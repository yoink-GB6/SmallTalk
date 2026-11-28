// 「拼装」页的就地编辑：展开一条消息后，按来源（Source）分成几节（只有一个来源就一节），能改的节标题行末尾有「编辑」，
// 点了在那里展开这个来源的【原文】（宏替换之前、正则之前、合并之前那份），改完写回来源。
// 能改：角色卡字段、预设条目、世界书条目（卡自带的和额外的）、人设描述、作者注释、聊天的一楼。
// 不能改（不出现「编辑」）：外置记忆、工具提示（new_chat_prompt 等）、预填充、wi_format 包装、世界书示例、合并成一段认不出条目的世界书。
//
// 为什么是原文而不是页面上显示的最终文字：显示的是宏替换过的结果，拿它写回去 {{user}} / {{char}} 就被写死成名字了。
//
// 认出「这一段的原文在哪」靠 assemble.js 给每段带的 Source（kind / id，以及 cardField、book 这两个补充字段，见 types.js Source）。
// resolveSource(s) 给出：key（同一个来源在页面上出现几次都是同一个 key，编辑框只开在第一次出现的地方）、where（编辑框上方那行灰字）、
// get() 读原文、set(text) 写回。写回走各来源本来的保存路径（改 state → save() → 刷新预览），拦截条件和改聊天记录一样（chat.js chatWriteBlocked）。
//
// 编辑框开着时页面会因为各种原因重画（输入框打字、记忆压缩完成……）：编辑中的状态（哪一段、打到一半的字）记在本模块里，
// 重画时照样画出编辑框、填回草稿，所以不会被冲掉。换了存档（epoch 变了）就作废，免得把上一个存档的草稿写进新存档。
//
// 循环依赖：从兄弟 ui 模块导入的函数只在函数体里调用。

import { h, toast } from './dom.js';
import { state, ui, save, persist, preset, setPersonaFields, setAuthorNote } from './state.js';
import { updateCurrent } from '../personas.js';
import { refreshPreview, allEntries, currentAuthorNote } from './pipeline.js';   // 只在函数体里调用
import { chatWriteBlocked, editMessageText } from './chat.js';     // 同上
import { renderPromptTab } from './tab-prompt.js';   // 同上
import { ownPreset } from './tab-preset.js';          // 同上
import { renderTopbar } from './shell.js';            // 同上

/** 卡字段：名字（灰字里用）、读、写 */
const CARD_FIELDS = {
    description: { label: '描述', get: c => c.description, set: (c, v) => { c.description = v; } },
    personality: { label: '性格', get: c => c.personality, set: (c, v) => { c.personality = v; } },
    scenario: { label: '场景', get: c => c.scenario, set: (c, v) => { c.scenario = v; } },
    mesExample: { label: '对话示例', get: c => c.mesExample, set: (c, v) => { c.mesExample = v; } },
    systemPrompt: { label: 'system_prompt', get: c => c.systemPrompt, set: (c, v) => { c.systemPrompt = v; } },
    postHistoryInstructions: { label: 'post_history_instructions', get: c => c.postHistoryInstructions, set: (c, v) => { c.postHistoryInstructions = v; } },
    // 深度提示：parseCard 在 prompt 为空时给 null；能在拼装里看到它就说明不是 null。改成空串也保留对象（深度、角色还在），拼装时自然不发
    depthPrompt: { label: '深度提示', get: c => c.depthPrompt?.prompt ?? '', set: (c, v) => { c.depthPrompt = { depth: 4, role: 'system', ...(c.depthPrompt ?? {}), prompt: v }; } },
};

/**
 * 同时直接改原始数据 raw 里存这个字段的地方（用户定：简单粗暴地就地改，不留旧版本）。
 * 位置照酒馆保存角色时的 charaFormatData：V2/V3 在 raw.data.*，顶层有同名旧字段的一并改；V1（没有 data）只有顶层。
 * system_prompt / post_history_instructions / 深度提示只在 data 里：V1 卡没地方放，不碰 raw——导出时 card-export.js 会发现
 * 它和 raw 不同、把卡升级成 V2 再写进去（TEXT_FIELDS）。这样前端卡读 raw（frame-host.js getCharData）也能看到新内容。
 */
