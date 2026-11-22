// 小工具：查元素、建节点、toast、防抖、下载、uid、safeJson。不依赖任何别的模块（依赖图的叶子）。

/**
 * 查元素。消息正文是导入的卡片 / 模型输出的 HTML，里面可以带任意 id（比如 id="input"），
 * 而聊天区在文档里排在输入框前面——所以全局查找时要跳过消息正文里的元素，免得被「撞 ID」顶替。
 */
export const $ = (sel, root = document) => {
    if (root !== document) return root.querySelector(sel);
    for (const el of document.querySelectorAll(sel)) if (!el.closest('.mes_text')) return el;
    return null;
};

/**
 * h() 建出来的元素（页面自己的界面）。酒馆助手脚本开了「允许直接操作页面」时会往 <body> / <head> 里加东西，
 * 关掉后要把它加的清掉（ui/page-guard.js），但不能把同一段时间里我们自己挂上去的弹框、提示条、模型下拉一起清掉——靠这个认。
 * WeakSet：元素没了自然释放，不占内存
 */
const OWN = new WeakSet();
export const isOwnNode = n => OWN.has(n);

/** 建 DOM 节点。文本一律走 textContent，导入的卡名、条目名都是不可信内容，不拼 innerHTML。 */
export function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    OWN.add(el);
    for (const [k, v] of Object.entries(props ?? {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid == null || kid === false) continue;
        el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
}

export function toast(text, kind = '') {
    const el = h('div', { class: `toast ${kind}` }, text);
    const box = $('#toasts');
    box.append(el);
    // 同屏最多 6 条：多出来的把最早的挪走（卡 / 脚本用循环狂弹提示时，页面不能堆几万个节点卡死；见 frame-host.js toastr 的限频）
    while (box.children.length > 6) box.firstElementChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}

export function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function download(filename, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export function safeJson(v) {
    try { return JSON.stringify(v)?.slice(0, 200) ?? ''; } catch { return '…'; }
}
