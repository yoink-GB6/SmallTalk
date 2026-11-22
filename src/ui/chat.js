// 聊天区：开新对话、渲染楼层、编辑 / 删除、发送、流式生成、重新生成、swipe（左右切换候选）、错误面板与忙碌状态。

import { substitute } from '../macros.js';
import { formatMessage, mountMessage, unmountMessage } from '../render.js';
import { generate, samplerParamsFromPreset } from '../llm.js';
import { $, h, toast } from './dom.js';
import { state, ui, card, save, preset, persist, STOPPED_TEXT } from './state.js';
import { macroContext, permanentRegex, displayText, computePrompt, displayDepth, hiddenSummary } from './pipeline.js';
import { ensureMemories, renderMemoryIfActive } from './memory.js';
import { invalidateTurnAt, turnReplyIndex, isHidden, setHidden } from '../memory-fold.js';
import { restoreActive } from './backup.js';   // 循环依赖（backup.js 经 archive.js 间接导入本文件）：只在函数体里调用
import { frameHostFor } from './frame-host.js';
import { readSwipes, swipeTarget, selectSwipe, appendSwipe, ensureSwipes, syncSwipeSlot } from '../chatfile.js';
import { renderAll } from './shell.js';
import { chatChanged } from './chat-search.js';

export function startChat(greetingIndex = 0) {
    const c = card();
    const greetings = [c.firstMes, ...c.alternateGreetings].filter(Boolean);
    state.chat = [];
    state.variables.local = {};
    ui.rendered.clear();
    const first = greetings[greetingIndex] ?? greetings[0];
    if (first) {
        const ctx = macroContext([], state.variables);
        state.chat.push({ role: 'assistant', name: c.name, content: permanentRegex(substitute(first, ctx), 'assistant') });
    }
    save();
    renderAll();
}

export function renderChat() {
    const box = $('#chat');
    // 这一批楼层属于哪个存档：按钮和前端卡 iframe 都绑着它，存档换了就失效（见 archive.js 开头的不变式 3）
    const epoch = persist.epoch;
    const host = frameHostFor(epoch);
    // 楼层数变少（删除 / 新对话）时整体重画
    while (box.children.length > state.chat.length) {
        ui.rendered.delete(box.children.length - 1);
        box.lastElementChild.remove();
    }
    state.chat.forEach((msg, i) => {
        let row = box.children[i];
        if (!row) {
            row = h('div', { class: 'mes' },
                h('div', { class: 'mes_head' },
                    h('span', { class: 'mes_name' }),
                    h('span', { class: 'mes_idx' }),
                    // 隐藏楼层的标记（酒馆是一个幽灵图标 .mes_ghost，title「This message is invisible for the AI」）。用文字，不依赖图标字体
                    h('span', { class: 'mes_hidden_tag', 'data-fk': 'mes-hidden-tag', hidden: true, title: '这一楼已隐藏：留在记录里、能看能改，但不会发给模型' }, '已隐藏'),
                    h('span', { class: 'mes_actions' },
                        h('button', { class: 'ghost', title: '编辑', onclick: () => editMessage(i, epoch) }, '✎'),
                        // 文字和 title 在下面按状态更新（酒馆是同一位置的两个按钮 .mes_hide / .mes_unhide，按 is_system 二选一显示）
                        h('button', { class: 'ghost mes_hide_btn', 'data-fk': 'mes-hide', onclick: () => toggleHidden(i, epoch) }),
                        h('button', { class: 'ghost', 'data-fk': 'mes-hide-upto', title: '隐藏这一楼及之前的全部楼层（不发给模型，省字数；随时可以取消隐藏）', onclick: () => hideUpTo(i, epoch) }, '隐藏至此'),
                        h('button', { class: 'ghost', title: '删除这一楼及之后', onclick: () => deleteFrom(i, epoch) }, '✕'),
                    ),
                ),
                h('div', { class: 'mes_text' }),
                // 脚注行：左下角「重新生成」（只在最后一楼显示），右边是候选箭头
                h('div', { class: 'mes_foot' },
                    h('button', { class: 'ghost mes_regen', 'data-fk': 'mes-regen', type: 'button', title: '重新生成', 'aria-label': '重新生成', hidden: true, onclick: () => regenerate(i, epoch) }, '↻'),
                    h('div', { class: 'mes_swipes', hidden: true },
                        h('button', { class: 'ghost swipe_left', title: '上一个候选（第一个时绕回最后一个）', onclick: () => swipe(i, -1, epoch) }, '◀'),
                        h('span', { class: 'swipes_counter' }),
                        h('button', { class: 'ghost swipe_right', title: '下一个候选', onclick: () => swipe(i, 1, epoch) }, '▶'),
                    ),
                ),
            );
            box.append(row);
        }
        row.dataset.role = msg.role;
        const hid = isHidden(msg);
        row.classList.toggle('mes-hidden', hid);
        $('.mes_hidden_tag', row).hidden = !hid;
        const hideBtn = $('.mes_hide_btn', row);
        hideBtn.textContent = hid ? '取消隐藏' : '隐藏';
        hideBtn.title = hid ? '取消隐藏：这一楼重新发给模型' : '隐藏这一楼：留在记录里，但不发给模型';
        $('.mes_name', row).textContent = msg.name;
        // 深度只数可见的楼（隐藏的楼不算深度，同酒馆，见 pipeline.js displayDepth）；隐藏的楼自己没有深度
        $('.mes_idx', row).textContent = hid ? `#${i}` : `#${i} · 深度 ${displayDepth(state.chat, i)}`;
        updateSwipeControls(row, i);
        if (row.classList.contains('editing')) return;

        let text;
        try { text = displayText(msg, i); } catch (e) { console.error(e); text = msg.content; }
        if (ui.rendered.get(i) === text) return;   // 显示内容没变就不动，iframe 不用重建
        ui.rendered.set(i, text);
        const body = $('.mes_text', row);
        try {
            mountMessage(body, formatMessage(text), { messageId: i, host });
        } catch (e) {
            console.error(e);
            body.textContent = text;
        }
    });
    renderChatInfo();
    renderChatEmpty();
    chatChanged();   // 聊天里的内容可能变了：搜索栏开着的话防抖重算（见 chat-search.js）
}

