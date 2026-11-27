// 划线 / 摘抄（2026-11-28 第一段：数据和纯逻辑；选中文字的按钮、高亮的绘制、摘抄页签是第二段）。
// 纯函数，Node 里可测，不碰 DOM / IndexedDB。数据形状见 types.js「划线」一节（Highlight / HighlightPoint / HighlightDoc）。
//
// ─────────────────────────── 两半 ───────────────────────────
// 一、位置的运算（增删、编辑后平移、删楼后清理、哪些现在看得见、切出文字、读入清洗）。
//     只认「一组有序的文本」（HighlightDoc：第几段、第几个版本、取文字），不知道这是 RP 存档：
//     chatDoc(messages) 把存档的消息包成这个样子（楼 = 段，候选 = 版本）；以后手机聊天、读书的划线各写各的包装，下面的函数照用。
// 二、选区对回原文（mapFloor 等）：界面上选中的是渲染后的文字，要换算成原文（ChatMessage.content）里的位置，反过来画高亮也要换回去。
//
// ─────────────────────────── 位置怎么数 ───────────────────────────
// offset 是 UTF-16 下标（就是 JS 字符串的下标，String.prototype.slice 直接能用）。为什么不用码点：
//   浏览器的选区（Range.startOffset）在文字节点里数的就是 UTF-16；原文切片、比较新旧原文也都是 UTF-16。用码点就得在每一处来回换算，
//   换算错一处就悄悄划歪。代价：emoji 这类占两个单位的字，理论上能把位置落在它中间——对照函数在两端各自往外扩一格，保证不切开（snapSurrogates）。
// 区间左闭右开 [from, to)。跨楼时 from 那一楼从 from.offset 到这一楼末尾、to 那一楼从开头到 to.offset、中间的楼整楼都算。
//
// ─────────────────────────── 规则（用户 2026-11-27 定的，见 docs/new-features-plan.md 第 1 节） ───────────────────────────
// - 只记位置，不存文字；带上第几楼、第几个候选（swipe）。没有候选的楼 swipe = 0（和 chatfile.js readSwipes 的「没有候选 = 只有 content 一个」一致；
//   老存档候选还躺在 st 里的也按 readSwipes 读）。
// - 删楼（删这一楼及之后 / 前端卡单删任意楼）：任一端落在被删的楼里的整条删掉（跨楼只被删掉一半的也删）；其余的楼号往前挪（afterDeleteFloors）。
// - 编辑后平移（shiftAfterEdit）：新旧原文求公共前缀和公共后缀，中间是改动段。在这一楼上，划线覆盖的部分
//   完全在改动段之前 → 不动；完全在之后 → 整体平移；有交叠 → 整条删掉。「整楼」的（whole）不删不移。
//   跨楼的：对它两端各自所在的楼分别套这条规则；中间的楼被整楼覆盖，所以中间楼的任何改动（除了只在最前 / 最后插字）都算交叠、整条删掉。
//   只看这一楼【当时这个候选】上的划线：改的是候选 2，挂在候选 0 上的不动。
// - 换候选 / 重新生成：不删任何划线，按 swipe 号决定显示哪些（visibleHighlights）。跨楼的要两端的候选都正好是现在显示的才显示。
// - 读入（normalizeHighlights）：形状不对、楼号越界、候选号不存在、offset 超出那段原文长度、同一楼却两端候选不同、长度为 0 → 丢掉；
//   from 在 to 之后 → 两端对调；id 缺 / 重复 → 补一个确定的 'hl-<位置>'；备注不是字符串 → 去掉；at 不是数字 → 0。
//   不认识的字段原样带着（以后的版本加的），只挡 __proto__ / constructor / prototype。
//
// ─────────────────────────── 已知的局限 ───────────────────────────
// - 不存文字，所以「原文在别处被改了、却没经过这里的钩子」时发现不了：旧版本的页面（离线缓存还没更新的标签页）编辑了消息、
//   在真酒馆里改过再导回来（.jsonl 不带划线，这一条其实碰不到）。越界的会在读入时被丢掉，没越界的会悄悄划在别的字上。
// - 新旧原文的「公共前缀 + 公共后缀」在重复字符处有多种切法（"aaa" → "aaaa"）；不同切法得到的位置在文字上是一样的，不影响结果。

import { readSwipes } from './chatfile.js';
import { runRegexScripts } from './regex.js';
import { isFrontend } from './render.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const KNOWN = new Set(['id', 'from', 'to', 'whole', 'note', 'at']);

/** 备注最长多少字（UTF-16 单位），超出截掉 */
export const MAX_HIGHLIGHT_NOTE = 5000;
/** 一个存档最多留多少条（读入时多出来的丢掉；防手改的数据把页面拖死） */
export const MAX_HIGHLIGHTS = 10000;

// ═══════════════════════════ 一、位置的运算 ═══════════════════════════

/**
 * 存档的消息 → HighlightDoc。第 floor 楼第 swipe 个候选的原文：
 *   swipe = 现在显示的那个（readSwipes 的 id，没有候选 = 0）→ content（content 才是当前候选的唯一真相，swipes[swipeId] 只是副本）；
 *   别的候选 → swipes[swipe]（不是字符串的当 ''，同 chatfile.js ensureSwipes）；没有这个候选 → null。
 * @param {import('./types.js').ChatMessage[]} messages
 * @returns {import('./types.js').HighlightDoc}
 */
