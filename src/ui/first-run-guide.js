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
// 页面正中间的卡片，后面一层半透明底；点底不关，只能点「以后再说」/「不再提示」，Esc 等于「以后再说」。
// z-index 24，比页内弹框的遮罩（25，恢复备份的面板、确认框）低，它们出现时盖住这张卡。
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

/** iPhone / iPad 的提醒（按 iOS 的一般行为写的，没在真机上验证）。弹窗的「注：」和「杂项」页的安装说明共用这一句 */
export const IPHONE_FIRST_NOTE = 'iPhone / iPad 请先添加到主屏幕再开始用：主屏幕上的应用和 Safari 里的网页是两份互不相通的数据，先在 Safari 里用了再装，就得用整体备份手动搬一遍。';

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

    // 第一行：安装。有安装事件 = 真按钮；没有（iPhone / iPad 的 Safari、Firefox 等）= 同一个位置换成就地的操作提示。
    // 电脑上也照写"手机 / 平板："（电脑的 Chrome / Edge 同样能安装，不另做分支）
    const installRow = h('div', { class: 'fr-step', 'data-fk': 'guide-install' },
        installed ? h('div', { class: 'fr-done' }, '✓ 已添加到主屏幕')
        : s.installable ? h('div', { class: 'row' },
            h('span', null, '手机 / 平板：'),
            h('button', { type: 'button', class: 'primary', 'data-fk': 'guide-install-btn', onclick: onInstall }, '添加到主屏幕'))
        : h('div', null, h('div', null, '手机 / 平板：'), h('div', { class: 'dim', 'data-fk': 'guide-install-help' }, ...installHelpNodes())),
        installMsg && !installed ? h('div', { class: 'dim', 'data-fk': 'guide-install-msg' }, installMsg) : null);

    // 第二行：持久存储，结果就地显示
    const askText = { denied: '浏览器没答应，可以先添加到主屏幕再试', error: '请求出错了，可以先添加到主屏幕再试' }[s.persistAsked] ?? '';
    const persistRow = h('div', { class: 'fr-step', 'data-fk': 'guide-persist' },
        persistDone ? h('div', { class: 'fr-done' }, '✓ 已保留')
        : persistNA ? h('div', { class: 'dim' }, '这个浏览器不支持"保留数据"这项请求')   // 没法做，别让用户干等
        : h('button', { type: 'button', class: 'primary', 'data-fk': 'guide-persist-btn', onclick: () => requestPersist() }, '让浏览器保留数据'),
        askText && !persistDone ? h('div', { class: 'dim', 'data-fk': 'guide-persist-msg' }, askText) : null);

    el.replaceChildren(h('div', { class: 'fr-card' },
        h('div', { class: 'fr-title' }, done ? '好了，数据更稳了' : '以防聊天丢失'),
        done ? null : installRow,
        done ? null : persistRow,
        done ? null : h('div', { class: 'dim fr-note' }, '注：数据只存在这台设备的浏览器里。浏览器可能在空间不够或很久没打开时自动清掉（iPhone 的 Safari 是 7 天没打开就清），清掉就找不回来。' + IPHONE_FIRST_NOTE + '也请定期做整体备份。'),
        done ? null : h('div', { class: 'fr-foot' },
            h('button', { type: 'button', 'data-fk': 'guide-later', onclick: later }, '以后再说'),
            h('button', { type: 'button', 'data-fk': 'guide-never', onclick: onNever }, '不再提示'))));

    if (done && !closing) { closing = true; setTimeout(close, 2500); }   // 先让用户看到一句"好了"
}

function later() { snoozed = true; close(); }

/** Esc = 「以后再说」。别的弹框（确认框、导出面板）开着时 Esc 归它们，这里不抢 */
function onKey(e) {
    if (e.key !== 'Escape' || !el || el.hidden || e.defaultPrevented) return;
    if (document.querySelector('.bk-overlay')) return;
    later();
}

function close() {
    document.removeEventListener('keydown', onKey);
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
    el = h('div', { class: 'fr-guide', role: 'dialog', 'aria-modal': 'true', 'aria-label': '以防聊天丢失', 'data-fk': 'first-run-guide' });
    document.body.append(el);
    paint();
    timer = setInterval(applyYield, 1000);
    document.addEventListener('keydown', onKey);
}

/** pwa-ui.js 的 initPwaUi 里调用一次（不 await、不挡启动） */
export function initFirstRunGuide() {
    pwaEvents?.addEventListener('change', onChange);
    onChange();   // initPwa 可能已经跑完了
}
