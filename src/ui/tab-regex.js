// 检查器「正则」页：全局 / 预设 / 角色卡三组正则脚本，每条可以开关、展开编辑、上下移、删除；全局组还能新增、导入。
//
// 三个来源的数据各存在哪（改的都是原对象，存盘由存档层负责，这里只调 save()）：
//   - 全局：state.globalRegex（存在全局记录里，不跟卡和存档走）；
//   - 预设自带：当前预设的 extensions.regex_scripts（存在预设记录里；导出预设时自然带上）；
//   - 角色卡自带：card().regexScripts（存在卡记录里）。导出卡时 card-export.js 的 exportCardJson 会拿它和「导入时的样子」比，
//     改过 / 删过就写回 data.extensions.regex_scripts，没动过的卡导出结果不变。
// 卡 / 预设被删时，它们自带的启用正则可以移进全局：见 regex-delete.js（删除前弹框问）。
// 开关原来就是直接改脚本上的 disabled，所以编辑也一样直接改脚本对象——三个来源走同一个编辑器。
//
// 酒馆互通：编辑器只写自己认识的那些字段（见 src/regex-edit.js），脚本上不认识的字段原样留着，导出时也原样带出。
// 注意 pipeline.js 的 allScripts 会在脚本上写一个运行时的 origin 标签；它不是酒馆的字段，导出时去掉（regex-edit.js serializeRegexScript）。
//
// 重画时不丢焦点：
//   - 文本框每个字都直接写进脚本（保存本身有防抖），不重画本页；聊天区和「拼装」页的刷新另外防抖。
//     后台的 renderAll → renderInspector 在焦点停在本页文本框里时会跳过重画（shell.js），焦点离开后才补画。
//   - 勾选框、下拉框这类改完会让显示变化的，改完立刻重画本页。
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { $, h, toast, uid, download, debounce } from './dom.js';
import { state, ui, save, persist, card, preset, STOPPED_TEXT } from './state.js';
import { allScripts, macroContext } from './pipeline.js';
import { renderAll } from './shell.js';
import { pickAndImportFiles } from './pick-import-files.js';
import { substitute } from '../macros.js';
import {
    PLACEMENT_CHOICES, SUBSTITUTE_CHOICES, SCOPE_CHOICES, scopeOf, applyScope, newRegexScript, parseDepth, parseTrimStrings,
    checkFindRegex, tryScript, serializeRegexScript, regexFileName,
} from '../regex-edit.js';

// ───────────────────────────── 检查器：正则 ─────────────────────────────

export const PLACEMENT_NAMES = { 1: '用户输入', 2: 'AI 输出', 3: '斜杠命令', 5: '世界书', 6: '推理' };
export const ORIGIN_NAMES = { global: '全局', preset: '预设', card: '角色卡' };

// 展开状态记在脚本对象本身上（WeakSet）：挪动、重画都不丢；切卡 / 切预设换了对象，自然清掉
const openScripts = new WeakSet();
// 「试一试」输入框里的文字，同样跟着脚本对象走，不存盘
const tryTexts = new WeakMap();

/** 现在能不能改正则；能返回 null，不能返回原因（和便签页的 notesBlocked 同一个风格）。生成回复时可以改：引擎每次现取脚本，不会出错 */
export function regexBlocked() {
    if (persist.readOnly) return '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能改正则';
    if (persist.stopped) return STOPPED_TEXT;
    if (persist.paused) return '正在从备份恢复，稍等一下再改正则';
    return null;
}

/** 三组脚本。list 是真正存数据的那个数组（改它就是改 state / 预设 / 卡） */
function groups() {
    return [
        { origin: 'global', title: '全局正则', list: state.globalRegex ?? [] },
        { origin: 'preset', title: '当前预设自带', list: preset().extensions?.regex_scripts ?? [] },
        { origin: 'card', title: '当前角色卡自带', list: card().regexScripts ?? [] },
    ];
}

