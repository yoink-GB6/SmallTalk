// 手机壳（第一版：只有外观和导航，没有任何应用的功能，不存任何数据）。
//
// 结构（从外到内，全由本模块在启动时建好，挂在 <body> 末尾）：
//
//   #phone                        整个手机。**一直在 DOM 里**：收起只是 data-open="0"（CSS display:none），从不移除、不重建
//     .ph-frame                   机身（电脑上有圆角边框，窄屏上去掉边框铺满全屏）
//       .ph-screen
//         .ph-wall                壁纸（CSS 画的，颜色全取自主题变量，第一版不能换）
//         .ph-statusbar           假状态栏（statusbar.js）；电脑上也是拖动手机的把手
//         .ph-views               可切换的子视图，同一时间只有一个没有 hidden：
//           lock / home / settings / chat / music / reading（应用画面见 apps.js）
//         button.ph-homebar       底部的 home 指示条
//         .ph-persist             ★ 常驻层（见下）
//
// ★ 给音乐留的约定：.ph-persist 是"不随应用切换、也不随手机收起而销毁"的一层。以后的音乐播放器（<audio> 和它的控制逻辑）
//   要挂在这里，不能长在某个应用的画面里：开着音乐去 Chat / Reading、甚至收起手机回到 RP，音乐都不能断。
//   做得到的原因有两条：① #phone 本身从不销毁；② 收起用的是 display:none，不是 remove——<audio> 在 display:none 的祖先里照常播放。
//   所以以后加东西进常驻层只管 append，别给 #phone 或 .ph-persist 加任何"收起时清空 / 重建"的逻辑。
//
// 导航（view 是当前显示哪一个子视图）：
//   顶栏的手机图标 = togglePhone()：收起时 → 打开（没解过锁看锁屏，解过锁看桌面）；开着且在某个应用里 → 回桌面；开着且在桌面 / 锁屏 → 收起。
//   底部的 home 指示条做同一件事（窄屏上手机铺满全屏、盖住了顶栏，所以手机里要有个等价的出口）。
//   Meetup（桌面上）= 收起手机，露出后面原来的 RP 画面。Esc = 收起（不抢输入框和别的弹框的 Esc）。
//
// 锁屏：按一下假指纹解锁（点一下就行，不用按住——按住半秒在鼠标上不顺手，也不便于键盘 / 读屏用户）；有一段描圈 + 上滑的动效，
//   prefers-reduced-motion 时直接切换。"解过锁"只记在这个模块的变量里，刷新页面就没了（回到锁屏）；不写 localStorage / IndexedDB。
//
// 拖动（只在宽屏，> 900px）：抓状态栏拖，位置限制在视口里；位置只在内存里，刷新回到默认（右上角、顶栏下面）。窄屏没有拖动。
//
// Settings（原来右侧面板的「杂项」页，整页搬进来了；见 apps.js）：
//   · 进入 Settings 视图时通过 onPhoneView 通知 app.js 重画它（renderMiscTab），所以收起再打开、从别处跳进来，看到的都是最新的；
//   · Settings 开着时状态变了（切存档、恢复备份……）由 shell.js 的 renderInspector 用 isSettingsShown() 判断要不要重画，不可见时不白画；
//   · openSettings(选择器?)：给「点顶栏的"手动"徽标」这类跳转用——手机收着就打开，没解过锁直接当作解锁（不为一个跳转再点一次指纹），
//     进 Settings 并滚到那一节。
//
// 层级：z-index 19，高于窄屏抽屉（16），低于拖放提示（20）、页内弹框（25，含恢复备份的遮罩和各种确认框）、提示条（30）。
//
// 本模块导入 drawer.js（只用它的 closeDrawer，在函数体里调用），drawer.js 不导入本模块，不涉及循环依赖。

import { h } from '../dom.js';
import { closeDrawer } from '../drawer.js';
import { icon } from './icons.js';
import { createStatusBar } from './statusbar.js';
import { APPS, buildAppView } from './apps.js';

const NARROW = '(max-width: 900px)';   // 必须和 style.css / drawer.js 里抽屉的断点一致
const REDUCED = '(prefers-reduced-motion: reduce)';

let root = null;
let open = false;
let unlocked = false;
let view = 'lock';
let unlocking = false;
let pos = null;                        // 电脑上的位置 {left, top}（px），只在内存里
let toggleBtn = null;