/** 一张卡都没有、也还没聊过：聊天区显示「怎么开始」的引导（顶栏的导入按钮没了，得告诉用户入口在哪） */
function renderChatEmpty() {
    const el = $('#chat-empty');
    if (el) el.hidden = Boolean(state.card) || state.chat.length > 0;
}

/**
 * 聊天区顶上的提示条（以前还带「N 楼」，现在只在有提示时出现）。最近一次拼装（预览或发送）有楼层因为上下文上限没发时，后面跟一句提示：
 * 常驻、不弹窗，但用户一眼能看到历史被截了（详情在「拼装」页）。
 */
export function renderChatInfo() {
    const el = $('#chat-info');
    if (!el) return;
    const b = ui.preview?.budget;
    const note = b?.droppedCount
        ? h('span', { class: 'budget-note', title: `超出上下文上限（${b.limit} token，估算），这次第 ${b.droppedFrom}–${b.droppedTo} 楼没发给模型；聊天记录本身没删。详情见右侧「拼装」页。` },
            b.keptCount ? ` · 最早的 ${b.droppedCount} 楼超出上限没发` : ' · 超出上限：这次一楼都没发')
        : null;
    // 隐藏楼层的小结直接看聊天记录（不跟预览走：隐藏是用户自己点的，点完立刻要看到）
    const hs = hiddenSummary(state.chat);
    const epoch = persist.epoch;
    const hiddenNote = hs.count
        ? h('span', { class: 'hidden-note', 'data-fk': 'hidden-note', 'data-count': hs.count, title: `已隐藏：${hs.text}。隐藏的楼留在记录里、能看能改，但不会发给模型，也不算楼层深度、不参与世界书扫描。` },
            ` · 有 ${hs.count} 楼已隐藏，不会发给模型 `,
            h('button', { class: 'ghost hidden-unhide-all', 'data-fk': 'unhide-all', type: 'button', title: '把所有隐藏的楼都取消隐藏', onclick: () => unhideAll(epoch) }, '全部取消隐藏'))
        : null;
    // 楼数不在这里了（挪到「存档」页每个存档那一行）；这一条只在有提示要说时才出现，平时整条隐藏，聊天区顶上就没有多余的一行
    const parts = [...(note ? [note] : []), ...(hiddenNote ? [hiddenNote] : [])];
    el.hidden = !parts.length;
    el.replaceChildren(...parts);
}

