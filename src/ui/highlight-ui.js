// 划线的界面（2026-11-28 第二段）：选中文字 → 冒出「划线」按钮 → 存下来 → 在聊天区画出高亮；点高亮冒出备注 / 删除小浮层。
// 数据和纯逻辑在 ../highlight.js（第一段），存取在 state.js 的「划线」一节；摘抄页签在 tab-excerpts.js。
//
// ─────────────────────────── 为什么这么画（高亮只画在显示层） ───────────────────────────
// 用 CSS Custom Highlight API（CSS.highlights + ::highlight()，style.css 末尾「划线」一块）：
//   给浏览器一组 DOM Range，它在文字上叠一层底色，【不改 DOM 一个节点】。所以
//   · 不会被带进编辑框 / 存档（编辑取的是 state.chat[i].content，本来就不读 DOM）；
//   · 酒馆助手脚本 / 前端卡读 .mes_text 的 innerHTML 看不到任何标记；
//   · 和聊天内搜索的 <mark>（chat-search.js 会拆开文字节点）互不干扰——Range 每次重画都按「现在的」文字节点重新建。
// 代价：Range 绑在具体的文字节点上，消息重画（编辑、切候选、换存档、流式结束……）后旧 Range 就塌了，所以每次聊天重画后都要重建：
//   renderChat 末尾直接调 repaintHighlights()；另外盯着 #chat 的 DOM 变动（搜索的 <mark> 之类），变了就防抖重建。
// 不支持这套 API 的浏览器（Safari < 17.2 等）：不画高亮，也不做「点高亮」，其余照常（划线照样存、摘抄页照常用）；
//   第一次划线时弹一句说明。不用 <mark> 包字当兜底：那会改 DOM，上面三条好处就都没了。
//
// ─────────────────────────── 选区怎么对回原文 ───────────────────────────
// 每一楼先拼出「可见文字」：.mes_text 里所有文字节点按顺序连起来，跳过 <style> / <script> / 前端卡（.smalltalk-frontend）里的——
// 拼法必须和 browser-tests/highlight-data-ui.mjs 的 VIS、types.js FloorMap 的约定完全一样，highlight.js mapFloor 才对得上。
// 记下每个文字节点在可见文字里从第几个字开始（starts），就能把 DOM 的 (节点, 偏移) 换成可见文字的下标，反过来也一样。
// 对照表（FloorMap）按楼缓存：原文、渲染文字、可见文字都没变就不重算（Myers 差分不便宜）。
// 显示正则里有 {{random}} 这类每次渲染都不同的内容时，displayMapOf 重跑出来的文字可能和页面上实际显示的不同（ui.rendered 里记的是
// 实际显示的），这一楼的对照表就不可信：不画、也不让划，提示原因。
//
// ─────────────────────────── 手机上 ───────────────────────────
// 手机上长按选字 → 系统弹自己的菜单（通常在选区上方）+ 两个拖动把手（在选区两端的下方）。我们的按钮放在选区【下方再往下一截】，
// 避开系统菜单和把手；下面放不下就放到选区上方。选区一变（拖把手）按钮跟着挪，选区没了按钮就消失。
// 点按钮时 mousedown / touchstart 都 preventDefault，选区不会因为点了按钮而塌掉；点击时用的是按钮出现时存下的选区副本，
// 不依赖点击那一刻的 getSelection()（有的手机浏览器点按钮会先清选区）。点高亮不需要键盘 / 选区，靠点击坐标和 Range 的外框比对。
//
// UI 模块之间有故意保留的循环依赖：本文件顶层只放声明，不调用兄弟 ui 模块的函数。

import { $, h, toast } from './dom.js';
import {
    state, ui, persist, currentHighlights, addChatHighlight, removeChatHighlight, setChatHighlightNote,
} from './state.js';
import { displayMapOf } from './pipeline.js';
import { chatWriteBlocked } from './chat.js';          // 循环依赖：只在函数体里调用
import { highlightsListChanged } from './tab-excerpts.js';   // 循环依赖：只在函数体里调用
import { chatDoc, mapFloor, rangeFromSelection, rawToVisible, visibleHighlights } from '../highlight.js';