export function chatDoc(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const current = floor => (isObj(list[floor]) ? readSwipes(list[floor])?.id ?? 0 : 0);
    return {
        count: list.length,
        current,
        text(floor, swipe) {
            const m = list[floor];
            if (!isObj(m) || !isInt(swipe)) return null;
            if (swipe === current(floor)) return typeof m.content === 'string' ? m.content : '';
            const s = readSwipes(m);
            if (!s || swipe < 0 || swipe >= s.swipes.length) return null;
            return typeof s.swipes[swipe] === 'string' ? s.swipes[swipe] : '';
        },
    };
}

/** 一组纯文本（每段只有一个版本 0）→ HighlightDoc。给单元测试和以后不分候选的使用者（读书）用 */
export function textsDoc(texts) {
    const list = Array.isArray(texts) ? texts : [];
    return {
        count: list.length,
        current: () => 0,
        text: (floor, swipe) => (swipe === 0 && typeof list[floor] === 'string' ? list[floor] : null),
    };
}

/** 两个端点的先后：先比楼，再比位置 */
export const comparePoint = (a, b) => a.floor - b.floor || a.offset - b.offset;

const lenAt = (doc, floor, swipe) => { const t = doc.text(floor, swipe); return t === null ? -1 : t.length; };

function cleanPoint(p, doc) {
    if (!isObj(p) || !isInt(p.floor) || !isInt(p.swipe) || !isInt(p.offset)) return null;
    if (p.floor < 0 || p.floor >= doc.count || p.offset < 0) return null;
    const len = lenAt(doc, p.floor, p.swipe);
    if (len < 0 || p.offset > len) return null;
    return { floor: p.floor, swipe: p.swipe, offset: p.offset };
}

/** 备注：字符串才要；去首尾空白；空了 = 没有（返回 undefined）；超长截掉 */
export function cleanNote(v) {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t ? t.slice(0, MAX_HIGHLIGHT_NOTE) : undefined;
}

/**
 * 一条划线的读入清洗（规则见文件头）。不改输入，返回新对象或 null（丢掉）。
 * @param {any} h
 * @param {import('./types.js').HighlightDoc} doc
 * @param {string} fallbackId  id 缺失时用它
 */
export function normalizeHighlight(h, doc, fallbackId = 'hl-0') {
    if (!isObj(h)) return null;
    let from = cleanPoint(h.from, doc), to = cleanPoint(h.to, doc);
    if (!from || !to) return null;
    const whole = h.whole === true;
    if (whole) {
        // 整楼：两端必须是同一楼同一候选；位置不看，一律写 0
        if (from.floor !== to.floor || from.swipe !== to.swipe) return null;
        from.offset = 0; to.offset = 0;
    } else {
        if (comparePoint(from, to) > 0) [from, to] = [to, from];
        if (from.floor === to.floor && (from.swipe !== to.swipe || from.offset === to.offset)) return null;
    }
    const out = {};
    // 不认识的字段原样带着（以后的版本加的），危险键挡掉
    for (const k of Object.keys(h)) if (!KNOWN.has(k) && !UNSAFE.has(k)) out[k] = h[k];
    out.id = typeof h.id === 'string' && h.id ? h.id : fallbackId;
    out.from = from; out.to = to;
    if (whole) out.whole = true;
    const note = cleanNote(h.note);
    if (note !== undefined) out.note = note;
    out.at = typeof h.at === 'number' && Number.isFinite(h.at) ? h.at : 0;
    return out;
}

/**
 * 一组划线的读入清洗。不是数组 = 没有。id 重复 / 缺失的换成确定的 'hl-<下标>'（再撞就加后缀），所以同样的输入永远得到同样的输出。
 * @returns {{list: import('./types.js').Highlight[], dropped: number}}
 */
export function normalizeHighlights(raw, doc) {
    if (!Array.isArray(raw)) return { list: [], dropped: 0 };
    const list = [], ids = new Set();
    let dropped = 0;
    raw.forEach((h, k) => {
        if (list.length >= MAX_HIGHLIGHTS) { dropped++; return; }
        const c = normalizeHighlight(h, doc, '');
        if (!c) { dropped++; return; }
        if (!c.id || ids.has(c.id)) {
            let id = `hl-${k}`, n = 2;
            while (ids.has(id)) id = `hl-${k}-${n++}`;
            c.id = id;
        }
        ids.add(c.id);
        list.push(c);
    });
    return { list, dropped };
}

/** 要存进 ChatRecord 的形状：清洗后一条都没有 = null（不写这个字段，不用划线的人存储形状不变） */
export function storedHighlights(raw, doc) {
    const { list } = normalizeHighlights(raw, doc);
    return list.length ? list : null;
}

/** 存储里有几条（不清洗，只数对象；给存档目录 index 的 hl 计数用） */
export const countHighlights = raw => (Array.isArray(raw) ? raw.filter(isObj).length : 0);

/**
 * 新建一条（界面调）。不合法（越界、长度为 0……）返回 null。
 * @param {{from: import('./types.js').HighlightPoint, to: import('./types.js').HighlightPoint, whole?: boolean, note?: string}} spec
 *   whole：整楼（收藏整条消息）——只看 from 的楼和候选，to 可以不给
 * @param {import('./types.js').HighlightDoc} doc
 * @param {{newId: () => string, now?: number}} deps
 */
export function newHighlight(spec, doc, { newId, now = Date.now() }) {
    if (!isObj(spec)) return null;
    const whole = spec.whole === true;
    const to = whole ? { ...spec.from, offset: 0 } : spec.to;
    const from = whole ? { ...spec.from, offset: 0 } : spec.from;
    return normalizeHighlight({ from, to, whole, note: spec.note, at: now }, doc, newId());
}

