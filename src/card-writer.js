// 「写卡」的纯逻辑：从零造一张空白卡、把写卡页改的四样（名字 / 描述 / 开场白；头像单独存在卡记录上）写进 Card，
// 以及头像缩放的几何计算。界面在 ui/card-writer.js；纯函数，不碰 DOM / 存储，Node 里可测。
//
// 为什么新卡要先造一份「酒馆的卡 JSON」，而不是直接拼一个 Card 对象：
//   我们的 Card 有一个 raw（导入时的原始卡 JSON），导出（card-export.js exportCardJson）是「以 raw 为底、只写回改过的地方」。
//   从零新建的卡如果 raw 是空的，导出时只能走「raw 解析不出卡 → 用 Card 字段现拼一张 V2」那条退路；
//   而先按酒馆新建角色时存盘的样子（characters.js charaFormatData）造一份完整的 V2 JSON，再交给 parseCard 和现成的「导入卡」流程，
//   这张卡从此和导入进来的卡走完全一样的路：存储、切卡、导出、前端卡读 raw（frame-host.js getCharData）都是测过的。

import { parseCard } from './card.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 新建空白卡的默认名字 */
export const BLANK_CARD_NAME = '新角色';

/**
 * 一张空白的酒馆 V2 卡 JSON。字段和默认值照酒馆新建角色时 charaFormatData（characters.js ~L565）写出的样子：
 *   顶层是 V1 的旧字段（name / description / … / creatorcomment / avatar / talkativeness / fav / tags），
 *   spec / spec_version / data 是 V2 的；data.extensions 里有 talkativeness / fav / world / depth_prompt。
 * 有意不写的：chat（「当前聊天」的指向，私人字段，酒馆导出时也会删）。
 * create_date 用 ISO 时间（酒馆导入卡时写的就是 new Date().toISOString()）；写一次就固定在 raw 里，之后导出多少次都一样。
 * @param {string} name
 * @param {Date} [now]
 * @returns {Object}
 */
export function blankCardJson(name, now = new Date()) {
    return {
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creatorcomment: '',
        avatar: 'none',
        talkativeness: 0.5,
        fav: false,
        tags: [],
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            character_version: '',
            alternate_greetings: [],
            extensions: {
                talkativeness: 0.5,
                fav: false,
                world: '',
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
            },
        },
        create_date: now.toISOString(),
    };
}

/**
 * 不和已有卡重名的名字：「新角色」「新角色 2」「新角色 3」…
 * 为什么要避开重名：现成的导入卡流程（archive.js addCard）遇到同名卡会问「更新那张卡还是另存」——
 * 新建一张空白卡不该问这个，更不能一不小心用空白内容把同名的卡盖掉。
 * @param {string} base
 * @param {string[]} taken
 */
