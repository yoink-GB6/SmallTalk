// 检查器「世界书」页：条目触发情况、扫描设置、额外导入的世界书（开关、生效范围、绑定到卡、改名），以及直接编辑条目。
//
// 页面结构：顶上扫描设置和一行小结；下面每本书一个可折叠的块（卡内嵌的那本 + 每本额外世界书）。
//   块的头部一行：书名、条目数、这次触发了几条、状态标记（生效 / 已关闭 / 对这张卡不生效 / 没有绑定任何卡）、控件。
//   展开后才画条目表格（几十本书全展开会很长，也很慢）。
// 默认展开：卡内嵌的那本，以及绑定到当前卡的额外世界书；其余折叠。用户点过的记在内存里（按书对象），切卡时清掉、重新按规则来。
// 额外世界书的开关 / 范围 / 绑定的数据规则在 src/books.js；哪些书参与拼装由 pipeline.js allEntries 决定（isBookActiveFor）。

import { $, h, toast } from './dom.js';
import { state, ui, save, persist } from './state.js';
import { allEntries, refreshPreview, cardBookActive } from './pipeline.js';
import { splitKeywords } from '../keywords.js';
import { defaultEntry } from '../card.js';
import { exportBookFile } from './export-st.js';
import { importFiles } from './importer.js';     // 循环依赖：只在函数体里调用
import { bookScopeOf, isBookActiveFor, setBookScope, setBookName } from '../books.js';
import { listCards } from './archive.js';        // 循环依赖：只在函数体里调用
import { restoreActive } from './backup.js';     // 同上

// ───────────────────────────── 检查器：世界书 ─────────────────────────────

export const POSITION_NAMES = ['角色定义前', '角色定义后', '作者注释上', '作者注释下', '@深度', '示例前', '示例后', 'outlet'];
export const SKIP_REASONS = {
    'disabled': '已禁用', 'no-key-match': '关键词未命中', 'secondary-failed': '次要关键词不满足',
    'probability': '概率未通过',
};
const LOGIC_NAMES = ['任一（AND ANY）', '非全部（NOT ALL）', '全无（NOT ANY）', '全部（AND ALL）'];
const ROLE_NAMES = ['system', 'user', 'assistant'];

// 编辑说明与已知局限：
// - allEntries() 返回的是【原对象】（只是把几个数组拍平），所以这里直接改条目对象就是改 state，
//   不会改到副本；scanWorldInfo 下一次预览读到的就是新值。
// - 改的是归一化后的 card.worldEntries / books[].entries，**不回写 card.raw**（原始卡 JSON 里的 character_book）。
//   导出角色卡时 exportCardJson 会以 raw 为底、把这里的改动合并回去（不修改 raw 本身）；
//   但 raw 还被前端卡脚本的 getCharData()（frame-host.js）读到，所以前端卡看到的世界书仍是改之前的。
// - 展开状态记在条目对象本身上（WeakSet）：预览刷新引起的重渲染不会丢；切卡换了对象，展开状态自然清掉。
const openEntries = new WeakSet();

// ── 书的展开 / 折叠（只在内存里）──
// 用户手动点过的：书对象 → true / false（卡内嵌的那本用 CARD_BOOK 这个键）。没点过的按 defaultOpen 的规则。
// 换了卡（persist.cardId 或 state.card 对象变了）就清空，重新按规则来。开关 / 范围 / 绑定是原地改书对象的（books.js setBookScope），
// 所以改这些不会让展开状态丢。备份恢复后 state.books 换成新对象，展开状态自然回到默认。
const CARD_BOOK = {};
let openBooks = new WeakMap();
let openFor = { cardId: undefined, card: undefined };