/** 加一条（返回新数组）。和已有的一条位置完全相同（含是不是整楼）时不重复加，返回原数组 */
export function addHighlight(list, h) {
    const cur = Array.isArray(list) ? list : [];
    const same = x => x.whole === h.whole && comparePoint(x.from, h.from) === 0 && comparePoint(x.to, h.to) === 0
        && x.from.swipe === h.from.swipe && x.to.swipe === h.to.swipe;
    return cur.some(same) ? cur : [...cur, h];
}

/** 删一条（返回新数组） */
export const removeHighlight = (list, id) => (Array.isArray(list) ? list.filter(h => h.id !== id) : []);

/** 改备注（返回新数组；空备注 = 去掉 note 字段） */
export function setHighlightNote(list, id, note) {
    const n = cleanNote(note);
    return (Array.isArray(list) ? list : []).map(h => {
        if (h.id !== id) return h;
        const { note: _old, ...rest } = h;
        return n === undefined ? rest : { ...rest, note: n };
    });
}

/**
 * 新旧原文的改动段：公共前缀 + 公共后缀之外的那一段。没改 = null。
 * @returns {{start: number, oldEnd: number, newEnd: number}|null}  旧原文里 [start, oldEnd) 换成了新原文里 [start, newEnd)
 */
export function diffRange(before, after) {
    const a = String(before ?? ''), b = String(after ?? '');
    if (a === b) return null;
    const min = Math.min(a.length, b.length);
    let p = 0;
    while (p < min && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < min - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return { start: p, oldEnd: a.length - s, newEnd: b.length - s };
}

/**
 * 某一楼某个候选的原文从 before 改成了 after：划线跟着平移 / 删掉（规则见文件头）。
 * @param {import('./types.js').Highlight[]} list
 * @param {{floor: number, swipe: number, before: string, after: string}} edit
 * @returns {{list: import('./types.js').Highlight[], removed: string[], changed: boolean}}  removed：删掉的 id
 */
export function shiftAfterEdit(list, { floor, swipe, before, after }) {
    const cur = Array.isArray(list) ? list : [];
    const d = diffRange(before, after);
    if (!d || !cur.length) return { list: cur, removed: [], changed: false };
    const oldLen = String(before ?? '').length;
    const delta = String(after ?? '').length - oldLen;
    const out = [], removed = [];
    let changed = false;
    for (const h of cur) {
        if (h.whole || floor < h.from.floor || floor > h.to.floor) { out.push(h); continue; }
        const onFrom = h.from.floor === floor, onTo = h.to.floor === floor;
        // 端点在这一楼、但挂的是别的候选：改的不是它划的那段字
        if ((onFrom && h.from.swipe !== swipe) || (onTo && h.to.swipe !== swipe)) { out.push(h); continue; }
        // 这条划线在这一楼上覆盖的部分 [a, b)（中间的楼 = 整楼）
        const a = onFrom ? h.from.offset : 0;
        const b = onTo ? h.to.offset : oldLen;
        if (b <= d.start) { out.push(h); continue; }          // 全在改动段之前
        if (a >= d.oldEnd) {                                  // 全在改动段之后：平移
            if (delta === 0) { out.push(h); continue; }
            out.push({ ...h, from: onFrom ? { ...h.from, offset: h.from.offset + delta } : h.from,
                to: onTo ? { ...h.to, offset: h.to.offset + delta } : h.to });
            changed = true;
            continue;
        }
        removed.push(h.id);                                   // 和改动段交叠：划的那段字变了，删掉
        changed = true;
    }
    return { list: changed ? out : cur, removed, changed };
}

/**
 * 删掉了一些楼（任意的楼号集合；「删这一楼及之后」就是 n..末尾）。任一端在被删的楼里 → 删掉；其余的楼号往前挪。
 * @param {Iterable<number>} dropped  被删的楼号（删之前的编号）
 * @returns {{list: import('./types.js').Highlight[], removed: string[], changed: boolean}}
 */
export function afterDeleteFloors(list, dropped) {
    const cur = Array.isArray(list) ? list : [];
    const drop = [...new Set(dropped)].filter(isInt).sort((x, y) => x - y);
    if (!drop.length || !cur.length) return { list: cur, removed: [], changed: false };
    const set = new Set(drop);
    // 楼号 f 前面被删了几楼
    const before = f => { let lo = 0, hi = drop.length; while (lo < hi) { const m = (lo + hi) >> 1; if (drop[m] < f) lo = m + 1; else hi = m; } return lo; };
    const out = [], removed = [];
    let changed = false;
    for (const h of cur) {
        if (set.has(h.from.floor) || set.has(h.to.floor)) { removed.push(h.id); changed = true; continue; }
        const df = before(h.from.floor), dt = before(h.to.floor);
        if (!df && !dt) { out.push(h); continue; }
        out.push({ ...h, from: { ...h.from, floor: h.from.floor - df }, to: { ...h.to, floor: h.to.floor - dt } });
        changed = true;
    }
    return { list: changed ? out : cur, removed, changed };
}

/** 「删这一楼及之后」：截到 n 楼（n 楼和之后的都没了） */
export function afterTruncate(list, n) {
    const cur = Array.isArray(list) ? list : [];
    const out = cur.filter(h => h.to.floor < n);
    const removed = cur.filter(h => h.to.floor >= n).map(h => h.id);
    return { list: removed.length ? out : cur, removed, changed: removed.length > 0 };
}

/** 这条划线现在看不看得见：两端的候选都正好是现在显示的那个，而且原文还在 */
export function isShown(h, doc) {
    return doc.current(h.from.floor) === h.from.swipe && doc.current(h.to.floor) === h.to.swipe
        && lenAt(doc, h.from.floor, h.from.swipe) >= 0 && lenAt(doc, h.to.floor, h.to.swipe) >= 0;
}

/**
 * 一条划线在每一楼上覆盖原文的哪一段。端点楼用划线记的候选，中间的楼用现在显示的候选。原文不在了返回 null。
 * @returns {{floor: number, swipe: number, start: number, end: number}[]|null}
 */
export function highlightParts(h, doc) {
    const parts = [];
    for (let f = h.from.floor; f <= h.to.floor; f++) {
        const swipe = f === h.from.floor ? h.from.swipe : f === h.to.floor ? h.to.swipe : doc.current(f);
        const len = lenAt(doc, f, swipe);
        if (len < 0) return null;
        const start = h.whole || f !== h.from.floor ? 0 : h.from.offset;
        const end = h.whole || f !== h.to.floor ? len : h.to.offset;
        parts.push({ floor: f, swipe, start: Math.min(start, len), end: Math.min(end, len) });
    }
    return parts;
}

/**
 * 现在看得见的划线，拆成每一楼一段（画高亮用；坐标是原文的，界面再用 rawToVisible 换成渲染后的位置）。
 * 按楼、再按开始位置排好。
 * @param {{floor?: number}} [opts]  只要某一楼的
 * @returns {{id: string, floor: number, start: number, end: number, whole: boolean, first: boolean, last: boolean, note?: string}[]}
 *   first / last：这一段是不是这条划线的第一段 / 最后一段（跨楼时界面可以只在最后一段画备注图标）
 */
export function visibleHighlights(list, doc, { floor } = {}) {
    const out = [];
    for (const h of Array.isArray(list) ? list : []) {
        if (floor !== undefined && (floor < h.from.floor || floor > h.to.floor)) continue;
        if (!isShown(h, doc)) continue;
        const parts = highlightParts(h, doc);
        if (!parts) continue;
        parts.forEach((p, k) => {
            if (floor !== undefined && p.floor !== floor) return;
            out.push({ id: h.id, floor: p.floor, start: p.start, end: p.end, whole: h.whole === true,
                first: k === 0, last: k === parts.length - 1, ...(h.note !== undefined ? { note: h.note } : {}) });
        });
    }
    return out.sort((x, y) => x.floor - y.floor || x.start - y.start || x.end - y.end);
}

/**
 * 从原文切出这条划线的文字（摘抄页用；不管现在显示的是不是那个候选，端点楼按记下的候选切）。
 * @param {string} [joiner='\n']  跨楼时各楼之间用什么连
 * @returns {{parts: {floor: number, swipe: number, start: number, end: number, text: string}[], text: string}|null}  原文不在了 = null
 */
export function sliceHighlight(h, doc, joiner = '\n') {
    const parts = highlightParts(h, doc);
    if (!parts) return null;
    const withText = parts.map(p => ({ ...p, text: doc.text(p.floor, p.swipe).slice(p.start, p.end) }));
    return { parts: withText, text: withText.map(p => p.text).join(joiner) };
}

/**
 * 判重用（backup.js chatSig）：清洗后的划线只留位置、整楼标记和备注，去掉 id、at 和不认识的字段，按位置排好。
 * 所以同一份备份导两遍、或者两边各自给同一段字划过线，签名都一样。没有划线 = null（签名里不加这一项，和划线功能出现之前逐字相同）。
 */
export function highlightSigPart(raw, messages) {
    const { list } = normalizeHighlights(raw, chatDoc(messages));
    if (!list.length) return null;
    const pt = p => [p.floor, p.swipe, p.offset];
    return list.map(h => [pt(h.from), pt(h.to), h.whole === true, h.note ?? ''])
        .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : JSON.stringify(x) > JSON.stringify(y) ? 1 : 0));
}

