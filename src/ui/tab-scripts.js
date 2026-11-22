// 检查器「脚本」页：当前角色卡自带的酒馆助手脚本（2026-11-23 第 1 期：只能看、开关、新增、删除、改代码、导入导出，【不运行】）。
// 数据层在 src/scripts.js（解析、规范化、导出时合并回卡的原始 JSON），契约见 types.js Card.scripts。
//
// 数据存在哪：卡记录的 state.card.scripts。【缺省 = 跟着 raw】：没有这个键时现场从卡的原始 JSON 解析（cardScripts），
// 第一次改动时（ownTree）才把整棵树写进 state.card.scripts，之后照常 save()。导出卡时 card-export.js 合并回 data.extensions.tavern_helper。
// 这一期脚本不运行、也不进拼装，所以改完只存盘、重画本页，不用让聊天区 / 预览 / 记忆失效。
//
// 界面（照「人设」「世界书」页精简后的样子）：首行「新增」「导入」「批量」；一行灰字说明现在不运行；
// 每个脚本一个可折叠的框（框头：启用开关、名字、按钮数、没保存的标记 •），文件夹是一个带开关的框，里面是它的脚本。
// 展开后：名字、说明、代码编辑器、「保存」「还原」「导出」「删除」。名字 / 说明 / 代码先改在草稿里（drafts，内存里，刷新就丢），点「保存」或 Ctrl+S 才写进卡。
// 批量：进入后点框头整块即选中，工具条换成「全选」「导出」「删除」「取消」。
//
// 代码编辑器是零依赖的 textarea：Tab 缩进两格、选中多行时整块缩进，Shift+Tab 反缩进，Esc 之后的下一次 Tab 让出焦点（键盘用户能离开），
// Ctrl / Cmd+S 保存。不做语法高亮。几百 KB 的代码只在展开时才放进 textarea。
//
// 重画：后台的 renderAll 会频繁调到这里。框里有打到一半的草稿、点「保存」前焦点刚离开文本框（app.js 的 focusout 会补一次重画）——
// 整页重建会把按钮换掉、点击落空。所以先比一份「画面签名」（树、开关状态、展开、批量勾选），没变就不重建（lastSig）。
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { $, h, toast, uid, download } from './dom.js';
import { state, ui, save, persist, STOPPED_TEXT } from './state.js';
import { restoreActive } from './backup.js';   // 循环依赖：只在函数体里调用
import { cardScripts, newScript, parseScriptFile, scriptFileObject } from '../scripts.js';
import { safeFileName } from '../card-export.js';

/** 每张卡（state.card 对象）一份的界面状态：展开的 id、草稿。换卡 / 重新读档换了对象，自然清掉 */
const perCard = new WeakMap();
function cardView() {
    let v = perCard.get(state.card);
    if (!v) { v = { open: new Set(), drafts: new Map() }; perCard.set(state.card, v); }
    return v;
}
/** 批量模式（不分卡；换卡时勾选里不存在的 id 自动去掉） */
const batch = { on: false, picked: new Set() };
let lastSig = null;

/** 现在能不能改脚本；能返回 null，不能返回原因 */
export function scriptsBlocked() {
    if (!state.card) return '还没有角色卡';
    if (persist.readOnly) return '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能改脚本';
    if (persist.stopped) return STOPPED_TEXT;
    if (persist.paused || restoreActive()) return '正在从备份恢复，稍等一下再改脚本';
    if (ui.switching) return '正在切换存档，稍等一下';
    if (ui.busy) return '正在生成回复，等它结束（或点「停止」）再改脚本';
    return null;
}

function guarded(fn) {
    return (...args) => {
        const why = scriptsBlocked();
        if (why) { toast(why, 'error'); renderScriptsTab(true); return; }
        fn(...args);
    };
}

/** 要改了：把现在的树写进 state.card.scripts（第一次改动时才写，之前一直跟着 raw） */
function ownTree() {
    if (!Array.isArray(state.card.scripts)) state.card.scripts = structuredClone(cardScripts(state.card));
    return state.card.scripts;
}

