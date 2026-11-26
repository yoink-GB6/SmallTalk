// 拼装流水线：脚本 / 条目汇总、宏上下文、computePrompt、永久改写与显示用正则、预览刷新。
// 想看一次生成到底发生了什么，从 computePrompt() 读起。

import { substitute } from '../macros.js';
import { scanWorldInfo, effectiveWiSettings } from '../worldinfo.js';
import { isBookActiveFor } from '../books.js';
import { assemble, resolveContextLimit, messageTokens } from '../assemble.js';
import { normalizeAuthorNote } from '../author-note.js';
import { runRegexScripts } from '../regex.js';
import { $, debounce } from './dom.js';
import { state, ui, card, preset, persist } from './state.js';
import { foldChat, memoryBlock } from './memory.js';
import { renderInspector } from './shell.js';
import { recordSent } from './sent-log.js';
import { renderChatInfo } from './chat.js';   // 循环依赖（chat.js 也导入本文件）：只在函数体里调用，安全

// ───────────────────────────── 拼装的入口 ─────────────────────────────

/** 正则脚本的执行顺序：全局 → 预设 → 角色卡（和酒馆 engine.js 一致） */
export function allScripts() {
    const tag = (list, origin) => (list ?? []).map(s => (s.origin = origin, s));
    return [
        ...tag(state.globalRegex, 'global'),
        ...tag(preset().extensions?.regex_scripts, 'preset'),
        ...tag(card().regexScripts, 'card'),
    ];
}

/**
 * 这一次参与拼装的世界书条目：当前卡内嵌的那本（没被整本关掉时，见 cardBookActive）+ 对当前卡生效的额外世界书
 * （books.js isBookActiveFor：启用、且范围是「所有聊天」或绑定了当前卡）。关掉的、只对别的卡生效的书不在这里，扫描时根本看不到它们。
 * 「当前卡」用 persist.cardId（卡记录的 id）；还没有任何卡时是 null，于是只有「所有聊天」的书生效。
 * 返回的是条目【原对象】（「世界书」页直接改它们）。
 */
export function allEntries() {
    return [...(cardBookActive() ? card().worldEntries : []), ...activeBooks().flatMap(b => b.entries)];
}

/**
 * 卡自带的世界书这次参与拼装吗：没被整本关掉（types.js Card.worldDisabled）。
 * 酒馆导入的卡绑定的书文件一起导进来了时，卡自带的这份会被关掉（酒馆运行时只用文件那本，见 tavern-convert.js applyWorldRules）。
 */
export const cardBookActive = () => card().worldDisabled !== true;

/** 对当前卡生效的额外世界书（顺序同 state.books） */
export function activeBooks() {
    return state.books.filter(b => isBookActiveFor(b, persist.cardId));
}

/**
 * 「按存档固定」的随机种子：当前卡 id + 当前存档 id（{{pick}} 用；开了 stableRandom 时 {{random}} / {{roll}} 也用）。
 * 酒馆用的是聊天 ID 的哈希（macros.js getChatIdHash）；我们的「聊天」就是一个存档，存档 id 生成后不会变，所以刷新、重开浏览器都一样。
 * 没卡、还没存过档（persist.cardId 为 null）时返回 ''：macros.js 退回旧的「原文哈希 + 偏移」。
 * 注意没卡状态下第一次保存才分配 id（state.js ensureCardRecord），所以那种情况下第一次发送和之后的 pick 结果可能不同。
 */
export function macroSeed() {
    return persist.cardId && persist.chatId ? `${persist.cardId}:${persist.chatId}` : '';
}

/**
 * 当前存档的作者注释（ChatRecord.authorNote，运行时在 persist.chatMeta 上；没有 = 内置默认）。规范化过的完整五个字段。
 * 没卡状态 / 还没有存档记录时也是默认值（酒馆里不在聊天里时不插，但我们没卡时也能聊，默认值下只有世界书「作者注释上 / 下」的条目会受影响）
 */