// ═══════════════════════════ 二、选区对回原文 ═══════════════════════════
//
// 显示一楼时，原文依次经过（ui/pipeline.js displayText → render.js formatMessage → mountMessage）：
//   1. 显示正则（runRegexScripts，markdownOnly 等）：任意替换，状态栏、对话上色、隐藏思维链……替换结果里还会做宏替换
//   2. 引号包 <q>（只加标签，不改字）、\begin{align*} → $$
//   3. showdown（markdown → HTML）：去掉 * _ ~ ` # > 列表符号、链接 / 图片语法；:smile: 这类变成 emoji；转义 & < >；换行变 <br>
//   4. DOMPurify：去掉 <script>、事件属性等；<style> 编码后作用域化，再放回成 <style> 元素
//   5. mountMessage：内容是完整网页的代码块（```html … <html> …```）换成前端卡 iframe（原 <pre> 收进「查看源码」）
//   （自动修复 markdown 默认关，开着时还会补 * 和 "）
// 我们不重放第 3、4 步（showdown / DOMPurify 只在浏览器里有，重放也拿不到逐字的对应），而是分两步：
//   A. 显示正则这一步【精确】追踪（displayMap）：regex.js 给每一处替换报 {位置, 长度, 替换成什么}；没被替换的字一一对应原文；
//      替换出来的字先当作「对不上」，再把替换前后两小段做一次逐字对齐——对话上色（「$1」→ <span>「$1」</span>）这种原样搬过去的字
//      能认回原文，状态栏的标签（「生命值」）认不回来。替换结果里的标签、样式先剥掉再对齐。
//   B. 剩下的 markdown / HTML 这一步用逐字对齐（Myers 差分，求最长公共子序列）：先把显示文字里的 HTML 标签、<style> / <script> 块、
//      注释、前端卡代码块剥掉，HTML 实体（&amp; 等）解码，第 A 步里「对不上」的字也去掉；剩下的和渲染后的可见文字做差分。
//      markdown 只删字、几乎不加字，两边绝大部分逐字相同，差分的「编辑距离」很小，所以快；编辑距离超过上限（ALIGN_MAX_EDITS）时
//      退回贪心的顺序匹配（可能认错个别字）。
// 为什么不用「渲染时带标记」：要改 formatMessage 的输出（任务说明不许），而且 showdown / DOMPurify 会挪动、复制、丢掉标记，未必可靠。
// 为什么不直接拿原文和可见文字做 LCS：状态栏的标签、HTML 里的文字会被当成原文里碰巧相同的字，端点落在状态栏里也能「对上」，
//   违反「正则替换出来的内容里划不了」；而且状态栏那几千字的 HTML 会把编辑距离撑得很大，慢。
//
// 已知对不上（端点落在这些字上 → 划不了；在中间被跨过则整段包进去）：
//   - 显示正则替换出来、又不是原样搬过去的字（状态栏的标签、模板文字、宏展开的值）；
//   - markdown 生成的字：:smile: 变的 emoji、自动编号列表的序号（不在 textContent 里，本来也选不到）；
//   - HTML 实体以外的转义差异、<br> 前后多出来的换行等空白（两端落在对不上的空白上时自动往里缩，见 trimUnmapped）；
//   - 前端卡（iframe）里的内容：在另一个源的沙箱里，主页面读不到选区，可见文字里也不该收它（见 mapFloor 的说明）；
//   - 自动修复 markdown 开着时补上的 * 和 "；
//   - 替换结果里带 {{random}} 这类每次都变的宏：每次渲染的文字不一样，第二段要拿同一次的 displayMap.text 去渲染或比对。
// markdown 符号自动包进选区（expandMarkup）：两端外侧紧挨着的 * _ ~ ` （渲染后看不见的那些）在另一侧也找到配对时一起包进来，
//   所以选中整个「粗体」得到 **粗体**，只选「粗」得到 粗；包完再数一遍，每种符号在区间里必须是偶数个，不成对就退回不包。
//   行首的 # > - 1. 不包。判断是启发式的（不按 CommonMark 的左右侧规则），「**甲**乙 **丙**」从「乙」选到「丙」
//   会把甲后面那个 ** 也包进来（凑巧成对）。

