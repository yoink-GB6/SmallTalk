// 手机桌面上的应用清单，和每个应用自己的画面。
//
// 加一个应用要改的地方：
//   1. 下面 APPS 加一项 { id, name, icon }（icon 是 icons.js 里的名字，没有就在那边加一个线条图标）；
//   2. 要有自己的画面就在 buildAppView 里给它加分支（现在 Chat / Music / Reading 是空白占位；Settings 有内容：原来右侧面板的「杂项」页整个搬进来了）；
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

/** 空白应用画面里的那句话（简短自然就行，以后换成真内容时整段删掉） */
const PLACEHOLDER = {
    chat: '还没有对话。这里以后是手机里的聊天。',
    music: '还没有音乐。',
    reading: '书架是空的。',
};

/**
 * 一个应用的画面：标题栏（返回 + 应用名）+ 内容区。
 * @param {typeof APPS[number]} app
 * @param {() => void} goHome 回桌面（标题栏的返回按钮用）
 */
export function buildAppView(app, goHome) {
    const body = h('div', { class: 'ph-app-body' });
    if (app.id === 'settings') {
        // 原来右侧面板的「杂项」页整个搬进来了：把 index.html 里的 #tab-misc 这个节点本身挪进这里（不是复制）。
        // 为什么挪节点而不是在这里重画一份：里面的 id / data-fk（#theme-select、#manual-mode、#misc-rest……）、
        // 手动模式勾选框的事件（app.js）、renderMiscTab（tab-misc.js）都认这个节点，一份就够，也不会出现两个主题下拉框。
        // 去掉 class="tab"：那个类是右侧面板「一次只显示一页」的机制（style.css 的 .tab / .tab.active），搬进手机后不归它管。
        // 内容由 tab-misc.js 的 renderMiscTab 填：每次进入 Settings、Settings 开着时状态变了都会重画（见 shell.js 的 renderInspector）。
        const misc = document.querySelector('#tab-misc');
        if (misc) {
            misc.classList.remove('tab');
            misc.classList.add('ph-settings');
            // 壁纸占位放在主题那一行后面（主题行是静态的，不随 renderMiscTab 重画）
            misc.querySelector('.theme-row')?.after(
                h('div', { class: 'ph-set-list ph-wall-row' },
                    h('div', { class: 'ph-set-row ph-set-todo' }, h('span', { class: 'ph-set-name' }, '壁纸'), h('span', { class: 'dim' }, '以后在这里换'))));
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
    return h('section', { class: 'ph-view ph-app', 'data-view': app.id, hidden: true },
        h('header', { class: 'ph-app-head' },
            h('button', { class: 'ph-back', type: 'button', 'aria-label': '返回桌面', title: '返回桌面', onclick: goHome }, icon('back')),
            h('h2', { class: 'ph-app-title' }, app.name),
            h('span', { class: 'ph-app-head-pad' })),
        body);
}
