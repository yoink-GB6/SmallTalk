// 存储的数据结构（schema 版本 2）和从版本 1 的迁移。纯函数，不碰 DOM / IndexedDB，Node 里可测。
// 键布局（见 types.js「多卡多存档」）：
//   'meta' → StoreMeta，'global' → GlobalRecord，'card:<cardId>' → CardRecord，'chat:<cardId>:<chatId>' → ChatRecord，
//   'preset:<presetId>' → PresetRecord（多预设，见文件末尾）
// 版本 1 是单独一个键 'state'，里面就是当时运行时 state 对象的整份拷贝。

import { sanitizeRegexScript } from './regex.js';
import { sanitizePreset } from './preset-sanitize.js';
import { parseWorldbook } from './card.js';
import { normalizeBookScope } from './books.js';
import { normalizeScriptTree } from './scripts.js';

export const SCHEMA_VERSION = 2;

export const cardKey = cardId => `card:${cardId}`;
export const chatKey = (cardId, chatId) => `chat:${cardId}:${chatId}`;
export const chatPrefix = cardId => `chat:${cardId}:`;
// 不在 types.js 的键布局里（我们加的）：每张卡一份小目录，切换时只读它就能列出存档，不用把每个存档整条读出来。
// 和存档写在同一个事务里；丢了或对不上时从存档重建（见 archive.js loadIndex）
export const indexKey = cardId => `index:${cardId}`;
// 迁移时理解不了、没能放进新结构的原始数据，原样备份在这里，程序永远不会自动删它
export const V1_BACKUP_KEY = 'state.v1.bak';

/**
 * 目录里一个存档的条目。hl = 这个存档有几条划线（ChatRecord.highlights）：有才写（没有划线的存档条目和以前一模一样）。
 * 摘抄页（第二段）靠它先挑出有划线的存档，只把那几个存档整条读出来。目录丢了 / 对不上时从存档重建，走的也是这里，所以计数跟着重建。
 * 划线功能出现之前写的目录没有 hl：那时还没有划线，缺 = 0 是对的。
 */
export function indexEntry(chat) {
    const e = { name: chat.name, count: Array.isArray(chat.messages) ? chat.messages.length : 0, updatedAt: chat.updatedAt, createdAt: chat.createdAt };
    const hl = Array.isArray(chat.highlights) ? chat.highlights.filter(h => isObj(h)).length : 0;
    if (hl) e.hl = hl;
    return e;
}

/** 从整条存档记录建目录 */
export function buildIndex(cardId, chats) {
    return { cardId, chats: Object.fromEntries(chats.map(c => [c.id, indexEntry(c)])) };
}

/**
 * 上下文上限（GlobalRecord.contextLimit）的默认值。
 * 它【不在】defaultGlobal() 里（加进去会改变旧数据迁移的输出），但运行时 state 的初值有它（src/ui/state.js 引用这个常量），
 * 所以页面第一次保存就会把它原样写进 'global'。isPristineGlobal 把「等于这个默认值的 contextLimit」视同没有。
 * 另：src/ui/tab-prompt.js 里还各写着一份同样的字面量（{ mode: 'preset', maxContext: 32000 }），改这里要一起改。
 */
export const DEFAULT_CONTEXT_LIMIT = Object.freeze({ mode: 'preset', maxContext: 32000 });

/**
 * 全局记录里绝不能当成普通字段处理的键：赋给对象时会改它的原型，而不是加一个字段。
 * JSON.parse('{"__proto__": …}') 会产生一个【自有】的 __proto__ 属性，展开（{...x}）、structuredClone 都会原样带着它，
 * 之后一旦 Object.assign / obj[k] = v 到别的对象上，就换掉了那个对象的原型。备份恢复、读全局记录时都要跳过它们。
 */
export const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** 是不是「还是默认值的 contextLimit」（键顺序无关；多了 / 少了字段都不算） */
const isDefaultContextLimit = v => isObj(v) && Object.keys(v).length === Object.keys(DEFAULT_CONTEXT_LIMIT).length
    && Object.entries(DEFAULT_CONTEXT_LIMIT).every(([k, x]) => v[k] === x);

