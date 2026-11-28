// 贴着按钮弹出的小菜单（存档页顶上「导入」用）：点菜单项执行并收起；点别处 / Esc / 滚动 / 窗口变化 / 再点一次按钮都收起。
// 菜单挂在 body 上、position: fixed，所以存档页重画（保存之后会重画）不会把它带走或撑乱布局；
// 但重画会换掉按钮本身，所以「再点一次按钮收起」靠按钮上的 aria-expanded 之外的全局记录（openMenu）判断。
//
// 菜单项里的 onSelect 要弹文件选择框（input.click()）：浏览器只在用户手势里放行，所以必须在点击事件里同步调用，不能先 await。

import { h } from './dom.js';

let openMenu = null;   // {el, anchor, close}

/** 收起当前开着的菜单（没有就什么都不做） */
export function closeImportMenu() { openMenu?.close(); }

/**
 * @param {HTMLElement} anchor  菜单贴在它下面（左边对齐；右边放不下就往左挪，手机上不会超出屏幕）
 * @param {{label: string, title?: string, fk: string, onSelect: () => void}[]} items
 */
export function openImportMenu(anchor, items) {
    const was = openMenu;
    closeImportMenu();
    if (was && was.anchor === anchor) return;   // 菜单开着时再点同一个按钮 = 收起
    const close = () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        removeEventListener('resize', close);
        document.removeEventListener('scroll', onScroll, true);
        anchor.setAttribute('aria-expanded', 'false');
        el.remove();
        if (openMenu?.el === el) openMenu = null;
    };
    // 点在菜单外（包括点按钮本身：按钮的 onclick 自己决定是收起还是重开，所以这里放过它）就收起
    const onDown = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus?.(); } };
    // 菜单自己里面滚动不算（菜单很短，用不上，但别误伤）
    const onScroll = e => { if (!el.contains(e.target)) close(); };
    const el = h('div', { class: 'import-menu', role: 'menu', 'data-fk': 'import-menu' },
        ...items.map(it => h('button', { type: 'button', role: 'menuitem', class: 'import-menu-item', 'data-fk': it.fk, title: it.title ?? '',
            onclick: () => { close(); it.onSelect(); } }, it.label)));
    document.body.append(el);
    anchor.setAttribute('aria-expanded', 'true');
    // 定位：先挂上才量得出宽高。贴在按钮正下方，左对齐，超出屏幕就往回收，留 8px 边
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const top = r.bottom + 4 + hh > innerHeight - 8 ? Math.max(8, r.top - hh - 4) : r.bottom + 4;   // 下面放不下就开在按钮上方
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    el.querySelector('button')?.focus();
    openMenu = { el, anchor, close };
}
