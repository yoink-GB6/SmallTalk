// 前端卡 iframe 的宿主侧：酒馆助手 API 的最小实现（hostMethods）、frameHost、楼层范围解析、斜杠命令。

import { substitute } from '../macros.js';
import { $, toast, safeJson } from './dom.js';
import { state, ui, card, save, persist } from './state.js';
import { macroContext, permanentRegex, refreshPreview } from './pipeline.js';
import { generateReply, scrollChatToEnd, chatWriteBlocked } from './chat.js';   // chatWriteBlocked：只在函数体里调用（循环依赖）
import { renderAll, renderInspector } from './shell.js';
import { renderMiscLog } from './tab-misc.js';
import { ensureMemories } from './memory.js';   // 循环依赖（memory.js 经 pipeline.js 间接导入本文件）：只在函数体里调用
import { invalidateTurnAt, invalidateAfterDelete, isHidden, setHidden } from '../memory-fold.js';
import { resolveMessageId, safeVarPairs, isSafeVarName } from '../frame-args.js';

// ───────────────────────────── 前端卡 iframe 的宿主侧 ─────────────────────────────
// iframe 里的卡片调用酒馆助手 API 时，render.js 会把调用转到这里。只实现了最常用的一小撮。

/** 酒馆助手 getChatMessages 的返回形状。is_hidden 就是酒馆的 is_system（我们的 ChatMessage.hidden） */
export const toTavernMessage = (msg, i) => ({
    message_id: i, name: msg.name, role: msg.role, is_hidden: isHidden(msg), message: msg.content, data: {}, extra: {},
});

/**
 * getChatMessages 的筛选（酒馆助手 JS-Slash-Runner 的 GetChatMessagesOption；手头没有它的源码，按它公开的类型声明：
 *   role?: 'all'|'system'|'assistant'|'user'，默认 'all'；hide_state?: 'all'|'hidden'|'unhidden'，默认 'all'——
 *   也就是默认【包含】隐藏的楼，每条带 is_hidden）。include_swipes 没实现（照旧只给当前候选）。
 * 注意 frameHost.call 会在参数末尾追加 messageId：卡只传了 range 时，第二个参数是那个数字，不是选项。
 */
function filterTavern(list, option) {
    const o = option && typeof option === 'object' ? option : {};
    const role = ['system', 'assistant', 'user'].includes(o.role) ? o.role : null;
    const hs = o.hide_state === 'hidden' || o.hide_state === 'unhidden' ? o.hide_state : 'all';
    return list.filter(m => (!role || m.role === role) && (hs === 'all' || m.is_hidden === (hs === 'hidden')));
}

/** "0-3" / 5 / "-1" / "0-{{lastMessageId}}" → 楼层号数组 */
export function parseRange(range) {
    const last = state.chat.length - 1;
    const norm = n => (n < 0 ? last + 1 + n : n);
    const text = String(range ?? `0-${last}`).replaceAll('{{lastMessageId}}', String(last));
    const m = text.match(/^\s*(-?\d+)\s*(?:-\s*(-?\d+))?\s*$/);
    if (!m) return [];
    const a = norm(Number(m[1]));
    const b = m[2] === undefined ? a : norm(Number(m[2]));
    const out = [];
    for (let i = Math.max(0, Math.min(a, b)); i <= Math.min(last, Math.max(a, b)); i++) out.push(i);
    return out;
}

/** 极简斜杠命令：只认卡片按钮最常用的 /send /trigger /setinput，用 | 串联 */
export async function runSlash(command) {
    for (const part of String(command).split('|').map(s => s.trim()).filter(Boolean)) {
        const [, name, arg = ''] = part.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
        // 会改聊天 / 触发发送的命令：拒绝条件和别的改聊天的接口一样（见 writeBlocked）；被拒绝时这一串后面的也不做
        if ((name === 'send' || name === 'trigger') && writeBlocked(`斜杠命令 /${name}`)) return '';
        if (name === 'send') {
            state.chat.push({ role: 'user', name: state.persona.name || 'User', content: arg });
            save(); renderAll(); scrollChatToEnd();
        } else if (name === 'trigger') {
            await generateReply();
        } else if (name === 'setinput') {
            $('#input').value = arg; refreshPreview();
        } else {
            frameHost.log({ messageId: -1, level: 'unimplemented', text: `斜杠命令未实现：${part}` });
        }
    }
    return '';
}

/**
 * 卡脚本传来的楼层号 → 下标（规则见 frame-args.js resolveMessageId：整数或数字字符串，负数从末尾数，必须落在 0..楼数−1）。
 * 不合法的返回 null 并记一条日志；调用方整条跳过。所有按楼层号取消息的宿主方法都走这里，绝不直接拿卡传来的值当下标
 */