/** 全局层还是出厂默认（用户没动过）？ */
export function isPristineGlobal(rec) {
    // 「选了哪个模型」不算用户内容：这些字段在加载时会被自动补上 / 转换（见 state.js 的 migrateModelRefs），
    // 如果把它们算进来，任何存过一次的 global 都不再「原始」，下面依赖这个判断的旧数据接管逻辑就失效了。
    const strip = (g) => {
        const { chatModel, model, ...rest } = g;
        // 上下文上限：运行时第一次保存就会写进默认值（见 DEFAULT_CONTEXT_LIMIT），还是默认值就不算用户动过；改过的照常参与比较
        if (isDefaultContextLimit(rest.contextLimit)) delete rest.contextLimit;
        // 新形状的 global 用 activePresetId 指向预设记录；null（用内置默认预设）和旧形状的 preset: null 是一回事
        if (rest.activePresetId === null) delete rest.activePresetId;
        const { modelRef, model: memModel, openaiModel, ...memory } = rest.memory ?? {};
        return { ...rest, memory };
    };
    return JSON.stringify(strip(normalizeGlobal(rec))) === JSON.stringify(strip(defaultGlobal()));
}

/** 没导入角色卡时用的空卡（名字 Assistant）。每次返回新对象，免得被原地改到。 */
export function emptyCard() {
    return {
        name: 'Assistant', description: '', personality: '', scenario: '', firstMes: '', alternateGreetings: [],
        mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', depthPrompt: null,
        worldName: '', worldEntries: [], regexScripts: [], raw: {},
    };
}

/** 全局层的默认值。运行时 state 的初值也从这里来，两边不会对不上。 */
export function defaultGlobal() {
    return {
        // 预设：运行时 state 上仍是这两个字段（指向「当前预设」）。存储里的新形状 global 不再带它们，
        // 改存 activePresetId，预设本体在 'preset:<id>'（见下面的 toGlobalV2 / planPresetMigration）
        preset: null,          // 酒馆预设原始 JSON | null（null = 用内置默认预设）
        presetName: '',
        books: [],             // 额外导入的世界书 [{name, entries: WorldEntry[], enabled?: false, scope?: 'cards', cards?: string[]}]（后三个见 books.js）
        globalRegex: [],       // 单独导入的正则脚本
        persona: { name: 'User', description: '' },
        globalVariables: {},   // 对应 state.variables.global
        wi: { scanDepth: 2, recursive: true, maxRecursionSteps: 0, caseSensitive: false, matchWholeWords: false, includeNames: true },
        manual: false,
        model: '',
        // 外置记忆：keep = 最近几楼照发原文，更早的换成每轮一行的摘要；model = 做压缩用的模型（默认最轻量的）
        memory: { enabled: true, model: 'haiku', keep: 6 },
    };
}

/** 属于「当前卡 / 当前存档」的 state 字段，其余字段全部算全局（以后 state 新加的字段自动跟着全局层存） */
export const NON_GLOBAL_KEYS = ['card', 'avatar', 'chat', 'variables'];

/**
 * 「默认不写」的全局字段：运行时 state 的初值里没有它们，只有用户用到时才出现在 global 里
 * （多人设的 personas / activePersonaId、便签 notes、以前「便签」页「隐藏已完成」的开关 notesHideDone——
 *  这个开关 2026-11-22 界面精简时去掉了，字段已废弃、界面不再读写；留在表里是为了旧数据里的值读档时照旧按这里的规则处理，见 data-inventory.js）。
 * 不放进 defaultGlobal() 的理由见 types.js GlobalRecord.personas。
 * 用到它的地方：
 *   - test/data-inventory.test.mjs：「全局字段有哪些」= state 初值写出来的字段 + 这张表；
 *   - src/ui/state.js 读档（applyGlobal / reloadGlobalFromStore）：存储里【没有】这些键时，把 state 上的同名键删掉。
 *     不删的话，运行中「用备份里的设置替换」之后 state 上会残留替换前的值，下一次保存又把它写回去。
 * 以后再加这种字段，要加在这里，并到 src/data-inventory.js 登记。
 */
