// 外置记忆：把较早的楼层折叠成每轮一行的摘要（foldChat / summarizeTurn / ensureMemories）及「记忆」页。

import { substitute } from '../macros.js';
import { foldCut, memorySystem, MEMORY_SKIP, MEMORY_BATCH_DEFAULT, MEMORY_SUMMARY_LEN_DEFAULT, MEMORY_SUMMARY_LEN_MAX, summaryLenOf, turnInputs, isHidden } from '../memory-fold.js';
import { runRegexScripts } from '../regex.js';
import { complete, backendKind } from '../llm.js';
import { $, h } from './dom.js';
import { state, ui, save, persist, idsOfEpoch, patchStoredChat } from './state.js';
import { renderModelPicker, refUnpicked, endpointById, endpointsLoading, onEndpointsChange } from './model-picker.js';
import { allScripts, macroContext, placementOf, displayText, refreshPreview } from './pipeline.js';

// ───────────────────────────── 外置记忆 ─────────────────────────────
// 思路：模型每次只看得到 prompt 里的东西，聊天越长 prompt 越大。这里在模型之外维护一份「记忆」：
// 每轮结束后用一个便宜的模型把这一轮压成一句话，存在那条回复上（msg.memory）；
// 之后拼 prompt 时，老楼层不发原文，只发这些一句话摘要。

// 压缩提示词 memorySystem / MEMORY_SYSTEM 在 memory-fold.js（纯函数，单元测试直接测）
export { memorySystem, MEMORY_SYSTEM } from '../memory-fold.js';

// 「折到哪」和「哪一轮的摘要作废」的规则是纯函数，在 src/memory-fold.js（含 MEMORY_SKIP、批大小的默认值）
export { MEMORY_SKIP } from '../memory-fold.js';

/** 把若干行摘要拼成发给模型的记忆块 */
export function memoryBlock(rows) {
    return '[此前剧情的记忆：按先后顺序，每行是一轮的摘要]\n' + rows.map((r, k) => `${k + 1}. ${r.text}`).join('\n');
}

/**
 * 决定哪些楼层折叠成记忆（按当前的记忆设置）。返回 cut：chat[0..cut) 不发原文；rows：对应的摘要行。
 * 规则见 memory-fold.js foldCut：保留最近 keep 楼、折叠段里每条回复都已有摘要、切点对齐到 batch 的整数倍、停在一轮结束处。
 */
export function foldChat(chat) {
    // batch 固定 10：界面已隐藏这项设置（2026-11-22 用户定），存储 / 备份里残留的别的值在这里被盖掉
    return foldCut(chat, { ...state.memory, batch: MEMORY_BATCH_DEFAULT });
}

/** 压缩第 i 楼（一条回复）所在的这一轮，返回一句话 */
export async function summarizeTurn(i) {
    const msg = state.chat[i];
    const scripts = allScripts();
    const ctx = macroContext(state.chat, structuredClone(state.variables));
    // 先过一遍发送侧正则，把预设要求隐藏的东西（思考块之类）去掉再交给压缩模型
    const clean = m => runRegexScripts(m.content, scripts, {
        placement: placementOf(m), isPrompt: true, depth: 0, substitute: t => substitute(t, ctx),
    }).trim().slice(0, 8000);
    const reply = clean(msg);
    if (reply.length < 60) {
        // 本来就很短，不值得花一次调用。其中一种是「占位符」：原文只有几个字，显示时被正则换成一整张卡片
        // （比如开场白 【xxx的intro】 → 首页前端卡）。它没有剧情内容，记成 MEMORY_SKIP，不进记忆块。
        const shown = displayText(msg, i);
        if (!reply || (shown !== msg.content && shown.length > msg.content.length * 5)) return MEMORY_SKIP;
        return reply;
    }
    // 这一轮的输入：紧挨在前面的可见用户输入（跳过隐藏楼层，规则见 memory-fold.js 文件头「隐藏楼层」）
    const inputs = turnInputs(state.chat, i).map(j => clean(state.chat[j]));
    const body = (inputs.length ? `【${state.persona.name || 'User'} 的输入】\n${inputs.join('\n')}\n\n` : '')
        + `【${msg.name} 的回复】\n${reply}`;
    // 压缩用的「接口 + 模型」是「记忆」页选的（可以和聊天不是同一个接口）；claude-code 下 model '' = 默认模型，不传
    const ref = state.memory.modelRef ?? { endpoint: 'claude-code', model: 'haiku' };
    const len = summaryLenOf(state.memory);
    // 字数调大时 max_tokens 和截断上限跟着放宽（默认 60 字时仍是 200 / 200，和以前一样）
    const cap = Math.max(200, len * 3);
    const out = await complete(memorySystem(len), body, { endpoint: ref.endpoint, model: ref.model || undefined, params: { max_tokens: cap, temperature: 0.3 } });
    // 取第一行；万一模型还是先说了句「以下是摘要：」这样的引子，就跳过它
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const line = (lines.find(s => !/[:：]$/.test(s)) ?? lines[0] ?? '')
        .replace(/^(?:[-*•]|\d+[.、)])\s*/, '').replace(/^["“「]|["”」]$/g, '').slice(0, cap);
    if (!line) throw new Error('压缩模型返回了空内容');
    return line;
}