// ───────────────────────────── 隐藏楼层 ─────────────────────────────
// 对照酒馆 1.19：
//   - 数据：消息上的 is_system = true（scripts/chats.js hideChatMessageRange）。我们存成 ChatMessage.hidden（types.js），
//     导入导出时和 is_system 互转（chatfile.js 文件头）。
//   - 入口：每楼的眼睛按钮（.mes_hide / .mes_unhide，chats.js initChatUtilities）、/hide /unhide [楼层号或 a-b 范围]
//     （slash-commands.js hideMessageCallback，不带参数 = 最后一楼）。任何一楼都能隐藏，包括第 0 楼开场白。
//     我们没有斜杠命令输入框，所以把最常用的「整段隐藏很早的剧情」做成每楼的「隐藏至此」（= /hide 0-N）和顶上的「全部取消隐藏」。
//   - 显示：酒馆给 .mes 加 is_system="true"，出现幽灵图标，头像变灰（style.css .mes[is_system="true"] .avatar）；内容照常显示。
//     我们整楼变淡 + 「已隐藏」字样（style.css 末尾「隐藏楼层」一块）。
//   - 不发给模型、不算深度、不进世界书扫描：见 pipeline.js computePrompt 第 0 步。
//   - 外置记忆：见 memory-fold.js 文件头「隐藏楼层」小节（setHidden 顺带作废受影响的摘要）。
// 拦截：和编辑 / 删除一样，正在生成、正在切换存档（旧存档的按钮）时不生效；另外恢复备份中、已停止保存、只读标签页时拒绝并说明。
// （编辑 / 删除在只读标签页里目前是「改了但不保存」，没有拒绝；隐藏照任务要求拒绝。）

/**
 * 现在能不能隐藏 / 取消隐藏：能就返回 null；旧存档的按钮返回 ''（静默不做，同编辑）；其余返回拒绝的原因。
 * 和前端卡改聊天的接口（frame-host.js writeBlocked）是同一套条件（chatWriteBlocked），只是拒绝原因的说法不同
 */
export function hideBlocked(epoch = persist.epoch) {
    return chatWriteBlocked(epoch, '隐藏或取消隐藏');
}

/**
 * 现在能不能从「界面按钮以外」的入口改聊天内容（前端卡的 setChatMessages / createChatMessages / deleteChatMessages、
 * 斜杠命令 /send /trigger，见 frame-host.js）：能就返回 null；旧存档 / 正在切换返回 ''；其余返回拒绝的原因。
 * 条件和隐藏一样：正在生成（generateReply 手里拿着占位那一楼的对象和楼层号，中途插楼删楼会让它把回复写错地方）、
 * 正在恢复备份、已停止保存、只读标签页。
 * @param {number} [epoch]
 * @param {string} [action]  拒绝原因里「不能 / 等这次结束再」后面的动作
 */
export function chatWriteBlocked(epoch = persist.epoch, action = '改聊天记录') {
    if (!stillCurrent(epoch)) return '';
    if (ui.busy) return `正在生成回复，等这次结束再${action}`;
    if (restoreActive()) return '正在恢复，请稍等';
    if (persist.stopped) return STOPPED_TEXT;
    if (persist.readOnly) return `这个标签页是只读的（见页面顶上的说明），不能${action}`;
    return null;
}

/** 真正改数据：setHidden（memory-fold.js）改标记、作废受影响的摘要；然后存盘、重画、补压 */
function applyHidden(indexes, hide) {
    const { changed } = setHidden(state.chat, indexes, hide);
    if (!changed.length) return 0;
    ui.previewIsSent = false;
    save();
    renderAll();
    renderMemoryIfActive();
    // 作废了的轮次、以及刚取消隐藏而还没有摘要的回复，交给 ensureMemories 补压（它自己跳过隐藏的回复）
    setTimeout(ensureMemories, 0);
    return changed.length;
}

