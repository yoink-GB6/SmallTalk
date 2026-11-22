// 世界书（World Info / Lorebook）触发模块。
//
// 这是酒馆 1.19.0 public/scripts/world-info.js 里 checkWorldInfo（约 L4709-5282）的「可读简化版」。
// 注释里的 Lxxxx 都指那个文件的大致行号；script.js 的行号会单独写明。
//
// 整体流程（和酒馆一致）：
//   1. 把最近的聊天楼层拼成「扫描缓冲」（WorldInfoBuffer，L199）
//   2. 条目按 order 从大到小排好（getSortedEntries，L4590）
//   3. 一轮一轮地扫（while (scanState)，L4766）：每轮对每个条目依次检查
//      禁用 → 递归相关标记 → 常驻 → 主关键词 → 次要关键词逻辑，命中的再掷概率
//   4. 本轮新激活条目的内容进「递归缓冲」，下一轮除了聊天还会扫它；没有新激活就停
//   5. 把所有激活条目按 order 排序，分到 before / after / @深度 / 示例 / outlet 各个桶（L5203-5263）
//
// ───────────── 未实现（相对酒馆刻意省略的功能） ─────────────
//   - token 预算（world_info_budget / budget_cap / ignoreBudget）：这里视为预算无限
//   - 定时效果 sticky / cooldown / delay（WorldInfoTimedEffects）
//   - 包含组 inclusion groups、组评分 group scoring、组权重（filterByInclusionGroups）
//   - 最少激活数 min activations（以及它带来的扫描深度推进 advanceScan / skew）
//   - 内容装饰器 @@activate / @@dont_activate（parseDecorators，L4652）：内容里的 @@ 行原样保留
//   - 角色 / 标签过滤 characterFilter
//   - 生成类型触发 triggers（normal / continue / swipe ...）
//   - 向量化条目 vectorized
//   - match* 额外扫描源（matchPersonaDescription / matchCharacterDescription / ... ，buffer.get L299-316）
//     以及扩展提示注入缓冲 injectBuffer（作者注释等 scan=true 的提示，L4719）
//   - 外部强制激活 externalActivations
//   - 世界书正则（regex_placement.WORLD_INFO，L5205 getRegexedString）
//   - 多级 delayUntilRecursion：任何真值都按第 1 级处理（见 checkEntry 注释）
//   - 多本世界书的插入策略 world_info_character_strategy：传进来的 entries 被当成一个整体排序
//     （相当于 evenly 策略）
//   - 聊天楼层在进扫描缓冲前会先跑 promptOnly 正则（script.js L4501）：这里不做，调用方需要的话先自己改好 chat
// ──────────────────────────────────────────────────────────────

/** 条目 position 枚举，对应 world_info_position（L855） */
export const WI_POSITION = Object.freeze({
    before: 0,     // 角色定义前
    after: 1,      // 角色定义后
    ANTop: 2,      // 作者注释上方（只在这一轮插作者注释时才发，见 author-note.js 文件头）
    ANBottom: 3,   // 作者注释下方
    atDepth: 4,    // @深度，插进聊天记录里
    EMTop: 5,      // 示例对话前
    EMBottom: 6,   // 示例对话后
    outlet: 7,     // 具名出口，由 {{outlet::name}} 宏取用
});

/** 次要关键词逻辑枚举，对应 world_info_logic（L33） */
export const WI_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

const DEFAULT_DEPTH = 4;      // L96：@深度条目没填 depth 时用 4
const MAX_SCAN_DEPTH = 1000;  // L98：扫描深度上限
// 酒馆的循环靠「没有新激活就停」自然结束（每轮至少新激活一条，条目数有限），
// 这里再加一道硬上限防止任何意外导致死循环。
const HARD_PASS_CAP = 1000;

// 每楼文本前面加的「匹配符」和楼与楼之间的连接符（buffer.get L295-296）。
// \x01 是个不可见字符，它属于 \W，所以全词匹配时它能充当开头的「词边界」；
// 副作用：正则关键词里的 ^ 永远匹配不到某条消息的开头（开头是 \x01，不是消息首字）。
const MATCHER = '\x01';
const JOINER = '\n' + MATCHER;

const ROLE_NAMES = { 0: 'system', 1: 'user', 2: 'assistant' };