//   stableRandom（只认 true）、promptCache（只认 false，没有 = 开）：「拼装」页里和提示缓存有关的两个开关，见 types.js GlobalRecord。
export const OPTIONAL_GLOBAL_KEYS = Object.freeze(['personas', 'activePersonaId', 'notes', 'notesHideDone', 'stableRandom', 'promptCache']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 补齐默认值：老数据（比如 memory 设置出现之前存的）缺的字段用默认值填上；嵌套的设置对象按字段合并。
 * 不认识的字段原样保留。返回新对象，不改输入。
 */
export function normalizeGlobal(rec) {
    const d = defaultGlobal();
    const src = isObj(rec) ? structuredClone(rec) : {};
    const out = { ...d, ...src };
    for (const k of ['persona', 'wi', 'memory']) out[k] = { ...d[k], ...(isObj(src[k]) ? src[k] : {}) };
    // 额外世界书 / 全局正则里的坏条目（null、数字……）丢掉：它们会让 scanWorldInfo、ui/pipeline.js allScripts、「世界书」页渲染抛错，
    // 消息发不出去、那本书在界面上也删不掉。读档时就清掉，存储里已经被写坏的数据下一次保存就自己好了
    out.books = cleanBooks(out.books).list;
    out.globalRegex = cleanRegexList(out.globalRegex).list;
    if (!isObj(out.globalVariables)) out.globalVariables = {};
    if (out.preset !== null && !isObj(out.preset)) out.preset = null;
    // 旧形状的 global（多预设之前）里预设本体就在这儿：酒馆的连接信息（反代密码等，见 preset-sanitize.js）一样要去掉。
    // 读档时去掉 → 下一次保存按 state 重写 global 时就不再带着它们；正则字段类型也一起校正（cleanPresetBody）
    if (isObj(out.preset)) out.preset = cleanPresetBody(out.preset).preset;
    return out;
}

/**
 * 预设本体进入系统时的统一清洗（所有入口都调它：导入文件、酒馆 zip、整体备份恢复、旧格式迁移、读档）：
 *   1. 去掉酒馆的连接信息（反代地址 / 密码、自定义请求头……，清单和兜底规则见 preset-sanitize.js）；
 *   2. 预设自带的正则（extensions.regex_scripts）校正字段类型（cleanRegexList）：它们和全局正则、卡的正则一起跑，
 *      类型不对会让消息发不出去。不是数组的当作没有（[]），校正不了的脚本丢掉。
 * 不改输入。没有任何要改的地方时返回【同一个对象】（调用方可以拿 === 判断「变没变」）。
 * @returns {{preset: Object, removed: string[], filled: string[], badRegex: number}}
 *          removed / filled：见 sanitizePreset（字段名，不含值）；badRegex：丢掉的正则条数
 */
export function cleanPresetBody(preset) {
    if (!isObj(preset)) return { preset, removed: [], filled: [], badRegex: 0 };
    const s = sanitizePreset(preset);
    let out = s.preset, badRegex = 0;
    const ext = out.extensions;
    if (isObj(ext) && ext.regex_scripts !== undefined && ext.regex_scripts !== null) {
        const c = cleanRegexList(ext.regex_scripts);
        badRegex = c.bad;
        const same = Array.isArray(ext.regex_scripts) && c.list.length === ext.regex_scripts.length && c.list.every((x, i) => x === ext.regex_scripts[i]);
        if (!same) out = { ...out, extensions: { ...ext, regex_scripts: c.list } };
    }
    return { preset: out, removed: s.removed, filled: s.filled, badRegex };
}

/**
 * 额外世界书列表的容错（读档的 normalizeGlobal、恢复备份的两条路径都用它，规则只有这一份）：
 *   - 不是数组 → []；不是对象的书丢掉（badBooks +1）；
 *   - 书的 entries 是酒馆世界书文件的原始形状（对象，键是编号 {"0": {...}, "1": {...}}）：用 card.js parseWorldbook 转成我们的数组形状
 *     （和拖世界书文件导入同一套），两种模式都这样——以前直接当空，下一次保存就把条目永久丢了；
 *   - 书的 entries 既不是数组也不是对象（认不出来）：
 *     读档时（strict 为假）保留这本书、entries 当空——书名还在界面上，用户看得到、能自己删；
 *       原来的值原样挂在这本书的 unreadableEntries 字段上，不丢（只有手改存储才会出现，留着以后能找回来）。
 *       这个字段没有任何地方读：拼装 / 扫描只看 entries，「世界书」页只画 entries，导出世界书只序列化 entries（card-export.js serializeWorldbook），
 *       整体备份原样带着它（恢复时 bookSig 把它算进内容，不影响去重的正确性）；
 *     恢复备份时（strict 为真）整本跳过、算「格式不对」——没有内容的书没必要加进来，加进来反倒多一本空书；
 *   - entries 里不是对象的条目丢掉（badEntries +1）；
 *   - 名字不是文字的，读档时换成「未命名世界书」（恢复时由调用方另起名字）；
 *   - 书上不认识的字段原样保留（{...b}）；开关 / 范围 / 绑定三个字段（enabled / scope / cards）过一遍 books.js normalizeBookScope：
 *     类型不对的按缺省处理（启用、所有聊天），cards 里不是字符串的丢掉，默认值的键删掉。已经规范的书还是同一个对象。
 * 返回新数组，书和条目是浅拷贝（条目对象本身原样引用；调用方要深拷贝的自己 structuredClone）。
 * @returns {{list: Object[], badBooks: number, badEntries: number}}
 */
export function cleanBooks(raw, { strict = false } = {}) {
    if (!Array.isArray(raw)) return { list: [], badBooks: 0, badEntries: 0 };
    const list = [];
    let badBooks = 0, badEntries = 0;
    for (const b of raw) {
        if (!isObj(b)) { badBooks++; continue; }
        if (isObj(b.entries)) {
            // 酒馆的原始形状：转成数组。条目的 book 字段用书名（和导入世界书文件时一样）；不是对象的条目 parseWorldbook 会丢掉，这里计数
            const name = typeof b.name === 'string' || strict ? b.name : '未命名世界书';
            const raw = Object.values(b.entries);
            const entries = parseWorldbook({ entries: b.entries }, typeof name === 'string' ? name : '');
            badEntries += raw.length - entries.length;
            list.push({ ...b, name, entries });
            continue;
        }
        if (!Array.isArray(b.entries)) {
            if (strict) { badBooks++; continue; }
            const kept = b.entries === undefined || b.entries === null ? {} : { unreadableEntries: b.entries };
            list.push({ ...b, name: typeof b.name === 'string' ? b.name : '未命名世界书', entries: [], ...kept });
            continue;
        }
        const entries = b.entries.filter(isObj);
        badEntries += b.entries.length - entries.length;
        const name = typeof b.name === 'string' || strict ? b.name : '未命名世界书';
        list.push(entries.length === b.entries.length && name === b.name ? b : { ...b, name, entries });
    }
    return { list: list.map(normalizeBookScope), badBooks, badEntries };
}

/**
 * 正则脚本列表的容错（全局正则、卡自带的、预设自带的都走这里，规则只有这一份）：
 *   不是数组 → []；每条过 regex.js sanitizeRegexScript：不是对象 / 没有字符串的 findRegex 的丢掉（计入 bad），
 *   字段类型不对的校正（规则见那个函数）。字段都对的脚本原样保留【同一个对象】。返回 {list, bad}
 */
export function cleanRegexList(raw) {
    if (!Array.isArray(raw)) return { list: [], bad: 0 };
    const list = [];
    for (const s of raw) {
        const c = sanitizeRegexScript(s);
        if (c) list.push(c);
    }
    return { list, bad: raw.length - list.length };
}

/** 运行时 state → GlobalRecord（不拷贝，调用方负责 structuredClone） */
export function globalFromState(s) {
    const rec = {};
    for (const [k, v] of Object.entries(s)) if (!NON_GLOBAL_KEYS.includes(k)) rec[k] = v;
    rec.globalVariables = s.variables?.global ?? {};
    return rec;
}

/**
 * 卡缺的字段用空卡补齐（老版本导入的卡可能少字段）。
 * 卡自带的正则也在这里校正字段类型（cleanRegexList）：从存储读卡（archive.js activateCard）、整体备份恢复时比较卡的内容（backup.js cardSig）
 * 都经过这里，两边按同一个规则校正，去重才对得上。字段都对时 regexScripts 还是原来那个数组。
 */
export function normalizeCard(card) {
    const out = { ...emptyCard(), ...(isObj(card) ? card : {}) };
    const c = cleanRegexList(out.regexScripts);
    if (!Array.isArray(out.regexScripts) || c.list.length !== out.regexScripts.length || c.list.some((x, i) => x !== out.regexScripts[i])) out.regexScripts = c.list;
    // 卡自带世界书的整本开关（types.js Card.worldDisabled）：只认 true，别的值（false、'yes'、1……）一律当作启用、删掉这个键（默认值不写）
    if (out.worldDisabled !== true) delete out.worldDisabled;
    // 酒馆助手脚本（types.js Card.scripts）：没有 = 跟着 raw（不补这个键）；不是数组 = 坏数据，删掉回到跟着 raw；是数组就规范化（已经规范的还是同一个数组）
    if (Object.hasOwn(out, 'scripts')) {
        const t = normalizeScriptTree(out.scripts);
        if (t === null) delete out.scripts; else out.scripts = t;
    }
    return out;
}

/** 存档的默认名字：「角色名 - 本地日期时间」 */
export function chatName(cardName, date) {
    const p = n => String(n).padStart(2, '0');
    const d = date instanceof Date ? date : new Date(date);
    return `${cardName || 'Assistant'} - ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 新建存档的默认名字：「角色名 人设名 年-月-日」（例：艾拉 小明 2026-11-22）；人设名为空就省掉。
 * 只用于以后新建的存档；上面的 chatName 是 v1 迁移出来的存档的老格式，已有存档的名字不改。
 */
export function newChatName(cardName, personaName, date) {
    const p = n => String(n).padStart(2, '0');
    const d = date instanceof Date ? date : new Date(date);
    // 人设名还是默认的 User（没改过人设）时省掉，不然每个存档名里都挂着一个没信息量的 User
    let who = typeof personaName === 'string' ? personaName.trim() : '';
    if (who === 'User') who = '';
    return [cardName || 'Assistant', who, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`].filter(Boolean).join(' ');
}