// ── 批量模式（顶上「批量」）──
// 只在内存里。勾选的是【额外世界书】的书对象（卡自带那本不参与：它是卡的一部分，删不掉）。
// 进入批量模式时每本额外世界书头部出现勾选框；导出 / 删除作用于勾选的书；删除先确认一次。
const batch = { on: false, sel: new Set() };
const batchSelected = () => state.books.filter(b => batch.sel.has(b));   // 过滤掉已经不在的书（切卡 / 恢复备份后）

// ── 卡名（显示「已绑定：A、B」用）──
// 卡的目录在存储里（listCards 会把每张卡的记录读一遍，带着头像），不能每次重画都读：从别的页切进来（force）时读一次；
// 发现书里绑着一个没见过的 id 时补读一次（同一批没见过的 id 只补读一次，免得已删掉的卡让它反复读）。
// 当前卡的名字直接用 state 里的。读不到的 id = 那张卡已经不在了，不显示。
let cardNames = new Map();
let namesLoading = false;
const namesTried = new Set();

function loadCardNames() {
    if (namesLoading) return;
    namesLoading = true;
    // 读完（成功或失败）先把 namesLoading 放下再重画：bookStatus 看它决定要不要暂缓「没有绑定任何卡」的结论
    const done = changedNames => {
        namesLoading = false;
        const redo = changedNames || statusDeferred;
        statusDeferred = false;
        if (redo && $('#tabs button.active')?.dataset.tab === 'world') renderWorldTab();
    };
    listCards().then(list => {
        const next = new Map(list.map(c => [c.id, c.name]));
        const same = next.size === cardNames.size && [...next].every(([k, v]) => cardNames.get(k) === v);
        cardNames = next;
        done(!same);
    }).catch(e => { console.error('读卡名失败', e); done(false); });
}

/** 这个卡 id 现在显示成什么名字；卡已经不在了返回 null */
function cardNameOf(id) {
    if (id === persist.cardId && state.card) return state.card.name;
    return cardNames.get(id) ?? null;
}

/** 条目的所有来源：当前卡内嵌的 + 额外导入的世界书。每个来源给出它的数组（改它就是改 state）。 */
function sources() {
    const out = [];
    if (state.card) {
        out.push({
            title: '角色卡内嵌世界书', list: state.card.worldEntries ??= [], key: CARD_BOOK,
            // 新条目的 book 字段沿用该卡现有条目的（用于界面里区分来源）
            bookName: () => state.card.worldEntries[0]?.book ?? state.card.raw?.data?.character_book?.name ?? '',
            // 导出时的书名（= 文件名）：卡的 worldName，没有就「卡名 的世界书」
            exportName: () => state.card.worldName || `${state.card.name} 的世界书`,
            cardBook: true,
        });
    }
    for (const b of state.books) out.push({ title: b.name, list: b.entries, key: b, bookName: () => b.name, exportName: () => b.name, book: b });
    return out;
}

/** 额外世界书相对当前卡的状态：'on' 生效 / 'off' 已关闭 / 'unbound' 只对指定的卡、但一张（还在的）卡都没绑 / 'other' 只对别的卡生效 */
function bookStatus(b) {
    const s = bookScopeOf(b);
    if (!s.enabled) return 'off';
    if (isBookActiveFor(b, persist.cardId)) return 'on';
    if (s.scope === 'cards' && !s.cards.some(id => cardNameOf(id) !== null)) {
        // 「读早了」：卡名列表还在读（刚切进本页、或在补读没见过的 id），绑定的卡可能都还在，只是名字没回来。
        // 这时不下「没有绑定任何卡（对谁都不生效）」的结论，先按「绑定在别的卡」显示；读完后重画一次（loadCardNames 看 statusDeferred）
        if (namesLoading && s.cards.length) { statusDeferred = true; return 'other'; }
        return 'unbound';
    }
    return 'other';
}
/** bookStatus 因为卡名还没读回来而暂时显示成「别的卡」：读完卡名后不管有没有变化都要重画一次 */
let statusDeferred = false;
const STATUS_TEXT = { on: '生效', off: '已关闭', unbound: '没有绑定任何卡', other: '对这张卡不生效' };
const STATUS_TIP = {
    on: '这本书参与这次拼装', off: '关着：不参与任何聊天的拼装（条目照样可以看、可以改）',
    unbound: '范围是「只对指定的卡」，但没有绑定任何（还在的）角色卡：现在对谁都不生效',
    other: '范围是「只对指定的卡」，绑定的不是当前这张卡：这次不参与拼装',
};