export const currentAuthorNote = () => normalizeAuthorNote(persist.chatMeta?.authorNote);

export function macroContext(chat, variables, outlets = {}) {
    const c = card();
    return {
        seed: macroSeed(),
        stableRandom: state.stableRandom === true,
        authorsNote: currentAuthorNote().prompt,   // {{authorsNote}}（macros.js）
        user: state.persona.name || 'User',
        char: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
        persona: state.persona.description,
        mesExamples: c.mesExample,
        chat,
        variables,
        outlets,
    };
}

export const placementOf = msg => (msg.role === 'user' ? 1 : 2);

/**
 * 一次生成的完整流水线。
 * @param {import('./types.js').ChatMessage[]} chat
 * @param {{commit: boolean}} opts  commit=false 时用变量的副本，预览不会让 {{incvar}} 之类反复生效
 */
export function computePrompt(chat, { commit }) {
    const variables = commit ? state.variables : structuredClone(state.variables);
    const ctx = macroContext(chat, variables);
    const sub = text => substitute(text, ctx);

    // 0. 隐藏楼层（ChatMessage.hidden = 酒馆的 is_system）：酒馆 Generate 里第一步就是
    //      coreChat = chat.filter(x => !x.is_system)（script.js ~L4496）
    //    之后的一切都在 coreChat 上做，所以隐藏的楼：
    //      - 不发给模型；
    //      - 不算楼层深度：发送侧正则的深度（同处 options.depth = coreChat.length - index - 1）、@深度注入的位置
    //        （populationInjectionPrompts 在 coreChat 做成的消息上数）都只数可见的楼；
    //      - 不进世界书扫描：chatForWI = coreChat.map(...)（~L4624），扫描深度数的也是可见的楼；
    //      - 不占上下文预算（预算也是在 coreChat 做成的消息上算）。
    //    宏不一样：{{lastMessage}} / {{lastMessageId}} 读整个 chat（含隐藏），{{lastUserMessage}} / {{lastCharMessage}} 跳过隐藏
    //    （macros.js 里按 ChatMessage.hidden 过滤），所以宏上下文仍用完整的 chat。
    //    floors[k] = visible[k] 在完整记录里的楼层号，拼装结果里的出处、日志、budget 都用它，界面上的「#N」对得上。
    const floors = [];
    for (let i = 0; i < chat.length; i++) if (chat[i]?.hidden !== true) floors.push(i);
    const visible = floors.map(i => chat[i]);

    // 1. 世界书：扫描聊天记录（只看可见的楼），决定哪些条目被触发
    //    酒馆在扫描前先对第 0 楼（开场白）做宏替换（script.js ~L4490），所以开场白里 {{char}} 展开出的名字也能触发关键词。
    //    这一步在过滤之前对真正的 chat[0] 做：开场白被隐藏了就不在 coreChat 里，排在最前面的那楼不会被多替换一次
    const scanChat = visible.map((m, k) => (floors[k] === 0 ? { ...m, content: sub(m.content) } : m));
    const worldInfo = scanWorldInfo({ entries: allEntries(), chat: scanChat, settings: effectiveWiSettings(state.wi), substitute: sub });

    // 2. 发送侧正则：每一楼进 prompt 之前先过一遍 promptOnly 脚本（带楼层深度）
    const scripts = allScripts();
    const regexHits = [];
    const transformChat = (msg, depth) => runRegexScripts(msg.content, scripts, {
        placement: placementOf(msg), isPrompt: true, depth, substitute: sub,
        onApply: ({ script, before, after }) => regexHits.push({ script, depth, delta: after.length - before.length }),
    });

    // 3. 拼装：预设条目 + 角色卡 + 世界书 + 聊天记录 → messages
    // 3'. 外置记忆：把较早的楼层从聊天记录里拿掉（世界书扫描和宏仍然看得到完整记录），稍后换成一块摘要
    //     切点 fold.cut 是完整记录里的楼层号（foldCut 数所有楼，规则见 memory-fold.js 文件头「隐藏楼层」），然后再去掉切点之后的隐藏楼层
    const fold = foldChat(chat);
    const hiddenFloors = chat.length - floors.length;
    let sendChat, sendFloors = null;
    if (!hiddenFloors) sendChat = fold.cut ? chat.slice(fold.cut) : chat;   // 没有隐藏楼层：和以前完全一样
    else {
        const from = floors.findIndex(i => i >= fold.cut);
        sendFloors = from < 0 ? [] : floors.slice(from);
        sendChat = sendFloors.map(i => chat[i]);
    }
    const memText = fold.rows.length ? memoryBlock(fold.rows) : '';

    // 3''. 上下文上限：先外置记忆、后上限。
    //   - 已经被摘要替代的旧楼层不在 sendChat 里，自然不计入预算；
    //   - 摘要块本身由我们插在后面，但必须先占预算（reserved），相当于又一条必需内容；
    //   - 上限只在 sendChat 里从最老的开始丢。被丢的楼层还在 state.chat 里，ensureMemories 照样会给它们压摘要，
    //     等它们超出「保留最近 N 楼」时就会被折叠进记忆块——不会因为这次没发而失去被记住的机会。
    const limitInfo = resolveContextLimit(state.contextLimit, preset());
    const contextLimit = limitInfo.limit
        ? { ...limitInfo.limit, reserved: memText ? messageTokens({ role: 'system', content: memText }) : 0 }
        : null;

    const { messages, log, budget } = assemble({
        preset: preset(), card: card(), persona: state.persona, chat: sendChat, worldInfo, variables, transformChat,
        // assemble 看到的是截短（并去掉隐藏楼层）后的记录，楼层号要换回完整记录里的，界面上才对得上
        chatOffset: fold.cut, chatFloors: sendFloors ?? undefined, contextLimit,
        // 宏读完整记录（含隐藏、含被折叠的楼）：{{lastMessageId}} 是完整记录里的楼层号，同酒馆。
        // 【有意保留的行为变化】（隐藏楼层那次改动起）：外置记忆已经折叠时，{{lastMessageId}} / {{lastMessage}} /
        // {{lastUserMessage}} / {{lastCharMessage}} 看到的也是完整记录，而不是截短后的 sendChat。
        // 以前传的是截短后的记录，于是折叠一发生 {{lastMessageId}} 就从「真实的最后楼层号」变成「截短后的长度 − 1」——
        // 记忆只是「少发原文」，不该改变宏的含义；酒馆里也没有这种截短，宏读的一直是整个 chat。
        // 不要改回去（test/hide.test.mjs「macroChat：外置记忆折叠后宏仍看完整记录」钉着）
        macroChat: chat,
        // assemble 用自己的宏上下文（不是上面的 ctx）：种子和稳定随机的开关要单独传过去，不然预设条目里的 pick / random 不按存档固定
        macroSeed: ctx.seed, stableRandom: ctx.stableRandom,
        // 作者注释：「这一轮插不插」按 macroChat（完整记录，含隐藏楼层——酒馆数的是整个 chat 里的 is_user）数用户消息；
        // 「聊天内」的深度和别的 @深度 条目一样按发出去的 sendChat 数（隐藏的楼不算、折叠进记忆的楼不在里面）
        authorNote: currentAuthorNote(),
    });

    if (fold.rows.length) {
        const text = memText;
        const at = messages.findIndex(m => m.sources.some(s => s.kind === 'chat'));
        // 合并段（记忆再压缩）一行顶好几轮：标签里数的是轮数。没有合并段时 = 行数，和以前一样
        const turnCount = fold.rows.reduce((n, r) => n + (r.merged ? r.merged.count : 1), 0);
        messages.splice(at < 0 ? messages.length : at, 0, {
            role: 'system', content: text,
            sources: [{ kind: 'memory', id: 'memory', label: `外置记忆（${turnCount} 轮）`, chars: text.length }],
        });
        log.push({ level: 'info', message: `外置记忆：第 0–${fold.cut - 1} 楼不再发送原文，改为 ${fold.rows.length} 行摘要，插在聊天记录之前` });
    }
    // 隐藏楼层的小结（「拼装」页的日志里看得到；聊天区顶上另有一句，见 chat.js renderChatInfo）
    const hidden = hiddenSummary(chat);
    if (hidden.count) log.push({ level: 'info', message: `有 ${hidden.count} 楼已隐藏（${hidden.text}），不发给模型，也不算楼层深度、不参与世界书扫描` });

    if (commit) recordSent(messages);   // 真发送才记，「拼装」页拿它和之后的预览对比（纯展示）
    return { messages, log, worldInfo, regexHits, variables, fold, budget: budget ?? null, limitInfo, hidden };
}

