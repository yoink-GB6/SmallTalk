// 手机的数据在整体备份里怎么带、恢复时怎么并（纯函数，Node 里可测：test/phone-backup.test.mjs）。契约见 types.js「手机第一步」的「备份和恢复」。
// backup.js 的 buildBackup / countBackup / summaryText 调这里；ui/backup.js 在恢复的写入事务里用 planPhoneImport 的结果。
//
// 存储键（四种，都在 IndexedDB smalltalk / kv）：
//   'phone'               PhoneRecord：聊天预设（内容）、表情目录（内容）、两张壁纸（设置）、手机用的模型和上次选的预设（当前选择）
//   'phonechat:<id>'      一个会话（内容）
//   'phoneimg:<id>'       一张图（表情或壁纸的字节）
//   'phoneindex'          会话目录（能重建，不进备份）
//
// 备份文件里是一个可选的顶层字段 phone（PhoneBackup）；version 仍是 1。旧版本的页面不认识这个字段：parseBackup / planBackupImport 只看
// cards / presets / global / endpoints，phone 被忽略——不报错，手机以外的东西照常恢复（test/phone-backup.test.mjs 钉着）。
// 没用过手机的人：存储里没有这些键 → 备份里没有 phone 字段，和以前逐字相同。
//
// 恢复的规矩（三类）：
//   内容（会话、聊天预设、表情）：取并集，本机的一条不删不改；判重只比内容。
//   设置（两张壁纸）：空浏览器直接用备份的；已有数据时并进「是否应用备份中的……」那一句问话（答「是」才换，按位置换，备份里没有的位置不动）。
//   当前选择（手机用的模型、上次选的预设）：不导出、永不从备份拿。

import {
    normalizePhoneRecord, normalizeSession, normalizeChatPreset, normalizeImage, normalizeStickers, normalizeWallpaper, cleanStickerName, cleanStickerDesc,
    stickerNamer, buildPhoneIndex, phoneDoc, phoneRecordHasContent, usedImageIds, builtinPreset, WALLPAPER_SLOTS, DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, MAX_STICKERS,
} from './phone-data.js';
import { mergeHighlights } from './highlight.js';
import { makeUniqueNamer } from './migrate.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = v => typeof v === 'string' && v !== '';

// ───────────────────────────── 键 ─────────────────────────────

export const PHONE_KEY = 'phone';
export const PHONE_INDEX_KEY = 'phoneindex';
export const SESSION_PREFIX = 'phonechat:';
export const IMAGE_PREFIX = 'phoneimg:';
export const sessionKey = id => `${SESSION_PREFIX}${id}`;
export const imageKey = id => `${IMAGE_PREFIX}${id}`;
/** 进整体备份的手机键（目录 'phoneindex' 能重建，不算） */
export const isPhoneBackupKey = k => k === PHONE_KEY || k.startsWith(SESSION_PREFIX) || k.startsWith(IMAGE_PREFIX);
/** 所有手机键（含目录）。「空浏览器」判定、清理用 */
export const isPhoneKey = k => isPhoneBackupKey(k) || k === PHONE_INDEX_KEY;

/** 键 = 前缀 + 记录里的 id：对不上的记录（手改的）不认，同 backup.js buildBackup 对 card: / chat: 的处理 */
const idOf = (key, prefix, value) => (isObj(value) && key === `${prefix}${value.id}` ? value.id : null);

/** 键值表里拆出手机的三样（规范化过）：{record, sessions: PhoneSession[], images: Map<id, PhoneImage>} */
export function phoneEntriesFrom(entries) {
    let record = null;
    const sessions = [], images = new Map();
    for (const [k, v] of Object.entries(entries ?? {})) {
        if (k === PHONE_KEY) record = normalizePhoneRecord(v, { newId: fallbackId });
        else if (k.startsWith(SESSION_PREFIX) && idOf(k, SESSION_PREFIX, v)) { const s = normalizeSession(v); if (s) sessions.push(s); }
        else if (k.startsWith(IMAGE_PREFIX) && idOf(k, IMAGE_PREFIX, v)) { const img = normalizeImage(v); if (img) images.set(img.id, img); }
    }
    sessions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || (a.id < b.id ? -1 : 1));
    return { record, sessions, images };
}
// 读档时预设 id 重复（手改的数据）要换一个新 id；这里只在导出 / 计划时用到，给一个确定的就行
let fallbackSeq = 0;
const fallbackId = () => `p-dup-${++fallbackSeq}`;