/** 当前是不是窄屏（手机上铺满全屏的形态） */
const isNarrow = () => matchMedia(NARROW).matches;

export const isPhoneOpen = () => open;
export const phoneView = () => view;
/** Settings 现在正显示在屏幕上（手机开着且在 Settings 视图）：shell.js 靠它决定要不要重画那一页 */
export const isSettingsShown = () => open && view === 'settings';

let viewListener = null;
/** 登记「切到某个视图」的回调（app.js 用它在进入 Settings 时重画；phone.js 不导入 tab-misc，免得绕圈） */
export function onPhoneView(fn) { viewListener = fn; }

function showView(next) {
    view = next;
    root.dataset.view = next;
    for (const v of root.querySelectorAll('.ph-view')) v.hidden = v.dataset.view !== next;
    syncChrome();
    viewListener?.(next);
}

/**
 * 打开手机、进 Settings、（可选）滚到某一节。手机收着就打开；没解过锁就直接解锁。
 * @param {string} [sectionSelector] Settings 里某一节的 CSS 选择器，比如 '#misc-manual'；找不到就停在最上面
 */
export function openSettings(sectionSelector) {
    if (!root) return;
    unlocked = true;                      // 跳转是用户自己点的，不再让他为此多点一次指纹
    if (!open) openPhone();
    unlocking = false;                    // 正在播解锁动效时跳进来：动效的收尾发现已经不用做了（finish 里 wasOpen 为假）
    showView('settings');
    const body = root.querySelector('.ph-view[data-view="settings"] .ph-app-body');
    const target = sectionSelector ? body?.querySelector(sectionSelector) : null;
    if (body) {
        body.scrollTop = 0;
        // 手动算偏移而不是 scrollIntoView：后者可能连手机外面的页面一起滚
        if (target) body.scrollTop = target.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    }
    // 不把焦点挪到返回按钮：程序设的焦点会让它画出一圈键盘焦点框，鼠标用户看着像出了问题（点击跳转时没有地方需要焦点）
}

/** 顶栏图标 / home 条的提示文字、aria 状态跟着当前情形走 */
function syncChrome() {
    root.dataset.open = open ? '1' : '0';
    const atTop = view === 'lock' || view === 'home';
    const homeLabel = atTop ? '收起手机' : '回到桌面';
    const bar = root.querySelector('.ph-homebar');
    bar.setAttribute('aria-label', homeLabel);
    bar.title = homeLabel;
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', String(open));
        const t = !open ? '打开手机' : (atTop ? '收起手机' : '回到手机桌面');
        toggleBtn.title = t;
        toggleBtn.setAttribute('aria-label', t);
    }
}

/** 把电脑上的位置夹进视口（窗口变小或手机尺寸变了都要夹一次） */
function clampPos() {
    if (!pos) return;
    const w = root.offsetWidth, hh = root.offsetHeight;
    pos.left = Math.max(0, Math.min(innerWidth - w, pos.left));
    pos.top = Math.max(0, Math.min(innerHeight - hh, pos.top));
    root.style.left = pos.left + 'px';
    root.style.top = pos.top + 'px';
}

function placeDefault() {
    const bar = document.querySelector('#top-bar')?.getBoundingClientRect().bottom ?? 0;
    pos = { left: innerWidth - root.offsetWidth - 24, top: bar + 12 };
    clampPos();
}

export function openPhone() {
    if (open) return;
    if (isNarrow()) closeDrawer();      // 窄屏：抽屉和手机都是铺满的，别叠着
    open = true;
    showView(unlocked ? 'home' : 'lock');
    if (!isNarrow()) { if (!pos) placeDefault(); else clampPos(); }   // display 切回来之后才量得到尺寸，所以在 showView 之后摆位置
    // 焦点移进手机（读屏 / 键盘用户）：锁屏落在指纹上，桌面落在第一个应用上
    root.querySelector(view === 'lock' ? '.ph-finger' : '.ph-tile')?.focus({ preventScroll: true });
}

export function closePhone() {
    if (!open) return;
    open = false;
    unlocking = false;
    syncChrome();
    // 只有焦点还在手机里时才把它还给顶栏的图标，免得抢走用户已经点去别处的焦点
    if (root.contains(document.activeElement)) toggleBtn?.focus({ preventScroll: true });
}

