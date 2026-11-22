// 外置记忆：把较早的楼层折叠成每轮一行的摘要（foldChat / summarizeTurn / ensureMemories）及「记忆」页。

import { substitute } from '../macros.js';
import { foldCut, memorySystem, MEMORY_SKIP, MEMORY_BATCH_DEFAULT, MEMORY_SUMMARY_LEN_DEFAULT, MEMORY_SUMMARY_LEN_MAX, summaryLenOf, turnInputs, isHidden,
    turnFullyHidden, turnPending, mergeEveryOf, MERGE_EVERY_MIN, MERGE_EVERY_MAX, mergeLenOf, mergeSystem, mergeBody, mergedSegments, segmentStart, coveredByMerge,
    normalizeMerged, commitMerged, nextMergeGroup, mergeGroups, mergeFingerprint, applyMerge, dissolveMerged } from '../memory-fold.js';
import { createMemoryQueue, MEMORY_REQUEST_GAP_MS, MEMORY_MAX_FAILS } from '../memory-queue.js';
import { runRegexScripts } from '../regex.js';
import { complete, backendKind } from '../llm.js';
import { $, h } from './dom.js';
import { state, ui, save, persist, idsOfEpoch, patchStoredChat } from './state.js';
import { renderModelPicker, refUnpicked, endpointById, endpointsLoading, onEndpointsChange } from './model-picker.js';
import { allScripts, macroContext, placementOf, displayText, refreshPreview } from './pipeline.js';
import { restoreActive } from './backup.js';   // 循环依赖（backup.js 经 archive.js 间接导入本文件）：只在函数体里调用

// ───────────────────────────── 外置记忆 ─────────────────────────────
// 思路：模型每次只看得到 prompt 里的东西，聊天越长 prompt 越大。这里在模型之外维护一份「记忆」：
// 每轮结束后用一个便宜的模型把这一轮压成一句话，存在那条回复上（msg.memory）；
// 之后拼 prompt 时，老楼层不发原文，只发这些一句话摘要。

// 压缩提示词 memorySystem / MEMORY_SYSTEM 在 memory-fold.js（纯函数，单元测试直接测）
export { memorySystem, MEMORY_SYSTEM } from '../memory-fold.js';

// 「折到哪」和「哪一轮的摘要作废」的规则是纯函数，在 src/memory-fold.js（含 MEMORY_SKIP、批大小的默认值）
export { MEMORY_SKIP } from '../memory-fold.js';

// 记忆块的拼法 memoryBlock 也在 memory-fold.js（合并段那一行的说明要和单元测试共用）
export { memoryBlock } from '../memory-fold.js';

/** 运行时用的记忆设置：batch 固定 10（界面已隐藏这项设置，2026-11-22 用户定），存储 / 备份里残留的别的值在这里被盖掉 */
const foldMem = () => ({ ...state.memory, batch: MEMORY_BATCH_DEFAULT });

/**
 * 决定哪些楼层折叠成记忆（按当前的记忆设置）。返回 cut：chat[0..cut) 不发原文；rows：对应的摘要行（合并段占一行）。
 * 规则见 memory-fold.js foldCut：保留最近 keep 楼、折叠段里每条回复都已有摘要、切点对齐到 batch 的整数倍、停在一轮结束处。
 */
export function foldChat(chat) {
    return foldCut(chat, foldMem());
}

/**
 * 把若干行摘要合并成一段（记忆再压缩，规则见 memory-fold.js 文件头「合并段」）。
 * 和 summarizeTurn 同一个摘要模型、同一种调用（本地版的命令行接口也一样走 complete）。
 * max_tokens 按合并段的字数放宽（默认 240 字 → 720），所以和逐轮压缩的请求（默认 200）分得开
 */
export async function mergeRows(texts) {
    const ref = state.memory.modelRef ?? { endpoint: 'claude-code', model: 'haiku' };
    const len = mergeLenOf(state.memory);
    const cap = Math.max(600, len * 3);
    const out = await complete(mergeSystem(len), mergeBody(texts), { endpoint: ref.endpoint, model: ref.model || undefined, params: { max_tokens: cap, temperature: 0.3 } });
    // 合成一段：去掉可能的引子（「以下是合并后的摘要：」）、开头的序号 / 引号，多行接成一行
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const text = (lines.length > 1 && /[:：]$/.test(lines[0]) ? lines.slice(1) : lines).join('')
        .replace(/^(?:[-*•]|\d+[.、)])\s*/, '').replace(/^["“「]|["”」]$/g, '').slice(0, cap);
    if (!text) throw new Error('压缩模型返回了空内容');
    return text;
}

