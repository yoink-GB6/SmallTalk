// 删除角色卡 / 预设时「它们自带的启用正则怎么处理」：页内弹框 + 把正则移进全局。
// 谁调用：archive.js 的 deleteCard、tab-preset.js 的删除按钮。移动规则本身（纯函数）在 src/regex-move.js。
//
// 落盘顺序（两个调用方都一样，原因见 moveToGlobal 的注释）：先把正则加进全局并确认已落盘，再删卡 / 预设；
// 删除失败就把刚加的撤回。这样最坏的情况只是「全局和卡里各有一份」（多一份，不会少）。
//
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { h, toast, uid } from './dom.js';
import { state, ui, flushNow } from './state.js';
import { renderAll } from './shell.js';
import { planRegexMove } from '../regex-move.js';

/** 弹框里最多列几条名字，多的写「等 N 条」 */
const MAX_LISTED = 6;

/**
 * 问：这张卡 / 这个预设自带的启用正则怎么办。
 * @param {{kind: 'card'|'preset', title: string, scripts: Object[]}} o  title 是弹框标题（已经写好要删什么）
 * @returns {Promise<'move'|'discard'|null>} null = 取消（Esc / 点遮罩 / 取消按钮）
 */
export function askRegexFate({ kind, title, scripts }) {
    const owner = kind === 'card' ? '这张角色卡' : '这个预设';
    return new Promise(resolve => {
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        const close = r => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(r); };
        const names = scripts.slice(0, MAX_LISTED).map(s => h('li', null, s.scriptName || '(未命名)'));
        if (scripts.length > MAX_LISTED) names.push(h('li', { class: 'dim' }, `等 ${scripts.length} 条`));
        const cancel = h('button', { type: 'button', 'data-fk': 'rd-cancel', onclick: () => close(null) }, '取消');
        const discard = h('button', { type: 'button', 'data-fk': 'rd-discard', onclick: () => close('discard') }, '丢弃');
        const move = h('button', { type: 'button', class: 'primary', 'data-fk': 'rd-move', onclick: () => close('move') }, '移动至全局');
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': 'rd-dialog', onmousedown: e => { if (e.target === overlay) close(null); } },
            h('div', { class: 'bk-panel imp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
                h('div', { class: 'bk-head' }, h('b', null, title)),
                h('div', { class: 'bk-body imp-body' },
                    h('p', { class: 'imp-lead' }, `${owner}自带 ${scripts.length} 条启用中的正则：`),
                    h('ul', { class: 'rd-list', 'data-fk': 'rd-list' }, ...names),
                    h('p', { class: 'imp-question' }, `这些正则是随${owner}来的，删掉${kind === 'card' ? '卡' : '预设'}它们也会一起没有。`
                        + '移到全局后，它们会对所有聊天生效。')),
                h('div', { class: 'bk-foot' }, cancel, discard, move)));
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        cancel.focus();   // 初始焦点在「取消」：手滑按回车什么都不会发生
    });
}

/**
 * 把这几条移进 state.globalRegex（只改内存，返回 {added, reopened, dup, undo}；调用方负责 flushNow）。
 * undo()：把这次的改动原样撤回（删掉新加的、把被打开的重新关上），只动这次动过的那几个对象。
 *
 * 为什么先加后删、失败撤回：全局正则和卡 / 预设是两条独立的存储记录，没法在一次事务里同时改。
 * 先加再删，中途任何一步失败 / 页面被关，最多是两边各有一份；反过来就可能「卡删了、正则没进全局」。
 */
export function moveToGlobal(scripts) {
    const plan = planRegexMove(state.globalRegex, scripts, uid);
    const reopened = plan.reopen.map(s => { s.disabled = false; return s; });
    state.globalRegex.push(...plan.add);
    return {
        added: plan.add.length, reopened: reopened.length, dup: plan.dup,
        undo() {
            for (const s of plan.add) { const i = state.globalRegex.indexOf(s); if (i >= 0) state.globalRegex.splice(i, 1); }
            for (const s of reopened) s.disabled = true;
        },
    };
}

/** 移动后存盘；存不下去就撤回内存里的改动，返回 false（调用方放弃删除） */
export async function moveAndFlush(scripts) {
    const moved = moveToGlobal(scripts);
    if (await flushNow()) return moved;
    moved.undo();
    toast('正则没能保存到全局，已取消删除', 'error');
    return false;
}

/** 删除失败后撤回：移进全局的正则退回去，并尽力存一次（存不上的话下次保存会重写，内存里已经是撤回后的样子） */
export async function undoMove(moved) {
    moved.undo();
    await flushNow().catch(() => false);
    refreshRegexViews();
}

/** 正则变了：已渲染的楼层缓存清掉，「正则」页、聊天区、「拼装」页预览跟着重画（和「正则」页的 applyNow 一样） */
export function refreshRegexViews() {
    ui.rendered.clear();
    renderAll();
}

/** 结果提示里关于正则的那半句；没移就返回空串 */
export function moveSummary(moved) {
    if (!moved) return '';
    const bits = [`${moved.added} 条启用的正则已移到全局`];
    if (moved.dup) bits.push(`${moved.dup} 条因为全局里已有相同的没重复加${moved.reopened ? `，其中 ${moved.reopened} 条原来关着、已打开` : ''}`);
    return `；${bits.join('，')}`;
}
