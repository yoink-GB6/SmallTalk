// 聊天内搜索：手机 Settings 最上面的「搜索聊天记录」按钮（tab-misc.js 调 openSearch）→ 聊天区顶上展开搜索栏 → 在当前存档每一楼的原文里找。
//
// 设计要点（为什么这么写）：
//   1. 匹配只在 state.chat 的原文字符串上做（纯函数在 ../chat-search-core.js），不碰 DOM，几千楼也不卡。
//   2. DOM 里只给"当前这一处所在的那一楼"加高亮：楼层加边框 class，楼内文字里的命中片段包进 <mark>。
//      这些都只是显示层的临时装饰：每次重画高亮前先 clearDom() 全部拆掉；消息编辑取的是 state.chat[i].content
//      （见 chat.js editMessage），不是从 DOM 读文字，所以 <mark> 不可能被带进编辑框或存档。
//   3. 不对渲染后的 HTML 字符串做替换（那会把标签属性、脚本里的词也替换坏）。只遍历文本节点，
//      并跳过 script / style / 代码块 / 输入框 / iframe 里的内容。
//   4. 聊天变化（renderChat 末尾通知 chatChanged）时做防抖的轻量重算；存档换了（persist.epoch 变了）就整个复位。
//      注意：本文件被 chat.js 和 app.js 互相引用，顶层只放声明，不调用兄弟 ui 模块的函数。

import { $ } from './dom.js';
import { state, persist } from './state.js';
import { searchMessages, makeMatcher, escapeRegExp } from '../chat-search-core.js';

export { searchMessages, makeMatcher, escapeRegExp };

const MARK_CLASS = 'st-search-mark';
const HIT_CLASS = 'search-hit';
/** 这些祖先里的文字不做楼内高亮（前端卡 iframe 里面本来就够不着，这里只防它的外壳） */
const SKIP_SELECTOR = 'script, style, pre, code, textarea, iframe, .smalltalk-frontend, mark';

const st = {
    open: false,
    query: '',
    hits: [],       // 命中的楼层下标
    pos: 0,         // 当前在 hits 里的位置
    epoch: -1,      // 打开 / 搜索时所在的存档；换了就复位
    timer: 0,
};

/** 拆掉所有临时装饰：楼层边框 class、<mark>（还原成普通文字节点）。没有高亮时调用也无副作用 */
export function clearDom() {
    const box = $('#chat');
    if (!box) return;
    for (const row of box.querySelectorAll(`.${HIT_CLASS}`)) row.classList.remove(HIT_CLASS);
    for (const m of box.querySelectorAll(`mark.${MARK_CLASS}`)) {
        const parent = m.parentNode;
        m.replaceWith(document.createTextNode(m.textContent));
        parent?.normalize();   // 把拆开的相邻文字节点并回去，DOM 恢复成高亮前的样子
    }
}

/** 给一楼里的普通文字节点里的命中片段包上 <mark> */
function markInRow(row, query) {
    const body = row.querySelector('.mes_text');
    const re = makeMatcher(query);
    if (!body || !re) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);   // 先收集再改，免得改着改着遍历乱了
    for (const node of nodes) {
        const text = node.nodeValue;
        re.lastIndex = 0;
        let last = 0, m, frag = null;
        while ((m = re.exec(text))) {
            if (m[0] === '') { re.lastIndex++; continue; }
            frag ??= document.createDocumentFragment();
            if (m.index > last) frag.append(text.slice(last, m.index));
            const mark = document.createElement('mark');
            mark.className = MARK_CLASS;
            mark.textContent = m[0];
            frag.append(mark);
            last = m.index + m[0].length;
        }
        if (!frag) continue;
        if (last < text.length) frag.append(text.slice(last));
        node.replaceWith(frag);
    }
}

function paintCount() {
    const el = $('#chat-search-count');
    if (!el) return;
    el.textContent = !st.query ? '' : st.hits.length ? `第 ${st.pos + 1} / 共 ${st.hits.length} 处` : '没找到';
    const none = st.hits.length === 0;
    $('#chat-search-prev').disabled = none;
    $('#chat-search-next').disabled = none;
}

/** 按当前 hits / pos 重画高亮。scroll=true 时滚到当前这一楼（聊天变化引起的重算不滚，免得打断用户） */
function paint(scroll) {
    clearDom();
    paintCount();
    if (!st.open || !st.hits.length) return;
    const row = $('#chat').children[st.hits[st.pos]];
    if (!row) return;
    row.classList.add(HIT_CLASS);
    // 编辑中 / 流式输出中的楼层里放的是输入框 / 会被整段覆盖的内容，不做楼内高亮，只留边框
    if (!row.classList.contains('editing') && !row.classList.contains('streaming')) markInRow(row, st.query);
    if (scroll) row.scrollIntoView({ block: 'center' });
}

/** 重新匹配。keep=true：尽量停在原来那一楼（聊天变化时）；否则回到第一处（输入变了时） */
function refresh({ keep = false, scroll = false } = {}) {
    const was = st.hits[st.pos];
    st.hits = st.open ? searchMessages(state.chat, st.query) : [];
    const at = keep ? st.hits.indexOf(was) : -1;
    st.pos = at >= 0 ? at : Math.min(keep ? st.pos : 0, Math.max(0, st.hits.length - 1));
    paint(scroll);
}

function step(dir) {
    if (!st.hits.length) return;
    st.pos = (st.pos + dir + st.hits.length) % st.hits.length;
    paint(true);
}

export function openSearch() {
    st.open = true;
    st.epoch = persist.epoch;
    $('#chat-search').hidden = false;
    const input = $('#chat-search-input');
    input.focus();
    input.select();
    refresh({ scroll: true });
}

export function closeSearch() {
    clearTimeout(st.timer);
    st.open = false;
    st.query = '';
    st.hits = [];
    st.pos = 0;
    $('#chat-search-input').value = '';
    $('#chat-search').hidden = true;
    clearDom();
    paintCount();
}

/**
 * renderChat 末尾调用：聊天内容（新消息、编辑、删除、swipe、重新生成…）可能变了。
 * 换了存档（epoch 变了）立刻整个复位；否则防抖后轻量重算（流式片段不走 renderChat，所以不会每个片段都算）。
 */
export function chatChanged() {
    if (!st.open) return;
    if (st.epoch !== persist.epoch) { closeSearch(); return; }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (st.open) refresh({ keep: true }); }, 150);
}

export function bindChatSearch() {
    const input = $('#chat-search-input');
    $('#chat-search-close').addEventListener('click', closeSearch);
    $('#chat-search-prev').addEventListener('click', () => step(-1));
    $('#chat-search-next').addEventListener('click', () => step(1));
    input.addEventListener('input', () => {
        st.query = input.value;
        st.epoch = persist.epoch;
        refresh({ scroll: true });
    });
    input.addEventListener('keydown', e => {
        if (e.isComposing) return;   // 输入法选词时的回车不算
        if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    });
    // Esc 在搜索栏任何控件上都关闭。Ctrl+F 故意不拦截，留给浏览器自己的页内查找
    $('#chat-search').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); $('#send_textarea').focus(); } });
}