/** 合并失败的原因（只在这次打开页面期间记着，不存盘）：有值时不再自动合并，等用户点「补全 / 重试」，免得每轮都白花一次额度 */
export const mergeWork = { error: null };

/** 压缩前先过一遍发送侧正则，把预设要求隐藏的东西（思考块之类）去掉再交给压缩模型 */
function turnCleaner() {
    const scripts = allScripts();
    const ctx = macroContext(state.chat, structuredClone(state.variables));
    return m => runRegexScripts(m.content, scripts, {
        placement: placementOf(m), isPrompt: true, depth: 0, substitute: t => substitute(t, ctx),
    }).trim().slice(0, 8000);
}

/** 回复不到这么多字就不发请求，直接拿原文当摘要 */
const SHORT_REPLY = 60;

/** 压缩第 i 楼这一轮要不要真的发请求（队列据此决定要不要等间隔）。和 summarizeTurn 的判断一致 */
function turnSends(i) {
    try { return turnCleaner()(state.chat[i]).length >= SHORT_REPLY; } catch { return true; }
}

/** 压缩第 i 楼（一条回复）所在的这一轮，返回一句话 */
export async function summarizeTurn(i) {
    return (await summarizeTurnInfo(i)).line;
}

/** 同 summarizeTurn，另外告诉调用方有没有真的发请求（sent） */
async function summarizeTurnInfo(i) {
    const msg = state.chat[i];
    const clean = turnCleaner();
    const reply = clean(msg);
    if (reply.length < SHORT_REPLY) {
        // 本来就很短，不值得花一次调用。其中一种是「占位符」：原文只有几个字，显示时被正则换成一整张卡片
        // （比如开场白 【xxx的intro】 → 首页前端卡）。它没有剧情内容，记成 MEMORY_SKIP，不进记忆块。
        const shown = displayText(msg, i);
        if (!reply || (shown !== msg.content && shown.length > msg.content.length * 5)) return { line: MEMORY_SKIP, sent: false };
        return { line: reply, sent: false };
    }
    // 这一轮的输入：紧挨在前面的那串用户输入。隐藏的也算（隐藏只管原文发不发，规则见 memory-fold.js 文件头「隐藏楼层」）
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
    return { line, sent: true };
}

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

// ───────────── 请求队列（规矩见 src/memory-queue.js 文件头） ─────────────
// 逐轮压缩和合并都走同一个队列：一次只发一个，前一个结束后隔 2 秒再发下一个；连续失败 3 次整体停下，点「补全 / 重试」再继续。

/** 队列的可调参数。测试里改小 gapMs（页面里 (await import('/src/ui/memory.js')).memoryTuning.gapMs = 50），不然浏览器测试要等很久 */
export const memoryTuning = { gapMs: MEMORY_REQUEST_GAP_MS, maxFails: MEMORY_MAX_FAILS };
export { MEMORY_REQUEST_GAP_MS, MEMORY_MAX_FAILS } from '../memory-queue.js';

let runEpoch = -1;        // 这次运行开始时的存档 epoch：切走了就停（新存档的压缩等它自己的下一次触发）
let lastMerge = null;     // 上一件做完的活是合并、并且写进去了：{objs: 成员的消息对象, fp: 指纹}。防同一组反复被挑中（见 nextJob）
let paintQueue = null;    // 「记忆」页当前挂着的队列状态行的更新函数

const queue = createMemoryQueue({
    begin: () => { runEpoch = persist.epoch; if (canWrite()) tidyMerged(); },
    end: () => { if (persist.epoch === runEpoch && state.memory?.enabled && canWrite()) tidyMerged(); ui.memoryPending = null; },
    allowed: queueAllowed,
    jobFor: msg => { const i = state.chat.indexOf(msg); return i >= 0 && pendingAt(i) ? turnJob(i) : null; },
    nextJob,
    exec: job => (job.kind === 'turn' ? summarizeOne(job) : mergeOne(job)),
    gapMs: () => memoryTuning.gapMs,
    maxFails: () => memoryTuning.maxFails,
    onChange: () => paintQueue?.(),
});

