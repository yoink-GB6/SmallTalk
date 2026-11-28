// 手机数据层：内存里的缓存 + 所有写入口（契约见 types.js「手机第一步」；纯逻辑在 src/phone-data.js、src/phone-backup.js）。
// 界面（C 阶段的 Chat 应用、Settings 里的壁纸 / 表情库 / 模型、「预设」页的聊天预设一节、摘抄页）只调这里导出的函数，不直接碰存储。
//
// ── 存什么、存在哪 ──
//   'phone'            PhoneRecord（聊天预设、表情目录、两张壁纸、手机用的模型、上次选的预设）
//   'phonechat:<id>'   一个会话；'phoneindex' 会话目录；'phoneimg:<id>' 一张图
// 内存里（phoneMem）：record、index 常驻；会话按需读进来、读过就缓存；图片按需读、缓存 data URL。
// 缓存只在【写成功之后】才换成新值：写失败时内存和存储一样，不会出现「页面上看得到、刷新就没了」。
//
// ── 写入 ──
//   每个改动立刻写（不防抖：手机里的改动都是点一下一次，不是逐字）。全部经 ui/state.js patchPhone：排在写入链后面、
//   一个事务里先读再写（会话 + 目录，需要时加 'phone' 和图片），读到的会话已经不在了就什么都不写（不复活）。
//   拒绝条件（phoneWriteBlocked，每个写入口先问）：只读标签页、停止保存之后、正在恢复备份。被拒 = 抛 Error（message 是给人看的原因），界面 toast 出来。
//   引用的卡被删了的会话（用户定的：留着、只能看）：能看、能删会话、能删 / 改收藏、能删气泡，不能发、不能重新生成、不能编辑（sessionLocked）。
//   这个「只能看」不落盘，每次按「现在存储里有哪些卡」现算（phone-data.js sessionCardsMissing）：卡从备份里回来了，会话自己就又能聊了。
//
// ── 和 RP 的关系 ──
//   手机的键和 RP 的保存（state.js buildWrites）没有重叠；RP 正在生成（ui.busy）、切换存档（ui.switching）都不挡手机，反过来也一样。
//   恢复备份：ui/backup.js 在手机正在回复时拒绝恢复（phone-gen.js isPhoneBusy），恢复写完后调 reloadPhoneFromStore。
//
// UI 模块之间有故意保留的循环依赖（backup.js ↔ 本文件）：顶层只放声明，不调用兄弟模块的函数。

import { store } from '../../store.js';
import { uid } from '../dom.js';
import { persist, patchPhone, STOPPED_TEXT } from '../state.js';
import { restoreActive } from '../backup.js';   // 循环依赖：只在函数体里调用
import {
    normalizePhoneRecord, normalizeSession, normalizeImage, normalizeChatPreset, normalizeWallpaper, newSession, sessionIndexEntry, buildPhoneIndex,
    phoneIndexValid, sortIndex, sessionCardsMissing, splitInput, makeBubbles, appendMessages, editMessage, deleteMessages, truncateFrom,
    planRegenerate, toggleFavorite, editFavorites, markRead, addSticker, renameSticker, setStickerDesc, removeSticker, usedImageIds,
    DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, WALLPAPER_SLOTS, builtinPreset, stickerPart,
} from '../../phone-data.js';
import { PHONE_KEY, PHONE_INDEX_KEY, SESSION_PREFIX, sessionKey, imageKey, unionStickers, stickersFile, parseStickersFile } from '../../phone-backup.js';

/** 内存里的手机数据。别的模块只读它；改一律走下面的函数 */
export const phoneMem = {
    loaded: false,
    /** @type {Object|null} PhoneRecord（规范化过）；null = 还没有这条记录 */
    record: null,
    /** @type {{sessions: Record<string, Object>}} */
    index: { sessions: {} },
    /** @type {Map<string, Object>} 读过的会话（规范化过） */
    sessions: new Map(),
    /** @type {Map<string, Object>} 读过的图（PhoneImage） */
    images: new Map(),
};