/** 在树里找一个条目：{item, list（它所在的数组）, folder（所在文件夹，顶层为 null）} */
function locate(tree, id) {
    for (const t of tree) {
        if (t.id === id) return { item: t, list: tree, folder: null };
        if (t.type === 'folder') for (const s of t.scripts) if (s.id === id) return { item: s, list: t.scripts, folder: t };
    }
    return null;
}

function commit() { save(); renderScriptsTab(true); }

const displayName = s => s.name || '(未命名)';
const isDirty = (s, d) => !!d && (d.name !== s.name || d.info !== s.info || d.content !== s.content);

// ───────────────────────────── 操作 ─────────────────────────────

const toggleEnabled = guarded((id, on) => {
    const hit = locate(ownTree(), id);
    if (hit) hit.item.enabled = on;
    commit();
});

const addScript = guarded(() => {
    const s = newScript(uid());
    ownTree().push(s);
    cardView().open.add(s.id);
    commit();
});

/** 保存草稿（名字、说明、代码）。不重画整页：焦点可能还在代码框里（Ctrl+S），只更新框头 */
function saveDraft(id) {
    const why = scriptsBlocked();
    if (why) { toast(why, 'error'); return null; }
    const v = cardView();
    const d = v.drafts.get(id);
    const hit = locate(ownTree(), id);
    if (!d || !hit) return null;
    hit.item.name = d.name; hit.item.info = d.info; hit.item.content = d.content;
    v.drafts.delete(id);
    save();
    return hit.item;   // 写进卡里的那个对象（第一次改动时树刚被拷进 state.card.scripts，和画面上的不是同一个）
}

function deleteOne(id) {
    const why = scriptsBlocked();
    if (why) { toast(why, 'error'); return; }
    const hit = locate(cardScripts(state.card), id);
    if (!hit) return;
    if (!confirm(`删除脚本「${displayName(hit.item)}」？删掉就找不回来了（可以先点「导出」留一份）。`)) return;
    removeIds([id]);
    commit();
}

/** 从树里删掉这些 id（文件夹连同里面的脚本） */
function removeIds(ids) {
    const set = new Set(ids);
    const tree = ownTree();
    const v = cardView();
    for (let i = tree.length - 1; i >= 0; i--) {
        const t = tree[i];
        if (set.has(t.id)) { tree.splice(i, 1); v.drafts.delete(t.id); if (t.type === 'folder') for (const s of t.scripts) v.drafts.delete(s.id); continue; }
        if (t.type === 'folder') for (let j = t.scripts.length - 1; j >= 0; j--) if (set.has(t.scripts[j].id)) { v.drafts.delete(t.scripts[j].id); t.scripts.splice(j, 1); }
    }
}

const fileNameOf = item => safeFileName(`酒馆助手脚本-${item.name || '未命名'}`, 'json');
/** 导出成酒馆助手的脚本 / 文件夹文件（导出的是已保存的版本，不含草稿）。不改数据，只读时也能用 */
const exportItem = item => download(fileNameOf(item), JSON.stringify(scriptFileObject(item), null, 2));

/** 导入酒馆助手导出的脚本 / 文件夹 JSON（可多选）：加在最外层末尾，导入的先关着（酒馆助手也这样）、id 换新 */
const importFiles = guarded(() => {
    const input = h('input', { type: 'file', accept: '.json,application/json', multiple: true });
    input.addEventListener('change', async () => {
        const files = [...input.files];
        if (!files.length) return;
        const why = scriptsBlocked();   // 选文件这段时间里可能开始了生成 / 恢复
        if (why) { toast(why, 'error'); return; }
        const cardAtStart = state.card;
        const got = [], bad = [];
        for (const f of files) {
            try {
                const items = parseScriptFile(JSON.parse(await f.text()), uid);
                if (items) got.push(...items); else bad.push(`「${f.name}」不是酒馆助手的脚本文件`);
            } catch (e) { bad.push(`「${f.name}」读不出来：${e.message}`); }
        }
        if (state.card !== cardAtStart || scriptsBlocked()) { toast('读文件期间换了卡或开始了别的操作，没有导入', 'error'); return; }
        if (got.length) {
            ownTree().push(...got);
            commit();
        }
        const n = got.reduce((k, t) => k + (t.type === 'folder' ? t.scripts.length : 1), 0);
        if (got.length) toast(`已导入 ${n} 个脚本${got.some(t => t.type === 'folder') ? '（含文件夹）' : ''}，导入的先关着`, 'ok');
        for (const b of bad) toast(b, 'error');
    });
    input.click();
});