/** 顶栏图标和 home 条共用的那一下：见文件头「导航」 */
export function togglePhone() {
    if (!open) openPhone();
    else if (view === 'lock' || view === 'home') closePhone();
    else showView('home');
}

function unlock() {
    if (unlocking || view !== 'lock') return;
    unlocking = true;
    const lock = root.querySelector('.ph-view[data-view="lock"]');
    const finish = () => {
        const wasOpen = open && unlocking;
        unlocking = false;
        lock.classList.remove('ph-scanning', 'ph-leaving');
        if (!wasOpen) return;               // 动效期间用户把手机收起了：不解锁，下次还是锁屏
        unlocked = true;
        showView('home');
        root.querySelector('.ph-tile')?.focus({ preventScroll: true });
    };
    if (matchMedia(REDUCED).matches) { finish(); return; }
    lock.classList.add('ph-scanning');                                   // 指纹描一圈（CSS 动画 .45s）
    setTimeout(() => {
        if (!unlocking) { lock.classList.remove('ph-scanning'); return; }
        lock.classList.add('ph-leaving');                                // 锁屏上滑淡出（.3s）
        setTimeout(finish, 300);
    }, 450);
}

/** 电脑上抓状态栏拖动 */
function bindDrag(handle) {
    let start = null;
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || isNarrow()) return;
        start = { dx: e.clientX - root.offsetLeft, dy: e.clientY - root.offsetTop };
        handle.setPointerCapture(e.pointerId);
        root.classList.add('ph-dragging');
        e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!start) return;
        pos = { left: e.clientX - start.dx, top: e.clientY - start.dy };
        clampPos();
    });
    const end = () => { start = null; root.classList.remove('ph-dragging'); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

function buildLock(extra) {
    const finger = h('button', { class: 'ph-finger', type: 'button', 'aria-label': '指纹解锁', title: '点一下解锁', onclick: unlock },
        h('span', { class: 'ph-finger-ring' }), icon('fingerprint'));
    extra.lockTime = h('div', { class: 'ph-lock-time' });
    extra.lockDate = h('div', { class: 'ph-lock-date' });
    return h('section', { class: 'ph-view ph-lock', 'data-view': 'lock' },
        h('div', { class: 'ph-lock-clock' }, extra.lockTime, extra.lockDate),
        h('div', { class: 'ph-lock-foot' }, finger));   // 不写提示文字，只留指纹图标（aria-label 给读屏用）
}

function buildHome() {
    const tiles = APPS.map(app => h('button', {
        class: 'ph-tile', type: 'button', 'data-app': app.id, 'aria-label': app.name,
        onclick: () => (app.kind === 'exit' ? closePhone() : showView(app.id)),
    }, h('span', { class: 'ph-tile-plate' }, icon(app.icon)), h('span', { class: 'ph-tile-name' }, app.name)));
    return h('section', { class: 'ph-view ph-home', 'data-view': 'home', hidden: true }, h('div', { class: 'ph-grid' }, tiles));
}

export function initPhone() {
    if (root) return;
    toggleBtn = document.querySelector('#phone-toggle');
    const extra = {};
    const lock = buildLock(extra);
    const status = createStatusBar(extra);
    const appViews = APPS.filter(a => a.kind === 'view').map(a => buildAppView(a, () => showView('home')));
    root = h('div', { id: 'phone', 'data-open': '0', 'data-view': 'lock', role: 'dialog', 'aria-label': '手机' },
        h('div', { class: 'ph-frame' },
            h('div', { class: 'ph-screen' },
                h('div', { class: 'ph-wall' }),
                status,
                h('div', { class: 'ph-views' }, lock, buildHome(), appViews),
                h('button', { class: 'ph-homebar', type: 'button', onclick: togglePhone }, h('span', { class: 'ph-homebar-line' })),
                h('div', { class: 'ph-persist', 'aria-hidden': 'true' }))));   // ★ 常驻层：见文件头
    document.body.append(root);
    bindDrag(status);
    syncChrome();
    toggleBtn?.addEventListener('click', togglePhone);
    addEventListener('resize', () => { if (open && !isNarrow()) clampPos(); });
    // Esc 收起。让路：焦点在输入框 / 下拉框里（Esc 是它们自己的）、有页内弹框或模型下拉开着（它们先处理 Esc）
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
        const a = document.activeElement;
        if (a && a.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (document.querySelector('.bk-overlay, .mp-pop')) return;
        closePhone();
    });
}
