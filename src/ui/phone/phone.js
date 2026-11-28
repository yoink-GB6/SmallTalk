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
//   Esc = 收起（不抢输入框和别的弹框的 Esc）。
//   Meetup 现在是个应用（原来「存档」页整页搬进来）：点了进它的页；在里面选卡 / 存档才收起手机进 RP（规则见 tab-archive.js enterRp）。
//   Clippings 是原来的「摘抄」页，同样整页搬进来；单击跳转后收起手机（tab-excerpts.js jump）。
//
// 锁屏：按一下假指纹解锁（点一下就行，不用按住——按住半秒在鼠标上不顺手，也不便于键盘 / 读屏用户）；有一段描圈 + 上滑的动效，
//   prefers-reduced-motion 时直接切换。"解过锁"只记在这个模块的变量里，刷新页面就没了（回到锁屏）；不写 localStorage / IndexedDB。
//
// 拖动（只在宽屏，> 900px）：抓状态栏拖，位置限制在视口里；位置只在内存里，刷新回到默认（右上角、顶栏下面）。窄屏没有拖动。
//
// Settings（两级菜单；原来右侧面板的「杂项」页拆成了几个下一页，见 apps.js 的 SETTINGS_PAGES 和 index.html 的 #tab-misc）：
//   · settingsPage 是当前在哪一页：null = 菜单页，否则是页的 id（'rp'、'data'……）。菜单点一项 → setSettingsPage(id)；标题栏返回在下一页里回菜单，在菜单页回桌面。
//   · 顶栏图标 / home 条在下一页里点：直接回桌面；离开 Settings 时 settingsPage 清回 null，所以下次进来永远是菜单页（简单可预期）。
//   · 进入某一页时通过 onSettingsPage 通知 app.js 重画那一页的内容（renderMiscTab(页)），所以菜单 → 下一页 → 返回 → 再进，看到的都是最新的；
//   · Settings 开着时状态变了（切存档、恢复备份……）由 shell.js 的 renderInspector 用 isSettingsShown() 判断要不要重画（只画当前那一页，菜单页没有动态内容），不可见时不白画；
//   · openSettings(选择器?)：给「点顶栏的"手动"徽标」这类跳转用——手机收着就打开，没解过锁直接当作解锁（不为一个跳转再点一次指纹），
//     进 Settings、自动进到包含那个元素的下一页并滚到它；不带选择器就停在菜单页。
//   · 红点：setSettingsBadge(菜单项 id, 是否有)。某一项有红点时，那一项、桌面上的 Settings 图标、顶栏的手机图标三处各显示一个小红点
//     （没有任何一项有红点时全部消失）。第一版没有接任何真实条件，以后哪里发现"有事要用户处理"就调它。
//
// 层级：z-index 19，高于窄屏抽屉（16），低于拖放提示（20）、页内弹框（25，含恢复备份的遮罩和各种确认框）、提示条（30）。
//
// 本模块导入 drawer.js（只用它的 closeDrawer，在函数体里调用），drawer.js 不导入本模块，不涉及循环依赖。

import { h } from '../dom.js';
import { closeDrawer } from '../drawer.js';
import { icon } from './icons.js';
import { createStatusBar } from './statusbar.js';
import { APPS, SETTINGS_PAGES, buildAppView } from './apps.js';

const NARROW = '(max-width: 900px)';   // 必须和 style.css / drawer.js 里抽屉的断点一致
const REDUCED = '(prefers-reduced-motion: reduce)';

let root = null;
let open = false;
let unlocked = false;
let view = 'lock';
let unlocking = false;
let pos = null;                        // 电脑上的位置 {left, top}（px），只在内存里
let toggleBtn = null;
let settingsPage = null;               // Settings 当前在哪一页：null = 菜单页
const badgePages = new Set();          // 有红点的菜单项 id

/** 当前是不是窄屏（手机上铺满全屏的形态） */
const isNarrow = () => matchMedia(NARROW).matches;

export const isPhoneOpen = () => open;
export const phoneView = () => view;
/** Settings 现在正显示在屏幕上（手机开着且在 Settings 视图）：shell.js 靠它决定要不要重画那一页 */
export const isSettingsShown = () => open && view === 'settings';
/** Meetup（存档树）/ Clippings（摘抄）现在正显示在屏幕上：shell.js、tab-archive.js、tab-excerpts.js 靠它们决定要不要重画，不可见时不白画 */
export const isMeetupShown = () => open && view === 'meetup';
export const isClippingsShown = () => open && view === 'clippings';

