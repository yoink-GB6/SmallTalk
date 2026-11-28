// 手机第一步（单聊、聊天预设、壁纸、表情包）的数据纯逻辑：规范化（读档 / 恢复时的容错）、默认聊天预设、会话目录、
// 气泡的增删改和收藏的联动、表情起名。不碰 DOM / IndexedDB，Node 里可测（test/phone-data.test.mjs）。
// 数据形状和规则见 types.js「手机第一步」一节——这里的每个函数都对应那里的一句话，改规则先改那边。
//
// 约定：
//   - 所有函数都不改输入，返回新对象（界面拿结果交给 phone-store.js 去写）。
//   - 要生成 id、要「现在几点」的函数都从参数拿 newId / now，保持纯函数、测试可重复。
//   - 记录上不认识的字段原样保留（以后的版本加的），只挡 __proto__ / constructor / prototype。
//   - 坏数据不抛错：能修就修，修不了的那一条丢掉（或整条返回 null，由调用方当「坏记录」处理）。

import { textsDoc, storedHighlights, newHighlight, addHighlight, removeHighlight, afterDeleteFloors, afterTruncate, editHighlights, countHighlights } from './highlight.js';
import { pickParams } from './openai-shared.js';
import { makeUniqueNamer } from './migrate.js';
import { alignPersonas } from './personas.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const isNonEmptyStr = v => typeof v === 'string' && v !== '';
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** 把 src 上我们不认识的字段（不在 known 里、也不是危险键）抄到 out 上 */
function keepUnknown(out, src, known) {
    for (const k of Object.keys(src)) if (!known.has(k) && !UNSAFE.has(k)) out[k] = src[k];
    return out;
}

// ═══════════════════════════ 用户定下的取舍 ═══════════════════════════
//
// 2026-11-28 用户回答了 8 个问题。其中会影响这里和 phone-prompt.js / phone-reply.js 行为的几条集中在这张表里，
// 以后要改主意，多半只改这张表（或调用方传的参数），不用动逻辑。另外几条决定写在别处：
//   删卡后会话留着、只能看（phone-store.js sessionCardsMissing）；壁纸两张、算设置（PhoneRecord.wallpaper、phone-backup.js）；
//   手机可以另选模型（PhoneRecord.modelRef、phoneModelRef）；RP 生成中手机照样能发（phone-gen.js 的忙碌标记和 ui.busy 分开）；
//   世界书和 RP 是通的、每次现算（books.js entriesForCard）。
export const PHONE_CHOICES = Object.freeze({
    /** 「重新生成」：'replace' = 删掉最后一批再生成（用户定的）；'append' = 旧的一批留着、新的一批接在后面（没用上，留着便于改主意） */
    regenerate: 'replace',
    /** 外置记忆：false = 第一版不做，只发最近 ChatPreset.history 条（用户定的）。以后要做见 ChatPreset 的 memory 预留字段 */
    memory: false,
    /** 发送方式：'lines' = 输入框里每一行一个气泡（用户定的）；'single' = 整段输入就是一个气泡 */
    sendMode: 'lines',
    /** 表情的描述要不要一起发给模型：false = 只发名字（用户定的） */
    stickerDesc: false,
});

// ═══════════════════════════ 聊天预设 ═══════════════════════════

/** 保留 id：「默认聊天预设」。存下来的 'default' = 改过的默认；没有就是下面的内置常量 */
export const DEFAULT_PRESET_ID = 'default';
export const DEFAULT_PRESET_NAME = '默认聊天预设';

/** 数字字段的范围和默认值（规范化时夹到范围内）。改默认值改这里，DEFAULT_CHAT_PRESET 跟着变 */
export const PRESET_NUMBERS = Object.freeze({
    maxBubbles: Object.freeze({ min: 1, max: 12, def: 5 }),
    // 默认 300 个气泡（用户定的：短消息字很少，40 太短；仍受 contextTokens 约束，超了从最老的丢）
    history: Object.freeze({ min: 0, max: 2000, def: 300 }),
    contextTokens: Object.freeze({ min: 1000, max: 2000000, def: 16000 }),
});

/** 回复没写 max_tokens 时给回复预留多少 token（phone-prompt.js 算上限时用） */
export const DEFAULT_REPLY_TOKENS = 400;

/** 内置默认预设（草稿，暂定；见 types.js ChatPreset 下面的原文）。冻结，不要原地改它 */
export const DEFAULT_CHAT_PRESET = Object.freeze({
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    createdAt: '',
    updatedAt: '',
    system: [
        '你是{{char}}，正在用手机和{{user}}发消息聊天。',
        '',
        '关于{{char}}：',
        '{{description}}',
        '{{personality}}',
        '',
        '{{scenario}}',
        '',
        '关于{{user}}：',
        '{{persona}}',
    ].join('\n'),
    format: '像真人用手机发消息那样回：口语、简短、自然。一次发 1 到 {{maxBubbles}} 条，每条单独占一行。\n'
        + '不写动作、神态、心理描写和旁白，不加引号，不在前面写名字。',
    maxBubbles: PRESET_NUMBERS.maxBubbles.def,
    stickers: true,
    stickerHint: '可以发表情包：单独一行写 [表情:名字]，名字只能从这些里选：{{stickers}}。偶尔发就好，别每次都发。',
    history: PRESET_NUMBERS.history.def,
    contextTokens: PRESET_NUMBERS.contextTokens.def,
    timeHint: true,
    params: Object.freeze({ temperature: 0.9, max_tokens: DEFAULT_REPLY_TOKENS }),
});