export const memoryWork = { running: false };

// ───────────── 压缩用的模型「现在能不能用」（只有网页版会拦；本地版照旧，失败就记失败） ─────────────
// 网页版里压缩用的引用默认指向 claude-code（网页版没有它）、或指向被删的接口、或没填模型名：这些都是「还没选好」，
// 不是「压缩失败」——所以不发请求、不往消息上记 memoryError，「记忆」页给一条提示，各轮显示「待压缩」。
// 判断依赖两件异步的事：后端种类（backendKind）和接口列表（启动时才读回来）。这两样没出结果前一律「等」，
// 绝不在这段时间里下结论（否则会把用户的接口误判成已删除，或者白白发一次必败的请求）。
let webMode = null;        // null = 后端还没判定；true = 网页版（direct）；false = 本地版
let retryWanted = false;   // 因为「还在等」而放弃过一次：条件满足后补跑一次
let paintHint = null;      // 「记忆」页当前挂着的提示更新函数（不重画整页，免得打断模型选择器的浮层）
backendKind().then(k => { webMode = k === 'direct'; settle(); }, () => { webMode = false; settle(); });
onEndpointsChange(() => settle());

/** 后端 / 接口列表有了新结果：补画提示；之前因为在等而放弃的压缩，现在补上 */
function settle() {
    paintHint?.();
    if (retryWanted && memoryRefStatus().state !== 'wait') { retryWanted = false; ensureMemories(); }
}

/** @returns {{state: 'ok'|'wait'|'no', reason?: string}} */
export function memoryRefStatus() {
    if (webMode === null || (webMode && endpointsLoading())) return { state: 'wait' };
    if (!webMode) return { state: 'ok' };
    const ref = state.memory.modelRef ?? { endpoint: 'claude-code', model: 'haiku' };
    const ep = endpointById(ref.endpoint);
    if (!ep) return { state: 'no', reason: refUnpicked(ref) ? '还没选摘要模型' : '摘要模型用的接口已被删除' };
    if (!ep.ready) return { state: 'no', reason: `摘要模型用的接口「${ep.name}」还没配置好` };
    if (!ref.model) return { state: 'no', reason: '还没选摘要模型' };
    return { state: 'ok' };
}

// 旧版本在「接口没配好」时给每一轮记过的失败原因（含旧的带命令行接口名字的文字）。这类不是真的压缩失败，
// 网页版里不显示、模型可用后自动清掉重试。不做存储迁移：读取 / 显示的地方认出来就处理，旧字段随下一次正常保存更新。
const STALE_CONFIG_ERR = /Claude Code|claude 可执行|Codex|还没选聊天用的接口|还没选接口|找不到这个接口|还没配置好|没有选择模型/;
// 带「上游」二字的是接口真的回了报错（「上游返回 HTTP…」「上游报错…」「读取上游响应失败…」），原文是对方写的，
// 里面可能恰好有 Claude Code / Codex 字样（比如转卖订阅的中转）。这种是真失败：照常显示，不自动清掉重试，免得每轮都白花一次额度。
const staleErr = msg => webMode === true && typeof msg.memoryError === 'string'
    && !msg.memoryError.includes('上游') && STALE_CONFIG_ERR.test(msg.memoryError);