/** 兼容旧名字：浏览器测试用 memoryWork.running 等「压缩做完」。running = 队列在跑（含等间隔）；queue 是队列本身的状态 */
export const memoryWork = {
    get running() { return queue.state.running; },
    get queue() { return queue.state; },
    idle: () => queue.idle(),
};

/** 这个标签页现在能不能写（只读、停止保存、恢复备份中都不行：结果反正存不下来，就不发请求） */
const canWrite = () => !persist.readOnly && !persist.stopped && !restoreActive();

/** 第 i 楼是不是一条要压缩的回复（memory-fold.js turnPending；正在流式输出的最后一楼先不碰） */
const pendingAt = i => turnPending(state.chat, i) && !(ui.busy && i === state.chat.length - 1);

const turnJob = i => ({ kind: 'turn', key: state.chat[i], msg: state.chat[i], sends: turnSends(i) });

/** 队列每挑一件活之前问：还能不能接着发 */
function queueAllowed() {
    if (!state.memory?.enabled || !canWrite() || persist.epoch !== runEpoch) return false;
    // 压缩用的引用还指向内置接口、而列表里没有它（网页版：默认值是 Claude Code，网页版没有）→ 等于还没选接口：不发请求、不记失败
    if (refUnpicked(state.memory.modelRef ?? { endpoint: 'claude-code' })) return false;
    const status = memoryRefStatus();
    if (status.state === 'wait') { retryWanted = true; return false; }   // 后端 / 列表还没出结果：出了结果会补跑（settle）
    return status.state === 'ok';                                        // 'no'：没选好，等用户选完（选择器的 onChange 会触发）
}

/** 下一件活：先把还没有摘要的轮逐条压完（从最老的开始），都压好了再看要不要合并 */
function nextJob() {
    const i = state.chat.findIndex((_, k) => pendingAt(k));
    if (i >= 0) return turnJob(i);
    if (mergeWork.error) return null;
    const group = nextMergeGroup(state.chat, foldMem(), mergeEveryOf(state.memory));
    if (!group) return null;
    // 防御（复核提的）：上一件活就是合并这同一组、而且写进去了，这一组却又被挑中——说明写下的段没能被读出来（mergedSegments 不认它）。
    // 有了队列也只是每 2 秒一个，但这种请求永远白发：停下合并、记日志，等用户点「补全 / 重试」
    if (lastMerge && lastMerge.objs.length === group.length && group.every((k, n) => state.chat[k] === lastMerge.objs[n])
        && mergeFingerprint(state.chat, group) === lastMerge.fp) {
        console.error('外置记忆：同一组合并连续被选中两次（上一次写下的段没能被读出来），已停下合并', group);
        mergeWork.error = '合并结果写下后没能读出来，已停下（详情见浏览器控制台）';
        lastMerge = null;
        renderMemoryIfActive();
        return null;
    }
    return { kind: 'merge', key: 'merge:' + group.join(','), members: group, sends: true };
}

/**
 * 有要压的就开始（已经在跑就让它结束后再看一眼）。各处在「可能多了要压的东西」时调：回复写完、换候选、编辑、开开关、选好模型……
 * 连续失败停下之后不会自己继续，要点「补全 / 重试」（resumeMemories）。
 */
export function ensureMemories() {
    if (!state.memory?.enabled || !canWrite()) return Promise.resolve();
    // 模型可用了：之前因为「没配好」记下的旧错误清掉，让它们和别的待压缩轮次一起重试
    if (memoryRefStatus().state === 'ok') {
        const stale = state.chat.filter(m => m.role === 'assistant' && !m.memory && staleErr(m));
        if (stale.length) { for (const m of stale) delete m.memoryError; save(); renderMemoryIfActive(); }
    }
    return queue.kick();
}

/** 「补全 / 重试」：清掉失败记录和停下的状态，接着来 */
export function resumeMemories() {
    if (!canWrite()) return Promise.resolve();
    for (const m of state.chat) if (m.role === 'assistant') delete m.memoryError;
    mergeWork.error = null;
    lastMerge = null;
    save();
    return queue.resume();
}

/** 「记忆」页某一行的「重压」：这一条排到最前 */
function redoFirst(msg) {
    lastMerge = null;
    if (!canWrite()) return Promise.resolve();
    const run = queue.prioritize(msg);
    return queue.state.halted ? queue.resume() : run;   // 连续失败停下了：用户手动点了，就接着来（这一条在最前）
}