// 以后加的字段（现在不做，读到就原样保留——keepUnknown）：
//   memory：手机聊天的外置记忆（用户的想法：复用 RP 那套，改成「每 10 轮对话压一段」，大概 {enabled, every: 10}）；
//   proactive / moments / group：主动消息、朋友圈、拉群
const PRESET_KNOWN = new Set(['id', 'name', 'createdAt', 'updatedAt', 'system', 'format', 'maxBubbles', 'stickers', 'stickerHint', 'history', 'contextTokens', 'timeHint', 'params']);

/** 数字字段：不是有限数 = 默认值；有小数的取整；超范围夹回来 */
function clampInt(v, { min, max, def }) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * 一个聊天预设的规范化（读档、恢复、导入都走）。不是对象 / 没有字符串 id → null（丢掉）。
 * 字符串字段不是字符串 → 默认值；数字夹到范围；开关不是布尔 → 默认值；params 过 pickParams（白名单，和 RP 的采样参数同一份规则）。
 * 存的是完整的一份：缺的字段补齐（所以以后默认值改了，已经存下来的预设不会跟着变——它们是用户「那时候存下的样子」）。
 * @returns {import('./types.js').ChatPreset|null}
 */
export function normalizeChatPreset(p) {
    if (!isObj(p) || !isNonEmptyStr(p.id)) return null;
    const d = DEFAULT_CHAT_PRESET;
    const out = {
        id: p.id,
        name: isStr(p.name) && p.name.trim() ? p.name.trim() : (p.id === DEFAULT_PRESET_ID ? DEFAULT_PRESET_NAME : '未命名聊天预设'),
        createdAt: isStr(p.createdAt) ? p.createdAt : '',
        updatedAt: isStr(p.updatedAt) ? p.updatedAt : '',
        system: isStr(p.system) ? p.system : d.system,
        format: isStr(p.format) ? p.format : d.format,
        maxBubbles: clampInt(p.maxBubbles, PRESET_NUMBERS.maxBubbles),
        stickers: typeof p.stickers === 'boolean' ? p.stickers : d.stickers,
        stickerHint: isStr(p.stickerHint) ? p.stickerHint : d.stickerHint,
        history: clampInt(p.history, PRESET_NUMBERS.history),
        contextTokens: clampInt(p.contextTokens, PRESET_NUMBERS.contextTokens),
        timeHint: typeof p.timeHint === 'boolean' ? p.timeHint : d.timeHint,
        // params 缺了 = 默认那份；给了就以给的为准（用户删掉温度 = 让接口用它自己的默认，这是允许的）
        params: isObj(p.params) ? pickParams(p.params) : { ...d.params },
    };
    return keepUnknown(out, p, PRESET_KNOWN);
}

/**
 * 预设列表的规范化：不是数组 = []；坏的丢掉；id 重复的后一个换新 id（newId 由调用方给）。
 * @param {any} list
 * @param {{newId: () => string}} deps
 */
export function normalizeChatPresets(list, { newId }) {
    if (!Array.isArray(list)) return [];
    const out = [], ids = new Set();
    for (const raw of list) {
        const p = normalizeChatPreset(raw);
        if (!p) continue;
        if (ids.has(p.id)) { let id = newId(); while (ids.has(id)) id = newId(); p.id = id; }
        ids.add(p.id);
        out.push(p);
    }
    return out;
}

/**
 * 一个会话实际用哪份预设（presetId 不写 = 'default'）。
 * 指向的预设不在了 → 用默认，missing = true（界面提示「原来的预设已删除」）。默认：存下来的 'default'，没有就是内置常量的一份拷贝。
 * @param {{presets?: any[]}|null} record   PhoneRecord（规范化过的）
 * @param {string|undefined} presetId
 * @returns {{preset: import('./types.js').ChatPreset, missing: boolean}}
 */
export function resolvePreset(record, presetId) {
    const list = Array.isArray(record?.presets) ? record.presets : [];
    const want = isNonEmptyStr(presetId) ? presetId : DEFAULT_PRESET_ID;
    const hit = list.find(p => p?.id === want);
    if (hit) return { preset: normalizeChatPreset(hit) ?? builtinPreset(), missing: false };
    const def = list.find(p => p?.id === DEFAULT_PRESET_ID);
    return { preset: (def && normalizeChatPreset(def)) || builtinPreset(), missing: want !== DEFAULT_PRESET_ID };
}

/** 内置默认的一份可以改的拷贝（params 也拷一份） */
export const builtinPreset = () => ({ ...DEFAULT_CHAT_PRESET, params: { ...DEFAULT_CHAT_PRESET.params } });

// ═══════════════════════════ 表情库、图片 ═══════════════════════════

