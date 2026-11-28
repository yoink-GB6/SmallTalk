// 手机 Settings 里的内容（原来右侧检查器的「杂项」页，搬进了手机，节点是 index.html 的 #tab-misc）。
// Settings 现在是两级菜单，内容按下一页分开（页的 id 见 apps.js 的 SETTINGS_PAGES）：
//   misc 页（杂项）：手动模式（静态）+ 变量 + 前端卡日志；  backup 页（备份）：整体备份、酒馆互通；  reset 页：清空所有数据；  install 页：安装到主屏幕（只有网页版）；
//   provider 页（接口）、preset 页（预设）：从右侧面板搬来的两页，各自的渲染函数在 tab-provider.js / tab-preset.js，这里只负责「进这一页时调它」；
//   style 页的主题下拉框、手动模式勾选框、几个「以后在这里」的占位都是 index.html 里的静态内容，这里不画。
// 「手动模式」勾选框是 index.html 里的常驻控件（事件在 src/app.js，值由 shell.js 的 renderTopbar 同步）。
// 「我叫」和人设描述已经挪到「人设」页（tab-persona.js）。

import { store } from '../store.js';
import { $, h, toast } from './dom.js';
import { state, ui, save, stopSaving, persist } from './state.js';
import { refreshPreview } from './pipeline.js';
import { backendKind } from '../llm.js';
import { backupSection } from './backup.js';   // 「整体备份」一节（备份全部数据 / 从备份恢复；逻辑都在 backup.js）
import { tavernSection } from './tavern-ui.js'; // 「和酒馆整体互通」一节（酒馆整体备份 zip 的导入 / 导出成酒馆目录结构；逻辑都在 tavern-ui.js）
import { pwaSection } from './pwa-ui.js';       // 「安装到主屏幕」一节（只在网页版显示；逻辑在 pwa-ui.js / src/pwa.js）
import { renderProviderTab } from './tab-provider.js';   // 「接口」页（和 tab-provider.js 有循环依赖：这里只在函数体里调用）
import { renderPresetTab } from './tab-preset.js';       // 「预设」页（同上）

// ───────────────────────────── 手机 Settings（原「杂项」页） ─────────────────────────────

/**
 * 重画 Settings 里某一页的动态部分。只画要看的那一页：进入那一页时、那一页开着且状态变了时调用；
 * 不可见的页不白画，也不会漏——每次进页都会重画一遍，所以菜单 → 下一页 → 返回 → 再进，看到的永远是最新的。
 * @param {string|null} [page] 页的 id；null / 菜单页没有动态内容，什么也不画；'all' 把这里自己画的几页全画（openSettings 要按选择器找还没画出来的元素时用；
 *   接口 / 预设两页不在 'all' 里：它们的容器是静态的，按选择器找得到，而接口页每画一次都要去读一遍接口列表，不值得为找个元素白画）
 * @param {boolean} [force] 只对「接口」页有意义：它平时不跟着后台重画走（见 tab-provider.js），进这一页时传 true 才重建
 */
export function renderMiscTab(page = 'all', force = false) {
    if (page === 'misc' || page === 'all') renderMiscPage();
    if (page === 'backup' || page === 'all') renderBackupPage();
    if (page === 'reset' || page === 'all') renderResetPage();
    if (page === 'install' || page === 'all') $('#misc-rest-install').replaceChildren(pwaSection());
    if (page === 'provider') renderProviderTab(force);
    if (page === 'preset') renderPresetTab();
}

function renderBackupPage() {
    $('#misc-rest-backup').replaceChildren(backupSection(), tavernSection());
}

function renderResetPage() {
    $('#misc-rest-reset').replaceChildren(
        h('div', { class: 'section-title' }, '数据'),
        h('div', { class: 'row' },
            h('button', { onclick: resetAll }, '清空所有数据')),
    );
}

function renderMiscPage() {
    const vars = ui.preview?.variables ?? state.variables;
    $('#misc-rest-misc').replaceChildren(
        h('div', { class: 'section-title' }, '变量（setvar / getvar）'),
        h('pre', { id: 'vars-view', class: 'block card', style: 'padding:8px 10px' }, JSON.stringify(vars, null, 2)),
        h('div', { class: 'row' },
            h('button', { onclick: () => { state.variables = { local: {}, global: {} }; save(); refreshPreview(); } }, '清空变量')),
        h('div', { class: 'section-title' }, '前端卡日志'),
        h('div', { class: 'dim', style: 'margin-bottom:4px' }, '消息里的前端卡（iframe）调用了哪些酒馆助手 API、哪些没实现、报了什么错。'),
        h('div', { id: 'frame-log', class: 'card', style: 'padding:6px 10px;max-height:300px;overflow:auto' }),
    );
    renderMiscLog();
}

/** 一条日志的文字：前端卡写楼层号（#3），酒馆助手脚本写脚本名（「名字」）；「脚本」页的日志区也用它 */
export const logLineText = l => `${l.time} ${l.scriptId !== undefined ? `「${l.scriptName ?? l.scriptId ?? '脚本沙箱'}」` : `#${l.messageId}`} [${l.level}] ${l.text}`;

export function renderMiscLog() {
    const box = $('#frame-log');
    if (!box) return;
    box.replaceChildren(...(ui.frameLog.length
        ? ui.frameLog.slice(-120).map(l => h('div', { class: `log-line ${l.level}` }, logLineText(l)))
        : [h('span', { class: 'dim' }, '（暂无）')]));
    box.scrollTop = box.scrollHeight;
}

export async function resetAll() {
    // 只读（比如另一个标签页正在写）时不能删：删了那边马上又会写回去一部分，留下残缺的数据
    if (persist.readOnly) return toast('这个标签页是只读的（见页面顶上的说明），不能清空数据', 'error');
    // 网页版（direct）的接口列表和 API key 存在同一个浏览器库的 'endpoints' 键里，下面「一次删光」会连它们一起删；
    // 本地服务版的接口配置在服务端文件里，不受影响。所以只有网页版要把这点写进确认框。
    const direct = await backendKind() === 'direct';
    if (!confirm('清空角色卡、预设、世界书、正则和聊天记录？' + (direct ? '\n\n网页版里保存在浏览器中的接口列表和 API key 也会一并删除（之后要重新添加接口、重新填 key）。' : ''))) return;
    // 先停掉保存（包括关页面时的那次），否则刷新前 state 又会被写回去
    await stopSaving();
    // 新布局的所有键（meta / global / card:* / chat:*）以及可能残留的旧 'state'：库里的东西全是我们的，一次删光
    const keys = await store.keys('');
    await store.batch(keys.map(k => ({ del: k })));
    location.reload();
}
