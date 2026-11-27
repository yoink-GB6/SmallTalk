// 「摘抄」页（ui/tab-excerpts.js）的纯逻辑：一条划线显示成什么名字、搜索怎么匹配、批量勾选的层级。
// 不碰 DOM / 存储，Node 里可测（test/excerpts.test.mjs）。
//
// 页面上的数据是三层：角色卡 → 有划线的存档 → 划线。这里用的形状（tab-excerpts.js gather 产出）：
//   ExcerptGroup = {cardId, cardName, current, chats: ExcerptChat[]}
//   ExcerptChat  = {chatId, name, current, items: ExcerptItem[]}
//   ExcerptItem  = {h: Highlight, text: string|null（从原文切出来的；原文不在了 = null）, shown}
// 一条划线的「键」= '卡id/存档id/划线id'（存档 id、卡 id 是 uuid，划线 id 只在存档内唯一，所以三段拼起来才唯一）。

/** 名字最多几个字（没有备注时取摘抄的前几个字） */
export const NAME_MAX = 15;

/**
 * 一条划线在列表里显示的「名字」（用户 2026-11-28 定的）：有备注就是备注；没有就是摘抄的前 15 个字，超出加「…」。
 * 按字（码点）数，不按 UTF-16：emoji 不会被切开。空白（换行、连续空格）压成一个空格再数。
 * 原文已经不在了（text = null）→「（原文已经不在了）」；全是空白 →「（空白）」。
 */
export function excerptName(h, text, max = NAME_MAX) {
    const note = typeof h?.note === 'string' ? h.note.replace(/\s+/g, ' ').trim() : '';
    if (note) return note;
    if (text === null || text === undefined) return '（原文已经不在了）';
    const flat = String(text).replace(/\s+/g, ' ').trim();
    if (!flat) return '（空白）';
    const chars = Array.from(flat);
    return chars.length > max ? chars.slice(0, max).join('') + '…' : flat;
}

/** 搜索：按字面、不分大小写，摘抄的文字或备注里包含就算匹配。空搜索（去掉首尾空白后）= 全部匹配 */
export function matchExcerpt(query, text, note) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;
    return (typeof text === 'string' && text.toLowerCase().includes(q)) || (typeof note === 'string' && note.toLowerCase().includes(q));
}

/** 按搜索过滤：只留匹配的划线，没有剩下划线的存档、没有剩下存档的卡去掉。不改输入。空搜索原样返回 */
export function filterGroups(groups, query) {
    if (!String(query ?? '').trim()) return groups;
    const out = [];
    for (const g of groups) {
        const chats = [];
        for (const c of g.chats) {
            const items = c.items.filter(it => matchExcerpt(query, it.text, it.h?.note));
            if (items.length) chats.push({ ...c, items });
        }
        if (chats.length) out.push({ ...g, chats });
    }
    return out;
}

export const itemKey = (cardId, chatId, id) => `${cardId}/${chatId}/${id}`;
/** 一个存档下所有划线的键 */
export const chatKeys = (g, c) => c.items.map(it => itemKey(g.cardId, c.chatId, it.h.id));
/** 一张卡下所有划线的键 */
export const groupKeys = g => g.chats.flatMap(c => chatKeys(g, c));
/** 所有划线的键 */
export const allKeys = groups => groups.flatMap(groupKeys);

/** 一组键在勾选集合里的状态：'all'（全勾了）| 'some'（勾了一部分，勾选框显示成半选）| 'none'。空组 = 'none' */
export function pickState(picked, keys) {
    let n = 0;
    for (const k of keys) if (picked.has(k)) n++;
    return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

/** 勾 / 不勾一组键（勾存档 = 它下面全部划线；勾角色 = 它下面全部存档的全部划线）。原地改 picked */
export function setPicked(picked, keys, on) {
    for (const k of keys) { if (on) picked.add(k); else picked.delete(k); }
}

/**
 * 勾选集合 → 要做的改动：[{cardId, chatId, remove: 划线 id[]}]（按 groups 里的顺序，一个存档一项）。
 * 只认 groups 里现在还列着的划线（已经不在的键忽略）。同时给出涉及几个存档、一共几条。
 */
export function picksToEdits(groups, picked) {
    const edits = [];
    let count = 0;
    for (const g of groups) for (const c of g.chats) {
        const remove = c.items.filter(it => picked.has(itemKey(g.cardId, c.chatId, it.h.id))).map(it => it.h.id);
        if (remove.length) { edits.push({ cardId: g.cardId, chatId: c.chatId, remove }); count += remove.length; }
    }
    return { edits, count, chats: edits.length };
}