export const STICKER_NAME_MAX = 40;
export const STICKER_DESC_MAX = 200;
export const MAX_STICKERS = 500;
/** 表情上传时的尺寸规则：静态图长边超过 512 缩到 512 存 PNG（留透明）；动图（GIF、动态 WebP）原样；原样存的超过 1 MB 拒收 */
export const STICKER_MAX_SIDE = 512;
export const STICKER_MAX_BYTES = 1024 * 1024;
/** 壁纸：静态图长边超过 2048 缩到 2048、存 JPEG（质量 0.85）；动图（GIF、动态 WebP）原样存、超过 5 MB 拒收（用户定的：壁纸可以是动图） */
export const WALLPAPER_MAX_SIDE = 2048;
export const WALLPAPER_JPEG_QUALITY = 0.85;
export const WALLPAPER_ANIMATED_MAX_BYTES = 5 * 1024 * 1024;
/** 静态图原样存时的上限（没超过尺寸、不用缩的那种）：防止一张几十 MB 的 PNG 原样进库、进备份 */
export const WALLPAPER_STATIC_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 这张图是不是动图（看文件头，不靠扩展名）。
 *   GIF：一律当动图处理——单帧 GIF 也原样存，体积本来就小；要分辨单帧多帧得把整个文件解析一遍，不值得。
 *   WebP：RIFF....WEBP，第一个块是 VP8X 且标志字节里有「动画」位（0x02），或者文件里有 ANIM 块。
 *   别的（PNG、JPEG……）：不是。APNG（动的 PNG）不认：浏览器缩放时只取第一帧，和静态 PNG 一样处理（不常见，代价是它会变成不动的）。
 * @param {Uint8Array} bytes
 */
export function isAnimatedImage(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12) return false;
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (ascii(0, 4) === 'GIF8') return true;
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return false;
    if (bytes.length >= 21 && ascii(12, 4) === 'VP8X' && (bytes[20] & 0x02)) return true;
    // 兜底：在前 64 KB 里找 ANIM 块（VP8X 标志写错的文件）
    const end = Math.min(bytes.length - 4, 65536);
    for (let i = 12; i < end; i++) if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x49 && bytes[i + 3] === 0x4d) return true;
    return false;
}

/**
 * 上传一张图要怎么处理（纯函数：界面先读出字节、量出宽高，按这里的结论去缩放 / 原样存 / 拒收）。
 *   kind 'sticker'：动图原样（超过 1 MB 拒收）；静态图长边 ≤ 512 原样（超过 1 MB 拒收），超过就缩到 512、存 PNG。
 *   kind 'wallpaper'：动图原样（超过 5 MB 拒收）；静态图长边 ≤ 2048 原样（超过 8 MB 拒收），超过就缩到 2048、存 JPEG。
 *   不认识的类型（不是 png / jpeg / webp / gif，比如视频、SVG）拒收。
 * @param {{kind: 'sticker'|'wallpaper', type: string, bytes: number, w: number, h: number, animated: boolean}} f   type 是文件的 MIME，bytes 是字节数
 * @returns {{action: 'keep'} | {action: 'resize', w: number, h: number, type: 'image/png'|'image/jpeg', quality?: number} | {action: 'reject', reason: string}}
 */
export function imagePlan({ kind, type, bytes, w, h, animated }) {
    if (!IMAGE_TYPES.includes(type)) return { action: 'reject', reason: '只能用 PNG、JPEG、WebP、GIF 图片' };
    const sticker = kind === 'sticker';
    const mb = n => `${Math.round(n / 1024 / 1024 * 10) / 10} MB`;
    if (animated) {
        const cap = sticker ? STICKER_MAX_BYTES : WALLPAPER_ANIMATED_MAX_BYTES;
        return bytes > cap ? { action: 'reject', reason: `动图太大了（${mb(bytes)}），${sticker ? '表情' : '动图壁纸'}最多 ${mb(cap)}` } : { action: 'keep' };
    }
    const side = sticker ? STICKER_MAX_SIDE : WALLPAPER_MAX_SIDE;
    const long = Math.max(w || 0, h || 0);
    if (long > side) {
        const s = side / long;
        return { action: 'resize', w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)),
            ...(sticker ? { type: 'image/png' } : { type: 'image/jpeg', quality: WALLPAPER_JPEG_QUALITY }) };
    }
    const cap = sticker ? STICKER_MAX_BYTES : WALLPAPER_STATIC_MAX_BYTES;
    return bytes > cap ? { action: 'reject', reason: `图片太大了（${mb(bytes)}），最多 ${mb(cap)}` } : { action: 'keep' };
}

// 换行类字符（含 U+0085、U+2028、U+2029）。用 fromCharCode 拼，源码里不直接写看不见的字符（同 personas.js）
const LINE_BREAKS = new RegExp(`[\\r\\n\\v\\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+`, 'g');

/**
 * 表情名的规范化：去首尾空白、压成一行、去掉 [ ] : ：（它们是 [表情:名字] 标记本身的符号，留着会让模型写出来的标记切不开）、
 * 连续空白压成一个空格、最长 STICKER_NAME_MAX 字（按码点，emoji 不切开）。返回 '' = 不能用。
 */
export function cleanStickerName(v) {
    if (!isStr(v)) return '';
    const t = v.replace(LINE_BREAKS, ' ').replace(/[[\]:：]/g, '').replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, STICKER_NAME_MAX).join('').trim();
}

/** 描述：去首尾空白、压成一行、最长 STICKER_DESC_MAX 字；空 = undefined（不写这个键） */
export function cleanStickerDesc(v) {
    if (!isStr(v)) return undefined;
    const t = v.replace(LINE_BREAKS, ' ').trim();
    return t ? Array.from(t).slice(0, STICKER_DESC_MAX).join('') : undefined;
}

const STICKER_KNOWN = new Set(['id', 'name', 'desc', 'at']);