function msgIndex(id, method) {
    const i = resolveMessageId(id, state.chat.length);
    if (i === null) frameHost.log({ messageId: -1, level: 'warn', text: `${method}：楼层号 ${safeJson(id)} 不合法（应为 0–${state.chat.length - 1} 的整数，负数从末尾数），这一条跳过` });
    return i;
}

/** 卡脚本传来的变量对象：只取安全的键（frame-args.js safeVarPairs），去掉了危险键时记日志 */
function varPairs(vars, method) {
    const { pairs, dropped } = safeVarPairs(vars ?? {});
    if (dropped) frameHost.log({ messageId: -1, level: 'warn', text: `${method}：${dropped} 个变量名（__proto__ / constructor / prototype）不允许，已忽略` });
    return pairs;
}

/**
 * 前端卡改聊天内容之前问一句（chat.js chatWriteBlocked：正在生成、正在恢复备份、已停止保存、只读、正在切换 / 旧存档）。
 * 被拒绝时记一条日志、返回 true，调用方整个调用都不做——不做一半：生成中插进来的楼会让失败分支删错楼，
 * 删掉的楼会让回复写到别的位置（复核实测过）。
 */
let lastBlockedToast = 0;
function writeBlocked(method) {
    const why = chatWriteBlocked(persist.epoch);
    if (why === null) return false;
    frameHost.log({ messageId: -1, level: 'warn', text: `${method} 没有执行：${why || '正在切换存档'}` });
    // 多半是用户点了卡里的按钮（选开场白之类）：只记日志的话看起来就是「点了没反应」，所以把原因弹出来。
    // 卡也可能用定时器反复调，5 秒内只弹一次
    if (why && Date.now() - lastBlockedToast > 5000) { lastBlockedToast = Date.now(); toast(why, 'error'); }
    return true;
}