const SKIP = 'style, script, .smalltalk-frontend';   // 这些里面的文字不算「可见文字」
const NAME_ALL = 'st-hl', NAME_NOTE = 'st-hl-note', NAME_FLASH = 'st-hl-flash';
const supported = () => typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight !== 'undefined';

// ───────────────────────────── 一楼的「可见文字」和对照表 ─────────────────────────────

/** 一楼 .mes_text 里的文字节点（跳过 SKIP）和它们在可见文字里的起点 */
function collectText(body) {
    const nodes = [];
    let visible = '';
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (w.nextNode()) { nodes.push({ node: w.currentNode, start: visible.length }); visible += w.currentNode.data; }
    return { nodes, visible };
}

const fmCache = new Map();   // 楼号 → {content, rendered, visible, fm}
let cacheEpoch = -1;

/**
 * 第 i 楼现在能不能用来划线 / 画高亮：能就返回 {row, body, nodes, visible, fm}，不能返回 {err}。
 * err：'gone' 这一楼不在 / 'busy' 正在编辑或生成（里面是输入框 / 会被整段覆盖）/ 'dynamic' 显示里有每次都变的内容 / 'map' 算对照表出错
 */
function viewOf(i) {
    const row = $('#chat')?.children[i], msg = state.chat[i];
    if (!row || !msg) return { err: 'gone' };
    if (row.classList.contains('editing') || row.classList.contains('streaming')) return { err: 'busy' };
    const body = $('.mes_text', row);
    const { nodes, visible } = collectText(body);
    const rendered = ui.rendered.get(i);
    const c = fmCache.get(i);
    if (c && c.content === msg.content && c.rendered === rendered && c.visible === visible) return { row, body, nodes, visible, fm: c.fm };
    let dm;
    try { dm = displayMapOf(msg, i); } catch (e) { console.error(e); return { err: 'map' }; }
    if (dm.text !== rendered) return { err: 'dynamic' };
    const fm = mapFloor(msg.content, visible, { display: dm });
    fmCache.set(i, { content: msg.content, rendered, visible, fm });
    return { row, body, nodes, visible, fm };
}

/** DOM 边界点 (node, offset) → 这一楼可见文字的下标。点在某个文字节点里就是它的起点 + 偏移；在元素之间就取它前面所有文字节点的总长 */
function toVisibleIndex(view, node, offset) {
    const hit = view.nodes.find(n => n.node === node);
    if (hit) return hit.start + Math.min(offset, node.data.length);
    const at = document.createRange();
    at.setStart(node, offset);
    at.collapse(true);
    for (const n of view.nodes) {
        if (at.comparePoint(n.node, n.node.data.length) < 0) continue;   // 这个文字节点整个在边界点之前
        return at.comparePoint(n.node, 0) < 0 ? n.start + n.node.data.length : n.start;   // 边界点正好卡在它的末尾 / 在它之前
    }
    return view.visible.length;
}

/** 可见文字的 [s, e) → DOM Range（空区间返回 null） */
function makeRange(view, s, e) {
    if (e <= s) return null;
    let a = null, b = null;
    for (const n of view.nodes) {
        const len = n.node.data.length;
        if (!a && s < n.start + len) a = [n.node, Math.max(0, s - n.start)];
        if (!b && e <= n.start + len && e > n.start) { b = [n.node, e - n.start]; break; }
    }
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(...a);
    r.setEnd(...b);
    return r;
}

// ───────────────────────────── 画高亮 ─────────────────────────────

/** 当前画着的每一段：{id, floor, range}。点高亮时拿它比对；摘抄页「跳转」闪一下也用它 */
let entries = [];
let paintTimer = 0;
let lastList = null;