/** Settings 当前在哪一页（null = 菜单页）：shell.js 用它只重画开着的那一页 */
export const currentSettingsPage = () => settingsPage;

let viewListener = null;
/** 登记「切到某个视图」的回调（phone.js 不导入 tab-misc，免得绕圈） */
export function onPhoneView(fn) { viewListener = fn; }

let pageListener = null;
/**
 * 登记「Settings 进入某一页」的回调（app.js 用它去重画那一页的动态内容；phone.js 不导入 tab-misc，免得绕圈）。
 * 回调收到页的 id；'all' 是个特例：要找某个选择器、但内容还没画出来时，让调用方把所有页都画一遍
 */
export function onSettingsPage(fn) { pageListener = fn; }

function showView(next) {
    if (next !== 'settings' && settingsPage !== null) setSettingsPage(null);   // 离开 Settings：下次进来是菜单页
    view = next;
    root.dataset.view = next;
    for (const v of root.querySelectorAll('.ph-view')) v.hidden = v.dataset.view !== next;
    syncChrome();
    viewListener?.(next);
}

/**
 * Settings 切到某一页（null = 菜单页）：显示那一页、藏其它页和菜单、改标题和返回按钮的说明、滚回顶部、通知 app.js 重画那一页。
 * 只改显示，不碰各页里面的节点（它们由 tab-misc.js 画、index.html 写）。
 */
function setSettingsPage(id) {
    settingsPage = id;
    const sv = root.querySelector('.ph-view[data-view="settings"]');
    sv.dataset.page = id ?? 'menu';
    const misc = sv.querySelector('#tab-misc');
    sv.querySelector('.ph-menu').hidden = id !== null;
    if (misc) {
        misc.hidden = id === null;
        for (const p of misc.querySelectorAll(':scope > .ph-set-page')) p.hidden = p.dataset.page !== id;
    }
    const name = id ? SETTINGS_PAGES.find(p => p.id === id)?.name : null;
    sv.querySelector('.ph-app-title').textContent = name ?? 'Settings';
    const back = sv.querySelector('.ph-back');
    back.title = id ? '返回设置菜单' : '返回桌面';
    back.setAttribute('aria-label', back.title);
    sv.querySelector('.ph-app-body').scrollTop = 0;
    if (id) pageListener?.(id);
}

/** Settings 标题栏的返回：在下一页里回菜单，在菜单页回桌面 */
function settingsBack() {
    if (settingsPage !== null) setSettingsPage(null);
    else showView('home');
}

// ── 红点 ──
/** 红点都画在一个个 .ph-dot 小圆点里（apps.js 的菜单行、桌面图标的底板、顶栏图标各有一个，默认 hidden），这里只管显示 / 隐藏 */
function syncBadges() {
    const any = badgePages.size > 0;
    for (const d of root.querySelectorAll('.ph-tile[data-app="settings"] .ph-dot')) d.hidden = !any;
    if (toggleBtn) {
        const d = toggleBtn.querySelector('.ph-dot');
        if (d) d.hidden = !any;
        toggleBtn.dataset.badge = any ? '1' : '0';
    }
    for (const row of root.querySelectorAll('.ph-menu-row')) {
        const on = badgePages.has(row.dataset.page);
        row.querySelector('.ph-dot').hidden = !on;
        const name = SETTINGS_PAGES.find(p => p.id === row.dataset.page)?.name ?? '';
        row.setAttribute('aria-label', on ? name + '（有需要处理的事）' : name);
    }
    syncChrome();
}

/**
 * 给 Settings 的某个菜单项挂上 / 去掉红点（表示"这一项下面有需要用户处理的事"）。
 * 三处联动：那一项的菜单行、桌面上的 Settings 图标、顶栏的手机图标；只要还有一项有红点，上面两层就还亮着。
 * @param {string} pageId SETTINGS_PAGES 里的 id；不认识的 id 忽略
 * @param {boolean} [on=true]
 */
export function setSettingsBadge(pageId, on = true) {
    if (!SETTINGS_PAGES.some(p => p.id === pageId)) return;
    if (on) badgePages.add(pageId); else badgePages.delete(pageId);
    if (root) syncBadges();
}

