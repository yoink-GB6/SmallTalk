// 认酒馆（SillyTavern 1.19.0）整体备份 zip 的目录结构。纯函数，不碰存储、页面和 zip 解压（解压是 zip.js 的事）。
//
// 酒馆备份是什么：src/users.js createBackupArchive —— 整个用户目录 `**/*`（含点文件）打成 zip，
// 顶层没有外层文件夹；默认不含 secrets.json。我们只关心其中几个目录：
//   characters/<文件名>.png|.json     角色卡（PNG 里内嵌卡数据）
//   chats/<卡文件名去掉扩展名>/*.jsonl  聊天。目录名是卡的【文件名】，不是卡里的 name 字段
//                                      （src/endpoints/chats.js：avatar_url.replace('.png', '')）
//   worlds/<名>.json                  世界书（文件名就是书名）
//   OpenAI Settings/<预设名>.json      对话补全预设
//   settings.json                     设置；我们只从里面挑人设 / 全局正则 / 当前预设名
// 其余（backups/ thumbnails/ extensions/ vectors/ group chats/ User Avatars/ ……）一律忽略，只汇总数量和大小。
//
// settings.json 里字段的位置（已在酒馆源码里核对）：
//   顶层 username / user_avatar            public/script.js saveSettings（约 8073–8076 行）
//   power_user.personas                    {头像文件名: 显示名}   public/scripts/personas.js（约 522 行写入）
//   power_user.persona_descriptions        {头像文件名: {description, title, connections, ...}}（同上约 523 行）
//   extension_settings.regex               全局正则脚本数组   public/scripts/extensions/regex/engine.js（约 113、144 行）
//   oai_settings.preset_settings_openai    当前预设名         public/scripts/openai.js（约 412、4614 行）
//   world_info_settings.world_info.globalSelect   全局选中的世界书（书名数组）
//                                          public/script.js saveSettings 写 world_info_settings: getWorldInfoSettings()（约 8080 行）；
//                                          public/scripts/world-info.js getWorldInfoSettings（约 795 行）返回 {world_info, ...}，
//                                          保存前 Object.assign(world_info, { globalSelect: selected_world_info })（约 85 行）；
//                                          读回时 setWorldInfoSettings(settings.world_info_settings ?? settings, …)（script.js 约 8013 行）
//                                          → settings.world_info?.globalSelect（world-info.js 约 998 行）。很老的设置文件没有 world_info_settings 这一层，
//                                          world_info 直接在顶层，所以照酒馆的写法「有 world_info_settings 用它，没有就用顶层」。
// 这几个都在 settings.json 的顶层对象下（power_user / extension_settings / oai_settings / world_info_settings）。
// 角色卡绑定的世界书不在 settings.json 里，在卡自己的 data.extensions.world（书名字符串；world-info.js getCharacterLore 约 4481 行），
// 由 tavern-convert.js 在读卡之后处理。

import { safeEntryPath } from './zip.js';
import { safeFileName } from './card-export.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ───────────────────────────── 分类 ─────────────────────────────

const TAVERN_DIRS = new Set(['characters', 'chats', 'worlds', 'OpenAI Settings']);

/** 一组路径（已拆段）看起来像不像酒馆用户目录的根 */
function looksLikeTavernRoot(segLists) {
    return segLists.some(s => (s.length === 1 && s[0] === 'settings.json') || (s.length > 1 && TAVERN_DIRS.has(s[0])));
}

