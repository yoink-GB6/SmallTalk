// 便签的纯逻辑：不碰 DOM、不碰存储，Node 里能直接跑（test/notes.test.mjs）。
// 界面在 src/ui/tab-notes.js（挂在「人设」页下方的「便签」一节）；数据形状和存储规则见 types.js 的 GlobalRecord.notes / Note。
// 下面的 Markdown 导出 / 导入函数：界面精简后界面上没有入口了，函数和测试先留着（以后要加回来不用重写）。
//
// 要点：
//   - 便签是全局的（不跟着卡和存档走），存在全局记录的 notes 字段，是一个数组，顺序就是显示顺序。
//   - 一条都没有时【不写】这个字段（和多人设的 personas 同一个思路：不用便签的人，存储里看不出区别；
//     migrate.js 的 isPristineGlobal 也就不会因为多了个空数组而以为用户改过设置）。这条规则由 UI 层执行（tab-notes.js 的 commit），
//     这里的函数只管数组本身。
//   - 不发给模型：assemble.js / pipeline.js 完全不知道它的存在。
//   - 所有函数都返回新数组 / 新对象，不改输入（UI 层拿结果去换 state.notes）。
//   - 要生成 id、取当前时间的函数，id 和时间由调用方传进来，这样这里保持纯函数、测试结果固定。

import { UNSAFE_KEYS } from './migrate.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** 认识的六个字段（types.js Note） */
const KNOWN = ['id', 'title', 'body', 'done', 'createdAt', 'doneAt'];
/** 赋给对象时会改原型、而不是加字段的键（migrate.js 的 UNSAFE_KEYS，只有一份名单） */
const UNSAFE = UNSAFE_KEYS;

/**
 * 标题是单行的（界面上是输入框）：所有「换行一类」的字符都压成一个空格。
 * 除了 \r \n，还有 U+2028 / U+2029（行分隔符 / 段分隔符）、U+0085（NEL）、竖向制表 \v、换页 \f——
 * 它们在 JS 的正则里同样算「行终止符」或会被编辑器当成换行，留在标题里会让 Markdown 导出的那一行读回来时断开。
 * 新增、改标题、读档 / 导入时的规范化、导出、读 Markdown 都用这一个函数，几处的结果才一致。
 */
// （正则用 fromCharCode 拼出来，不在源码里直接写这两个字符：它们在文本里看不见，编辑器 / 工具还可能把它们当成真的换行）
const LINE_BREAKS = new RegExp(`[\\r\\n\\v\\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+`, 'g');
export const oneLine = s => String(s ?? '').replace(LINE_BREAKS, ' ');

/**
 * 读进来的一条便签整理成标准形状 {id, title, body, done, createdAt, doneAt, ...}。
 * 认不出来的（不是对象；标题和内容都不是文字）返回 null，调用方丢掉它。
 * 认识的六个字段照旧校验、补默认值；【不认识的字段原样带着】（深拷贝）：以后的版本给便签加了字段，
 * 旧版本打开一次、存一次也不会把它们永久丢掉（向前兼容，和 global 里不认识的字段原样保留是同一个道理）。
 * 只挡 __proto__ / constructor / prototype：它们一旦被赋给别的对象，换掉的是那个对象的原型。
 * 做法是在一个新对象上逐个拷贝自有键，而不是在可能被污染的输入上 delete。
 * @param {any} raw
 * @param {{newId: () => string, now: number}} deps  缺 id / 时间时用
 */
export function normalizeNote(raw, { newId, now }) {
    if (!isObj(raw)) return null;
    const hasTitle = typeof raw.title === 'string', hasBody = typeof raw.body === 'string';
    if (!hasTitle && !hasBody) return null;
    const done = raw.done === true;
    const createdAt = isTime(raw.createdAt) ? raw.createdAt : now;
    const out = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        title: hasTitle ? oneLine(raw.title) : '',
        body: hasBody ? raw.body.replace(/\r\n?/g, '\n') : '',
        done,
        createdAt,
        // 没完成时一律 null；完成了却没有合法的完成时间（手改的数据）→ 用创建时间顶上，总比没有好
        doneAt: done ? (isTime(raw.doneAt) ? raw.doneAt : createdAt) : null,
    };
    for (const k of Object.keys(raw)) {
        if (KNOWN.includes(k) || UNSAFE.includes(k)) continue;
        // 拷贝不了的值（JSON 里不会有，只防万一）就不带：一条便签不能因为一个附加字段整条丢掉
        try { out[k] = structuredClone(raw[k]); } catch { /* 跳过这个字段 */ }
    }
    return out;
}