/** 改完立刻生效：已渲染的楼层缓存清掉（聊天区按新规则重画）、存盘、「拼装」页预览刷新 */
function applyNow() {
    ui.rendered.clear();
    save();
    renderAll();
}
/** 打字时用：先让聊天区和预览歇一下再刷（每个字都重画所有楼层太重） */
const applyLater = debounce(applyNow, 300);

/** 包一层：不允许改的时候弹提示、什么都不做 */
function guarded(fn) {
    return (...args) => {
        const why = regexBlocked();
        if (why) { toast(why, 'error'); renderRegexTab(); return; }
        fn(...args);
    };
}

const addScript = guarded(() => {
    const s = newRegexScript(uid());
    state.globalRegex.push(s);
    openScripts.add(s);
    applyNow(); renderRegexTab();
});

const moveScript = guarded((list, i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];   // 顺序就是执行顺序
    applyNow(); renderRegexTab();
});

const deleteScript = guarded((list, s) => {
    if (!confirm(`删除正则「${s.scriptName || '(未命名)'}」？删掉就找不回来了（可以先点「导出」留一份）。`)) return;
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1);
    applyNow(); renderRegexTab();
});

// 可多选；每个文件走 importer.js importFiles 里现成的正则导入（cleanRegexList 清洗，算作全局）
const importRegex = guarded(() => pickAndImportFiles());

const exportScript = s => download(regexFileName(s), serializeRegexScript(s));

const when = s => (s.markdownOnly && s.promptOnly ? '显示 + 发送' : s.markdownOnly ? '仅显示' : s.promptOnly ? '仅发送' : '永久改写原文');
const depthText = s => {
    const a = s.minDepth != null && s.minDepth >= -1 ? s.minDepth : null;
    const b = s.maxDepth != null && s.maxDepth >= 0 ? s.maxDepth : null;
    return a == null && b == null ? '' : `深度 ${a ?? 0}–${b ?? '∞'}`;
};

/** 一条脚本的行（头部 + 展开后的编辑区） */
function scriptItem(s, list, i, locked) {
    const open = openScripts.has(s);
    const nameEl = h('span', { class: 'name', 'data-fk': 're-name', title: open ? '点这里收起' : '点这里展开编辑',
        onclick: () => { open ? openScripts.delete(s) : openScripts.add(s); renderRegexTab(); } }, s.scriptName || '(未命名)');
    const check = checkFindRegex(s.findRegex, s.substituteRegex);
    const errBadge = h('span', { class: 'badge bad', 'data-fk': 're-bad', hidden: check.ok, title: check.message }, '正则有误');
    const head = h('header', null,
        h('input', { type: 'checkbox', 'data-fk': 're-enable', checked: !s.disabled, disabled: locked, title: s.disabled ? '已关闭，点一下启用' : '已启用',
            onchange: guarded(e => { s.disabled = !e.target.checked; applyNow(); renderRegexTab(); }) }),
        nameEl,
        errBadge,
        h('span', { class: 'badge' }, (Array.isArray(s.placement) ? s.placement : []).map(p => PLACEMENT_NAMES[p] ?? p).join(' / ')),
        h('span', { class: `badge ${s.markdownOnly || s.promptOnly ? '' : 'bad'}` }, when(s)),
        depthText(s) ? h('span', { class: 'badge' }, depthText(s)) : null,
        h('button', { class: 'ghost', 'data-fk': 're-up', title: '上移（顺序就是执行顺序）', disabled: locked || i === 0, onclick: () => moveScript(list, i, -1) }, '↑'),
        h('button', { class: 'ghost', 'data-fk': 're-down', title: '下移', disabled: locked || i === list.length - 1, onclick: () => moveScript(list, i, 1) }, '↓'),
        h('button', { class: 'ghost', 'data-fk': 're-del', title: '删除这条正则', disabled: locked, onclick: () => deleteScript(list, s) }, '✕'),
    );
    const item = h('div', { class: `pitem re-item ${s.disabled ? 'disabled' : ''}`, 'data-fk': 're-item', 'data-origin': list === state.globalRegex ? 'global' : '' }, head);
    if (open) item.append(scriptEditor(s, nameEl, errBadge, locked));
    return item;
}