const listeners = new Set();
/**
 * 订阅「手机的数据变了」（写成功之后、恢复备份重读之后）。fn({what, id?})：what = 'session' | 'index' | 'record' | 'reload'。
 * 返回取消订阅的函数。界面用它重画；回调出错不影响写入。
 */
export function onPhoneChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what, id) { for (const fn of listeners) { try { fn({ what, id }); } catch (e) { console.error(e); } } }

/** 现在能不能改手机里的东西：能 = null，否则是给人看的原因 */
export function phoneWriteBlocked() {
    if (persist.readOnly) return '这个标签页是只读的（见页面顶上的说明），不能改手机里的东西';
    if (persist.stopped) return STOPPED_TEXT;
    if (restoreActive()) return '正在恢复备份，请稍等';
    return null;
}
function guard() { const why = phoneWriteBlocked(); if (why) throw new Error(why); }

// ───────────────────────────── 读 ─────────────────────────────

let loading = null;

/** 第一次用到手机的数据时读进来（只读一次；恢复备份后 reloadPhoneFromStore 重读）。只读标签页也能读 */
export function ensurePhoneLoaded() {
    if (!loading) loading = loadAll().catch(e => { loading = null; throw e; });
    return loading;
}

/** 一个事务里读出这些键（同一时刻的快照） */
async function readKeys(keys) {
    let values = [];
    await store.transact(keys, v => { values = v; return []; });
    return values;
}

async function loadAll() {
    const keys = await store.keys('');
    const sessionIds = keys.filter(k => k.startsWith(SESSION_PREFIX)).map(k => k.slice(SESSION_PREFIX.length));
    const [rec, idx] = await readKeys([PHONE_KEY, PHONE_INDEX_KEY]);
    phoneMem.record = normalizePhoneRecord(rec, { newId: uid });
    if (phoneIndexValid(idx, sessionIds)) {
        phoneMem.index = idx;
    } else {
        // 目录丢了 / 对不上：把所有会话读一遍重建（同 archive.js loadIndex）。有写权限就顺手写回去，写不成也不要紧（下次再建）
        const raws = await readKeys(sessionIds.map(sessionKey));
        const good = raws.map((r, i) => (r && r.id === sessionIds[i] ? r : null)).filter(Boolean);
        phoneMem.index = buildPhoneIndex(good);
        for (const s of good.map(normalizeSession).filter(Boolean)) phoneMem.sessions.set(s.id, s);
        if (sessionIds.length && !phoneWriteBlocked()) {
            const next = phoneMem.index;
            patchPhone([PHONE_INDEX_KEY], () => [{ set: PHONE_INDEX_KEY, value: next }]).catch(e => console.warn('重建手机会话目录没写成', e?.message ?? e));
        }
    }
    phoneMem.loaded = true;
}

/** 恢复备份写完之后：缓存全部作废、从存储重读，通知界面 */
export async function reloadPhoneFromStore() {
    loading = null;
    phoneMem.loaded = false;
    phoneMem.record = null;
    phoneMem.index = { sessions: {} };
    phoneMem.sessions.clear();
    phoneMem.images.clear();
    await ensurePhoneLoaded();
    emit('reload');
}

/** 一个会话（规范化过）；不在了 = null */
export async function getSession(id) {
    await ensurePhoneLoaded();
    if (phoneMem.sessions.has(id)) return phoneMem.sessions.get(id);
    const raw = await store.get(sessionKey(id));
    const s = raw && raw.id === id ? normalizeSession(raw) : null;
    if (s) phoneMem.sessions.set(id, s);
    return s;
}

/** 一张图（PhoneImage）；不在了 / 坏了 = null */
export async function getImage(id) {
    if (!id) return null;
    if (phoneMem.images.has(id)) return phoneMem.images.get(id);
    const raw = await store.get(imageKey(id));
    const img = raw && raw.id === id ? normalizeImage(raw) : null;
    if (img) phoneMem.images.set(id, img);
    return img;
}

/** 现在存储里有哪些卡 id（判断会话是不是「只能看」用） */
export async function existingCardIds() {
    return new Set((await store.keys('card:')).map(k => k.slice('card:'.length)));
}

/**
 * 会话列表（Chat 应用的首页）：目录里的每一项 + id + locked（引用的卡不在了 = 只能看），置顶的在前、然后新的在前。
 * @returns {Promise<Array<Object>>}
 */