/** 后台把还没有摘要的回复逐条压缩。失败的会记下原因并跳过，不自动重试（免得反复烧额度）。 */
export async function ensureMemories() {
    if (!state.memory?.enabled || memoryWork.running) return;
    // 压缩用的引用还指向内置接口、而列表里没有它（网页版：默认值是 Claude Code，网页版没有）→ 等于还没选接口：
    // 不发请求，也不给每一轮记一条「失败」；「记忆」页的选择器上会标出「还没选接口」，选好后点「补全 / 重试」或等下一轮回复
    if (refUnpicked(state.memory.modelRef ?? { endpoint: 'claude-code' })) return;
    const status = memoryRefStatus();
    if (status.state === 'wait') { retryWanted = true; return; }   // 后端 / 列表还没出结果：出了结果会补跑（settle）
    if (status.state === 'no') return;                              // 没选好：不发请求，等用户选完（选择器的 onChange 会触发）
    // 模型可用了：之前因为「没配好」记下的旧错误清掉，让它们和别的待压缩轮次一起重试
    const stale = state.chat.filter(m => m.role === 'assistant' && !m.memory && staleErr(m));
    if (stale.length) { for (const m of stale) delete m.memoryError; save(); renderMemoryIfActive(); }
    memoryWork.running = true;
    try {
        for (;;) {
            const i = state.chat.findIndex((m, k) => m.role === 'assistant' && !m.memory && !m.memoryError
                && !isHidden(m)                                   // 隐藏的回复不发给模型，也不压（取消隐藏后再压）
                && !(ui.busy && k === state.chat.length - 1));   // 正在流式输出的那条先不碰
            if (i < 0) break;
            const msg = state.chat[i];
            const snapshot = msg.content;
            // 这一轮输入的快照：压缩期间隐藏 / 取消隐藏 / 编辑了它的输入，结果就和「会发给模型的内容」对不上了，丢掉重压
            // （按传进来的聊天数组算：切走之后要拿别的数组——重新读出来的 state.chat、存储里的记录——来比）
            const inputsIn = (chat, k) => JSON.stringify(turnInputs(chat, k).map(j => chat[j].content));
            const inputsOf = k => inputsIn(state.chat, k);
            const inputsSnap = inputsOf(i);
            const epoch = persist.epoch;   // 压缩要等好几秒，期间可能切到别的存档
            ui.memoryPending = msg;
            renderMemoryIfActive();
            /** 把结果写到一条消息上：原文在压缩期间被改过（或已经有了摘要）就作废，下一圈重来 */
            let apply;
            try {
                const line = await summarizeTurn(i);
                // 压缩期间这一楼被隐藏了也作废：隐藏的回复不压（隐藏 / 取消隐藏改了这一轮的取材，旧结果对不上）
                apply = m => { if (m.content !== snapshot || m.memory || isHidden(m)) return false; m.memory = line; delete m.memoryError; return true; };
            } catch (e) {
                // 压缩期间用户把接口删了 / 清了模型：这不是这一轮的错，别记失败，停下（选好后会再触发）
                if (memoryRefStatus().state === 'no') { ui.memoryPending = null; renderMemoryIfActive(); break; }
                const err = String(e.message ?? e).slice(0, 300);
                apply = m => { if (m.content !== snapshot || m.memory || isHidden(m)) return false; m.memoryError = err; return true; };
            }
            ui.memoryPending = null;
            if (persist.epoch !== epoch) {
                // 已经切走了：msg 是旧存档里的对象，改它不会被保存。按「那时的卡 / 存档 + 楼层号 + 原文 + 这一轮的输入」写回原来的存档，
                // 然后停下这一轮（新存档的压缩等它自己的下一次回复再触发）。输入和当前存档那条路一样要核对：
                // 切走前（或在别的标签页里）改了 / 隐藏了这一轮的输入，结果就和这一轮现在的样子对不上了，不写
                const { cardId, chatId } = idsOfEpoch(epoch);
                const fits = chat => Array.isArray(chat) && chat[i] && inputsIn(chat, i) === inputsSnap;
                if (cardId && chatId && cardId === persist.cardId && chatId === persist.chatId) {
                    // 又切回来了：state.chat 是重新读出来的新对象
                    if (fits(state.chat) && apply(state.chat[i])) save();
                } else if (cardId && chatId) {
                    // 存档要是已经被删了，patchStoredChat 什么都不写（不会把它复活）
                    await patchStoredChat(cardId, chatId, rec => (fits(rec.messages) ? apply(rec.messages[i]) : false)).catch(e => console.error('补写记忆失败', e));
                }
                renderMemoryIfActive();
                break;
            }
            const k = state.chat.indexOf(msg);
            if (k >= 0 && inputsOf(k) === inputsSnap) apply(msg);   // 对不上就不写，下一圈按现在的输入重压
            save();
            if (!ui.busy && !ui.previewIsSent) refreshPreview();
            renderMemoryIfActive();
        }
    } finally {
        memoryWork.running = false;
        ui.memoryPending = null;
    }
}