/**
 * 卡自带那本书的名字（= 它的条目上的 book 字段）。parseCard 给条目的 book 是 character_book.name，缺省用卡名。
 * 额外世界书改名时不能叫这个名字：触发结果按「书名 + uid」对条目，重名会串（见 renameBook）
 */
function cardBookName() {
    if (!state.card) return null;
    return state.card.worldEntries?.[0]?.book ?? (state.card.raw?.data?.character_book?.name || state.card.name || '');
}

/** 卡自带那本的状态：'on' 生效 / 'off' 整本关掉（Card.worldDisabled） */
const cardBookStatus = () => (cardBookActive() ? 'on' : 'off');
const CARD_STATUS_TIP = { on: '角色卡自带的世界书：只对这张卡生效', off: '关着：这张卡自带的世界书不参与拼装（条目照样可以看、可以改）' };

/** 默认展开吗：卡内嵌的那本；绑定了当前卡的额外世界书 */
function defaultOpen(src) {
    if (!src.book) return true;
    const s = bookScopeOf(src.book);
    return s.scope === 'cards' && !!persist.cardId && s.cards.includes(persist.cardId);
}
function isOpen(src) {
    if (openFor.cardId !== persist.cardId || openFor.card !== state.card) {
        openBooks = new WeakMap();
        openFor = { cardId: persist.cardId, card: state.card };
    }
    return openBooks.has(src.key) ? openBooks.get(src.key) : defaultOpen(src);
}
function setOpen(src, on) { isOpen(src); openBooks.set(src.key, on); }

/** 新增条目：默认值取 card.js 的 defaultEntry（对应酒馆 newWorldInfoEntryDefinition），uid 取该书现有最大值 + 1 */
function addEntry(src) {
    const uid = src.list.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
    const e = { ...defaultEntry(), uid, comment: '新条目', book: src.bookName() };
    src.list.push(e);
    openEntries.add(e);
    setOpen(src, true);   // 新条目要看得见
    changed();
}

function deleteEntry(src, e) {
    if (!confirm(`删除条目「${e.comment || '#' + e.uid}」？内容会一并删掉。`)) return;
    const i = src.list.indexOf(e);
    if (i >= 0) src.list.splice(i, 1);
    changed();
}

/**
 * 改名。书名就是它的身份（导入同名文件会替换它、导出的文件名用它、条目上的 book 字段也是它），所以不能和另一本额外世界书重名：
 * 重名时【拒绝】并提示，不自动加「 (2)」——用户自己起的名字被悄悄改掉反而更难找。空名字也拒绝。
 * 条目上的 book 字段跟着改（「本次结果」按「书名 + uid」对条目，不改会对不上）。
 */
function renameBook(b) {
    const input = prompt('新的书名：', b.name);
    if (input === null) return;
    const name = input.trim();
    if (!name) return void toast('书名不能是空的', 'error');
    if (name === b.name) return;
    if (state.books.some(x => x !== b && x.name === name)) return void toast(`已经有一本叫「${name}」的世界书了，换个名字吧`, 'error');
    // 卡自带那本的名字也不行：同样是按「书名 + uid」对触发结果，重名时两本书的条目会串
    if (state.card && (state.card.worldEntries?.length ?? 0) > 0 && name === cardBookName()) return void toast(`「${name}」是当前角色卡自带的世界书的名字，换个名字吧`, 'error');
    setBookName(b, name);   // 条目上的 book 跟着改（books.js，和整体备份恢复时给重名的书改名是同一个函数）
    changed();
}