/** 队列状态行的数字：待压缩几轮、待合并几组（照现在的样子数） */
export function memoryQueueCounts() {
    let turns = 0;
    for (let i = 0; i < state.chat.length; i++) {
        const m = state.chat[i];
        // 旧的「接口没配好」错误（staleErr）在列表里也显示成「待压缩」，这里一起数
        if (pendingAt(i) || (m.role === 'assistant' && staleErr(m) && !m.memory && !coveredByMerge(m) && !turnFullyHidden(state.chat, i))) turns++;
    }
    const merges = mergeWork.error ? 0 : mergeGroups(state.chat, foldMem(), mergeEveryOf(state.memory)).length;
    return { turns, merges };
}

/** 合并段的兜底和收尾：坏段 / 孤儿标记清掉（normalizeMerged），已经用上的段换上（commitMerged，不改发出去的内容） */
function tidyMerged() {
    const bad = normalizeMerged(state.chat);
    const n = state.memory?.enabled ? commitMerged(state.chat, foldMem()) : 0;
    if (!bad && !n) return;
    save();
    if (bad && !ui.busy && !ui.previewIsSent) refreshPreview();
    renderMemoryIfActive();
}

/**
 * 合并一组（job.members = 楼层号，旧 → 新）。和 summarizeOne 一样核对迟到的结果：成员的原文、输入、摘要行、范围里的回复
 * 任何一样变了（mergeFingerprint），或者其中有楼已经进了别的段，就不写；切走存档后按「那时的卡 / 存档」写回存储（同样先核对）。
 * @returns {Promise<{sent: boolean, outcome: 'ok'|'fail'|'stop', error?: string}>}
 */
async function mergeOne({ members }) {
    lastMerge = null;
    const snap = mergeFingerprint(state.chat, members);
    const objs = members.map(k => state.chat[k]);
    const texts = members.map(k => state.chat[k].memory).filter(t => t !== MEMORY_SKIP);
    const epoch = persist.epoch;
    let text;
    try {
        text = await mergeRows(texts);
    } catch (e) {
        // 压缩期间用户把接口删了 / 清了模型：不算合并失败，停下（选好后会再触发）
        if (memoryRefStatus().state === 'no') { renderMemoryIfActive(); return { sent: true, outcome: 'stop' }; }
        mergeWork.error = String(e.message ?? e).slice(0, 300);
        renderMemoryIfActive();
        return { sent: true, outcome: 'fail', error: mergeWork.error };
    }
    if (!mergeEveryOf(state.memory) || !state.memory.enabled) { renderMemoryIfActive(); return { sent: true, outcome: 'stop' }; }   // 等结果期间关掉了：不写
    const taken = chat => mergedSegments(chat).segs.some(s => s.members.some(k => members.includes(k)));
    const write = chat => {
        if (!Array.isArray(chat) || mergeFingerprint(chat, members) !== snap || taken(chat)) return false;
        applyMerge(chat, members, text, foldMem());
        return true;
    };
    if (persist.epoch !== epoch) {
        const { cardId, chatId } = idsOfEpoch(epoch);
        if (cardId && chatId && cardId === persist.cardId && chatId === persist.chatId) {
            if (write(state.chat)) save();
        } else if (cardId && chatId) {
            await patchStoredChat(cardId, chatId, rec => write(rec.messages)).catch(e => console.error('补写合并段失败', e));
        }
        renderMemoryIfActive();
        return { sent: true, outcome: 'ok' };   // 队列下一圈问 allowed() 时发现换了存档，自己停下
    }
    if (write(state.chat)) {
        save();
        // 写下的段要能马上读出来（读不出来 = 这一组下一圈还会被挑中，见 nextJob 的防御）
        if (!mergedSegments(state.chat).segs.some(s => s.anchor === members.at(-1) && s.members.length === members.length)) {
            console.error('外置记忆：合并段写下后读不出来', members, state.chat[members.at(-1)]?.memoryMerged);
        }
        lastMerge = { objs, fp: mergeFingerprint(state.chat, members) };
    }
    // 对不上就不写：下一圈按现在的样子重新挑一组
    renderMemoryIfActive();
    return { sent: true, outcome: 'ok' };
}