/** 显示 / 隐藏 Settings 的某个菜单项（只有网页版才有「安装到主屏幕」：pwa-ui.js 探测完后端种类再调它） */
export function setSettingsItemHidden(pageId, hidden) {
    const row = root?.querySelector(`.ph-menu-row[data-page="${pageId}"]`);
    if (row) row.hidden = !!hidden;
}

/**
 * 打开手机、进 Settings、（可选）进到包含某个元素的下一页并滚到它。手机收着就打开；没解过锁就直接解锁。
 * @param {string} [sectionSelector] Settings 里某个元素的 CSS 选择器，比如 '#misc-manual'；不带或找不到就停在菜单页
 */
export function openSettings(sectionSelector) {
    if (!root) return;
    unlocked = true;                      // 跳转是用户自己点的，不再让他为此多点一次指纹
    if (!open) openPhone();
    unlocking = false;                    // 正在播解锁动效时跳进来：动效的收尾发现已经不用做了（finish 里 wasOpen 为假）
    showView('settings');
    const body = root.querySelector('.ph-view[data-view="settings"] .ph-app-body');
    const misc = body?.querySelector('#tab-misc');
    // 先弄清目标在哪一页。动态内容（备份、变量……）平时只在进了那一页才画，所以找不到时让 app.js 把各页都画一遍再找；
    // 对应菜单项被藏起来的页（本地版的「安装到主屏幕」）当作没有这一页，停在菜单
    const pageOf = () => {
        const id = (sectionSelector && misc?.querySelector(sectionSelector))?.closest('.ph-set-page')?.dataset.page ?? null;
        return id && !root.querySelector(`.ph-menu-row[data-page="${id}"]`)?.hidden ? id : null;
    };
    let page = sectionSelector ? pageOf() : null;
    if (sectionSelector && !page) { pageListener?.('all'); page = pageOf(); }
    setSettingsPage(page);   // 进这一页会重画它：画完再找目标（上面找到的节点可能已被换掉）
    const target = page ? misc.querySelector(sectionSelector) : null;
    if (body && target) {
        // 手动算偏移而不是 scrollIntoView：后者可能连手机外面的页面一起滚
        body.scrollTop = target.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    }
    // 不把焦点挪到返回按钮：程序设的焦点会让它画出一圈键盘焦点框，鼠标用户看着像出了问题（点击跳转时没有地方需要焦点）
}

/** 打开手机并进某个应用的视图（和 openSettings 一样：手机收着就打开，没解过锁直接当作解锁，不为一个跳转再点一次指纹） */
function openAppView(id) {
    if (!root) return;
    unlocked = true;
    if (!open) openPhone();
    unlocking = false;
    showView(id);
    const body = root.querySelector(`.ph-view[data-view="${id}"] .ph-app-body`);
    if (body) body.scrollTop = 0;
}
/** 顶栏的当前卡片名、聊天区空状态里的链接：打开手机直接进 Meetup（存档树） */
export const openMeetup = () => openAppView('meetup');
export const openClippings = () => openAppView('clippings');
/** 窄屏上手机是铺满全屏的：从手机里跳去右侧面板的某一页（抽屉）之前要先收起它，不然抽屉开在手机后面看不到。宽屏手机是浮着的，不用收 */
export function closePhoneIfNarrow() { if (isNarrow()) closePhone(); }

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
        const t = (!open ? '打开手机' : (atTop ? '收起手机' : '回到手机桌面')) + (badgePages.size ? '（Settings 里有需要处理的事）' : '');
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
    }, h('span', { class: 'ph-tile-plate' }, icon(app.icon), h('span', { class: 'ph-dot', hidden: true, 'aria-hidden': 'true' })),   // 红点见 setSettingsBadge
        h('span', { class: 'ph-tile-name' }, app.name)));
    return h('section', { class: 'ph-view ph-home', 'data-view': 'home', hidden: true }, h('div', { class: 'ph-grid' }, tiles));
}

export function initPhone() {
    if (root) return;
    toggleBtn = document.querySelector('#phone-toggle');
    const extra = {};
    const lock = buildLock(extra);
    const status = createStatusBar(extra);
    const appViews = APPS.filter(a => a.kind === 'view').map(a => buildAppView(a, a.id === 'settings'
        ? { back: settingsBack, openPage: setSettingsPage }
        : { back: () => showView('home'), openPage: () => {} }));
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
    toggleBtn?.append(h('span', { class: 'ph-dot', hidden: true, 'aria-hidden': 'true' }));   // 顶栏图标上的红点
    syncBadges();    // 里面会调 syncChrome
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