/** 改完统一走这里：存盘 → 刷新预览（拼装页、触发情况跟着变）→ 重画本页 */
function changed() { save(); refreshPreview(); renderWorldTab(); }

/** 现在能不能改数据：只读标签页、正在从备份恢复、已停止保存时都不能（返回 true = 禁用） */
const readOnlyNow = () => persist.readOnly || persist.stopped || restoreActive();

export function renderWorldTab(force = false) {
    const tab = $('#tab-world');
    const ro = readOnlyNow();
    if (force) loadCardNames();
    const srcs = sources();
    const entries = allEntries();
    // 书里绑着没见过的卡 id：补读一次卡名（见 cardNames 的说明）
    const unknown = state.books.flatMap(b => bookScopeOf(b).cards).filter(id => id !== persist.cardId && !cardNames.has(id) && !namesTried.has(id));
    if (unknown.length) { unknown.forEach(id => namesTried.add(id)); loadCardNames(); }

    const wi = ui.preview?.worldInfo;
    const hit = new Map((wi?.activated ?? []).map(a => [a.entry.book + '\u0000' + a.entry.uid, a]));
    const miss = new Map((wi?.skipped ?? []).map(s => [s.entry.book + '\u0000' + s.entry.uid, s]));
    const num = (key, label, title, suffix = '') => h('label', { class: 'inline', title }, label,
        h('input', { type: 'number', min: 0, value: state.wi[key], disabled: ro, 'data-fk': 'wi-' + key, style: 'width:4.5em', onchange: e => { state.wi[key] = Number(e.target.value) || 0; save(); refreshPreview(); } }), suffix);

    const kids = [
        // 递归 / 全词匹配 / 扫描带名字 / 区分大小写四个开关已从界面去掉，拼装时固定为酒馆默认（worldinfo.js effectiveWiSettings）
        // 「这次参与拼装的世界书 N 本…」的小结和「点书名展开…」的说明也去掉了（2026-11-22 用户定）：每本书头上只标异常状态，
        // 条目数写在各自表头的「条目 / 关键词 x/y」里
        h('div', { class: 'summary' }, num('scanDepth', '扫描最近', '扫描最近几条消息', ' 条'), worldToolbar(ro)),
        h('div', { class: 'legend' },
            h('span', null, h('span', { class: 'dot constant' }), '常驻'),
            h('span', null, h('span', { class: 'dot key' }), '关键词命中'),
            h('span', null, h('span', { class: 'dot recursion' }), '递归命中（被别的条目内容带出来）'),
            h('span', null, h('span', { class: 'dot' }), '未触发')),
    ];
    if (!srcs.length) kids.push(h('div', { class: 'empty' }, '没有世界书。角色卡自带的世界书会自动读入，也可以拖一个世界书 JSON 进来。'));

    srcs.forEach((src, i) => kids.push(bookBlock(src, i, { hit, miss, ro })));

    // 重画会把控件换成新的：记下焦点在哪个控件上（按 data-fk），画完放回去，键盘操作不会被打断
    const focusKey = tab.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    tab.replaceChildren(...kids);
    if (focusKey) tab.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}

/**
 * 顶上的工具条：导入 / 批量。
 * 导入走 importer.js 的 importFiles（和拖放同一条路：同名书只换条目、开关范围保留；一次可选多个文件）。
 * 批量：进入后额外世界书各出现一个勾选框，工具条换成「导出 / 删除 / 取消」。导出不写任何东西，只读时也能用；删除和导入只读时禁用。
 */
