// 网页版「首次打开的小指引」：浏览器角落里一张小卡片，把「安装到主屏幕」和「让浏览器保留数据」两步直接摆到用户面前。
// （「杂项」页的「安装到主屏幕」一节还在，那里是常驻入口；这里只是新用户不会去翻杂项页，所以把它提到前面来。）
//
// 为什么要弹：网页版的数据全存在各人的浏览器里。两件事能保住它——① 装到主屏幕（iPhone 的 Safari 会清掉 7 天没访问的网站数据，
// 装了的不受影响）；② 浏览器答应"长期保留本站数据"（navigator.storage.persist()）。
//
// 什么时候弹（只在启动后判断一次，见 maybeLaunch）：
//   网页版（pwa.js 探测出 backend === 'direct'）+ 不是从主屏幕打开的 + 浏览器还没给持久存储 + 用户没点过「不再提示」 + 这个标签页能写数据。
//   本地版、已经装了、已经持久了：都不弹。
// 点「以后再说」：只在这次页面会话里不再出现（模块变量，刷新就没了，下次打开还弹）；点「不再提示」：记在 localStorage（永远不弹）。
// 弹出之后的显示状态全部从 getPwaState() 来（和「杂项」页那一节同源），pwaEvents 一变就重画。
//
// 让路：有新版本的提示条、恢复备份的过程中、标签页变成只读时，卡片先藏起来（状态还在），条件消失再显示。
// 卡片在右下角（窄屏贴底部），z-index 比页内弹框的遮罩低，弹框出现时盖住它。
//
// UI 模块之间有循环依赖：本文件不 import pwa-ui.js（反过来由 pwa-ui.js 导入这里）；顶层语句不调用兄弟 ui 模块的函数。

import { h } from './dom.js';
import { persist } from './state.js';
import { pwaEvents, getPwaState, promptInstall, requestPersist } from '../pwa.js';

/** localStorage：点过「不再提示」就是 '1'（这台设备的界面偏好，登记在 data-inventory.js 的 LOCAL_STORAGE_PREFS，不进备份） */
export const GUIDE_OFF_KEY = 'smalltalk.firstRunGuideOff';

let el = null;              // 卡片（还没弹过就是 null）
let snoozed = false;        // 「以后再说」：这次会话不再弹
let launched = false;       // 已经做过"要不要弹"的判断（只判断一次）
let installMsg = '';        // 点「安装」之后就地显示的结果
let timer = null;           // 弹着时每秒看一次让路条件（只读 / 恢复备份中不发 pwa 事件）
let closing = false;        // 两步都完成了，正在显示"好了"

const guideOff = () => { try { return localStorage.getItem(GUIDE_OFF_KEY) === '1'; } catch { return false; } };

/**
 * 没有安装事件的浏览器里，「安装」按钮换成的就地说明。
 * 「杂项」页的那一节也用它（pwa-ui.js 导入），所以文案只有这一份。
 */
export function installHelpNodes() {
    return [
        h('div', null, 'iPhone / iPad：用 Safari 打开这个网页，点"分享"→"添加到主屏幕"。'),
        h('div', null, '安卓：用 Chrome 打开，点右上角菜单里的"添加到主屏幕"或"安装应用"。'),
    ];
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || '');

/** 让路：新版本提示条在顶上、恢复备份时页面在换数据、只读标签页不该打扰。只改显隐，不重画（免得点击中途按钮被换掉） */
function applyYield() {
    if (el) el.hidden = snoozed || getPwaState().updateReady || persist.paused || persist.readOnly;
}

