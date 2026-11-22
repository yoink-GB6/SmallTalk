// 检查器「人设」页：首行工具条（新建 / 导入 / 批量）+ 人设列表（每个人设一个可折叠的框）+ 下方的便签（tab-notes.js）。
// 纯逻辑（列表的增删改切、和 persona 的对齐规则、备注的规范化）在 src/personas.js；这里只管界面和「改完存起来、刷新」。
//
// 和别的模块的约定没变：state.persona 永远是当前人设的 {name, description, remark?}，别的模块（宏、拼装、发送时取名字）照旧只读名字和描述。
// 多人设的列表放在 state.personas / state.activePersonaId——只有用户新建了第二个人设才会出现，
// 平时 state 上没有这两个键（原因见 types.js GlobalRecord）。
//
// 界面精简（2026-11-22 用户定）后的样子：
//   - 没有小标题和说明文字；首行「新建」「导入」「批量」。「批量」进入多选模式，工具条换成「导出」「删除」「取消」。
//   - 每个人设一个 <details> 框：框头显示备注（没有备注就显示名字；有备注时名字作为小字跟在后面）、「当前」标记或「用它」按钮；
//     展开后只有名字、备注、描述三个输入框。默认只展开当前在用的那个；之后用户展开 / 收起了哪几个记在 view.open（运行期的，不存盘）。
//
// 控件分两类：
//   常驻的（index.html 里写死，不随页签重画）：当前人设的名字 #persona-name、备注 #persona-remark、描述 #persona-desc（包在 #persona-fields 里）。
//     事件在 bindPersonaTab（app.js 启动时调一次）；shell.js 的 renderTopbar 不管哪一页打开都会同步 #persona-name 的值，所以它们必须一直在文档里。
//     平时待在隐藏的 #persona-fields-home，每次重画时被挪进当前人设那个框的展开区里（挪的是同一个元素，事件和正在输入的状态都还在）。
//   每次打开重画的：工具条 #persona-bar、列表 #persona-list（非当前人设的三个输入框是现建的）、便签 #notes-box。
// UI 模块之间有循环依赖：这里从 shell.js 导入的 renderAll 只在函数体里用，顶层语句不调用兄弟模块的函数。

import { $, h, toast, uid, download } from './dom.js';
import { state, ui, save, persist, setPersonaFields, STOPPED_TEXT } from './state.js';
import { refreshPreview } from './pipeline.js';
import { renderAll } from './shell.js';
import { renderNotesTab } from './tab-notes.js';
import { mountNoteBox, noteBoxHasFocus } from './author-note.js';   // 只在函数体里调用
import { listPersonas, addPersona, switchPersona, updateCurrent, updatePersona, deletePersonas, exportPersonasFile, parsePersonasFile, mergePersonas,
    personasFileName, MAX_REMARK } from '../personas.js';
import { pickJson } from './importer.js';   // 循环依赖：只在函数体里调用

/** 界面状态（运行期的）：open = 展开着的人设 id（null = 还没画过，第一次画时只展开当前那个）；batch = 是否在多选模式；picked = 勾选的 id */
const view = { open: null, batch: false, picked: new Set() };

/** 现在能不能切换 / 新建 / 删除人设；能返回 null，不能返回原因（和 state.js 的 presetBlocked 同一个风格） */
export function personaBlocked() {
    if (ui.busy) return '正在生成回复，等它结束（或点「停止」）再切换人设';
    if (ui.switching) return '正在切换存档，稍等一下';
    if (persist.readOnly) return '存储处于只读状态（见页面顶上的说明），不能切换、新建或删除人设';
    if (persist.stopped) return STOPPED_TEXT;
    return null;
}

/** 换了人设之后的善后：存起来、重画聊天区和预览。ui.rendered.clear 和以前改名字时一样——楼层按当前名字重新渲染 */
function commit(r) {
    setPersonaFields(r);
    ui.rendered.clear();
    save();
    renderAll();
}