export function renderMemoryIfActive() {
    if ($('#tabs button.active')?.dataset.tab === 'memory') renderMemoryTab();
}

export function renderMemoryTab() {
    const tab = $('#tab-memory');
    const m = state.memory;
    const { cut } = foldChat(state.chat);
    const turns = state.chat.map((msg, i) => ({ msg, i })).filter(x => x.msg.role === 'assistant');
    // 隐藏的回复不压缩、不进记忆块，不算在「已压缩 / 总数」里（表格里照样列出来，标「已隐藏」，摘要留着可以看、可以改）
    const counted = turns.filter(x => !isHidden(x.msg));
    const done = counted.filter(x => x.msg.memory).length;
    const changed = () => { save(); ui.previewIsSent = false; refreshPreview(); renderMemoryTab(); };

    // 压缩用的模型还不能用（只有网页版会有）：开关旁一个小徽章 + 设置区下面一条提示。不重画整页，只切显示（见 paintHint）
    const enabledBadge = h('span', { class: 'badge bad', id: 'mem-unusable-badge', hidden: true, title: '外置记忆开着，但摘要模型还没选好，现在不会压缩' }, '开着，但还不能用');
    const unusableNote = h('div', { class: 'log-line warn', id: 'mem-unusable', hidden: true, style: 'margin-bottom:8px' });
    paintHint = () => {
        if (!enabledBadge.isConnected) { paintHint = null; return; }   // 这一页已经被别的内容换掉了
        const s = memoryRefStatus();
        const bad = m.enabled && s.state === 'no';
        enabledBadge.hidden = unusableNote.hidden = !bad;
        if (bad) unusableNote.textContent = `${s.reason}：在上面选一个接口和模型，之后的回复才会被压成摘要；已有的回复会在选好后自动补压。`;
    };
    queueMicrotask(() => paintHint?.());   // 节点还没挂上页面，下一拍再画
    // 带边框的框：框头是开关，框里是全部设置和操作；关着就折叠（只剩框头）。摘要列表在框外
    const box = h('div', { class: 'mem-box' + (m.enabled ? ' on' : ''), id: 'mem-box' },
        h('div', { class: 'mem-box-head' },
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 'mem-enabled', checked: m.enabled, onchange: e => { m.enabled = e.target.checked; changed(); if (m.enabled) ensureMemories(); } }), '启用外置记忆'),
            enabledBadge),
        h('div', { class: 'mem-box-body', id: 'mem-box-body', hidden: !m.enabled },
            h('div', { class: 'summary' },
                h('label', { class: 'inline' }, '摘要模型',
                    (() => {
                        const pk = h('span', { class: 'model-picker' });
                        // 选好之后：补提示，并触发一次补压（之前「待压缩」的轮次）。不重画整页：onChange 之后选择器还要自己打开模型面板
                        renderModelPicker(pk, { value: m.modelRef ?? { endpoint: 'claude-code', model: 'haiku' }, onChange: ref => { m.modelRef = ref; save(); paintHint?.(); if (webMode === true) ensureMemories(); } });   // 本地版行为不变：选完不自动补压
                        return pk;
                    })(),
                    h('span', { class: 'dim' }, '推荐便宜模型')),
                h('label', { class: 'inline', title: '最近这么多条照发原文，更早的换成摘要' }, '保留最近',
                    h('input', { type: 'number', min: 0, value: m.keep, style: 'width:4.5em', onchange: e => { m.keep = Math.max(0, Number(e.target.value) || 0); changed(); } }), '条原文'),
                // 每条摘要的目标字数（写进压缩提示词，memory-fold.js summaryLenOf）。默认 60 时不写字段；只影响之后压的，已有摘要不作废
                h('label', { class: 'inline', title: '每条摘要的目标字数。留空 = 默认 ' + MEMORY_SUMMARY_LEN_DEFAULT + '。只影响之后压的摘要，已有的不会重压' }, '摘要字数',
                    h('input', { type: 'number', id: 'mem-summary-len', min: 1, max: MEMORY_SUMMARY_LEN_MAX, step: 1, placeholder: String(MEMORY_SUMMARY_LEN_DEFAULT),
                        value: m.summaryLen !== undefined && summaryLenOf(m) !== MEMORY_SUMMARY_LEN_DEFAULT ? summaryLenOf(m) : '', style: 'width:5em',
                        onchange: e => {
                            const raw = e.target.value.trim();
                            const n = Number(raw);
                            if (!raw || !Number.isInteger(n) || n < 1 || n === MEMORY_SUMMARY_LEN_DEFAULT) delete m.summaryLen;
                            else m.summaryLen = Math.min(n, MEMORY_SUMMARY_LEN_MAX);
                            save(); renderMemoryTab();   // 不走 changed()：它会刷新拼装预览，而字数不影响发给聊天模型的内容
                        } })),
                h('span', { class: 'spacer' }),
                h('button', { title: '压缩还没有摘要的轮次，并重试失败的', onclick: () => { for (const x of turns) delete x.msg.memoryError; ensureMemories(); renderMemoryTab(); } }, '补全 / 重试')),
            unusableNote));
    const kids = [
        box,
        m.enabled ? null : h('div', { class: 'dim', style: 'margin-bottom:8px' }, '已关闭：所有楼层照发原文，回复后也不再压缩。已有的摘要会留着。'),
    ].filter(Boolean);
    if (!turns.length) {
        kids.push(h('div', { class: 'empty' }, '还没有回复。每次回复结束后，会在后台把这一轮压成一句话。'));
        return void tab.replaceChildren(...kids);
    }
    const rows = turns.map(({ msg, i }) => {
        const pending = ui.memoryPending === msg;
        const input = h('input', { class: 'mem', value: msg.memory ?? '', placeholder: pending ? '压缩中…' : '（还没有摘要，可以直接手写）',
            title: msg.memory === MEMORY_SKIP ? '「-」表示这一轮没有值得记的内容，不会进记忆块' : '写成「-」可以让这一轮不进记忆块',
            onchange: e => { const v = e.target.value.trim(); if (v) { msg.memory = v; delete msg.memoryError; } else delete msg.memory; changed(); } });
        const status = pending ? h('span', { class: 'badge' }, '压缩中…')
            : isHidden(msg) ? h('span', { class: 'badge', 'data-fk': 'mem-hidden', title: '这一楼已隐藏：不发给模型，不压缩，摘要（如果有）不进记忆块。取消隐藏后摘要直接恢复使用' }, '已隐藏')
            : msg.memoryError && !staleErr(msg) ? h('span', { class: 'badge bad', title: msg.memoryError }, '失败')   // 旧的「接口没配好」错误当作待压缩
                : !msg.memory ? h('span', { class: 'badge' }, '待压缩')
                    : i < cut ? h('span', { class: 'badge on' }, '已折叠') : h('span', { class: 'badge' }, '原文发送');
        return h('tr', { class: i < cut && !isHidden(msg) ? 'hit' : isHidden(msg) ? 'mem-hidden-row' : '' },
            h('td', { class: 'dim mono' }, `#${i}`),
            h('td', null, status),
            h('td', { style: 'width:100%' }, input, msg.memoryError && !staleErr(msg) ? h('div', { class: 'log-line error' }, msg.memoryError) : null),
            h('td', { class: 'dim' }, `${msg.content.length}→${(msg.memory ?? '').length}`),
            h('td', null, h('button', { class: 'ghost', title: isHidden(msg) ? '隐藏的楼不压缩，取消隐藏后才能重压' : '重新压缩这一轮', disabled: pending || isHidden(msg),
                onclick: () => { delete msg.memory; delete msg.memoryError; changed(); ensureMemories(); } }, '↻')),
        );
    });
    kids.push(h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['楼', '状态','这一轮的摘要（可直接改）', '原文→摘要', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows)));
    tab.replaceChildren(...kids);
}
