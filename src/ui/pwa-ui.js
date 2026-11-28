// 手机 Settings 的「安装到主屏幕」一节 + "有新版本"的常驻提示。状态和浏览器接口都在 src/pwa.js，这里只画界面、守住数据。
// 只在网页版（direct 后端）显示；本地版这一节是空的、隐藏的。
//
// 重载（切换到新版本）时数据是怎么保住的——确认过的事实：
//   - 所有改动都先进 state，再由 save()（state.js，400 ms 防抖）排进写入链；flushNow()（state.js）立刻把还在防抖里的改动
//     排进去，它返回的 Promise 在"到目前为止的改动都落盘"后才 resolve（失败 resolve 成 false）。
//   - archive.js 的 bindArchive 在 pagehide / beforeunload 里也会调 flushNow()，但那时发起的 IndexedDB 写入浏览器只是"一般会做完"，
//     不是保证。所以这里不靠它：重载之前先 await flushNow()，确认落盘了再重载。
//   - 正在生成回复时（ui.busy，chat.js 的 setBusy 设置）不能重载：流式回复还没写完。用户自己点"更新"时直接拒绝；
//     别的标签页点了更新、这个标签页被动重载时，等这条回复结束再重载。
//   - 正在切换存档（ui.switching）、正在恢复备份（persist.paused）时同样拒绝 / 等待，免得写到一半。
//   - 只读标签页（persist.readOnly）本来就不写存储，flushNow 直接返回，重载不丢东西（它的内容来自另一个标签页写下的数据）。
//   - 输入框里还没发出去的字不在 state 里、平时刷新会丢：重载前暂存到 sessionStorage（只属于这个标签页，重载后还在），
//     启动时放回输入框。
//   - 已知没保住的：正在原地编辑的消息（.mes.editing）。用户自己点更新时会被拒绝并提示先保存；被别的标签页带着重载时会丢掉这段编辑。

import { $, h, toast } from './dom.js';
import { ui, persist, flushNow } from './state.js';
import { installHelpNodes, IPHONE_FIRST_NOTE, initFirstRunGuide } from './first-run-guide.js';
import { pwaEvents, getPwaState, initPwa, setBeforeReload, applyUpdate, promptInstall, requestPersist } from '../pwa.js';

const DRAFT_KEY = 'smalltalk-update-draft';   // sessionStorage 里暂存输入框内容的键
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 现在能不能重载？能 → null，不能 → 原因（给用户看） */
function reloadBlocker() {
    if (ui.busy) return '正在生成回复，等它结束（或点「停止」）再更新';
    if (ui.switching) return '正在切换存档，稍等一下再更新';
    if (persist.paused) return '正在从备份恢复，等它完成再更新';
    if (document.querySelector('#chat .mes.editing')) return '有消息正在编辑：先保存或取消编辑，再更新';
    return null;
}

/** 重载前：等到能重载（被别的标签页带着更新时用）、落盘、暂存输入框 */
async function prepareReload() {
    let told = false;
    // 只等"生成中 / 切换中 / 恢复中"（编辑中的消息不等：等不到头，只能丢）
    while (ui.busy || ui.switching || persist.paused) {
        if (!told) { toast('新版本已启用：等这次操作结束后页面会自动刷新'); told = true; }
        await sleep(300);
    }
    await flushNow();
    try {
        const v = $('#send_textarea')?.value ?? '';
        if (v) sessionStorage.setItem(DRAFT_KEY, v);
    } catch {}
}

/** 启动时：把重载前暂存的输入框内容放回去（只放进空的输入框，然后删掉暂存） */
function restoreDraft() {
    let v = null;
    try { v = sessionStorage.getItem(DRAFT_KEY); sessionStorage.removeItem(DRAFT_KEY); } catch {}
    const input = $('#send_textarea');
    if (v && input && !input.value) {
        input.value = v;
        input.dispatchEvent(new Event('input'));   // 让「拼装」页的预览跟上（和用户自己打字一样）
    }
}

/** 用户点"更新到新版本"（手机 Settings 的按钮或常驻提示） */
async function startUpdate() {
    const why = reloadBlocker();
    if (why) { toast(why, 'error'); return; }
    if (!await flushNow()) { toast('当前内容没能保存，已取消更新', 'error'); return; }
    if (reloadBlocker()) { toast(reloadBlocker(), 'error'); return; }   // 上面等待落盘期间又开始生成了
    if (!applyUpdate()) toast('没找到新版本（可能已经在别的标签页更新过了），刷新一下页面试试', 'error');
    // 成功的话接下来会收到 controllerchange → prepareReload → 重载（src/pwa.js）
}

// ───────────────────────────── 常驻提示 ─────────────────────────────

let banner = null;
function paintBanner(s) {
    if (!banner) return;
    const show = s.updateReady;
    banner.hidden = !show;
    banner.disabled = s.updating;
    banner.textContent = s.updating ? '正在更新…' : '有新版本，点这里更新';
    document.body.classList.toggle('pwa-has-update', show);
}

