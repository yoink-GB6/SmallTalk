// 主题切换：「杂项」页最上面的下拉框 #theme-select。
//
// 机制：<html data-theme="…">。「默认」= 不设这个属性，用 style.css :root 里的值；别的主题是 style.css 里的 `:root[data-theme="xxx"] { …覆盖变量… }`。
// 选了哪个记在 localStorage['smalltalk.theme']：这是「这台设备的界面偏好」，不进 IndexedDB、不进整体备份（登记见 src/data-inventory.js 末尾）。
// 读写都包 try/catch：无痕窗口等用不了 localStorage 时，本次会话里照样能切，只是刷新后回到默认。
//
// 页面一打开就是对的主题、不闪一下，靠 index.html <head> 里样式表之前的一小段内联脚本（它只读 localStorage 设 data-theme，不依赖任何模块）。
// 本模块在页面启动时做三件事：用主题清单（src/themes.js）填下拉框；存的值不在清单里（比如以后某个主题被删了）就当默认——去掉 data-theme、选中「默认」；
// 给清单里带 decoPick 的主题随机抽一张装饰图（见 pickThemeDecos）。
// 本模块不导入任何兄弟 ui 模块，不涉及循环依赖。

import { THEMES, DEFAULT_THEME, THEME_STORAGE_KEY, themeOrDefault } from '../themes.js';

const readStored = () => { try { return localStorage.getItem(THEME_STORAGE_KEY); } catch { return null; } };
const writeStored = id => { try { if (id === DEFAULT_THEME) localStorage.removeItem(THEME_STORAGE_KEY); else localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* 记不住就算了 */ } };

/** 设 / 去掉 <html data-theme>。默认主题不设属性 */
export function applyTheme(id) {
    const root = document.documentElement;
    if (id === DEFAULT_THEME) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', id);
}

/** 当前生效的主题 id（以 <html> 上的属性为准；没有就是默认） */
export const currentTheme = () => themeOrDefault(document.documentElement.getAttribute('data-theme') ?? DEFAULT_THEME);

/** 按清单（重新）填下拉框并选中当前主题。清单变了（测试里临时加一项）可以再调一次 */
export function fillThemeSelect() {
    const sel = document.querySelector('#theme-select');
    if (!sel) return;
    const cur = currentTheme();
    sel.replaceChildren(...THEMES.map(t => {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = t.name; o.selected = t.id === cur;
        return o;
    }));
    sel.value = cur;
}

const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/;   // 只要相对路径、不许 ..，也就不可能拼出 url("…") 之外的东西

const FITS = ['corner', 'width'];

/**
 * 给带 decoPick 的主题各抽一张装饰图：路径设成 <html> 上的 CSS 变量（如 --pr-deco-pick: url("themes/princesse/cocktail-2.png")），
 * 摆法设成 <html> 上的属性（如 data-pr-deco-fit="width"），style.css 按它换尺寸和位置。
 * 只在页面启动时调一次：同一次打开期间不换（切页签、切存档、切主题再切回来都不重抽），刷新才重抽。
 * 不管当前是不是这个主题都设：变量和属性只在该主题的样式里被引用，别的主题不受影响。
 * 路径解析：在 JS 里设到元素 style 上的 url() 按【文档】的地址解析；index.html 和 style.css 在同一目录，
 * 所以和样式表里写的 url("themes/princesse/…") 指向同一个文件（网页版挂在子路径下也一样）。
 */
export function pickThemeDecos(random = Math.random) {
    const root = document.documentElement;
    for (const t of THEMES) {
        const d = t.decoPick;
        const list = (d?.images || []).filter(p => p && typeof p.src === 'string' && SAFE_PATH.test(p.src) && FITS.includes(p.fit));
        if (!d || !/^--[a-z0-9-]+$/.test(d.cssVar || '') || !/^data-[a-z0-9-]+$/.test(d.fitAttr || '') || !list.length) continue;
        const pick = list[Math.min(list.length - 1, Math.floor(random() * list.length))];
        root.style.setProperty(d.cssVar, `url("${pick.src}")`);
        root.setAttribute(d.fitAttr, pick.fit);
    }
}

export function initTheme() {
    pickThemeDecos();
    const stored = readStored();
    const id = themeOrDefault(stored);
    applyTheme(id);   // 内联脚本已经设过一次；这里再按清单校验一遍（清单里没有的 id 在这里被去掉）
    fillThemeSelect();
    const sel = document.querySelector('#theme-select');
    sel?.addEventListener('change', () => {
        const next = themeOrDefault(sel.value);
        applyTheme(next);
        writeStored(next);
    });
}