// ───────────────────────────── 批量 ─────────────────────────────

function leaveBatch() { batch.on = false; batch.picked.clear(); }

function batchExport() {
    const tree = cardScripts(state.card);
    const items = [];
    for (const t of tree) {
        if (batch.picked.has(t.id)) { items.push(t); continue; }   // 选了文件夹：整个文件夹一个文件
        if (t.type === 'folder') for (const s of t.scripts) if (batch.picked.has(s.id)) items.push(s);
    }
    if (!items.length) { toast('先勾选要导出的脚本', 'error'); return; }
    for (const it of items) exportItem(it);
    leaveBatch();
    renderScriptsTab(true);
}

const batchDelete = guarded(() => {
    const tree = cardScripts(state.card);
    const names = [];
    for (const t of tree) {
        if (batch.picked.has(t.id)) names.push(t.type === 'folder' ? `文件夹「${displayName(t)}」（${t.scripts.length} 个脚本）` : `「${displayName(t)}」`);
        else if (t.type === 'folder') for (const s of t.scripts) if (batch.picked.has(s.id)) names.push(`「${displayName(s)}」`);
    }
    if (!names.length) { toast('先勾选要删除的脚本', 'error'); return; }
    if (!confirm(`删除 ${names.join('、')}？删掉就找不回来了（可以先导出留一份）。`)) return;
    removeIds([...batch.picked]);
    leaveBatch();
    commit();
});

// ───────────────────────────── 代码编辑器 ─────────────────────────────

/** 在光标处插入文字：优先 execCommand（能撤销），不行再 setRangeText（不进撤销栈，手动发 input） */
function insertText(ta, text) {
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

/** Tab / Shift+Tab：没选中时插两个空格；选中了（或反缩进）时把涉及的整行一起缩进 / 反缩进两格 */
function indent(ta, outdent) {
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    if (!outdent && a === b) { insertText(ta, '  '); return; }
    const start = v.lastIndexOf('\n', a - 1) + 1;
    const stop = b > a && v[b - 1] === '\n' ? b - 1 : b;   // 选区停在下一行行首：那一行不算
    const nl = v.indexOf('\n', stop);
    const end = nl < 0 ? v.length : nl;
    const lines = v.slice(start, end).split('\n');
    const out = lines.map(l => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l));
    const block = out.join('\n');
    if (block === lines.join('\n')) return;
    ta.setSelectionRange(start, end);
    insertText(ta, block);
    const d0 = out[0].length - lines[0].length;
    const na = Math.max(start, a + d0);
    const nb = a === b ? na : b + (block.length - (end - start));
    ta.setSelectionRange(na, Math.max(na, nb));
}

/** 代码框：等宽、不换行、行数够用（最多 30 行，再多滚动）。tabOut：按过 Esc，下一次 Tab 让浏览器挪焦点 */
function codeEditor(value, locked, onInput, onSave) {
    const lines = Math.min(30, Math.max(6, (value.match(/\n/g)?.length ?? 0) + 2));
    const ta = h('textarea', { class: 'scr-code', 'data-fk': 'scr-code', rows: lines, readOnly: locked,
        autocomplete: 'off', 'aria-label': '脚本代码', oninput: onInput });
    ta.setAttribute('wrap', 'off');
    ta.spellcheck = false;   // h() 会跳过值为 false 的属性，这里直接设
    ta.value = value;
    let tabOut = false;
    ta.addEventListener('blur', () => { tabOut = false; });
    ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); onSave(); return; }
        if (e.key === 'Escape') { tabOut = true; return; }
        if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) { if (e.key !== 'Shift') tabOut = false; return; }
        if (tabOut || ta.readOnly) { tabOut = false; return; }   // 让出 Tab：焦点照常移走
        e.preventDefault();
        indent(ta, e.shiftKey);
    });
    return ta;
}