/** 差分的编辑距离上限：超过就退回贪心匹配。1500 时最坏约 9 MB 临时内存、几千万次比较 */
export const ALIGN_MAX_EDITS = 1500;
/** 显示正则每一处替换内部的对齐上限：超过就整段当作「对不上」 */
const SPAN_MAX_EDITS = 400;
/** 贪心退路往前找同一个字最多找多远 */
const GREEDY_WINDOW = 2000;

const identity = n => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };

/**
 * Myers 差分：a、b 两个字符串，返回 b 的每个位置对应 a 的哪个位置（-1 = b 里多出来的）。对应关系是单调递增的（不交叉）。
 * @returns {{map: Int32Array, exact: boolean}}  exact = false：编辑距离超过上限，用的是贪心退路
 */
export function alignTexts(a, b, { maxEdits = ALIGN_MAX_EDITS, fallback = 'greedy' } = {}) {
    const map = new Int32Array(b.length).fill(-1);
    const min = Math.min(a.length, b.length);
    let p = 0;
    while (p < min && a.charCodeAt(p) === b.charCodeAt(p)) { map[p] = p; p++; }
    let s = 0;
    while (s < min - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) { map[b.length - 1 - s] = a.length - 1 - s; s++; }
    const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
    if (myersInto(A, B, map, p, p, maxEdits)) return { map, exact: true };
    if (fallback === 'greedy') greedyInto(A, B, map, p, p);
    return { map, exact: false };
}

function myersInto(A, B, map, offA, offB, maxEdits) {
    const N = A.length, M = B.length;
    if (!N || !M) return true;
    const max = Math.min(N + M, maxEdits);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));   // 这一轮开始前的状态，只存用得到的 k ∈ [-d-1, d+1]
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < N && y < M && A.charCodeAt(x) === B.charCodeAt(y)) { x++; y++; }
            v[off + k] = x;
            if (x >= N && y >= M) { backtrack(trace, N, M, A, B, map, offA, offB); return true; }
        }
    }
    return false;
}

function backtrack(trace, N, M, A, B, map, offA, offB) {
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const V = k => vd[k + d + 1];
        const k = x - y;
        const prevK = (k === -d || (k !== d && V(k - 1) < V(k + 1))) ? k + 1 : k - 1;
        const prevX = V(prevK), prevY = prevX - prevK;
        while (x > prevX && y > prevY) { x--; y--; map[offB + y] = offA + x; }
        if (d > 0) { x = prevX; y = prevY; }
    }
}