const extOf = name => { const m = /\.([^./]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };
const stripExt = name => name.replace(/\.[^./]+$/, '');

/**
 * @typedef {Object} TavernClassified
 * @property {boolean} isTavern            看起来是酒馆备份
 * @property {string}  strippedPrefix      自动剥掉的外层文件夹名（没剥则为 ''）
 * @property {{fileName: string, baseName: string, entry: object}[]} cards      characters/ 下的 .png / .json
 * @property {{dir: string, files: {fileName: string, entry: object}[]}[]} chatGroups   chats/<dir>/*.jsonl，按 dir 分组
 * @property {{name: string, fileName: string, entry: object}[]} worlds        name = 去掉 .json 的书名
 * @property {{name: string, fileName: string, entry: object}[]} presets
 * @property {object|null} settings        settings.json 的条目
 * @property {{total: {count: number, bytes: number}, byTop: {name: string, count: number, bytes: number}[]}} ignored
 */

/**
 * 把 openZip 给的条目分类。
 * @param {{name: string, path?: string|null, isDirectory?: boolean, size?: number}[]} entries
 * @returns {TavernClassified}
 */
export function classifyTavernEntries(entries) {
    // 1. 整理：目录条目不算内容（只用来判断有没有 characters/）；名字不安全的直接归入忽略
    const files = [];            // {segs, entry}
    const unsafe = [];
    let hasCharsDir = false;
    for (const e of entries) {
        const path = e.path !== undefined ? e.path : safeEntryPath(e.name);
        if (path === null) { if (!e.isDirectory) unsafe.push(e); continue; }
        const segs = path.split('/');
        if (e.isDirectory) { if (segs.includes('characters')) hasCharsDir = true; continue; }
        files.push({ segs, entry: e });
    }

    // 2. 外层文件夹：只在"根上不像酒馆、但所有内容都在同一个文件夹下、剥掉后像酒馆"时剥。
    //    macOS 压缩时会多一个 __MACOSX/ 文件夹，判断时不算它
    let prefix = '';
    const real = files.filter(f => f.segs[0] !== '__MACOSX');
    if (!looksLikeTavernRoot(real.map(f => f.segs)) && real.length > 0) {
        const first = real[0].segs[0];
        if (real.every(f => f.segs.length > 1 && f.segs[0] === first)
            && looksLikeTavernRoot(real.map(f => f.segs.slice(1)))) {
            prefix = first;
        }
    }
    const rel = files.map(f => ({ segs: prefix && f.segs[0] === prefix ? f.segs.slice(1) : f.segs, entry: f.entry }));

    // 3. 按位置认
    const out = { isTavern: false, strippedPrefix: prefix, cards: [], chatGroups: [], worlds: [], presets: [], settings: null,
        ignored: { total: { count: 0, bytes: 0 }, byTop: [] } };
    const groups = new Map();
    const ignoredMap = new Map();
    const ignore = (top, entry) => {
        const size = entry.size || 0;
        const slot = ignoredMap.get(top) || { name: top, count: 0, bytes: 0 };
        slot.count++; slot.bytes += size;
        ignoredMap.set(top, slot);
        out.ignored.total.count++; out.ignored.total.bytes += size;
    };
    for (const e of unsafe) ignore('(名字不安全)', e);

    for (const { segs, entry } of rel) {
        const [top, second, third] = segs;
        const file = segs[segs.length - 1];
        if (segs.length === 1 && top === 'settings.json') out.settings = entry;
        else if (segs.length === 2 && top === 'characters' && ['png', 'json'].includes(extOf(file))) {
            out.cards.push({ fileName: file, baseName: stripExt(file), entry });
        } else if (segs.length === 3 && top === 'chats' && extOf(third) === 'jsonl') {
            if (!groups.has(second)) groups.set(second, { dir: second, files: [] });
            groups.get(second).files.push({ fileName: third, entry });
        } else if (segs.length === 2 && top === 'worlds' && extOf(file) === 'json') {
            out.worlds.push({ name: stripExt(file), fileName: file, entry });
        } else if (segs.length === 2 && top === 'OpenAI Settings' && extOf(file) === 'json') {
            out.presets.push({ name: stripExt(file), fileName: file, entry });
        } else {
            ignore(segs.length === 1 ? '(根目录文件)' : top, entry);
        }
    }
    out.chatGroups = [...groups.values()];
    out.ignored.byTop = [...ignoredMap.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    out.isTavern = !!out.settings || out.cards.length > 0 || hasCharsDir;
    return out;
}

// ───────────────────────────── settings.json ─────────────────────────────

const REGEX_FIELDS = ['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled',
    'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth'];

/**
 * 从 settings.json 的对象里【只挑】我们要的。其余一概不返回——尤其是密码 / key / 代理 / 自定义请求头
 * （oai_settings.proxy_password、proxies[].password、extension_settings.apiKey……）。
 * 输入形状不对返回空结果，不抛错。键名是 __proto__ 之类的一律跳过。
 * @param {any} settings
 * @returns {{personas: {avatar: string, name: string, description: string, title: string, isCurrent: boolean}[],
 *            currentUsername: string, currentAvatar: string, regexScripts: object[], presetName: string, globalWorlds: string[]}}
 *          globalWorlds：酒馆里全局选中的世界书的名字（只取非空字符串，去重，保持原顺序）
 */
export function extractTavernSettings(settings) {
    const res = { personas: [], currentUsername: '', currentAvatar: '', regexScripts: [], presetName: '', globalWorlds: [] };
    if (!isObj(settings)) return res;
    const own = (o, k) => isObj(o) && !DANGEROUS_KEYS.has(k) && Object.prototype.hasOwnProperty.call(o, k);

    if (typeof settings.username === 'string') res.currentUsername = settings.username;
    if (typeof settings.user_avatar === 'string') res.currentAvatar = settings.user_avatar;

    const pu = settings.power_user;
    if (isObj(pu) && isObj(pu.personas)) {
        for (const avatar of Object.keys(pu.personas)) {
            if (DANGEROUS_KEYS.has(avatar)) continue;
            const name = pu.personas[avatar];
            if (typeof name !== 'string') continue;
            const d = own(pu.persona_descriptions, avatar) ? pu.persona_descriptions[avatar] : null;
            res.personas.push({
                avatar,
                name,
                description: isObj(d) && typeof d.description === 'string' ? d.description : '',
                // 备注（酒馆人设列表上名字下面那行小字）：只认字符串，规范化在 personas.js cleanRemark（转换时做）
                title: isObj(d) && typeof d.title === 'string' ? d.title : '',
                isCurrent: avatar === res.currentAvatar,
            });
        }
    }

    const rx = isObj(settings.extension_settings) ? settings.extension_settings.regex : null;
    if (Array.isArray(rx)) {
        for (const s of rx) {
            if (!isObj(s)) continue;
            const c = {};
            for (const k of REGEX_FIELDS) if (own(s, k)) c[k] = s[k];
            res.regexScripts.push(c);
        }
    }

    const oai = settings.oai_settings;
    if (isObj(oai) && typeof oai.preset_settings_openai === 'string') res.presetName = oai.preset_settings_openai;

    // 全局选中的世界书：world_info_settings 这一层缺失（null / undefined）时退到顶层，和酒馆的 `settings.world_info_settings ?? settings` 一样。
    // 只取名字字符串——这个对象里别的东西（扫描设置、charLore 等）都不要
    const wis = settings.world_info_settings ?? settings;
    const sel = isObj(wis) && isObj(wis.world_info) ? wis.world_info.globalSelect : null;
    if (Array.isArray(sel)) res.globalWorlds = [...new Set(sel.filter(x => typeof x === 'string' && x !== ''))];
    return res;
}

// ───────────────────────────── 预览 ─────────────────────────────

/**
 * 导入前给界面看的摘要（不做导入）。
 * @param {TavernClassified} c
 * @param {ReturnType<typeof extractTavernSettings>} [settings]  已读出的 settings；不传则人设 / 正则数量为 null
 */
export function planTavernImport(c, settings) {
    const chatsByDir = new Map(c.chatGroups.map(g => [g.dir, g.files.length]));
    const cardBases = new Set(c.cards.map(x => x.baseName));
    return {
        isTavern: c.isTavern,
        strippedPrefix: c.strippedPrefix,
        cardCount: c.cards.length,
        cards: c.cards.map(x => ({ fileName: x.fileName, baseName: x.baseName, chatCount: chatsByDir.get(x.baseName) || 0 })),
        chatCount: c.chatGroups.reduce((n, g) => n + g.files.length, 0),
        orphanChats: c.chatGroups.filter(g => !cardBases.has(g.dir)).map(g => ({ dir: g.dir, count: g.files.length })),
        worldCount: c.worlds.length,
        presetCount: c.presets.length,
        hasSettings: !!c.settings,
        personaCount: settings ? settings.personas.length : null,
        regexCount: settings ? settings.regexScripts.length : null,
        ignored: c.ignored,
    };
}

// ───────────────────────────── 反方向：我们的数据 → 酒馆目录 ─────────────────────────────

const toBytes = d => (typeof d === 'string' ? new TextEncoder().encode(d) : d);
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47];

/** 在 used（小写集合）里找一个不重名的名字：重名加 ` (2)`、` (3)`……。Windows 不区分大小写，所以按小写比 */
function uniqueName(base, ext, used) {
    let n = 1, name;
    do {
        name = n === 1 ? base : `${base} (${n})`;
        n++;
    } while (used.has(`${name}.${ext}`.toLowerCase()));
    used.add(`${name}.${ext}`.toLowerCase());
    return name;
}

/**
 * 把"已经按酒馆格式序列化好的文件"摆成酒馆的目录结构，输出给 buildZip。
 *
 * 【绝不生成 settings.json】：用户会把这个 zip 解压进酒馆的数据目录，带上 settings.json 会冲掉对方的全部设置
 * （连接、主题、扩展设置……）。同理也不生成 secrets.json、User Avatars 等。
 *
 * 文件名规则和单个文件导出一致（card-export.js 的 safeFileName：去 Windows 非法字符、首尾空格和点、
 * 保留名加下划线、按 UTF-8 字节截断）。chats/ 的目录名严格等于对应卡的文件名去扩展名，
 * 这样酒馆才找得到——所以卡先定名（含重名处理），聊天再按"卡的原始文件名"查最终名。
 * 没有对应卡的聊天（孤儿）也会写，目录名按同样规则清洗。
 *
 * @param {{
 *   cards?: {fileName: string, data: Uint8Array}[],            fileName 如 '艾拉.png' / '艾拉.json'
 *   chats?: {card: string, fileName: string, data: Uint8Array|string}[],   card = 所属卡的 fileName（和 cards 里一致）
 *   worlds?: {name: string, data: Uint8Array|string}[],        name = 书名（不含 .json）
 *   presets?: {name: string, data: Uint8Array|string}[],
 * }} input
 * @returns {{name: string, data: Uint8Array}[]}
 */
export function buildTavernLayout({ cards = [], chats = [], worlds = [], presets = [] } = {}) {
    const out = [];

    // 卡
    const usedCards = new Set();
    const cardBase = new Map(); // 原始 fileName → 最终的 base（不含扩展名）
    for (const c of cards) {
        const data = toBytes(c.data);
        const raw = String(c.fileName ?? '');
        const m = /\.(png|json)$/i.exec(raw);
        const ext = m ? m[1].toLowerCase() : (data.length >= 4 && PNG_MAGIC.every((b, i) => data[i] === b) ? 'png' : 'json');
        // 卡的去重只看主体名、不看扩展名：「艾拉.png」和「艾拉.json」在酒馆里共用 chats/艾拉/ 这一个聊天目录，
        // 而且再导入时同名的 .json 会被同名的 .png 盖掉。所以第二张要叫「艾拉 (2).json」（扩展名统一传 'card' 只当集合里的键用）
        const base = uniqueName(stripCleanBase(m ? raw.slice(0, -m[0].length) : raw), 'card', usedCards);
        if (!cardBase.has(raw)) cardBase.set(raw, base);
        out.push({ name: `characters/${base}.${ext}`, data });
    }

    // 聊天：目录名 = 卡的 base；每个目录内文件名按目录各自去重
    const usedChat = new Map(); // 目录 → 已用名字集合
    for (const ch of chats) {
        const rawCard = String(ch.card ?? '');
        const dir = cardBase.has(rawCard) ? cardBase.get(rawCard)
            : stripCleanBase(rawCard.replace(/\.(png|json)$/i, ''));
        if (!usedChat.has(dir)) usedChat.set(dir, new Set());
        const name = uniqueName(stripCleanBase(String(ch.fileName ?? '').replace(/\.jsonl$/i, ''), '聊天'), 'jsonl', usedChat.get(dir));
        out.push({ name: `chats/${dir}/${name}.jsonl`, data: toBytes(ch.data) });
    }

    for (const [list, dir, fb] of [[worlds, 'worlds', '世界书'], [presets, 'OpenAI Settings', '预设']]) {
        const used = new Set();
        for (const w of list) {
            const name = uniqueName(stripCleanBase(String(w.name ?? '').replace(/\.json$/i, ''), fb), 'json', used);
            out.push({ name: `${dir}/${name}.json`, data: toBytes(w.data) });
        }
    }
    return out;
}

/** 清洗成一个不带扩展名的安全文件名主体（借 safeFileName 的规则，所以和单文件导出一致） */
function stripCleanBase(name, fallback = '未命名') {
    // safeFileName(name, '', fb) 不加扩展名；扩展名由调用方统一拼，这样截断长度时留的余量（200 字节）够用
    return safeFileName(name, '', fallback);
}