/**
 * 压缩一轮（job.msg 是这一轮的回复），写回（含迟到结果的核对）。
 * @returns {Promise<{sent: boolean, outcome: 'ok'|'fail'|'stop', error?: string}>}  stop = 接口没选好（不算失败）
 */
async function summarizeOne({ msg }) {
    lastMerge = null;
    const i = state.chat.indexOf(msg);
    if (i < 0 || !pendingAt(i)) return { sent: false, outcome: 'ok' };
    const snapshot = msg.content;
    // 这一轮输入的快照：压缩期间编辑了它的输入，结果就和这一轮现在的原文对不上了，丢掉重压
    // （按传进来的聊天数组算：切走之后要拿别的数组——重新读出来的 state.chat、存储里的记录——来比）
    const inputsIn = (chat, k) => JSON.stringify(turnInputs(chat, k).map(j => chat[j].content));
    const inputsOf = k => inputsIn(state.chat, k);
    const inputsSnap = inputsOf(i);
    const epoch = persist.epoch;   // 压缩要等好几秒，期间可能切到别的存档
    ui.memoryPending = msg;
    renderMemoryIfActive();
    /** 把结果写到一条消息上：原文在压缩期间被改过（或已经有了摘要）就作废，下一圈重来。隐藏标记不管（隐藏不碰记忆） */
    let apply, sent, outcome = 'ok', error;
    try {
        const r = await summarizeTurnInfo(i);
        sent = r.sent;
        apply = m => { if (m.content !== snapshot || m.memory || coveredByMerge(m)) return false; m.memory = r.line; delete m.memoryError; return true; };
    } catch (e) {
        sent = true;
        // 压缩期间用户把接口删了 / 清了模型：这不是这一轮的错，别记失败，停下（选好后会再触发）
        if (memoryRefStatus().state === 'no') { ui.memoryPending = null; renderMemoryIfActive(); return { sent, outcome: 'stop' }; }
        error = String(e.message ?? e).slice(0, 300);
        outcome = 'fail';
        apply = m => { if (m.content !== snapshot || m.memory || coveredByMerge(m)) return false; m.memoryError = error; return true; };
    }
    ui.memoryPending = null;
    if (persist.epoch !== epoch) {
        // 已经切走了：msg 是旧存档里的对象，改它不会被保存。按「那时的卡 / 存档 + 楼层号 + 原文 + 这一轮的输入」写回原来的存档
        // （队列下一圈发现换了存档就停下，新存档的压缩等它自己的下一次触发）。输入和当前存档那条路一样要核对：
        // 切走前（或在别的标签页里）改了这一轮的输入，结果就和这一轮现在的样子对不上了，不写
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
        return { sent, outcome, error };
    }
    const k = state.chat.indexOf(msg);
    if (k >= 0 && inputsOf(k) === inputsSnap) apply(msg);   // 对不上就不写，下一圈按现在的输入重压
    save();
    if (!ui.busy && !ui.previewIsSent) refreshPreview();
    renderMemoryIfActive();
    return { sent, outcome, error };
}

export function renderMemoryIfActive() {
    if ($('#tabs button.active')?.dataset.tab === 'memory') renderMemoryTab();
}