export const hostMethods = {
    getChatMessages: (range, option) => filterTavern(parseRange(range).map(i => toTavernMessage(state.chat[i], i)), option),
    setChatMessages: (updates) => {
        if (writeBlocked('setChatMessages')) return;
        // 先把楼层号校验、换算好（不合法的整条跳过），后面只用换算后的下标
        const list = [];
        for (const u of [].concat(updates ?? [])) {
            if (!u || typeof u !== 'object') continue;
            const i = msgIndex(u.message_id, 'setChatMessages');
            if (i !== null) list.push({ u, i });
        }
        // is_hidden（酒馆助手 setChatMessages 可以改它，对应酒馆的 is_system）：先收集，最后一次性走 setHidden，
        // 和界面上的「隐藏 / 取消隐藏」同一条路（作废受影响的摘要，规则见 memory-fold.js 文件头「隐藏楼层」）
        const hideIds = [], showIds = [];
        for (const { u, i } of list) if (typeof u.is_hidden === 'boolean') (u.is_hidden ? hideIds : showIds).push(i);
        // 拒绝条件和界面上的按钮一样（正在生成、正在恢复备份、已停止保存、只读），开头的 writeBlocked 已经整个拦过了
        if (hideIds.length || showIds.length) {
            setHidden(state.chat, hideIds, true);
            setHidden(state.chat, showIds, false);
            ui.previewIsSent = false;
            setTimeout(ensureMemories, 0);
        }
        for (const { u, i } of list) {
            const m = state.chat[i];
            // 原文真的变了：这一轮的摘要作废重压（和手动编辑同一条规则，见 memory-fold.js）
            if (typeof u.message === 'string') {
                if (m.content !== u.message) { m.content = u.message; invalidateTurnAt(state.chat, i); setTimeout(ensureMemories, 0); }
                ui.rendered.delete(i);
            }
            // 酒馆里第 0 楼的 swipe 就是各个开场白；卡片首页的「选开场白」按钮走的是这条路
            if (i === 0 && Number.isInteger(u.swipe_id)) {
                const c = card();
                const greeting = [c.firstMes, ...c.alternateGreetings].filter(Boolean)[u.swipe_id];
                if (greeting != null) {
                    const text = permanentRegex(substitute(greeting, macroContext([], state.variables)), 'assistant');
                    if (m.content !== text) { m.content = text; invalidateTurnAt(state.chat, 0); setTimeout(ensureMemories, 0); }
                    ui.rendered.delete(0);
                    $('#greeting-select').value = String(u.swipe_id);
                }
            }
        }
        save(); renderAll();
    },
    setChatMessage: (update, messageId) => hostMethods.setChatMessages([{ message_id: messageId, ...(typeof update === 'string' ? { message: update } : (update && typeof update === 'object' ? update : {})) }]),
    getLastMessageId: () => state.chat.length - 1,
    getVariables: () => structuredClone(state.variables.local),
    replaceVariables: (vars) => { state.variables.local = Object.fromEntries(varPairs(vars, 'replaceVariables')); save(); renderInspector(); },
    // 逐个定义自有属性（不用 Object.assign：它对 __proto__ 走的是赋值，会换掉 local 的原型；危险键 varPairs 已经去掉，这里再稳一层）
    insertOrAssignVariables: (vars) => {
        for (const [k, v] of varPairs(vars, 'insertOrAssignVariables')) Object.defineProperty(state.variables.local, k, { value: v, writable: true, enumerable: true, configurable: true });
        save(); renderInspector();
    },
    triggerSlash: (command) => runSlash(command),
    substitudeMacros: (text) => substitute(String(text ?? ''), macroContext(state.chat, structuredClone(state.variables))),
    getCharData: () => structuredClone(card().raw),
    getContextSnapshot: () => ({
        name1: state.persona.name, name2: card().name, characterId: 0, chatId: 'smalltalk',
        // is_system 照酒馆的含义 = 隐藏楼层（旁白在酒馆里 is_system 是 false）
        chat: state.chat.map((m, i) => ({ name: m.name, is_user: m.role === 'user', is_system: isHidden(m), mes: m.content, message_id: i })),
    }),
    createChatMessages: (msgs) => {
        // 被拒绝时整个调用都不建（含 is_hidden: true 的：不能退成「建一条不隐藏的」，那样卡想藏起来的内容会被发给模型）
        if (writeBlocked('createChatMessages')) return;
        const list = [].concat(msgs ?? []);
        for (const m of list) {
            if (typeof m?.message !== 'string') continue;
            const role = ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'assistant';
            const msg = { role, name: typeof m.name === 'string' ? m.name : (role === 'user' ? state.persona.name : card().name), content: m.message };
            if (m.is_hidden === true) msg.hidden = true;   // 酒馆助手 createChatMessages 也能直接建隐藏的楼
            state.chat.push(msg);
        }
        ui.rendered.clear(); save(); renderAll(); scrollChatToEnd();
    },
    deleteChatMessages: (ids) => {
        if (writeBlocked('deleteChatMessages')) return;
        // 楼层号同样校验、换算（负数从末尾数）；不合法的跳过
        const drop = new Set();
        for (const id of [].concat(ids ?? [])) { const i = msgIndex(id, 'deleteChatMessages'); if (i !== null) drop.add(i); }
        if (!drop.size) return;
        // 前端卡可以单删任意一楼（酒馆的接口就是这样）：删掉的楼后面那一轮变了（少了输入，或两轮并成一轮），它的摘要作废重压
        invalidateAfterDelete(state.chat, drop); setTimeout(ensureMemories, 0);
        state.chat = state.chat.filter((_, i) => !drop.has(i));
        ui.rendered.clear(); $('#chat').replaceChildren(); save(); renderAll();
    },
    insertVariables: (vars) => { state.variables.local = { ...Object.fromEntries(varPairs(vars, 'insertVariables')), ...state.variables.local }; save(); renderInspector(); },
    // 只删自有的键（以前用 in：'toString' 之类从原型上继承来的名字也算「有」）；危险键一律不删
    deleteVariable: (path) => {
        if (!isSafeVarName(path)) return false;
        const had = Object.hasOwn(state.variables.local, path);
        delete state.variables.local[path]; save(); renderInspector(); return had;
    },
    getCharAvatarPath: () => state.avatar || null,   // data URL，本身就是绝对地址
    eventEmit: () => undefined,                      // render.js 已经把事件转给其它订阅的 iframe，宿主这边没有要做的
    toastr: (kind, text) => toast(String(text ?? ''), kind === 'error' ? 'error' : kind === 'success' ? 'ok' : ''),
};

export const frameHost = {
    call(method, args, messageId) {
        // 正在切换存档：这时到达的调用不知道该落在哪个存档里，一律不执行
        if (ui.switching) throw new Error('正在切换存档，这次调用没有执行');
        const fn = hostMethods[method];
        if (!fn) {
            frameHost.log({ messageId, level: 'unimplemented', text: `${method}(${safeJson(args)})` });
            return undefined;
        }
        return fn(...(args ?? []), messageId);
    },
    log(entry) {
        ui.frameLog.push({ ...entry, time: new Date().toLocaleTimeString() });
        if (ui.frameLog.length > 300) ui.frameLog.splice(0, ui.frameLog.length - 300);
        renderMiscLog();
    },
};

/**
 * 给某一次渲染用的宿主：记住这条消息是在哪个存档（epoch）里挂上去的。
 * 存档换了之后，旧 iframe 迟到的调用（比如异步回调里的 setChatMessages）直接丢掉，不会改到新存档。
 */
export function frameHostFor(epoch) {
    return {
        call(method, args, messageId) {
            if (epoch !== persist.epoch) {
                console.warn(`前端卡调用 ${method} 来自已经切走的存档，已丢弃`);
                throw new Error('这条消息所在的存档已经不是当前存档');
            }
            return frameHost.call(method, args, messageId);
        },
        log(entry) { if (epoch === persist.epoch) frameHost.log(entry); },
    };
}