/**
 * 版本 1 → 2。纯函数：不改 oldState，返回要写入的各条记录。
 * @param {Object} oldState
 * @param {{now: Date, newId: () => string}} deps
 * @returns {{meta: {version: 2, activeCardId: string|null}, global: Object, cards: Object[], chats: Object[], discarded: string[]}}
 *          discarded：旧数据里没能迁移的部分（非空时调用方要把旧数据整份备份到 V1_BACKUP_KEY）
 */
export function migrateV1(oldState, { now, newId }) {
    const old = isObj(oldState) ? structuredClone(oldState) : {};
    const iso = now.toISOString();
    // 形状不对、迁移不了的东西记在 discarded 里：调用方据此把整份旧数据备份起来，而不是悄悄丢掉
    const discarded = [];
    const nonEmpty = v => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(isObj(v) && !Object.keys(v).length);
    if (oldState !== undefined && oldState !== null && !isObj(oldState)) discarded.push('整个旧数据不是对象');
    if (nonEmpty(old.chat) && !Array.isArray(old.chat)) discarded.push('chat 不是数组');
    if (nonEmpty(old.card) && !isObj(old.card)) discarded.push('card 不是对象');
    if (nonEmpty(old.avatar) && !isObj(old.card)) discarded.push('有头像但没有角色卡');
    if (nonEmpty(old.variables) && !isObj(old.variables)) discarded.push('variables 不是对象');
    if (nonEmpty(old.variables?.local) && !isObj(old.variables.local)) discarded.push('variables.local 不是对象');
    if (nonEmpty(old.variables?.global) && !isObj(old.variables.global)) discarded.push('variables.global 不是对象');
    const local = isObj(old.variables?.local) ? old.variables.local : {};
    const rawMessages = Array.isArray(old.chat) ? old.chat : [];
    // 消息必须是对象（数组里的 null / 空位 / 字符串渲染时会出错）
    const messages = rawMessages.filter(m => isObj(m));
    if (messages.length !== rawMessages.length) discarded.push(`${rawMessages.length - messages.length} 条消息不是对象`);

    const global = normalizeGlobal(globalFromState({ ...old, variables: { global: isObj(old.variables?.global) ? old.variables.global : {} } }));

    const cards = [], chats = [];
    // 有卡 → 卡 + 一个存档；没卡但有聊天（或聊天变量）→ 建一张空的 Assistant 卡挂着它，聊天不能丢
    const hasCard = isObj(old.card);
    if (hasCard || messages.length || Object.keys(local).length) {
        const card = hasCard ? normalizeCard(old.card) : emptyCard();
        const cardId = newId(), chatId = newId();
        cards.push({ id: cardId, card, avatar: hasCard && typeof old.avatar === 'string' ? old.avatar : '', createdAt: iso, activeChatId: chatId, usedAt: iso });
        chats.push({ id: chatId, cardId, name: chatName(card.name, now), createdAt: iso, updatedAt: iso, messages, variables: local });
    }
    // 全局层里形状不对的字段（normalizeGlobal 会换成默认值）也算丢弃
    for (const k of ['persona', 'wi', 'memory', 'books', 'globalRegex', 'preset']) {
        const want = k === 'books' || k === 'globalRegex' ? Array.isArray : k === 'preset' ? (v => v === null || isObj(v)) : isObj;
        if (k in old && nonEmpty(old[k]) && !want(old[k])) discarded.push(`${k} 的格式不对`);
    }
    return { meta: { version: SCHEMA_VERSION, activeCardId: cards[0]?.id ?? null }, global, cards, chats, discarded };
}