/**
 * 对应 parseRegexFromString（L2901）。返回 RegExp 或 null（不是正则形式 / 写错了）。
 * 规则：
 *   - 必须整体形如 /pattern/flags，flags 只能是 gimsuy 的组合（注意没有 d、v）
 *   - pattern 里出现没转义的 / 就不算正则（酒馆认为这样的分隔符写法不合法）
 *   - 然后把 \/ 还原成 /。酒馆用的是 String.replace（只替换第一处），这里照抄这个小 bug
 *   - new RegExp 抛错（语法错误）→ null，之后这个关键词会被当成「普通文本」去匹配
 */
function parseRegexFromString(input) {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

/** utils.js escapeRegex（L1377） */
function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * 对应 WorldInfoBuffer.matchKeys（L337）。haystack 是扫描文本，needle 是已经宏替换 + trim 过的关键词。
 */
function matchKeys(haystack, needle, entry, settings) {
    // 1. 正则关键词：直接 test 原文，大小写敏感 / 全词匹配设置都不管（要忽略大小写就自己写 i 标志）
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) {
        return keyRegex.test(haystack);
    }

    // 2. 普通文本关键词：不区分大小写时两边都转小写（#transformString L268）
    const caseSensitive = entry.caseSensitive ?? settings.caseSensitive;
    if (!caseSensitive) {
        haystack = haystack.toLowerCase();
        needle = needle.toLowerCase();
    }
    const matchWholeWords = entry.matchWholeWords ?? settings.matchWholeWords;

    if (!matchWholeWords) {
        return haystack.includes(needle);
    }

    // 3. 全词匹配：关键词里有空白（多个词）→ 退化成普通子串包含
    const keyWords = needle.split(/\s+/);
    if (keyWords.length > 1) {
        return haystack.includes(needle);
    }
    // 单个词 → 要求左右是 \W（非 [A-Za-z0-9_]）或文本边界。
    // 注意：JS 的 \W 不认识中文，所有汉字都算 \W（「非单词字符」）。
    // 所以中文关键词「猫」在「我的猫很乖」里也能全词命中——对中文来说全词匹配几乎等于子串匹配，
    // 只有紧挨着英文字母 / 数字 / 下划线时才会失败（「猫a」不命中）。酒馆就是这样，这里不「修正」。
    const regex = new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`);
    return regex.test(haystack);
}

/**
 * 界面只留「扫描最近 N 条」（scanDepth），其余四项固定成酒馆默认：递归开、全词匹配开、带名字开、区分大小写关。
 * （2026-11-22 用户定；出处：酒馆 default/content/settings.json 的 world_info_recursive / match_whole_words /
 * include_names = true、case_sensitive = false。注意酒馆代码里的初值 recursive / matchWholeWords 是 false，
 * 但新用户拿到的是 settings.json 的值。）
 * 存储里 state.wi 的旧值照样保留（不改写），只是拼装时一律被这里盖掉；条目自己的 caseSensitive / matchWholeWords
 * （逐条覆盖）仍然优先于这里，见 matchKeys。scanWorldInfo 本身不套用它——单元测试和别的调用方可以传任意设置。
 */
export const WI_FIXED_SETTINGS = Object.freeze({ recursive: true, matchWholeWords: true, includeNames: true, caseSensitive: false });
/** 存储里的 wi 设置 → 实际拿去扫描的设置：scanDepth 等照旧，四项固定值盖上去 */
export const effectiveWiSettings = (wi) => ({ ...(wi ?? {}), ...WI_FIXED_SETTINGS });

/**
 * 主函数。
 * @type {import('./types.js').ScanWorldInfo}
 */
export function scanWorldInfo({ entries, chat, settings = {}, substitute, rng } = {}) {
    // ─── 设置默认值。注意：酒馆自己的 world_info_recursive 默认是 false（L75），
    //     这里按契约默认 true。
    const cfg = {
        scanDepth: settings.scanDepth ?? 2,
        recursive: settings.recursive ?? true,
        maxRecursionSteps: Number(settings.maxRecursionSteps) || 0,
        caseSensitive: settings.caseSensitive ?? false,
        matchWholeWords: settings.matchWholeWords ?? false,
        includeNames: settings.includeNames ?? true,
    };
    const sub = (text) => (substitute ? substitute(String(text ?? '')) : String(text ?? ''));
    // 条目概率的骰子【不受】「拼装」页「随机宏按存档固定」（GlobalRecord.stableRandom）的影响，永远是真随机：
    // 那个开关只管 {{random}} / {{roll}} 这类宏的文字结果；概率决定的是条目「进不进」，要是按存档固定，
    // 一个 30% 的条目在某个存档里就成了「永远进」或「永远不进」，等于改了概率的含义。
    const roll = rng ?? Math.random;
    const allEntries = Array.isArray(entries) ? entries : [];
    const messages = Array.isArray(chat) ? chat : [];

    // ─── 1. 扫描缓冲（WorldInfoBuffer 构造 + #initDepthBuffer L250）
    // script.js L4624：chatForWI = coreChat.map(x => includeNames ? `${x.name}: ${x.mes}` : x.mes).reverse()
    // 也就是「新 → 旧」排列，depthBuffer[0] 是最新一楼。每楼 trim 一下。
    // （酒馆 coreChat 会去掉隐藏楼层 is_system；我们的 role:'system' 是旁白，不是隐藏楼层，所以照常扫。）
    const depthBuffer = [];
    for (let d = 0; d < MAX_SCAN_DEPTH && d < messages.length; d++) {
        const m = messages[messages.length - 1 - d];
        const text = cfg.includeNames ? `${m.name}: ${m.content}` : m.content;
        depthBuffer[d] = text ? String(text).trim() : '';
    }
    /** 递归缓冲：每轮新激活条目的内容（用 \n 拼成一段）push 进来（addRecurse L372） */
    const recurseBuffer = [];

    /** 对应 buffer.get（L279）：取某条目这一轮要扫的文本 */
    function getScanText(entry) {
        let depth = entry.scanDepth ?? cfg.scanDepth;
        // 扫描深度 <= 0 直接返回空串——连递归缓冲也不扫！
        // 所以 scanDepth=0 的条目永远不能靠关键词触发（只能常驻）。
        if (depth <= 0) return '';
        if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;
        // 每楼前面都有一个 \x01，楼与楼之间用 "\n\x01" 连接；最新的楼在最前面
        let result = MATCHER + depthBuffer.slice(0, depth).join(JOINER);
        if (recurseBuffer.length > 0) {
            result += JOINER + recurseBuffer.join(JOINER);
        }
        return result;
    }

    // ─── 2. 排序（getSortedEntries L4590 + sortFn L88：b.order - a.order，order 大的在前）
    // Array.prototype.sort 是稳定排序，order 相同的保持传入顺序。
    const sortedEntries = [...allEntries].sort((a, b) => b.order - a.order);

    // ─── 3. 扫描循环的状态（L4729-4734）
    /** @type {Map<object, {entry: object, reason: 'constant'|'key', matchedKey?: string, matchedSecondary?: string[], pass: number, content: string}>} */
    const allActivated = new Map();   // 插入顺序 = 激活顺序。酒馆用 `${world}.${uid}` 作键，这里直接用条目对象本身
    const failedProbability = new Set();
    /** 每个未激活条目「走得最远」的那一步失败原因，给界面解释用 */
    const skipReason = new Map();
    const RANK = { 'no-key-match': 1, 'secondary-failed': 2, 'probability': 3, 'disabled': 4 };
    function noteSkip(entry, reason) {
        const prev = skipReason.get(entry);
        if (!prev || RANK[reason] >= RANK[prev]) skipReason.set(entry, reason);
    }

    /**
     * 单个条目在某一轮里的检查，对应 for (const entry of sortedEntries) 循环体（L4785-4989）。
     * 返回激活信息，或者 null（未激活，原因已经记进 skipReason）。
     */
    function checkEntry(entry, isRecursion) {
        if (entry.disable == true) {
            noteSkip(entry, 'disabled');
            return null;
        }

        // （此处酒馆还有：生成类型触发、角色/标签过滤、delay、cooldown —— 未实现）

        // delayUntilRecursion：只在递归轮才有资格（L4860）
        if (!isRecursion && entry.delayUntilRecursion) {
            noteSkip(entry, 'no-key-match');   // 契约里没有「被延迟」这个原因，记为没匹配上
            return null;
        }
        // 酒馆 L4865 还会比较 entry.delayUntilRecursion > currentRecursionDelayLevel（多级延迟）。
        // 简化：任何真值都当第 1 级，第一次递归轮就有资格，所以这里不需要这个判断。
        // （当所有延迟条目的级别都相同时，这个简化和酒馆完全等价。）

        // excludeRecursion：递归轮里不能被激活（L4870）
        if (isRecursion && cfg.recursive && entry.excludeRecursion) {
            noteSkip(entry, 'no-key-match');
            return null;
        }

        // （此处酒馆还有：@@activate / @@dont_activate 装饰器、外部激活 —— 未实现）

        // 常驻：直接激活，不看关键词（L4893）
        if (entry.constant) {
            return { reason: 'constant' };
        }

        // 没有主关键词又不是常驻 → 永远不会激活（L4905）
        if (!Array.isArray(entry.key) || !entry.key.length) {
            noteSkip(entry, 'no-key-match');
            return null;
        }

        const textToScan = getScanText(entry);

        // 主关键词：任意一个命中即可（L4914）。关键词先过宏替换；
        // 替换后为空串的关键词被跳过。注意 ST 是先判空、再 trim：
        // 只有空白的关键词（如 " "）不会被跳过，trim 后变成 ''，而 ''.includes 永远为真 →
        // 这种关键词会匹配任何文本（全词模式下也一样，因为 \x01 充当了边界）。照抄酒馆。
        const primaryKeyMatch = entry.key.find((key) => {
            const substituted = sub(key);
            return substituted && matchKeys(textToScan, substituted.trim(), entry, cfg);
        });
        if (primaryKeyMatch === undefined) {
            noteSkip(entry, 'no-key-match');
            return null;
        }

        // 次要关键词只在 selective 为真且 keysecondary 非空时才参与（L4924）
        const hasSecondaryKeywords = entry.selective
            && Array.isArray(entry.keysecondary)
            && entry.keysecondary.length;
        if (!hasSecondaryKeywords) {
            return { reason: 'key', matchedKey: primaryKeyMatch };
        }

        // 次要关键词逻辑（matchSecondaryKeys L4943）
        //   AND_ANY：任意一个次要词出现 → 激活
        //   NOT_ALL：只要有一个次要词「没出现」→ 激活（即「并非全部出现」）
        //   NOT_ANY：所有次要词都没出现 → 激活（即「一个都不能出现」）
        //   AND_ALL：所有次要词都出现 → 激活
        // 宏替换后为空的次要词算「没出现」：会让 AND_ALL 失败、让 NOT_ALL 成功。
        const selectiveLogic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY;
        let hasAnyMatch = false;
        let hasAllMatch = true;
        let secondaryOk = false;
        let matchedSecondary = [];
        for (const keysecondary of entry.keysecondary) {
            const substituted = sub(keysecondary);
            const hasSecondaryMatch = Boolean(substituted && matchKeys(textToScan, substituted.trim(), entry, cfg));
            if (hasSecondaryMatch) hasAnyMatch = true;
            if (!hasSecondaryMatch) hasAllMatch = false;
            // AND_ANY / NOT_ALL 一旦满足就提前返回
            if (selectiveLogic === WI_LOGIC.AND_ANY && hasSecondaryMatch) {
                secondaryOk = true; matchedSecondary = [keysecondary]; break;
            }
            if (selectiveLogic === WI_LOGIC.NOT_ALL && !hasSecondaryMatch) {
                secondaryOk = true; matchedSecondary = [keysecondary]; break;
            }
        }
        if (!secondaryOk && selectiveLogic === WI_LOGIC.NOT_ANY && !hasAnyMatch) {
            secondaryOk = true; matchedSecondary = [...entry.keysecondary];
        }
        if (!secondaryOk && selectiveLogic === WI_LOGIC.AND_ALL && hasAllMatch) {
            secondaryOk = true; matchedSecondary = [...entry.keysecondary];
        }
        // selectiveLogic 是其它值（不在 0-3）→ 酒馆返回 false，这里同样不激活
        if (!secondaryOk) {
            noteSkip(entry, 'secondary-failed');
            return null;
        }
        return { reason: 'key', matchedKey: primaryKeyMatch, matchedSecondary };
    }

    // ─── 4. 主循环（while (scanState) L4766）
    // count 表示已经跑了几轮；maxRecursionSteps = N 表示「总共最多跑 N 轮」（含首轮），
    // 酒馆的判断是 if (max && max <= count) break（L4768），所以 N=1 时只跑首轮、不递归。
    for (let count = 0; count < HARD_PASS_CAP; count++) {
        if (cfg.maxRecursionSteps && cfg.maxRecursionSteps <= count) break;
        const pass = count;
        const isRecursion = pass > 0;   // 首轮 INITIAL，之后都是 RECURSION 状态

        // 4a. 找出本轮所有可激活条目（按 sortedEntries 顺序，所以天然是 order 从大到小）
        const activatedNow = [];
        for (const entry of sortedEntries) {
            // 已激活的、已掷骰失败的：后续轮次直接跳过（L4797）——失败的概率不会重掷
            if (failedProbability.has(entry) || allActivated.has(entry)) continue;
            const hit = checkEntry(entry, isRecursion);
            if (hit) activatedNow.push({ entry, ...hit });
        }

        // 4b. 概率检查（L5019-5077），按上面的顺序依次掷骰（rng 的调用顺序因此是确定的）
        const successful = [];
        for (const hit of activatedNow) {
            const { entry } = hit;
            // 不启用概率或概率正好 100 → 不掷骰
            if (entry.useProbability && entry.probability !== 100) {
                const rollValue = roll() * 100;
                // 注意是 <=：probability=0 时，rng() 恰好返回 0 也会通过
                if (!(rollValue <= entry.probability)) {
                    failedProbability.add(entry);
                    noteSkip(entry, 'probability');
                    continue;
                }
            }
            // 激活成功时才做内容的宏替换（L5058）；替换后的内容同时用于递归缓冲和最终输出。
            // 酒馆在 getSortedEntries 里先做 content || ''。
            const content = sub(entry.content || '');
            const record = { ...hit, pass, content };
            allActivated.set(entry, record);
            successful.push(record);
        }

        // 4c. 决定要不要再来一轮（L5097）：开启递归 且 本轮有「允许递归」的新激活条目
        //     preventRecursion 的条目自己会激活，但内容不进递归缓冲
        const forRecursion = successful.filter((r) => !r.entry.preventRecursion);
        const shouldRecurse = cfg.recursive && forRecursion.length > 0;
        // （酒馆这里还有 min activations 和多级延迟递归的续扫逻辑 L5104-5133 —— 未实现；
        //   单级延迟时，L5129 那个分支永远不会走到，因为唯一的级别在循环开始前就已经 shift 掉了。）
        if (!shouldRecurse) break;

        // 4d. 把本轮新内容拼成一段推进递归缓冲（L5139）
        const text = forRecursion.map((r) => r.content).join('\n');
        if (text) recurseBuffer.push(text);
    }

    // ─── 5. 输出（L5192-5266）
    // 酒馆把所有激活条目再按 sortFn（order 大→小，稳定排序，同 order 保持激活顺序）排一次，
    // 然后对 before/after/示例/@深度组内都用 unshift 放进数组 ——
    // 结果就是：order 小的在上、order 大的在下（离聊天记录 / 生成位置更近）。
    // 同 order 时因为 unshift，激活顺序靠后的反而排在前面。
    const finalOrder = [...allActivated.values()].sort((a, b) => b.entry.order - a.entry.order);

    const beforeList = [];   // {entry, content}
    const afterList = [];
    const emList = [];       // {isBefore, content}
    /** @type {{depth: number, role: number, items: {entry: object, content: string}[]}[]} */
    const depthGroups = [];
    /** @type {Record<string, string[]>} */
    const outletLists = {};
    const anTopList = [];    // {entry, content}：作者注释上方（L5229）
    const anBottomList = []; // 作者注释下方（L5232）

    for (const record of finalOrder) {
        const { entry, content } = record;
        // 内容为空（宏替换之后）→ 不进任何桶，但仍算激活过（L5207）
        if (!content) continue;

        switch (entry.position) {
            case WI_POSITION.before:
                beforeList.unshift({ entry, content });
                break;
            case WI_POSITION.after:
                afterList.unshift({ entry, content });
                break;
            case WI_POSITION.EMTop:
                emList.unshift({ isBefore: true, content });
                break;
            case WI_POSITION.EMBottom:
                emList.unshift({ isBefore: false, content });
                break;
            // 作者注释上 / 下：和 before / after 一样 unshift（order 小的在上）。拼不拼进去由拼装决定——
            // 酒馆只在这一轮插作者注释（shouldWIAddPrompt）时才把它们和正文拼在一起（L5268），不插的轮次它们不发，
            // 但扫描阶段照常激活、内容照常进了递归缓冲，所以可能「间接」激活别的条目
            case WI_POSITION.ANTop:
                anTopList.unshift({ entry, content });
                break;
            case WI_POSITION.ANBottom:
                anBottomList.unshift({ entry, content });
                break;
            case WI_POSITION.atDepth: {
                // 同 (depth, role) 合并成一组（L5236）；组内 unshift，组按「首次出现」push。
                // 组的先后顺序在酒馆里其实无所谓：之后 setExtensionPrompt 按 depth/role 作键注入。
                // 这里保留酒馆数组的原始顺序（= 组里 order 最大的条目，order 越大的组越靠前）。
                const depth = entry.depth ?? DEFAULT_DEPTH;
                const role = entry.role ?? 0;
                const group = depthGroups.find((g) => g.depth === depth && g.role === role);
                if (group) {
                    group.items.unshift({ entry, content });
                } else {
                    depthGroups.push({ depth, role, items: [{ entry, content }] });
                }
                break;
            }
            case WI_POSITION.outlet:
                // 没有 outletName 的直接丢掉（L5249）。
                // 注意 outlet 用的是 push 不是 unshift：order 大的在前，和其它桶相反！
                if (!entry.outletName) break;
                (outletLists[entry.outletName] ??= []).push(content);
                break;
            default:
                break;
        }
    }

    // 示例对话：script.js L4639-4655 遍历 EMEntries，「前」用 unshift 插到示例数组最前面，
    // 「后」用 push 追加到最后。这里直接给出「最终出现在 prompt 里的顺序」：
    //   examplesBefore 按 order 大→小（又被 unshift 反了一次），examplesAfter 按 order 小→大。
    // 调用方只需要 [...examplesBefore, ...卡里的示例, ...examplesAfter]。
    const examplesBefore = [];
    const examplesAfter = [];
    for (const ex of emList) {
        if (ex.isBefore) examplesBefore.unshift(ex.content);
        else examplesAfter.push(ex.content);
    }

    /** @type {Record<string, string>} */
    const outlets = {};
    for (const [name, list] of Object.entries(outletLists)) outlets[name] = list.join('\n');

    // activated：按激活顺序（轮次 → 扫描顺序）列出（作者注释上 / 下的条目也在里面：激活了，发不发看作者注释这一轮插不插）
    const activated = [];
    for (const r of allActivated.values()) {
        const a = { entry: r.entry, reason: r.reason, pass: r.pass };
        if (r.matchedKey !== undefined) a.matchedKey = r.matchedKey;
        if (r.matchedSecondary !== undefined) a.matchedSecondary = r.matchedSecondary;
        activated.push(a);
    }

    // skipped：按扫描顺序列出每个没进 activated 的条目
    const skipped = [];
    for (const entry of sortedEntries) {
        if (!allActivated.has(entry)) {
            skipped.push({ entry, reason: skipReason.get(entry) ?? 'no-key-match' });
        }
    }

    return {
        before: beforeList.map((x) => x.content).join('\n'),
        after: afterList.map((x) => x.content).join('\n'),
        beforeEntries: beforeList.map((x) => x.entry),
        afterEntries: afterList.map((x) => x.entry),
        // 各条目宏替换之后的文字（和 *Entries 一一对应）：assemble.js 拿它把拼好的文本逐条对齐成出处
        beforeContents: beforeList.map((x) => x.content),
        afterContents: afterList.map((x) => x.content),
        depth: depthGroups.map((g) => ({
            depth: g.depth,
            role: /** @type {import('./types.js').Role} */ (ROLE_NAMES[g.role] ?? 'system'),
            content: g.items.map((x) => x.content).join('\n'),
            entries: g.items.map((x) => x.entry),
            contents: g.items.map((x) => x.content),
        })),
        examplesBefore,
        examplesAfter,
        anTop: anTopList.map((x) => x.content),
        anTopEntries: anTopList.map((x) => x.entry),
        anBottom: anBottomList.map((x) => x.content),
        anBottomEntries: anBottomList.map((x) => x.entry),
        outlets,
        activated,
        skipped,
    };
}
