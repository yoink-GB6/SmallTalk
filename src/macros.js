// 宏替换（酒馆「旧版」宏引擎）。对应：
//   public/scripts/macros.js  evaluateMacros（~L610）
//   public/scripts/variables.js getVariableMacros（~L238）及 add/get/setLocalVariable
//   public/script.js  substituteParamsLegacy（~L2831）
//
// ============ 求值顺序（务必读，拼装器依赖它）============
// 旧引擎不是解析器，而是「一串正则，依次对整段文本做全局替换」：
//   preEnv（<USER>/<BOT>/<CHAR> → roll → 变量宏 → newline → trim → noop）
//   → env（original, description, personality, scenario, persona, mesExamples, user, char，按这个顺序；
//          最后是插件注册的 authorsNote / charAuthorsNote / defaultAuthorsNote）
//   → postEnv（lastMessage… → reverse → {{//}} → time/date… → outlet → random → pick）。
// 因此：在【同一次 substitute 调用内】，不是从左到右！而是按「宏种类」分批：
//   同一段文本里所有 {{setvar}} 先全部执行（按出现顺序），然后才是 addvar，再 incvar、decvar，
//   最后才是所有 {{getvar}}。所以 "{{getvar::x}}{{setvar::x::1}}" 得到 "1"（getvar 看到的是 setvar 之后的值）；
//   "{{addvar::x::1}}{{setvar::x::5}}" 里 setvar 先于 addvar 执行，结果 x=6。
//   全局变量那组（setglobalvar…getglobalvar）排在本地那组之后，同理分批。
// 跨 substitute 调用（拼装器逐条 prompt 求值）才是按调用顺序。
// 另外：getvar 在 env 之前执行，所以 {{description}} 文本里自带的 {{getvar::..}} 不会再被展开（和酒馆一致）。
//
// 与酒馆的已知差异：
//  - time/date 等不用 moment.js，用手写的英文 locale 等价格式（LT=“8:05 PM”，LL=“November 20, 2026”，dddd=“Friday”）。
//  - {{pick}}：酒馆旧引擎（public/scripts/macros.js getPickReplaceMacro ~L516，新引擎 core-macros.js ~L363 同理）的种子是
//    `${聊天ID哈希}-${原文哈希}-${偏移}`，再交给 seedrandom。这里对齐的是「按聊天固定」这个【行为】：种子里的「聊天 ID」
//    换成 ctx.seed（pipeline.js 给的是 `卡id:存档id`），伪随机用项目自己的 djb2 + mulberry32，没有 seedrandom。
//    所以同一个存档里每次拼装、刷新页面、重开浏览器结果都不变，不同存档之间可以不同；但【不会】和酒馆选出同一个选项
//    （那要同样的聊天 ID 和同样的算法）。几处具体差别：
//      · 酒馆把聊天 ID 的哈希缓存在 chat_metadata.chat_id_hash 里，跟着聊天文件走（重命名、分支都不变）；
//        我们用存档 id，所以导出 .jsonl 再导入成新存档后 pick 的结果会变（新存档 id 不同）——这是预期。
//      · 酒馆有 /reroll-pick（chat_metadata.pick_reroll_seed）可以整体重抽；这里不做。
//      · 没有 ctx.seed 时（单元测试、没卡还没存过档）退回旧行为：只用 (原文哈希, 偏移)。
//  - {{random}} / {{roll}}：默认每次都用 rng（Math.random），和酒馆一致。ctx.stableRandom 为真时（「拼装」页的开关，酒馆没有），
//    改用和 pick 同一套「seed + 原文哈希 + 偏移」的确定性取值——同一存档里每次拼装结果相同，接口的提示缓存才能命中。
//  - {{roll}} 酒馆用 droll；这里只支持 [X]dY[+-Z]。
//  - mesExamples 原样输出（酒馆会 parseMesExamples 去掉 <START> 等，那是拼装器的事）。
//  - 不支持：group/instruct/model/maxPrompt/input/timeDiff/banned/datetimeformat 等；未知宏原样保留（和酒馆一致）。

/** @typedef {import('./types.js').MacroContext} MacroContext */

const FALLBACK_RNG = () => Math.random();

// 对应 variables.js getLocalVariable：纯数字字符串会变成 Number（所以 "007" 读出来是 7）
function readVar(store, name) {
    const v = store?.[name];
    return (v?.trim?.() === '' || Number.isNaN(Number(v))) ? (v || '') : Number(v);
}
function writeVar(store, name, value) {
    if (!store || !name) return value;
    store[name] = value;
    return value;
}
// 对应 addLocalVariable / addGlobalVariable
function addVar(store, name, value) {
    if (!store) return '';
    const current = readVar(store, name) || 0;
    try {
        const parsed = JSON.parse(current);
        if (Array.isArray(parsed)) {
            parsed.push(value);
            writeVar(store, name, JSON.stringify(parsed));
            return JSON.stringify(parsed);
        }
    } catch { /* 非数组忽略 */ }
    const inc = Number(value);
    if (Number.isNaN(inc) || Number.isNaN(Number(current))) {
        const s = String(current || '') + value;
        writeVar(store, name, s);
        return s;
    }
    const n = Number(current) + inc;
    if (Number.isNaN(n)) return '';
    writeVar(store, name, n);
    return n;
}

