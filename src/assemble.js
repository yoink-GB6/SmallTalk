// 拼装器：预设 + 角色卡 + persona + 聊天记录 + 世界书结果 → 发给模型的 messages[]。
// 对照酒馆 1.19.0 源码（行号为近似值）：
//   public/scripts/openai.js        prepareOpenAIMessages(~L1542) → preparePromptsForChatCompletion(~L1367)
//                                   → populateChatCompletion(~L1185) → populationInjectionPrompts(~L810)
//                                   → populateChatHistory(~L885) / populateDialogueExamples(~L1101)
//                                   → ChatCompletion.squashSystemMessages(~L3922) / getChat(~L4120)
//   public/scripts/PromptManager.js getPromptCollection(~L1516) / preparePrompt(~L1277) / shouldTrigger(~L1549)
//   public/script.js                Generate(~L4460-4836) / parseMesExamples(~L3501) / getExtensionPrompt(~L3301)
//
// ─────────────────────────── 未实现（有意简化） ───────────────────────────
//  - token 预算：已实现（见下面「上下文预算」一节），但 token 数只是粗估（没有真分词器），
//    pin_examples（示例先于聊天记录占预算）没有做，固定按「聊天记录先、示例后」；
//    必需内容本身就超出预算时，酒馆会报错并发出一份残缺的 prompt，我们改为照发全部非聊天内容、聊天记录一楼不发，并警告。
//  - 群聊（group nudge、new_group_chat_prompt、群成员名前缀、群卡）。
//  - impersonate / continue / quiet / swipe 等生成类型：一律按 'normal'。
//  - 除「世界书 @深度」「角色卡深度提示」「作者注释」以外的扩展提示：总结、向量库、persona 的 in-chat / 作者注释上下位置等。
//    作者注释的规则（插不插、三种位置、和世界书「作者注释上 / 下」怎么拼）见 author-note.js 文件头，实现在下面「作者注释」几处。
//  - 工具调用、图片/音视频内联、推理(reasoning)回填、pin_examples、bias。
//  - enhanceDefinitions 不做任何特殊处理，就当一条普通内置条目。
//  - names_behavior=0(DEFAULT) 时酒馆对 /sendas、换过 persona 名的旧楼层（force_avatar）会加前缀；我们没有 force_avatar 字段，等同不加。
//
// ─────────────────────────── 宏求值顺序（setvar/getvar 可见性） ───────────────────────────
// 酒馆不是「按 prompt_order 一条条求值」那么简单，实际时间线是（本文件照此实现）：
//   A. Generate 一开始 getCharacterCardFields()（script.js ~L4460，解构顺序即求值顺序）：
//      description → personality → persona → scenario → mesExamples → 卡 system_prompt → 卡 post_history_instructions → 卡 depth_prompt
//   B. chat[0]（开场白）先被 substituteParams 一次（script.js ~L4490），之后作为聊天记录还会再替换一次。
//   (C. 世界书扫描：酒馆在这里（A、B 之后）替换条目内容。我们的 worldInfo 由调用方提前算好，即发生在 A 之前 —— 差异。)
//   D. 世界书「示例前/后」条目再 baseChatReplace 一次（script.js ~L4646）。
//   E. scenario_format、personality_format（openai.js ~L1368-1369）。
//   F. prompt_order 列表里【启用且触发】的条目，按列表顺序逐条（PromptManager.getPromptCollection ~L1521）。未启用的不求值。
//   G. 各标记的填充内容，按酒馆 systemPrompts 数组的固定顺序（openai.js ~L1374-1434），而不是列表顺序：
//      worldInfoBefore → worldInfoAfter → charDescription → charPersonality → scenario → 作者注释（这一轮插的话）→ personaDescription。
//      注意：这一步不管标记是否启用都会求值（preparePrompt 在 ~L1488 无条件调用）；作者注释不管放在哪个位置也都在这里求值一次。
//   H. 角色卡覆盖：main（带 {{original}}）→ jailbreak（带 {{original}}）（~L1496-1513）。
//   I. 聊天内注入：深度 0,1,2… 依次；每个深度内 order 从大到小、role 按 system→user→assistant，
//      扩展提示（作者注释「聊天内」+ 深度提示 + 世界书@深度）在 order=100 那组里求值一次（getExtensionPrompt ~L3326）。
//      所以「聊天内」的作者注释里的宏一共求值两次（G 一次、这里一次），酒馆也是这样。
//   J. new_chat_prompt（~L894），然后聊天记录【从新到旧】逐楼求值（populateChatHistory ~L948-955，chatPool 是倒序的）。
//   K. new_example_chat_prompt（~L1108，只在有示例时）。示例内容本身在 A/D 已替换过，不再替换。
//   L. assistant_prefill（发请求时 ~L2880）。
//   send_if_empty 酒馆不做宏替换（~L930），这里也不做。
// 已知的求值次数差异：酒馆对注入到聊天里的消息在 J 阶段会再 preparePrompt 一次（第二遍通常是空操作），这里省略；
//   酒馆每次 substituteParams 都会重新对卡字段跑 baseChatReplace（卡字段里的 setvar 被反复执行），这里只在 A 跑一次。
//
// ─────────────────────────── 出处(sources)不变式 ───────────────────────────
// 每条输出消息：content.length === Σ sources[i].chars + (sources.length - 1)
// 即各段之间恰好用一个 '\n' 连接（酒馆里同深度合并、squash 都用 '\n'）。
// 若一次宏替换跨越多个出处且改变了文本，无法再逐段对齐，这几段会被合并成一个出处（id 用 '+' 连接）。
//
// ─────────────────────────── 上下文预算（openai_max_context） ───────────────────────────
// 酒馆的规则（openai.js，行号近似）：
//   1. prepareOpenAIMessages（~L1567）：预算 = openai_max_context − openai_max_tokens（setTokenBudget ~L3982），
//      两个数都在预设里。之后每放进一条消息就从预算里扣掉它的 token 数。
//   2. populateChatCompletion（~L1210）：先 reserveBudget(3)——给回复开头的 <|start|>assistant<|message|> 留 3 个。
//   3. 非聊天内容（main / 世界书前后 / 角色描述 / 性格 / 场景 / persona / nsfw / jailbreak / 自定义相对条目 / enhanceDefinitions）
//      逐条 add()，每条都先 checkTokenBudget——放不下就抛 TokenBudgetExceededError，被 ~L1589 接住：
//      弹「Mandatory prompts exceed the context size」，然后把【已经放进去的那部分】照样发出去（残缺的 prompt）。
//      我们有意不同：非聊天内容全部照发，聊天记录 / 示例一条都不放，并在日志里警告。
//   4. 按深度注入（预设里 injection_position=1 的条目、世界书 @深度、卡的 depth prompt）在 populationInjectionPrompts（~L810）
//      里被插进【完整的】聊天记录数组——深度按原始楼层数算，发生在丢楼之前。所以它们和聊天记录同属一个池子：
//      离最新越远（深度越大）越先被丢；被丢的楼层之间的注入跟着一起丢，丢楼不会让注入「挪位」。
//   5. populateChatHistory（~L885）：
//      a. new_chat_prompt 先 reserveBudget（~L895），最后 freeBudget 再插到聊天记录最前（~L1078）——它总会发；
//      b. 最后一条是 assistant 且有 send_if_empty：canAfford 才加（~L931），它先于聊天记录占预算；
//      c. 从最新往最旧逐条（含注入的条目）：先 preparePrompt（宏在这一步求值），再 canAfford，放不下就 break（~L1070）。
//         break 之后更老的楼层连宏都不求值。连最新一楼都放不下时，就是一楼都不发——酒馆不报错，我们照做但会警告。
//   6. populateDialogueExamples（~L1101）在聊天记录之后（除非 power_user.pin_examples，我们没有这个设置）：
//      用剩下的预算，按「一整块示例（含 new_example_chat_prompt）」为单位，放不下就 break，之后的块都不发。
//   7. squash_system_messages 在这之后才合并（~L1608），所以预算按合并前的消息算。assistant_prefill 是单独的字段，不计入。
//   8. 每条消息的 token（tokenizers.js countTokensOpenAIAsync ~L846 + 服务端 endpoints/tokenizers.js /openai/count ~L998）：
//      3（每条消息）+ 各字段（role、content、name）的 token + name 再 +1 + 3（每次请求的 padding），客户端再 −2；
//      内容为空的消息记 0（Message.createAsync 只在有内容时计数）。
// 我们的差异：token 用 estimateTokens 粗估（中文误差可达三四成），酒馆有真分词器；
//   外置记忆块（调用方插入）以 contextLimit.reserved 的形式先占预算，相当于又一条必需内容。