/**
 * 整个列表的容错：不是数组 → []；坏的条目丢掉；id 重复的（手改 / 合并出错的数据）后面那条换个新 id，内容不丢。
 * 读档、恢复备份时都过一遍它：一条坏数据不能让整页打不开。
 * @param {any} raw
 * @param {{newId: () => string, now: number}} deps
 * @returns {Note[]}
 */
export function normalizeNotes(raw, deps) {
    if (!Array.isArray(raw)) return [];
    const out = [], seen = new Set();
    for (const r of raw) {
        const n = normalizeNote(r, deps);
        if (!n) continue;
        if (seen.has(n.id)) n.id = freshId(seen, deps.newId);
        seen.add(n.id);
        out.push(n);
    }
    return out;
}

/** 生成一个不在 taken 里的 id（newId 一般是 uuid，撞上的概率可以忽略；这里只是兜底，最多试几次） */
function freshId(taken, newId) {
    let id = newId();
    for (let i = 0; i < 20 && taken.has(id); i++) id = newId();
    return id;
}

// ───────────────────────────── 增删改 ─────────────────────────────

/**
 * 新增一条，放在最后（像预设条目一样从上往下排，新记的在底下）。
 * 标题去掉首尾空白后是空的 → 返回 null（不加空便签）。
 * @param {Note[]} list
 * @param {{id: string, title: string, body?: string, now: number}} init
 */
export function addNote(list, { id, title, body = '', now }) {
    const t = oneLine(title).trim();
    if (!t) return null;
    return [...list, { id, title: t, body: String(body), done: false, createdAt: now, doneAt: null }];
}

/**
 * 输入框里的多行文字 → 一行一条的标题（新增便签用：输入框是多行文本块，提示「一行一条」）。
 * 按所有换行类字符拆（和 oneLine 认的一样，所以拆出来的每一段都是单行），去首尾空白，空行忽略。
 * @returns {string[]}
 */
export function splitNoteLines(text) {
    return String(text ?? '').split(LINE_BREAKS).map(s => s.trim()).filter(Boolean);
}

/**
 * 一次加好几条（splitNoteLines 拆出来的每一行一条，按原来的顺序放在最后）。一行有字的都没有 → 返回 null。
 * @param {Note[]} list
 * @param {{text: string, newId: () => string, now: number}} init
 */
export function addNotesFromText(list, { text, newId, now }) {
    const titles = splitNoteLines(text);
    if (!titles.length) return null;
    let out = list;
    for (const t of titles) out = addNote(out, { id: newId(), title: t, now });
    return out;
}

/** 改标题 / 内容（patch 里给哪个改哪个，只认这两个字段）。id 不存在 → 原样返回（新数组） */
export function updateNote(list, id, patch) {
    const p = isObj(patch) ? patch : {};
    return list.map(n => n.id !== id ? n : {
        ...n,
        ...(typeof p.title === 'string' ? { title: oneLine(p.title) } : {}),
        ...(typeof p.body === 'string' ? { body: p.body } : {}),
    });
}

/** 打勾 / 取消。打勾时记下完成时间，取消时 doneAt 回到 null */
export function setDone(list, id, done, now) {
    return list.map(n => n.id !== id ? n : { ...n, done: !!done, doneAt: done ? (n.done && isTime(n.doneAt) ? n.doneAt : now) : null });
}

/** 删一条 */
export function deleteNote(list, id) {
    return list.filter(n => n.id !== id);
}

/** 删掉所有已完成的。返回 {list, removed: 删了几条} */
export function clearDone(list) {
    const next = list.filter(n => !n.done);
    return { list: next, removed: list.length - next.length };
}

/**
 * 上移（dir = -1）/ 下移（dir = 1）一条。
 * visibleIds：界面上现在看得见的那些（筛选了 / 隐藏了已完成时）。给了的话就和「看得见的上一条 / 下一条」换位置，
 * 不然隐藏着的条目夹在中间时，点一下上移看起来什么都没发生。到头了 → 原样返回（新数组）。
 * @param {Note[]} list
 * @param {string} id
 * @param {-1|1} dir
 * @param {string[]} [visibleIds]
 */