function tryOp(fn) {
    const why = personaBlocked();
    if (why) { toast(why, 'error'); return; }
    fn();
}

/** 新人设的默认名字：「新人设」，重名就加序号 */
function freshName() {
    const names = new Set(listPersonas(state).map(p => p.name));
    if (!names.has('新人设')) return '新人设';
    let n = 2;
    while (names.has(`新人设 ${n}`)) n++;
    return `新人设 ${n}`;
}

/**
 * 导入酒馆「人设管理 → 备份」的文件（来自「人设」页的按钮，或拖进页面 / 「存档」页的导入…，由 importer.js 转进来）。
 * 合并而不是替换，不切换当前人设；导入名字、描述和备注（酒馆的 title）。形状不对、或现在不允许改人设时什么都不改。
 */
export function importPersonasJson(json) {
    const why = personaBlocked();
    if (why) { toast(why, 'error'); return; }
    const items = parsePersonasFile(json);
    if (!items) { toast('这不是酒馆的人设备份文件（要有 personas 和 persona_descriptions 两部分）', 'error'); return; }
    const { rec, added, skipped } = mergePersonas(state, items, uid);
    if (added) commit(rec);
    toast(`人设导入完成：新增 ${added} 个${skipped ? `，跳过 ${skipped} 个（本机已有名字、描述和备注都相同的）` : ''}。只导入了名字、描述和备注，头像、位置、绑定的世界书等没有导入`, added ? 'ok' : '');
}

// ───────────────────────────── 批量：导出 / 删除 ─────────────────────────────

function leaveBatch() {
    view.batch = false;
    view.picked.clear();
}

/** 导出勾选的那几个，放进同一个酒馆人设备份文件（酒馆的格式本来就是一个文件装多个人设，恢复时一次全读进去）。不改数据，只读标签页里也能用 */
function exportPicked() {
    const ids = [...view.picked];
    if (!ids.length) { toast('先勾选要导出的人设', 'error'); return; }
    const file = exportPersonasFile(state, ids);
    const n = Object.keys(file.personas).length;
    download(personasFileName(), JSON.stringify(file, null, 2));
    toast(`已导出 ${n} 个人设，格式和酒馆「人设管理 → 备份」一样（备注写在 title 里；没有头像，酒馆恢复时会补默认头像）`, 'ok');
    leaveBatch();
    renderPersonaTab();
}

/** 删除勾选的那几个：先确认一次；不能删到一个不剩（personas.js deletePersonas） */
function deletePicked() {
    tryOp(() => {
        const list = listPersonas(state);
        const hit = list.filter(p => view.picked.has(p.id));
        if (!hit.length) { toast('先勾选要删除的人设', 'error'); return; }
        const r = deletePersonas(state, hit.map(p => p.id));
        if (!r) { toast('至少要保留一个人设：不能把人设全删掉', 'error'); return; }
        const names = hit.map(p => `「${p.remark ? `${p.remark}（${p.name}）` : p.name}」`).join('');
        if (!confirm(`删除 ${hit.length} 个人设：${names}？删掉之后找不回来（已经发出的楼层不受影响）。`)) return;
        for (const p of hit) view.open?.delete(p.id);
        leaveBatch();
        commit(r);
    });
}

// ───────────────────────────── 画 ─────────────────────────────