import { substitute } from './macros.js';
import { estimateTokens } from './tokens.js';
import { normalizeAuthorNote, noteTurn, joinNoteText, NOTE_POSITION, NOTE_ROLES } from './author-note.js';

/** @typedef {import('./types.js').Source} Source */
/** @typedef {import('./types.js').AssembledMessage} AssembledMessage */
/** @typedef {import('./types.js').AssembleLogEntry} AssembleLogEntry */
/** @typedef {import('./types.js').MacroContext} MacroContext */

const INJECTION_ABSOLUTE = 1;          // PromptManager INJECTION_POSITION.ABSOLUTE
const DEFAULT_ORDER = 100;             // Prompt 构造函数里 injection_order 的默认值
const EXTENSION_ORDER = '100';         // populationInjectionPrompts：扩展提示只进 order=100 这一组
const MAX_INJECTION_DEPTH = 10000;     // script.js MAX_INJECTION_DEPTH
const DUMMY_CHARACTER_ID = 100001;     // openai.js setupChatCompletionPromptManager: promptOrder.dummyId
const ROLES = ['system', 'user', 'assistant'];

// PromptManager.js promptManagerDefaultPromptOrder（~L2087）：找不到 100001 时酒馆会用它新建一份
// 酒馆 PromptManager.js chatCompletionDefaultPrompts（~L2001）。
// 唯一改动：main 里酒馆写的是 {{charIfNotGroup}}，我们不做群聊，等价于 {{char}}。
const DEFAULT_PROMPTS = [
    { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}." },
    { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'enhanceDefinitions', name: 'Enhance Definitions', system_prompt: true, role: 'system', marker: false, content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute." },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

const DEFAULT_PROMPT_ORDER = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'personaDescription', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'charPersonality', enabled: true },
    { identifier: 'scenario', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: false },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
    { identifier: 'dialogueExamples', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

// populateChatCompletion 里会被 addToChatCompletion 的内置条目（~L1212-1260）。
// 另外所有 system_prompt === false 的相对条目也会被加入（userRelativePrompts）。
const BUILTIN_ADDED = new Set([
    'worldInfoBefore', 'main', 'worldInfoAfter', 'charDescription', 'charPersonality',
    'scenario', 'personaDescription', 'nsfw', 'jailbreak', 'enhanceDefinitions',
]);
const KNOWN_MARKERS = new Set([
    'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality',
    'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory',
]);

// ─────────────────────────── 「段」：带出处的文本片段 ───────────────────────────
// part = {text, src}；src 是不含 chars 的 Source，chars 在最后输出时按 text.length 计算。

const part = (text, src) => ({ text: String(text ?? ''), src });
const joinParts = (parts) => parts.map((p) => p.text).join('\n');

/** 把若干段合并成一段（宏替换/trim 后无法逐段对齐时用） */
function collapse(parts, text) {
    if (parts.length === 0) return [];
    if (parts.length === 1) return [part(text, parts[0].src)];
    const uniq = (xs) => [...new Set(xs)];
    const first = parts[0].src;
    /** @type {any} */
    const src = {
        kind: first.kind,
        id: uniq(parts.map((p) => p.src.id)).join('+'),
        label: uniq(parts.map((p) => p.src.label)).join(' + '),
    };
    if (first.depth !== undefined) src.depth = first.depth;
    return [part(text, src)];
}

/** 对整段做一次宏替换（与酒馆一次 substituteParams 调用的粒度一致）；文本没变就保留逐段出处 */
function substituteParts(parts, ctx) {
    const joined = joinParts(parts);
    if (!joined) return parts;
    const out = substitute(joined, ctx);
    return out === joined ? parts : collapse(parts, out);
}

/** 等价于对拼好的整段做 .trim()，尽量保留逐段出处 */
function trimParts(parts) {
    if (parts.length === 0) return parts;
    const target = joinParts(parts).trim();
    const copy = parts.map((p) => ({ ...p }));
    copy[0].text = copy[0].text.trimStart();
    copy[copy.length - 1].text = copy[copy.length - 1].text.trimEnd();
    // 两头是空段时（作者注释正文为空、只剩世界书「作者注释上 / 下」的条目），要 trim 掉的换行就是它和邻段之间的连接符：
    // 去掉空的边段再对一次，免得整段并成一个出处。对不上时照旧合并
    while (copy.length > 1 && joinParts(copy) !== target && copy[copy.length - 1].text === '') {
        copy.pop();
        copy[copy.length - 1].text = copy[copy.length - 1].text.trimEnd();
    }
    while (copy.length > 1 && joinParts(copy) !== target && copy[0].text === '') {
        copy.shift();
        copy[0].text = copy[0].text.trimStart();
    }
    return joinParts(copy) === target ? copy : collapse(parts, target);
}

const withDepth = (parts, depth) => parts.map((p) => ({ text: p.text, src: { ...p.src, depth } }));

/** 内部消息 → 输出消息 */
function finalize(m) {
    /** @type {AssembledMessage} */
    const out = {
        role: m.role,
        content: joinParts(m.parts),
        sources: m.parts.map((p) => ({ ...p.src, chars: p.text.length })),
    };
    if (m.name) out.name = m.name;
    return out;
}

// ─────────────────────────── 小工具 ───────────────────────────

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// PromptManager.shouldTrigger（~L1549），生成类型固定为 'normal'
function shouldTrigger(prompt) {
    if (!Array.isArray(prompt?.injection_trigger)) return true;
    if (!prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes('normal');
}

// utils.js stringFormat
function stringFormat(format, ...args) {
    return format.replace(/{(\d+)}/g, (match, n) => (typeof args[n] !== 'undefined' ? args[n] : match));
}

// PromptManager.isValidName / sanitizeName（~L1343）
const isValidName = (name) => /^[a-zA-Z0-9_]{1,64}$/.test(name);
const sanitizeName = (name) => name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);

/** script.js parseMesExamples（~L3501），chat completion 下 blockHeading 固定为 '<START>\n' */
export function parseMesExamples(examplesStr) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return [];
    if (!examplesStr.startsWith('<START>')) examplesStr = '<START>\n' + examplesStr.trim();
    return examplesStr.split(/<START>/gi).slice(1).map((block) => `<START>\n${block.trim()}\n`);
}

/**
 * openai.js setOpenAIMessageExamples + parseExampleIntoIndividual（~L656、~L729），非群聊版本。
 * @returns {{role: 'system', content: string, name: string}[]}
 */
export function parseExampleIntoIndividual(block, name1, name2) {
    const text = block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    const result = [];
    const lines = text.split('\n');
    let cur = [];
    let inUser = false;
    let inBot = false;
    const addMsg = (name, systemName) => {
        // 只去掉第一次出现的 "名字:"，再 trim —— 与酒馆一致
        const content = cur.join('\n').replace(name + ':', '').trim();
        result.push({ role: 'system', content, name: systemName });
        cur = [];
    };
    // 第一行是 "{Example Dialogue:}"，跳过
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(name1 + ':')) {
            inUser = true;
            if (inBot) addMsg(name2, 'example_assistant');
            inBot = false;
        } else if (line.startsWith(name2 + ':')) {
            inBot = true;
            if (inUser) addMsg(name1, 'example_user');
            inUser = false;
        }
        cur.push(line);
    }
    if (inUser) addMsg(name1, 'example_user');
    else if (inBot) addMsg(name2, 'example_assistant');
    return result;
}

