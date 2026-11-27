// 共享状态：state（持久化）、ui（运行期）、默认预设 / 空卡，以及 save（把 state 写回分层的存储）。
// state、ui 只在这里定义一次，其它模块按引用导入，不要复制。
//
// 存储分三层（键布局见 types.js「多卡多存档」和 migrate.js）：全局 / 卡 / 存档。
// state 的形状没变，永远是「当前卡的当前存档」；这里负责把它拆回各层记录：
//   state.card + state.avatar           → 'card:<cardId>'
//   state.chat + state.variables.local  → 'chat:<cardId>:<chatId>'
//   state.preset + state.presetName     → 'preset:<当前预设 id>'（多预设，见文件末尾「多预设」一节）
//   其余字段 + state.variables.global    → 'global'（预设只记 activePresetId）
// 启动、切换卡 / 存档由 archive.js 负责（它调用这里的 applyCardChat / flushNow）；切换预设在这里（switchPreset 等）。

import { store } from '../store.js';
import { toast, uid } from './dom.js';
import { alignPersonas } from '../personas.js';
import { normalizeNotes } from '../notes.js';
import {
    defaultGlobal, emptyCard, normalizeGlobal, globalFromState, newChatName, cardKey, chatKey, indexKey, indexEntry, SCHEMA_VERSION,
    PRESET_PREFIX, presetKey, isLegacyGlobal, toGlobalV2, uniquePresetName, planPresetMigration, isPresetRecord,
    NON_GLOBAL_KEYS, UNSAFE_KEYS, OPTIONAL_GLOBAL_KEYS, DEFAULT_CONTEXT_LIMIT, cleanPresetBody,
} from '../migrate.js';
import { sanitizePreset } from '../preset-sanitize.js';
import { storedAuthorNote } from '../author-note.js';
import { normalizeMerged } from '../memory-fold.js';
import { cardVarsKey, normalizeCardVars } from '../cardvars.js';
import {
    chatDoc, storedHighlights, newHighlight, addHighlight, removeHighlight, setHighlightNote, shiftAfterEdit, afterDeleteFloors, afterTruncate,
} from '../highlight.js';

// ───────────────────────────── 状态 ─────────────────────────────