/** 每楼的「隐藏 / 取消隐藏」 */
export function toggleHidden(i, epoch = persist.epoch) {
    const why = hideBlocked(epoch);
    if (why !== null) { if (why) toast(why, 'error'); return; }
    if (!state.chat[i]) return;
    applyHidden([i], !isHidden(state.chat[i]));
}

/** 「隐藏至此」：第 0..i 楼里还没隐藏的全部隐藏（= 酒馆 /hide 0-i）。不止一楼时先确认，说清楚几楼 */
export function hideUpTo(i, epoch = persist.epoch) {
    const why = hideBlocked(epoch);
    if (why !== null) { if (why) toast(why, 'error'); return; }
    const todo = [];
    for (let k = 0; k <= i && k < state.chat.length; k++) if (!isHidden(state.chat[k])) todo.push(k);
    if (!todo.length) return void toast(`第 0–${i} 楼已经都隐藏了`);
    if (todo.length > 1 && !confirm(`隐藏第 0–${i} 楼？其中还没隐藏的有 ${todo.length} 楼。\n隐藏的楼留在记录里、能看能改，只是不再发给模型；随时可以取消隐藏。`)) return;
    applyHidden(todo, true);
}

/** 聊天区顶上的「全部取消隐藏」。不止一楼时先确认 */
export function unhideAll(epoch = persist.epoch) {
    const why = hideBlocked(epoch);
    if (why !== null) { if (why) toast(why, 'error'); return; }
    const todo = [];
    for (let k = 0; k < state.chat.length; k++) if (isHidden(state.chat[k])) todo.push(k);
    if (!todo.length) return;
    if (todo.length > 1 && !confirm(`取消隐藏全部 ${todo.length} 楼？它们会重新发给模型。`)) return;
    applyHidden(todo, false);
}

/** 上一次真发送时有没有丢楼：只在「从不丢 → 开始丢」时弹一次提示，免得长聊天里每发一句都弹 */
let lastSendDropped = false;
function noticeBudget(prompt) {
    const b = prompt.budget;
    const dropping = Boolean(b?.droppedCount || b?.overflow);
    if (dropping && !lastSendDropped) {
        toast(b.keptCount && !b.overflow
            ? `超出上下文上限：这次最早的 ${b.droppedCount} 楼没发给模型（聊天记录没删，详情见「拼装」页）`
            : '超出上下文上限：这次聊天记录一楼都没发出去，见「拼装」页', b.keptCount && !b.overflow ? '' : 'error');
    }
    lastSendDropped = dropping;
}

export function scrollChatToEnd() {
    const box = $('#chat');
    box.scrollTop = box.scrollHeight;
}

/** 这个操作还作数吗：不在切换中，而且发起时的存档还是当前存档 */
const stillCurrent = epoch => !ui.switching && (epoch === undefined || epoch === persist.epoch);

export function editMessage(i, epoch = persist.epoch) {
    const row = $('#chat').children[i];
    if (!row || ui.busy || !stillCurrent(epoch)) return;
    row.classList.add('editing');
    updateSwipeControls(row, i);
    const body = $('.mes_text', row);
    const ta = h('textarea', { rows: Math.min(18, state.chat[i].content.split('\n').length + 2) });
    ta.value = state.chat[i].content;
    const done = (commit) => {
        row.classList.remove('editing');
        if (!stillCurrent(epoch)) return;   // 编辑期间切换了存档：这次编辑作废，不能写进新存档的第 i 楼
        if (commit) {
            state.chat[i].content = permanentRegex(ta.value, state.chat[i].role, true);
            syncSwipeSlot(state.chat[i]);   // 改的是当前这个候选（酒馆 messageEditDone：mes.swipes[mes.swipe_id] = text）
            // 原文改了，这一轮的摘要作废重压：改的是回复就是它自己，改的是用户输入就是紧跟着的那条回复（规则见 memory-fold.js）
            invalidateTurnAt(state.chat, i);
            setTimeout(ensureMemories, 0);
        }
        ui.rendered.delete(i);
        save();
        renderAll();
    };
    body.replaceChildren(h('div', { class: 'mes_edit' }, ta,
        h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => done(true) }, '保存'),
            h('button', { onclick: () => done(false) }, '取消'),
        )));
    ta.focus();
}