/** 按当前存档的划线重画全部高亮（幂等，便宜到可以随便调；DOM 一个字不动） */
export function repaintHighlights() {
    clearTimeout(paintTimer);
    if (cacheEpoch !== persist.epoch) { fmCache.clear(); cacheEpoch = persist.epoch; closePop(); hideBtn(); }
    entries = [];
    const list = currentHighlights();
    if (list !== lastList) { lastList = list; highlightsListChanged(); }   // 摘抄页开着就跟着刷新
    if (!supported()) return;
    const all = new Highlight(), noted = new Highlight();
    if (list.length) {
        const views = new Map();   // 楼号 → viewOf 的结果（这一轮里同一楼只算一次）
        const view = f => { if (!views.has(f)) views.set(f, viewOf(f)); return views.get(f); };
        for (const p of visibleHighlights(list, chatDoc(state.chat))) {
            const v = view(p.floor);
            if (v.err) continue;
            let span = { start: 0, end: v.visible.length };   // 整楼的划线：画整楼
            if (!p.whole) span = rawToVisible(v.fm, p.start, p.end);
            const range = span && makeRange(v, span.start, span.end);
            if (!range) continue;   // 划的这一段渲染后一个字都看不见（整段被正则吃了）
            entries.push({ id: p.id, floor: p.floor, range });
            all.add(range);
            if (p.note !== undefined && p.last) noted.add(range);   // 带备注的在最后一段加下划线（跨楼时只在最后一楼标）
        }
    }
    CSS.highlights.set(NAME_ALL, all);
    CSS.highlights.set(NAME_NOTE, noted);
    if (pop && !currentHighlights().some(x => x.id === pop.id)) closePop();   // 浮层开着、这条被别处删了
}

/** 防抖版：DOM 变了（搜索的 <mark>、流式结束……）后重建。流式输出中的楼层本来就不画，它的内容变动不触发 */
function scheduleRepaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(repaintHighlights, 40);
}

/**
 * 摘抄页「跳转」：把这条划线滚到聊天区可视范围的中间偏上（第一行距顶部约 30%）。跨楼的按第一楼那一段。
 * id 传 null（调用方已知它画不出来）或画不出来（在别的候选上、整段被显示正则吃掉、浏览器不支持高亮 API）→ 退回到把那一楼的顶部滚到聊天区顶上。返回是否定位到了划线本身。
 * 为什么要校正：消息里的图片、前端卡 iframe 晚一点才撑开高度，上面的楼变高会把位置顶走；高亮也可能在 DOM 变动后被重建（Range 换了新的）。
 * 所以每次都按 id 从当前画着的高亮里重新找 Range 再算：滚完之后下一帧校正一次、400 ms 后再一次，聊天区里还没加载完的图片 / iframe
 * 加载完各校正一次（3 秒内）。期间用户自己动了滚动条就不再校正。
 */
export function scrollToHighlight(id, row) {
    const box = $('#chat');
    if (!box) return false;
    const find = () => {
        const hits = entries.filter(e => e.id === id && e.range.startContainer.isConnected);
        return hits.length ? hits.reduce((a, b) => (b.floor < a.floor ? b : a)) : null;
    };
    if (id != null && !find() && supported()) repaintHighlights();   // 刚换过存档 / 重画过、还没重建：先重建一次
    let last = -1;
    const place = () => {
        const e = find();
        const b = box.getBoundingClientRect();
        let target;
        if (e) {
            const rects = e.range.getClientRects();
            const r = rects.length ? rects[0] : e.range.getBoundingClientRect();
            target = box.scrollTop + (r.top - b.top) - box.clientHeight * 0.3;
        } else if (row?.isConnected) {
            target = box.scrollTop + (row.getBoundingClientRect().top - b.top) - 8;
        } else return false;
        box.scrollTop = Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));
        last = box.scrollTop;
        return !!e;
    };
    const found = place();
    const until = Date.now() + 3000;
    const again = () => { if (Date.now() > until || Math.abs(box.scrollTop - last) > 2) return; place(); };
    requestAnimationFrame(() => requestAnimationFrame(again));
    setTimeout(again, 400);
    for (const el of box.querySelectorAll('img, iframe')) {
        if (el.tagName === 'IMG' && el.complete) continue;
        el.addEventListener('load', again, { once: true });
    }
    return found;
}

/** 摘抄页「跳转」之后让这条划线闪一下：换一层更醒目的高亮，1.6 秒后撤掉。滚动由调用方做 */
export function flashHighlight(id) {
    const hit = entries.filter(e => e.id === id);
    for (const e of hit) {
        e.range.startContainer.parentElement?.closest('.mes')?.classList.add('hl-flash-row');
        setTimeout(() => e.range.startContainer.parentElement?.closest('.mes')?.classList.remove('hl-flash-row'), 1700);
    }
    if (!supported() || !hit.length) return;
    CSS.highlights.set(NAME_FLASH, new Highlight(...hit.map(e => e.range)));
    setTimeout(() => CSS.highlights.delete(NAME_FLASH), 1600);
}