/**
 * 表情目录的规范化：不是数组 = []；不是对象、没有 id、名字规范化后空了 → 丢掉；id 重复的只留第一个；
 * 名字重复的后一个加「 (2)」（读档时只可能是手改的数据，宁可改名也不丢图）；最多 MAX_STICKERS 个。
 * @returns {import('./types.js').PhoneStickerMeta[]}
 */
export function normalizeStickers(list) {
    if (!Array.isArray(list)) return [];
    const out = [], ids = new Set();
    const nameFor = makeUniqueNamer([]);
    for (const s of list) {
        if (out.length >= MAX_STICKERS) break;
        if (!isObj(s) || !isNonEmptyStr(s.id) || ids.has(s.id)) continue;
        const name = cleanStickerName(s.name);
        if (!name) continue;
        ids.add(s.id);
        const e = { id: s.id, name: nameFor(name) };
        const desc = cleanStickerDesc(s.desc);
        if (desc !== undefined) e.desc = desc;
        e.at = typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0;
        out.push(keepUnknown(e, s, STICKER_KNOWN));
    }
    return out;
}

/**
 * 按名字找表情：先完全相同，再「去空白、不分大小写」相同（模型常把名字写得多个空格、换个大小写）。找不到 = null。
 * phone-reply.js 切气泡、界面显示「没有 id 的表情气泡」都用它，规则只有这一份。
 * @param {{id: string, name: string}[]} stickers
 * @param {string} name
 */
export function findSticker(stickers, name) {
    if (!Array.isArray(stickers) || !isStr(name)) return null;
    const exact = stickers.find(s => s?.name === name);
    if (exact) return exact;
    const loose = x => String(x).replace(/\s+/g, '').toLowerCase();
    const want = loose(name);
    if (!want) return null;
    return stickers.find(s => isStr(s?.name) && loose(s.name) === want) ?? null;
}

/**
 * 上传一个表情（界面：图片已经处理好、写进 'phoneimg:<id>' 之前先调它拿到新目录）。
 * 名字撞了【拒绝】（用户自己起的名字，悄悄改成「 (2)」会让他以为是原来那个）；导入 / 恢复时撞名才加序号（uniqueStickerName）。
 * @returns {{list: import('./types.js').PhoneStickerMeta[], sticker?: import('./types.js').PhoneStickerMeta, error?: string}}
 */
export function addSticker(list, { id, name, desc, at }) {
    const cur = Array.isArray(list) ? list : [];
    const n = cleanStickerName(name);
    if (!n) return { list: cur, error: '表情要有个名字（不能只有符号）' };
    if (cur.length >= MAX_STICKERS) return { list: cur, error: `表情库最多 ${MAX_STICKERS} 个` };
    if (cur.some(s => s.name === n)) return { list: cur, error: `已经有一个叫「${n}」的表情了` };
    const s = { id, name: n };
    const d = cleanStickerDesc(desc);
    if (d !== undefined) s.desc = d;
    s.at = typeof at === 'number' ? at : 0;
    return { list: [...cur, s], sticker: s };
}

/** 改名（撞名拒绝）。id 不存在：原样返回、带 error */
export function renameSticker(list, id, name) {
    const cur = Array.isArray(list) ? list : [];
    const i = cur.findIndex(s => s.id === id);
    if (i < 0) return { list: cur, error: '没有这个表情' };
    const n = cleanStickerName(name);
    if (!n) return { list: cur, error: '表情要有个名字（不能只有符号）' };
    if (cur.some((s, k) => k !== i && s.name === n)) return { list: cur, error: `已经有一个叫「${n}」的表情了` };
    const out = [...cur];
    out[i] = { ...cur[i], name: n };
    return { list: out };
}

/** 改描述（空 = 去掉） */
export function setStickerDesc(list, id, desc) {
    const d = cleanStickerDesc(desc);
    return (Array.isArray(list) ? list : []).map(s => {
        if (s.id !== id) return s;
        const { desc: _old, ...rest } = s;
        return d === undefined ? rest : { ...rest, desc: d };
    });
}

/** 删一个（界面在同一个事务里把 'phoneimg:<id>' 也删掉） */
export const removeSticker = (list, id) => (Array.isArray(list) ? list.filter(s => s.id !== id) : []);

/** 导入 / 恢复时起名：撞了加「 (2)」「 (3)」（和 RP 预设、世界书同一个起名函数）。返回一个起名函数，每起一个记进「已用」 */
export const stickerNamer = list => makeUniqueNamer((Array.isArray(list) ? list : []).map(s => s?.name).filter(isStr));

/** 认的图片类型（data URL 的 MIME） */
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 一张图（'phoneimg:<id>'）的规范化：不是对象、没有 id、dataUrl 不是这四种图片的 base64 data URL → null（坏图）。
 * w / h 不是正整数就去掉。
 * @returns {import('./types.js').PhoneImage|null}
 */
export function normalizeImage(v) {
    if (!isObj(v) || !isNonEmptyStr(v.id) || !isStr(v.dataUrl) || !DATA_URL.test(v.dataUrl)) return null;
    const out = { id: v.id, dataUrl: v.dataUrl };
    for (const k of ['w', 'h']) if (Number.isInteger(v[k]) && v[k] > 0) out[k] = v[k];
    return keepUnknown(out, v, new Set(['id', 'dataUrl', 'w', 'h']));
}