/**
 * 「✕」：删除第 i 楼【及之后的所有楼】（截断）。这是本项目一直以来的做法（酒馆可以单删任意一楼，我们不提供单删）。
 * 输入、回复、记忆三者因此天然绑在一起：
 *   - 删一条用户输入：它这一轮的回复（连同全部 swipe 候选和挂在回复上的记忆摘要）在它后面，一起删掉；
 *   - 删一条回复：只删它和它之后的；它前面的用户输入留着，可以直接点「重新生成」；
 *   - 剩下的楼都在 i 之前，每一轮都完整，没有哪条剩下的摘要需要作废（memory-fold.js invalidateAfterDelete 的注释）。
 * 前端卡能调用的 deleteChatMessages 是任意单删，那边另有作废规则（frame-host.js）。
 */
export function deleteFrom(i, epoch) {
    if (ui.busy || !stillCurrent(epoch)) return;
    const n = state.chat.length - i;
    // 删的是用户输入、后面还有这一轮的回复时，把「回复也会一起删掉」说出来（只删最后一楼时照旧不问）
    const reply = state.chat[i]?.role !== 'assistant' && turnReplyIndex(state.chat, i) > i;
    if (n > 1 && !confirm(`删除第 ${i} 楼及之后共 ${n} 楼？${reply ? '\n这一轮的回复（连同它的候选和记忆摘要）也会一起删掉。' : ''}`)) return;
    state.chat.length = i;
    ui.rendered.clear();
    $('#chat').replaceChildren();
    save();
    renderAll();
}

export function setBusy(busy) {
    ui.busy = busy;
    $('#send').disabled = busy;
    $('#stop').hidden = !busy;
    const box = $('#chat');
    if (box?.lastElementChild) updateSwipeControls(box.lastElementChild, box.children.length - 1);
}

export async function send() {
    // switching：archive.js 正在切换卡 / 存档（中间有异步读写）。这时发出的消息会落进即将被换掉的那个存档，干脆不让发
    if (ui.busy || ui.switching) return;
    const text = $('#input').value.trim();
    if (text) {
        state.chat.push({ role: 'user', name: state.persona.name || 'User', content: permanentRegex(text, 'user') });
        $('#input').value = '';
    }
    await generateReply();
}

/** 生成失败时在聊天区下方留一条不会自己消失的说明（小提示一闪而过，容易以为「没回复」） */
export function showGenError(message) {
    const text = String(message ?? '未知错误');
    $('#gen-error-text').textContent = text;
    // 网页版专属的几条放最前面（网页版的报错和建议里都不提 Claude Code / Codex：网页版根本没有它们）
    $('#gen-error-hint').textContent = /还没选聊天用的接口|还没选接口/.test(text)
        ? '到右侧「接口」页添加一个 OpenAI 兼容接口，再在页面顶部的「聊天用的模型」里选它。'
        : /不允许网页直接访问/.test(text)
            ? '这个接口可能不允许网页直连；可以换一个接口，或改用压缩包版。'
        // Codex 没登录（报错文字来自 server/cli-codex.mjs 的 explainCodexError）
        : /Codex/.test(text) && /codex login|还没有登录|401|Unauthorized/i.test(text)
            ? '在终端（命令提示符）里运行 codex login，登录你的 ChatGPT 账号，然后点「重新生成」。'
        : /找不到 codex|SMALLTALK_CODEX/.test(text)
            ? '没找到 Codex：先安装 OpenAI 的 Codex CLI 并运行 codex login，然后重启本地服务；或者先换一个接口 / 用「手动模式」。'
            : /HTTP 404/.test(text) && /model/i.test(text)
                ? '这个模型在该接口上不可用，到「接口」页顶部换一个模型。'
        : /safeguards flagged|usage policy|legal\/aup/i.test(text)
        ? '这是模型一侧拒绝了这次请求的内容，不是程序出错。常见原因是预设里的条目；可以在「预设」页关掉部分条目后重试，或换一个预设。'
        : /找不到 claude|SMALLTALK_CLAUDE/.test(text)
            ? '模型桥没找到 claude 可执行文件。可以先开「杂项」页里的「手动模式」。'
            : /找不到这个接口|还没配置好|没有选择模型/.test(text)
                ? '到右侧「接口」页检查这个接口（地址 / API Key 是否填全、接口是否还在），再在「接口」页顶部的「聊天用的模型」里重新选一个模型，然后点「重新生成」。'
            : '可以点「重新生成」再试一次；拼好的内容在右侧「拼装」页，也可以用「手动模式」。';
    $('#gen-error').hidden = false;
}