// ───────────────────────────── 选中文字 → 「划线」按钮 ─────────────────────────────

let btn = null;
let current = null;   // 按钮对应的选区副本：{range, epoch}
let dragging = false; // 鼠标正按着拖选：先不出按钮，松手再出（免得按钮追着光标跑）
let pressing = false; // 正在按按钮：这期间选区变化不收按钮
let selTimer = 0;

function ensureBtn() {
    if (btn) return btn;
    btn = h('button', { class: 'hl-btn', 'data-fk': 'hl-btn', type: 'button', hidden: true, title: '把选中的文字划线（可以加备注，之后在手机里的 Clippings 集中看）' }, '划线');
    // 点按钮不能让选区塌掉：鼠标 / 触摸的「按下」默认会清选区，拦掉；真正的动作在 click 里，用存下的选区副本
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('touchstart', e => { pressing = true; e.preventDefault(); }, { passive: false });
    btn.addEventListener('pointerdown', () => { pressing = true; });
    btn.addEventListener('click', () => { pressing = false; commitSelection(); });
    document.body.append(btn);
    return btn;
}

function hideBtn() {
    if (btn) btn.hidden = true;
    current = null;
}

/** 这个节点所在的 .mes_text（聊天区里的），没有 = null */
const bodyOf = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('#chat .mes_text') ?? null;

/** 选区变了（或滚动 / 改窗口大小）：该出按钮就出、位置跟着选区，不该出就收 */
function updateBtn() {
    clearTimeout(selTimer);
    if (pressing) return;
    const sel = getSelection();
    if (dragging || !sel || !sel.rangeCount || sel.isCollapsed) return void hideBtn();
    const range = sel.getRangeAt(0);
    // 开头必须在聊天正文里；结尾可以在正文外面但还在聊天区里（三击选一段，结尾常落到下一个元素的开头，commitSelection 里会往回收）。
    // 一端在聊天区外面、或在楼层的名字 / 按钮上（开头落在那里）：不出按钮
    if (!bodyOf(range.startContainer) || !$('#chat').contains(range.endContainer)) return void hideBtn();
    if (!sel.toString().trim()) return void hideBtn();
    const rects = [...range.getClientRects()].filter(r => r.width > 0 || r.height > 0);
    if (!rects.length) return void hideBtn();
    const b = ensureBtn();
    current = { range: range.cloneRange(), epoch: persist.epoch };
    b.hidden = false;
    const last = rects[rects.length - 1], first = rects[0];
    const touch = matchMedia('(pointer: coarse)').matches;
    const gap = touch ? 34 : 6;   // 手机：系统的拖动把手在选区末端下面，再让开一截
    const w = b.offsetWidth, hh = b.offsetHeight;
    let top = last.bottom + gap;
    if (top + hh > innerHeight - 8) top = Math.max(8, first.top - hh - (touch ? 44 : 6));   // 下面放不下：放上面（手机上再高一点，避开系统菜单）
    const left = Math.min(Math.max(8, last.right - w / 2), innerWidth - w - 8);
    b.style.left = `${Math.round(left)}px`;
    b.style.top = `${Math.round(top)}px`;
}

const scheduleUpdate = () => { clearTimeout(selTimer); selTimer = setTimeout(updateBtn, 80); };

const FAIL = {
    start: f => `这里划不了：选区的开头（第 ${f} 楼）落在了正则替换出来的内容里（比如状态栏），请从普通文字开始选`,
    end: f => `这里划不了：选区的结尾（第 ${f} 楼）落在了正则替换出来的内容里（比如状态栏），请在普通文字上结束`,
    empty: () => '这里划不了：没有选到可以划的文字',
};
const BAD_FLOOR = {
    busy: f => `这里划不了：第 ${f} 楼正在编辑或生成，等它结束再划`,
    dynamic: f => `这里划不了：第 ${f} 楼的显示里有每次渲染都会变的内容（比如 {{random}}），位置对不回原文`,
    gone: f => `这里划不了：第 ${f} 楼已经不在了`,
    map: f => `这里划不了：第 ${f} 楼的显示内容算不出对照关系（详情见控制台）`,
};