/** data URL 解码后大约多少字节（不真解码；界面显示「约 X MB」、检查 1 MB 上限用） */
export function dataUrlBytes(dataUrl) {
    if (!isStr(dataUrl)) return 0;
    const i = dataUrl.indexOf(',');
    const b64 = i < 0 ? '' : dataUrl.slice(i + 1);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}

// ═══════════════════════════ 'phone' 记录 ═══════════════════════════

const RECORD_KNOWN = new Set(['v', 'presets', 'stickers', 'wallpaper', 'modelRef', 'lastPresetId']);

/**
 * 'phone' 记录的规范化。不是对象 = null（还没有这条记录）。可选字段规范化后是空的就不写（没用过某个功能的人记录上没有那个键）。
 * v 不是 1 也照 1 读（契约：以后要整体换形状时才用它，现在不报错）。
 * @param {any} v
 * @param {{newId: () => string}} deps
 * @returns {import('./types.js').PhoneRecord|null}
 */
export function normalizePhoneRecord(v, { newId }) {
    if (!isObj(v)) return null;
    const out = { v: 1 };
    const presets = normalizeChatPresets(v.presets, { newId });
    if (presets.length) out.presets = presets;
    const stickers = normalizeStickers(v.stickers);
    if (stickers.length) out.stickers = stickers;
    const wp = normalizeWallpaper(v.wallpaper);
    if (wp) out.wallpaper = wp;
    if (isObj(v.modelRef) && isStr(v.modelRef.endpoint) && isStr(v.modelRef.model)) out.modelRef = { endpoint: v.modelRef.endpoint, model: v.modelRef.model };
    if (isNonEmptyStr(v.lastPresetId)) out.lastPresetId = v.lastPresetId;
    return keepUnknown(out, v, RECORD_KNOWN);
}

/** 壁纸的两个位置（用户定的：锁屏一张、桌面一张，各自可以没有 = 用主题自带的 CSS 壁纸） */
export const WALLPAPER_SLOTS = Object.freeze(['lock', 'home']);

/**
 * PhoneRecord.wallpaper 的规范化：{lock?: 图片 id, home?: 图片 id}，两个都没有 = null（不写这个键）。
 * 契约草案里的旧形状 {image}（只有一张）读到时当成两个位置共用这一张——那一版没有真正落过盘，这只是容错。
 */
export function normalizeWallpaper(w) {
    if (!isObj(w)) return null;
    const out = {};
    for (const slot of WALLPAPER_SLOTS) if (isNonEmptyStr(w[slot])) out[slot] = w[slot];
    if (!Object.keys(out).length && isNonEmptyStr(w.image)) { out.lock = w.image; out.home = w.image; }
    return Object.keys(out).length ? out : null;
}

/**
 * 'phone' 记录里有没有「内容或设置」（聊天预设、表情、壁纸）。整体备份的「空浏览器」判定用：
 * 只有当前选择（modelRef、lastPresetId）的记录不算有数据（和 global 里「选了哪个模型不算用户内容」一个道理）。
 */
export const phoneRecordHasContent = rec => isObj(rec)
    && ((Array.isArray(rec.presets) && rec.presets.length > 0) || (Array.isArray(rec.stickers) && rec.stickers.length > 0) || !!normalizeWallpaper(rec.wallpaper));

/** 被表情目录或壁纸指着的图片 id */
export function usedImageIds(rec) {
    const wp = normalizeWallpaper(rec?.wallpaper) ?? {};
    return new Set([...(Array.isArray(rec?.stickers) ? rec.stickers : []).map(s => s?.id).filter(isNonEmptyStr), ...WALLPAPER_SLOTS.map(s => wp[s]).filter(Boolean)]);
}

/**
 * 孤儿图：'phoneimg:*' 里没有被表情目录或壁纸指着的 id。
 * 【不自动删】（B 阶段定的）：所有写入都是一个事务里同时写目录和图片，正常不会出现孤儿；真出现了多半是记录读坏了，这时删图就是丢数据。
 * 只给界面 / 以后的「清理」按钮用。
 */
export function orphanImageIds(rec, imageIds) {
    const used = usedImageIds(rec);
    return [...imageIds].filter(id => !used.has(id));
}

/**
 * 手机聊天用哪个「接口 + 模型」（用户定的：可以另选；默认跟 RP 的 state.chatModel）。
 * PhoneRecord.modelRef 是当前选择：存在这台设备的 'phone' 记录里、不进备份。
 */
export const phoneModelRef = (rec, chatModel) => (isObj(rec?.modelRef) ? rec.modelRef : chatModel);

// ═══════════════════════════ 消息（气泡） ═══════════════════════════

export const ROLES = Object.freeze(['user', 'assistant', 'system']);
const MESSAGE_KNOWN = new Set(['id', 'role', 'content', 'at', 'gen', 'sticker', 'from']);

/** 一个表情气泡的原文：「[表情:名字]」（发给模型的也是这个样子） */
export const stickerToken = name => `[表情:${name}]`;

/**
 * 消息列表的规范化（normalizeSession 调它）：
 *   不是对象 / content 不是字符串 / role 认不出 → 丢掉；id 缺或重复 → 补确定的 'm-<下标>'（再撞加后缀，同样的输入永远同样的输出）；
 *   at 不是有限数 → 前一条的 at（第一条 → 0）；gen / sticker / from 不是非空字符串 → 删掉。不认识的字段原样保留。
 * @returns {import('./types.js').PhoneMessage[]}
 */