function worldToolbar(ro) {
    if (!batch.on) {
        return h('span', { class: 'wbook-toolbar', 'data-fk': 'wbook-toolbar' },
            h('button', { disabled: ro, 'data-fk': 'wbook-import', title: '导入世界书 JSON（可一次选多个）', onclick: pickBookFiles }, '导入'),
            h('button', { 'data-fk': 'wbook-batch', title: '多选额外世界书后导出 / 删除', onclick: () => { batch.on = true; batch.sel.clear(); renderWorldTab(); } }, '批量'));
    }
    const n = batchSelected().length;
    // 全选只算额外世界书（卡自带那本没有勾选框，批量不含它）
    const all = state.books.length > 0 && state.books.every(b => batch.sel.has(b));
    return h('span', { class: 'wbook-toolbar', 'data-fk': 'wbook-toolbar' },
        h('button', { disabled: !state.books.length, 'data-fk': 'wbook-batch-all', title: '全部勾上；已经全勾时再点就全不选',
            onclick: () => { batch.sel.clear(); if (!all) for (const b of state.books) batch.sel.add(b); renderWorldTab(); } }, all ? '全不选' : '全选'),
        h('span', { class: 'dim', 'data-fk': 'wbook-batch-count' }, `已选 ${n} 本`),
        h('button', { disabled: !n, 'data-fk': 'wbook-batch-export', title: '逐本导出成酒馆的世界书 JSON，一本一个文件', onclick: batchExport }, '导出'),
        h('button', { class: 'danger', disabled: ro || !n, 'data-fk': 'wbook-batch-delete', onclick: batchDelete }, '删除'),
        h('button', { class: 'ghost', 'data-fk': 'wbook-batch-cancel', onclick: () => { batch.on = false; batch.sel.clear(); renderWorldTab(); } }, '取消'));
}

/** 选世界书文件（可多选），交给 importFiles；它自己会查只读 / 恢复中 / 停止保存 */
function pickBookFiles() {
    // 输入框挂在页面上（隐藏）而不是悬空：浏览器测试要往里塞文件；用完 / 下次再点时清掉
    document.getElementById('world-file-input')?.remove();
    const input = h('input', { type: 'file', id: 'world-file-input', accept: '.json,application/json', multiple: true, hidden: true });
    document.body.append(input);
    input.addEventListener('change', async () => {
        const files = [...input.files];
        input.remove();
        if (!files.length) return;
        await importFiles(files);
        renderWorldTab();
    });
    input.click();
}

function batchExport() {
    for (const b of batchSelected()) exportBookFile(b.entries, b.name);
}

function batchDelete() {
    if (readOnlyNow()) return;
    const sel = batchSelected();
    if (!sel.length) return;
    if (!confirm(`删除选中的 ${sel.length} 本世界书？条目会一并删掉。`)) return;
    const gone = new Set(sel);
    state.books = state.books.filter(b => !gone.has(b));
    batch.on = false; batch.sel.clear();
    changed();
}