export function moveNote(list, id, dir, visibleIds) {
    const out = [...list];
    const i = out.findIndex(n => n.id === id);
    if (i < 0) return out;
    const vis = visibleIds ? new Set(visibleIds) : null;
    let j = i + dir;
    while (j >= 0 && j < out.length && vis && !vis.has(out[j].id)) j += dir;
    if (j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
}

// ───────────────────────────── 查看 ─────────────────────────────

/**
 * 按文字筛选（标题和内容里找，不分大小写；空的筛选词 = 不筛），可选隐藏已完成的。
 * @param {Note[]} list
 * @param {string} query
 * @param {{hideDone?: boolean}} [opts]
 */
export function filterNotes(list, query, { hideDone = false } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    return list.filter(n => (!hideDone || !n.done) && (!q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)));
}

/** 共几条、已完成几条（页面上那行小字） */
export function countNotes(list) {
    return { total: list.length, done: list.filter(n => n.done).length };
}

// ───────────────────────────── 导出 / 导入（Markdown 文本） ─────────────────────────────
//
// 格式就是常见的 Markdown 任务列表，别的笔记软件（Obsidian、Typora、GitHub……）也认：
//   - [ ] 没做完的标题
//   - [x] 做完了的标题
//     详细内容的每一行前面缩进两个空格
//
//     内容里的空行写成只有两个空格的行（这样它仍然属于上一条；有的编辑器会删掉行尾空格，所以读的时候也认真正的空行）
// 读的时候：
//   - 「- [ ] / - [x] / - [X]」开头的行是一条新的；「* 」「+ 」开头也认。没有方框的「- 文字」当作没做完的一条（方便导入普通列表）。
//   - 带方框但方框后面什么都没有的「- [ ]」是一条【标题为空】的便签（编辑时把标题清空了的那种）：
//     导出时就这样写，读回来仍是空标题，和原来那条「完全相同」，再导入不会多出一条。
//     没有方框、也没有文字的「- 」不是便签（普通列表里的空项），照旧忽略。
//   - 紧跟在一条后面、以至少两个空格或一个 Tab 开头的行是它的内容（去掉开头那一层缩进）。
//   - 空行：如果后面还有这一条的缩进内容，就算内容里的空行；否则就是条目之间的分隔，扔掉。
//   - 其余的行（标题 # …、正文段落、没跟在条目后面的缩进行）一律忽略，并数一数忽略了几行，告诉用户。
//
// 为什么条目行不用一个正则来认：以前的 /^[-*+][ \t]+(?:\[([ xX])\][ \t]*)?(.*)$/ 在「- 」后面跟一大串空格、
// 末尾再有一个 . 匹配不了的字符（比如 U+2028）时会反复回溯，耗时随空格数平方增长（4 万个空格两秒多）。
// 下面的 parseItemLine 只从左到右扫一遍，长度再长也是线性的。

const INDENT_RE = /^(?: {2}|\t)/;

/** 从 i 开始跳过空格和 Tab，返回第一个不是它们的位置 */
function skipBlank(line, i) {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    return i;
}

/**
 * 一行是不是条目行。是 → {box: 有没有方框, done, title}；不是 → null。
 * 规则和上面的说明一致：「-」「*」「+」之后至少一个空格或 Tab；可选的「[ ]」「[x]」「[X]」；剩下的是标题。
 */
function parseItemLine(line) {
    if (!'-*+'.includes(line[0] ?? '\0')) return null;
    let i = skipBlank(line, 1);
    if (i === 1) return null;   // 「-」后面必须先有空白，「-abc」「--」不是列表项
    let box = false, done = false;
    if (line[i] === '[' && line[i + 2] === ']' && ' xX'.includes(line[i + 1] ?? '\0')) {
        box = true;
        done = line[i + 1] !== ' ';
        i = skipBlank(line, i + 3);
    }
    return { box, done, title: oneLine(line.slice(i)).trim() };
}

/** 读 Markdown 文件的大小上限：便签是随手记的短文字，2 MB 已经是几万条；再大多半是选错了文件，读进来只会卡住页面 */
export const MAX_NOTES_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 便签 → Markdown 文本（每条一行，内容缩进跟在后面；末尾带一个换行）。
 * 标题空着的写成「- [ ]」（后面什么都没有），读回来仍是空标题——见上面「读的时候」。
 * 只有标题、内容、是否完成三样进文件；id、时间和不认识的附加字段不进（Markdown 任务列表没有地方放它们）。
 * @param {Note[]} list
 */
