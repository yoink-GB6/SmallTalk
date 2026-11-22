// 检查器「预设」页：顶部是预设选择器（切换 / 导入新增 / 改名 / 删除 / 导出），下面是当前预设的条目列表、
// 启用 / 排序 / 删除 / 新增 / 导入条目、条目编辑器。这里的所有改动都只改 state.preset（= 当前预设），
// 存到哪个键由 state.js 负责（只重写当前预设那一条）。

import { $, h, download, uid, toast } from './dom.js';
import { state, ui, preset, save, DEFAULT_PRESET, presets, listPresets, switchPreset, deleteCurrentPreset, renameCurrentPreset, presetBlocked } from './state.js';
import { refreshPreview } from './pipeline.js';
import { renderTopbar, renderAll } from './shell.js';
import { pickJson } from './importer.js';
import { pickAndImportFiles } from './pick-import-files.js';
import { sanitizePreset } from '../preset-sanitize.js';
import { askRegexFate, moveAndFlush, undoMove, refreshRegexViews, moveSummary } from './regex-delete.js';
import { enabledScripts } from '../regex-move.js';

// ───────────────────────────── 检查器：预设 ─────────────────────────────

/** 当前生效的顺序表：character_id 100001，没有就取第一个（和 assemble.js 的选择规则一致） */
export function activeOrder() {
    const po = preset().prompt_order ?? [];
    return (po.find(o => o.character_id === 100001) ?? po[0])?.order ?? [];
}

/** 改预设之前调用：如果还在用内置默认预设，先复制一份成为用户自己的 */
export function ownPreset() {
    // 这份副本在下次保存时会存成一条新的预设记录（state.js presetWrites），名字重复时自动加序号
    if (!state.preset) { state.preset = structuredClone(DEFAULT_PRESET); state.presetName = '默认预设（已修改）'; }
    return state.preset;
}

export function presetChanged() { save(); renderPresetTab(); renderTopbar(); refreshPreview(); }

// 当前预设换了（切换、导入、删除、启动时的升级 / 补读完成）：整页重画。
// 预设自带的正则会影响楼层的显示，所以连已渲染的楼层缓存一起清掉。
// 这里只是赋值、不调用别的 ui 模块的函数，顶层这样写不受循环依赖影响。
presets.onChange = () => { ui.rendered.clear(); renderAll(); };