/**
 * 选区的一端 → {floor, offset}（可见文字下标）或 {err}。
 * @param {boolean} isEnd  结尾落在正文外面（但在聊天区里）时往回收：取它前面最近一段正文的末尾
 */
function endpoint(range, isEnd) {
    const node = isEnd ? range.endContainer : range.startContainer, off = isEnd ? range.endOffset : range.startOffset;
    let body = bodyOf(node), atEnd = false;
    if (!body && isEnd) {
        const at = document.createRange();
        at.setStart(node, off);
        at.collapse(true);
        const bodies = [...$('#chat').querySelectorAll('.mes_text')];
        for (let k = bodies.length - 1; k >= 0; k--) {
            if (at.comparePoint(bodies[k], bodies[k].childNodes.length) <= 0) { body = bodies[k]; atEnd = true; break; }
        }
    }
    if (!body) return { err: 'empty' };
    const floor = [...$('#chat').children].indexOf(body.closest('.mes'));
    // 端点落在前端卡 / 样式块里：那里面的文字不在「可见文字」里，对不回去
    if (!atEnd && (node.nodeType === 1 ? node : node.parentElement)?.closest(SKIP)) return { err: 'frontend', floor };
    const view = viewOf(floor);
    if (view.err) return { err: view.err, floor };
    return { floor, view, offset: atEnd ? view.visible.length : toVisibleIndex(view, node, off) };
}

/** 点「划线」：把存下的选区副本对回原文，存成一条划线 */
function commitSelection() {
    const cur = current;
    if (!cur || cur.epoch !== persist.epoch) { hideBtn(); return; }
    const why = chatWriteBlocked(cur.epoch, '划线');   // 只读标签页 / 正在生成 / 正在恢复备份 / 已停止保存：和别的写操作同一套拒绝条件
    if (why !== null) { if (why) toast(why, 'error'); return; }
    const a = endpoint(cur.range, false), b = endpoint(cur.range, true);
    for (const p of [a, b]) {
        if (p.err === 'frontend') return void toast(`这里划不了：第 ${p.floor} 楼的选区落在前端卡 / 样式里，对不回原文`, 'error');
        if (p.err) return void toast((BAD_FLOOR[p.err] ?? FAIL.empty)(p.floor), 'error');
    }
    const doc = chatDoc(state.chat);
    const r = rangeFromSelection(
        { floor: a.floor, swipe: doc.current(a.floor), map: a.view.fm, offset: a.offset },
        { floor: b.floor, swipe: doc.current(b.floor), map: b.view.fm, offset: b.offset });
    if (!r.ok) return void toast(FAIL[r.reason](r.floor), 'error');
    const added = addChatHighlight({ from: r.from, to: r.to });
    getSelection().removeAllRanges();
    hideBtn();
    if (!added) { toast('这一段已经划过了'); return; }
    repaintHighlights();
    if (!supported() && !commitSelection.warned) {
        commitSelection.warned = true;
        toast('已划线。这个浏览器不支持画高亮（需要较新的浏览器），划过的内容可以在手机里的 Clippings 看', 'ok');
    }
}

// ───────────────────────────── 点高亮 → 备注 / 删除浮层 ─────────────────────────────

let pop = null;   // {id, el, ta, saved, epoch}

export function closePop(save = true) {
    if (!pop) return;
    const p = pop;
    pop = null;   // 先置空：下面的保存会重画，重画里会检查 pop
    if (save && !p.ta.disabled && p.ta.value.trim() !== p.saved && chatWriteBlocked(p.epoch, '改备注') === null) {
        setChatHighlightNote(p.id, p.ta.value);
        repaintHighlights();
    }
    p.el.remove();
}