// ───────────────────────────── 画 ─────────────────────────────

/** 框头上和批量有关的处理：批量模式下点框头（空白、名字）= 勾选 / 取消，不展开；开关、复选框照常 */
function batchHead(head, id) {
    head.addEventListener('click', e => {
        if (!batch.on) return;
        const t = e.target.closest('button, a, input, select, textarea, label');
        if (t && t !== head) return;
        e.preventDefault(); e.stopPropagation();
        const on = !batch.picked.has(id);
        if (on) batch.picked.add(id); else batch.picked.delete(id);
        const cb = head.querySelector('[data-fk="scr-pick"]');
        if (cb) cb.checked = on;
        head.classList.toggle('batch-picked', on);
        renderBar(!!scriptsBlocked());
        lastSig = viewSig();
    }, true);
}

function pickBox(id) {
    return batch.on ? h('input', { type: 'checkbox', 'data-fk': 'scr-pick', checked: batch.picked.has(id), 'aria-label': '选中',
        onchange: e => { e.target.checked ? batch.picked.add(id) : batch.picked.delete(id); e.target.closest('summary')?.classList.toggle('batch-picked', e.target.checked); renderBar(!!scriptsBlocked()); lastSig = viewSig(); } }) : null;
}

function enableBox(item, locked) {
    return h('input', { type: 'checkbox', 'data-fk': 'scr-enable', checked: item.enabled, disabled: locked,
        title: item.enabled ? '已启用' : '已关闭', 'aria-label': '启用',
        onchange: e => toggleEnabled(item.id, e.target.checked) });
}

/** 一个脚本的框 */
function scriptBox(s, locked) {
    const v = cardView();
    const nameEl = h('span', { class: 'scr-name', 'data-fk': 'scr-name' }, displayName(s));
    const dot = h('span', { class: 'scr-dirty', 'data-fk': 'scr-dirty', title: '有没保存的改动', hidden: !isDirty(s, v.drafts.get(s.id)) }, '•');
    const nBtn = s.button?.buttons?.length ?? 0;
    const head = h('summary', { class: `scr-head${batch.on ? ' batch-row' : ''}${batch.on && batch.picked.has(s.id) ? ' batch-picked' : ''}`, title: s.info ? s.info.slice(0, 200) : null },
        pickBox(s.id), enableBox(s, locked), nameEl,
        nBtn ? h('span', { class: 'badge', 'data-fk': 'scr-btn-count', title: '这个脚本带的按钮（以后运行脚本时显示在输入框上方）' }, `按钮 ${nBtn}`) : null,
        dot);
    batchHead(head, s.id);
    const box = h('details', { class: `pitem scr-item${s.enabled ? '' : ' off'}`, 'data-fk': 'scr-item', 'data-id': s.id, open: v.open.has(s.id) }, head);
    const build = () => { if (!box.querySelector(':scope > .scr-body')) box.append(scriptBody(s, locked, nameEl, dot)); };
    box.addEventListener('toggle', () => {
        if (box.open) { v.open.add(s.id); build(); } else v.open.delete(s.id);
        lastSig = viewSig();
    });
    if (box.open) build();
    return box;
}