export function normalizeMessages(list) {
    if (!Array.isArray(list)) return [];
    const out = [], ids = new Set();
    let prevAt = 0;
    list.forEach((m, k) => {
        if (!isObj(m) || !isStr(m.content) || !ROLES.includes(m.role)) return;
        let id = isNonEmptyStr(m.id) && !ids.has(m.id) ? m.id : '';
        if (!id) { id = `m-${k}`; let n = 2; while (ids.has(id)) id = `m-${k}-${n++}`; }
        ids.add(id);
        const at = typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : prevAt;
        prevAt = at;
        const e = { id, role: m.role, content: m.content, at };
        for (const k2 of ['gen', 'sticker', 'from']) if (isNonEmptyStr(m[k2])) e[k2] = m[k2];
        out.push(keepUnknown(e, m, MESSAGE_KNOWN));
    });
    return out;
}

/** 收藏用的 HighlightDoc：一个气泡一段、只有版本 0（手机没有候选）。content 不是字符串的当 ''（textsDoc 对非字符串返回 null） */
export const phoneDoc = messages => textsDoc((Array.isArray(messages) ? messages : []).map(m => (isStr(m?.content) ? m.content : '')));

// ═══════════════════════════ 会话 ═══════════════════════════

// worlds：契约草案里会话自己勾的世界书。用户定了「世界书和 RP 是通的、每次现算」（books.js entriesForCard），这个字段不再用：
// 读到旧的丢掉（放进 KNOWN 里就不会被 keepUnknown 原样抄过去）
const SESSION_KNOWN = new Set(['id', 'cards', 'personaId', 'presetId', 'worlds', 'title', 'createdAt', 'updatedAt', 'readAt', 'messages', 'favorites', 'pinned']);
const lastAt = msgs => (msgs.length ? msgs[msgs.length - 1].at : 0);

/**
 * 一个会话的规范化（读档、恢复都走）。不是对象 / 没有 id → null（坏记录：列表里不出现，记录不删）。
 * 逐个字段的规则见 types.js PhoneSession 下面的「规范化」。
 * @returns {import('./types.js').PhoneSession|null}
 */
export function normalizeSession(s) {
    if (!isObj(s) || !isNonEmptyStr(s.id)) return null;
    const cards = [...new Set(Array.isArray(s.cards) ? s.cards.filter(isNonEmptyStr) : [])];
    const messages = normalizeMessages(s.messages);
    const out = {
        id: s.id,
        cards,
        personaId: isStr(s.personaId) && s.personaId ? s.personaId : null,
    };
    if (isNonEmptyStr(s.presetId) && s.presetId !== DEFAULT_PRESET_ID) out.presetId = s.presetId;
    if (isNonEmptyStr(s.title)) out.title = s.title;
    out.createdAt = isStr(s.createdAt) ? s.createdAt : '';
    out.updatedAt = isStr(s.updatedAt) ? s.updatedAt : out.createdAt;
    // readAt 坏了 → 全算已读（宁可少一个红点，也不要一屏假未读）
    out.readAt = typeof s.readAt === 'number' && Number.isFinite(s.readAt) ? s.readAt : lastAt(messages);
    out.messages = messages;
    const fav = storedHighlights(s.favorites, phoneDoc(messages));
    // 收藏只认整条（whole）：手机里没有「划一段」的入口，读到的半段划线当坏数据丢掉
    const whole = fav ? fav.filter(h => h.whole === true) : [];
    if (whole.length) out.favorites = whole;
    if (s.pinned === true) out.pinned = true;
    return keepUnknown(out, s, SESSION_KNOWN);
}

/**
 * 新建一个会话。presetId 是默认就不写。世界书不用选：每次生成时按这张卡在 RP 里现在生效的现算。
 * @param {{id: string, cardId: string, personaId?: string|null, presetId?: string, now: Date}} spec
 */
export function newSession({ id, cardId, personaId = null, presetId, now }) {
    const iso = now.toISOString();
    const s = { id, cards: [cardId], personaId: personaId || null };
    if (isNonEmptyStr(presetId) && presetId !== DEFAULT_PRESET_ID) s.presetId = presetId;
    Object.assign(s, { createdAt: iso, updatedAt: iso, readAt: now.getTime(), messages: [] });
    return s;
}

/**
 * 会话引用的卡里有哪些已经不在了（删卡后会话留着、只能看——用户定的）。不落盘，每次按「现在有哪些卡」现算。
 * 一张都不缺 = []；cards 是空的（坏数据）也算缺（返回 ['']），同样只能看。
 * @param {{cards: string[]}} session
 * @param {Set<string>} cardIds   现在存储里有的卡 id
 */
export function sessionCardsMissing(session, cardIds) {
    const cards = Array.isArray(session?.cards) ? session.cards : [];
    if (!cards.length) return [''];
    return cards.filter(id => !cardIds.has(id));
}

/**
 * 会话用哪个人设（personaId null = 跟随当前人设）。指向的不在了 → 当前人设、missing = true（不改记录，界面提示一句）。
 * @param {{persona?: any, personas?: any[], activePersonaId?: string}} globalLike   GlobalRecord 里和人设有关的三个字段
 * @returns {{persona: {name: string, description: string}, missing: boolean}}
 */
export function resolvePersona(globalLike, personaId) {
    const a = alignPersonas(globalLike);
    const pick = p => ({ name: p.name, description: p.description });
    if (!personaId) return { persona: pick(a.persona), missing: false };
    const hit = a.personas?.find(p => p.id === personaId);
    return hit ? { persona: pick(hit), missing: false } : { persona: pick(a.persona), missing: true };
}