function greedyInto(A, B, map, offA, offB) {
    let i = 0;
    for (let j = 0; j < B.length; j++) {
        const c = B.charCodeAt(j);
        const stop = Math.min(A.length, i + GREEDY_WINDOW);
        for (let k = i; k < stop; k++) if (A.charCodeAt(k) === c) { map[offB + j] = offA + k; i = k + 1; break; }
    }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * 把显示文字里渲染后看不见的东西剥掉，留下「可能出现在可见文字里的字」以及每个字来自 text 的哪个位置（再经 src 换成原文位置）。
 * 剥掉：内容是完整网页的围栏代码块（前端卡）、<style> / <script> 块、HTML 注释、HTML 标签（代码块和行内代码里的不剥：那里的 <div> 会原样显示）；
 * src 为 -1 的字（显示正则替换出来、认不回原文的）。HTML 实体解码成一个字，算在 & 的位置上。
 * @param {string} text
 * @param {Int32Array} src  text 的每个位置 → 原文位置（-1 = 对不上）
 * @returns {{text: string, src: Int32Array}}
 */
export function stripMarkup(text, src) {
    const out = [], os = [];
    const push = (ch, at) => { if (src[at] >= 0) { out.push(ch); os.push(src[at]); } };
    const copy = (from, to) => { for (let k = from; k < to; k++) push(text[k], k); };
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        // 围栏代码块：行首（前面最多 3 个空格）``` 或 ~~~，到同样的围栏为止。前端卡整块去掉，别的原样（不剥标签）
        if ((c === '`' || c === '~') && atLineStart(text, i)) {
            const fence = /^(`{3,}|~{3,})[^\n]*\n/.exec(text.slice(i, i + 200));
            if (fence) {
                const mark = fence[1];
                const bodyStart = i + fence[0].length;
                const close = findFenceClose(text, bodyStart, mark);
                if (close) {
                    if (!isFrontend(text.slice(bodyStart, close.start))) copy(i, close.end);
                    i = close.end;
                    continue;
                }
            }
        }
        // 行内代码：一串反引号到同样长度的一串反引号为止，里面原样
        if (c === '`') {
            let r = i; while (r < n && text[r] === '`') r++;
            const run = text.slice(i, r);
            const end = findBacktickRun(text, r, run.length);
            if (end >= 0) { copy(i, end + run.length); i = end + run.length; continue; }
            copy(i, r); i = r; continue;
        }
        if (c === '<') {
            if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
            const block = /^<(style|script)\b[^>]*>/i.exec(text.slice(i, i + 200));
            if (block) {
                const re = new RegExp(`</${block[1]}\\s*>`, 'ig'); re.lastIndex = i + block[0].length;
                const m = re.exec(text);
                i = m ? m.index + m[0].length : n;
                continue;
            }
            const tag = /^<\/?[A-Za-z][^<>]*>/.exec(text.slice(i, i + 4000));
            if (tag) { i += tag[0].length; continue; }
        }
        if (c === '&') {
            const ent = /^&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/.exec(text.slice(i, i + 12));
            if (ent) {
                const body = ent[1];
                let ch = null;
                if (body[0] === '#') {
                    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
                    if (cp > 0 && cp <= 0x10ffff) ch = String.fromCodePoint(cp);
                } else ch = ENTITIES[body.toLowerCase()] ?? null;
                if (ch !== null) { for (const u of ch) for (let q = 0; q < u.length; q++) push(u[q], i); i += ent[0].length; continue; }
            }
        }
        push(c, i);
        i++;
    }
    return { text: out.join(''), src: Int32Array.from(os) };
}

function atLineStart(text, i) {
    let k = i, sp = 0;
    while (k > 0 && text[k - 1] === ' ' && sp < 3) { k--; sp++; }
    return k === 0 || text[k - 1] === '\n';
}

function findFenceClose(text, from, mark) {
    const re = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`, 'gm');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) return null;
    let end = m.index + m[0].length;
    if (text[end] === '\n') end++;
    return { start: m.index, end };
}

function findBacktickRun(text, from, len) {
    let i = from;
    while (i < text.length) {
        const k = text.indexOf('`', i);
        if (k < 0) return -1;
        let r = k; while (r < text.length && text[r] === '`') r++;
        if (r - k === len) return k;
        i = r;
    }
    return -1;
}

/**
 * 跑显示正则，同时记下结果里每个字来自原文的哪个位置（第 A 步，见上）。
 * text 一定等于 runRegexScripts(raw, scripts, options) 的结果（同一次调用的产物）。
 * @param {string} raw  原文
 * @param {import('./types.js').RegexScript[]} scripts
 * @param {import('./types.js').RegexRunOptions} options  和显示时 runRegexScripts 用的一样（ui/pipeline.js displayText）
 * @returns {{text: string, src: Int32Array}}
 */
export function displayMap(raw, scripts, options) {
    const r = String(raw ?? '');
    let text = r, src = identity(r.length), lost = false;
    const final = runRegexScripts(r, scripts, {
        ...(options ?? {}),
        onSpans: ({ before, after, spans }) => {
            if (lost) return;
            if (before !== text) { lost = true; return; }
            const next = applySpans(before, src, spans);
            if (next.text !== after) { lost = true; return; }
            ({ text, src } = next);
        },
    });
    // 万一追踪对不上（不应该发生）：只按公共前缀 / 后缀认，中间整段对不上
    if (lost || text !== final) {
        text = final;
        src = new Int32Array(final.length).fill(-1);
        const d = diffRange(r, final) ?? { start: r.length, oldEnd: r.length, newEnd: r.length };
        for (let k = 0; k < d.start; k++) src[k] = k;
        for (let k = d.newEnd; k < final.length; k++) src[k] = k - d.newEnd + d.oldEnd;
    }
    return { text, src };
}