/** 世界书 before/after 的出处：能逐条对齐就逐条，否则整块一个 */
function worldInfoEntryParts(text, entries, blockId) {
    if (Array.isArray(entries) && entries.length && entries.map((e) => str(e.content)).join('\n') === text) {
        return entries.map((e) => part(str(e.content), {
            kind: 'worldinfo', id: String(e.uid), label: e.comment || `条目 ${e.uid}`,
        }));
    }
    const ids = Array.isArray(entries) && entries.length ? entries.map((e) => e.uid).join('+') : blockId;
    const label = Array.isArray(entries) && entries.length
        ? entries.map((e) => e.comment || `条目 ${e.uid}`).join(' + ')
        : '世界书';
    return [part(text, { kind: 'worldinfo', id: String(ids), label })];
}

/** openai.js formatWorldInfo（~L789）：套 wi_format，并尽量拆出包装文本 / 各条目 */
function formatWorldInfoParts(text, entries, wiFormat, markerId, markerLabel) {
    if (!text) return [];
    const format = typeof wiFormat === 'string' ? wiFormat : '{0}';
    const entryParts = worldInfoEntryParts(text, entries, markerId);
    if (!format.trim()) return entryParts;
    const formatted = stringFormat(format, text);
    const pieces = format.split('{0}');
    if (pieces.length === 2) {
        const [pre, post] = pieces;
        if ((pre === '' || pre.endsWith('\n')) && (post === '' || post.startsWith('\n'))) {
            const wrap = { kind: 'marker', id: markerId, label: `${markerLabel}（wi_format 包装）` };
            const parts = [];
            if (pre) parts.push(part(pre.slice(0, -1), wrap));
            parts.push(...entryParts);
            if (post) parts.push(part(post.slice(1), wrap));
            if (joinParts(parts) === formatted) return parts;
        }
    }
    return collapse(entryParts, formatted).map((p) => ({ text: p.text, src: { ...p.src, kind: 'worldinfo' } }));
}

// ─────────────────────────── 预算用的小工具 ───────────────────────────

export const TOKENS_PER_MESSAGE = 3;   // endpoints/tokenizers.js：tokensPerMessage
export const TOKENS_PER_NAME = 1;      // 同上：tokensPerName（有 name 字段时）
export const TOKENS_PADDING = 3;       // 同上：tokensPadding（每次计数调用加一次；酒馆是一条消息调用一次）
export const COUNT_NOT_FULL = 2;       // tokenizers.js countTokensOpenAIAsync(full=false)：最后 −2
export const REPLY_PRIMER_TOKENS = 3;  // openai.js populateChatCompletion：reserveBudget(3)

/**
 * 一条消息占多少 token（照酒馆的公式，各字段的 token 数用 est 估）。内容为空记 0。
 * @param {{role: string, content: string, name?: string}} m
 * @param {(text: string) => number} [est]
 */
export function messageTokens(m, est = estimateTokens) {
    if (!m.content) return 0;
    let n = TOKENS_PER_MESSAGE + est(m.role) + est(m.content);
    if (m.name) n += est(m.name) + TOKENS_PER_NAME;
    return n + TOKENS_PADDING - COUNT_NOT_FULL;
}

const positiveInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * 全局设置 + 当前预设 → 这次用的上限。纯函数（调用方从 state 里取出两样东西传进来）。
 *   'preset'（默认）：用预设里的 openai_max_context / openai_max_tokens（忠实于酒馆）；预设里没有 openai_max_context 就不限。
 *   'custom'：上限用自己填的 maxContext，回复预留仍取预设里的 openai_max_tokens（它也是真正发给接口的 max_tokens）。
 *   'off'：不限。
 * @param {{mode?: string, maxContext?: number}|undefined} setting  state.contextLimit
 * @param {Object} preset
 * @returns {{mode: 'preset'|'custom'|'off', limit: {maxContext: number, maxTokens: number}|null, why: string}}
 *   limit 为 null 表示不限；why 是给人看的一句说明
 */
export function resolveContextLimit(setting, preset) {
    const mode = setting?.mode === 'custom' || setting?.mode === 'off' ? setting.mode : 'preset';
    const maxTokens = positiveInt(preset?.openai_max_tokens);
    if (mode === 'off') return { mode, limit: null, why: '已关闭上限：所有楼层照发' };
    if (mode === 'custom') {
        const maxContext = positiveInt(setting?.maxContext);
        if (!maxContext) return { mode, limit: null, why: '自定义上限没有填有效的数字，当作不限' };
        return { mode, limit: { maxContext, maxTokens }, why: `自定义上限 ${maxContext}，回复预留取预设里的 openai_max_tokens（${maxTokens}）` };
    }
    const maxContext = positiveInt(preset?.openai_max_context);
    if (!maxContext) return { mode, limit: null, why: '当前预设里没有 openai_max_context，不限' };
    return { mode, limit: { maxContext, maxTokens }, why: `来自当前预设：openai_max_context ${maxContext}，openai_max_tokens ${maxTokens}` };
}

// ─────────────────────────── 主函数 ───────────────────────────

/**
 * @param {Object} args 见 types.js Assemble
 * @returns {{messages: AssembledMessage[], log: AssembleLogEntry[], budget?: import('./types.js').AssembleBudget}}
 *   budget 只在传了 contextLimit 时才有
 */