export async function listSessions() {
    await ensurePhoneLoaded();
    const cards = await existingCardIds();
    return sortIndex(phoneMem.index).map(([id, e]) => ({ id, ...e, locked: sessionCardsMissing(e, cards).length > 0 }));
}

/** 这个会话现在能不能聊：能 = null，否则是原因（卡被删了） */
export async function sessionLocked(sessionOrId) {
    const s = typeof sessionOrId === 'string' ? await getSession(sessionOrId) : sessionOrId;
    if (!s) return '这个会话已经不在了';
    return sessionCardsMissing(s, await existingCardIds()).length ? '这个会话用到的角色卡已经删了：会话留着能看，但不能再聊' : null;
}

/** 有几个会话用到这张卡（删卡的确认框里说一句） */
export async function sessionsUsingCard(cardId) {
    await ensurePhoneLoaded();
    return Object.values(phoneMem.index.sessions).filter(e => Array.isArray(e.cards) && e.cards.includes(cardId)).length;
}

/** 有几个会话在用这个聊天预设（'default' = 没写 presetId 的那些） */
export async function sessionsUsingPreset(presetId) {
    await ensurePhoneLoaded();
    return Object.values(phoneMem.index.sessions).filter(e => (e.presetId ?? DEFAULT_PRESET_ID) === presetId).length;
}

// ───────────────────────────── 会话的写 ─────────────────────────────

/** 目录里换掉 / 去掉一个会话的条目。tx 里读到的目录形状不对时用内存里那份当底子 */
function indexWith(idx, id, entry) {
    const base = idx && typeof idx === 'object' && idx.sessions && typeof idx.sessions === 'object' ? idx.sessions : phoneMem.index.sessions;
    const sessions = { ...base };
    if (entry) sessions[id] = entry; else delete sessions[id];
    return { sessions };
}

/**
 * 改一个会话：事务里现读、规范化、交给 mutate（纯函数，返回新会话；返回 null / 原对象 = 不用写）。会话和目录一起写。
 * @returns {Promise<Object|null>} 写完之后的会话（没写就是读到的那份；会话不在了 = null）
 */
async function updateSession(id, mutate) {
    guard();
    await ensurePhoneLoaded();
    let result = null, index = null;
    const wrote = await patchPhone([sessionKey(id), PHONE_INDEX_KEY], ([raw, idx]) => {
        result = null; index = null;
        const s = raw && raw.id === id ? normalizeSession(raw) : null;
        if (!s) return [];
        result = s;
        const next = mutate(s);
        if (!next || next === s) return [];
        result = next;
        index = indexWith(idx, id, sessionIndexEntry(next));
        return [{ set: sessionKey(id), value: next }, { set: PHONE_INDEX_KEY, value: index }];
    });
    if (result) phoneMem.sessions.set(id, result); else phoneMem.sessions.delete(id);
    if (wrote) { phoneMem.index = index; emit('session', id); }
    return result;
}

/** 调 updateSession 之前先确认会话能聊（卡还在） */
async function requireUnlocked(id) {
    const why = await sessionLocked(id);
    if (why) throw new Error(why);
}

/**
 * 新建一个会话（单聊一张卡）。卡必须现在还在。personaId：null = 跟随当前人设；presetId：不给 / 'default' = 默认聊天预设。
 * 也把 presetId 记成「上次选的预设」（PhoneRecord.lastPresetId，当前选择）。
 * @returns {Promise<Object>} 新会话
 */