export const refreshPreview = debounce(() => {
    if (ui.busy) return;
    const pending = $('#send_textarea').value.trim();
    const chat = pending
        ? [...state.chat, { role: 'user', name: state.persona.name, content: pending }]
        : state.chat;
    try {
        ui.preview = computePrompt(chat, { commit: false });
        ui.preview.hypothetical = Boolean(pending);
        ui.previewIsSent = false;
    } catch (e) {
        console.error(e);
        ui.preview = { error: e };
    }
    renderInspector();
    renderChatInfo();   // 聊天区顶上「有几楼超出上限没发」的提示跟着预览走
}, 150);

/** 「永久改写」类正则：markdownOnly / promptOnly 都没勾的脚本，直接改存储的原文 */
export function permanentRegex(text, role, isEdit = false) {
    const ctx = macroContext(state.chat, structuredClone(state.variables));
    return runRegexScripts(text, allScripts(), {
        placement: role === 'user' ? 1 : 2, isEdit, substitute: t => substitute(t, ctx),
    });
}

/**
 * 隐藏楼层的小结：几楼、哪几楼（连续的合并成「3–7」，太多时只列前几段）。
 * @returns {{count: number, text: string, floors: number[]}}
 */
export function hiddenSummary(chat) {
    const floors = [];
    for (let i = 0; i < chat.length; i++) if (chat[i]?.hidden === true) floors.push(i);
    const runs = [];
    for (const i of floors) {
        const r = runs.at(-1);
        if (r && r[1] === i - 1) r[1] = i; else runs.push([i, i]);
    }
    const shown = runs.slice(0, 6).map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`));
    return { count: floors.length, floors, text: shown.join('、') + (runs.length > 6 ? ' 等' : '') };
}

/**
 * 显示一楼时它的楼层深度（显示正则的 minDepth / maxDepth 用，聊天区「深度 M」也显示它）。
 * 照酒馆 messageFormatting（script.js ~L1851）：
 *   usableMessages = chat 里去掉 is_system（隐藏）的楼；深度 = 它在 usableMessages 里离末尾有几楼。
 *   隐藏的楼自己不在 usableMessages 里，深度是 undefined——显示正则的深度限制对它不生效（engine.js 只在 depth 是数字时才比较）。
 * 所以和发送侧一样，只数可见的楼；没有隐藏楼层时就是 楼数 − 1 − 楼层号。
 * @returns {number|undefined}
 */
export function displayDepth(chat, index) {
    if (chat[index]?.hidden === true) return undefined;
    let d = 0;
    for (let k = index + 1; k < chat.length; k++) if (chat[k]?.hidden !== true) d++;
    return d;
}

export function displayText(msg, index) {
    const depth = displayDepth(state.chat, index);
    const ctx = macroContext(state.chat, structuredClone(state.variables));
    return runRegexScripts(msg.content, allScripts(), {
        placement: placementOf(msg), isMarkdown: true, depth, substitute: t => substitute(t, ctx),
    });
}