export function assemble(args) {
    const preset = args.preset ?? {};
    const card = args.card ?? /** @type {any} */ ({});
    const persona = args.persona ?? { name: '', description: '' };
    const chat = Array.isArray(args.chat) ? args.chat : [];
    const wi = normalizeWorldInfo(args.worldInfo);
    const variables = args.variables ?? { local: {}, global: {} };
    const transformChat = typeof args.transformChat === 'function' ? args.transformChat : (msg) => msg.content;
    // chat[0] 在完整聊天记录里是第几楼（外置记忆截掉了前面的楼层时由调用方传）：只影响出处 id、日志和 budget 里的楼层号
    const chatOffset = Number.isInteger(args.chatOffset) && args.chatOffset > 0 ? args.chatOffset : 0;
    // 去掉了隐藏楼层时楼层号不连续：调用方直接给每一楼的楼层号（types.js Assemble 的 chatFloors）
    const chatFloors = Array.isArray(args.chatFloors) && args.chatFloors.length === chat.length ? args.chatFloors : null;
    const floorNo = (i) => (chatFloors ? chatFloors[i] : i + chatOffset);

    /** @type {AssembleLogEntry[]} */
    const log = [];
    const info = (message) => log.push({ level: 'info', message });
    const warn = (message) => log.push({ level: 'warn', message });

    // 上下文预算（规则见文件头「上下文预算」）。没传上限时 remaining 恒为 Infinity，下面所有预算判断都不会生效，
    // 输出和没有这个功能时逐字节相同。
    const limit = normalizeLimit(args.contextLimit);
    const est = typeof args.estimateTokens === 'function' ? args.estimateTokens : estimateTokens;
    const tok = (m) => messageTokens({ role: m.role, content: joinParts(m.parts), name: m.name }, est);
    let remaining = Infinity;
    /** 已占用的 token，按来源分开记（加起来就是 budget.used） */
    const spent = { primer: 0, reserved: 0, fixed: 0, utility: 0, chat: 0, examples: 0 };
    const dropped = { floors: [], injected: 0, examples: 0, sendIfEmpty: false };

    const name1 = str(persona.name);
    const name2 = str(card.name);
    /** @type {MacroContext} */
    // seed / stableRandom：「按存档固定」的随机（{{pick}} 永远用 seed；stableRandom 时 {{random}} / {{roll}} 也用），见 macros.js 文件头。
    // 不传时和以前一样（pick 只看原文 + 偏移，random / roll 用 rng）
    // 宏看到的聊天记录：调用方给了完整记录（macroChat，含隐藏楼层）就用它——酒馆的 {{lastMessage}} 等读的是整个 chat，不是 coreChat
    const macroChat = Array.isArray(args.macroChat) ? args.macroChat : chat;
    // 作者注释（规则见 author-note.js 文件头）。坏值 / 不传都按内置默认（空正文、每次都插、聊天内深度 4、system）
    const note = normalizeAuthorNote(args.authorNote);
    const baseCtx = { user: name1, char: name2, chat: macroChat, variables, outlets: wi.outlets, now: args.now, rng: args.rng, seed: args.macroSeed, stableRandom: args.stableRandom === true, authorsNote: note.prompt };

    // 这一轮插不插（setFloatingPrompt）：数的是完整记录里的用户消息（含隐藏楼层、含被外置记忆折叠的），所以用 macroChat。
    // 插的话把世界书「作者注释上 / 下」的条目拼在正文上下（world-info.js ~L5270）；noteRaw 是宏替换之前的段，这一轮不插 = []
    const noteRun = noteTurn(note, macroChat);
    let noteRaw = [];
    if (noteRun.insert) {
        const wiPart = (text, e) => part(text, { kind: 'worldinfo', id: String(e?.uid ?? ''), label: e?.comment || `条目 ${e?.uid}` });
        const top = wi.anTop.map((t, k) => wiPart(t, wi.anTopEntries[k]));
        const bottom = wi.anBottom.map((t, k) => wiPart(t, wi.anBottomEntries[k]));
        noteRaw = [...top, part(note.prompt, { kind: 'authorNote', id: 'authorNote', label: '作者注释' }), ...bottom];
        // 逐段连接恰好等于酒馆的公式（两头多出来的那个换行正好被它的 replace 去掉），保险起见对一次，对不上就合并成一段
        const target = joinNoteText(wi.anTop, note.prompt, wi.anBottom);
        if (joinParts(noteRaw) !== target) noteRaw = collapse(noteRaw, target);
        if (!joinParts(noteRaw)) noteRaw = [];
    }
    const NOTE_WHERE = { [NOTE_POSITION.before]: '主提示之前', [NOTE_POSITION.after]: '主提示之后', [NOTE_POSITION.chat]: `聊天内深度 ${note.depth}` };
    if (noteRaw.length) {
        info(`作者注释：这一轮插入，位置「${NOTE_WHERE[note.position]}」，${NOTE_ROLES[note.role]}`
            + (note.interval > 1 ? `（每 ${note.interval} 句用户输入插一次，现在是第 ${noteRun.userCount} 句）` : '')
            + (wi.anTop.length + wi.anBottom.length ? `；带上世界书「作者注释上 / 下」的条目 ${wi.anTop.length + wi.anBottom.length} 条` : ''));
    } else if (!noteRun.insert && (note.prompt || wi.anTop.length || wi.anBottom.length)) {
        info(note.interval <= 0
            ? '作者注释：频率是 0（关），这一轮不插' + (wi.anTop.length + wi.anBottom.length ? '；世界书「作者注释上 / 下」的条目也跟着不发' : '')
            : `作者注释：每 ${note.interval} 句用户输入插一次，这一轮不插（还差 ${noteRun.untilNext} 句）`
                + (wi.anTop.length + wi.anBottom.length ? '；世界书「作者注释上 / 下」的条目也跟着不发' : ''));
    }

    // ── A. 卡字段先各自替换一次（getCharacterCardFields，baseChatReplace 会先 trim）
    const raw = {
        description: str(card.description).trim(),
        personality: str(card.personality).trim(),
        persona: str(persona.description).trim(),
        scenario: str(card.scenario).trim(),
        mesExamples: str(card.mesExample).trim(),
    };
    // 简化：这一步里 {{description}} 等展开为原文（酒馆此时 replaceCharacterCard=false，会原样保留到之后再展开）
    const ctxA = { ...baseCtx, ...raw };
    const sA = (t) => substitute(t, ctxA).replace(/\r/g, '');
    const description = sA(raw.description);
    const personality = sA(raw.personality);
    const personaText = sA(raw.persona);
    const scenario = sA(raw.scenario);
    const mesExamples = sA(raw.mesExamples);
    const systemOverride = sA(str(card.systemPrompt).trim());
    const jailbreakOverride = sA(str(card.postHistoryInstructions).trim());
    const depthPromptText = card.depthPrompt ? sA(str(card.depthPrompt.prompt).trim()) : '';

    /** @type {MacroContext} 之后所有替换共用的上下文 */
    const ctx = {
        ...baseCtx,
        description, personality, scenario, persona: personaText,
        // 酒馆 {{mesExamples}} = parseMesExamples(...).join('')
        mesExamples: parseMesExamples(mesExamples).join(''),
    };
    const sub = (t) => substitute(str(t), ctx);

    // ── B. 开场白（chat[0]）先替换一次
    //    酒馆是对真正的 chat[0] 做的（script.js ~L4490，在过滤隐藏楼层之前）。所以只在传进来的第一楼确实是完整记录的第 0 楼时做
    //    （floorNo：有 chatFloors 看它，没有就看 chatOffset）：开场白被隐藏了、或被外置记忆折叠掉了，排在最前面的就是别的楼，
    //    不该多替换一次——不然同一楼发出去的文字会随「有没有别的隐藏楼」（决定调用方给不给 chatFloors）而变
    const chat0 = chat.length && floorNo(0) === 0 ? { ...chat[0], content: sub(chat[0].content) } : null;

    // ── D. 示例对话：卡里的 + 世界书示例前/后（worldinfo.js 已按最终顺序给出）
    /** @type {{block: string, id: string, label: string}[]} */
    const exampleBlocks = [];
    wi.examplesBefore.forEach((t, k) => {
        if (!str(t).length) return;
        for (const block of parseMesExamples(sub(t))) exampleBlocks.push({ block, id: `worldInfoExamplesBefore#${k}`, label: '世界书示例（前）' });
    });
    for (const block of parseMesExamples(mesExamples)) exampleBlocks.push({ block, id: 'mes_example', label: '角色卡示例' });
    wi.examplesAfter.forEach((t, k) => {
        if (!str(t).length) return;
        for (const block of parseMesExamples(sub(t))) exampleBlocks.push({ block, id: `worldInfoExamplesAfter#${k}`, label: '世界书示例（后）' });
    });

    // ── E. 场景 / 性格格式（内容为空时不套格式）
    const scenarioFormat = typeof preset.scenario_format === 'string' ? preset.scenario_format : '{{scenario}}';
    const personalityFormat = typeof preset.personality_format === 'string' ? preset.personality_format : '{{personality}}';
    const scenarioText = scenario && scenarioFormat ? sub(scenarioFormat) : scenario;
    const personalityText = personality && personalityFormat ? sub(personalityFormat) : personality;

    // ── F. 选 prompt_order，按列表顺序生成 prompt 集合（getPromptCollection）
    const promptOrders = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
    // getPromptOrderForCharacter（PromptManager ~L1208）：find(...)?.order ?? []。
    // 注意：100001 的列表存在但为空时，酒馆就真的用空列表（只会发出被追加到末尾的占位条目），不会退回默认顺序。
    const orderList = promptOrders.find((o) => String(o?.character_id) === String(DUMMY_CHARACTER_ID));
    let order = orderList ? (Array.isArray(orderList.order) ? orderList.order : []) : null;
    if (!order) {
        // 酒馆 sanitizeServiceSettings（~L1010）：没有 100001 时用默认顺序新建，而不是拿别的 character_id 的列表
        warn(`预设里没有 character_id=${DUMMY_CHARACTER_ID} 的 prompt_order，酒馆会改用内置默认顺序（main / 世界书前 / persona / 角色描述 / 性格 / 场景 / nsfw / 世界书后 / 示例 / 聊天记录 / jailbreak）`);
        order = DEFAULT_PROMPT_ORDER;
    } else {
        info(`使用 prompt_order 中 character_id=${DUMMY_CHARACTER_ID} 的列表：共 ${order.length} 条，启用 ${order.filter((e) => e?.enabled).length} 条`);
    }
    // PromptManager sanitizeServiceSettings（~L1018）+ checkForMissingPrompts（~L1043）：
    // 预设的 prompts 为空 → 整套换成默认定义；否则把缺失的默认条目（main、chatHistory 等 12 个）补到末尾。
    // 所以 prompt_order 里引用了它们而 prompts 里没有定义时，酒馆照样能拼出来。
    const ownPrompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const presetPrompts = ownPrompts.length === 0
        ? DEFAULT_PROMPTS
        : [...ownPrompts, ...DEFAULT_PROMPTS.filter((d) => !ownPrompts.some((p) => p && p.identifier === d.identifier))];
    const getPromptById = (id) => presetPrompts.find((p) => p && p.identifier === id) ?? null;
    const orderEntry = (id) => order.find((e) => e?.identifier === id) ?? null;
    const isDisabled = (id) => { const e = orderEntry(id); return e ? !e.enabled : false; };

    /** 内部 prompt 对象（相当于酒馆的 Prompt 实例），内容用 parts 表示 */
    const makePrompt = (p, parts, kind) => ({
        identifier: p.identifier,
        name: p.name ?? p.identifier,
        role: p.role,
        system_prompt: p.system_prompt,
        marker: !!p.marker,
        injection_position: p.injection_position,
        injection_depth: p.injection_depth,
        injection_order: p.injection_order ?? DEFAULT_ORDER,
        forbid_overrides: p.forbid_overrides,
        kind,
        parts,
    });
    const promptParts = (p, text) => (text ? [part(text, { kind: 'prompt', id: p.identifier, label: p.name ?? p.identifier })] : []);

    const collection = [];
    for (const entry of order) {
        const p = getPromptById(entry?.identifier);
        if (!p) {
            warn(`prompt_order 引用了不存在的条目「${entry?.identifier}」，跳过`);
            continue;
        }
        const label = `「${p.name ?? p.identifier}」(${p.identifier})`;
        if (entry.enabled && shouldTrigger(p)) {
            // preparePrompt：标记条目没有 content，替换结果为空
            collection.push(makePrompt(p, promptParts(p, p.marker ? '' : sub(p.content)), p.marker ? 'marker' : 'prompt'));
        } else {
            if (!entry.enabled) info(`${label} 未启用，跳过（其中的宏不会执行）`);
            else info(`${label} 的 injection_trigger 不含 normal，跳过`);
            if (p.identifier === 'main') {
                // 酒馆给 main 放一个空内容的替身，保证其它东西能找到 main 的位置（~L1531）
                collection.push(makePrompt(p, [], 'prompt'));
            }
        }
    }
    const indexOf = (id) => collection.findIndex((p) => p.identifier === id);

    // ── G. 填标记（preparePromptsForChatCompletion 的 systemPrompts，~L1374-1493）
    const markerContents = [
        ['worldInfoBefore', () => formatWorldInfoParts(wi.before, wi.beforeEntries, preset.wi_format, 'worldInfoBefore', 'World Info (before)')],
        ['worldInfoAfter', () => formatWorldInfoParts(wi.after, wi.afterEntries, preset.wi_format, 'worldInfoAfter', 'World Info (after)')],
        ['charDescription', () => markerText('charDescription', description)],
        ['charPersonality', () => markerText('charPersonality', personalityText)],
        ['scenario', () => markerText('scenario', scenarioText)],
    ];
    // 酒馆用的是 power_user.persona_description 原文（没经过 A 步替换），只有非空才加入
    if (str(persona.description)) markerContents.push(['personaDescription', () => markerText('personaDescription', str(persona.description))]);
    function markerText(id, text) {
        const p = getPromptById(id);
        return text ? [part(text, { kind: 'marker', id, label: p?.name ?? id })] : [];
    }
    // 作者注释的 preparePrompt（openai.js ~L1398 推进 systemPrompts，~L1488 统一 preparePrompt）：排在 scenario 之后、personaDescription 之前
    // （酒馆 systemPrompts 里 personaDescription 是在这些扩展提示后面才 push 的）。位置是「主提示之前 / 之后」时发出去的就是这次的结果；
    // 「聊天内」时这次的结果不用，I 步会对原文再求值一次——但这里的宏照样执行了（{{incvar}} 加两次），和酒馆一样
    let notePrepared = [];
    let notePreparedDone = false;
    const prepareNote = () => {
        notePreparedDone = true;
        if (noteRaw.length) notePrepared = substituteParts(noteRaw, ctx);
    };
    for (const [id, build] of markerContents) {
        if (id === 'personaDescription') prepareNote();
        const idx = indexOf(id);
        const cp = idx !== -1 ? collection[idx] : null;
        const base = getPromptById(id) ?? { identifier: id, name: id };
        const parts = substituteParts(build(), ctx); // 不管是否启用都会求值
        const prompt = makePrompt({
            identifier: id,
            name: cp?.name ?? base.name ?? id,
            role: cp?.role ?? 'system',
            system_prompt: true,
            marker: true,
            injection_position: cp?.injection_position,
            injection_depth: cp?.injection_depth,
            injection_order: cp?.injection_order,
        }, parts, 'marker');
        if (cp) {
            collection[idx] = prompt;
        } else {
            collection.push(prompt); // prompts.add：追加到集合末尾
            if (!orderEntry(id) && parts.length) {
                info(`标记 ${id} 不在 prompt_order 里，酒馆会把它追加到最后（排在聊天记录之后）`);
            }
        }
    }
    if (!notePreparedDone) prepareNote();   // 没有人设描述（personaDescription 不在 markerContents 里）

    // ── H. 角色卡覆盖 main / jailbreak（~L1495-1513）
    for (const [id, override, field] of [['main', systemOverride, 'system_prompt'], ['jailbreak', jailbreakOverride, 'post_history_instructions']]) {
        if (!override) continue;
        const idx = indexOf(id);
        if (idx === -1) {
            info(`角色卡有 ${field}，但预设里没有可用的 ${id}，不覆盖`);
            continue;
        }
        const target = collection[idx];
        if (target.forbid_overrides === true) {
            info(`角色卡有 ${field}，但 ${id} 设置了 forbid_overrides，保留预设内容`);
            continue;
        }
        if (isDisabled(id)) {
            info(`角色卡有 ${field}，但 ${id} 未启用，不覆盖`);
            continue;
        }
        const original = joinParts(target.parts); // 已经替换过宏的预设文本
        const text = substitute(override, { ...ctx, original });
        collection[idx] = {
            ...target,
            // cardField：这一段的原文是角色卡的哪个字段（「拼装」页就地编辑靠它找到原文，见 ui/prompt-edit.js）
            parts: text ? [part(text, { kind: 'prompt', id, label: `${target.name}（角色卡 ${field} 覆盖）`, cardField: field })] : [],
        };
        info(`${id} 被角色卡 ${field} 覆盖${override.match(/{{original}}/i) ? '（{{original}} 展开为预设原文）' : ''}`);
    }

    // ── 相对 / 绝对的归属（populateChatCompletion ~L1185-1347）
    // 酒馆按固定顺序调用 addToChatCompletion(id)，但每次都是 chatCompletion.add(collection, prompts.index(id))，
    // 而 add() 是 `messages.collection[position] = collection`（稀疏数组按下标赋值，~L4002）。
    // 所以「调用顺序」无关紧要，最终顺序 = prompt 集合里的下标顺序 = prompt_order 列表顺序（追加的标记在末尾）。
    // 哪些条目会被放进去：
    //   - 内置：worldInfoBefore/main/worldInfoAfter/charDescription/charPersonality/scenario/personaDescription/nsfw/jailbreak/enhanceDefinitions
    //   - 所有 system_prompt === false 的自定义条目
    //   - chatHistory / dialogueExamples（由 populateChatHistory / populateDialogueExamples 放在自己的下标处，无视注入位置）
    //   其余（system_prompt 为 true 的非内置条目、未知标记）不会被发送。
    //   以上任何条目若 injection_position === 1（含标记，如 charDescription），addToChatCompletion 会跳过它，改为聊天内注入。
    /** @type {any[]} 与 collection 下标一一对应的块 */
    const blocks = new Array(collection.length).fill(null);
    const absolutePrompts = [];
    collection.forEach((p, i) => {
        if (p.injection_position === INJECTION_ABSOLUTE) absolutePrompts.push(p);
        if (p.identifier === 'chatHistory' || p.identifier === 'dialogueExamples') return; // 稍后填
        const addable = BUILTIN_ADDED.has(p.identifier) || p.system_prompt === false;
        if (!addable) {
            if (p.marker && !KNOWN_MARKERS.has(p.identifier)) info(`未知标记「${p.name}」(${p.identifier})：酒馆不会为它填内容，跳过`);
            else if (!p.marker) warn(`「${p.name}」(${p.identifier}) 的 system_prompt 为 ${p.system_prompt}，又不是内置条目，酒馆不会发送它`);
            return;
        }
        if (isDisabled(p.identifier) && p.identifier !== 'main') return; // 追加进来的、未启用的标记
        if (p.injection_position === INJECTION_ABSOLUTE) return;
        if (p.parts.length === 0 || !joinParts(p.parts)) {
            if (!(p.identifier === 'main' && isDisabled('main'))) info(`「${p.name}」(${p.identifier}) 内容为空，酒馆会丢弃这条消息`);
        }
        blocks[i] = [{ role: ROLES.includes(p.role) ? p.role : 'system', parts: p.parts, identifier: p.identifier }];
    });

    // ── 作者注释：「主提示之前 / 之后」（populateChatCompletion 末尾的 injectToMain，openai.js ~L1265-1296）
    //   作为单独一条消息插进 main 那一组的开头 / 末尾，角色用作者注释自己的。main 没启用时那一组是空内容的替身（照样插得进去，替身本身不发）。
    //   main 是绝对位置（聊天内注入）时：复制一份，角色 / 深度 / order 都跟 main，排在 main 前 / 后，进注入列表。
    //   这一步在预算的「非聊天内容」之前做：它和 main 一样先占预算（酒馆 insert 时同样 checkTokenBudget）。
    if (noteRaw.length && note.position !== NOTE_POSITION.chat) {
        const start = note.position === NOTE_POSITION.before;
        const mainIdx = indexOf('main');
        const mainPrompt = mainIdx !== -1 ? collection[mainIdx] : null;
        if (mainPrompt && blocks[mainIdx]) {
            const msg = { role: NOTE_ROLES[note.role], parts: notePrepared, identifier: 'authorsNote' };
            if (start) blocks[mainIdx].unshift(msg); else blocks[mainIdx].push(msg);
        } else if (mainPrompt && mainPrompt.injection_position === INJECTION_ABSOLUTE) {
            const at = absolutePrompts.indexOf(mainPrompt);
            absolutePrompts.splice(start ? at : at + 1, 0, {
                identifier: 'authorsNote', name: '作者注释', role: mainPrompt.role, system_prompt: true, marker: false,
                injection_position: INJECTION_ABSOLUTE, injection_depth: mainPrompt.injection_depth, injection_order: mainPrompt.injection_order,
                kind: 'prompt', parts: notePrepared,
            });
            info(`作者注释：main 是聊天内注入，作者注释跟着它注入到深度 ${mainPrompt.injection_depth}（角色、order 也跟 main）`);
        } else {
            warn('作者注释的位置是「主提示之前 / 之后」，但预设里没有 main 条目，酒馆找不到插的地方，不发');
        }
    }

    // ── 预算第一步：回复开头的 3 个 + 调用方先占的（外置记忆块）+ 上面这些非聊天内容（此时 blocks 里只有它们）
    if (limit) {
        remaining = limit.maxContext - limit.maxTokens;
        spent.primer = REPLY_PRIMER_TOKENS;
        spent.reserved = limit.reserved;
        spent.fixed = blocks.filter(Boolean).flat().reduce((n, m) => n + tok(m), 0);
        remaining -= spent.primer + spent.reserved + spent.fixed;
        if (remaining < 0) {
            warn(`上下文上限：非聊天内容（预设、角色卡、世界书${limit.reserved ? '、外置记忆' : ''}）估算已有 ${spent.primer + spent.reserved + spent.fixed} token，`
                + `超过了预算 ${limit.maxContext - limit.maxTokens}（${limit.maxContext} − 回复预留 ${limit.maxTokens}）。`
                + '酒馆在这里会报「Mandatory prompts exceed the context size」并发出残缺的 prompt；这里照发非聊天内容，聊天记录一楼都不发。');
        }
    }

    // ── I. 聊天内注入（populationInjectionPrompts ~L810）
    // 扩展提示：角色卡深度提示 + 世界书@深度。getExtensionPrompt 按键名排序（~L3310）：
    //   'DEPTH_PROMPT' < 'customDepthWI_<depth>_<role>'（大写 D 的码位小于小写 c），所以深度提示在世界书之前。
    //   作者注释的键是 '2_floating_prompt'，数字排在字母前，所以「聊天内」的作者注释在三者最前面。
    const extensionPrompts = [];
    if (noteRaw.length && note.position === NOTE_POSITION.chat) {
        // 用宏替换之前的原文（getExtensionPrompt 对 extension_prompts 里存的原值求值），G 步那次的结果不用
        extensionPrompts.push({ depth: note.depth, role: NOTE_ROLES[note.role], parts: noteRaw });
    }
    if (card.depthPrompt && depthPromptText) {
        extensionPrompts.push({
            depth: Number(card.depthPrompt.depth ?? 4),
            role: ROLES.includes(card.depthPrompt.role) ? card.depthPrompt.role : 'system',
            parts: [part(depthPromptText, { kind: 'depthPrompt', id: 'DEPTH_PROMPT', label: '角色卡深度提示' })],
        });
    }
    for (const g of wi.depth) {
        if (!str(g?.content)) continue;
        extensionPrompts.push({
            depth: Number(g.depth),
            role: ROLES.includes(g.role) ? g.role : 'system',
            parts: worldInfoEntryParts(str(g.content), g.entries, `depth-${g.depth}-${g.role}`),
        });
    }

    const injectable = [];
    for (const p of absolutePrompts) {
        if (!joinParts(p.parts)) continue; // 酒馆：filter(prompt.content)
        if (!ROLES.includes(p.role)) {
            warn(`绝对位置条目「${p.name}」没有有效的 role（${p.role}），酒馆按 role 分组时会把它漏掉`);
            continue;
        }
        if (!isValidDepth(p.injection_depth)) {
            warn(`绝对位置条目「${p.name}」的深度 ${p.injection_depth} 不在 0..${MAX_INJECTION_DEPTH} 的整数范围内，酒馆不会注入它`);
            continue;
        }
        injectable.push(p);
        info(`「${p.name}」(${p.identifier}) 是绝对位置，注入到深度 ${p.injection_depth}（order ${p.injection_order}，${p.role}）`);
    }
    for (const e of extensionPrompts) {
        if (!isValidDepth(e.depth)) warn(`扩展提示「${e.parts[0]?.src.label}」的深度 ${e.depth} 无效，酒馆不会注入它`);
    }
    if (injectable.length || extensionPrompts.length) {
        if (indexOf('chatHistory') === -1) warn('chatHistory 未启用：聊天记录和所有聊天内注入都不会出现');
    }

    // 聊天记录先做成「新 → 旧」数组（setOpenAIMessages 的输出就是倒序的）
    const namesBehavior = Number(preset.names_behavior ?? 0);
    /** @type {any[]} */
    let history = chat.map((m, i) => {
        const depth = chat.length - 1 - i;
        const msg = i === 0 && chat0 ? chat0 : m;
        let text = str(transformChat(msg, depth));
        const role = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant';
        // names_behavior=2(CONTENT)：除旁白外都加 "名字: " 前缀（setOpenAIMessages ~L603）
        if (namesBehavior === 2 && role !== 'system') text = `${m.name}: ${text}`;
        text = text.replace(/\r/gm, '');
        return { chatIndex: i, role, name: m.name, text };
    }).reverse();

    const depths = [...new Set([...injectable.map((p) => p.injection_depth), ...extensionPrompts.map((e) => e.depth)])]
        .filter(isValidDepth).sort((a, b) => a - b);
    let totalInserted = 0;
    for (const d of depths) {
        const depthPrompts = injectable.filter((p) => p.injection_depth === d);
        const orderGroups = { [EXTENSION_ORDER]: [] };
        for (const p of depthPrompts) (orderGroups[p.injection_order ?? DEFAULT_ORDER] ??= []).push(p);
        // order 从大到小处理
        const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
        const roleMessages = [];
        for (const o of orders) {
            for (const role of ROLES) {
                const groups = [];
                const rp = orderGroups[o].filter((p) => p.role === role).flatMap((p) => p.parts);
                if (joinParts(rp)) groups.push(trimParts(rp));
                if (o === EXTENSION_ORDER) {
                    // getExtensionPrompt：每个值先 trim，用 '\n' 连接，再整体 substituteParams 一次
                    const ext = extensionPrompts.filter((e) => e.depth === d && e.role === role).map((e) => trimParts(e.parts));
                    if (ext.length) {
                        const extParts = substituteParts(ext.flat(), ctx);
                        if (joinParts(extParts)) groups.push(trimParts(extParts));
                    }
                }
                const parts = groups.flat();
                if (joinParts(parts)) roleMessages.push({ injected: true, role, parts: withDepth(parts, d) });
            }
        }
        if (roleMessages.length) {
            // 在倒序数组里插到下标 d + 已插入条数；超出长度时 splice 自动追加到末尾（=最终的最上方）
            history.splice(d + totalInserted, 0, ...roleMessages);
            totalInserted += roleMessages.length;
        }
    }
    // 翻回「旧 → 新」。注意这一翻转使同一深度内的顺序也反过来了：
    //   最终从上到下 = order 小的在上、order 大的在下；同 order 内 assistant → user → system。
    history.reverse();

    // ── J. 聊天记录（populateChatHistory ~L885）
    const chatHistoryIdx = indexOf('chatHistory');
    if (chatHistoryIdx !== -1) {
        const newChatText = sub(typeof preset.new_chat_prompt === 'string' ? preset.new_chat_prompt : '[Start a new Chat]');
        const last = history[history.length - 1];
        const sendIfEmpty = str(preset.send_if_empty);
        const addSendIfEmpty = last && last.role === 'assistant' && sendIfEmpty;
        const newChatMsg = newChatText ? { role: 'system', identifier: 'newMainChat', parts: [part(newChatText, { kind: 'utility', id: 'new_chat_prompt', label: 'new_chat_prompt' })] } : null;
        // 预算：new_chat_prompt 先预留（它总会发），send_if_empty 放得下才加，两者都先于聊天记录占预算（~L895、~L931）
        if (newChatMsg) { const t = tok(newChatMsg); spent.utility += t; remaining -= t; }
        let sendIfEmptyMsg = null;
        if (addSendIfEmpty) {
            // 原样发送，不替换宏（~L930）
            const m = { role: 'user', identifier: 'emptyUserMessageReplacement', parts: [part(sendIfEmpty, { kind: 'utility', id: 'send_if_empty', label: 'send_if_empty' })] };
            const t = tok(m);
            if (t <= remaining) { spent.utility += t; remaining -= t; sendIfEmptyMsg = m; } else dropped.sendIfEmpty = true;
        }
        // 从新到旧逐楼（含注入的条目）：先替换宏，再看预算放不放得下，放不下就停（chatPool = [...messages].reverse()，~L948-1075）。
        // 没有上限时 remaining 是 Infinity，永远放得下，宏的求值顺序和以前完全一样（新 → 旧）。
        const kept = [];        // 新 → 旧
        const emptyFloors = []; // 内容为空的楼层（新 → 旧），之后按旧 → 新写日志，和以前的日志顺序一致
        let stopAt = -1;        // history 里从这个下标（含）往前都没放进去
        for (let i = history.length - 1; i >= 0; i--) {
            const h = history[i];
            let m = null;
            if (h.injected) {
                m = { role: h.role, identifier: 'injected', parts: h.parts }; // 简化：注入的消息酒馆会再替换一遍宏，这里省略
            } else {
                h.text = sub(h.text);
                if (h.text) {
                    m = {
                        role: h.role,
                        identifier: `chatHistory-${h.chatIndex}`,
                        parts: [part(h.text, { kind: 'chat', id: String(floorNo(h.chatIndex)), label: str(h.name) })],
                    };
                    // names_behavior=1(COMPLETION)：放进 name 字段，不合法的字符替换为 _（~L957）
                    if (namesBehavior === 1 && h.name) m.name = isValidName(h.name) ? h.name : sanitizeName(h.name);
                }
            }
            // 空楼层记 0 token；canAfford(0) 只在预算已经是负数时才不成立
            const t = m ? tok(m) : 0;
            if (t > remaining) { stopAt = i; break; }
            remaining -= t;
            if (m) { spent.chat += t; kept.push(m); } else emptyFloors.push(h.chatIndex);
        }
        for (const idx of emptyFloors.reverse()) info(`第 ${floorNo(idx)} 楼内容为空，酒馆会丢弃它`);
        if (stopAt >= 0) {
            for (let i = 0; i <= stopAt; i++) {
                if (history[i].injected) dropped.injected++;
                else dropped.floors.push(history[i].chatIndex);
            }
        }
        const msgs = [];
        if (newChatMsg) msgs.push(newChatMsg);
        msgs.push(...kept.reverse());
        if (sendIfEmptyMsg) {
            msgs.push(sendIfEmptyMsg);
            info('最后一条是 assistant，按 send_if_empty 补了一条 user 消息');
        }
        blocks[chatHistoryIdx] = msgs;
    }

    // ── K. 示例对话（populateDialogueExamples ~L1101）
    const examplesIdx = indexOf('dialogueExamples');
    if (examplesIdx !== -1 && exampleBlocks.length) {
        const newExampleText = sub(typeof preset.new_example_chat_prompt === 'string' ? preset.new_example_chat_prompt : '[Example Chat]');
        const msgs = [];
        for (let bi = 0; bi < exampleBlocks.length; bi++) {
            const b = exampleBlocks[bi];
            const blockMsgs = [];
            if (newExampleText) blockMsgs.push({ role: 'system', identifier: 'newChat', parts: [part(newExampleText, { kind: 'utility', id: 'new_example_chat_prompt', label: 'new_example_chat_prompt' })] });
            parseExampleIntoIndividual(b.block, name1, name2).forEach((m, mi) => {
                if (!m.content) return; // insert() 不收空内容
                blockMsgs.push({
                    role: 'system',
                    name: m.name,
                    identifier: `dialogueExamples ${bi}-${mi}`,
                    parts: [part(m.content, { kind: 'example', id: `${b.id}:${bi}-${mi}`, label: `${m.name}（${b.label}）` })],
                });
            });
            // 预算：一整块（含 new_example_chat_prompt）一起放，放不下就停，后面的块都不发（canAffordAll ~L1124）
            const t = blockMsgs.reduce((n, m) => n + tok(m), 0);
            if (t > remaining) { dropped.examples = exampleBlocks.length - bi; break; }
            remaining -= t;
            spent.examples += t;
            msgs.push(...blockMsgs);
        }
        blocks[examplesIdx] = msgs;
    } else if (examplesIdx !== -1) {
        info('没有示例对话（mes_example 为空），dialogueExamples 不产生消息');
    }

    // ── 展平（跳过稀疏数组的空位，同 getChat）
    let flat = blocks.filter(Boolean).flat();

    // ── squash_system_messages（squashSystemMessages ~L3922）
    if (preset.squash_system_messages) {
        const exclude = ['newMainChat', 'newChat', 'groupNudge'];
        const shouldSquash = (m) => !exclude.includes(m.identifier) && m.role === 'system' && !m.name;
        const squashed = [];
        let lastMessage = null;
        let merged = 0;
        for (const m of flat) {
            if (m.role === 'system' && !joinParts(m.parts)) continue; // 强制丢掉空 system
            if (shouldSquash(m) && lastMessage && shouldSquash(lastMessage)) {
                lastMessage.parts = [...lastMessage.parts, ...m.parts]; // '\n' 连接
                merged++;
            } else {
                const copy = { ...m };
                squashed.push(copy);
                lastMessage = copy;
            }
        }
        flat = squashed;
        info(`squash_system_messages：合并了 ${merged} 条相邻的 system 消息（new_chat_prompt / new_example_chat_prompt / 带 name 的不参与）`);
    }

    // getChat：内容为空的消息不发送
    const messages = flat.filter((m) => joinParts(m.parts)).map(finalize);

    // ── L. assistant_prefill
    // 酒馆里这是 Claude 源专属：作为 generate_data.assistant_prefill 发给后端，由后端追加成最后一条 assistant 消息（~L2872-2881）；
    // 其它源（OpenAI 等）根本不使用这个字段。这里不区分源，非空就追加。
    const prefill = sub(preset.assistant_prefill);
    if (prefill) {
        messages.push({ role: 'assistant', content: prefill, sources: [{ kind: 'prefill', id: 'assistant_prefill', label: 'assistant_prefill', chars: prefill.length }] });
        info('assistant_prefill 作为最后一条 assistant 消息追加（酒馆只对 Claude 源这样做）');
    }

    if (!limit) return { messages, log };

    // ── 预算的结果。没有东西被丢时不写日志（没超限时日志和以前完全相同）
    const available = limit.maxContext - limit.maxTokens;
    const used = spent.primer + spent.reserved + spent.fixed + spent.utility + spent.chat + spent.examples;
    const floors = dropped.floors;
    /** @type {import('./types.js').AssembleBudget} */
    const budget = {
        limit: limit.maxContext,
        reply: limit.maxTokens,
        available,
        used,
        spent,
        overflow: spent.primer + spent.reserved + spent.fixed > available,
        droppedFrom: floors.length ? floorNo(Math.min(...floors)) : null,
        droppedTo: floors.length ? floorNo(Math.max(...floors)) : null,
        droppedCount: floors.length,
        keptCount: chat.length - floors.length,
        droppedInjected: dropped.injected,
        droppedExamples: dropped.examples,
        droppedSendIfEmpty: dropped.sendIfEmpty,
    };
    const head = `上下文上限（token 为估算）：预算 ${available} = ${limit.maxContext} − 回复预留 ${limit.maxTokens}，`;
    if (floors.length) {
        const all = budget.keptCount === 0;
        warn(head + (all
            ? `连最新的一楼都放不下，这次聊天记录一楼都没发（第 ${budget.droppedFrom}–${budget.droppedTo} 楼，共 ${floors.length} 楼）。酒馆也是这样：不报错，直接不发。`
            : `第 ${budget.droppedFrom}–${budget.droppedTo} 楼共 ${floors.length} 楼放不下，这次没发（从最老的开始丢）。`)
            + '聊天记录本身没有删。');
    }
    if (dropped.injected) warn(head + `${dropped.injected} 条按深度注入的消息落在被丢掉的楼层之间，跟着一起没发。`);
    if (dropped.examples) warn(head + `聊天记录之后剩下的预算不够，${dropped.examples} 块示例对话没发（示例在聊天记录之后才占预算）。`);
    if (dropped.sendIfEmpty) warn(head + 'send_if_empty 那条 user 消息放不下，没发。');
    return { messages, log, budget };
}