/** 未读条数：assistant 的气泡里 at > readAt 的 */
export const unreadCount = s => (Array.isArray(s?.messages) ? s.messages.filter(m => m.role === 'assistant' && m.at > (s.readAt ?? 0)).length : 0);

/** 标已读：readAt 设成最后一条的 at（已经是了就返回原对象，调用方据此决定不写） */
export function markRead(s) {
    const at = lastAt(s.messages ?? []);
    return s.readAt >= at ? s : { ...s, readAt: at };
}

// ═══════════════════════════ 会话目录 'phoneindex' ═══════════════════════════

export const PREVIEW_MAX = 40;

/** 列表上那一行的预览：表情气泡 = 「[表情]」；其余压成一行、最多 PREVIEW_MAX 字（按码点） */
export function previewOf(m) {
    if (!m) return '';
    if (m.sticker || /^\[表情[:：][^\]]*\]$/.test(m.content)) return '[表情]';
    const flat = String(m.content).replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > PREVIEW_MAX ? chars.slice(0, PREVIEW_MAX).join('') + '…' : flat;
}

/**
 * 一个会话在目录里的条目（types.js PhoneIndexEntry）。fav、title、pinned 有才写。
 * 预览和 lastAt 看最后一条【不是 system】的气泡（system 是灰色提示行，不当「最后一句话」）。
 */
export function sessionIndexEntry(s) {
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    const last = [...msgs].reverse().find(m => m.role !== 'system');
    const e = { cards: [...(s.cards ?? [])] };
    if (s.title) e.title = s.title;
    Object.assign(e, { updatedAt: s.updatedAt ?? '', count: msgs.length, last: previewOf(last), lastAt: last ? last.at : 0, unread: unreadCount(s) });
    const fav = countHighlights(s.favorites);
    if (fav) e.fav = fav;
    if (s.pinned === true) e.pinned = true;
    // 用的是哪个聊天预设（不是默认时才写）：删预设时数「有几个会话在用它」不用把会话整条读出来
    if (s.presetId) e.presetId = s.presetId;
    return e;
}

/** 从全部会话记录重建目录（坏记录跳过） */
export function buildPhoneIndex(sessions) {
    const out = { sessions: {} };
    for (const raw of Array.isArray(sessions) ? sessions : []) {
        const s = normalizeSession(raw);
        if (s) out.sessions[s.id] = sessionIndexEntry(s);
    }
    return out;
}

/**
 * 目录还能不能用：形状对、而且和存储里的会话 id 一一对应（多了少了都要重建）。
 * @param {any} index
 * @param {Iterable<string>} sessionIds   存储里 'phonechat:*' 的 id
 */
export function phoneIndexValid(index, sessionIds) {
    if (!isObj(index) || !isObj(index.sessions)) return false;
    const have = new Set(Object.keys(index.sessions));
    const want = new Set(sessionIds);
    if (have.size !== want.size) return false;
    for (const id of want) if (!have.has(id) || !isObj(index.sessions[id])) return false;
    return true;
}

/** 会话列表的排序：置顶的在前，然后按最后一条的时间（新的在前），一样时按 id（稳定） */
export function sortIndex(index) {
    return Object.entries(index?.sessions ?? {}).sort(([ia, a], [ib, b]) =>
        (b.pinned === true) - (a.pinned === true) || (b.lastAt ?? 0) - (a.lastAt ?? 0) || (ia < ib ? -1 : ia > ib ? 1 : 0));
}

// ═══════════════════════════ 发送、编辑、删除、重新生成、收藏 ═══════════════════════════
// 都返回新的会话对象；会改消息的那几个同时把收藏挪好（收藏只记楼号，见 types.js「收藏」）。
// updatedAt 只在消息变了时更新（参数 now）。

/**
 * 输入框里的文字 → 几个用户气泡的原文（PHONE_CHOICES.sendMode）：
 *   'lines'  每行一个，去首尾空白，空行丢掉——和模型「一行一条」对称；
 *   'single' 整段一个（去首尾空白），换行留在气泡里。
 * 空输入 → []（界面据此走「不加气泡、直接让 TA 接着说」）。
 */
export function splitInput(text, { mode = PHONE_CHOICES.sendMode } = {}) {
    const t = isStr(text) ? text : '';
    if (mode === 'single') return t.trim() ? [t.trim()] : [];
    return t.split(/\r\n|\r|\n|\u2028|\u2029/).map(x => x.trim()).filter(Boolean);
}

/**
 * 造一批气泡（用户发的、或 splitReply 切出来的）。at 从 now 起每条 +1 毫秒，保证同一批里严格递增（排序稳定、主动消息往回填时也不会撞）。
 * @param {'user'|'assistant'} role
 * @param {{content: string, sticker?: string}[]} parts
 * @param {{newId: () => string, now: number, gen?: string, from?: string}} deps   gen 只给 assistant 的
 * @returns {import('./types.js').PhoneMessage[]}
 */
export function makeBubbles(role, parts, { newId, now, gen, from }) {
    return parts.map((p, i) => {
        const m = { id: newId(), role, content: p.content, at: now + i };
        if (role === 'assistant' && gen) m.gen = gen;
        if (p.sticker) m.sticker = p.sticker;
        if (from) m.from = from;
        return m;
    });
}