/** 展开后的编辑区：名字、说明、代码 + 保存 / 还原 / 导出 / 删除 */
function scriptBody(s, locked, nameEl, dot) {
    const v = cardView();
    let base = s;   // 已保存的版本；保存后换成写进卡里的那个对象
    const draft = () => v.drafts.get(s.id) ?? { name: base.name, info: base.info, content: base.content };
    const cur = draft();
    const saveBtn = h('button', { type: 'button', class: 'primary', 'data-fk': 'scr-save', title: 'Ctrl+S', onclick: () => doSave() }, '保存');
    const revertBtn = h('button', { type: 'button', 'data-fk': 'scr-revert', title: '丢掉没保存的改动', onclick: () => { v.drafts.delete(s.id); renderScriptsTab(true); } }, '还原');
    const paint = () => {
        const d = v.drafts.get(s.id);
        const dirty = isDirty(base, d);
        dot.hidden = !dirty;
        saveBtn.disabled = locked || !dirty;
        revertBtn.disabled = !dirty;
        nameEl.textContent = displayName(base);
    };
    const edit = (field, value) => { const d = draft(); d[field] = value; v.drafts.set(s.id, d); paint(); };
    const doSave = () => { const it = saveDraft(s.id); if (it) { base = it; paint(); lastSig = viewSig(); } };
    const onKey = e => { if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(); } };

    const name = h('input', { type: 'text', 'data-fk': 'scr-name-input', autocomplete: 'off', readOnly: locked, onkeydown: onKey,
        oninput: e => edit('name', e.target.value) });
    name.value = cur.name;
    name.spellcheck = false;
    const info = h('textarea', { class: 'scr-info', 'data-fk': 'scr-info', rows: 2, readOnly: locked, placeholder: '说明', onkeydown: onKey,
        oninput: e => edit('info', e.target.value) });
    info.value = cur.info;
    const code = codeEditor(cur.content, locked, e => edit('content', e.target.value), doSave);
    const body = h('div', { class: 'scr-body' },
        h('label', { class: 'inline scr-row' }, '名字', name),
        info,
        code,
        h('div', { class: 'scr-actions' },
            saveBtn, revertBtn,
            h('button', { type: 'button', 'data-fk': 'scr-export', title: '导出成酒馆助手的脚本文件（已保存的版本）', onclick: () => exportItem(locate(cardScripts(state.card), s.id)?.item ?? s) }, '导出'),
            h('button', { type: 'button', class: 'danger', 'data-fk': 'scr-del', disabled: locked, onclick: () => deleteOne(s.id) }, '删除')),
    );
    paint();
    return body;
}

/** 一个文件夹的框：头部开关 + 名字 + 脚本数；展开后是它的脚本 */
function folderBox(f, locked) {
    const v = cardView();
    const head = h('summary', { class: `scr-head${batch.on ? ' batch-row' : ''}${batch.on && batch.picked.has(f.id) ? ' batch-picked' : ''}` },
        pickBox(f.id), enableBox(f, locked),
        h('span', { class: 'scr-name', 'data-fk': 'scr-name' }, displayName(f)),
        h('span', { class: 'badge', 'data-fk': 'scr-folder-count', title: '文件夹里的脚本数；文件夹关着时里面的脚本都不会运行' }, `${f.scripts.length} 个`));
    batchHead(head, f.id);
    const box = h('details', { class: `pitem scr-folder${f.enabled ? '' : ' off'}`, 'data-fk': 'scr-folder', 'data-id': f.id, open: v.open.has(f.id) }, head,
        h('div', { class: 'plist scr-children' }, f.scripts.length ? f.scripts.map(s => scriptBox(s, locked)) : h('div', { class: 'dim scr-empty-folder' }, '空文件夹')));
    box.addEventListener('toggle', e => {
        if (e.target !== box) return;   // 里面的脚本框的 toggle 冒泡上来，不算
        box.open ? v.open.add(f.id) : v.open.delete(f.id);
        lastSig = viewSig();
    });
    return box;
}