export function uniqueCardName(base, taken) {
    const used = new Set(taken);
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** 一张空白卡：Card（parseCard 的结果），raw 就是 blankCardJson */
export function blankCard(name, now) {
    return parseCard(blankCardJson(name, now));
}

// 写卡页能改的文字字段 → Card 上的键、原始卡 JSON 里的键
const FIELDS = { name: 'name', description: 'description', firstMes: 'first_mes' };

/** raw 是不是一张能解析的卡（parseCard 要求有名字）。迁移来的占位卡 raw = {}：不碰它，导出时 card-export.js 会用 Card 字段拼一张 V2 */
function rawIsCard(raw) {
    if (!isObj(raw)) return false;
    const data = isObj(raw.data) ? raw.data : {};
    return !!str(data.name ?? raw.name).trim();
}

/**
 * 原始卡 JSON 里存这个字段的地方也改掉（和「拼装」页就地编辑的 prompt-edit.js writeRaw 同一个规矩）：
 * V2 / V3 改 data.*，顶层有同名旧字段的一并改；V1（没有 data）只有顶层。
 * 这样前端卡 / 脚本读 raw（getCharData）看到的是新内容，导出时以 raw 为底也就自然带着改动。
 */
function writeRaw(raw, key, value) {
    if (!rawIsCard(raw)) return;
    if (isObj(raw.data)) {
        raw.data[key] = value;
        if (key in raw) raw[key] = value;
    } else {
        raw[key] = value;
    }
}

/**
 * 把写卡页的改动写进 Card（原地改，同时改 card.raw）。返回实际变了的字段名。
 * - name：去掉首尾空白；空名字不接受（酒馆卡必须有名字，parseCard 读不出没名字的卡），抛错由界面提示。
 *   改名时，卡自带世界书如果没有自己的书名（parseCard 那时拿卡名当书名），条目上记的书名跟着换成新名字——
 *   导出再导入时 parseCard 给条目的书名就是新卡名，这样页面里和导出的一致，导出时也不会因为书名对不上被当成「世界书改过」。
 * - description / firstMes：原样（不去空白，宏 {{char}} / {{user}} 原样保留）。
 * @param {import('./types.js').Card} card
 * @param {{name?: string, description?: string, firstMes?: string}} patch
 * @returns {string[]}
 */
export function applyCardFields(card, patch) {
    const changed = [];
    for (const [k, rawKey] of Object.entries(FIELDS)) {
        if (!(k in patch)) continue;
        let v = str(patch[k]);
        if (k === 'name') {
            v = v.trim();
            if (!v) throw new Error('名字不能为空');
        }
        if (card[k] === v) continue;
        if (k === 'name') renameOwnBook(card, card.name, v);
        card[k] = v;
        writeRaw(card.raw, rawKey, v);
        changed.push(k);
    }
    return changed;
}

/** 卡自带世界书没有自己的书名时，条目上的书名（= 旧卡名）换成新卡名（理由见 applyCardFields） */
function renameOwnBook(card, oldName, newName) {
    const bookName = str(card.raw?.data?.character_book?.name);
    if (bookName) return;
    for (const e of Array.isArray(card.worldEntries) ? card.worldEntries : []) {
        if (isObj(e) && e.book === oldName) e.book = newName;
    }
}

// ───────────────────────────── 多个开场白 ─────────────────────────────
//
// 酒馆卡的开场白：first_mes 是第一个，data.alternate_greetings（字符串数组，只在 V2 / V3 的 data 下，V1 没有这个字段）是备选的。
// 写卡页把它们当成一个列表编辑：[first_mes, ...alternate_greetings]。把某个备选挪到第一位 = 它成了 first_mes（数据上真的这样写）。
//
// 页面别处用的是「去掉空的」之后的列表：chat.js startChat / shell.js 的开场白下拉框都是 [firstMes, ...alternateGreetings].filter(Boolean)，
// 存档记的 greeting.index 也是这个过滤后列表里的下标。所以这里另给两个换算：槽位（未过滤列表里的位置）↔ 过滤后的下标。
//
// 写回 raw：first_mes 照名字 / 描述那一套写进 raw（writeRaw）；alternate_greetings【不写进 raw】，只改 Card，
// 导出时由 card-export.js TEXT_FIELDS 和「导入时的样子」比，变了才写 data.alternate_greetings。
// 为什么不写 raw：原卡里可能根本没有这个键，写进去之后「加一个再删掉」会在导出里多出一个 alternate_greetings: []，
// 就做不到「改了又改回 = 原文件逐字不变」了。代价：前端卡 / 脚本读 raw（getCharData）看到的还是原来的备选开场白。

/** 写卡页的开场白列表：[first_mes, ...alternate_greetings]，非字符串的项当空串 */
export function greetingList(card) {
    const alts = Array.isArray(card?.alternateGreetings) ? card.alternateGreetings : [];
    return [str(card?.firstMes), ...alts.map(str)];
}

/**
 * 把列表写回卡：list[0] → firstMes（同时写 raw 的 first_mes），其余 → alternateGreetings（换成新数组，不原地改：
 * 刚导入的卡 card.alternateGreetings 和 raw.data.alternate_greetings 可能是同一个数组）。列表至少当一个空开场白处理。
 * @returns {boolean} 有没有变
 */
export function setGreetings(card, list) {
    const l = (Array.isArray(list) && list.length ? list : ['']).map(str);
    const before = JSON.stringify(greetingList(card));
    applyCardFields(card, { firstMes: l[0] });
    card.alternateGreetings = l.slice(1);
    return JSON.stringify(greetingList(card)) !== before;
}

/** 槽位 → 过滤掉空开场白之后的下标；这个槽位本身是空的返回 -1 */
export function filteredIndex(list, slot) {
    if (!str(list[slot])) return -1;
    let n = 0;
    for (let i = 0; i < slot; i++) if (str(list[i])) n++;
    return n;
}

/** 过滤后的下标 → 槽位；超出范围返回 null */
export function slotOfFiltered(list, index) {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
        if (!str(list[i])) continue;
        if (n === index) return i;
        n++;
    }
    return null;
}

/**
 * 列表的一次结构操作之后，某个槽位去了哪（实时预览要跟着「存档是用哪个开场白开的」走）。
 * op：{type:'move', from, to} / {type:'delete', at} / {type:'add'}（加在最后）。被删掉的返回 null。
 */
export function followSlot(slot, op) {
    if (slot === null || slot === undefined) return null;
    if (op.type === 'delete') return slot === op.at ? null : slot > op.at ? slot - 1 : slot;
    if (op.type === 'move') {
        if (slot === op.from) return op.to;
        if (op.from < slot && op.to >= slot) return slot - 1;
        if (op.from > slot && op.to <= slot) return slot + 1;
        return slot;
    }
    return slot;
}

/** 列表上做一次结构操作，返回新数组（不改原数组） */
export function applyListOp(list, op) {
    const l = [...list];
    if (op.type === 'add') l.push('');
    else if (op.type === 'delete') { l.splice(op.at, 1); if (!l.length) l.push(''); }
    else if (op.type === 'move') { const [x] = l.splice(op.from, 1); l.splice(op.to, 0, x); }
    return l;
}

// ───────────────────────────── 头像 ─────────────────────────────

/**
 * 头像的长边上限（像素）。不裁剪、保持比例；只有长边超过它才等比缩小——手机拍的照片动辄 4000×3000、好几 MB，
 * 原样塞进卡记录会把存储和整体备份撑得很大。1536 在聊天界面和导出的 PNG 卡里都绰绰有余（酒馆的标准头像是 512×768）。
 */
export const AVATAR_MAX_SIDE = 1536;

/**
 * 原图尺寸 → 存下来的尺寸：长边不超过 max 就原样（返回 null = 不用缩），超过就等比缩到长边 = max（四舍五入，至少 1）。
 * @returns {{w: number, h: number} | null}
 */
export function fitWithin(w, h, max = AVATAR_MAX_SIDE) {
    if (!(w > 0 && h > 0) || Math.max(w, h) <= max) return null;
    const k = max / Math.max(w, h);
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