/**
 * 「空浏览器」判定里手机这一项（backup.js isEmptyForRestore 的 phone 参数）：有会话、有图，或 'phone' 记录里有内容 / 设置 → 有数据。
 * 只有当前选择（选了哪个模型）的 'phone' 记录不算。
 * @param {string[]} keys   存储里全部的键
 * @param {any} phoneRecord 存储里 'phone' 的值
 */
export const hasPhoneData = (keys, phoneRecord) =>
    keys.some(k => k.startsWith(SESSION_PREFIX) || k.startsWith(IMAGE_PREFIX)) || phoneRecordHasContent(normalizePhoneRecord(phoneRecord, { newId: fallbackId }));

// ───────────────────────────── 导出 ─────────────────────────────

/**
 * 存储里的手机数据 → 备份里的 phone 字段（types.js PhoneBackup）。什么都没有 = null（不写这个字段）。
 *   presets：PhoneRecord.presets 原样（规范化过，含改过的 'default'）；sessions：全部会话（规范化过，含收藏）；
 *   wallpaper：两个位置各自的图内联成 {dataUrl, w?, h?}（图丢了的位置不带）；
 *   stickers：带图（opts.stickers 为 false 时不带，另写 stickersOmitted: true——库是空的就不写这个标记）。图丢了的表情不带。
 *   不导出：modelRef、lastPresetId（当前选择）、'phoneindex'（能重建）、孤儿图。
 * @param {Record<string, any>} entries   键 → 存储里的值（只看手机的键，别的忽略）
 * @param {{stickers?: boolean}} [opts]
 */
export function phoneForBackup(entries, { stickers = true } = {}) {
    const { record, sessions, images } = phoneEntriesFrom(entries);
    const out = {};
    if (record?.presets?.length) out.presets = structuredClone(record.presets);
    if (sessions.length) out.sessions = structuredClone(sessions);
    const wp = normalizeWallpaper(record?.wallpaper);
    if (wp) {
        const w = {};
        for (const slot of WALLPAPER_SLOTS) { const img = wp[slot] && images.get(wp[slot]); if (img) w[slot] = inlineImage(img); }
        if (Object.keys(w).length) out.wallpaper = w;
    }
    const lib = (record?.stickers ?? []).filter(s => images.has(s.id));
    if (lib.length) {
        if (stickers) out.stickers = lib.map(s => ({ ...structuredClone(s), ...inlineImage(images.get(s.id)) }));
        else out.stickersOmitted = true;
    }
    return Object.keys(out).length ? out : null;
}
const inlineImage = img => ({ dataUrl: img.dataUrl, ...(img.w ? { w: img.w } : {}), ...(img.h ? { h: img.h } : {}) });

/** 备份里手机的东西有多少（导出框小计、恢复框的「这次将导入」） */
export function countPhone(p) {
    const ok = isObj(p);
    return {
        sessions: ok && Array.isArray(p.sessions) ? p.sessions.length : 0,
        presets: ok && Array.isArray(p.presets) ? p.presets.length : 0,
        stickers: ok && Array.isArray(p.stickers) ? p.stickers.length : 0,
        wallpapers: ok && isObj(p.wallpaper) ? WALLPAPER_SLOTS.filter(s => isObj(p.wallpaper[s])).length : 0,
        stickersOmitted: ok && p.stickersOmitted === true,
    };
}

/** 表情包大概多大（导出框里「带上表情包（N 个，约 X MB）」用）：data URL 字符串的总长度，按字节算 */
export const stickersBytes = p => (isObj(p) && Array.isArray(p.stickers) ? p.stickers.reduce((n, s) => n + (typeof s.dataUrl === 'string' ? s.dataUrl.length : 0), 0) : 0);