function openPop(id, x, y) {
    closePop();
    const hl = currentHighlights().find(k => k.id === id);
    if (!hl) return;
    const epoch = persist.epoch;
    const why = chatWriteBlocked(epoch, '改划线');
    const saved = hl.note ?? '';
    const ta = h('textarea', { class: 'hl-note', 'data-fk': 'hl-note', rows: 3, maxLength: 5000, placeholder: '备注（可以留空）', disabled: why !== null });
    ta.value = saved;
    const done = fn => () => {
        const w = chatWriteBlocked(epoch, '改划线');
        if (w !== null) { if (w) toast(w, 'error'); return; }
        fn();
    };
    const el = h('div', { class: 'hl-pop', 'data-fk': 'hl-pop', role: 'dialog', 'aria-label': '划线' },
        ta,
        why ? h('div', { class: 'dim hl-pop-why' }, why || '') : null,
        h('div', { class: 'row' },
            h('button', { class: 'primary', 'data-fk': 'hl-save', type: 'button', disabled: why !== null,
                onclick: done(() => { setChatHighlightNote(id, ta.value); pop.saved = ta.value.trim(); repaintHighlights(); closePop(false); }) }, '保存备注'),
            h('button', { 'data-fk': 'hl-del', type: 'button', disabled: why !== null,
                onclick: done(() => {
                    if (hl.note && !confirm('这条划线带着备注，删除后备注也没了。确定删除？')) return;
                    removeChatHighlight(id); closePop(false); repaintHighlights();
                }) }, '删除划线'),
            h('button', { class: 'ghost', type: 'button', title: '关闭（Esc；改了的备注会自动保存）', onclick: () => closePop() }, '✕')));
    pop = { id, el, ta, saved: saved.trim(), epoch };
    document.body.append(el);
    const w = el.offsetWidth, hh = el.offsetHeight;
    el.style.left = `${Math.round(Math.min(Math.max(8, x - w / 2), innerWidth - w - 8))}px`;
    el.style.top = `${Math.round(y + 14 + hh > innerHeight - 8 ? Math.max(8, y - hh - 14) : y + 14)}px`;
    if (!why) ta.focus({ preventScroll: true });
}

/** 点在聊天里：落在某条高亮的文字上（Range 的外框里）就开浮层。选着字的时候（选区非空）不算 */
function onChatClick(e) {
    if (!entries.length || (getSelection()?.isCollapsed === false)) return;
    if (e.target.closest?.('a, button, input, textarea, select, iframe, .smalltalk-frontend')) return;
    const row = e.target.closest?.('.mes');
    if (!row) return;
    const floor = [...$('#chat').children].indexOf(row);
    let best = null;
    for (const en of entries) {
        if (en.floor !== floor) continue;
        const hit = [...en.range.getClientRects()].some(r => e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1);
        // 几条重叠时取字数最少的（最里面那条）
        if (hit && (!best || en.range.toString().length < best.len)) best = { id: en.id, len: en.range.toString().length };
    }
    if (best) openPop(best.id, e.clientX, e.clientY);
}

// ───────────────────────────── 接线 ─────────────────────────────

export function bindHighlights() {
    const chat = $('#chat');
    document.addEventListener('selectionchange', scheduleUpdate);
    chat.addEventListener('mousedown', e => { if (e.button === 0) dragging = true; });
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; updateBtn(); } });
    document.addEventListener('touchend', () => { pressing = false; scheduleUpdate(); }, true);
    document.addEventListener('keyup', e => { if (e.key.startsWith('Arrow') || e.key === 'Shift') scheduleUpdate(); });
    // 聊天滚动 / 改窗口大小：按钮跟着选区的新位置走（capture：scroll 不冒泡）
    chat.addEventListener('scroll', () => { if (btn && !btn.hidden) updateBtn(); }, { passive: true });
    addEventListener('resize', () => { if (btn && !btn.hidden) updateBtn(); });
    chat.addEventListener('click', onChatClick);
    // 点浮层外面关掉（备注有改动会自动保存）；Esc 关
    document.addEventListener('pointerdown', e => { if (pop && !pop.el.contains(e.target)) closePop(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) { e.preventDefault(); closePop(); } });
    // 聊天 DOM 变了就重建高亮（renderChat 末尾已经直接调过一次；这里补搜索的 <mark>、前端卡挂载、切存档清空这类不经过它的变动）。
    // 流式输出中的那一楼不触发：每个片段都重建会拖慢长聊天
    new MutationObserver(ms => {
        if (ms.some(m => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('.streaming'))) scheduleRepaint();
    }).observe(chat, { childList: true, subtree: true, characterData: true });
    scheduleRepaint();
}