/** 一个正则脚本的全部替换 → 新文字和新的来源表 */
function applySpans(before, src, spans) {
    const pieces = [], srcs = [];
    let pos = 0;
    for (const sp of [...spans].sort((x, y) => x.at - y.at)) {
        if (!isInt(sp.at) || sp.at < pos) return { text: null, src: null };
        pieces.push(before.slice(pos, sp.at)); srcs.push(src.subarray(pos, sp.at));
        const out = String(sp.out);
        const outSrc = new Int32Array(out.length).fill(-1);
        // 替换前后两小段各自剥掉标签再逐字对齐：原样搬过去的字认回来（继承替换前那个字的来源）
        const m = stripMarkup(before.slice(sp.at, sp.at + sp.len), identity(sp.len));
        const o = stripMarkup(out, identity(out.length));
        const { map, exact } = alignTexts(m.text, o.text, { maxEdits: SPAN_MAX_EDITS, fallback: 'none' });
        if (exact) for (let j = 0; j < map.length; j++) if (map[j] >= 0) outSrc[o.src[j]] = src[sp.at + m.src[map[j]]];
        pieces.push(out); srcs.push(outSrc);
        pos = sp.at + sp.len;
    }
    pieces.push(before.slice(pos)); srcs.push(src.subarray(pos));
    const text = pieces.join('');
    const all = new Int32Array(text.length);
    let k = 0;
    for (const s of srcs) { all.set(s, k); k += s.length; }
    return { text, src: all };
}

/**
 * 一楼的对照表（第 B 步）：渲染后可见文字的每个位置对应原文的哪个位置。
 * visible 由界面给：.mes_text 里所有文字节点按文档顺序连起来（= textContent 的拼法，不是 innerText），
 * 但要【跳过】<style>、<script> 和前端卡（.smalltalk-frontend：iframe 和收起来的「查看源码」）里的文字节点。
 * 界面记下每个文字节点在 visible 里从第几个字开始，就能把 DOM 选区（节点 + 偏移）换成 visible 的下标，反过来也一样。
 * @param {string} raw      原文（ChatMessage.content，或别的候选的原文）
 * @param {string} visible  可见文字（见上）
 * @param {{display?: {text: string, src: Int32Array}}} [opts]  display：displayMap 的结果；不给 = 没有显示正则（显示文字就是原文）
 * @returns {import('./types.js').FloorMap}
 */
export function mapFloor(raw, visible, { display } = {}) {
    const r = String(raw ?? ''), v = String(visible ?? '');
    const disp = display ?? { text: r, src: identity(r.length) };
    const stripped = stripMarkup(disp.text, disp.src);
    const { map: m2, exact } = alignTexts(stripped.text, v);
    const map = new Int32Array(v.length).fill(-1);
    const seen = new Uint8Array(r.length);
    let last = -1;
    for (let j = 0; j < v.length; j++) {
        const at = m2[j] >= 0 ? stripped.src[m2[j]] : -1;
        // 防御：对应关系必须单调递增（差分本身保证；这里挡住来源表里万一出现的倒序）
        if (at > last && at < r.length) { map[j] = at; seen[at] = 1; last = at; }
    }
    return { raw: r, visible: v, map, seen, exact };
}

const isHigh = c => c >= 0xd800 && c <= 0xdbff;
const isLow = c => c >= 0xdc00 && c <= 0xdfff;
const MD_WRAP = new Set(['*', '_', '~', '`']);
const isSpace = ch => /\s/.test(ch);

/** 端点不切开一个 emoji（UTF-16 代理对）：两端各自往外扩 */
function snapSurrogates(raw, start, end) {
    if (start > 0 && start < raw.length && isLow(raw.charCodeAt(start)) && isHigh(raw.charCodeAt(start - 1))) start--;
    if (end > 0 && end < raw.length && isHigh(raw.charCodeAt(end - 1)) && isLow(raw.charCodeAt(end))) end++;
    return [start, end];
}

/** 选区两头落在「对不上的空白」上（段落之间的换行之类）：往里缩到第一个 / 最后一个不是这种空白的字 */
function trimUnmapped(fm, vs, ve) {
    while (vs < ve && fm.map[vs] < 0 && isSpace(fm.visible[vs])) vs++;
    while (ve > vs && fm.map[ve - 1] < 0 && isSpace(fm.visible[ve - 1])) ve--;
    return [vs, ve];
}

/**
 * markdown 符号自动包进选区：两端外侧紧挨着、渲染后看不见的 * _ ~ ` 那一串，在另一侧也找到配对时包进来（说明见上）。
 * openStart / openEnd：这一头是开着的（跨楼时 from 楼的选区一直到楼尾、to 楼的从楼头开始）——那一头的范围按整楼算。
 */
function expandMarkup(raw, seen, start, end, { openStart = false, openEnd = false } = {}) {
    const lo = openStart ? 0 : start, hi = openEnd ? raw.length : end;
    let l = start; while (l > 0 && MD_WRAP.has(raw[l - 1]) && !seen[l - 1]) l--;
    let r = end; while (r < raw.length && MD_WRAP.has(raw[r]) && !seen[r]) r++;
    const rev = s => [...s].reverse().join('');
    let ns = start, ne = end;
    if (!openStart) {
        for (let k = start - l; k > 0; k--) {
            const closer = rev(raw.slice(start - k, start));
            const at = raw.indexOf(closer, start);
            if (at >= 0 && at + k <= Math.max(hi, r)) { ns = start - k; break; }
        }
    }
    if (!openEnd) {
        for (let k = r - end; k > 0; k--) {
            const opener = rev(raw.slice(end, end + k));
            const at = raw.lastIndexOf(opener, end - k);
            if (at >= Math.min(lo, ns) && at >= 0 && at + k <= end) { ne = end + k; break; }
        }
    }
    // 再核对一次配对：包进来之后，区间里每种看不见的符号都得是偶数个。「**粗体字**中间*斜体*」选「粗体字中间」时，
    // 右边紧挨的那个 * 是「斜体」的开头，上面的配对查找会误认成前面 ** 的一半——数一下就知道包了反而不成对
    const balanced = (s, e) => {
        const n = { '*': 0, _: 0, '~': 0, '`': 0 };
        for (let k = s; k < e; k++) if (!seen[k] && MD_WRAP.has(raw[k])) n[raw[k]]++;
        return Object.values(n).every(x => x % 2 === 0);
    };
    const span = (s, e) => [openStart ? 0 : s, openEnd ? raw.length : e];
    for (const [s, e] of [[ns, ne], [ns, end], [start, ne]]) if (balanced(...span(s, e))) return [s, e];
    return [start, end];
}

