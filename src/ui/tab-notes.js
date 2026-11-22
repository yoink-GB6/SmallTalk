// 便签：随手记点子、当待办。一条一条的，像「预设」页的条目列表（复用 .plist / .pitem 的样式和写法）。
// 以前是单独的「便签」页签；界面精简（2026-11-22 用户定）后整块挂在「人设」页下方（容器 #notes-box，由 tab-persona.js 的 renderPersonaTab 调 renderNotesTab 画）。
// 纯逻辑（增删改、挪动、筛选、合并）在 src/notes.js；这里只管界面和「改完存起来、重画」。
//
// 数据：state.notes（全局的，不跟着卡和存档走；一条都没有时 state 上没有这个键，见 state.js setNotesField 和 types.js GlobalRecord.notes）。
// 改动只走 setNotesField + save()，存到哪由存档层负责。便签不发给模型，所以这里不调 refreshPreview。
//
// 界面精简后的样子：说明一句「简易便签待办/idea处」；多行输入框（一行一条，「添加」或 Ctrl+Enter 提交，空行忽略）；筛选框；列表；
// 底下只有「删除已完成」。以前的「共 x 条，已完成 y 条」、空列表提示、「隐藏已完成」开关、导出 / 导入按钮都去掉了。
// 「隐藏已完成」存在全局记录的 notesHideDone 里——这个字段已废弃：这里不再读也不再写，旧数据里的值留着不管（见 data-inventory.js）。
//
// 界面状态（筛选词、展开了哪几条、输入框里还没加进去的字）放在本模块的 view 里：运行期的，不存盘（刷新后回到默认）。
//
// 重画时不丢焦点 / 不丢正在编辑的内容：
//   - 后台的 renderAll → renderInspector 在焦点停在「人设」页的文本框里时本来就会跳过重画（shell.js），焦点离开后才补画。
//   - 这里自己触发的重画只重画便签这一块（不动上面的人设）：输入框里的字先存进 view，重画后填回去；「添加」之后把焦点放回新的输入框。
//   - 筛选框打字时只重画列表，不重建筛选框本身。
//   - 展开后改标题 / 内容：每个字直接写进 state（保存有防抖），不重画，只顺手改标题行的文字。
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { $, h, toast, uid } from './dom.js';
import { state, save, persist, setNotesField, STOPPED_TEXT } from './state.js';
import { addNotesFromText, updateNote, setDone, deleteNote, clearDone, moveNote, filterNotes, countNotes } from '../notes.js';

const view = { query: '', draft: '', open: new Set() };

const notes = () => state.notes ?? [];
/** 便签这一块的容器（index.html 里「人设」页下方的 #notes-box） */
const box = () => $('#notes-box');

/** 现在能不能改便签；能返回 null，不能返回原因（和人设页的 personaBlocked 同一个风格）。生成回复、切换存档都不影响便签，不拦 */
export function notesBlocked() {
    if (persist.readOnly) return '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能改便签';
    if (persist.stopped) return STOPPED_TEXT;
    // 整体备份恢复正在写（ui/backup.js）：它把「本机 + 备份」合并好的便签写进存储后会重读全局层，这期间的改动会被盖掉
    if (persist.paused) return '正在从备份恢复，稍等一下再改便签';
    return null;
}

/** 改完的善后：换掉 state.notes（空了就删掉这个键）、排一次保存、重画便签这一块 */
function commit(list) {
    setNotesField(list);
    save();
    renderNotesTab();
}

/** 包一层：不允许改的时候弹提示、什么都不做 */
function guarded(fn) {
    return (...args) => {
        const why = notesBlocked();
        if (why) { toast(why, 'error'); return; }
        fn(...args);
    };
}

// 一行一条：输入框里的每个非空行变成一条便签，按顺序加在最后（notes.js addNotesFromText）
const doAdd = guarded(() => {
    const next = addNotesFromText(notes(), { text: view.draft, newId: uid, now: Date.now() });
    if (!next) { toast('先写点什么再添加', 'error'); return; }
    view.draft = '';
    commit(next);
    $('[data-fk="notes-new"]', box())?.focus();   // 重画换掉了输入框：焦点放回新的那个，连着记下一批
});

const doToggle = guarded((id, done) => commit(setDone(notes(), id, done, Date.now())));

const doMove = guarded((id, dir) => commit(moveNote(notes(), id, dir, visible().map(n => n.id))));

const doDelete = guarded(id => {
    const n = notes().find(x => x.id === id);
    if (!n) return;
    if (!confirm(`删除便签「${n.title || '（无标题）'}」？删掉就找不回来了。`)) { renderNotesTab(); return; }
    view.open.delete(id);
    commit(deleteNote(notes(), id));
});

const doClearDone = guarded(() => {
    const { done } = countNotes(notes());
    if (!done) { toast('没有已完成的便签', ''); return; }
    if (!confirm(`删除 ${done} 条已完成的便签？删掉就找不回来了。`)) return;
    const r = clearDone(notes());
    for (const id of view.open) if (!r.list.some(n => n.id === id)) view.open.delete(id);
    commit(r.list);
    toast(`删除了 ${r.removed} 条已完成的便签`, 'ok');
});

/** 当前筛选条件下看得见的那些（「隐藏已完成」去掉了，已完成的一直显示） */
const visible = () => filterNotes(notes(), view.query);