/** 简单的字符串指纹（FNV-1a 32 位 + 长度），用来认出「迁移完成但没来得及删掉的旧 state」 */
export function fingerprint(value) {
    const s = JSON.stringify(value) ?? '';
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `${s.length}:${(h >>> 0).toString(16)}`;
}

// ───────────────────────────── 多预设 ─────────────────────────────
// 每个预设一个键 'preset:<id>' → PresetRecord {id, name, preset, createdAt, updatedAt}（preset 是酒馆原始 JSON，不转换）。
// 'global' 里只记 activePresetId。这样发一条消息只重写 global（小），不会把所有预设（每个可能几十上百 KB）重写一遍。
// 旧形状的 global（没有 activePresetId 这个键，预设本体在 global.preset）由 state.js 在启动时升级，规则见 planPresetMigration。

export const PRESET_PREFIX = 'preset:';
export const presetKey = id => `${PRESET_PREFIX}${id}`;

/** 存储里的 global 是不是旧形状（预设本体还在里面）。判断依据是「有没有 activePresetId 这个键」，值是 null 也算新形状 */
export function isLegacyGlobal(rec) {
    return isObj(rec) && !('activePresetId' in rec);
}

/** GlobalRecord（含 preset / presetName 的那种，比如 globalFromState 的结果）→ 新形状：去掉预设本体和名字，只留 id。不改输入 */
export function toGlobalV2(rec, activePresetId) {
    const { preset, presetName, ...rest } = isObj(rec) ? rec : {};
    return { ...rest, activePresetId: activePresetId ?? null };
}