const safeFileName = s => String(s).replace(/[\\/:*?"<>|\r\n]+/g, '-').trim() || 'preset';

/** 预设选择器那一行 */
function presetBar() {
    const list = listPresets();
    // value '' = 内置默认预设（switchPreset('') 切回 DEFAULT_PRESET）。正在用自己的预设时它也一直在列表最上面，
    // 这样不用把预设全删光也能回到默认
    const sel = h('select', { class: 'preset-select', title: '切换当前预设', onchange: e => switchPreset(e.target.value).then(() => renderPresetTab()) },
        presets.activeId ? h('option', { value: '' }, '（内置默认）') : h('option', { value: '', selected: true },
            presets.mode === 'legacy' ? `${state.presetName || '旧预设'}（预设存储还没升级）`
                : state.preset ? '默认预设（已修改，下次保存时存下来）' : '内置默认预设'),
        list.map(m => h('option', { value: m.id, selected: m.id === presets.activeId }, m.name)));
    const rename = () => {
        const name = prompt('预设名字', state.presetName);
        if (name == null || !name.trim() || name.trim() === state.presetName) return;
        const used = renameCurrentPreset(name);
        if (used && used !== name.trim()) toast(`已经有叫「${name.trim()}」的预设了，改成「${used}」`, 'ok');
        renderPresetTab(); renderTopbar();
    };
    // 删除当前预设。预设自带的正则里有启用的：弹三选一框（移动至全局 / 丢弃 / 取消），见 regex-delete.js。
    // 顺序：先过一遍 presetBlocked（拒绝就不弹框）→ 问 → 选「移动」就先加进全局并落盘 → deleteCurrentPreset。
    // 删除失败就撤回——但 deleteCurrentPreset 在「已经离开这个预设、只是最后一次存盘失败」时也返回 false，
    // 那种情况下删除会在下次保存时重试（预设已不在列表里），这时不能撤回，不然正则就没了。所以只在预设还在列表里时撤回。
    const del = async () => {
        const blocked = presetBlocked();
        if (blocked) { toast(blocked, 'error'); return; }
        const name = state.presetName, id = presets.activeId;
        const enabled = enabledScripts(preset().extensions?.regex_scripts);
        const what = `删除预设「${name}」？删掉就找不回来了（可以先点「导出」留一份）。`;
        let moved = null;
        // 弹框开着的时候当前预设可能已经换了（比如往页面里拖进了一个新预设）：deleteCurrentPreset 删的是「那一刻的当前预设」，
        // 不核对就会删错。换了就放弃，让用户重新点一次。
        const stillSame = () => presets.activeId === id || (toast('当前预设已经换了，这次没有删除', 'error'), false);
        if (enabled.length) {
            const fate = await askRegexFate({ kind: 'preset', title: what, scripts: enabled });
            if (!fate || !stillSame()) return;
            if (fate === 'move') { moved = await moveAndFlush(enabled); if (!moved) return; }
        } else if (!confirm(what) || !stillSame()) return;
        const next = await deleteCurrentPreset();
        if (next === false) {
            if (moved && presets.catalog.has(id)) await undoMove(moved);
            return;
        }
        if (moved) refreshRegexViews();
        toast((next ? `已删除「${name}」，切到「${next}」` : `已删除「${name}」；没有别的预设了，回到内置默认预设`) + moveSummary(moved), 'ok');
    };
    return h('div', { class: 'preset-bar' },
        sel,
        // 可以一次选多个文件：每个都走 importFiles 里同一套预设导入（cleanPresetBody 清洗连接信息、新增并切过去、不替换已有的）
        h('button', { title: '导入酒馆预设 JSON（可多选）：作为新预设加进列表并切过去，不替换已有的', onclick: pickAndImportFiles }, '导入'),
        h('button', { title: '给当前预设改名', disabled: !state.preset, onclick: rename }, '改名'),
        h('button', { title: '删除当前预设', disabled: !presets.activeId, onclick: del }, '删除'),
        // 导出前再去一遍酒馆的连接信息（反代地址 / 密码等，见 preset-sanitize.js）：读档时已经清过，这里是出口的兜底
        h('button', { title: '把当前预设下载成酒馆格式的 JSON（不带酒馆的反代地址、密码等连接信息）', onclick: () => download(`${safeFileName(state.presetName || 'preset')}.json`, JSON.stringify(sanitizePreset(preset()).preset, null, 2)) }, '导出'),
    );
}

export function renderPresetTab() {
    const tab = $('#tab-preset');
    if (presets.pending) {
        // 启动时 global 指向的预设还在补读（见 state.js loadMissingPreset）：这时改的话会改到默认预设的副本上
        tab.replaceChildren(h('div', { class: 'dim' }, '正在读取预设……'));
        return;
    }
    const p = preset();
    const order = activeOrder();
    const byId = new Map((p.prompts ?? []).map(x => [x.identifier, x]));
    const enabled = order.filter(o => o.enabled).length;

    const opt = (key, label) => h('label', { class: 'inline' },
        h('input', { type: 'checkbox', checked: Boolean(p[key]), onchange: e => { ownPreset()[key] = e.target.checked; presetChanged(); } }), label);

    const kids = [
        presetBar(),
        h('div', { class: 'summary' },
            h('span', { class: 'dim' }, `${enabled} / ${order.length} 个条目启用`),
            h('span', { class: 'spacer' }),
            opt('squash_system_messages', '合并连续 system'),
            h('button', { onclick: addPrompt }, '＋ 条目'),
            h('button', { title: '从 JSON 追加条目：单个条目、条目数组，或另一个预设文件（取它启用的非占位条目）', onclick: () => pickJson(importPromptEntries) }, '导入条目'),
        ),
        h('div', { class: 'dim', style: 'margin-bottom:8px' }, '从上到下就是相对位置条目的拼装顺序；标了「@深度」的条目会被插进聊天记录里。勾选框 = 启用。'),
    ];

    const list = h('div', { class: 'plist' });
    order.forEach((o, i) => {
        const pr = byId.get(o.identifier);
        const open = ui.openPrompts.has(o.identifier);
        const abs = pr?.injection_position === 1;
        const head = h('header', null,
            h('input', { type: 'checkbox', checked: o.enabled, onchange: e => { ownOrderItem(i).enabled = e.target.checked; presetChanged(); } }),
            h('span', { class: 'name', title: o.identifier, onclick: () => { open ? ui.openPrompts.delete(o.identifier) : ui.openPrompts.add(o.identifier); renderPresetTab(); } },
                pr ? (pr.name || o.identifier) : `（找不到条目 ${o.identifier}）`),
            pr?.marker ? h('span', { class: 'badge' }, '占位') : h('span', { class: `badge role-${pr?.role ?? 'system'}` }, pr?.role ?? 'system'),
            abs ? h('span', { class: 'badge on' }, `@深度 ${pr.injection_depth ?? 4} · 序 ${pr.injection_order ?? 100}`) : null,
            h('button', { class: 'ghost', title: '上移', disabled: i === 0, onclick: () => moveItem(i, -1) }, '↑'),
            h('button', { class: 'ghost', title: '下移', disabled: i === order.length - 1, onclick: () => moveItem(i, 1) }, '↓'),
            h('button', { class: 'ghost', title: '删除条目', onclick: () => deletePrompt(i) }, '✕'),
        );
        const item = h('div', { class: `pitem ${o.enabled ? '' : 'disabled'}` }, head);
        if (open && pr) item.append(promptEditor(pr));
        list.append(item);
    });
    kids.push(list);
    tab.replaceChildren(...kids);
}

export function ownOrderItem(i) {
    ownPreset();
    return activeOrder()[i];
}

export function moveItem(i, dir) {
    ownPreset();
    const order = activeOrder();
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    presetChanged();
}

/**
 * 删除条目。和酒馆一样分两种：自定义条目连定义一起删；内置条目（main、聊天记录等占位）
 * 只从顺序表里拿掉——定义留着，酒馆拼装时本来也会把缺的内置定义补回来。
 */
export function deletePrompt(i) {
    const item = activeOrder()[i];
    if (!item) return;
    const pr = (preset().prompts ?? []).find(x => x.identifier === item.identifier);
    const builtin = pr?.system_prompt === true;
    const what = pr?.name || item.identifier;
    if (!confirm(builtin ? `把内置条目「${what}」从顺序表里移除？（拼装时不再使用它）` : `删除条目「${what}」？内容会一并删掉。`)) return;
    const p = ownPreset();
    activeOrder().splice(i, 1);
    if (!builtin) p.prompts = p.prompts.filter(x => x.identifier !== item.identifier);
    ui.openPrompts.delete(item.identifier);
    presetChanged();
}

/** 把 JSON 里的条目追加到当前预设末尾。认三种形状：单个条目、条目数组 / {prompts: [...]}、完整预设。 */
export function importPromptEntries(json, name) {
    let incoming;
    if (Array.isArray(json?.prompts) && Array.isArray(json?.prompt_order)) {
        // 完整预设：按它自己的顺序表，取启用的、有内容的非占位条目
        const po = json.prompt_order.find(o => o.character_id === 100001) ?? json.prompt_order[0];
        const byId = new Map(json.prompts.map(x => [x.identifier, x]));
        incoming = (po?.order ?? []).filter(o => o.enabled).map(o => byId.get(o.identifier));
    } else {
        incoming = [].concat(Array.isArray(json?.prompts) ? json.prompts : json);
    }
    incoming = incoming.filter(x => x && typeof x === 'object' && !x.marker && typeof x.content === 'string' && x.content.trim());
    if (!incoming.length) throw new Error('里面没有可用的条目（需要带 content 的对象）');
    const p = ownPreset();
    const taken = new Set(p.prompts.map(x => x.identifier));
    for (const src of incoming) {
        // identifier 撞了（比如两边都有 main）就换一个新的，并作为自定义条目加入，不覆盖现有的
        const identifier = src.identifier && !taken.has(src.identifier) ? src.identifier : uid();
        taken.add(identifier);
        p.prompts.push({
            identifier, name: src.name || '导入的条目', system_prompt: false,
            role: ['system', 'user', 'assistant'].includes(src.role) ? src.role : 'system',
            content: src.content, marker: false,
            injection_position: src.injection_position === 1 ? 1 : 0,
            injection_depth: Number.isFinite(src.injection_depth) ? src.injection_depth : 4,
            injection_order: Number.isFinite(src.injection_order) ? src.injection_order : 100,
            forbid_overrides: false,
        });
        activeOrder().push({ identifier, enabled: true });
    }
    toast(`已从「${name}」追加 ${incoming.length} 个条目到列表末尾`, 'ok');
    presetChanged();
}

export function addPrompt() {
    const p = ownPreset();
    const identifier = uid();
    p.prompts.push({ identifier, name: '新条目', system_prompt: false, role: 'system', content: '', marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false });
    activeOrder().push({ identifier, enabled: true });
    ui.openPrompts.add(identifier);
    presetChanged();
}

export function promptEditor(shown) {
    // 编辑时要改的是用户自己的预设对象；如果当前还是内置默认预设，第一次改动时才复制
    const target = () => ownPreset().prompts.find(x => x.identifier === shown.identifier);
    const set = (key, value) => { target()[key] = value; save(); renderTopbar(); refreshPreview(); };
    const body = h('div', { class: 'body' });
    body.append(h('div', { class: 'row' },
        h('label', { class: 'inline' }, '名称', h('input', { value: shown.name ?? '', onchange: e => { set('name', e.target.value); renderPresetTab(); } })),
        h('label', { class: 'inline' }, '角色', h('select', { onchange: e => { set('role', e.target.value); renderPresetTab(); } },
            ['system', 'user', 'assistant'].map(r => h('option', { value: r, selected: (shown.role ?? 'system') === r }, r)))),
        h('label', { class: 'inline' }, '位置', h('select', { onchange: e => { set('injection_position', Number(e.target.value)); renderPresetTab(); } },
            h('option', { value: 0, selected: shown.injection_position !== 1 }, '相对（按列表顺序）'),
            h('option', { value: 1, selected: shown.injection_position === 1 }, '聊天内 @深度'))),
        shown.injection_position === 1 ? [
            h('label', { class: 'inline' }, '深度', h('input', { type: 'number', min: 0, value: shown.injection_depth ?? 4, onchange: e => { set('injection_depth', Number(e.target.value) || 0); renderPresetTab(); } })),
            h('label', { class: 'inline' }, '顺序', h('input', { type: 'number', value: shown.injection_order ?? 100, onchange: e => { set('injection_order', Number(e.target.value) || 0); renderPresetTab(); } })),
        ] : null,
    ));
    if (shown.marker) {
        body.append(h('div', { class: 'dim' }, '占位条目：内容在拼装时自动填入（角色描述、世界书、聊天记录等），这里只决定它放在哪。'));
    } else {
        const ta = h('textarea', { spellcheck: false, oninput: e => set('content', e.target.value) });   // 每个字立刻进 state（保存本身有防抖）：先防抖再改 state 的话，最后几个字会赶不上切换 / 关页面 / 导入新预设
        ta.value = shown.content ?? '';
        body.append(ta);
    }
    return body;
}