export async function createSession({ cardId, personaId = null, presetId }) {
    guard();
    await ensurePhoneLoaded();
    if (!(await existingCardIds()).has(cardId)) throw new Error('这张角色卡已经不在了');
    const s = newSession({ id: uid(), cardId, personaId, presetId, now: new Date() });
    let index = null, record = null;
    const want = presetId && presetId !== DEFAULT_PRESET_ID ? presetId : null;
    await patchPhone([PHONE_INDEX_KEY, PHONE_KEY], ([idx, rec]) => {
        index = indexWith(idx, s.id, sessionIndexEntry(s));
        const ops = [{ set: sessionKey(s.id), value: s }, { set: PHONE_INDEX_KEY, value: index }];
        record = null;
        const r = normalizePhoneRecord(rec, { newId: uid }) ?? { v: 1 };
        if ((r.lastPresetId ?? null) !== want) {
            record = { ...r };
            if (want) record.lastPresetId = want; else delete record.lastPresetId;
            ops.push({ set: PHONE_KEY, value: record });
        }
        return ops;
    });
    phoneMem.sessions.set(s.id, s);
    phoneMem.index = index;
    if (record) phoneMem.record = record;
    emit('index');
    return s;
}

/** 删一个会话（连同它的收藏）。卡被删了的会话也能删 */
export async function deleteSession(id) {
    guard();
    await ensurePhoneLoaded();
    let index = null;
    await patchPhone([PHONE_INDEX_KEY], ([idx]) => {
        index = indexWith(idx, id, null);
        return [{ del: sessionKey(id) }, { set: PHONE_INDEX_KEY, value: index }];
    });
    phoneMem.sessions.delete(id);
    phoneMem.index = index;
    emit('index');
}

/**
 * 改会话的设置：personaId（null = 跟随当前人设）、presetId（'default' / null = 默认）、title（'' = 去掉，显示卡名）、pinned。
 * 不动 updatedAt（不算「消息变了」）。卡被删了的会话也能改标题、置顶。
 */
export function setSessionOptions(id, patch) {
    return updateSession(id, s => {
        const next = { ...s };
        if ('personaId' in patch) next.personaId = patch.personaId || null;
        if ('presetId' in patch) { if (patch.presetId && patch.presetId !== DEFAULT_PRESET_ID) next.presetId = patch.presetId; else delete next.presetId; }
        if ('title' in patch) { const t = String(patch.title ?? '').trim(); if (t) next.title = t; else delete next.title; }
        if ('pinned' in patch) { if (patch.pinned) next.pinned = true; else delete next.pinned; }
        return JSON.stringify(next) === JSON.stringify(s) ? s : next;
    });
}

/**
 * 用户发消息：输入框的文字按「一行一个气泡」（PHONE_CHOICES.sendMode）加进去。空输入不加（界面接着调 phone-gen.js phoneReply = 「让 TA 接着说」）。
 * @returns {Promise<Object>} 写完的会话
 */
export async function sendUserText(id, text) {
    await requireUnlocked(id);
    const parts = splitInput(text).map(content => ({ content }));
    if (!parts.length) return getSession(id);
    const now = new Date();
    const msgs = makeBubbles('user', parts, { newId: uid, now: now.getTime() });
    return updateSession(id, s => markRead(appendMessages(s, msgs, { now, newId: uid })));
}

/** 用户从表情面板发一个表情 */
export async function sendUserSticker(id, stickerId) {
    await requireUnlocked(id);
    await ensurePhoneLoaded();
    const st = (phoneMem.record?.stickers ?? []).find(s => s.id === stickerId);
    if (!st) throw new Error('这个表情已经不在了');
    const now = new Date();
    const msgs = makeBubbles('user', [stickerPart(st)], { newId: uid, now: now.getTime() });
    return updateSession(id, s => markRead(appendMessages(s, msgs, { now, newId: uid })));
}

/**
 * 把一批回复的气泡接到会话末尾（phone-gen.js 在回复结束 / 停止时调）。parts 是 splitReply 的 bubbles。
 * 不检查卡在不在：生成开始时检查过，这一刻卡被删了也照样把已经花了额度的回复存下来。
 * markAsRead：会话正开着（用户看得到）时传 true。
 */
export function appendReply(id, parts, { gen = uid(), markAsRead = false } = {}) {
    if (!parts.length) return getSession(id);
    const now = new Date();
    const msgs = makeBubbles('assistant', parts, { newId: uid, now: now.getTime(), gen });
    return updateSession(id, s => { const n = appendMessages(s, msgs, { now, newId: uid }); return markAsRead ? markRead(n) : n; });
}

/** 编辑第 i 个气泡（收藏不动）。卡被删了的会话不能编辑 */
export async function editBubble(id, i, content) {
    await requireUnlocked(id);
    return updateSession(id, s => editMessage(s, i, content, { now: new Date() }).session);
}