// ───────────────────────────── 手机 Settings 那一节 ─────────────────────────────

/** 给 tab-misc.js 用：返回这一节的容器（同步返回，内容按当前状态画；状态变了自己重画） */
export function pwaSection() {
    const box = h('div', { class: 'pwa-section', 'data-fk': 'pwa-section' });
    paintSection(box, getPwaState());
    return box;
}

function paintSection(box, s) {
    if (s.backend !== 'direct') { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const installed = s.standalone || s.justInstalled;
    const lines = [
        h('div', { class: 'section-title' }, '安装到主屏幕'),
        h('div', { class: 'row', 'data-fk': 'pwa-install-state' },
            h('span', null, installed ? (s.standalone ? '现在是以装到主屏幕的应用打开的' : '已经装到主屏幕 / 桌面了') : '现在是在浏览器里打开的'),
            s.installable && !installed ? h('button', { 'data-fk': 'pwa-install', onclick: onInstall }, '安装') : null),
    ];
    if (!installed && !s.installable) {
        lines.push(h('div', { class: 'dim pwa-desc', 'data-fk': 'pwa-install-help' },
            ...installHelpNodes(), h('div', null, IPHONE_FIRST_NOTE)));   // 说明文字和首次指引弹窗共用一份（first-run-guide.js）
    }
    lines.push(h('div', { class: 'dim pwa-desc' }, '为什么值得装：iPhone 的 Safari 会清掉 7 天没访问过的网站的数据，装到主屏幕的不受影响；装好后断网也能打开。'));

    // 存储
    const storeText = s.persisted === true ? '浏览器已承诺不会自动清理这里的数据'
        : s.persisted === false ? '浏览器还没承诺保留数据（空间紧张时可能被清理）'
        : s.persisted === 'unsupported' ? '这个浏览器不支持"请求保留数据"'
        : '正在查询…';
    const askResult = {
        granted: '浏览器同意了：这里的数据不会被自动清理。',
        denied: '浏览器没有同意（有的浏览器要等你常用这个网站、或装到主屏幕之后才会同意）。请记得定期用下面的「整体备份」备份数据。',
        unsupported: '这个浏览器不支持这项请求。请记得定期用下面的「整体备份」备份数据。',
        error: '请求出错了。请记得定期用下面的「整体备份」备份数据。',
    }[s.persistAsked];
    lines.push(h('div', { class: 'row', 'data-fk': 'pwa-storage' },
        h('span', null, '存储：' + storeText),
        s.persisted === false ? h('button', { 'data-fk': 'pwa-persist', onclick: onPersist }, '请浏览器保留数据') : null));
    if (askResult) lines.push(h('div', { class: 'dim pwa-desc', 'data-fk': 'pwa-persist-result' }, askResult));

    // 离线缓存 / 版本
    const swText = s.sw === 'ready' ? `已就绪${s.version ? `（版本 ${s.version}）` : ''}`
        : s.sw === 'pending' ? '正在准备…'
        : s.sw === 'failed' ? `没准备好：${s.swReason}`
        : `未启用${s.swReason ? `（${s.swReason}）` : ''}`;
    lines.push(h('div', { class: 'row', 'data-fk': 'pwa-version' },
        h('span', null, '离线缓存：' + swText),
        s.updateReady ? h('button', { class: 'primary', 'data-fk': 'pwa-update', disabled: s.updating, onclick: startUpdate },
            s.updating ? '正在更新…' : '更新到新版本' + (s.newVersion ? `（${s.newVersion}）` : '')) : null));
    box.replaceChildren(...lines);
}

async function onInstall() {
    const r = await promptInstall();
    if (r === 'dismissed') toast('没有安装。之后想装还可以用浏览器菜单里的"安装应用"');
}

async function onPersist() {
    await requestPersist();   // 结果记在状态里，'change' 事件会把这一节重画出来
}

/** 状态变了：重画常驻提示，以及手机 Settings 里这一节（如果它正挂在页面上） */
function repaint() {
    const s = getPwaState();
    paintBanner(s);
    const box = document.querySelector('[data-fk="pwa-section"]');
    if (box) paintSection(box, s);
}

// ───────────────────────────── 启动 ─────────────────────────────

/** app.js 启动流程里调用一次（不用 await：不挡页面启动） */
export function initPwaUi() {
    restoreDraft();
    banner = h('button', { id: 'pwa-update-banner', type: 'button', class: 'pwa-update-banner', 'data-fk': 'pwa-update-banner', hidden: true, onclick: startUpdate },
        '有新版本，点这里更新');
    document.body.append(banner);
    pwaEvents?.addEventListener('change', repaint);
    setBeforeReload(prepareReload);
    initFirstRunGuide();   // 首次打开的小指引（只在网页版、没装 / 没持久时弹；自己订阅 pwaEvents）
    return initPwa().catch(e => console.debug('离线缓存初始化失败', e));
}
