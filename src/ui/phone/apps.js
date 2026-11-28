// 手机桌面上的应用清单，和每个应用自己的画面。
//
// 加一个应用要改的地方：
//   1. 下面 APPS 加一项 { id, name, icon }（icon 是 icons.js 里的名字，没有就在那边加一个线条图标）；
//   2. 要有自己的画面就在 buildAppView 里给它加分支（现在 Chat / Music / Reading 是空白占位；Settings 有内容：两级菜单，见下面 SETTINGS_PAGES）；
//   3. phone.css 里一般不用动：桌面是按清单自动排的格子。
// 第一版全是空壳：这里不读不写任何用户数据。

import { h } from '../dom.js';
import { icon } from './icons.js';

/** kind: 'view' = 点了进它自己的画面；'exit' = 点了直接收起手机、露出后面的 RP 画面（现在没有应用用它，留着备用） */
export const APPS = [
    { id: 'settings', name: 'Settings', icon: 'settings', kind: 'view' },
    { id: 'chat', name: 'Chat', icon: 'chat', kind: 'view' },
    { id: 'music', name: 'Music', icon: 'music', kind: 'view' },
    { id: 'reading', name: 'Reading', icon: 'reading', kind: 'view' },
    { id: 'meetup', name: 'Meetup', icon: 'meetup', kind: 'view' },        // 原来的「存档」页：在这里选角色 / 存档，再进入 RP
    { id: 'clippings', name: 'Clippings', icon: 'clippings', kind: 'view' },   // 原来的「摘抄」页
];

/**
 * Settings 的菜单项（也就是它的「下一页」）。id 要和 index.html 里 #tab-misc 下各 section.ph-set-page 的 data-page 一一对应。
 * 加一页：这里加一项 + index.html 里加一个同 data-page 的 section（动态内容放进它里面的 .misc-rest，并在 tab-misc.js 的 renderMiscTab 里登记）。
 * only: 'web' = 只有网页版才显示（本地版没有「安装到主屏幕」）；是否显示由 pwa-ui.js 通过 setSettingsItemHidden 决定，默认先藏着，免得本地版闪一下。
 */
export const SETTINGS_PAGES = [
    { id: 'lock', name: '锁屏壁纸' },
    { id: 'desktop', name: '桌面' },
    { id: 'style', name: '风格' },
    { id: 'install', name: '安装到主屏幕', only: 'web' },
    { id: 'provider', name: '接口' },      // 原来右侧面板的「接口」页（index.html 的 #tab-provider）
    { id: 'preset', name: '预设' },        // 原来右侧面板的「预设」页（#tab-preset）
    { id: 'backup', name: '备份' },        // 整体备份 + 和酒馆整体互通
    { id: 'misc', name: '杂项' },          // 手动模式、变量、前端卡日志
    { id: 'reset', name: '清空所有数据' },
];

/** 空白应用画面里的那句话（简短自然就行，以后换成真内容时整段删掉） */
const PLACEHOLDER = {
    chat: '还没有对话。这里以后是手机里的聊天。',
    music: '还没有音乐。',
    reading: '书架是空的。',
};

/**
 * 一个应用的画面：标题栏（返回 + 应用名）+ 内容区。
 * @param {typeof APPS[number]} app
 * @param {{back: () => void, openPage: (id: string) => void}} nav
 *   back：标题栏返回按钮（phone.js 决定：在 Settings 的下一页里 = 回菜单，别处 = 回桌面）；openPage：Settings 菜单点一项
 */
export function buildAppView(app, nav) {
    const body = h('div', { class: 'ph-app-body' });
    if (app.id === 'settings') {
        // Settings 是两级菜单：menu（一行一项）→ 点一项进 #tab-misc 里的一页（phone.js 控制哪个显示）。
        // 原来右侧面板的「杂项」页整个搬进来了：把 index.html 里的 #tab-misc 这个节点本身挪进这里（不是复制），
        // 它现在只是各个下一页（section.ph-set-page）的容器。
        // 为什么挪节点而不是在这里重画一份：里面的 id / data-fk（#theme-select、#manual-mode、#vars-view……）、
        // 手动模式勾选框的事件（app.js）、renderMiscTab（tab-misc.js）都认这些节点，一份就够，也不会出现两个主题下拉框。
        // 去掉 class="tab"：那个类是右侧面板「一次只显示一页」的机制（style.css 的 .tab / .tab.active），搬进手机后不归它管。
        // 内容由 tab-misc.js 的 renderMiscTab 按页填：进入某一页时、那一页开着且状态变了时重画（见 shell.js 的 renderInspector）。
        const menu = h('nav', { class: 'ph-menu', 'aria-label': '设置菜单' },
            SETTINGS_PAGES.map(p => h('button', {
                class: 'ph-menu-row', type: 'button', 'data-page': p.id, onclick: () => nav.openPage(p.id),
                hidden: p.only === 'web',
            },
                h('span', { class: 'ph-menu-name' }, p.name),
                h('span', { class: 'ph-dot', hidden: true, 'aria-hidden': 'true' }),   // 红点：phone.js 的 setSettingsBadge 控制
                icon('chevron'))));
        body.append(menu);
        const misc = document.querySelector('#tab-misc');
        if (misc) {
            misc.classList.remove('tab');
            misc.classList.add('ph-settings');
            misc.hidden = true;   // 菜单页时整个藏起来；进了某一页再显示
            body.append(misc);
        }
    } else if (app.id === 'meetup' || app.id === 'clippings') {
        // 和 Settings 同一个做法：把右侧面板里原来的页（#tab-archive「存档」/ #tab-excerpts「摘抄」）的节点本身挪进来，id / data-fk 一律不变，
        // 渲染函数（tab-archive.js renderArchiveTab / tab-excerpts.js renderExcerptsTab）一行没改，认的还是这个节点。
        // class 'tab' 是右侧面板「一次显示一页」的机制，搬进来后去掉；加 ph-settings（让页内按钮保持页面通用的样子，不被手机的按钮重置规则抹掉）和 ph-page。
        const page = document.querySelector(app.id === 'meetup' ? '#tab-archive' : '#tab-excerpts');
        if (page) {
            page.classList.remove('tab', 'active');
            page.classList.add('ph-settings', 'ph-page');
            body.append(page);
        }
    } else {
        body.append(h('div', { class: 'ph-empty' }, icon(app.icon), h('p', null, PLACEHOLDER[app.id] ?? '还没做。')));
    }
    // data-page：Settings 当前在哪一页（'menu' = 菜单页），phone.js 的 setSettingsPage 维护，别的应用没有这个属性
    return h('section', { class: 'ph-view ph-app', 'data-view': app.id, 'data-page': app.id === 'settings' ? 'menu' : null, hidden: true },
        h('header', { class: 'ph-app-head' },
            h('button', { class: 'ph-back', type: 'button', 'aria-label': '返回桌面', title: '返回桌面', onclick: nav.back }, icon('back')),
            h('h2', { class: 'ph-app-title' }, app.name),
            h('span', { class: 'ph-app-head-pad' })),
        body);
}