/** 删第 i 个气泡（收藏跟着挪 / 没）。卡被删了的会话也能删 */
export const deleteBubble = (id, i) => updateSession(id, s => deleteMessages(s, [i], { now: new Date() }).session);

/** 从第 i 个气泡往后全删 */
export const truncateBubbles = (id, i) => updateSession(id, s => truncateFrom(s, i, { now: new Date() }).session);

/** 「重新生成」之前：删掉最后一批（PHONE_CHOICES.regenerate = 'replace'）。phone-gen.js 调；返回删完的会话 */
export async function prepareRegenerate(id) {
    await requireUnlocked(id);
    return updateSession(id, s => planRegenerate(s, { now: new Date() }).session);
}

/** 收藏 / 取消收藏第 i 个气泡。返回 {session, on} */
export async function toggleBubbleFavorite(id, i) {
    let on = false;
    const session = await updateSession(id, s => { const r = toggleFavorite(s, i, { newId: uid, now: Date.now() }); on = r.on; return r.session; });
    return { session, on };
}

/** 标已读（打开会话时）。已经是已读的不写 */
export const markSessionRead = id => updateSession(id, s => markRead(s));

/**
 * 摘抄页的删除 / 改备注（可以跨好几个会话）：edits = [{sessionId, remove?: id[], notes?: {id: 备注}}]。【一个事务】，要么全成要么全不成。
 * 会话不在了的跳过（gone 计数）。生成中也能改：生成写回也是事务里读-改-写，互相不会盖掉对方。
 * @returns {Promise<{removed: number, noted: number, gone: number}>}
 */
export async function editPhoneFavorites(edits) {
    guard();
    await ensurePhoneLoaded();
    const keys = edits.map(e => sessionKey(e.sessionId));
    let changed = [], index = null, removed = 0, noted = 0, gone = 0;
    await patchPhone([...keys, PHONE_INDEX_KEY], values => {
        changed = []; removed = 0; noted = 0; gone = 0; index = null;
        const idx = values.at(-1);
        let sessions = null;
        edits.forEach((e, i) => {
            const s = values[i] && values[i].id === e.sessionId ? normalizeSession(values[i]) : null;
            if (!s) { gone++; return; }
            const r = editFavorites(s, { remove: e.remove ?? [], notes: e.notes ?? {} });
            if (!r.changed) return;
            removed += r.removed; noted += r.noted;
            changed.push(r.session);
            sessions = indexWith(sessions ?? idx, s.id, sessionIndexEntry(r.session));
        });
        if (!changed.length) return [];
        index = sessions;
        return [...changed.map(s => ({ set: sessionKey(s.id), value: s })), { set: PHONE_INDEX_KEY, value: index }];
    });
    for (const s of changed) { phoneMem.sessions.set(s.id, s); emit('session', s.id); }
    if (index) phoneMem.index = index;
    return { removed, noted, gone };
}

// ───────────────────────────── 'phone' 记录的写（预设、表情、壁纸、模型） ─────────────────────────────

/**
 * 改 'phone' 记录：事务里现读、规范化，mutate(record, values) 返回 {record, ops?}（record = null 表示不用写；ops 是另外要一起写的图片等）。
 * extraKeys：要一起读的别的键（mutate 的 values 里跟在 'phone' 后面）。
 */
async function updateRecord(mutate, extraKeys = []) {
    guard();
    await ensurePhoneLoaded();
    let next = null, extra = null;
    await patchPhone([PHONE_KEY, ...extraKeys], values => {
        next = null; extra = null;
        const cur = normalizePhoneRecord(values[0], { newId: uid }) ?? { v: 1 };
        const r = mutate(cur, values.slice(1));
        if (!r || !r.record) return [];
        next = r.record; extra = r;
        return [{ set: PHONE_KEY, value: next }, ...(r.ops ?? [])];
    });
    if (next) {
        phoneMem.record = next;
        for (const op of extra.ops ?? []) {
            const id = (op.set ?? op.del).slice('phoneimg:'.length);
            if (op.set) phoneMem.images.set(id, op.value); else phoneMem.images.delete(id);
        }
        emit('record');
    }
    return extra?.result ?? next;
}