/** contextLimit 参数 → {maxContext, maxTokens, reserved} 或 null（不限） */
function normalizeLimit(l) {
    if (!l || typeof l !== 'object') return null;
    const maxContext = positiveInt(l.maxContext);
    if (!maxContext) return null;
    return { maxContext, maxTokens: positiveInt(l.maxTokens), reserved: positiveInt(l.reserved) };
}

function isValidDepth(d) {
    return Number.isInteger(d) && d >= 0 && d <= MAX_INJECTION_DEPTH;
}

function anGroup(key, w) {
    const texts = Array.isArray(w[key]) ? w[key] : [];
    const entries = Array.isArray(w[`${key}Entries`]) ? w[`${key}Entries`] : [];
    const keep = texts.map((t, k) => [str(t), entries[k]]).filter(([t]) => t);
    return { [key]: keep.map(([t]) => t), [`${key}Entries`]: keep.map(([, e]) => e) };
}

function normalizeWorldInfo(w) {
    w = w ?? {};
    return {
        before: str(w.before),
        after: str(w.after),
        beforeEntries: Array.isArray(w.beforeEntries) ? w.beforeEntries : [],
        afterEntries: Array.isArray(w.afterEntries) ? w.afterEntries : [],
        depth: Array.isArray(w.depth) ? w.depth : [],
        examplesBefore: Array.isArray(w.examplesBefore) ? w.examplesBefore : [],
        examplesAfter: Array.isArray(w.examplesAfter) ? w.examplesAfter : [],
        // 作者注释上 / 下：只留非空字符串（酒馆空内容的条目不进任何桶）；entries 和文本按下标对应，对不上时给 []（出处退成「条目 undefined」也不出错）
        ...anGroup('anTop', w), ...anGroup('anBottom', w),
        outlets: w.outlets && typeof w.outlets === 'object' ? w.outlets : {},
    };
}