/** 名字撞了就在后面加「 (2)」「 (3)」……（同名预设不合并，只是区分开） */
export function uniquePresetName(name, taken) {
    return makeUniqueNamer(taken)(name);
}

/**
 * 一次要起很多个名字时用（恢复备份时给几百本世界书 / 预设去重名）：返回一个起名函数，每起一个就记进「已用」里。
 * 结果和对每个名字分别调 uniquePresetName(名字, 到目前为止用过的所有名字) 一模一样，但总耗时是线性的：
 * 每个基础名记住「下一个该试的序号」，不用每次从 (2) 重新数。
 * 为什么可以记：名字只增不减，某个基础名「最小的空闲序号」只会变大，不会变小，所以从上次停下的地方接着试就对了。
 * 以前每次都 new Set(全部名字) 再从 2 数起，一份塞了上万本同名书的备份（手改 / 恶意的）要卡好几秒。
 * @param {Iterable<string>} taken  已经用掉的名字
 * @returns {(name: string) => string}
 */
export function makeUniqueNamer(taken) {
    const used = new Set(taken);
    const next = new Map();   // 基础名 → 下一个该试的序号
    return name => {
        const base = String(name ?? '').trim() || '未命名预设';
        let out = base;
        if (used.has(base)) {
            let i = next.get(base) ?? 2;
            while (used.has(`${base} (${i})`)) i++;
            next.set(base, i + 1);
            out = `${base} (${i})`;
        }
        used.add(out);
        return out;
    };
}