/**
 * 展开后的编辑区。字段以 src/regex.js 真正读取的为准：
 * findRegex / replaceString / trimStrings / placement / markdownOnly / promptOnly / runOnEdit / substituteRegex / minDepth / maxDepth（外加名字和启用）。
 * disabled 在行头的勾选框上；id 不给改。
 */
function scriptEditor(s, nameEl, errBadge, locked) {
    /** 写一个字段：存盘 + 稍后刷新聊天区 / 预览；text = 打字中，不重画本页 */
    const set = (field, value) => { s[field] = value; save(); applyLater(); };
    const msg = h('div', { class: 're-msg', 'data-fk': 're-msg' });
    const tryOut = h('pre', { class: 'block re-try-out', 'data-fk': 're-try-out' });

    /** 查找串的提示 + 「试一试」的结果，改了任何一个相关字段都调一次（不重画本页） */
    const paint = () => {
        const r = checkFindRegex(s.findRegex, s.substituteRegex);
        msg.textContent = r.message || r.note || '';
        msg.className = `re-msg${r.ok ? '' : ' bad'}`;
        errBadge.hidden = r.ok;
        errBadge.title = r.message;
        const text = tryTexts.get(s) ?? '';
        if (!text) { tryOut.textContent = ''; return; }
        if (!r.ok) { tryOut.textContent = '（正则有误，没法试）'; return; }
        try {
            const ctx = macroContext(state.chat, structuredClone(state.variables));
            tryOut.textContent = tryScript(s, text, t => substitute(t, ctx));
        } catch (e) { tryOut.textContent = `（试一试出错：${e?.message ?? e}）`; }
    };
    /** 打字类字段：直接写进脚本，更新提示，不重画 */
    const typing = (field, parse = v => v, after) => e => { set(field, parse(e.target.value)); after?.(e.target.value); paint(); };
    /** 会让头部徽章变化的字段：写完重画本页（焦点在勾选框 / 下拉框上，没有打字被打断的问题） */
    const choose = fn => guarded(e => { fn(e); applyNow(); renderRegexTab(); });

    const text = (value, handler, extra = {}) => { const el = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, readOnly: locked, oninput: handler, ...extra }); el.value = value ?? ''; return el; };
    const area = (value, handler, rows, placeholder, fk) => { const el = h('textarea', { spellcheck: false, rows, readOnly: locked, placeholder, 'data-fk': fk, oninput: handler }); el.value = value ?? ''; return el; };
    const depthInput = (field, fk) => text(s[field] ?? '', typing(field, parseDepth), { inputMode: 'numeric', placeholder: '不限', 'data-fk': fk, class: 're-num' });

    const placements = Array.isArray(s.placement) ? s.placement : [];
    const findInput = text(s.findRegex, typing('findRegex'), { 'data-fk': 're-find', class: 're-find', placeholder: '/正则/标志，或直接写正则本身' });
    const tryInput = area(tryTexts.get(s) ?? '', e => { tryTexts.set(s, e.target.value); paint(); }, 3, '在这里贴一段文字，下面显示这条正则替换后的样子（不保存）', 're-try-in');
    tryInput.readOnly = false;   // 试一试不改数据，只读标签页里也能用

    const body = h('div', { class: 'body re-body' },
        h('label', { class: 'inline re-row' }, '脚本名', text(s.scriptName, typing('scriptName', v => v, v => { nameEl.textContent = v || '(未命名)'; }), { 'data-fk': 're-edit-name' })),
        h('div', { class: 'dim' }, '查找的正则'), findInput, msg,
        h('label', { class: 'inline re-row' }, '宏替换', h('select', { 'data-fk': 're-subst', disabled: locked, title: '要不要先把查找串里的 {{宏}} 换成值再当正则用',
            onchange: choose(e => { s.substituteRegex = Number(e.target.value); }) },
            SUBSTITUTE_CHOICES.map(c => h('option', { value: c.value, selected: Number(s.substituteRegex ?? 0) === c.value }, c.label)))),
        h('div', { class: 'dim' }, '替换成（可用 $1、$<名字>、{{match}}；多行）'), area(s.replaceString, typing('replaceString'), 4, '留空 = 把匹配到的删掉', 're-replace'),
        h('div', { class: 'dim' }, '修剪掉的字符串（一行一个；从 $1 这类捕获内容里删掉它们）'), area(s.trimStrings?.join?.('\n') ?? '', typing('trimStrings', parseTrimStrings), 2, '', 're-trim'),
        h('div', { class: 'dim' }, '作用于'),
        h('div', { class: 'row re-placements' }, PLACEMENT_CHOICES.map(c => h('label', { class: 'inline', title: c.title },
            h('input', { type: 'checkbox', 'data-fk': `re-place-${c.value}`, disabled: locked, checked: placements.includes(c.value),
                onchange: choose(e => {
                    const rest = placements.filter(p => p !== c.value);
                    s.placement = (e.target.checked ? [...rest, c.value] : rest).sort((a, b) => a - b);   // 其它数值（酒馆已废弃的 0、4）原样留着
                }) }), c.label))),
        h('div', { class: 'row' },
            h('label', { class: 'inline', title: SCOPE_CHOICES.map(c => `${c.label}：${c.title}`).join('\n') }, '范围',
                h('select', { 'data-fk': 're-scope', disabled: locked, onchange: choose(e => applyScope(s, e.target.value)) },
                    SCOPE_CHOICES.map(c => h('option', { value: c.value, selected: scopeOf(s) === c.value }, c.label)))),
            h('label', { class: 'inline', title: '只处理离最新一楼这么远的楼层：0 = 最新一楼，1 = 倒数第二楼……留空 = 不限' }, '楼层深度', depthInput('minDepth', 're-min'), '到', depthInput('maxDepth', 're-max')),
            h('label', { class: 'inline', title: '改某一楼的文字时（编辑消息）这条也跑' },
                h('input', { type: 'checkbox', 'data-fk': 're-onedit', disabled: locked, checked: s.runOnEdit === true, onchange: choose(e => { s.runOnEdit = e.target.checked; }) }), '编辑时也运行')),
        h('div', { class: 'dim' }, '试一试'), tryInput, tryOut,
        h('div', { class: 'row' },
            h('button', { 'data-fk': 're-export', title: '下载成酒馆的正则 JSON（一条一个文件），酒馆里可以直接导入', onclick: () => exportScript(s) }, '导出')),
    );
    paint();
    return body;
}

export function renderRegexTab() {
    const tab = $('#tab-regex');
    const locked = !!regexBlocked();
    allScripts();   // 给每条脚本打上 origin 标签（导出时要去掉，见 regex-edit.js）
    const kids = [
        h('div', { class: 'summary' },
            h('button', { 'data-fk': 're-add', disabled: locked, title: locked ? regexBlocked() : '新建一条全局正则', onclick: addScript }, '＋ 新增'),
            h('button', { 'data-fk': 're-import', disabled: locked, title: locked ? regexBlocked() : '导入酒馆的正则 JSON（可多选，也可以直接把文件拖进页面），算作全局', onclick: importRegex }, '导入')),
    ];
    for (const g of groups()) {
        if (g.origin !== 'global' && !g.list.length) continue;
        kids.push(h('div', { class: 'section-title', 'data-fk': `re-group-${g.origin}` }, `${g.title}（${g.list.length}）`));
        if (!g.list.length) kids.push(h('div', { class: 'empty' }, '新增or拖入JSON'));
        else kids.push(h('div', { class: 'plist' }, g.list.map((s, i) => scriptItem(s, g.list, i, locked))));
    }
    tab.replaceChildren(...kids);
}