function paint() {
    if (!el) return;
    const s = getPwaState();
    const installed = s.standalone || s.justInstalled;
    const persistDone = s.persisted === true;
    const persistNA = s.persisted === 'unsupported';   // 这个浏览器根本没有这项功能：没法做，别让用户干等
    const done = installed && (persistDone || persistNA);

    applyYield();

    // 第一步：安装
    const installRow = h('div', { class: 'fr-step', 'data-fk': 'guide-install' },
        installed ? h('div', { class: 'fr-done' }, '✓ 已经装到主屏幕 / 桌面了')
        : s.installable ? h('div', { class: 'row' },
            h('span', null, '像普通应用一样从桌面打开'),
            h('button', { type: 'button', class: 'primary', 'data-fk': 'guide-install-btn', onclick: onInstall }, '安装到主屏幕'))
        : h('div', { class: 'dim', 'data-fk': 'guide-install-help' }, ...installHelpNodes()),
        installMsg && !installed ? h('div', { class: 'dim', 'data-fk': 'guide-install-msg' }, installMsg) : null);

    // 第二步：持久存储
    const askText = {
        granted: '',   // 成功时上面的 ✓ 已经说明了
        denied: '浏览器没答应。有的浏览器要先装到主屏幕、或多用几次这个网站才会答应；记得定期做整体备份。',
        unsupported: '',
        error: '请求出错了，记得定期做整体备份。',
    }[s.persistAsked] ?? '';
    const persistRow = h('div', { class: 'fr-step', 'data-fk': 'guide-persist' },
        persistDone ? h('div', { class: 'fr-done' }, '✓ 浏览器答应长期保留本站的数据了')
        : persistNA ? h('div', { class: 'dim' }, '这个浏览器不支持"请求保留数据"，记得定期做整体备份。')
        : h('div', { class: 'row' },
            h('span', null, '让浏览器别自动清理这里的数据'),
            h('button', { type: 'button', class: 'primary', 'data-fk': 'guide-persist-btn', onclick: () => requestPersist() }, '让浏览器保留数据')),
        askText && !persistDone ? h('div', { class: 'dim', 'data-fk': 'guide-persist-msg' }, askText) : null);

    el.replaceChildren(
        h('div', { class: 'fr-title' }, done ? '好了，数据更稳了' : '数据只存在这台设备的浏览器里，做这两步更不容易丢'),
        done ? null : installRow,
        done ? null : persistRow,
        // 浏览器不允许网页自己往收藏夹里加东西，做不成按钮，只留一句提示
        done ? null : h('div', { class: 'dim fr-fav' }, `也可以顺手收藏本站：电脑上按 ${isMac() ? '⌘D' : 'Ctrl+D'}。`),
        done ? null : h('div', { class: 'fr-foot' },
            h('button', { type: 'button', 'data-fk': 'guide-later', onclick: () => { snoozed = true; close(); } }, '以后再说'),
            h('button', { type: 'button', 'data-fk': 'guide-never', onclick: onNever }, '不再提示')));

    if (done && !closing) { closing = true; setTimeout(close, 2500); }   // 先让用户看到一句"好了"
}

function close() {
    clearInterval(timer);
    el?.remove();
    el = null;
}

function onNever() {
    try { localStorage.setItem(GUIDE_OFF_KEY, '1'); } catch {}   // 写不进去（隐私模式）就只有这次会话不弹
    snoozed = true;
    close();
}

async function onInstall() {
    const r = await promptInstall();
    installMsg = r === 'dismissed' ? '没有安装。之后想装还可以用浏览器菜单里的"安装应用"。'
        : r === 'unavailable' ? '浏览器现在没法直接安装，请用浏览器菜单里的"安装应用"/"添加到主屏幕"。' : '';
    paint();   // accepted 时 appinstalled 事件会再触发一次重画
}

/** 状态变了：还没判断过就判断一次；弹着就重画 */
function onChange() {
    if (!launched) maybeLaunch();
    else paint();
}

function maybeLaunch() {
    const s = getPwaState();
    if (s.backend === null) return;                          // 还没探测出是哪种形态
    if (s.backend !== 'direct') { launched = true; return; } // 本地版：永远不弹
    if (s.persisted === null) return;                        // 持久状态还没查回来，等下一次 change
    launched = true;
    if (s.standalone || s.justInstalled || s.persisted === true) return;   // 已经装了 / 已经持久了
    if (guideOff() || snoozed || persist.readOnly) return;
    el = h('div', { class: 'fr-guide', role: 'dialog', 'aria-label': '首次打开的小指引', 'data-fk': 'first-run-guide' });
    document.body.append(el);
    paint();
    timer = setInterval(applyYield, 1000);
}

/** pwa-ui.js 的 initPwaUi 里调用一次（不 await、不挡启动） */
export function initFirstRunGuide() {
    pwaEvents?.addEventListener('change', onChange);
    onChange();   // initPwa 可能已经跑完了
}