export function renderMemoryTab() {
    const tab = $('#tab-memory');
    const m = state.memory;
    const { cut } = foldChat(state.chat);
    const turns = state.chat.map((msg, i) => ({ msg, i })).filter(x => x.msg.role === 'assistant');
    const changed = () => { save(); ui.previewIsSent = false; refreshPreview(); renderMemoryTab(); };
    // 只读标签页 / 已停止保存：会触发压缩 / 合并请求的控件禁用（结果反正存不下来）
    const locked = persist.readOnly || persist.stopped;
    const lockedTitle = '这个标签页是只读的（见页面顶上的说明）';

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
    // 队列状态（src/memory-queue.js）：一行短字「待压缩 37 · 待合并 2」，全做完就不显示；连续失败停下时另一行写原因。
    // 队列每做完一件活就更新（paintQueue），不重画整页
    const queueLine = h('div', { class: 'dim', 'data-fk': 'mem-queue', hidden: true, style: 'margin-top:6px' });
    // 平时不带 log-line error（页面上别处按这个类找「有没有红色错误行」），停下时才加上
    const haltedLine = h('div', { 'data-fk': 'mem-queue-halted', hidden: true });
    paintQueue = () => {
        if (!queueLine.isConnected) { paintQueue = null; return; }
        const { turns: nt, merges: nm } = memoryQueueCounts();
        const parts = [];
        if (nt) parts.push(`待压缩 ${nt}`);
        if (nm) parts.push(`待合并 ${nm}`);
        queueLine.textContent = parts.join(' · ');
        queueLine.hidden = !m.enabled || !parts.length;
        const halt = queue.state.halted;
        haltedLine.hidden = !m.enabled || !halt;
        haltedLine.className = haltedLine.hidden ? '' : 'log-line error';
        if (halt) haltedLine.textContent = `连续 ${halt.count} 次失败，已暂停${halt.reason ? '：' + halt.reason : ''}`;
    };
    queueMicrotask(() => { paintHint?.(); paintQueue?.(); });   // 节点还没挂上页面，下一拍再画
    // 带边框的框：框头是开关，框里是全部设置和操作；关着就折叠（只剩框头）。摘要列表在框外
    const box = h('div', { class: 'mem-box' + (m.enabled ? ' on' : ''), id: 'mem-box' },
        h('div', { class: 'mem-box-head' },
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 'mem-enabled', checked: m.enabled, disabled: locked, title: locked ? lockedTitle : null, onchange: e => { m.enabled = e.target.checked; changed(); if (m.enabled) ensureMemories(); } }), '启用外置记忆'),
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
                // 记忆再压缩（memory-fold.js 文件头「合并段」）：留空 / 0 = 不做，不写字段。改了不动已有的合并段，只影响之后的合并。
                // 不走 changed()：合并的结果要等下一批原文换成摘要时才换上，改设置这一刻发出去的内容不变
                h('label', { class: 'inline', title: `留空或 0 = 不做；最少 ${MERGE_EVERY_MIN}、最多 ${MERGE_EVERY_MAX}。已经合并的不受影响` }, '每',
                    h('input', { type: 'number', id: 'mem-merge-every', min: 0, max: MERGE_EVERY_MAX, step: 1, disabled: locked,
                        value: mergeEveryOf(m) || '', style: 'width:4.5em',
                        onchange: e => {
                            const raw = e.target.value.trim();
                            const n = Number(raw);
                            if (!raw || !Number.isInteger(n) || n < 1) delete m.mergeEvery;
                            else m.mergeEvery = Math.min(Math.max(n, MERGE_EVERY_MIN), MERGE_EVERY_MAX);
                            save(); renderMemoryTab(); ensureMemories();
                        } }),
                    '条记忆再次压缩'),
                h('span', { class: 'spacer' }),
                h('button', { 'data-fk': 'mem-retry', disabled: locked, title: locked ? lockedTitle : '压缩还没有摘要的轮次，并重试失败的', onclick: () => { resumeMemories(); renderMemoryTab(); } }, '补全 / 重试')),
            unusableNote,
            queueLine,
            haltedLine,
            mergeWork.error ? h('div', { class: 'log-line error', 'data-fk': 'mem-merge-error' }, `合并失败：${mergeWork.error}`) : null));
    const kids = [
        box,
        m.enabled ? null : h('div', { class: 'dim', style: 'margin-bottom:8px' }, '已关闭：所有楼层照发原文，回复后也不再压缩。已有的摘要会留着。'),
    ].filter(Boolean);
    if (!turns.length) {
        kids.push(h('div', { class: 'empty' }, '还没有回复。每次回复结束后，会在后台把这一轮压成一句话。'));
        return void tab.replaceChildren(...kids);
    }
    // 合并段（memory-fold.js 文件头「合并段」）：一段只占一行（排在它第一条成员的位置），被它覆盖的轮不再各占一行。
    // 待换上的段（成员的行还在、还照常按行发）也显示成一行「已合并」，提示里说明什么时候换上
    const segs = mergedSegments(state.chat).segs;
    const segOf = new Map();
    for (const s of segs) for (const k of s.members) segOf.set(k, s);
    const segRow = s => {
        const anchorMsg = state.chat[s.anchor];
        const redo = () => { const a = state.chat.indexOf(anchorMsg); if (a >= 0) dissolveMerged(state.chat, a); };
        const orig = s.members.reduce((n, k) => n + state.chat[k].content.length, 0);
        const input = h('input', { class: 'mem', value: s.text, 'data-fk': 'mem-merged-text',
            title: `这 ${s.members.length} 轮的摘要合并成的一段（可直接改；清空 = 作废这一段，回到逐轮压缩）`,
            onchange: e => {
                const v = e.target.value.trim();
                if (!anchorMsg.memoryMerged) return renderMemoryTab();
                if (v) anchorMsg.memoryMerged = { ...anchorMsg.memoryMerged, text: v };
                else { redo(); setTimeout(() => redoFirst(state.chat[s.members[0]]), 0); }
                changed();
            } });
        return h('tr', { class: s.pending ? '' : 'hit', 'data-fk': 'mem-merged-row' },
            h('td', { class: 'dim mono' }, `${segmentStart(state.chat, s)}–${s.anchor}`),
            h('td', null, h('span', { class: 'badge on', title: s.pending ? '已合并，下一批原文换成摘要时一起换上（免得多打断一次缓存）' : `${s.members.length} 轮的摘要已合并成这一段` }, '已合并')),
            h('td', { style: 'width:100%' }, input),
            h('td', { class: 'dim' }, `${orig}→${s.text.length}`),
            h('td', null, h('button', { class: 'ghost', 'data-fk': 'mem-merged-redo', title: locked ? lockedTitle : '重压：作废这一段，这几轮回到逐轮压缩', disabled: locked,
                onclick: () => { const first = state.chat[s.members[0]]; redo(); changed(); redoFirst(first); } }, '↻')));
    };
    const rows = turns.filter(({ i }) => !segOf.has(i) || segOf.get(i).members[0] === i).map(({ msg, i }) => {
        if (segOf.has(i)) return segRow(segOf.get(i));
        const pending = ui.memoryPending === msg;
        const input = h('input', { class: 'mem', value: msg.memory ?? '', placeholder: pending ? '压缩中…' : '（还没有摘要，可以直接手写）',
            title: msg.memory === MEMORY_SKIP ? '「-」表示这一轮没有值得记的内容，不会进记忆块' : '写成「-」可以让这一轮不进记忆块',
            onchange: e => { const v = e.target.value.trim(); if (v) { msg.memory = v; delete msg.memoryError; } else delete msg.memory; changed(); } });
        // 隐藏的楼照常列出它的摘要（隐藏不碰记忆，摘要照发，见 memory-fold.js 文件头「隐藏楼层」），另加一个小小的「已隐藏」。
        // 整轮隐藏、还没压过的：不压、不算待压缩，只显示「已隐藏」；隐藏的回复在切点之后不发原文，不显示「原文发送」
        const hid = isHidden(msg), wholeHidden = turnFullyHidden(state.chat, i);
        const status = pending ? h('span', { class: 'badge' }, '压缩中…')
            : msg.memoryError && !staleErr(msg) ? h('span', { class: 'badge bad', title: msg.memoryError }, '失败')   // 旧的「接口没配好」错误当作待压缩
                : !msg.memory ? (wholeHidden ? null : h('span', { class: 'badge' }, '待压缩'))
                    : i < cut ? h('span', { class: 'badge on' }, '已折叠') : hid ? null : h('span', { class: 'badge' }, '原文发送');
        return h('tr', { class: [i < cut ? 'hit' : '', hid ? 'mem-hidden-row' : ''].filter(Boolean).join(' ') },
            h('td', { class: 'dim mono' }, `#${i}`),
            h('td', null, status, hid ? h('span', { class: 'badge', 'data-fk': 'mem-hidden' }, '已隐藏') : null),
            h('td', { style: 'width:100%' }, input, msg.memoryError && !staleErr(msg) ? h('div', { class: 'log-line error' }, msg.memoryError) : null),
            h('td', { class: 'dim' }, `${msg.content.length}→${(msg.memory ?? '').length}`),
            h('td', null, h('button', { class: 'ghost', title: locked ? lockedTitle : wholeHidden ? '整轮都隐藏着：不压缩，取消隐藏后才能重压' : '重新压缩这一轮', disabled: pending || wholeHidden || locked,
                onclick: () => { delete msg.memory; delete msg.memoryError; changed(); redoFirst(msg); } }, '↻')),
        );
    });
    kids.push(h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['楼', '状态','这一轮的摘要（可直接改）', '原文→摘要', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows)));
    tab.replaceChildren(...kids);
}