/** 首行工具条：平时是「新建」「导入」「批量」；多选模式下是「导出」「删除」「取消」和已选几个 */
function renderBar(locked) {
    const bar = $('#persona-bar');
    if (!view.batch) {
        bar.replaceChildren(
            h('button', { type: 'button', id: 'persona-new', disabled: locked, onclick: () => tryOp(() => {
                const id = uid();
                view.open = new Set([id]);   // 新建的那个就是当前的：只展开它
                commit(addPersona(state, { id, name: freshName() }));
            }) }, '新建'),
            h('button', { type: 'button', id: 'persona-import', disabled: locked, title: '导入酒馆的人设备份：合并进来，名字、描述和备注都相同的跳过',
                onclick: () => tryOp(() => pickJson(json => importPersonasJson(json))) }, '导入'),
            h('button', { type: 'button', id: 'persona-batch', title: '勾选几个人设，一起导出或删除', onclick: () => { view.batch = true; view.picked.clear(); renderPersonaTab(); } }, '批量'),
        );
        return;
    }
    const n = view.picked.size;
    const list = listPersonas(state);
    const all = list.length > 0 && list.every(p => view.picked.has(p.id));
    bar.replaceChildren(
        h('button', { type: 'button', id: 'persona-pick-all', disabled: !list.length, title: '全部勾上；已经全勾时再点就全不选',
            onclick: () => { view.picked.clear(); if (!all) for (const p of list) view.picked.add(p.id); renderPersonaTab(); } }, all ? '全不选' : '全选'),
        h('button', { type: 'button', id: 'persona-export', disabled: !n, title: '把勾选的人设导出成一个酒馆「人设管理 → 备份」文件', onclick: exportPicked }, '导出'),
        h('button', { type: 'button', id: 'persona-del', disabled: locked || !n, onclick: deletePicked }, '删除'),
        h('button', { type: 'button', id: 'persona-batch-cancel', onclick: () => { leaveBatch(); renderPersonaTab(); } }, '取消'),
        h('span', { class: 'dim', 'data-fk': 'persona-picked' }, `已选 ${n} 个`),
    );
}

/** 非当前人设的三个输入框（现建的）：直接改列表里那一项，不切换当前人设 */
function otherFields(p, locked) {
    const edit = (patch, rerender) => {
        if (persist.readOnly || persist.stopped) return;   // 控件已禁用；这里只防万一（save 在只读时本来也什么都不写）
        setPersonaFields(updatePersona(state, p.id, patch));
        save();
        if (rerender) renderPersonaTab();   // 名字、备注改完要更新框头；描述每个字都存，不重画（不然光标会丢）
    };
    const name = h('input', { 'data-fk': 'persona-edit-name', size: 14, autocomplete: 'off', disabled: locked, onchange: e => edit({ name: e.target.value }, true) });
    name.value = p.name;
    const remark = h('input', { 'data-fk': 'persona-edit-remark', size: 14, autocomplete: 'off', maxLength: MAX_REMARK, placeholder: '可不填，用来区分重名的人设', disabled: locked,
        onchange: e => edit({ remark: e.target.value }, true) });
    remark.value = p.remark ?? '';
    const desc = h('textarea', { 'data-fk': 'persona-edit-desc', rows: 6, placeholder: '人设描述', disabled: locked, oninput: e => edit({ description: e.target.value }, false) });
    desc.value = p.description;
    return h('div', { class: 'persona-fields' },
        h('label', { class: 'inline' }, '名字 ', name),
        h('label', { class: 'inline' }, '备注 ', remark),
        desc);
}