/**
 * 生成一条回复。
 * @param {{swipe?: boolean}} [opts]  swipe=true：给最后一楼（AI 回复）生成一个新候选，而不是新开一楼。
 *   对应酒馆 Generate('swipe')：拼 prompt 时把最后一楼拿掉（script.js ~4497「if (type === 'swipe') coreChat.pop()」），
 *   生成完追加到 swipes 末尾并切过去（saveReply type='swipe'，~6671）。
 *   生成中这一楼的 content / swipes 都不动，新文本只画在界面上；所以中途存盘、刷新、失败都不会留下空候选。
 *   失败或中断且一个字都没收到：什么都不加，界面画回原来的候选（酒馆 endSwipe 把越界的 swipe_id 夹回去，~10052）。
 *   中断时已经收到一部分：和普通生成一样留下这部分（酒馆停止流式时也是把已收到的存成新候选）。
 */
export async function generateReply({ swipe = false } = {}) {
    if (ui.busy || ui.switching) return;
    const target = swipe ? state.chat.at(-1) : null;
    if (swipe && !canSwipe(state.chat.length - 1)) return;
    if (swipe && isHidden(target)) return;   // 隐藏的回复不生成新候选（见 swipe()）
    $('#gen-error').hidden = true;
    const context = swipe ? state.chat.slice(0, -1) : state.chat;
    let prompt;
    try {
        prompt = computePrompt(context, { commit: true });   // 这次是真的发送，setvar 等写入正式变量
    } catch (e) {
        console.error(e);
        toast(`拼装失败：${e.message}`, 'error');
        renderAll();
        return;
    }
    ui.preview = prompt;
    ui.previewIsSent = true;
    noticeBudget(prompt);
    save();
    renderAll();
    scrollChatToEnd();

    if (state.manual) {
        // 手动模式下的「重新生成」：贴回来的回复作为这一楼的【新候选】加进去，旧回复不删（app.js 的 #manual-ok 读这个标记）。
        // 普通发送时是 null：贴回来的回复新开一楼
        ui.manualTarget = target;
        $('#manual-panel').hidden = false;
        $('#manual-reply').focus();
        return;
    }

    const msg = target ?? { role: 'assistant', name: card().name, content: '' };
    if (!target) state.chat.push(msg);
    const index = state.chat.indexOf(msg);
    renderChat();
    const row = $('#chat').children[index];
    const body = $('.mes_text', row);
    row.classList.add('streaming');
    setBusy(true);
    ui.abort = new AbortController();
    let streamed = '';
    let removedAt = -1;   // 失败后删掉的占位原来在第几楼（finally 里决定渲染缓存作废多少）
    if (target) { unmountMessage(body); body.innerHTML = '…'; }   // 旧候选里可能有前端卡 iframe，先释放；酒馆这时也先显示「...」
    try {
        const wire = prompt.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content }));
        const full = await generate(wire, {
            signal: ui.abort.signal,
            // 聊天模型 = 「接口」页顶部选的「接口 + 模型」。接口被删了也照发：服务端会报错并指向「接口」页，不会悄悄换别的接口
            endpoint: state.chatModel.endpoint,
            model: state.chatModel.model || undefined,   // claude-code 下 '' = 默认模型，不传
            params: samplerParamsFromPreset(preset()),   // 只有 openai 类接口会用；claude-code 忽略
            promptCache: state.promptCache !== false,     // 「拼装」页的开关；只有 OpenRouter + anthropic/ 模型才真的加标记
            onDelta: (soFar) => {
                streamed = soFar;
                if (!target) msg.content = soFar;   // 新候选在生成完之前不碰 msg（见函数说明）
                // 流式期间只做 markdown，不挂 iframe；结束后再完整渲染一次
                try { body.innerHTML = formatMessage(soFar); } catch { body.textContent = soFar; }
                scrollChatToEnd();
            },
        });
        const text = permanentRegex(full, 'assistant');
        if (target) appendSwipe(target, text);   // 顺带作废这一楼旧候选的记忆摘要
        else {
            msg.content = text;
            // 酒馆 saveReply：回复一保存就带上 swipes=[mes]、swipe_id=0（~6800）
            msg.swipes = [text];
            msg.swipeId = 0;
        }
        setTimeout(ensureMemories, 0);   // 回复写完后，后台把这一轮压成一句话
    } catch (e) {
        if (e.name !== 'AbortError') showGenError(e.message);
        if (target) {
            if (streamed) { appendSwipe(target, streamed); setTimeout(ensureMemories, 0); }
        } else if (!msg.content) {
            // 按对象删占位：生成中聊天可能被别的入口改过（前端卡的 createChatMessages 等），最后一楼不一定还是它。
            // 已经不在聊天里（被删掉了）就什么都不做
            removedAt = state.chat.indexOf(msg);
            if (removedAt >= 0) state.chat.splice(removedAt, 1);
        }
        else { msg.swipes = [msg.content]; msg.swipeId = 0; }
    } finally {
        row.classList.remove('streaming');
        ui.abort = null;
        setBusy(false);
        // 这一楼不在原位了（生成中聊天被前端卡等改过）：按楼层号记的渲染缓存全部作废，整体重画。
        // 正常情况（还在原位，或者就是在原位被删掉的最后一楼）只作废这一楼，别的楼的前端卡 iframe 不用重建
        const at = state.chat.indexOf(msg);
        if (at === index || (at < 0 && removedAt === index && index === state.chat.length)) ui.rendered.delete(index);
        else ui.rendered.clear();
        save();
        renderAll();
        scrollChatToEnd();
    }
}