/** 没导入预设时用的最小预设，结构和酒馆的 Default 预设一致。 */
export const DEFAULT_PRESET = {
    names_behavior: 0,
    squash_system_messages: false,
    send_if_empty: '',
    assistant_prefill: '',
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    new_chat_prompt: '[Start a new Chat]',
    new_example_chat_prompt: '[Example Chat]',
    prompts: [
        { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.", injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
        { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
        { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
        { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
        { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
        { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
        { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false },
    ],
    prompt_order: [{
        character_id: 100001,
        order: ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak']
            .map(identifier => ({ identifier, enabled: true })),
    }],
    extensions: { regex_scripts: [] },
};

export const EMPTY_CARD = emptyCard();

// 全局层字段的默认值和注释在 migrate.js defaultGlobal() 里（迁移补默认值也用它，两边不会对不上）
const { globalVariables: _gv, ...GLOBAL_DEFAULTS } = defaultGlobal();

export const state = {
    card: null,            // Card | null（null = 没导入角色卡，用 EMPTY_CARD）
    avatar: '',            // data URL
    chat: [],              // ChatMessage[]，旧 → 新
    variables: { local: {}, global: {} },   // local 跟着存档走，global 跟着全局层走
    ...GLOBAL_DEFAULTS,    // preset / presetName / books / globalRegex / persona / wi / manual / memory
    // 「接口 + 模型」引用（规格见 types.js「模型接口 v2」）。旧字段 model / memory.model 不再使用，读档时由 migrateModelRefs 转换
    chatModel: { endpoint: 'claude-code', model: '' },
    memory: { enabled: GLOBAL_DEFAULTS.memory.enabled, keep: GLOBAL_DEFAULTS.memory.keep, modelRef: { endpoint: 'claude-code', model: 'haiku' } },
    // 上下文上限（types.js GlobalRecord.contextLimit）。默认跟随预设的 openai_max_context；旧数据没有这个字段时就用这里的值。
    // 跟着全局层存（globalFromState 会带上 state 里所有非卡 / 存档字段），读的时候由 assemble.js resolveContextLimit 做校验
    // 默认值定义在 migrate.js（isPristineGlobal 也要认它）；拷一份，别让原地修改碰到那个冻结的常量
    contextLimit: { ...DEFAULT_CONTEXT_LIMIT },
};

/** 运行期状态，不持久化 */
export const ui = {
    busy: false,
    switching: false,       // 正在切换卡 / 存档（archive.js），期间不许发送
    abort: null,
    preview: null,          // 最近一次 computePrompt 的结果
    previewIsSent: false,   // 检查器里显示的是「真正发出去的」还是「预览」
    frameLog: [],
    rendered: new Map(),    // 楼层号 → 上次渲染用的文本，避免无谓地重建 iframe
    openPrompts: new Set(), // 预设页里展开的条目
    openMsgs: new Set(),    // 拼装页里展开的消息
    showSerialized: false,
    endpoints: null,        // 接口列表的共享缓存（PublicEndpoint[]），null = 还没读到 / 读取失败，见 model-picker.js
};

export const card = () => state.card ?? EMPTY_CARD;
export const preset = () => state.preset ?? DEFAULT_PRESET;

// ───────────────────────────── 持久化 ─────────────────────────────

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** state 现在对应哪张卡、哪个存档，以及这两条记录里不在 state 上的字段 */
export const persist = {
    cardId: null,       // null = 没卡状态（还没有任何卡记录对应当前聊天）
    chatId: null,
    cardMeta: null,     // CardRecord 去掉 card / avatar：{id, createdAt, activeChatId, usedAt}
    chatMeta: null,     // ChatRecord 去掉 messages / variables：{id, cardId, name, createdAt, updatedAt, stHeader?, greeting?, authorNote?, highlights?}
    index: null,        // 当前卡的存档目录 'index:<cardId>'：{cardId, chats: {chatId: {name, count, updatedAt, createdAt}}}
    meta: { version: SCHEMA_VERSION, activeCardId: null },
    epoch: 0,           // 每换一次「state 指向的存档」就 +1。异步回来的操作拿它判断「还是不是当初那个存档」
    readOnly: false,    // 迁移失败 / 另一个标签页在写：只在内存里用，不往存储写任何东西
    stopped: false,     // 「清空所有数据」之后：再也不写
    paused: false,      // 备份导入正在写它的事务（ui/backup.js）：这期间 flushNow 什么都不做，导入完成后它会补一次保存。
                        // 不然这期间排出去的保存可能带着旧的 global / 目录，排在导入的事务后面把刚导入的盖掉
    onFlushed: null,    // 写完一次后的回调（archive.js 用它刷新存档列表）
    onSwap: null,       // state 刚换成另一个存档时【同步】调用（archive.js 在这里拆掉旧存档的 DOM 和 iframe）
    onSave: null,       // 每次 save() 被调用时【同步】调用（script-host.js 在这里排一次「把改动推给脚本沙箱」，见那个文件头）
    // 当前卡的运行时数据 'cardvars:<cardId>'（cardvars.js、types.js CardVars）。不放进 state（state 的形状不变）。
    //   undefined = 还没从存储读回来（换卡后异步读，见 loadCardVars）；null = 读过了，这张卡没有；对象 = 有。
    // cardVarsFor：上面这份属于哪张卡（读回来时核对，免得读的期间换了卡、把 A 卡的数据装到 B 卡上）
    cardVars: undefined,
    cardVarsFor: null,
};

/** epoch → 那时 state 对应的 {cardId, chatId}。没卡状态下第一次保存才分配 id（epoch 不变），所以要随时记 */
const epochIds = new Map();
export const idsOfEpoch = epoch => epochIds.get(epoch) ?? { cardId: null, chatId: null };

/** 要删的键：和下一次保存的其它写入放在同一个事务里（删存档 + 改目录要么都成要么都不成） */
const pendingDeletes = new Set();
export function queueDelete(key) { pendingDeletes.add(key); }

// 各条记录【最近一次排进写入队列】时的 JSON。下次保存时比一比，没变的记录不重写。
// 用「比较序列化结果」而不是「记住谁改过」：别的模块会原地改 state 里的对象
// （比如正则页切开关直接改 state.card.regexScripts[i].disabled），这样也不会漏掉。
// 不能和「最近一次写成功的值」比：A 正在写（还没完成）时值又改回去，就会以为没变而漏写（A→B→A）。
// 写失败时把对应的快照作废（置 null），下次保存一定重写。
const snap = { global: null, meta: null, card: null, avatar: null, cardMeta: null, chatMsgs: null, chatVars: null, chatMeta: null, index: null, preset: null, cardVars: null };

// ───────────────────────────── 当前卡的运行时数据（cardvars:<cardId>） ─────────────────────────────
// 换卡时（applyCardChat）开始异步读，读回来之前 persist.cardVars 是 undefined：这期间 buildWrites 不写它（不会拿「空」盖掉存储里的），
// 要读写它的人先 await cardVarsReady()。读排在已经在路上的写后面（writing），所以不会读到切走之前还没落盘的旧值。
// 快照 snap.cardVars 记的是「存储里现在是什么」的 JSON（'null' = 没有这个键），和别的记录一样：变了才写，空了就删键。

let cardVarsWait = null;   // {cardId, promise}

function loadCardVars(cardId, { fresh = false } = {}) {
    persist.cardVarsFor = cardId;
    if (!cardId || fresh || typeof indexedDB === 'undefined') {
        // 没卡 / 刚建的卡（存储里不可能有）/ Node 里：直接当作「读过了，没有」
        persist.cardVars = null;
        snap.cardVars = 'null';
        cardVarsWait = { cardId, promise: Promise.resolve() };
        return;
    }
    persist.cardVars = undefined;
    snap.cardVars = null;
    const read = () => store.get(cardVarsKey(cardId));
    const promise = writing.then(read, read).then(stored => {
        if (persist.cardVarsFor !== cardId || persist.cardVars !== undefined) return;
        const v = normalizeCardVars(stored);
        persist.cardVars = v;
        snap.cardVars = JSON.stringify(v);   // 按规范化之后的记：只是读一下不会引起重写，存储里的坏值等下次真的改了再换掉
    });
    // 读失败：persist.cardVars 一直是 undefined（不写，免得盖掉存储里读不出来的数据），等它的人收到失败
    promise.catch(e => console.error('读这张卡的脚本变量失败', e?.message ?? e));
    cardVarsWait = { cardId, promise };
}

/** 等当前卡的运行时数据读回来。读失败 / 读的期间换了卡 → reject（调用方放弃这次读写） */
export async function cardVarsReady() {
    const w = cardVarsWait;
    if (!w) throw new Error('当前没有打开角色卡');
    await w.promise;
    if (persist.cardVarsFor !== w.cardId || w.cardId !== persist.cardId) throw new Error('角色卡已经换了');
    if (persist.cardVars === undefined) throw new Error('读不出这张卡的脚本变量（存储出错），这次没有读写');
}

/**
 * 改当前卡的运行时数据：field = 'character' | 'scripts' | 'storage'；value 是那个字段的新值（undefined = 去掉这个字段）。
 * 调用前必须已经 cardVarsReady。调用方自己 save()。
 */
export function setCardVarsField(field, value) {
    if (persist.cardVars === undefined) throw new Error('这张卡的脚本变量还没读回来');
    const next = { ...(persist.cardVars ?? {}) };
    if (value === undefined) delete next[field]; else next[field] = value;
    persist.cardVars = Object.keys(next).length ? next : null;
}

/** 备份恢复把当前卡的 cardvars 合并进了存储：重读一次（恢复期间保存是暂停的，内存里的就是恢复前的那份） */
export async function reloadCardVars() {
    if (!persist.cardId) return;
    loadCardVars(persist.cardId);
    try { await cardVarsReady(); } catch { /* 已经记过控制台 */ }
}

/** 新存档记录（还没写入） */
export function newChatRecord(cardId, cardName, now = new Date(), skipChatId = null) {
    const iso = now.toISOString();
    // 默认名 = 卡名 + 创建时的人设名 + 年月日（migrate.js newChatName；人设名还是默认的 User 时省掉）。
    // 同一天给同一张卡建第二个存档会重名，列表里分不清：和这张卡已有的存档重名就加「 (2)」。
    // 只在给【当前卡】建存档时查得到已有的名字（persist.index）；skipChatId = 正要被删掉的那个存档，不算已用。
    const taken = cardId && cardId === persist.cardId && persist.index?.chats
        ? Object.entries(persist.index.chats).filter(([id]) => id !== skipChatId).map(([, c]) => c?.name).filter(n => typeof n === 'string')
        : [];
    const name = uniquePresetName(newChatName(cardName, state.persona?.name, now), taken);
    return { id: uid(), cardId, name, createdAt: iso, updatedAt: iso, messages: [], variables: {} };
}

/**
 * 旧存档的模型设置一次性转换成新的引用（原地改 rec）：没有 chatModel / memory.modelRef 就由旧字段换算，
 * 之后旧字段（model、memory.model、memory.openaiModel）一律丢掉不再用。
 */
export function migrateModelRefs(rec) {
    const isRef = r => r && typeof r.endpoint === 'string' && typeof r.model === 'string';
    if (!isRef(rec.chatModel)) rec.chatModel = { endpoint: 'claude-code', model: typeof rec.model === 'string' ? rec.model : '' };
    if (!isRef(rec.memory.modelRef)) rec.memory.modelRef = { endpoint: 'claude-code', model: typeof rec.memory.model === 'string' ? rec.memory.model : 'haiku' };
    delete rec.model; delete rec.memory.model; delete rec.memory.openaiModel;
    return rec;
}

/**
 * 把人设三个字段（persona / personas / activePersonaId，规则见 personas.js 和 types.js GlobalRecord）写进 state。
 * 没有 personas 时把 state 上的这两个键【删掉】（不是置成 undefined）：存储里只有一个人设时不该出现它们，
 * 否则 migrate.js 的 isPristineGlobal 会误以为用户改过设置。r 是 alignPersonas / switchPersona 等的返回值。
 */
export function setPersonaFields(r) {
    state.persona = r.persona;
    if (r.personas) { state.personas = r.personas; state.activePersonaId = r.activePersonaId; }
    else { delete state.personas; delete state.activePersonaId; }
}

/**
 * 便签（state.notes）写进 state：一条都没有时把键【删掉】（和 setPersonaFields 同理：存储里不该出现空的 notes，
 * 否则不用便签的人的 global 也多了一个字段）。list 应该已经是规范化过的（normalizeNotes 的结果）。
 */
export function setNotesField(list) {
    if (Array.isArray(list) && list.length) state.notes = list;
    else delete state.notes;
}

/**
 * 「便签」页的「隐藏已完成」（界面偏好，跟着全局记录存，types.js GlobalRecord.notesHideDone）。
 * 默认值（不隐藏）时把键【删掉】：和 setNotesField 同理，没动过这个开关的人存储里看不出区别。调用方自己 save()。
 */
export function setNotesHideDone(on) {
    if (on) state.notesHideDone = true;
    else delete state.notesHideDone;
}

/**
 * 读档时（assignGlobalFields 之后）：读到的 global 里没有 notes → state 上也不能有（运行中「替换全局设置」时，
 * assignGlobalFields 只赋存储里有的键，不删 state 上多出来的，不删的话就留着替换前的便签）；
 * 有 → 那是存储里的原样（可能被手改坏了），过一遍容错再放回去。
 */
function applyNotesFrom(rec) {
    if (!Object.hasOwn(rec, 'notes')) { delete state.notes; return; }
    setNotesField(normalizeNotes(state.notes, { newId: uid, now: Date.now() }));
}

/**
 * 读到的全局记录的字段赋给 state。不认识的字段照旧原样带上（向前兼容：以后新加的设置不会在读写一圈后丢掉），
 * 只挡住一小撮危险的键：
 *   - NON_GLOBAL_KEYS（card / avatar / chat / variables）：属于当前卡 / 当前存档。要是存储里的 global 被写进了这些键
 *     （比如手改的备份经「替换全局设置」写进来），赋进 state 之后下一次保存就会把当前卡写成别的、把当前存档的聊天换掉。
 *   - UNSAFE_KEYS（__proto__ 等）：赋值会换掉 state 的原型，而不是加一个字段。
 * 被挡住的键不进 state；下一次保存按 state 重写 global 时它们自然就没了。
 */
function assignGlobalFields(rest) {
    for (const [k, v] of Object.entries(rest)) {
        if (NON_GLOBAL_KEYS.includes(k) || UNSAFE_KEYS.includes(k)) continue;
        state[k] = v;
    }
    // 「默认不写」的字段（migrate.js OPTIONAL_GLOBAL_KEYS）：存储里没有 → state 上也不能有。
    // 上面只赋存储里有的键，不删 state 上多出来的；运行中重读（备份恢复后的 reloadGlobalFromStore）时，
    // 不删就会留着重读前的值——以前「用只有单个人设的备份替换全局设置」时，本机的 personas 列表就是这样残留下来、
    // 再被 alignPersonas 拿备份的 persona 改写了本机当前那一项。便签另有 applyNotesFrom 处理（还要过一遍容错）。
    for (const k of OPTIONAL_GLOBAL_KEYS) if (!Object.hasOwn(rest, k)) delete state[k];
    // 「隐藏已完成」只认 true（别的值当作没有，下一次保存时就不写了）
    if (state.notesHideDone !== true) delete state.notesHideDone;
    // 「拼装」页的两个缓存开关同理：stableRandom 只认 true，promptCache 只认 false（没有 = 开），别的值当作默认、下次保存不写
    if (state.stableRandom !== true) delete state.stableRandom;
    if (state.promptCache !== false) delete state.promptCache;
}

/** 「随机宏按存档固定」开关（GlobalRecord.stableRandom）。默认（关）时把键删掉。调用方自己 save()。 */
export function setStableRandom(on) {
    if (on) state.stableRandom = true;
    else delete state.stableRandom;
}

/** 「OpenRouter + Claude 自动加缓存标记」开关（GlobalRecord.promptCache）。默认（开）时把键删掉，关掉才写 false。调用方自己 save()。 */
export function setPromptCache(on) {
    if (on) delete state.promptCache;
    else state.promptCache = false;
}

/** 全局记录装进 state；stored = 存储里的原样（用来判断补了默认值之后要不要重写） */
export function applyGlobal(stored) {
    // normalizeGlobal 顺带清掉额外世界书 / 全局正则里的坏条目（null、数字……，见 migrate.js cleanBooks）：
    // 存储里已经被写坏的数据读进来就是干净的，snap.global 记的是存储原样，所以下一次保存会把干净的写回去
    const rec = migrateModelRefs(normalizeGlobal(stored));
    // activePresetId 不进 state（state 的形状不变）：它由下面的预设层记在 presets.activeId 上
    const { globalVariables, activePresetId, ...rest } = rec;
    assignGlobalFields(rest);
    setPersonaFields(alignPersonas(state));   // 多人设：和 persona 对齐；没有多人设时什么字段都不加
    applyNotesFrom(rest);                     // 便签：存储里没有就不要有；有就过一遍容错
    state.variables = { local: state.variables.local, global: globalVariables };
    snap.global = stored ? JSON.stringify(stored) : null;
    applyPresetLayer(stored, activePresetId);
}

/**
 * 运行中把全局层换成存储里现在的 'global'（备份导入「替换全局设置」用；调用前它和它指向的预设都已经写进存储）。
 * 为什么不直接调 applyGlobal：applyGlobal 是给启动用的，它从启动时读好的预设列表（bootPresets）里同步装当前预设；
 * 页面开了一阵之后那份列表可能已经过时（预设改过），装进来的会是旧内容，之后一保存就把新的盖掉。所以这里从存储里现读。
 * 只接受新形状的 global（导入写的一定是新形状）。
 * @returns {Promise<boolean>} 指向的预设找到了没有（没找到就用内置默认预设）
 */
export async function reloadGlobalFromStore() {
    const stored = await store.get('global');
    const rec = migrateModelRefs(normalizeGlobal(stored));   // 坏条目的容错同 applyGlobal
    const { globalVariables, activePresetId, ...rest } = rec;
    const id = typeof activePresetId === 'string' && activePresetId ? activePresetId : null;
    const p = id ? await store.get(presetKey(id)) : null;
    // 以下同步完成：不会有保存插在「state 换了一半」的时候
    assignGlobalFields(rest);
    setPersonaFields(alignPersonas(state));
    applyNotesFrom(rest);
    state.variables = { local: state.variables.local, global: globalVariables };
    snap.global = stored ? JSON.stringify(stored) : null;
    presets.mode = 'v2';
    if (isPresetRecord(p) && p.id === id) { applyPresetRecord(p); return true; }
    applyDefaultPreset();
    return !id;
}

/**
 * 让 state 指向这张卡、这个存档。fresh = 这条记录还没写进存储（下次保存时会写）。
 * 传 null 表示「没卡」/「没存档」。换了存档时（聊天数组换了）epoch +1 并同步调用 onSwap。
 */
export function applyCardChat(cardRec, chatRec, { freshCard = false, freshChat = false } = {}) {
    const swapped = !chatRec || chatRec.messages !== state.chat;
    if (cardRec && cardRec.id === persist.cardId && cardRec.card === state.card && !freshCard) {
        // 同一张卡只换存档：卡的快照不动（要是刚才有还没落盘的卡改动，下次保存照样会写）
        const { card: _c, avatar: _a, ...meta } = cardRec;
        persist.cardMeta = meta;
    } else if (cardRec) {
        const { card: c, avatar, ...meta } = cardRec;
        state.card = c ?? emptyCard();
        state.avatar = avatar ?? '';
        if (persist.cardId !== cardRec.id) { persist.index = null; snap.index = null; }
        // 换了卡（或者这是刚建的卡）：这张卡的运行时数据重新读。同一张卡换了卡定义（「更新」同名卡）时 id 不变，不重读——cardvars 跟着卡 id 走
        if (persist.cardId !== cardRec.id || freshCard || persist.cardVarsFor !== cardRec.id) loadCardVars(cardRec.id, { fresh: freshCard });
        persist.cardId = cardRec.id;
        persist.cardMeta = meta;
        snap.card = freshCard ? null : JSON.stringify(state.card);
        snap.avatar = freshCard ? null : state.avatar;
        snap.cardMeta = freshCard ? null : JSON.stringify(meta);
        if (freshCard) applyIndex({ cardId: cardRec.id, chats: {} }, { fresh: true });
    } else {
        state.card = null; state.avatar = '';
        persist.cardId = null; persist.cardMeta = null; persist.index = null;
        snap.card = snap.avatar = snap.cardMeta = snap.index = null;
        loadCardVars(null);
    }
    if (chatRec) {
        const { messages, variables, ...meta } = chatRec;
        // 作者注释（types.js ChatRecord.authorNote）：读入容错。坏的字段回默认值，全是默认就去掉这个键。
        // 快照按规范化之后的记（下面 snap.chatMeta），所以只是读一下不会引起一次重写；存储里的坏值等这条记录下次因别的改动被写时换掉
        if ('authorNote' in meta) {
            const n = storedAuthorNote(meta.authorNote);
            if (n) meta.authorNote = n; else delete meta.authorNote;
        }
        state.chat = Array.isArray(messages) ? messages : [];
        // 外置记忆的合并段（memory-fold.js 文件头「合并段」）：读入容错。坏的段、孤儿标记去掉（被去掉标记的轮回到待压缩）。
        // 和作者注释一样，快照按规范化之后的记，只是读一下不会引起一次重写
        normalizeMerged(state.chat);
        // 划线（types.js ChatRecord.highlights）：读入容错，按这个存档的消息核对（楼号越界、候选不存在、超出原文长度的丢掉）。
        // 一条都不剩就去掉这个键。同作者注释：快照按清洗之后的记，只是读一下不会引起一次重写
        if ('highlights' in meta) {
            const hl = storedHighlights(meta.highlights, chatDoc(state.chat));
            if (hl) meta.highlights = hl; else delete meta.highlights;
        }
        state.variables = { local: isObj(variables) ? variables : {}, global: state.variables.global };
        persist.chatId = chatRec.id;
        persist.chatMeta = meta;
        snap.chatMsgs = freshChat ? null : JSON.stringify(state.chat);
        snap.chatVars = freshChat ? null : JSON.stringify(state.variables.local);
        snap.chatMeta = freshChat ? null : JSON.stringify(meta);
    } else {
        state.chat = [];
        state.variables = { local: {}, global: state.variables.global };
        persist.chatId = null; persist.chatMeta = null;
        snap.chatMsgs = snap.chatVars = snap.chatMeta = null;
    }
    persist.meta = { ...persist.meta, activeCardId: persist.cardId };
    if (swapped) persist.epoch++;
    epochIds.set(persist.epoch, { cardId: persist.cardId, chatId: persist.chatId });
    if (swapped) {
        // 和换 state 在同一个同步块里拆掉旧存档的界面：之后旧楼层上的按钮、旧 iframe 的调用都碰不到新存档
        persist.onSwap?.();
    }
}

/**
 * 改当前存档的作者注释（types.js ChatRecord.authorNote；界面 ui/author-note.js）。note 是要的五个字段（可以只给一部分，和现有的合并），
 * 规范化后全是默认值就把键删掉（不用这个功能的人存储形状不变）。只改 persist.chatMeta，然后走普通的防抖保存：
 * buildWrites 发现 chatMeta 变了就重写这一条存档记录（不更新 updatedAt——改设置不算「用过这个存档」，和改名一样）。
 * 拦截（只读、生成中、恢复中、停止保存、正在切换）由调用方先判断（chat.js chatWriteBlocked）。没有当前存档时返回 false。
 * @returns {boolean} 有没有改
 */
export function setAuthorNote(patch) {
    if (!persist.chatMeta) return false;
    const next = storedAuthorNote({ ...(persist.chatMeta.authorNote ?? {}), ...patch });
    const before = JSON.stringify(persist.chatMeta.authorNote ?? null);
    if (next) persist.chatMeta.authorNote = next; else delete persist.chatMeta.authorNote;
    if (JSON.stringify(persist.chatMeta.authorNote ?? null) === before) return false;
    save();
    return true;
}

// ───────────────────────────── 划线（types.js ChatRecord.highlights，纯逻辑 src/highlight.js） ─────────────────────────────
// 运行时挂在 persist.chatMeta.highlights（state 的形状不变；和作者注释同一条路：chatMeta 变了 buildWrites 就重写这条存档记录，不更新 updatedAt）。
// 读入时（applyCardChat）已按消息清洗过，所以这里拿到的都是合法的。
// 两类入口：
//   - 用户操作（第二段的界面调）：addChatHighlight / removeChatHighlight / setChatHighlightNote —— 自己 save()。
//     拦截（只读、生成中、恢复中、停止保存、正在切换）由调用方先判断（chat.js chatWriteBlocked），同 setAuthorNote。
//   - 原文变了 / 删了楼的钩子：highlightsAfterEdit / highlightsAfterDelete / highlightsAfterTruncate / clearChatHighlights ——
//     【不】save()，调用方改完聊天自己会存（它们和 invalidateTurnAt 挂在同一批入口上：chat.js、frame-host.js）。

/** 当前存档的划线（没有 = []）。不要原地改返回的数组 */
export const currentHighlights = () => persist.chatMeta?.highlights ?? [];

/** 换成新列表（空 = 删掉这个键）。返回有没有变 */
function putHighlights(list) {
    if (!persist.chatMeta) return false;
    const before = persist.chatMeta.highlights;
    if (Array.isArray(list) && list.length) persist.chatMeta.highlights = list;
    else delete persist.chatMeta.highlights;
    return before !== persist.chatMeta.highlights;
}

/**
 * 给当前存档加一条划线。spec = {from, to, whole?, note?}（端点见 types.js HighlightPoint；一般来自 highlight.js rangeFromSelection）。
 * 不合法（越界、长度为 0、同一楼两端候选不同……）或和已有的一条位置完全相同 → 不加，返回 null；加了返回新的那条。
 */
export function addChatHighlight(spec) {
    if (!persist.chatMeta) return null;
    const h = newHighlight(spec, chatDoc(state.chat), { newId: uid });
    if (!h) return null;
    const cur = currentHighlights();
    const next = addHighlight(cur, h);
    if (next === cur) return null;
    putHighlights(next);
    save();
    return h;
}

/** 删一条。返回有没有删 */
export function removeChatHighlight(id) {
    if (!putHighlights(removeHighlight(currentHighlights(), id))) return false;
    save();
    return true;
}

/** 改备注（空 = 去掉备注）。返回有没有改 */
export function setChatHighlightNote(id, note) {
    const cur = currentHighlights();
    const next = setHighlightNote(cur, id, note);
    if (JSON.stringify(next) === JSON.stringify(cur)) return false;
    putHighlights(next);
    save();
    return true;
}

/**
 * 钩子：第 i 楼（当前显示的候选）的原文从 before 改成了 after（编辑、拼装页就地改、前端卡 / 脚本 setChatMessages、换开场白）。
 * 改动段之前的划线不动、之后的平移、交叠的删掉（highlight.js shiftAfterEdit）。不 save()。返回删掉的 id
 */
export function highlightsAfterEdit(i, before, after) {
    const cur = currentHighlights();
    if (!cur.length || before === after) return [];
    const r = shiftAfterEdit(cur, { floor: i, swipe: chatDoc(state.chat).current(i), before, after });
    if (r.changed) putHighlights(r.list);
    return r.removed;
}

/** 钩子：删掉了这些楼（删之前的楼号；前端卡的 deleteChatMessages 是任意单删）。要在 state.chat 真的删之前或之后调都行。不 save() */
export function highlightsAfterDelete(floors) {
    const r = afterDeleteFloors(currentHighlights(), floors);
    if (r.changed) putHighlights(r.list);
    return r.removed;
}

/** 钩子：「删这一楼及之后」，截到 n 楼。不 save() */
export function highlightsAfterTruncate(n) {
    const r = afterTruncate(currentHighlights(), n);
    if (r.changed) putHighlights(r.list);
    return r.removed;
}

/** 钩子：当前存档的聊天整个重来了（startChat 原地换开场白）。不 save() */
export function clearChatHighlights() {
    putHighlights([]);
}

/**
 * 恢复整体备份把备份里的划线并进了存储里的【当前存档】（ui/backup.js doImport：写入事务和读回校验都成功之后调）：内存跟上存储。
 * stored = 写进存储的那条记录的 highlights。按消息清洗后装进 persist.chatMeta（和读档 applyCardChat 同一个规矩）。
 * 快照原来和内存一致（doImport 进来前落过盘、之后暂停保存）就跟着换成新的，于是不会多一次重写；
 * 不更新内存的话，下一次保存会拿内存里的旧列表把并进来的划线盖掉。不是当前存档 → 什么都不做，返回 false
 */
export function adoptRestoredHighlights(cardId, chatId, stored) {
    if (!persist.chatMeta || persist.cardId !== cardId || persist.chatId !== chatId) return false;
    const synced = snap.chatMeta === JSON.stringify(persist.chatMeta);
    const hl = storedHighlights(stored, chatDoc(state.chat));
    if (hl) persist.chatMeta.highlights = hl; else delete persist.chatMeta.highlights;
    if (synced) snap.chatMeta = JSON.stringify(persist.chatMeta);
    return true;
}

/** 当前卡的存档目录装进来（fresh = 还没写进存储） */
export function applyIndex(index, { fresh = false } = {}) {
    persist.index = index;
    snap.index = fresh ? null : JSON.stringify(index);
}

/** 迁移 / 读取成功后，meta 已经在存储里了 */
export function markMetaSaved(meta) {
    persist.meta = { ...meta };
    snap.meta = JSON.stringify(persist.meta);
}

/**
 * 没卡状态下聊天有了内容：建一张名为 Assistant 的空卡（「占位卡」）和一个存档挂着它，
 * 这样之后导入真正的角色卡时这段聊天不会丢，在角色卡列表里还能切回来。
 * 聊天数组本身不换（正在流式输出的那条消息对象还在里面），所以 epoch 不变。
 */
export function ensureCardRecord() {
    if (persist.cardId) return;
    const now = new Date(), iso = now.toISOString();
    const c = state.card ?? emptyCard();
    const chat = { ...newChatRecord(null, c.name, now), messages: state.chat, variables: state.variables.local };
    if (persist.chatMeta?.greeting) chat.greeting = persist.chatMeta.greeting;
    const cardRec = { id: uid(), card: c, avatar: state.avatar, createdAt: iso, usedAt: iso, activeChatId: chat.id };
    chat.cardId = cardRec.id;
    applyCardChat(cardRec, chat, { freshCard: true, freshChat: true });
}

/** 同步地把 state 拆成要写的记录（结构化拷贝在这里做，之后 state 再怎么变都不影响这次写入） */
function buildWrites() {
    const ops = [], next = {};
    for (const k of pendingDeletes) ops.push({ del: k });
    next.deletes = [...pendingDeletes];
    if (!persist.cardId && (state.chat.length || Object.keys(state.variables.local ?? {}).length)) ensureCardRecord();
    if (persist.cardId && !persist.chatId) {
        // 防御：有卡没存档（正常流程不会出现），给它一个新存档，别把聊天写丢
        const rec = { ...newChatRecord(persist.cardId, state.card?.name), messages: state.chat, variables: state.variables.local };
        const { messages, variables, ...meta } = rec;
        persist.chatId = rec.id; persist.chatMeta = meta; persist.cardMeta.activeChatId = rec.id;
    }

    // 预设记录排在 global 前面：在内置默认预设上第一次改动时，这里才给它分配 id，global 要记下这个 id
    presetWrites(ops, next);
    // 旧形状升级进行中（见 migrateLegacyPreset）：global 先不写——升级完成后紧跟着的那次保存会按新形状写，
    // 这期间的改动也都在 state 里，会一起写进去
    if (!presets.migrating) {
        if (state.personas) setPersonaFields(alignPersonas(state));   // 有多人设时，别的模块直接改了 state.persona：写之前把列表里当前那一项对上
        const g = globalRecord();
        const gJson = JSON.stringify(g);
        if (gJson !== snap.global) { ops.push({ set: 'global', value: structuredClone(g) }); next.global = gJson; }
    }

    if (persist.cardId) {
        const msgs = JSON.stringify(state.chat);
        // updatedAt 只在消息变了的时候更新（改设置引起的保存不算「用过这个存档」）
        if (snap.chatMsgs !== null && msgs !== snap.chatMsgs) persist.chatMeta.updatedAt = new Date().toISOString();
        const vars = JSON.stringify(state.variables.local ?? {});
        const chatMeta = JSON.stringify(persist.chatMeta);
        if (msgs !== snap.chatMsgs || vars !== snap.chatVars || chatMeta !== snap.chatMeta) {
            ops.push({ set: chatKey(persist.cardId, persist.chatId), value: { ...structuredClone(persist.chatMeta), messages: structuredClone(state.chat), variables: structuredClone(state.variables.local ?? {}) } });
            Object.assign(next, { chatMsgs: msgs, chatVars: vars, chatMeta });
        }
        // 存档目录：和存档写在同一个事务里，切换时只读它就能列出存档，不用把每个存档整条读出来。
        // 只有目录确实是这张卡的（已经读进来或刚新建）才写，绝不拿半份目录覆盖存储里的整份
        if (persist.index?.cardId === persist.cardId) {
            persist.index.chats[persist.chatId] = indexEntry({ ...persist.chatMeta, messages: state.chat });
            const idx = JSON.stringify(persist.index);
            if (idx !== snap.index) { ops.push({ set: indexKey(persist.cardId), value: structuredClone(persist.index) }); next.index = idx; }
        }
        // 卡记录里有头像（可能 1 MB）：卡定义和头像都没变就不重写
        const cardJson = JSON.stringify(state.card);
        const cardMeta = JSON.stringify(persist.cardMeta);
        if (cardJson !== snap.card || state.avatar !== snap.avatar || cardMeta !== snap.cardMeta) {
            // 键的顺序和 CardRecord 定义一致（id, card, avatar, …），读回来对照时好看
            ops.push({ set: cardKey(persist.cardId), value: { id: persist.cardId, card: structuredClone(state.card ?? emptyCard()), avatar: state.avatar ?? '', ...structuredClone(persist.cardMeta) } });
            Object.assign(next, { card: cardJson, avatar: state.avatar, cardMeta });
        }
        // 这张卡的运行时数据（脚本变量、角色卡变量）：读回来了、确实是这张卡的才写；空了就删键（默认不写）
        if (persist.cardVars !== undefined && persist.cardVarsFor === persist.cardId) {
            const cvJson = JSON.stringify(persist.cardVars);
            if (cvJson !== snap.cardVars) {
                ops.push(persist.cardVars === null ? { del: cardVarsKey(persist.cardId) } : { set: cardVarsKey(persist.cardId), value: structuredClone(persist.cardVars) });
                next.cardVars = cvJson;
            }
        }
    }

    persist.meta = { ...persist.meta, version: SCHEMA_VERSION, activeCardId: persist.cardId };
    const metaJson = JSON.stringify(persist.meta);
    if (metaJson !== snap.meta) { ops.push({ set: 'meta', value: structuredClone(persist.meta) }); next.meta = metaJson; }
    return { ops, next, cardId: persist.cardId, chatId: persist.chatId, presetId: presets.activeId };
}

const CARD_SNAP = ['card', 'avatar', 'cardMeta', 'index', 'cardVars'];
const CHAT_SNAP = ['chatMsgs', 'chatVars', 'chatMeta'];

// 所有写入排成一条链，保证先后顺序；flushNow 返回的 Promise 在「到目前为止的改动都落盘」后才 resolve
let writing = Promise.resolve(true);
let timer = null;

/**
 * 立刻把 state 写回存储（取消还没到点的防抖保存）。切换卡 / 存档、导入、关页面之前都要先调它。
 * @returns {Promise<boolean>} false = 写入失败（已经弹了提示；调用方应放弃切换，免得丢数据）
 */
export function flushNow() {
    clearTimeout(timer); timer = null;
    if (persist.readOnly || persist.stopped || persist.paused) return writing;
    let built;
    try { built = buildWrites(); } catch (e) {
        console.error(e);
        toast(`保存失败：${e.message}`, 'error');
        return Promise.resolve(false);
    }
    if (!built.ops.length) return writing;
    const { deletes, ...snaps } = built.next;
    Object.assign(snap, snaps);   // 排进队列就记快照（见 snap 的注释）
    writing = writing.then(() => store.batch(built.ops)).then(() => {
        for (const k of deletes) pendingDeletes.delete(k);   // 删成功了才划掉；失败的下次保存再删
        persist.onFlushed?.();
        return true;
    }, e => {
        console.error('保存失败', e);
        // 作废这次写的那些快照——只在快照还是这次的值、而且还是同一条记录时（之后排队的写入已经覆盖的不动）
        for (const [k, v] of Object.entries(snaps)) {
            const sameRecord = CHAT_SNAP.includes(k) ? built.cardId === persist.cardId && built.chatId === persist.chatId
                : CARD_SNAP.includes(k) ? built.cardId === persist.cardId
                : k === 'preset' ? built.presetId === presets.activeId : true;
            if (sameRecord && snap[k] === v) snap[k] = null;
        }
        toast(`保存失败：${e?.message ?? e}（改动还在页面里，下次保存会重写）`, 'error');
        return false;
    });
    return writing;
}

/** 防抖保存：其它模块改完 state 就调它，和以前一样 */
export function save() {
    // 脚本沙箱的同步副本（script-host.js）：有改动就排一次推送（它自己合并成一次、做首尾比对）。
    // 放在 stopped 判断之前：停止保存之后页面上的改动不再落盘，但脚本照样该看到页面上的样子（实际上停止保存时沙箱已经拆了）
    try { persist.onSave?.(); } catch (e) { console.error(e); }
    if (persist.stopped) return;
    // 防抖，但最多推迟 2 秒：脚本 / 前端卡用定时器每几百毫秒写一次变量时，纯防抖会被一直往后推、永远不落盘（第 2 期实测撞上过）
    const now = Date.now();
    if (timer === null) firstPending = now;
    clearTimeout(timer);
    timer = setTimeout(flushNow, Math.max(0, Math.min(400, firstPending + 2000 - now)));
}
let firstPending = 0;

/**
 * 停止保存之后（persist.stopped：「清空所有数据」之后，或者备份恢复撤销失败时），所有会改数据的操作统一用这句拒绝。
 * 停止保存后 flushNow 什么都不写，只走 flushNow 的操作（新建存档、导入 .jsonl、新卡……）会「什么都没写却提示成功」，
 * 直接写存储的操作（删卡、删 / 改名存档）又会绕过停止——两种都不对，所以在各自的统一拦截点先挡掉（archive.js canSwitch、importer.js 等）。
 */
export const STOPPED_TEXT = '已停止保存，请刷新页面';

/** 「清空所有数据」用：之后不再写任何东西（包括关页面时的那次保存） */
export function stopSaving() {
    clearTimeout(timer); timer = null;
    persist.stopped = true;
    return writing;
}

/**
 * 改一个【不在 state 里】的存档（比如切走之后才回来的记忆摘要）：读-改-写在同一个事务里，
 * 存档已经被删掉就什么都不写（不会把它「复活」）。排在写入链后面，不会和正在写的同一条记录打架。
 * mutate(rec) 原地改记录，返回 false 表示不用写。
 * @returns {Promise<boolean>} 是否写了
 */
export function patchStoredChat(cardId, chatId, mutate) {
    if (persist.readOnly || persist.stopped || !cardId || !chatId) return Promise.resolve(false);
    if (cardId === persist.cardId && chatId === persist.chatId) return Promise.reject(new Error('当前存档请直接改 state'));
    const key = chatKey(cardId, chatId), ikey = indexKey(cardId);
    let entry = null;
    const prev = writing;
    const p = prev.then(() => store.transact([key, ikey], ([rec, idx]) => {
        if (!rec || mutate(rec) === false) return [];
        rec.updatedAt = new Date().toISOString();
        entry = indexEntry(rec);
        const ops = [{ set: key, value: rec }];
        if (idx?.chats?.[chatId]) { idx.chats[chatId] = entry; ops.push({ set: ikey, value: idx }); }
        return ops;
    })).then(wrote => {
        // 同一张卡的目录在内存里也有一份：跟着改，免得下次保存用旧的覆盖回去
        if (wrote && persist.index?.cardId === cardId && persist.index.chats[chatId]) persist.index.chats[chatId] = entry;
        return wrote;
    });
    // 链上保留之前那次写入的成败（这次补丁失败不算「保存失败」，调用方自己看返回值）
    writing = p.then(() => prev, () => prev);
    return p;
}

// ───────────────────────────── 多预设 ─────────────────────────────
// 存储：每个预设一个键 'preset:<id>' → PresetRecord；'global' 里只有 activePresetId（规则见 types.js GlobalRecord）。
// 运行时：state.preset / state.presetName 永远是「当前预设」，别的模块照旧原地改它、调 save()；
// buildWrites 发现它变了，就只重写 'preset:<当前 id>'（不动别的预设）；换了预设才会重写 global。
//
// 为什么启动时要在模块顶层先把预设读出来（文件最后的 top-level await）：
// archive.js 的 initArchive 是「applyGlobal(读到的 global) → 马上装卡、渲染」，applyGlobal 是同步的；
// 而当前预设在另一个键里，要异步读。先读好放着，applyGlobal 就能同步装进 state，
// 不会出现「先用默认预设画一遍 / 甚至发出一条，过一会儿才换成真正的预设」。
// 这次读发生在拿写入锁之前，只读不写，所以没关系；万一读到的和 global 对不上（极少见），走 loadMissingPreset 补读。

export const presets = {
    mode: 'v2',          // 'v2' | 'legacy'：存储里的 global 还是旧形状（预设本体在 global 里）——升级前 / 升级失败时
    activeId: null,      // 当前预设的 id；null = 内置默认预设（state.preset 也是 null）
    meta: null,          // 当前预设记录去掉 preset 本体：{id, name, createdAt, updatedAt}
    catalog: new Map(),  // id → {id, name, createdAt, updatedAt}：所有存下来的预设（选择器用，不含本体）
    migrating: false,    // 旧形状正在升级：这期间不写 global、不写预设记录
    pending: false,      // global 指向的预设启动时没读到，正在补读
    onChange: null,      // 当前预设换了之后的回调（tab-preset.js 设置：整页重画）
};

const metaOf = r => ({ id: r.id, name: typeof r.name === 'string' && r.name ? r.name : '未命名预设', createdAt: r.createdAt ?? '', updatedAt: r.updatedAt ?? '' });

/** 预设记录的快照：名字和内容任一变了就要重写这条记录 */
const presetSnap = () => JSON.stringify([state.presetName, state.preset]);

/** 当前预设有没落盘的改动（新形状下才有意义；旧形状的改动跟着 global 一起写） */
function presetDirty() {
    return presets.mode === 'v2' && !presets.pending && state.preset !== null && presetSnap() !== snap.preset;
}

async function readPresetRecords() {
    const keys = await store.keys(PRESET_PREFIX);
    const recs = await Promise.all(keys.map(k => store.get(k)));
    // 键和记录里的 id 对不上的也不要：之后按 id 写回时会写到另一个键上
    return recs.filter((r, i) => isPresetRecord(r) && presetKey(r.id) === keys[i]);
}

/**
 * 让 state 指向这条预设记录。fresh = 还没写进存储（下次保存时会写）。
 * 装进 state 的是清洗过的本体（migrate.js cleanPresetBody：去掉酒馆的连接信息、校正正则字段类型），不改 rec 本身。
 * 为什么在这里洗：以前导入的预设可能还带着反代密码等（那时入口还没清洗），读档、切换、删除后切到下一个、恢复后重读都经过这里。
 * 存储里的那份由 scrubStoredPresets 去掉敏感字段；快照按清洗后的记，所以这里的清洗本身不会引起一次重写。
 */
function applyPresetRecord(rec, { fresh = false } = {}) {
    state.preset = cleanPresetBody(rec.preset).preset;
    state.presetName = metaOf(rec).name;
    presets.activeId = rec.id;
    presets.meta = metaOf(rec);
    presets.catalog.set(rec.id, { ...presets.meta });
    snap.preset = fresh ? null : presetSnap();
    ui.openPrompts.clear();   // 展开状态按条目 identifier 记，换了预设就不对了
}

function applyDefaultPreset() {
    state.preset = null;
    state.presetName = '';
    presets.activeId = null;
    presets.meta = null;
    snap.preset = null;
    ui.openPrompts.clear();
}

/** 要写进 'global' 的内容：新形状去掉预设本体，只留 id；旧形状（升级失败）照旧整个写 */
function globalRecord() {
    const g = globalFromState(state);
    return presets.mode === 'legacy' ? g : toGlobalV2(g, presets.activeId);
}

/**
 * 「把现在的 global 写进去」这一条写操作，交给调用方和别的写 / 删放进【同一个事务】（archive.js deleteCard：删卡 + 清掉世界书里的绑定）。
 * 返回 {op, done}：调用方的事务成功后调 done()，记下快照（之后的保存发现没变就不重写）；失败就不调，下次保存照常重写。
 * 旧形状升级进行中（presets.migrating）返回 null：这时不能写 global（见 buildWrites），改动留在 state 里，升级完成后那次保存会带上。
 */
export function globalWriteOp() {
    if (presets.migrating) return null;
    if (state.personas) setPersonaFields(alignPersonas(state));   // 和 buildWrites 一样：写之前把多人设对齐
    const g = globalRecord();
    const json = JSON.stringify(g);
    return { op: { set: 'global', value: structuredClone(g) }, done: () => { snap.global = json; } };
}

/** buildWrites 的一部分：当前预设变了就重写它那一条（同一个事务里） */
function presetWrites(ops, next) {
    if (presets.mode !== 'v2' || presets.migrating || presets.pending || !state.preset) return;
    if (presets.activeId && presetSnap() === snap.preset) return;
    const iso = new Date().toISOString();
    if (!presets.activeId) {
        // 在内置默认预设上改了东西（tab-preset.js 的 ownPreset 复制了一份）：存成一条新记录，从此就是用户自己的预设
        const id = uid();
        const name = uniquePresetName(state.presetName || '默认预设（已修改）', [...presets.catalog.values()].map(m => m.name));
        presets.activeId = id;
        presets.meta = { id, name, createdAt: iso, updatedAt: iso };
    }
    const m = presets.meta;
    if (!state.presetName) state.presetName = m.name;   // 名字清空了：沿用原来的，别让界面显示成「内置默认预设」
    m.name = state.presetName;
    m.updatedAt = iso;
    presets.catalog.set(m.id, { ...m });
    // 键的顺序和 PresetRecord 定义一致
    ops.push({ set: presetKey(m.id), value: { id: m.id, name: m.name, preset: structuredClone(state.preset), createdAt: m.createdAt, updatedAt: m.updatedAt } });
    next.preset = presetSnap();
}

/**
 * applyGlobal 的一部分：按 global 的形状决定当前预设。
 *   新形状：按 activePresetId 装预设记录（启动时已经读好了，同步装进来）
 *   旧形状、preset 为 null：不用建记录，直接当新形状（下次保存时 global 自然写成新形状）
 *   旧形状、preset 有内容：先照旧用 global 里的本体，同时（有写权限时）在后台升级
 */
/**
 * 读档时把存储里每条预设记录的敏感字段去掉（酒馆的反代地址 / 密码、附加请求头……，清单见 preset-sanitize.js），写回去。
 * 只做这一件事：sanitizePreset 只删清单里的顶层字段，别的（名字、时间、条目、正则……）一个字节都不动；没有敏感字段的记录不写。
 * 为什么在读档时做、而不是只在导出时去掉：以前导入的预设会一直把密码留在 IndexedDB 里；导出侧另有兜底，两边都做。
 * 安全性：
 *   - 只读标签页、停止保存之后不做（调用方 applyPresetLayer 判断）；
 *   - 排在写入链上（和 patchStoredChat 一样），每条记录在一个事务里读-改-写：读到的已经不是一条预设记录、或者 id 对不上，就不写；
 *     写的是「事务里现读的那份」去掉敏感字段，不会拿旧内容盖掉这期间别处的改动；
 *   - 失败只记控制台，不影响页面（下次打开再试；导出时还有兜底）。
 */
function scrubStoredPresets() {
    const step = async () => {
        try {
            const keys = await store.keys(PRESET_PREFIX);
            for (const key of keys) {
                await store.transact([key], ([rec]) => {
                    if (!isPresetRecord(rec) || presetKey(rec.id) !== key) return [];
                    const s = sanitizePreset(rec.preset);
                    if (!s.removed.length) return [];
                    return [{ set: key, value: { ...rec, preset: s.preset } }];
                });
            }
        } catch (e) { console.error('清理预设里的连接信息失败（下次打开页面会再试；导出时也会去掉）', e?.message ?? e); }
        return true;
    };
    const prev = writing;
    const p = prev.then(step, step);
    // 链上保留之前那次写入的成败（这次清理失败不算「保存失败」）
    writing = p.then(() => prev, () => prev);
    return p;
}

function applyPresetLayer(stored, activePresetId) {
    // 有写权限时，顺手把存储里各个预设的敏感字段去掉（见 scrubStoredPresets）
    if (!persist.readOnly && !persist.stopped && typeof indexedDB !== 'undefined') scrubStoredPresets();
    if (isLegacyGlobal(stored) && state.preset) {
        presets.mode = 'legacy';
        presets.activeId = null;
        presets.meta = null;
        snap.preset = null;
        if (!persist.readOnly && !persist.stopped) migrateLegacyPreset(stored);   // 只读的标签页不升级
        return;
    }
    presets.mode = 'v2';
    const id = typeof activePresetId === 'string' && activePresetId ? activePresetId : null;
    if (!id) return applyDefaultPreset();
    const rec = bootPresets.find(r => r.id === id);
    if (rec) applyPresetRecord(rec);
    else loadMissingPreset(id);
}

/**
 * 旧形状 → 新形状。排在写入链上（之后的保存都等它），顺序：
 *   1. 读出已有的预设记录，有内容一字不差的就复用（重复执行不会多出预设），否则写一条新的
 *   2. 读回逐字比较
 *   3. 成功后内存里才换成新形状；紧跟着的那次保存把 global 写成新形状（不带本体，只带 activePresetId）
 * 任何一步失败：global 一个字没动（这期间根本不写它），刚写的预设记录尽量删掉，
 * 内存里保持旧形状，页面照旧用 global 里的预设工作、照旧保存（旧形状）；刷新页面会再试一次。
 */
function migrateLegacyPreset(stored) {
    presets.migrating = true;
    const step = async () => {
        let created = null;
        try {
            const existing = await readPresetRecords();
            const plan = planPresetMigration(stored, existing, { now: new Date(), newId: uid });
            if (plan.create) {
                created = plan.record.id;
                const key = presetKey(plan.record.id);
                await store.set(key, plan.record);
                if (JSON.stringify(await store.get(key)) !== JSON.stringify(plan.record)) throw new Error(`读回校验不一致：${key}`);
            }
            for (const r of existing) presets.catalog.set(r.id, metaOf(r));
            presets.mode = 'v2';
            const liveName = state.presetName;
            const liveBody = state.preset;
            // 升级期间用户可能已经改了条目：内存里的 state.preset 保持原样，快照按「存进去的那份」记，
            // 两者不同时紧跟着的那次保存会把改动写进这条记录
            applyPresetRecord(plan.record);
            state.preset = liveBody;
            if (liveName !== (stored.presetName ?? '')) state.presetName = liveName;   // 期间改过名字：以改过的为准
            console.info(`预设已升级为多预设存储：「${plan.record.name}」${plan.create ? '' : '（复用已有的记录）'}`);
        } catch (e) {
            console.error('预设存储升级失败', e);
            if (created) await store.del(presetKey(created)).catch(() => {});
            presets.mode = 'legacy';
            presets.activeId = null;
            presets.meta = null;
            snap.preset = null;
            toast(`预设存储升级失败：${e?.message ?? e}。旧数据没有动，这次照旧用原来的预设（暂时不能存多个预设）；刷新页面会再试一次。`, 'error');
        } finally {
            presets.migrating = false;
        }
        return true;
    };
    const p = writing.then(step, step);
    writing = p;
    // 升级期间跳过的 global 现在补写（成功：新形状；失败：旧形状，和以前一样）
    p.then(() => { flushNow(); presets.onChange?.(); });
}

/** global 指向的预设启动时没读到（读的时候存储恰好在变，或者记录真的没了）：补读一次，期间不许发送 */
function loadMissingPreset(id) {
    applyDefaultPreset();
    presets.activeId = id;     // 先占着：这期间的保存照旧写这个 id，不会把引用弄丢
    presets.pending = true;
    const blocked = !ui.switching;
    if (blocked) ui.switching = true;   // chat.js 在 ui.switching 时不发送：别用默认预设发出去
    (async () => {
        let rec = null;
        try {
            const all = await readPresetRecords();
            for (const r of all) presets.catalog.set(r.id, metaOf(r));
            rec = all.find(r => r.id === id) ?? null;
        } catch (e) { console.error('读预设失败', e); }
        presets.pending = false;
        if (blocked) ui.switching = false;
        if (rec) applyPresetRecord(rec);
        else {
            applyDefaultPreset();
            toast('上次用的预设在存储里找不到了，先用内置默认预设', 'error');
        }
        presets.onChange?.();
    })();
}

// ── 切换 / 新增 / 删除 / 改名（预设页和导入用） ──

let presetWorking = false;

/** 现在能不能动预设列表：规则和 archive.js 的 canSwitch 一致（生成中、只读、上一个操作没做完都不行） */
export function presetBlocked() {
    if (ui.busy) return '正在生成回复，等它结束（或点「停止」）再切换预设';
    if (ui.switching) return '正在切换存档，稍等一下';
    if (persist.readOnly) return '存储处于只读状态（见页面顶上的说明），不能切换、新增或删除预设';
    if (persist.stopped) return STOPPED_TEXT;
    if (presets.migrating || presets.pending) return '预设存储正在升级 / 读取，稍等一下';
    if (presets.mode !== 'v2') return '预设存储没能升级（见之前的提示），暂时不能存多个预设；刷新页面会再试一次';
    if (presetWorking) return '上一个预设操作还没做完';
    return null;
}

/** 包一层：检查、加锁、先落盘（落盘失败就放弃，宁可不切也不丢改动）。返回 fn 的结果，失败 / 拒绝返回 false */
async function presetOp(fn) {
    const why = presetBlocked();
    if (why) { toast(why, 'error'); return false; }
    presetWorking = true;
    try {
        if (!await flushNow()) { toast('当前内容没能保存，已取消这次操作', 'error'); return false; }
        const r = await fn();
        presets.onChange?.();
        return r ?? true;
    } catch (e) {
        console.error(e);
        toast(`操作失败：${e.message}`, 'error');
        return false;
    } finally {
        presetWorking = false;
    }
}

/**
 * 上面 flush 之后、await 期间，当前预设又有了没落盘的改动（比如在条目框里打字）：先写掉再换，
 * 写失败就放弃这次操作。调用方在它返回后【同步】换预设，中间不能再 await。
 */
async function settlePreset() {
    for (let i = 0; i < 5 && presetDirty(); i++) {
        if (!await flushNow()) throw new Error('当前预设的改动没能保存，已取消');
    }
    if (presetDirty()) throw new Error('当前预设一直在变，稍后再试');
}

/** 存下来的所有预设，按建立时间排；当前那个的名字用 state 里的（改名后还没落盘也是新名字） */
export function listPresets() {
    return [...presets.catalog.values()]
        .map(m => m.id === presets.activeId ? { ...m, name: state.presetName || m.name } : { ...m })
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * 切到另一个预设：只重写 global（activePresetId）。当前预设的改动先落盘。
 * id 为 '' / null：回到内置默认预设（DEFAULT_PRESET）。之后在它上面第一次改动，照旧会存成一条新记录（presetWrites）
 */
export const switchPreset = id => presetOp(async () => {
    id = id || null;
    if (id === presets.activeId) return true;
    if (id === null) {
        await settlePreset();   // presetOp 已经落过盘；这期间又有的改动先写掉
        applyDefaultPreset();
        await flushNow();
        return true;
    }
    const rec = await store.get(presetKey(id));
    if (!isPresetRecord(rec) || rec.id !== id) { presets.catalog.delete(id); throw new Error('这个预设已经不在了'); }
    await settlePreset();
    applyPresetRecord(rec);
    await flushNow();
    return true;
});

/**
 * 导入的预设：新增一条并切过去（不替换任何已有的预设）。同名的不合并，名字后加序号。
 * 新记录和 global 在同一个事务里写。返回实际用的名字（失败返回 false）。
 */
export const addPreset = (json, name) => presetOp(async () => {
    await settlePreset();
    const iso = new Date().toISOString();
    const rec = { id: uid(), name: uniquePresetName(name, [...presets.catalog.values()].map(m => m.name)), preset: json, createdAt: iso, updatedAt: iso };
    applyPresetRecord(rec, { fresh: true });
    await flushNow();
    return rec.name;
});

/**
 * 删除当前预设（调用方先确认）：切到最近改过的另一个；一个都不剩就回到内置默认预设。
 * 「删记录 + 改 global」在同一个事务里。返回切到的预设名（'' = 内置默认预设；失败返回 false）。
 */
export const deleteCurrentPreset = () => presetOp(async () => {
    const id = presets.activeId;
    if (!id) throw new Error('当前用的是内置默认预设，没有可删的');
    const others = [...presets.catalog.values()].filter(m => m.id !== id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    let next = null;
    for (const m of others) {
        const r = await store.get(presetKey(m.id));
        if (isPresetRecord(r) && r.id === m.id) { next = r; break; }
        presets.catalog.delete(m.id);   // 列表里有、存储里没有了：顺手清掉
    }
    // 先让 state 离开要删的预设（之后的保存不会再写回它），再把删除排进下一次保存
    if (next) applyPresetRecord(next); else applyDefaultPreset();
    presets.catalog.delete(id);
    queueDelete(presetKey(id));
    if (!await flushNow()) throw new Error('删除没能保存（下次保存会重试）');
    return next ? metaOf(next).name : '';
});

/** 给当前预设改名（走普通的保存：只重写这一条预设记录）。重名时加序号。返回实际用的名字，没改返回 null */
export function renameCurrentPreset(name) {
    const n = String(name ?? '').trim();
    if (!n || !state.preset) return null;
    const others = [...presets.catalog.values()].filter(m => m.id !== presets.activeId).map(m => m.name);
    state.presetName = uniquePresetName(n, others);
    save();
    return state.presetName;
}

// 启动时先把所有预设读出来（原因见本节开头）。Node 里（单元测试）没有 IndexedDB，跳过；
// 存储打不开 / 卡住也不能让整个页面起不来：最多等 5 秒，读不到就当没有，之后 loadMissingPreset 会补读
const bootPresets = typeof indexedDB === 'undefined' ? [] : await Promise.race([
    readPresetRecords().catch(e => { console.error('读预设列表失败', e); return []; }),
    new Promise(r => setTimeout(() => r([]), 5000)),
]);
for (const r of bootPresets) presets.catalog.set(r.id, metaOf(r));