// 简易 djb2 哈希，给 {{pick}} 当种子
function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
}
// 把哈希变成 [0,1)（mulberry32 一步）
function seeded(seed) {
    let t = (seed + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 从一个种子造一串伪随机数（mulberry32 连续取值）：{{roll::3d6}} 要掷好几次，不能每次都用同一个数 */
function seededStream(seed) {
    let s = seed >>> 0;
    return () => {
        const r = seeded(s);
        s = (s + 0x6D2B79F5) >>> 0;
        return r;
    };
}

/**
 * 确定性取值的种子：有 ctx.seed（存档）时是 `seed-原文哈希-偏移`（同酒馆的 `${chatIdHash}-${rawContentHash}-${offset}`），
 * 没有时是 `原文哈希-偏移`（以前的 pick，保持不变，旧测试和没存档时的结果都不动）。
 * kind 区分宏的种类：同一段文本里同一个偏移不可能同时是 pick 和 random，但 roll 是在【另一轮替换】里算偏移的，
 * 加上种类免得「roll 在偏移 5」和「pick 在偏移 5」拿到同一个数。pick 不加种类，保持和以前（及酒馆的写法）一样。
 */
function macroSeed(seed, rawHash, offset, kind = '') {
    const base = `${rawHash}-${offset}`;
    return hash(`${seed ? `${seed}-` : ''}${kind ? `${kind}-` : ''}${base}`);
}

// 对应 getRandomReplaceMacro / getPickReplaceMacro 的列表拆分：含 :: 按 ::，否则按逗号（\, 转义）并 trim
function splitList(listString) {
    return listString.includes('::')
        ? listString.split('::')
        : listString.replace(/\\,/g, '\u0000COMMA\u0000').split(',').map((s) => s.trim().replace(/\u0000COMMA\u0000/g, ','));
}

// 对应 getDiceRollMacro；droll 语法的简化版
function rollDice(formula, rng) {
    formula = formula.trim();
    if (/^\d+$/.test(formula)) formula = `1d${formula}`;
    const m = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(formula);
    if (!m) return '';
    const x = m[1] ? Number(m[1]) : 1;
    const y = Number(m[2]);
    if (x < 1 || y < 1 || x > 1000) return '';
    let total = m[3] ? Number(m[3]) : 0;
    for (let i = 0; i < x; i++) total += Math.floor(rng() * y) + 1;
    return String(total);
}

const pad2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function lastIdx(chat, filter) {
    for (let i = chat.length - 1; i >= 0; i--) if (!filter || filter(chat[i])) return i;
    return -1;
}

/**
 * @param {string} text
 * @param {MacroContext} ctx
 * @returns {string}
 */
export function substitute(text, ctx) {
    if (!text) return '';
    ctx = ctx ?? /** @type {any} */ ({});
    let content = String(text);
    const rawContent = content;
    const rng = typeof ctx.rng === 'function' ? ctx.rng : FALLBACK_RNG;
    const seed = typeof ctx.seed === 'string' ? ctx.seed : '';
    const rawHash = hash(rawContent);
    const stable = ctx.stableRandom === true;
    // {{random}} / {{roll}} 用的随机源：开关关着 = rng（每次都变）；开着 = 由「seed + 原文 + 这个宏的偏移」决定的一串数
    const rngAt = (kind, offset) => (stable ? seededStream(macroSeed(seed, rawHash, offset, kind)) : rng);
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const local = ctx.variables?.local;
    const global = ctx.variables?.global;
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const user = ctx.user ?? '';
    const char = ctx.char ?? '';

    const msgAt = (i) => (i >= 0 ? (chat[i]?.content ?? '') : '');

    /** @type {{regex: RegExp, replace: (...a: any[]) => any}[]} */
    const preEnv = [
        { regex: /<USER>/gi, replace: () => user },
        { regex: /<BOT>/gi, replace: () => char },
        { regex: /<CHAR>/gi, replace: () => char },
        // 偏移是在【这一轮替换时】的文本里算的（前面 <USER> 等已经换掉了）；同样的输入每次都是同样的文本，所以仍是确定的
        { regex: /{{roll[ : ]([^}]+)}}/gi, replace: (_, f, offset) => rollDice(f, rngAt('roll', offset)) },
        // —— 变量宏：顺序与 getVariableMacros 完全一致，决定了「按种类分批」的行为 ——
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, n, v) => { writeVar(local, n.trim(), v); return ''; } },
        { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_, n, v) => { addVar(local, n.trim(), v); return ''; } },
        { regex: /{{incvar::([^}]+)}}/gi, replace: (_, n) => addVar(local, n.trim(), 1) },
        { regex: /{{decvar::([^}]+)}}/gi, replace: (_, n) => addVar(local, n.trim(), -1) },
        { regex: /{{getvar::([^}]+)}}/gi, replace: (_, n) => readVar(local, n.trim()) },
        { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_, n, v) => { writeVar(global, n.trim(), v); return ''; } },
        { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_, n, v) => { addVar(global, n.trim(), v); return ''; } },
        { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_, n) => addVar(global, n.trim(), 1) },
        { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_, n) => addVar(global, n.trim(), -1) },
        { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_, n) => readVar(global, n.trim()) },
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
    ];

    // env：顺序即 substituteParamsLegacy 里 environment 的赋值顺序；user/char 放最后，
    // 这样 {{description}} 等被替换进来的文本里的 {{user}}/{{char}} 还能被后面的正则替换到。
    let originalUsed = false;
    const env = [];
    if (typeof ctx.original === 'string') {
        // 只替换一次：第二次起返回 ''
        env.push(['original', () => { if (originalUsed) return ''; originalUsed = true; return ctx.original; }]);
    }
    env.push(['description', ctx.description ?? ''], ['personality', ctx.personality ?? ''],
        ['scenario', ctx.scenario ?? ''], ['persona', ctx.persona ?? ''],
        ['mesExamples', ctx.mesExamples ?? ''], ['user', user], ['char', char],
        // 作者注释的三个宏（酒馆 authors-note.js registerAuthorsNoteMacros ~L606，经 MacrosParser.populateEnv 追加在 env 最后，
        // 所以排在 user / char 之后：正文里的 {{user}} 展开出来后不会再被替换）。值是正文原文。
        // 角色卡专属注释、默认作者注释我们没做（author-note.js 文件头），后两个永远是空串——等于酒馆里没设置时的样子
        ['authorsNote', typeof ctx.authorsNote === 'string' ? ctx.authorsNote : ''], ['charAuthorsNote', ''], ['defaultAuthorsNote', '']);
    const envMacros = env.map(([name, val]) => ({
        regex: new RegExp(`{{${name}}}`, 'gi'),
        replace: () => (typeof val === 'function' ? val() : val),
    }));

    const postEnv = [
        // 隐藏楼层（ChatMessage.hidden = 酒馆的 is_system）：酒馆 macros.js getLastMessage / getLastMessageId 不过滤，
        // 隐藏的最后一楼照样算；getLastUserMessage / getLastCharMessage 的过滤条件里有 !m.is_system，跳过隐藏的楼
        // （scripts/macros.js ~L388-L410，新引擎 scripts/macros/definitions/chat-macros.js 同样如此）
        { regex: /{{lastMessage}}/gi, replace: () => msgAt(lastIdx(chat)) },
        { regex: /{{lastMessageId}}/gi, replace: () => { const i = lastIdx(chat); return i >= 0 ? String(i) : ''; } },
        { regex: /{{lastUserMessage}}/gi, replace: () => msgAt(lastIdx(chat, (m) => m.role === 'user' && m.hidden !== true)) },
        { regex: /{{lastCharMessage}}/gi, replace: () => msgAt(lastIdx(chat, (m) => m.role === 'assistant' && m.hidden !== true)) },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, s) => Array.from(s).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' }, // 注释，可跨行
        { regex: /{{time}}/gi, replace: () => { const h = now.getHours(); return `${h % 12 || 12}:${pad2(now.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`; } },
        { regex: /{{date}}/gi, replace: () => `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}` },
        { regex: /{{weekday}}/gi, replace: () => DAYS[now.getDay()] },
        { regex: /{{isotime}}/gi, replace: () => `${pad2(now.getHours())}:${pad2(now.getMinutes())}` },
        { regex: /{{isodate}}/gi, replace: () => `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` },
        { regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => ctx.outlets?.[key.trim()] || '' },
        { regex: /{{random\s?::?([^}]+)}}/gi, replace: (_, l, offset) => { const list = splitList(l); return list[Math.floor(rngAt('random', offset)() * list.length)] ?? ''; } },
        {
            regex: /{{pick\s?::?([^}]+)}}/gi,
            replace: (_, l, offset) => {
                const list = splitList(l);
                const r = seeded(macroSeed(seed, rawHash, offset));
                return list[Math.floor(r * list.length)] ?? '';
            },
        },
    ];

    for (const macro of [...preEnv, ...envMacros, ...postEnv]) {
        if (!content) break;
        // 没有花括号就不用跑了（<USER> 这类尖括号宏除外），同 evaluateMacros
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;
        try {
            content = content.replace(macro.regex, (...args) => String(macro.replace(...args)));
        } catch (e) {
            // 酒馆同样吞掉异常继续
        }
    }
    return content;
}