/**
 * 「重新生成」（最后一条回复左下角的 ↻）：给最后一楼 AI 回复再生成一个【新候选】，旧回复留作候选、可以用箭头切回去。
 * （以前是照酒馆 Generate('regenerate') 整条删掉重来；现在改成新增候选式 = 酒馆里点右箭头到头的 swipe 生成。）
 * 不能走 swipe 的几种情况退回「删掉再生成」或「直接生成」（酒馆 Generate('regenerate') 的行为）：
 *   - 最后一楼是用户输入（上次生成失败 / 被停止、没有回复）：没有回复可加候选，直接生成，什么都不删。
 *     这是失败后「再试一次」的入口，所以用户输入那一楼的左下角也有这个按钮。
 *   - 最后一楼是隐藏的回复：隐藏楼不生成新候选（见 swipe()），整条删掉再生成，新回复不带隐藏标记。
 *   - 手动模式：没有真正的生成，候选没意义，删掉最后一条回复、拼好 prompt 等用户贴新回复。
 *   这两条「删掉再生成」的路先 confirm（写明会删掉这一楼和它的 N 个候选），取消就什么都不做。
 * 隐藏的用户输入：酒馆「lastMessage.is_user → 什么都不删」，直接生成；这条输入不在发出去的内容里（见 pipeline.js）。
 * @param {number} [i]  按钮所在楼层（必须是最后一楼，否则忽略）
 * @param {number} [epoch]  按钮所属的存档
 */
export function regenerate(i, epoch) {
    if (ui.busy || ui.switching || !stillCurrent(epoch)) return;
    if (i !== undefined && i !== state.chat.length - 1) return;
    const last = state.chat.at(-1);
    // 重新生成永远不删已有的回复和候选（2026-11-22 用户定）：
    //   普通 / 手动模式 → 加一个新候选（手动模式下是把贴回来的回复加成新候选，见 generateReply 里的 ui.manualTarget）；
    //   最后一楼是隐藏的回复 → 不做（按钮本来就不显示，见 paintFoot），提示先取消隐藏。
    if (last?.role === 'assistant' && state.chat.length > 1) {
        if (isHidden(last)) { toast('这一楼是隐藏的：先取消隐藏，再重新生成'); return; }
        generateReply({ swipe: true });
        return;
    }
    generateReply();
}

// ───────────────────────────── swipe ─────────────────────────────
// 规则在 src/chatfile.js 的 swipe 小节（对照酒馆 script.js swipe() / isMessageSwipeable）。这里只管界面。