/** 一条便签 */
function noteItem(n, i, list, locked) {
    const open = view.open.has(n.id);
    const nameEl = h('span', { class: 'name', 'data-fk': 'note-title', title: open ? '点这里收起' : '点这里展开，改标题、写详细内容',
        onclick: () => { open ? view.open.delete(n.id) : view.open.add(n.id); renderNotesTab(); } },
        n.title || '（无标题）', n.body && !open ? h('span', { class: 'note-has-body', title: '有详细内容' }, ' …') : null);
    const head = h('header', null,
        h('input', { type: 'checkbox', checked: n.done, disabled: locked, 'data-fk': 'note-done', title: n.done ? '取消完成' : '标记为完成',
            onchange: e => doToggle(n.id, e.target.checked) }),
        nameEl,
        h('button', { class: 'ghost', title: '上移', 'data-fk': 'note-up', disabled: locked || i === 0, onclick: () => doMove(n.id, -1) }, '↑'),
        h('button', { class: 'ghost', title: '下移', 'data-fk': 'note-down', disabled: locked || i === list.length - 1, onclick: () => doMove(n.id, 1) }, '↓'),
        h('button', { class: 'ghost', title: '删除这条便签', 'data-fk': 'note-del', disabled: locked, onclick: () => doDelete(n.id) }, '✕'),
    );
    const item = h('div', { class: `pitem note-item${n.done ? ' done' : ''}`, 'data-fk': 'note-item', 'data-id': n.id }, head);
    if (open) item.append(noteEditor(n, nameEl, locked));
    return item;
}

/** 展开后的编辑区：标题（单行）+ 详细内容（多行）。每个字直接写进 state，不重画（不然光标会丢） */
function noteEditor(n, nameEl, locked) {
    const edit = (patch) => {
        const why = notesBlocked();
        if (why) { toast(why, 'error'); return; }
        setNotesField(updateNote(notes(), n.id, patch));
        save();
    };
    const title = h('input', { 'data-fk': 'note-edit-title', 'aria-label': '标题', autocomplete: 'off', readOnly: locked,
        oninput: e => { edit({ title: e.target.value }); nameEl.firstChild.textContent = e.target.value || '（无标题）'; } });
    title.value = n.title;
    const body = h('textarea', { 'data-fk': 'note-edit-body', rows: 4, 'aria-label': '详细内容', placeholder: '详细内容（可以写多行）', readOnly: locked,
        oninput: e => edit({ body: e.target.value }) });
    body.value = n.body;
    const when = d => new Date(d).toLocaleString();
    return h('div', { class: 'body' },
        h('label', { class: 'inline note-edit-row' }, '标题', title),
        body,
        h('div', { class: 'dim note-meta' }, `记于 ${when(n.createdAt)}${n.done && n.doneAt ? `，完成于 ${when(n.doneAt)}` : ''}`));
}

/** 只重画列表（筛选框打字时用：不重建筛选框本身，焦点和输入法状态都不受影响）。没有便签 / 没有匹配的就是空的，不放提示文字 */
function renderList(root) {
    const locked = !!notesBlocked();
    const list = visible();
    const el = $('[data-fk="notes-list"]', root);
    if (!el) return;
    el.replaceChildren(...list.map((n, i) => noteItem(n, i, list, locked)));
    $('[data-fk="notes-clear-done"]', root).disabled = locked || !countNotes(notes()).done;
}

/** 画便签这一块（「人设」页每次重画时调；便签自己改动后也只调它，不重画上面的人设） */
export function renderNotesTab() {
    const root = box();
    if (!root) return;
    const locked = !!notesBlocked();
    const lockTip = locked ? notesBlocked() : '';
    // 多行文本块：一行一条。Enter 照常换行；Ctrl+Enter（Mac 上 ⌘+Enter）提交，和「添加」按钮一样
    const input = h('textarea', { 'data-fk': 'notes-new', class: 'notes-new', rows: 3, placeholder: '一行一条', 'aria-label': '新便签（一行一条）', disabled: locked, title: lockTip,
        oninput: e => { view.draft = e.target.value; },
        onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); doAdd(); } } });
    input.value = view.draft;
    const filter = h('input', { 'data-fk': 'notes-filter', class: 'notes-filter', autocomplete: 'off', placeholder: '筛选（标题和内容里找）', 'aria-label': '筛选便签',
        oninput: e => { view.query = e.target.value; renderList(root); } });
    filter.value = view.query;
    root.replaceChildren(
        h('div', { class: 'section-title' }, '便签'),
        h('div', { class: 'dim misc-note' }, '简易便签待办/idea处'),
        h('div', { class: 'notes-add' }, input,
            h('button', { 'data-fk': 'notes-add', class: 'primary', disabled: locked, title: lockTip || '一行一条（Ctrl+Enter 也行）', onclick: doAdd }, '添加')),
        h('div', { class: 'row notes-tools' }, filter),
        h('div', { class: 'plist notes-list', 'data-fk': 'notes-list' }),
        h('div', { class: 'row notes-foot' },
            h('button', { 'data-fk': 'notes-clear-done', title: '把打了勾的便签都删掉（会先问你）', onclick: doClearDone }, '删除已完成')),
    );
    renderList(root);
}