/** 用户从表情面板发一个表情的气泡内容 */
export const stickerPart = sticker => ({ content: stickerToken(sticker.name), sticker: sticker.id });

/** 接一批气泡到会话末尾（发送、收到回复）。messages 里的 id 撞了换新的（极少见：别的地方生成的 id） */
export function appendMessages(session, msgs, { now, newId }) {
    if (!msgs.length) return session;
    const ids = new Set(session.messages.map(m => m.id));
    const add = msgs.map(m => { if (!ids.has(m.id)) { ids.add(m.id); return m; } let id = newId(); while (ids.has(id)) id = newId(); ids.add(id); return { ...m, id }; });
    return { ...session, messages: [...session.messages, ...add], updatedAt: now.toISOString() };
}

/**
 * 编辑第 i 个气泡。表情气泡改了文字就不再是表情（删掉 sticker）。收藏不动（整条收藏编辑后不删不移）。
 * 内容没变 → changed = false（不写、不动 updatedAt）。
 */
export function editMessage(session, i, content, { now }) {
    const m = session.messages[i];
    if (!m || !isStr(content) || m.content === content) return { session, changed: false };
    const { sticker: _s, ...rest } = m;
    const next = [...session.messages];
    next[i] = { ...rest, content };
    return { session: { ...session, messages: next, updatedAt: now.toISOString() }, changed: true };
}

/** 收藏列表换成 list；空了删键 */
function withFavorites(s, list) {
    const { favorites: _old, ...rest } = s;
    return list && list.length ? { ...rest, favorites: list } : rest;
}

/** 删掉一组气泡（任意下标），收藏按 afterDeleteFloors 挪（删掉的气泡上的收藏静默跟着没） */
export function deleteMessages(session, indexes, { now }) {
    const drop = new Set([...indexes].filter(i => Number.isInteger(i) && i >= 0 && i < session.messages.length));
    if (!drop.size) return { session, changed: false };
    const fav = afterDeleteFloors(session.favorites ?? [], drop);
    const s = { ...session, messages: session.messages.filter((_, i) => !drop.has(i)), updatedAt: now.toISOString() };
    return { session: withFavorites(s, fav.list), changed: true };
}

/** 单删第 i 个 */
export const deleteMessage = (session, i, deps) => deleteMessages(session, [i], deps);

/** 「从这条往后全删」 */
export function truncateFrom(session, i, { now }) {
    if (!Number.isInteger(i) || i < 0 || i >= session.messages.length) return { session, changed: false };
    const fav = afterTruncate(session.favorites ?? [], i);
    const s = { ...session, messages: session.messages.slice(0, i), updatedAt: now.toISOString() };
    return { session: withFavorites(s, fav.list), changed: true };
}

/**
 * 最后一批 assistant 气泡的下标：从末尾往前，和最后一条同一个 gen 的连续那几条。
 * 最后一条不是 assistant → []。最后一条没有 gen（老数据 / 手改的）→ 只算它自己。
 */
export function lastBatch(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const last = list[list.length - 1];
    if (!last || last.role !== 'assistant') return [];
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.role !== 'assistant' || (last.gen ? m.gen !== last.gen : i !== list.length - 1)) break;
        out.unshift(i);
    }
    return out;
}

/**
 * 「重新生成」之前要对会话做什么（PHONE_CHOICES.regenerate）：
 *   'replace' 删掉最后一批（收藏跟着没），再拿剩下的去生成；
 *   'append'  什么都不删，新的一批接在后面（旧回复留着）。
 * 最后一条是用户气泡（或会话是空的）：两种都不删，直接生成。
 * @returns {{session: import('./types.js').PhoneSession, removed: number[]}}   removed：删掉的下标（删之前的编号）
 */
export function planRegenerate(session, { now, mode = PHONE_CHOICES.regenerate }) {
    const batch = lastBatch(session.messages);
    if (mode !== 'replace' || !batch.length) return { session, removed: [] };
    return { session: deleteMessages(session, batch, { now }).session, removed: batch };
}

/** 第 i 个气泡上的收藏（没有 = null） */
export const favoriteAt = (session, i) => (session.favorites ?? []).find(h => h.whole === true && h.from.floor === i) ?? null;

/**
 * 收藏 / 取消收藏第 i 个气泡（同一个气泡再点一次 = 取消）。不改 updatedAt（收藏不算「消息变了」）。
 * @returns {{session, on: boolean}}   on：这次之后是不是收藏着
 */
export function toggleFavorite(session, i, { newId, now }) {
    const had = favoriteAt(session, i);
    if (had) return { session: withFavorites(session, removeHighlight(session.favorites, had.id)), on: false };
    const h = newHighlight({ from: { floor: i, swipe: 0, offset: 0 }, whole: true }, phoneDoc(session.messages), { newId, now });
    if (!h) return { session, on: false };
    return { session: withFavorites(session, addHighlight(session.favorites ?? [], h)), on: true };
}

/**
 * 一次删 / 改备注一组收藏（摘抄页、手机里长按都走它；规则同 highlight.js editHighlights）。
 * @param {{remove?: string[], notes?: Object<string, string>}} edit
 */
export function editFavorites(session, edit) {
    const r = editHighlights(session.favorites ?? [], edit);
    return { session: r.changed ? withFavorites(session, r.list) : session, changed: r.changed, removed: r.removed, noted: r.noted };
}