/** 一本书的块：头部一行（名字、数字、状态、控件）+ 展开后的条目表格 */
function bookBlock(src, i, { hit, miss, ro }) {
    const b = src.book;
    const status = b ? bookStatus(b) : cardBookStatus();
    const active = status === 'on';
    const open = isOpen(src);
    const fk = name => `${name}:${i}`;

    const head = h('div', { class: 'section-title wedit-title wbook-head' },
        batch.on && b ? h('input', { type: 'checkbox', class: 'wbook-pick', 'data-fk': fk('wbook-pick'), checked: batch.sel.has(b), title: '选中这本书',
            onchange: e => { e.target.checked ? batch.sel.add(b) : batch.sel.delete(b); renderWorldTab(); } }) : null,
        h('button', { class: 'wbook-toggle', type: 'button', 'data-fk': fk('wbook-toggle'), 'aria-expanded': String(open),
            title: open ? '收起' : '展开看条目', onclick: () => { setOpen(src, !open); renderWorldTab(); } }, src.title),
        // 头部不再写「N 条 · 触发 M」（条目上已有颜色标识）；状态标记只在异常时显示（已关闭 / 没绑卡 / 对这张卡不生效），
        // 「生效」是正常状态，不占地方（元素留在 DOM 里，只是 hidden）
        h('span', { class: `badge wbook-status ${status === 'on' ? 'on' : 'off'}`, 'data-fk': fk('wbook-status'), hidden: status === 'on', title: b ? STATUS_TIP[status] : CARD_STATUS_TIP[status] }, STATUS_TEXT[status]),
        h('span', { class: 'spacer' }),
        h('span', { class: 'wbook-ctrl' },
            b ? bookControls(b, i, ro) : cardBookControls(i, ro),
            h('button', { disabled: ro, 'data-fk': fk('wbook-add'), onclick: () => addEntry(src) }, '＋ 新增条目'),
            // 单本的导出 / 移除按钮已收进顶上的「批量」
            null));

    const parts = [head];
    if (b && bookScopeOf(b).scope === 'cards') parts.push(bindLine(b));
    if (open) {
        if (!src.list.length) parts.push(h('div', { class: 'dim wbook-empty' }, '这本书还没有条目。'));
        else {
            const rows = src.list.flatMap(e => entryRows(src, e, hit, miss, ro, active));
            // 表格放进一个能横向滚动的盒子：窄屏下表格比屏幕宽时只滚这一块，整页不出现横向滚动
            parts.push(h('div', { class: 'wbook-table' }, h('table', { class: 'grid wedit' },
                // 表头的 x/y：这本书共 y 条，其中启用了 x 条（disable 是反的）
                h('thead', null, h('tr', null, ['启用', `条目 / 关键词 ${src.list.filter(e => !e.disable).length}/${src.list.length}`, '位置', '顺序', ''].map(t => h('th', null, t)))),
                h('tbody', null, rows))));
        }
    }
    return h('div', { class: `wbook${active ? '' : ' inactive'}${open ? ' open' : ''}`, 'data-fk': `wbook:${i}`, 'data-status': status }, ...parts);
}

/** 额外世界书头部的控件：启用开关、范围、绑定 / 解绑当前卡、改名 */
function bookControls(b, i, ro) {
    const s = bookScopeOf(b);
    const cardId = persist.cardId;
    const bound = !!cardId && s.cards.includes(cardId);
    const fk = name => `${name}:${i}`;
    const set = patch => { setBookScope(b, patch); changed(); };
    return [
        h('label', { class: 'inline wbook-enable', title: '关掉后这本书不参与任何聊天的拼装' },
            h('input', { type: 'checkbox', 'data-fk': fk('wbook-enable'), checked: s.enabled, disabled: ro, onchange: e => set({ enabled: e.target.checked }) }), '启用'),
        h('select', { 'data-fk': fk('wbook-scope'), disabled: ro, title: '这本书对哪些聊天生效', 'aria-label': '生效范围',
            onchange: e => set({ scope: e.target.value }) },
            h('option', { value: 'all', selected: s.scope === 'all' }, '所有聊天'),
            h('option', { value: 'cards', selected: s.scope === 'cards' }, '只对指定的卡')),
        s.scope === 'cards' ? h('button', { 'data-fk': fk('wbook-bind'), disabled: ro || !cardId,
            title: !cardId ? '还没有角色卡' : bound ? '这本书不再对当前这张卡生效' : '让这本书对当前这张卡生效',
            onclick: () => set({ cards: bound ? s.cards.filter(x => x !== cardId) : [...s.cards, cardId] }) },
            bound ? '解除绑定' : '绑定到当前卡') : null,
        h('button', { class: 'ghost', 'data-fk': fk('wbook-rename'), disabled: ro, title: '改这本世界书的名字', onclick: () => renameBook(b) }, '改名'),
    ];
}

/**
 * 卡自带那本书头部的控件：只有一个整本的启用开关（Card.worldDisabled；它只对这张卡生效，没有范围和绑定，也不能改名——
 * 书名来自卡的原始数据）。开关存在 state.card 上，跟着卡记录一起保存，不写进 raw、导出卡时不带（见 types.js Card.worldDisabled）
 */
