// 检查器「杂项」页：手动模式、变量、前端卡日志、整体备份、清空数据。
// 「手动模式」勾选框是 index.html 里的常驻控件（事件在 src/app.js，值由 shell.js 的 renderTopbar 同步），
// 这里只画后面那一大段（#misc-rest）。「我叫」和人设描述已经挪到「人设」页（tab-persona.js）。

import { store } from '../store.js';
import { $, h, toast } from './dom.js';
import { state, ui, save, stopSaving, persist } from './state.js';
import { refreshPreview } from './pipeline.js';
import { backendKind } from '../llm.js';
import { openSearch } from './chat-search.js';
import { backupSection } from './backup.js';   // 「整体备份」一节（备份全部数据 / 从备份恢复；逻辑都在 backup.js）
import { tavernSection } from './tavern-ui.js'; // 「和酒馆整体互通」一节（酒馆整体备份 zip 的导入 / 导出成酒馆目录结构；逻辑都在 tavern-ui.js）
import { pwaSection } from './pwa-ui.js';       // 「安装到主屏幕」一节（只在网页版显示；逻辑在 pwa-ui.js / src/pwa.js）

// ───────────────────────────── 检查器：杂项 ─────────────────────────────

export function renderMiscTab() {
    const vars = ui.preview?.variables ?? state.variables;
    $('#misc-rest').replaceChildren(
        // 聊天内搜索的入口（原来在聊天区顶上）。窄屏下检查器是盖住聊天区的抽屉，先收起才看得到搜索栏
        h('div', { class: 'row' },
            h('button', { id: 'misc-search-btn', 'data-fk': 'misc-search', type: 'button', title: '在当前存档里搜索', onclick: () => {
                document.body.classList.remove('drawer-open');
                document.querySelector('#drawer-toggle')?.setAttribute('aria-expanded', 'false');
                openSearch();
            } }, '搜索聊天记录')),
        h('div', { class: 'section-title' }, '变量（setvar / getvar）'),
        h('div', { class: 'dim', style: 'margin-bottom:4px' }, '预设里的 {{setvar}} 在拼装时按条目顺序执行；这里是拼完之后的值。'),
        h('pre', { id: 'vars-view', class: 'block card', style: 'padding:8px 10px' }, JSON.stringify(vars, null, 2)),
        h('div', { class: 'row' },
            h('button', { onclick: () => { state.variables = { local: {}, global: {} }; save(); refreshPreview(); } }, '清空变量')),
        h('div', { class: 'section-title' }, '前端卡日志'),
        h('div', { class: 'dim', style: 'margin-bottom:4px' }, '消息里的前端卡（iframe）调用了哪些酒馆助手 API、哪些没实现、报了什么错。'),
        h('div', { id: 'frame-log', class: 'card', style: 'padding:6px 10px;max-height:300px;overflow:auto' }),
        pwaSection(),
        backupSection(),
        tavernSection(),
        h('div', { class: 'section-title' }, '数据'),
        h('div', { class: 'row' },
            h('button', { onclick: resetAll }, '清空所有数据'),
            h('span', { class: 'dim' }, '所有内容只存在这个浏览器的 IndexedDB 里')),
    );
    renderMiscLog();
}

export function renderMiscLog() {
    const box = $('#frame-log');
    if (!box) return;
    box.replaceChildren(...(ui.frameLog.length
        ? ui.frameLog.slice(-120).map(l => h('div', { class: `log-line ${l.level}` }, `${l.time} #${l.messageId} [${l.level}] ${l.text}`))
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