/**
 * 一楼之内的选区（可见文字的 [vs, ve)）→ 原文区间。两端都要对得上；中间有对不上的（状态栏）整段包进去；markdown 符号自动包进去。
 * @returns {{ok: true, start: number, end: number} | {ok: false, reason: 'empty'|'start'|'end'}}
 *   reason：'start' / 'end' = 那一头落在对不上的字上（正则替换出来的内容等）→ 界面提示「这里划不了」
 */
export function selectionToRaw(fm, vs, ve) {
    const V = fm.visible.length;
    vs = Math.max(0, Math.min(V, vs | 0)); ve = Math.max(0, Math.min(V, ve | 0));
    if (vs > ve) [vs, ve] = [ve, vs];
    [vs, ve] = trimUnmapped(fm, vs, ve);
    if (vs >= ve) return { ok: false, reason: 'empty' };
    const s = fm.map[vs], e = fm.map[ve - 1];
    if (s < 0) return { ok: false, reason: 'start' };
    if (e < 0) return { ok: false, reason: 'end' };
    let [start, end] = snapSurrogates(fm.raw, s, e + 1);
    [start, end] = expandMarkup(fm.raw, fm.seen, start, end);
    return { ok: true, start, end };
}

/** 跨楼选区的开头（这一楼从 vs 一直选到楼尾）→ 原文位置 */
export function selectionStartToRaw(fm, vs) {
    const V = fm.visible.length;
    let [a] = trimUnmapped(fm, Math.max(0, Math.min(V, vs | 0)), V);
    if (a >= V) return { ok: false, reason: 'empty' };
    if (fm.map[a] < 0) return { ok: false, reason: 'start' };
    let [start] = snapSurrogates(fm.raw, fm.map[a], fm.map[a] + 1);
    [start] = expandMarkup(fm.raw, fm.seen, start, fm.raw.length, { openEnd: true });
    return { ok: true, offset: start };
}

/** 跨楼选区的结尾（这一楼从楼头选到 ve）→ 原文位置 */
export function selectionEndToRaw(fm, ve) {
    const V = fm.visible.length;
    let [, b] = trimUnmapped(fm, 0, Math.max(0, Math.min(V, ve | 0)));
    if (b <= 0) return { ok: false, reason: 'empty' };
    if (fm.map[b - 1] < 0) return { ok: false, reason: 'end' };
    let [, end] = snapSurrogates(fm.raw, fm.map[b - 1], fm.map[b - 1] + 1);
    [, end] = expandMarkup(fm.raw, fm.seen, 0, end, { openStart: true });
    return { ok: true, offset: end };
}

/**
 * 界面上的一个选区（两端各在哪一楼、哪个候选、可见文字的第几个字）→ 划线的两个端点。两端顺序不限（会自动排好）。
 * @param {{floor: number, swipe: number, map: import('./types.js').FloorMap, offset: number}} a
 * @param {{floor: number, swipe: number, map: import('./types.js').FloorMap, offset: number}} b
 * @returns {{ok: true, from: import('./types.js').HighlightPoint, to: import('./types.js').HighlightPoint} | {ok: false, reason: string, floor: number}}
 */
export function rangeFromSelection(a, b) {
    if (a.floor > b.floor || (a.floor === b.floor && a.offset > b.offset)) [a, b] = [b, a];
    if (a.floor === b.floor) {
        const r = selectionToRaw(a.map, a.offset, b.offset);
        if (!r.ok) return { ok: false, reason: r.reason, floor: a.floor };
        return { ok: true, from: { floor: a.floor, swipe: a.swipe, offset: r.start }, to: { floor: b.floor, swipe: b.swipe, offset: r.end } };
    }
    const s = selectionStartToRaw(a.map, a.offset);
    if (!s.ok) return { ok: false, reason: s.reason, floor: a.floor };
    const e = selectionEndToRaw(b.map, b.offset);
    if (!e.ok) return { ok: false, reason: e.reason, floor: b.floor };
    return { ok: true, from: { floor: a.floor, swipe: a.swipe, offset: s.offset }, to: { floor: b.floor, swipe: b.swipe, offset: e.offset } };
}

/**
 * 原文区间 [rs, re) → 可见文字区间（画高亮用）。第一个 / 最后一个落在区间里的可见字之间的全部可见字都算（中间对不上的也包进去）。
 * 一个可见字都不在里面（划的整段渲染后都看不见）= null。整楼划线不要用它，直接画整楼 [0, visible.length)。
 * @returns {{start: number, end: number}|null}
 */
export function rawToVisible(fm, rs, re) {
    let first = -1, last = -1;
    for (let j = 0; j < fm.map.length; j++) {
        const at = fm.map[j];
        if (at >= rs && at < re) { if (first < 0) first = j; last = j; }
        else if (at >= re) break;
    }
    return first < 0 ? null : { start: first, end: last + 1 };
}