// ───────────────────────────── 单独导出 / 导入表情包 ─────────────────────────────

export const STICKERS_FORMAT = 'smalltalk-stickers';
/** 表情包文件：{format, version: 1, stickers: [{name, desc?, dataUrl}]}（明文，不含 key）。图丢了的表情不带 */
export function stickersFile(record, images) {
    const list = (normalizeStickers(record?.stickers)).filter(s => images.get(s.id)).map(s => ({ name: s.name, ...(s.desc ? { desc: s.desc } : {}), dataUrl: images.get(s.id).dataUrl }));
    return { format: STICKERS_FORMAT, version: 1, stickers: list };
}
/** 读表情包文件（只认形状；每一项的清洗在 unionStickers 里） */
export function parseStickersFile(text) {
    let d;
    try { d = JSON.parse(text); } catch { return { ok: false, error: '这个文件不是 JSON' }; }
    if (!isObj(d) || d.format !== STICKERS_FORMAT || !Array.isArray(d.stickers)) return { ok: false, error: '这不是 SmallTalk 的表情包文件' };
    if (d.version !== 1) return { ok: false, error: '表情包文件的版本不认识' };
    return { ok: true, stickers: d.stickers };
}

// ───────────────────────────── 判重签名 ─────────────────────────────

/** 键排好序的 JSON（和 backup.js canonical 同一个写法；这里不 import backup.js，因为 backup.js 要 import 这个文件） */
export function canonical(v) {
    return JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
}

/** 聊天预设的「内容」：去掉 id、名字、时间（名字不算内容，同 RP 预设） */
export function chatPresetSig(p) {
    const n = normalizeChatPreset(p);
    if (!n) return null;
    const { id: _i, name: _n, createdAt: _c, updatedAt: _u, ...rest } = n;
    return canonical(rest);
}

/**
 * 会话的「内容」：参与的卡（换算后）+ 每条消息的 {role, content, at, from（换算后）}。
 * 不看：id、标题、人设 / 预设的选择、readAt、置顶、收藏、消息 id、sticker（契约：备份里可能没带表情，sticker 可能对不上）。
 * @param {Object} s       已规范化
 * @param {(id: string) => string} mapCard   卡 id 换算（本机这一边原样）
 */
export function sessionSig(s, mapCard = x => x) {
    return canonical([s.cards.map(mapCard), s.messages.map(m => [m.role, m.content, m.at, m.from ? mapCard(m.from) : null])]);
}

// ───────────────────────────── 壁纸（设置） ─────────────────────────────

/**
 * 备份里的壁纸有哪几个位置和本机的不一样（不一样才算「一样可以应用的设置」，才进那句问话）。
 * 备份里没有的位置不算（备份里缺 = 没有，本机的不动）。
 * @param {Object} backupPhone   备份里的 phone 字段
 * @param {{record: Object|null, images: Map}} local
 * @returns {string[]}  'lock' / 'home'
 */
export function wallpaperChanges(backupPhone, local) {
    const theirs = isObj(backupPhone?.wallpaper) ? backupPhone.wallpaper : {};
    const mine = normalizeWallpaper(local?.record?.wallpaper) ?? {};
    return WALLPAPER_SLOTS.filter(slot => {
        const t = backupImage(theirs[slot]);
        if (!t) return false;
        const m = mine[slot] && local.images.get(mine[slot]);
        return !m || m.dataUrl !== t.dataUrl;
    });
}
/** 备份里内联的一张图 → PhoneImage 的形状（id 先空着）；坏的 = null */
const backupImage = v => (isObj(v) ? normalizeImage({ ...v, id: 'x' }) : null);

// ───────────────────────────── 表情并集（恢复和「导入表情包」共用） ─────────────────────────────