/** 首行工具条 */
function renderBar(locked) {
    const bar = $('#tab-scripts [data-fk="scr-bar"]');
    if (!bar) return;
    const why = scriptsBlocked();
    if (!batch.on) {
        bar.replaceChildren(
            h('button', { type: 'button', 'data-fk': 'scr-add', disabled: locked, title: locked ? why : '新建一个脚本', onclick: addScript }, '新增'),
            h('button', { type: 'button', 'data-fk': 'scr-import', disabled: locked, title: locked ? why : '导入酒馆助手导出的脚本 / 文件夹 JSON（可多选）', onclick: importFiles }, '导入'),
            h('button', { type: 'button', 'data-fk': 'scr-batch', title: '勾选几个脚本，一起导出或删除',
                onclick: () => { batch.on = true; batch.picked.clear(); renderScriptsTab(true); } }, '批量'));
        return;
    }
    const tree = cardScripts(state.card);
    const ids = [];
    for (const t of tree) { ids.push(t.id); if (t.type === 'folder') for (const s of t.scripts) ids.push(s.id); }
    const all = ids.length > 0 && ids.every(id => batch.picked.has(id));
    const n = batch.picked.size;
    bar.replaceChildren(
        h('button', { type: 'button', 'data-fk': 'scr-pick-all', disabled: !ids.length, title: '全部勾上；已经全勾时再点就全不选',
            onclick: () => { batch.picked.clear(); if (!all) for (const id of ids) batch.picked.add(id); renderScriptsTab(true); } }, all ? '全不选' : '全选'),
        h('button', { type: 'button', 'data-fk': 'scr-batch-export', disabled: !n, title: '每个脚本 / 文件夹导出成一个酒馆助手的脚本文件', onclick: batchExport }, '导出'),
        h('button', { type: 'button', class: 'danger', 'data-fk': 'scr-batch-delete', disabled: locked || !n, title: locked ? why : null, onclick: batchDelete }, '删除'),
        h('button', { type: 'button', 'data-fk': 'scr-batch-cancel', onclick: () => { leaveBatch(); renderScriptsTab(true); } }, '取消'),
        h('span', { class: 'dim', 'data-fk': 'scr-picked' }, `已选 ${n} 个`));
}

/** 画面签名：这些都没变就不重建（见文件头「重画」） */
let cardSeq = 0;
const cardIds = new WeakMap();
function viewSig() {
    if (!state.card) return 'none';
    if (!cardIds.has(state.card)) cardIds.set(state.card, ++cardSeq);
    const v = cardView();
    return JSON.stringify([cardIds.get(state.card), scriptsBlocked() ?? '', batch.on, [...batch.picked], [...v.open], cardScripts(state.card)]);
}

/** @param {boolean} [force]  true = 不管签名，一定重建（本页自己的操作之后） */
export function renderScriptsTab(force = false) {
    const tab = $('#tab-scripts');
    if (!tab) return;
    if (!state.card) {
        leaveBatch();
        lastSig = 'none';
        tab.replaceChildren(h('div', { class: 'empty', 'data-fk': 'scr-empty' }, '还没有角色卡。'));
        return;
    }
    const tree = cardScripts(state.card);
    // 勾选里只留还在的 id（别处删卡 / 恢复备份换掉了的）
    const ids = new Set();
    for (const t of tree) { ids.add(t.id); if (t.type === 'folder') for (const s of t.scripts) ids.add(s.id); }
    for (const id of batch.picked) if (!ids.has(id)) batch.picked.delete(id);
    const sig = viewSig();
    if (force !== true && sig === lastSig && tab.firstChild) return;
    lastSig = sig;
    const locked = !!scriptsBlocked();
    tab.replaceChildren(
        h('div', { class: 'row scr-bar', 'data-fk': 'scr-bar' }),
        h('div', { class: 'dim scr-note', 'data-fk': 'scr-note' }, '仅查看和编辑，暂不运行'),
        tree.length
            ? h('div', { class: 'plist scr-list', 'data-fk': 'scr-list' }, tree.map(t => (t.type === 'folder' ? folderBox(t, locked) : scriptBox(t, locked))))
            : h('div', { class: 'empty', 'data-fk': 'scr-empty' }, '这张卡没有脚本。'));
    renderBar(locked);
}