/** 现在的聊天预设列表（不含没改过的内置默认；要显示「默认」时加上 builtinPreset()） */
export const chatPresets = () => phoneMem.record?.presets ?? [];

/**
 * 存一个聊天预设（新建或改）：没有 id = 新建（给新 id）；id 是 'default' = 改默认（存成 id 'default' 的一项，所有用默认的会话一起变）。
 * 规范化后存完整的一份，updatedAt 换成现在。返回存下来的那份。
 */
export function saveChatPreset(preset) {
    const iso = new Date().toISOString();
    const id = preset?.id || uid();
    return updateRecord(r => {
        const list = [...(r.presets ?? [])];
        const i = list.findIndex(p => p.id === id);
        const base = i >= 0 ? list[i] : (id === DEFAULT_PRESET_ID ? builtinPreset() : { createdAt: iso });
        const p = normalizeChatPreset({ ...base, ...preset, id, name: preset?.name ?? base.name ?? (id === DEFAULT_PRESET_ID ? DEFAULT_PRESET_NAME : '新的聊天预设'),
            createdAt: base.createdAt || iso, updatedAt: iso });
        if (i >= 0) list[i] = p; else list.push(p);
        return { record: { ...r, presets: list }, result: p };
    });
}

/** 删一个聊天预设（'default' = 恢复默认）。用到它的会话改用默认（不改会话记录）；确认框里的「有 N 个会话在用」见 sessionsUsingPreset */
export function deleteChatPreset(id) {
    return updateRecord(r => {
        const list = (r.presets ?? []).filter(p => p.id !== id);
        if (list.length === (r.presets ?? []).length) return null;
        const next = { ...r };
        if (list.length) next.presets = list; else delete next.presets;
        if (next.lastPresetId === id) delete next.lastPresetId;
        return { record: next };
    });
}

/** 手机聊天用的「接口 + 模型」（null = 跟着 RP 的 chatModel）。当前选择：存本机、不进备份 */
export function setPhoneModelRef(ref) {
    return updateRecord(r => {
        const next = { ...r };
        if (ref && typeof ref.endpoint === 'string') next.modelRef = { endpoint: ref.endpoint, model: String(ref.model ?? '') }; else delete next.modelRef;
        return JSON.stringify(next) === JSON.stringify(r) ? null : { record: next };
    });
}

/**
 * 加一个表情。图片界面已经按 phone-data.js imagePlan 处理好（缩放 / 原样 / 拒收）。名字撞了拒绝（抛错，message 是原因）。
 * 目录和图片在同一个事务里写。返回新的表情（PhoneStickerMeta）。
 * @param {{name: string, desc?: string, dataUrl: string, w?: number, h?: number}} spec
 */
export async function addStickerImage({ name, desc, dataUrl, w, h }) {
    const id = uid();
    const img = normalizeImage({ id, dataUrl, w, h });
    if (!img) throw new Error('只能用 PNG、JPEG、WebP、GIF 图片');
    let error = null;
    const out = await updateRecord(r => {
        error = null;
        const a = addSticker(r.stickers ?? [], { id, name, desc, at: Date.now() });
        if (a.error) { error = a.error; return null; }
        return { record: { ...r, stickers: a.list }, ops: [{ set: imageKey(id), value: img }], result: a.sticker };
    });
    if (error) throw new Error(error);
    return out;
}

/** 表情改名（撞名拒绝）/ 改描述 */
export async function renameStickerById(id, name) {
    let error = null;
    await updateRecord(r => { error = null; const x = renameSticker(r.stickers ?? [], id, name); if (x.error) { error = x.error; return null; } return { record: { ...r, stickers: x.list } }; });
    if (error) throw new Error(error);
}
export const setStickerDescById = (id, desc) => updateRecord(r => ({ record: { ...r, stickers: setStickerDesc(r.stickers ?? [], id, desc) } }));