/**
 * 表情取并集：图片（dataUrl）一样 = 同一个表情（保留本机的名字和描述，记下 备份 id → 本机 id）；新的换新 id，名字撞了加「 (2)」。
 * 名字规范化后空了、图不是认得的图片 → 跳过（计入 skipped）。库满了（MAX_STICKERS）后面的跳过。
 * @param {Object[]} mine        本机的表情目录（规范化过）
 * @param {Map<string, Object>} images   本机的图（id → PhoneImage）
 * @param {any[]} theirs         备份 / 表情包文件里的 [{id?, name, desc?, dataUrl, w?, h?, at?}]
 * @param {{newId: () => string, now: number}} deps
 * @returns {{list: Object[], newImages: Object[], idMap: Map<string, string>, added: number, dup: number, renamed: string[], skipped: number}}
 */
export function unionStickers(mine, images, theirs, { newId, now }) {
    const list = [...(mine ?? [])];
    const byData = new Map();
    for (const s of list) { const img = images.get(s.id); if (img && !byData.has(img.dataUrl)) byData.set(img.dataUrl, s.id); }
    const nameFor = stickerNamer(list);
    const newImages = [], idMap = new Map(), renamed = [];
    let added = 0, dup = 0, skipped = 0;
    for (const t of Array.isArray(theirs) ? theirs : []) {
        const img = isObj(t) ? backupImage(t) : null;
        const want = isObj(t) ? cleanStickerName(t.name) : '';
        if (!img || !want) { skipped++; continue; }
        const hit = byData.get(img.dataUrl);
        if (hit) { dup++; if (isNonEmptyStr(t.id)) idMap.set(t.id, hit); continue; }
        if (list.length >= MAX_STICKERS) { skipped++; continue; }
        const id = newId();
        const name = nameFor(want);
        if (name !== want) renamed.push(`表情「${want}」→「${name}」`);
        const s = { id, name };
        const desc = cleanStickerDesc(t.desc);
        if (desc !== undefined) s.desc = desc;
        s.at = typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : now;
        list.push(s);
        newImages.push({ ...img, id });
        byData.set(img.dataUrl, id);
        if (isNonEmptyStr(t.id)) idMap.set(t.id, id);
        added++;
    }
    return { list, newImages, idMap, added, dup, renamed, skipped };
}

// ───────────────────────────── 恢复计划 ─────────────────────────────

/**
 * 备份里的手机数据要怎么并进本机。纯函数，不改输入。
 * @param {any} backupPhone   备份里的 phone 字段（没有 / 形状不对 = 什么都不做）
 * @param {{record: Object|null, sessions: Object[], images: Map<string, Object>}} local   本机的（phoneEntriesFrom 的结果；空浏览器传空的）
 * @param {{newId: () => string, now: Date, fresh?: boolean, applyWallpaper?: boolean,
 *          cardIdMap?: Map<string, string>, personaIdMap?: Map<string, string>}} deps
 *        fresh：空浏览器（壁纸直接用备份的）；applyWallpaper：已有数据时问话答了「是」；
 *        cardIdMap / personaIdMap：planBackupImport 的 maps（备份里的 id → 本机的 id）
 * @returns {{
 *   record: Object|null,        要写的新 'phone' 记录（null = 不用写）
 *   sessions: Object[],         新会话（新 id）
 *   favMerges: {id: string, session: Object}[],   要并进收藏的本机会话（整条新记录）
 *   images: Object[],           新图（PhoneImage，新 id）
 *   dropImages: string[],       换壁纸后不再有人用的旧图 id
 *   index: Object|null,         要写的新 'phoneindex'（会话有变化时；null = 不用写）
 *   wallpaperApplied: string[], 换了哪几个位置
 *   summary: Object,
 * }}
 */
