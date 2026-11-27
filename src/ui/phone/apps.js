// 手机桌面上的应用清单，和每个应用自己的画面。
//
// 加一个应用要改的地方：
//   1. 下面 APPS 加一项 { id, name, icon }（icon 是 icons.js 里的名字，没有就在那边加一个线条图标）；
//   2. 要有自己的画面就在 buildAppView 里给它加分支（现在 Chat / Music / Reading 是空白占位，Settings 有内容）；
//   3. phone.css 里一般不用动：桌面是按清单自动排的格子。
// 第一版全是空壳：这里不读不写任何用户数据。

import { h } from '../dom.js';
import { icon } from './icons.js';
import { bindThemeSelect } from '../theme.js';

/** kind: 'view' = 点了进它自己的画面；'exit' = 点了收起手机、露出后面原来的 RP 画面（Meetup） */
export const APPS = [
    { id: 'settings', name: 'Settings', icon: 'settings', kind: 'view' },
    { id: 'chat', name: 'Chat', icon: 'chat', kind: 'view' },
    { id: 'music', name: 'Music', icon: 'music', kind: 'view' },
    { id: 'reading', name: 'Reading', icon: 'reading', kind: 'view' },
    { id: 'meetup', name: 'Meetup', icon: 'meetup', kind: 'exit' },
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
        // 主题：复用 src/ui/theme.js 的选择逻辑（bindThemeSelect 填选项、选了就切并记进 localStorage，和「杂项」页那个下拉框是同一套、互相同步），这里不另存一份
        const sel = h('select', { id: 'phone-theme-select', 'aria-label': '界面主题' });
        bindThemeSelect(sel);
        body.append(
            h('div', { class: 'ph-set-list' },
                h('label', { class: 'ph-set-row', for: 'phone-theme-select' }, h('span', { class: 'ph-set-name' }, '主题'), sel),
                h('div', { class: 'ph-set-row ph-set-todo' }, h('span', { class: 'ph-set-name' }, '壁纸'), h('span', { class: 'dim' }, '以后在这里换')),
            ));
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