const RAW_KEY = { description: 'description', personality: 'personality', scenario: 'scenario', mesExample: 'mes_example', systemPrompt: 'system_prompt', postHistoryInstructions: 'post_history_instructions' };
function writeRaw(card, f, text) {
    const raw = card.raw;
    if (!raw || typeof raw !== 'object') return;
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
    if (f === 'depthPrompt') {
        if (!data) return;
        const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : (data.extensions = {});
        ext.depth_prompt = { depth: card.depthPrompt?.depth ?? 4, role: card.depthPrompt?.role ?? 'system', ...(ext.depth_prompt ?? {}), prompt: text };
        return;
    }
    const key = RAW_KEY[f];
    if (data) { data[key] = text; if (key in raw) raw[key] = text; }
    else if (!['system_prompt', 'post_history_instructions'].includes(key)) raw[key] = text;
}

/** 这一段是不是卡的某个字段：返回 CARD_FIELDS 的键 */
function cardFieldOf(s) {
    if (s.kind === 'marker') return { charDescription: 'description', charPersonality: 'personality', scenario: 'scenario' }[s.id] ?? null;
    if (s.kind === 'example') return String(s.id).startsWith('mes_example') ? 'mesExample' : null;
    if (s.kind === 'depthPrompt') return 'depthPrompt';
    if (s.kind === 'prompt' && s.cardField) return s.cardField === 'system_prompt' ? 'systemPrompt' : s.cardField === 'post_history_instructions' ? 'postHistoryInstructions' : null;
    return null;
}

/**
 * 一段出处 → 能不能就地改、原文在哪。不能就地改返回 null。
 * @param {import('../types.js').Source} s
 * @returns {{key: string, where: string, get: () => string, set: (text: string) => void} | null}
 */
export function resolveSource(s) {
    const f = cardFieldOf(s);
    if (f && state.card) {
        const d = CARD_FIELDS[f];
        return {
            key: `card:${f}`, where: `角色卡 · ${d.label}`,
            get: () => String(d.get(state.card) ?? ''),
            set: text => { d.set(state.card, text); writeRaw(state.card, f, text); save(); },
        };
    }
    // 预设条目：走「预设」页条目编辑器的路（tab-preset.js promptEditor：先 ownPreset——还在用内置默认预设时复制一份——再改 content、存盘、刷新顶栏）。
    // 预设里找不到这个 identifier（assemble 自动补上的内置默认条目）或是占位条目：不可改
    if (s.kind === 'prompt' && !s.cardField) {
        const find = () => (preset().prompts ?? []).find(x => x?.identifier === s.id);
        const pr = find();
        if (!pr || pr.marker || typeof pr.content !== 'string') return null;
        return {
            key: `preset:${s.id}`, where: `预设条目 · ${pr.name || s.id}`,
            get: () => String(find()?.content ?? ''),
            set: text => {
                const t = ownPreset().prompts.find(x => x?.identifier === s.id);
                if (!t) return;
                t.content = text; save(); renderTopbar();
            },
        };
    }
    // 世界书条目：按「书名 + uid」认（同「世界书」页的触发结果）。合并成一段、认不出是哪一条的（没有 book）不可改。
    // 写法同「世界书」页的条目编辑器（tab-world.js entryEditor：直接改条目原对象、存盘、刷新预览）
    if (s.kind === 'worldinfo' && typeof s.book === 'string') {
        const find = () => allEntries().find(e => e.book === s.book && String(e.uid) === s.id);
        const e = find();
        if (!e) return null;
        return {
            // uid 是数字，放在前面；不用 \0 当分隔（key 要放进 data-src 和 CSS 选择器里）
            key: `wi:${s.id}@${s.book}`, where: `世界书「${s.book}」· ${e.comment || `条目 ${e.uid}`}`,
            get: () => String(find()?.content ?? ''),
            set: text => { const t = find(); if (t) { t.content = text; save(); } },
        };
    }
    // 人设描述：同「人设」页描述框（tab-persona.js bindPersonaTab）
    if (s.kind === 'marker' && s.id === 'personaDescription') {
        return {
            key: 'persona', where: '人设 · 描述',
            get: () => String(state.persona?.description ?? ''),
            set: text => { setPersonaFields(updateCurrent(state, { description: text })); save(); },
        };
    }
    // 作者注释正文：同「人设」页下面的作者注释框（state.js setAuthorNote，它自己存盘）
    if (s.kind === 'authorNote') {
        if (!persist.chatMeta) return null;
        return {
            key: 'authorNote', where: '作者注释',
            get: () => currentAuthorNote().prompt,
            set: text => { setAuthorNote({ prompt: text }); },
        };
    }
    // 聊天的一楼：同编辑消息的「保存」（chat.js editMessageText：永久改写正则、候选同步、记忆打「原文改过」（不作废）、存盘重画）。
    // 输入框里还没发出去的那一句（楼层号 = 现有楼数）不可改
    if (s.kind === 'chat') {
        const i = Number(s.id);
        if (!Number.isInteger(i) || !state.chat[i]) return null;
        return {
            key: `chat:${i}`, where: `聊天第 ${i} 楼`,
            get: () => String(state.chat[i]?.content ?? ''),
            set: text => { editMessageText(i, text); },
        };
    }
    return null;
}