export function planPhoneImport(backupPhone, local, { newId, now, fresh = false, applyWallpaper = false, cardIdMap = new Map(), personaIdMap = new Map() }) {
    const summary = { sessionsAdded: 0, sessionsDup: 0, favMerged: 0, presetsAdded: 0, presetsDup: 0, stickersAdded: 0, stickersDup: 0,
        stickersOmitted: false, wallpaperApplied: [], renamed: [], skipped: [] };
    const out = { record: null, sessions: [], favMerges: [], images: [], dropImages: [], index: null, wallpaperApplied: summary.wallpaperApplied, summary };
    if (!isObj(backupPhone)) return out;
    const nowMs = now.getTime();
    const mine = local?.record ?? null;
    const record = mine ? structuredClone(mine) : { v: 1 };
    const images = local?.images ?? new Map();
    let recordChanged = false;

    // ── 聊天预设 ──
    const presets = [...(record.presets ?? [])];
    const presetMap = new Map();   // 备份 id → 本机 id
    const sigToId = new Map();
    for (const p of presets) { const s = chatPresetSig(p); if (s && !sigToId.has(s)) sigToId.set(s, p.id); }
    const localDefault = presets.find(p => p.id === DEFAULT_PRESET_ID) ?? builtinPreset();
    const defaultSig = chatPresetSig(localDefault);
    const takenIds = new Set(presets.map(p => p.id));
    const presetName = makeUniqueNamer(presets.map(p => p.name));
    for (const raw of Array.isArray(backupPhone.presets) ? backupPhone.presets : []) {
        const p = normalizeChatPreset(raw);
        if (!p) { summary.skipped.push('1 个聊天预设（格式不对）'); continue; }
        const sig = chatPresetSig(p);
        if (p.id === DEFAULT_PRESET_ID) {
            // 备份里改过的「默认聊天预设」：和本机现在生效的默认一样 → 就是它；空浏览器（本机没有改过的默认）→ 原样当默认；
            // 不一样 → 作为普通预设加进来，不改本机的默认（改默认会让本机所有用默认的会话一起变）
            if (sig === defaultSig) { presetMap.set(p.id, DEFAULT_PRESET_ID); summary.presetsDup++; continue; }
            if (fresh && !takenIds.has(DEFAULT_PRESET_ID)) {
                presets.push(p); takenIds.add(p.id); sigToId.set(sig, p.id); presetMap.set(p.id, p.id); summary.presetsAdded++; recordChanged = true; continue;
            }
        }
        if (sigToId.has(sig)) { presetMap.set(p.id, sigToId.get(sig)); summary.presetsDup++; continue; }
        let id = newId(); while (takenIds.has(id)) id = newId();
        const want = p.id === DEFAULT_PRESET_ID ? `${DEFAULT_PRESET_NAME}（来自备份）` : p.name;
        const name = presetName(want);
        if (name !== want) summary.renamed.push(`聊天预设「${want}」→「${name}」`);
        presets.push({ ...p, id, name });
        takenIds.add(id); sigToId.set(sig, id); presetMap.set(p.id, id);
        summary.presetsAdded++; recordChanged = true;
    }
    if (presets.length) record.presets = presets;

    // ── 表情 ──
    summary.stickersOmitted = backupPhone.stickersOmitted === true;
    const st = unionStickers(record.stickers ?? [], images, backupPhone.stickers, { newId, now: nowMs });
    Object.assign(summary, { stickersAdded: st.added, stickersDup: st.dup });
    summary.renamed.push(...st.renamed);
    if (st.skipped) summary.skipped.push(`${st.skipped} 个表情（格式不对或表情库满了）`);
    if (st.added) { record.stickers = st.list; out.images.push(...st.newImages); recordChanged = true; }

    // ── 壁纸（设置）──
    if (fresh || applyWallpaper) {
        const slots = wallpaperChanges(backupPhone, { record: mine, images });
        if (slots.length) {
            const wp = { ...(normalizeWallpaper(record.wallpaper) ?? {}) };
            for (const slot of slots) {
                const img = backupImage(backupPhone.wallpaper[slot]);
                const id = newId();
                out.images.push({ ...img, id });
                wp[slot] = id;
                summary.wallpaperApplied.push(slot);
            }
            record.wallpaper = wp;
            recordChanged = true;
        }
    }
    if (recordChanged) {
        out.record = record;
        // 换下来的旧壁纸图：新记录里没人用了就删（和写新记录在同一个事务里）
        const used = usedImageIds(record);
        for (const id of usedImageIds(mine)) if (!used.has(id)) out.dropImages.push(id);
    }

    // ── 会话 ──
    const mapCard = id => cardIdMap.get(id) ?? id;   // 映射不到的原样留着 = 「角色卡已删除」的会话（只能看）
    const localSessions = local?.sessions ?? [];
    const bySig = new Map();   // 签名 → {session, isNew, local}
    for (const s of localSessions) { const k = sessionSig(s); if (!bySig.has(k)) bySig.set(k, { session: s, isNew: false }); }
    const favChanged = new Map();   // 本机会话 id → 并好收藏的新记录
    const sessionIds = new Set(localSessions.map(s => s.id));
    for (const raw of Array.isArray(backupPhone.sessions) ? backupPhone.sessions : []) {
        const s = normalizeSession(raw);
        if (!s) { summary.skipped.push('1 个手机会话（格式不对）'); continue; }
        const sig = sessionSig(s, mapCard);
        const hit = bySig.get(sig);
        if (hit) {
            summary.sessionsDup++;
            if (s.favorites?.length) {
                const base = hit.isNew ? hit.session : (favChanged.get(hit.session.id) ?? hit.session);
                const r = mergeHighlights(base.favorites, s.favorites, phoneDoc(base.messages));
                if (r.changed) {
                    const next = { ...base, favorites: r.list };
                    if (hit.isNew) hit.session.favorites = r.list;
                    else { favChanged.set(base.id, next); summary.favMerged += r.added + r.filled; }
                }
            }
            continue;
        }
        let id = newId(); while (sessionIds.has(id)) id = newId();
        sessionIds.add(id);
        const lastAt = s.messages.length ? s.messages[s.messages.length - 1].at : 0;
        const rec = {
            ...s, id,
            cards: s.cards.map(mapCard),
            personaId: s.personaId ? (personaIdMap.get(s.personaId) ?? null) : null,
            messages: s.messages.map(m => {
                const n = { ...m };
                if (n.from) n.from = mapCard(n.from);
                if (n.sticker && st.idMap.has(n.sticker)) n.sticker = st.idMap.get(n.sticker);
                return n;
            }),
            readAt: lastAt,   // 恢复进来的都算已读
        };
        if (s.presetId) { const p = presetMap.get(s.presetId); if (p && p !== DEFAULT_PRESET_ID) rec.presetId = p; else delete rec.presetId; }
        out.sessions.push(rec);
        bySig.set(sig, { session: rec, isNew: true });
        summary.sessionsAdded++;
    }
    out.favMerges = [...favChanged].map(([id, session]) => ({ id, session }));
    if (out.sessions.length || out.favMerges.length) {
        const merged = localSessions.map(s => favChanged.get(s.id) ?? s);
        out.index = buildPhoneIndex([...merged, ...out.sessions]);
    }
    return out;
}