function cardBookControls(i, ro) {
    const on = cardBookActive();
    return h('label', { class: 'inline wbook-enable', title: '关掉后这张卡自带的世界书不参与拼装（比如它和一本额外世界书是同一本的两份）' },
        h('input', { type: 'checkbox', 'data-fk': `wbook-enable:${i}`, checked: on, disabled: ro, onchange: e => {
            if (e.target.checked) delete state.card.worldDisabled; else state.card.worldDisabled = true;   // 默认值不写
            changed();
        } }), '启用');
}

/** 「只对指定的卡」时显示绑定了哪几张卡（已经不在的卡不显示） */
function bindLine(b) {
    const names = bookScopeOf(b).cards.map(cardNameOf).filter(n => n !== null);
    return h('div', { class: 'dim wbook-bound', 'data-fk': 'wbook-bound' },
        names.length ? `已绑定：${names.join('、')}` : '没有绑定任何卡（现在对谁都不生效）');
}

function entryRows(src, e, hit, miss, ro, active = true) {
    const id = e.book + '\u0000' + e.uid;
    // 不参与这次拼装的书：不显示触发结果（它根本没被扫描；书名撞了别的书时，别的书的结果也不该算到它头上）
    const a = active ? hit.get(id) : undefined, s = active ? miss.get(id) : undefined;
    const kind = a ? (a.pass > 0 ? 'recursion' : a.reason) : '';
    // 「本次结果」「长度」「常驻」三列已去掉：触发与否看圆点颜色（悬停有原因），常驻的勾选在展开的编辑区里
    const why = !active ? '不参与'
        : a ? (a.reason === 'constant' ? '常驻' : `命中「${a.matchedKey ?? ''}」${a.pass > 0 ? `（第 ${a.pass} 轮递归）` : ''}`)
        : (s ? SKIP_REASONS[s.reason] ?? s.reason : (e.disable ? '已禁用' : '未触发'));
    const open = openEntries.has(e);
    // 注意 disable 是反的：「启用」勾上 = disable:false
    const toggle = (field, invert) => h('input', {
        type: 'checkbox', disabled: ro, checked: invert ? !e[field] : Boolean(e[field]),
        onchange: ev => { e[field] = invert ? !ev.target.checked : ev.target.checked; changed(); },
    });
    const main = h('tr', { class: `${a ? 'hit' : ''} ${e.disable ? 'off' : ''}` },
        h('td', { title: '启用' }, toggle('disable', true)),
        h('td', null, h('span', { class: `dot ${kind}`, title: why }),
            h('b', { class: 'wname', onclick: () => { open ? openEntries.delete(e) : openEntries.add(e); renderWorldTab(); } }, (open ? '▾ ' : '▸ ') + (e.comment || `#${e.uid}`)),
            h('div', { class: 'keys' }, e.constant ? '（常驻）' : e.key.join('、'),
                e.selective && e.keysecondary.length ? ` ＋[${['任一', '非全部', '全无', '全部'][e.selectiveLogic] ?? ''}] ${e.keysecondary.join('、')}` : '')),
        h('td', null, POSITION_NAMES[e.position] ?? e.position, e.position === 4 ? ` ${e.depth}` : ''),
        h('td', null, String(e.order)),
        h('td', null, h('button', { class: 'ghost', title: '删除条目', disabled: ro, onclick: () => deleteEntry(src, e) }, '✕')),
    );
    return open ? [main, h('tr', { class: 'wedit-row' }, h('td', { colspan: 5 }, entryEditor(e, ro)))] : [main];
}

/**
 * 条目编辑区。所有输入框都在 change（失焦 / 回车 / 选择）时才提交——
 * 打字过程中不动 state，也就不会因为预览刷新重渲染而丢焦点；
 * 提交后只有「会改变显示哪些控件」的字段（位置、有无次要关键词）才立刻重画本页。
 */
