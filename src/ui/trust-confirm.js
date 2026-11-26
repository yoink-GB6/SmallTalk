// 「允许直接操作页面」打开前的页内确认框（tab-scripts.js 调；写法照 regex-delete.js 的 askRegexFate）。
//
// 为什么要页内框而不是 confirm()：这是一个安全决定，要把「会发生什么」写清楚（能读到 key、改页面、脚本变了会自动关）；
// 原生 confirm 只能放一行字，而且样式上和脚本弹的东西分不清。初始焦点在「取消」：手滑按回车什么都不会发生。
//
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { h } from './dom.js';

/**
 * 问一次：真的要让这张卡的脚本直接操作页面吗。
 * @param {{cardName: string, scriptNames: string[]}} o
 * @returns {Promise<boolean>} true = 用户点了「打开」；Esc / 点遮罩 / 取消 = false
 */
export function askTrust({ cardName, scriptNames }) {
    return new Promise(resolve => {
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
        const close = r => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(r); };
        const names = scriptNames.slice(0, 6).map(n => h('li', null, n || '(未命名)'));
        if (scriptNames.length > 6) names.push(h('li', { class: 'dim' }, `等 ${scriptNames.length} 个`));
        const cancel = h('button', { type: 'button', 'data-fk': 'trust-cancel', onclick: () => close(false) }, '取消');
        const ok = h('button', { type: 'button', class: 'danger', 'data-fk': 'trust-ok', onclick: () => close(true) }, '打开');
        const title = `允许「${cardName}」的脚本直接操作页面？`;
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': 'trust-dialog', onmousedown: e => { if (e.target === overlay) close(false); } },
            h('div', { class: 'bk-panel imp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
                h('div', { class: 'bk-head' }, h('b', null, title)),
                h('div', { class: 'bk-body imp-body' },
                    h('p', { class: 'imp-lead' }, '会以这种方式运行的脚本：'),
                    h('ul', { class: 'rd-list', 'data-fk': 'trust-list' }, ...names),
                    h('p', { class: 'imp-question trust-warn' },
                        '打开后，这些脚本不再关在沙箱里：能读到页面上的一切（包括你的 API key、所有卡和聊天），能改整个页面，也能联网把它们发出去。'
                        + '酒馆里脚本本来就是这样运行的。只对信得过的卡打开。'),
                    h('p', { class: 'dim' }, '只记在这台设备上（不进备份、不随卡导出）。脚本的代码变了会自动关掉。')),
                h('div', { class: 'bk-foot' }, cancel, ok)));
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        cancel.focus();
    });
}
