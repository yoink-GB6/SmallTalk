// 「允许直接操作页面」（直通模式，ui/script-host.js）的兜底清理：脚本运行期间往主页面上加的东西，脚本自己没清的由我们清掉。
//
// 美化类脚本常在 pagehide 里收拾自己（删 <style>、按钮、<html> 上的 class / 变量），iframe 移除时浏览器会发 pagehide（实测：
// 移除同源 iframe 时它的 pagehide 同步触发，回调里还能改主页面；之后它注册在主页面上的监听、MutationObserver、定时器、rAF 都不再被调用）。
// 但有的脚本不收拾，或只收拾一半。所以开始运行前拍一张快照，拆掉之后对比着恢复：
//   - <html> / <head> / <body> 的直接子节点：快照里没有、又不是我们自己建的（dom.js h() 建的元素都登记过），删掉。
//     只看直接子节点：脚本往我们已有的元素里面塞的东西（比如往 #chat 里加一个节点）不管——那些会随聊天重画消失，或者无害。
//   - 例外：专门留给脚本的几个空位（SLOT_IDS：输入框左右的 #leftSendForm / #rightSendForm、背景层 #bg1）也按上面的规矩看直接子节点，
//     外加它们自己的 class / 属性 / 内联样式——这几个位置就是给脚本挂东西用的（月亮按钮挂在 #leftSendForm、背景图设在 #bg1 上），
//     我们自己从来不往里放东西，所以脚本加的一律清掉。
//   - <style id="custom-style">（酒馆里放用户自定义 CSS 的那个 <style>，脚本会改它的内容）：内容换回快照时的样子。
//   - <html> / <body> 上的 class：新加的删掉（我们自己会加的几个除外）；被脚本删掉的我们自己的 class 不补（分不清是谁删的）。
//   - <html> / <body> 上的其它属性：新加的删掉、改了的换回去、删掉的补回来（我们自己会改的 data-theme 等除外）。
//   - <html> / <body> 的内联样式（脚本常用 style.setProperty('--xxx', …) 设 CSS 变量）：同上，逐个属性比。
// 「我们自己会改的」只有这几样（全项目查过：drawer.js、pwa-ui.js、theme.js）：body 的 panel-collapsed / drawer-open / pwa-has-update，
//   html 的 data-theme 和主题装饰图那一对（themes.js 的 decoPick），html 内联的 --topbar-h。新加这类东西时要记得加进下面的名单。
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { isOwnNode } from './dom.js';
import { THEMES } from '../themes.js';

const OWN_CLASSES = new Set(['panel-collapsed', 'drawer-open', 'pwa-has-update']);
const OWN_ATTRS = new Set(['data-theme', ...THEMES.map(t => t.decoPick?.fitAttr).filter(Boolean)]);
const OWN_PROPS = new Set(['--topbar-h', ...THEMES.map(t => t.decoPick?.cssVar).filter(Boolean)]);
/** 留给脚本的空位（index.html 里的空容器，酒馆页面上同名的元素）。见文件头 */
export const SLOT_IDS = ['leftSendForm', 'rightSendForm', 'bg1'];

function styleMap(el) {
    const m = new Map();
    for (let i = 0; i < el.style.length; i++) { const p = el.style[i]; m.set(p, [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]); }
    return m;
}
function attrMap(el) {
    const m = new Map();
    for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style') m.set(a.name, a.value);
    return m;
}

/** 开始运行之前拍快照 */
export function snapshotPage(doc = document) {
    const els = { html: doc.documentElement, head: doc.head, body: doc.body };
    for (const id of SLOT_IDS) { const el = doc.getElementById(id); if (el) els[id] = el; }
    const snap = { els, kids: new Set(), cls: {}, attrs: {}, style: {}, had: {}, customStyle: null };
    for (const k of ['html', 'head', 'body', ...SLOT_IDS]) for (const n of els[k]?.childNodes ?? []) snap.kids.add(n);
    for (const k of ['html', 'body', ...SLOT_IDS]) {
        const el = els[k];
        if (!el) continue;
        snap.had[k] = { cls: el.hasAttribute('class'), style: el.hasAttribute('style') };
        snap.cls[k] = new Set(el.classList);
        snap.attrs[k] = attrMap(el);
        snap.style[k] = styleMap(el);
    }
    const cs = doc.getElementById('custom-style');
    if (cs) snap.customStyle = { el: cs, text: cs.textContent };
    return snap;
}

/**
 * 对比快照恢复（见文件头）。keep(node)：除了 h() 建的之外，还有哪些新节点要留着。
 * @returns {{nodes: number, classes: number, attrs: number, props: number}} 各清了多少（日志 / 测试用）
 */
export function restorePage(snap, keep = () => false) {
    const out = { nodes: 0, classes: 0, attrs: 0, props: 0 };
    if (!snap) return out;
    const { els } = snap;
    for (const k of ['html', 'head', 'body', ...SLOT_IDS]) {
        const el = els[k];
        if (!el?.isConnected) continue;
        for (const n of [...el.childNodes]) {
            if (snap.kids.has(n) || n === els.head || n === els.body || isOwnNode(n) || keep(n)) continue;
            if (n.nodeType === 3 && !n.data.trim()) continue;   // 空白文本节点：无害，不动
            n.remove();
            out.nodes++;
        }
    }
    for (const k of ['html', 'body', ...SLOT_IDS]) {
        const el = els[k];
        if (!el?.isConnected || !snap.cls[k]) continue;
        const ownCls = k === 'html' || k === 'body' ? OWN_CLASSES : new Set();
        const ownAttr = k === 'html' || k === 'body' ? OWN_ATTRS : new Set();
        const ownProp = k === 'html' || k === 'body' ? OWN_PROPS : new Set();
        for (const c of [...el.classList]) if (!snap.cls[k].has(c) && !ownCls.has(c)) { el.classList.remove(c); out.classes++; }
        // 空位上被脚本去掉的 class 补回来（空位是我们的元素，class 只有我们写；html / body 上的不补，见文件头）
        if (k !== 'html' && k !== 'body') for (const c of snap.cls[k]) if (!el.classList.contains(c)) { el.classList.add(c); out.classes++; }
        if (!el.classList.length && el.hasAttribute('class') && !snap.had[k].cls) el.removeAttribute('class');
        const before = snap.attrs[k], now = attrMap(el);
        for (const [name, v] of now) {
            if (ownAttr.has(name)) continue;
            if (!before.has(name)) { el.removeAttribute(name); out.attrs++; } else if (before.get(name) !== v) { el.setAttribute(name, before.get(name)); out.attrs++; }
        }
        for (const [name, v] of before) if (!ownAttr.has(name) && !now.has(name)) { el.setAttribute(name, v); out.attrs++; }
        const s0 = snap.style[k], s1 = styleMap(el);
        for (const [p, [v, pri]] of s1) {
            if (ownProp.has(p)) continue;
            const was = s0.get(p);
            if (!was) { el.style.removeProperty(p); out.props++; } else if (was[0] !== v || was[1] !== pri) { el.style.setProperty(p, was[0], was[1]); out.props++; }
        }
        for (const [p, [v, pri]] of s0) if (!ownProp.has(p) && !s1.has(p)) { el.style.setProperty(p, v, pri); out.props++; }
        if (!el.style.length && el.hasAttribute('style') && !snap.had[k].style) el.removeAttribute('style');
    }
    const cs = snap.customStyle;
    if (cs && cs.el.textContent !== cs.text) { cs.el.textContent = cs.text; out.nodes++; }
    return out;
}