export function notesToMarkdown(list) {
    const lines = [];
    for (const n of list) {
        const t = oneLine(n.title).trim();
        lines.push(`- [${n.done ? 'x' : ' '}]${t ? ` ${t}` : ''}`);
        if (n.body) for (const l of n.body.replace(/\r\n?/g, '\n').split('\n')) lines.push(`  ${l}`);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Markdown 文本 → [{title, body, done}]（还没有 id 和时间，合并时由 mergeNotes 补上）。
 * @param {string} text
 * @returns {{items: {title: string, body: string, done: boolean}[], ignored: number}}  ignored：看不懂、忽略掉的非空行数
 */
export function parseNotesMarkdown(text) {
    const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const items = [];
    let cur = null;          // 正在读的那一条：{title, done, body: string[]}
    let blanks = 0;          // 攒着的空行（要看后面有没有缩进内容才知道它们算不算内容）
    let ignored = 0;
    const finish = () => {
        if (cur) items.push({ title: cur.title, body: cur.body.join('\n'), done: cur.done });
        cur = null; blanks = 0;
    };
    for (const line of lines) {
        if (cur && INDENT_RE.test(line)) {
            // 缩进行：这一条的内容，去掉一层缩进后原样保留（里面再多的缩进、行尾空格都不动，导出再导入才能一字不差）。
            // 之前攒着的真空行这时才确认是内容里的空行；但标题和第一行内容之间的真空行不算（手写文件里常见，导出不会写出这种空行）
            if (cur.body.length) for (; blanks > 0; blanks--) cur.body.push('');
            blanks = 0;
            cur.body.push(line.replace(INDENT_RE, ''));
            continue;
        }
        if (!line.trim()) { if (cur) blanks++; continue; }
        const m = parseItemLine(line);
        // 有标题的条目；或者带方框、标题为空的条目（空标题便签导出后的样子）
        if (m && (m.title || m.box)) {
            finish();
            cur = { title: m.title, done: m.done, body: [] };
            continue;
        }
        // 认不出来的行：它也结束了上一条（之后再出现的缩进行不会被错接到上一条上）
        finish();
        ignored++;
    }
    finish();   // 一条结束时还攒着的真空行是条目之间的分隔，finish 直接扔掉
    return { items, ignored };
}

// ───────────────────────────── 合并 ─────────────────────────────

/**
 * 「同一条」：标题和内容都一样。不看 id 和时间（Markdown 文件里没有这些），也【不看是否完成】（用户 2026-11-22 定的）：
 * 打勾只是这条便签的状态，不是内容——在一边打了勾、另一边没打，仍是同一条。重复时保留本机那条和它的完成状态，
 * 不会因为状态不同多出一条一模一样的便签。整体备份恢复和「便签」页导入 Markdown 都用这条规则
 * （所以导入一条「已完成」的、本机有同内容「未完成」的，也算重复跳过，本机那条照旧未完成）。
 * 标题比较前去掉首尾空白：导出 / 导入时标题会被 trim，不然一条标题末尾带空格的便签导出再导入会被当成新的。
 */
const sameKey = n => JSON.stringify([n.title.trim(), n.body]);

/**
 * 把一批便签追加到现有列表末尾（从 Markdown 导入、从整体备份恢复到已有数据的浏览器时用），不覆盖、不删除、不改顺序。
 *   - 和现有的是同一条（sameKey：标题 + 内容，不看是否完成）的跳过；这一批里前面刚加过的也算，同一份文件导两次不会多出东西。
 *   - 带 id 的（来自备份）：id 没被占用就沿用，撞了就换新 id。不带 id 的（来自 Markdown）生成新 id。
 *   - 每一条先过 normalizeNote：形状不对的丢掉，不算「跳过」，算 invalid。
 * @param {Note[]} list   现有的（已经规范化过）
 * @param {any[]} items   要加进来的
 * @param {{newId: () => string, now: number}} deps
 * @returns {{list: Note[], added: number, skipped: number, invalid: number}}
 */
export function mergeNotes(list, items, deps) {
    const out = [...list];
    const have = new Set(out.map(sameKey));
    const ids = new Set(out.map(n => n.id));
    let added = 0, skipped = 0, invalid = 0;
    for (const raw of Array.isArray(items) ? items : []) {
        // 先不让 normalizeNote 生成 id：带来的 id 撞了要换，没带的才新生成，都在下面统一处理
        const n = normalizeNote(raw, { newId: () => '', now: deps.now });
        if (!n) { invalid++; continue; }
        const k = sameKey(n);
        if (have.has(k)) { skipped++; continue; }
        if (!n.id || ids.has(n.id)) n.id = freshId(ids, deps.newId);
        have.add(k); ids.add(n.id);
        out.push(n);
        added++;
    }
    return { list: out, added, skipped, invalid };
}