/**
 * 这一楼能不能滑：酒馆 isMessageSwipeable（~9183）——最后一楼、不是用户消息。我们另外有两处收紧：
 *   - 只认 assistant（旁白 system 不滑，酒馆里旁白也能滑出一条角色回复，那个行为很怪，不照搬）；
 *   - 第 0 楼（开场白）不滑：酒馆里开场白的 swipe 是「备选开场白」，我们用 #greeting-select 处理，不在这里。
 */
export function canSwipe(i) {
    const msg = state.chat[i];
    return Boolean(msg) && i > 0 && i === state.chat.length - 1 && msg.role === 'assistant';
}

/**
 * 脚注行：左下角「重新生成」+ 右边的候选箭头。
 * 箭头只负责切换候选，候选多于一个才显示；最后一个候选时右箭头禁用，不再生成新候选（新增候选走「重新生成」）。
 */
function updateSwipeControls(row, i) {
    const box = $('.mes_swipes', row);
    if (!box) return;
    const idle = !ui.busy && !row.classList.contains('editing');
    const msg = state.chat[i];
    // 「重新生成」：最后一楼的 AI 回复（第 0 楼开场白不算，换开场白用 #greeting-select）或最后一楼的用户输入（失败后重试）
    $('.mes_regen', row).hidden = !(idle && i === state.chat.length - 1 && msg && ((msg.role === 'assistant' && i > 0 && !isHidden(msg)) || msg.role === 'user'));   // 隐藏的回复不给重新生成（先取消隐藏）
    const show = canSwipe(i) && idle;
    box.hidden = !show;
    if (!show) return;
    const s = readSwipes(state.chat[i]);
    const n = s ? s.swipes.length : 1, id = s ? s.id : 0;
    // 隐藏的楼：酒馆 getOverswipeBehavior（script.js ~L9238）对 is_system 的回复是 LOOP（越过最后一个绕回第一个，不生成新候选），
    // 箭头只在候选多于一个时显示（refreshSwipeButtons：swipes_visible 要 hasSwipes，last_swipe 只给 REGENERATE）
    const hid = isHidden(state.chat[i]);
    if (n <= 1) { box.hidden = true; return; }
    const right = $('.swipe_right', box);
    right.title = hid ? '下一个候选（这一楼已隐藏：到最后一个时绕回第一个）' : '下一个候选';
    right.disabled = !hid && id >= n - 1;   // 隐藏的楼到头绕回第一个；其余到头就停
    $('.swipe_left', box).hidden = n <= 1;
    $('.swipes_counter', box).hidden = n <= 1;
    $('.swipes_counter', box).textContent = `${id + 1}/${n}`;
}

/**
 * 点箭头。
 * @param {number} i  楼层号（必须是最后一楼）
 * @param {-1|1} dir
 * @param {number} [epoch]  按钮所属的存档（切走后旧按钮作废）
 */
export function swipe(i, dir, epoch) {
    if (ui.busy || !stillCurrent(epoch) || !canSwipe(i)) return;
    const row = $('#chat').children[i];
    if (row?.classList.contains('editing')) return;   // 酒馆会先关掉编辑框；我们直接不让滑，免得编辑内容落到别的候选上
    const msg = state.chat[i];
    let to = swipeTarget(msg, dir);
    if (to === 'generate') {
        // 右箭头只切换候选，到头了什么也不做（新增候选用「重新生成」）。
        // 隐藏的回复照酒馆 OVERSWIPE_BEHAVIOR.LOOP 绕回第一个（见 updateSwipeControls）
        if (!isHidden(msg) || (readSwipes(msg)?.swipes.length ?? 1) <= 1) return;
        to = 0;
    }
    ensureSwipes(msg);   // 老存档：从 st 里提升出来；当前格先写成 content
    if (!selectSwipe(msg, to)) return;   // 只有一个候选时向左 = 不动
    // 外置记忆：selectSwipe 已经删掉了旧候选的摘要。重新压缩交给 ensureMemories：它用原文快照判断结果还作不作数，
    // 所以连续快速切换时，压到一半的旧结果会被丢掉，不会把别的候选的摘要写到这一楼上
    setTimeout(ensureMemories, 0);
    ui.rendered.delete(i);
    ui.previewIsSent = false;
    save();
    renderAll();
}