/** 摘要里手机那几句（没有任何变化 = []） */
export function phoneSummaryBits(s) {
    if (!isObj(s)) return [];
    const bits = [];
    if (s.sessionsAdded) bits.push(`新增 ${s.sessionsAdded} 个手机会话`);
    if (s.sessionsDup) bits.push(`${s.sessionsDup} 个手机会话和这里已有的相同，跳过`);
    if (s.favMerged) bits.push(`${s.favMerged} 条收藏并进了这里已有的手机会话`);
    if (s.presetsAdded) bits.push(`新增 ${s.presetsAdded} 个聊天预设`);
    if (s.stickersAdded) bits.push(`新增 ${s.stickersAdded} 个表情`);
    if (s.stickersDup) bits.push(`${s.stickersDup} 个表情这里已经有了，跳过`);
    if (s.stickersOmitted) bits.push('这份备份没带表情包（导出时取消了勾选），聊天里的表情会显示成文字');
    // 换了壁纸不在这里说：它是设置，summaryText 的「已应用备份里的……」那一句里已经有「手机壁纸」（settingsApplied 的 'phoneWallpaper'）
    return bits;
}
/** 摘要里算不算「带进来了东西」 */
export const phoneAdded = s => isObj(s) && (s.sessionsAdded + s.favMerged + s.presetsAdded + s.stickersAdded + (s.wallpaperApplied?.length ?? 0)) > 0;