/** 一个人设的框 */
function personaBox(p, locked) {
    const head = h('summary', { class: `persona-head${view.batch ? ' batch-row' : ''}${view.batch && view.picked.has(p.id) ? ' batch-picked' : ''}`, title: p.description ? p.description.slice(0, 120) : '（没有描述）' },
        view.batch ? h('input', { type: 'checkbox', 'data-fk': 'persona-pick', checked: view.picked.has(p.id), 'aria-label': '选中这个人设',
            onchange: e => { e.target.checked ? view.picked.add(p.id) : view.picked.delete(p.id); renderBar(locked); } }) : null,
        h('span', { class: 'persona-label', 'data-fk': 'persona-label' }, p.remark || p.name),
        p.remark ? h('span', { class: 'dim persona-sub', 'data-fk': 'persona-sub' }, p.name) : null,
        p.active
            ? h('span', { class: 'persona-cur', 'data-fk': 'persona-cur' }, '当前')
            : h('button', { type: 'button', class: 'ghost persona-use', 'data-fk': 'persona-use', disabled: locked, title: '切换到这个人设',
                onclick: e => {
                    e.preventDefault();   // 在 <summary> 里：不要顺带展开 / 收起这个框
                    tryOp(() => { view.open = new Set([p.id]); commit(switchPersona(state, p.id)); });
                } }, '用它'),
    );
    // 批量模式下点框头（空白处或名字）= 切换勾选，不展开 / 收起；「用它」按钮和复选框自己照常工作
    head.addEventListener('click', e => {
        if (!view.batch) return;
        const t = e.target.closest('button, a, input, select, textarea, label');
        if (t && t !== head) return;
        e.preventDefault(); e.stopPropagation();   // <summary> 的默认动作是展开 / 收起
        const on = !view.picked.has(p.id);
        if (on) view.picked.add(p.id); else view.picked.delete(p.id);
        const cb = head.querySelector('input[type=checkbox]');
        if (cb) cb.checked = on;
        head.classList.toggle('batch-picked', on);
        renderBar(locked);
    }, true);
    const box = h('details', { class: p.active ? 'persona-item active' : 'persona-item', 'data-fk': 'persona-item', 'data-id': p.id,
        open: view.open.has(p.id) }, head);
    box.addEventListener('toggle', () => { box.open ? view.open.add(p.id) : view.open.delete(p.id); });
    // 当前那个：把常驻的输入框挪进来；别的：现建一组
    box.append(h('div', { class: 'persona-body' }, p.active ? $('#persona-fields') : otherFields(p, locked)));
    return box;
}

export function renderPersonaTab() {
    const list = listPersonas(state);
    const locked = persist.readOnly || persist.stopped;   // 只读标签页：会改数据的控件整体禁用（导出照常）
    const ids = new Set(list.map(p => p.id));
    if (!view.open) view.open = new Set(list.filter(p => p.active).map(p => p.id));   // 第一次画：只展开当前在用的那个
    for (const id of view.picked) if (!ids.has(id)) view.picked.delete(id);            // 别处删掉 / 恢复备份换掉了的，不留在勾选里
    renderBar(locked);
    $('#persona-list').replaceChildren(...list.map(p => personaBox(p, locked)));
    // 正在输入时不覆盖：后台触发的重画会把用户打到一半的字冲掉
    const name = $('#persona-name'), desc = $('#persona-desc'), remark = $('#persona-remark');
    if (document.activeElement !== name) name.value = state.persona.name;
    if (document.activeElement !== desc) desc.value = state.persona.description;
    if (document.activeElement !== remark) remark.value = state.persona.remark ?? '';
    name.disabled = desc.disabled = remark.disabled = locked;
    renderNotesTab();
    // 作者注释（当前存档的）：常驻小框挂在本页最下面。正在框里打字时不刷新（会打断输入法组字）；
    // 这期间要是存档换了，框自己在下一次输入时发现并改填成新存档的值（author-note.js commit）
    if (!noteBoxHasFocus()) mountNoteBox($('#an-slot'));
}

/** 绑定常驻控件的事件（app.js 的 bind() 里调一次） */
export function bindPersonaTab() {
    // 名字：改完（失焦 / 回车）才生效；空名字回到 User（和以前一样）
    $('#persona-name').addEventListener('change', e => commit(updateCurrent(state, { name: e.target.value })));
    // 备注：同样改完才生效（personas.js cleanRemark 去首尾空白、压成一行；空 = 去掉备注）。不影响发给模型的内容，但框头要跟着变，所以也走 commit
    $('#persona-remark').addEventListener('change', e => commit(updateCurrent(state, { remark: e.target.value })));
    // 描述：每个字都立刻写进 state（保存本身有防抖）：打完字马上切换存档的话，最后几个字才赶得上切换前的那次落盘
    $('#persona-desc').addEventListener('input', e => {
        setPersonaFields(updateCurrent(state, { description: e.target.value }));
        save(); refreshPreview();
    });
}