/**
 * 旧形状 global → 要写的预设记录 + 新形状 global。纯函数，不改输入。
 * 可以重复执行：existing（存储里已有的预设记录）里已经有一条内容一字不差的，就直接用它，不再新建
 * ——上次升级写完了预设记录、却没来得及改 global 时，再跑一次不会多出一个重复的预设。
 * @param {Object} legacy   旧形状的 global（preset 为 null 时不需要预设记录）
 * @param {Object[]} existing  存储里已有的 PresetRecord
 * @param {{now: Date, newId: () => string}} deps
 * @returns {{record: Object|null, create: boolean, global: Object}}
 *          record：之后要指向的预设记录（null = 用内置默认预设）；create：record 需要写入（false = 复用已有的）
 */
export function planPresetMigration(legacy, existing, { now, newId }) {
    const g = isObj(legacy) ? legacy : {};
    // 旧 global 里的预设也是「进入系统」：先清洗（去掉酒馆的连接信息、校正正则，见 cleanPresetBody）。
    // 和已有记录比较时两边都按清洗后的比：上次升级写下的记录（那时还没有清洗）带着密码，也要认得出是同一个
    const body = isObj(g.preset) ? cleanPresetBody(g.preset).preset : null;
    if (!body) return { record: null, create: false, global: toGlobalV2(g, null) };
    const json = JSON.stringify(body);
    const same = (existing ?? []).find(r => isObj(r) && typeof r.id === 'string' && isObj(r.preset) && JSON.stringify(cleanPresetBody(r.preset).preset) === json);
    if (same) return { record: same, create: false, global: toGlobalV2(g, same.id) };
    const iso = now.toISOString();
    const name = uniquePresetName(g.presetName || '导入的预设', (existing ?? []).map(r => r?.name));
    const record = { id: newId(), name, preset: structuredClone(body), createdAt: iso, updatedAt: iso };
    return { record, create: true, global: toGlobalV2(g, record.id) };
}

/** 存储里读出来的东西像不像一条预设记录（坏掉的记录不进列表，也不会被当成当前预设装进来） */
export function isPresetRecord(rec) {
    return isObj(rec) && typeof rec.id === 'string' && rec.id !== '' && isObj(rec.preset);
}