/** 现在能不能改（null = 能）。和改聊天记录同一套：生成中、恢复备份中、停止保存、只读、切换中都不行 */
export const editBlocked = () => chatWriteBlocked(persist.epoch, '编辑');

/** 正在编辑的那一段：{key, draft, epoch}；没有 = null。只在内存里 */
let editing = null;

/** 编辑框开着、而且还是这个存档的？（换了存档就作废） */
export function currentEdit() {
    if (editing && editing.epoch !== persist.epoch) editing = null;
    return editing;
}

/** 这条消息里有没有正在编辑的那一段（有的话拼装页强制展开这条） */
export const messageHasEdit = m => !!currentEdit() && m.sources.some(s => resolveSource(s)?.key === editing.key);

const rerender = () => renderPromptTab();

function open(r) {
    const why = editBlocked();
    if (why !== null) { if (why) toast(why, 'error'); return; }
    editing = { key: r.key, draft: r.get(), epoch: persist.epoch };
    rerender();
    // 画完把焦点放进编辑框
    setTimeout(() => document.querySelector('#tab-prompt .pedit textarea')?.focus(), 0);
}

function cancel() { editing = null; rerender(); }

function commit(r) {
    if (!currentEdit()) return rerender();
    const why = editBlocked();
    if (why !== null) { if (why) toast(why, 'error'); return; }
    const text = editing.draft;
    editing = null;
    if (text !== r.get()) {
        r.set(text);
        ui.previewIsSent = false;
        refreshPreview();
    }
    rerender();
}

/**
 * 一段的显示：可改的段在标签行末尾有个小「编辑」；正在编辑的段（同一个 key 的第一次出现）画成编辑框。
 * @param {import('../types.js').Source} s
 * @param {string} body      这一段最终发出去的文字
 * @param {string} labelText 标签行的文字
 * @param {Set<string>} shown 这次重画里已经画过编辑框的 key（同一来源出现多次时只画一次）
 */
export function segView(s, body, labelText, shown) {
    const r = resolveSource(s);
    const blocked = r ? editBlocked() !== null : true;
    const ed = r && currentEdit()?.key === r.key && !shown.has(r.key) ? editing : null;
    const label = h('div', { class: 'seg-label' }, labelText,
        r && !ed && !blocked ? h('button', { class: 'ghost seg-edit-btn', type: 'button', title: `改${r.where}的原文`, onclick: e => { e.stopPropagation(); open(r); } }, '编辑') : null);
    const seg = h('div', { class: 'seg' + (r && !blocked ? ' seg-editable' : ''), style: `--c: var(--src-${s.kind})`, 'data-src': r?.key ?? '' }, label);
    if (!ed) {
        seg.append(h('pre', null, body));
        return seg;
    }
    shown.add(r.key);
    const ta = h('textarea', { spellcheck: false, rows: Math.min(16, Math.max(3, ed.draft.split('\n').length + 1)),
        oninput: e => { ed.draft = e.target.value; },
        onkeydown: e => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); commit(r); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        } });
    ta.value = ed.draft;
    seg.append(h('div', { class: 'pedit' },
        h('div', { class: 'pedit-where dim' }, r.where),
        ta,
        h('div', { class: 'row' },
            h('button', { class: 'primary', type: 'button', onclick: () => commit(r) }, '保存'),
            h('button', { type: 'button', onclick: cancel }, '取消'))));
    return seg;
}