/** 删一个表情（目录项和图片一个事务）。已经发过它的消息显示成文字 */
export function deleteSticker(id) {
    return updateRecord(r => {
        const list = removeSticker(r.stickers ?? [], id);
        if (list.length === (r.stickers ?? []).length) return null;
        const next = { ...r };
        if (list.length) next.stickers = list; else delete next.stickers;
        // 壁纸碰巧指着同一个 id（不会发生：两者 id 各自生成）时不删图
        return { record: next, ops: usedImageIds(next).has(id) ? [] : [{ del: imageKey(id) }] };
    });
}

/**
 * 换一个位置的壁纸（'lock' 锁屏 / 'home' 桌面）。图片界面已经按 imagePlan 处理好（静态图缩到 2048 存 JPEG；动图原样，最多 5 MB）。
 * 新图写进去、记录指过去、旧图（没有别的位置在用的话）删掉，一个事务。
 */
export async function setWallpaper(slot, { dataUrl, w, h }) {
    if (!WALLPAPER_SLOTS.includes(slot)) throw new Error('壁纸位置不对');
    const id = uid();
    const img = normalizeImage({ id, dataUrl, w, h });
    if (!img) throw new Error('只能用 PNG、JPEG、WebP、GIF 图片');
    return updateRecord(r => {
        const wp = { ...(normalizeWallpaper(r.wallpaper) ?? {}), [slot]: id };
        const next = { ...r, wallpaper: wp };
        const old = normalizeWallpaper(r.wallpaper)?.[slot];
        const ops = [{ set: imageKey(id), value: img }];
        if (old && !usedImageIds(next).has(old)) ops.push({ del: imageKey(old) });
        return { record: next, ops };
    });
}

/** 去掉一个位置的壁纸（回到主题自带的） */
export function clearWallpaper(slot) {
    return updateRecord(r => {
        const cur = normalizeWallpaper(r.wallpaper);
        if (!cur?.[slot]) return null;
        const wp = { ...cur };
        delete wp[slot];
        const next = { ...r };
        if (Object.keys(wp).length) next.wallpaper = wp; else delete next.wallpaper;
        return { record: next, ops: usedImageIds(next).has(cur[slot]) ? [] : [{ del: imageKey(cur[slot]) }] };
    });
}

/** 一个位置的壁纸图（PhoneImage）；没设 = null（用主题的） */
export async function wallpaperImage(slot) {
    await ensurePhoneLoaded();
    return getImage(normalizeWallpaper(phoneMem.record?.wallpaper)?.[slot]);
}

// ───────────────────────────── 表情包的单独导出 / 导入 ─────────────────────────────

/** 表情包文件的对象（界面 JSON.stringify 后下载）。只读标签页也能导出 */
export async function exportStickers() {
    await ensurePhoneLoaded();
    const images = new Map();
    for (const s of phoneMem.record?.stickers ?? []) { const img = await getImage(s.id); if (img) images.set(s.id, img); }
    return stickersFile(phoneMem.record, images);
}

/**
 * 导入表情包文件（并集：图一样的跳过，撞名加「 (2)」）。目录和新图一个事务。
 * @returns {Promise<{added: number, dup: number, skipped: number, renamed: string[]}>}
 */
export async function importStickers(text) {
    const parsed = parseStickersFile(text);
    if (!parsed.ok) throw new Error(parsed.error);
    await ensurePhoneLoaded();
    const ids = (phoneMem.record?.stickers ?? []).map(s => s.id);
    // 判重要比图片：先把本机的图读进来（事务外读；事务里核对目录没变，变了就中止重来）
    const images = new Map();
    for (const id of ids) { const img = await getImage(id); if (img) images.set(id, img); }
    let res = null;
    await updateRecord(r => {
        if (JSON.stringify((r.stickers ?? []).map(s => s.id)) !== JSON.stringify(ids)) throw new Error('表情库刚刚被改过，请再导入一次');
        res = unionStickers(r.stickers ?? [], images, parsed.stickers, { newId: uid, now: Date.now() });
        if (!res.added) return null;
        return { record: { ...r, stickers: res.list }, ops: res.newImages.map(img => ({ set: imageKey(img.id), value: img })) };
    });
    return { added: res.added, dup: res.dup, skipped: res.skipped, renamed: res.renamed };
}