function entryEditor(e, ro) {
    /** 改一个字段：存盘 + 刷新预览；rerender = 这次改动会让控件的显示变化，需要重画 */
    const set = (field, value, rerender = false) => {
        e[field] = value; save(); refreshPreview();
        if (rerender) renderWorldTab();
    };
    const numberOf = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
    const textInput = (field, wide) => h('input', { value: e[field] ?? '', disabled: ro, style: wide ? 'flex:1;min-width:12em' : null, onchange: ev => set(field, ev.target.value) });
    const numInput = (field, min, max) => h('input', {
        type: 'text', inputmode: 'numeric', disabled: ro, value: e[field] ?? 0, style: 'width:4.5em',
        onchange: ev => {
            let n = Math.trunc(numberOf(ev.target.value));
            if (min != null) n = Math.max(min, n);
            if (max != null) n = Math.min(max, n);
            ev.target.value = n; set(field, n, field === 'depth');
        },
    });
    // 关键词：逗号分隔文本框，拆分规则见 src/keywords.js（照酒馆的 customTokenizer）
    const keyInput = (field, placeholder) => h('input', {
        value: e[field].join(', '), disabled: ro, placeholder, style: 'flex:1;min-width:12em',
        onchange: ev => {
            const had = e.keysecondary.length > 0;
            e[field] = splitKeywords(ev.target.value);
            // 酒馆只在 selective 且次要关键词非空时才看次要关键词；填了次要关键词就确保 selective 开着，免得「填了没效果」
            if (field === 'keysecondary' && e.keysecondary.length) e.selective = true;
            save(); refreshPreview();
            if (field === 'keysecondary' && had !== e.keysecondary.length > 0) renderWorldTab();
            else ev.target.value = e[field].join(', ');   // 规整成标准写法
        },
    });
    const sel = (field, names, rerender) => h('select', { disabled: ro, onchange: ev => set(field, Number(ev.target.value), rerender) },
        names.map((n, i) => h('option', { value: i, selected: (e[field] ?? 0) === i }, n)));

    const body = h('div', { class: 'wedit-body' });
    body.append(
        h('div', { class: 'row' }, h('label', { class: 'inline', style: 'flex:1' }, '标题', textInput('comment', true))),
        h('div', { class: 'row' }, h('label', { class: 'inline', style: 'flex:1' }, '主关键词', keyInput('key', '用逗号分隔；/正则/i 也可以'))),
        h('div', { class: 'row' }, h('label', { class: 'inline', style: 'flex:1' }, '次要关键词', keyInput('keysecondary', '可留空'))),
        e.keysecondary.length ? h('div', { class: 'row' }, h('label', { class: 'inline' }, '次要关键词逻辑', sel('selectiveLogic', LOGIC_NAMES, false))) : null,
        h('div', { class: 'row' },
            h('label', { class: 'inline' }, '位置', sel('position', POSITION_NAMES, true)),
            e.position === 4 ? [
                h('label', { class: 'inline' }, '深度', numInput('depth', 0)),
                h('label', { class: 'inline' }, '角色', sel('role', ROLE_NAMES, false)),
            ] : null,
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', disabled: ro, checked: Boolean(e.constant), 'data-fk': 'entry-constant',
                title: '常驻（蓝灯）：不用关键词，一直进上下文', onchange: ev => set('constant', ev.target.checked, true) }), '常驻'),
            h('label', { class: 'inline' }, '顺序', numInput('order')),
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', disabled: ro, checked: e.useProbability !== false, onchange: ev => set('useProbability', ev.target.checked) }), '启用概率'),
            h('label', { class: 'inline' }, '触发概率 %', numInput('probability', 0, 100))),
    );
    const ta = h('textarea', { spellcheck: false, disabled: ro, placeholder: '内容', onchange: ev => set('content', ev.target.value) });
    ta.value = e.content ?? '';
    body.append(ta);
    return body;
}
