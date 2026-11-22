// 前端卡 iframe 和酒馆助手脚本沙箱共用的宿主侧：酒馆助手 API 的宿主实现（hostImpl）、frameHost、楼层范围解析、斜杠命令、变量作用域。
//
// 调用方和上下文（ctx）——每个宿主方法的第一个参数，显式传，不再靠「把楼层号追加在参数末尾」：
//   {kind: 'message', messageId}               消息里的前端卡（render.js → frameHost.call）。messageId = 它所在的楼（-1 = 不知道 / 测试直接调）
//   {kind: 'script', cardId, scriptId, scriptName}   酒馆助手脚本（ui/script-host.js 的沙箱）。cardId = 沙箱建的时候的当前卡
// 两边用同一套方法、同一套参数校验和拒绝条件，不抄两份；只在少数地方按 ctx.kind 分开（脚本变量只有脚本有、日志的归属）。
//
// 变量作用域（酒馆助手 getVariables(option) 的 option.type；2026-11-23 第 2 期起真的生效，以前一律落到聊天变量）：
//   chat（默认）   state.variables.local（存档的 variables，酒馆的 chat_metadata.variables）
//   global         state.variables.global（全局记录的 globalVariables）
//   character      cardvars:<cardId>.character；没写过时读卡文件里带的初值（scripts.js cardCharacterVars）
//   script         cardvars:<cardId>.scripts[脚本 id]；没写过时读卡里这个脚本的 data（初值）。只有脚本里能用（option.script_id 不认，照酒馆助手：永远是调用者自己）
//   message        某一楼当前候选的楼层变量（ChatMessage.variables，script-sync.js messageVarsOf / setMessageVars）。
//                  message_id 不给 / 'latest'：读 = 最后一条没隐藏的楼，写 = 最后一楼（酒馆助手就是这样不对称的）；数字可以是负数（从末尾数）
//   preset / extension   SmallTalk 不支持：读到 {}、写被忽略，各记一次日志
// 合并：insertOrAssignVariables 是深合并（数组整体替换），insertVariables 只补没有的；deleteVariable 按 lodash 路径（'a.b'、'a[0]'）删，
//   返回 {variables, delete_occurred}（以前返回 boolean、只删顶层键）。规则在 vars-ops.js。
// 变量写的拒绝条件（varWriteBlocked）：正在切换（frameHost.call 已经整个拒绝）、正在恢复备份、已停止保存、只读标签页。
//   生成中【不拒绝】（宏 {{setvar}} 生成中也在写，酒馆同样允许）。以前只读标签页里前端卡写变量是「改了不保存」，现在是拒绝并记日志。

import { substitute } from '../macros.js';
import { $, toast, safeJson } from './dom.js';
import { state, ui, card, save, persist, cardVarsReady, setCardVarsField } from './state.js';
import { macroContext, permanentRegex, refreshPreview } from './pipeline.js';
import { generateReply, scrollChatToEnd, chatWriteBlocked } from './chat.js';   // chatWriteBlocked：只在函数体里调用（循环依赖）
import { renderAll, renderInspector } from './shell.js';
import { renderMiscLog } from './tab-misc.js';
import { ensureMemories } from './memory.js';   // 循环依赖（memory.js 经 pipeline.js 间接导入本文件）：只在函数体里调用
import { forwardFrameEvent, emitTavernEvent } from './script-host.js';   // 循环依赖：只在函数体里调用
import { renderScriptLog } from './tab-scripts.js';      // 同上
import { invalidateTurnAt, invalidateAfterDelete, isHidden, setHidden } from '../memory-fold.js';
import { resolveMessageId } from '../frame-args.js';
import { varOps } from '../vars-ops.js';
import { messageVarsOf, setMessageVars } from '../script-sync.js';
import { cardScripts, flattenScripts, cardCharacterVars } from '../scripts.js';
import { restoreActive } from './backup.js';   // 循环依赖：只在函数体里调用

// ───────────────────────────── 前端卡 iframe 的宿主侧 ─────────────────────────────

/** 酒馆助手 getChatMessages 的返回形状。is_hidden 就是酒馆的 is_system（我们的 ChatMessage.hidden）；data = 这一楼当前候选的楼层变量 */
export const toTavernMessage = (msg, i) => ({
    message_id: i, name: msg.name, role: msg.role, is_hidden: isHidden(msg), message: msg.content, data: structuredClone(messageVarsOf(msg)), extra: {},
});

/**
 * getChatMessages 的筛选（酒馆助手 JS-Slash-Runner 的 GetChatMessagesOption：
 *   role?: 'all'|'system'|'assistant'|'user'，默认 'all'；hide_state?: 'all'|'hidden'|'unhidden'，默认 'all'——
 *   也就是默认【包含】隐藏的楼，每条带 is_hidden）。include_swipes 没实现（照旧只给当前候选）。
 * option 不是对象（比如旧代码里被追加进来的楼层号）当作没给。
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

/** 给测试和旧代码直接调用 hostMethods 时用的上下文：一个不知道在哪一楼的前端卡 */
const ANON = Object.freeze({ kind: 'message', messageId: -1 });

/** 往日志里记一条，归属按调用方：前端卡记楼层号，脚本记脚本 id 和名字 */
function hostLog(ctx, level, text) {
    if (ctx?.kind === 'script') frameHost.log({ scriptId: ctx.scriptId, scriptName: ctx.scriptName, cardId: ctx.cardId, level, text });
    else frameHost.log({ messageId: ctx?.messageId ?? -1, level, text });
}

/** 极简斜杠命令：只认卡片按钮最常用的 /send /trigger /setinput，用 | 串联 */
export async function runSlash(command, ctx = ANON) {
    for (const part of String(command).split('|').map(s => s.trim()).filter(Boolean)) {
        const [, name, arg = ''] = part.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
        // 会改聊天 / 触发发送的命令：拒绝条件和别的改聊天的接口一样（见 writeBlocked）；被拒绝时这一串后面的也不做
        if ((name === 'send' || name === 'trigger') && writeBlocked(ctx, `斜杠命令 /${name}`)) return '';
        if (name === 'send') {
            state.chat.push({ role: 'user', name: state.persona.name || 'User', content: arg });
            emitTavernEvent('message_sent', state.chat.length - 1);   // 酒馆 /send（slash-commands.js ~6107）：MESSAGE_SENT、画出来、USER_MESSAGE_RENDERED
            save(); renderAll(); scrollChatToEnd();
            emitTavernEvent('user_message_rendered', state.chat.length - 1);
        } else if (name === 'trigger') {
            await generateReply();
        } else if (name === 'setinput') {
            $('#input').value = arg; refreshPreview();
        } else {
            hostLog(ctx, 'unimplemented', `斜杠命令未实现：${part}`);
        }
    }
    return '';
}

/**
 * 卡脚本传来的楼层号 → 下标（规则见 frame-args.js resolveMessageId：整数或数字字符串，负数从末尾数，必须落在 0..楼数−1）。
 * 不合法的返回 null 并记一条日志；调用方整条跳过。所有按楼层号取消息的宿主方法都走这里，绝不直接拿卡传来的值当下标
 */
function msgIndex(ctx, id, method) {
    const i = resolveMessageId(id, state.chat.length);
    if (i === null) hostLog(ctx, 'warn', `${method}：楼层号 ${safeJson(id)} 不合法（应为 0–${state.chat.length - 1} 的整数，负数从末尾数），这一条跳过`);
    return i;
}

/** 脚本的调用：沙箱是给哪张卡建的，现在还是不是那张卡（换卡后迟到的调用不能改到新卡上） */
function staleScript(ctx) {
    return ctx?.kind === 'script' && ctx.cardId !== persist.cardId;
}

/**
 * 改聊天内容之前问一句（chat.js chatWriteBlocked：正在生成、正在恢复备份、已停止保存、只读、正在切换 / 旧存档）。
 * 被拒绝时记一条日志、返回 true，调用方整个调用都不做——不做一半：生成中插进来的楼会让失败分支删错楼，
 * 删掉的楼会让回复写到别的位置（复核实测过）。
 */
let lastBlockedToast = 0;
function writeBlocked(ctx, method) {
    const why = staleScript(ctx) ? '' : chatWriteBlocked(persist.epoch);
    if (why === null) return false;
    hostLog(ctx, 'warn', `${method} 没有执行：${why || '正在切换存档 / 角色卡'}`);
    // 多半是用户点了卡里的按钮（选开场白之类）：只记日志的话看起来就是「点了没反应」，所以把原因弹出来。
    // 卡也可能用定时器反复调，5 秒内只弹一次
    if (why && Date.now() - lastBlockedToast > 5000) { lastBlockedToast = Date.now(); toast(why, 'error'); }
    // 脚本：让它的 await 收到拒绝（它能知道没改成）。前端卡照旧静默返回 undefined（现有的卡没有 catch，改成拒绝只会多一条未处理的错误）
    if (ctx?.kind === 'script') throw new Error(`${method} 没有执行：${why || '正在切换存档 / 角色卡'}`);
    return true;
}

// ───────────────────────────── 变量作用域 ─────────────────────────────

/** 现在能不能写变量；能 → null，不能 → 原因 */
function varWriteBlocked(ctx) {
    if (staleScript(ctx)) return '角色卡已经换了';
    if (ui.switching) return '正在切换存档';
    if (restoreActive()) return '正在恢复，请稍等';
    if (persist.stopped) return '已停止保存';
    if (persist.readOnly) return '这个标签页是只读的';
    return null;
}

/** 同一条「不支持」只记一次（按调用方 + 内容） */
const saidOnce = new Set();
function logOnce(ctx, level, text) {
    const key = `${ctx?.kind === 'script' ? 's:' + ctx.scriptId : 'm'}|${text}`;
    if (saidOnce.has(key)) return;
    if (saidOnce.size > 2000) saidOnce.clear();
    saidOnce.add(key);
    hostLog(ctx, level, text);
}

/**
 * option → 作用域 {kind, index?, scriptId?}。不合法抛错（调用方的 Promise 会 reject，错误文字进日志）。
 * write：写的时候 message 的 'latest' 指最后一楼（读的时候指最后一条没隐藏的楼），照酒馆助手
 */
function resolveScope(ctx, option, method, write) {
    const o = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
    const type = o.type === undefined ? 'chat' : o.type;
    switch (type) {
        case 'chat': case 'global': return { kind: type };
        case 'character':
            if (!persist.cardId) throw new Error(`${method}：当前没有打开角色卡，没有角色卡变量`);
            return { kind: 'character' };
        case 'script':
            if (ctx?.kind !== 'script') throw new Error(`${method}：{type: 'script'} 只能在酒馆助手脚本里用，前端卡里没有脚本变量`);
            if (typeof ctx.scriptId !== 'string' || !ctx.scriptId) throw new Error(`${method}：SmallTalk 没法确定是哪个脚本在调用，没有脚本变量`);
            return { kind: 'script', scriptId: ctx.scriptId };
        case 'message': {
            const len = state.chat.length;
            if (!len) throw new Error(`${method}：聊天里还没有消息，没有楼层变量`);
            let index;
            if (o.message_id === undefined || o.message_id === 'latest') {
                if (write) index = len - 1;
                else { index = -1; for (let i = len - 1; i >= 0; i--) if (!isHidden(state.chat[i])) { index = i; break; } }
                if (index < 0) return { kind: 'empty' };   // 全都隐藏了：读到 {}
            } else {
                index = resolveMessageId(o.message_id, len);
                if (index === null) throw new Error(`${method}：楼层号 ${safeJson(o.message_id)} 超出了范围 [${-len}, ${len})`);
            }
            return { kind: 'message', index };
        }
        case 'preset': case 'extension':
            logOnce(ctx, 'unimplemented', `${method}({type: '${type}'})：SmallTalk ${type === 'preset' ? '暂不支持预设变量' : '不支持扩展变量'}，读到的是 {}、写入被忽略`);
            return { kind: 'empty' };
        default:
            throw new Error(`${method}：不认识的变量类型 ${safeJson(type)}（应为 chat / global / character / script / message）`);
    }
}

/** 卡里这个脚本带的 data（脚本变量的初值） */
function scriptInitialData(scriptId) {
    const s = flattenScripts(cardScripts(state.card)).find(x => x.id === scriptId);
    return varOps.isPlain(s?.data) ? s.data : {};
}

/** 角色卡 / 脚本变量要等这张卡的 cardvars 读回来；别的作用域马上做（保持同步，现有代码和测试会同步读结果） */
function withScope(scope, fn) {
    if ((scope.kind === 'character' || scope.kind === 'script') && persist.cardVars === undefined) return cardVarsReady().then(fn);
    return fn();
}

/** 作用域现在的表（不拷贝，只读）。script-host.js 推副本时也用它（{kind:'chat'|'global'|'character'} / {kind:'script', scriptId}） */
export function readScope(scope) {
    switch (scope.kind) {
        case 'chat': return state.variables.local ?? {};
        case 'global': return state.variables.global ?? {};
        case 'character': return persist.cardVars?.character ?? cardCharacterVars(card().raw);
        case 'script': {
            const s = persist.cardVars?.scripts;
            return s && Object.hasOwn(s, scope.scriptId) ? s[scope.scriptId] : scriptInitialData(scope.scriptId);
        }
        case 'message': return messageVarsOf(state.chat[scope.index]);
        default: return {};
    }
}

/** 整张表换成 value（value 已清洗）。存盘、刷新检查器的变量显示 */
function writeScope(scope, value) {
    switch (scope.kind) {
        case 'chat': state.variables.local = value; break;
        case 'global': state.variables.global = value; break;
        case 'character': setCardVarsField('character', value); break;
        case 'script': setCardVarsField('scripts', { ...(persist.cardVars?.scripts ?? {}), [scope.scriptId]: value }); break;
        case 'message': setMessageVars(state.chat[scope.index], value); break;
        default: return;   // empty：忽略
    }
    save();
    if (scope.kind === 'chat' || scope.kind === 'global') renderInspector();
}

/** 外来的变量表：必须是普通对象；清洗（任何一层的危险键丢掉、限大小）。不合法抛错 */
function cleanVars(ctx, vars, method) {
    if (!varOps.isPlain(vars)) throw new Error(`${method}：变量必须是一个对象`);
    const r = varOps.sanitize(vars);
    if (!r.ok) throw new Error(`${method}：${r.error}`);
    if (r.dropped) hostLog(ctx, 'warn', `${method}：${r.dropped} 个变量名（__proto__ / constructor / prototype）不允许，已忽略`);
    return r.value;
}

/** 变量写的公共流程：解析作用域 → 拒绝条件 → 等 cardvars → 算新表 → 写 → 返回 compute 的结果 */
function varWrite(ctx, option, method, compute) {
    const scope = resolveScope(ctx, option, method, true);
    const why = varWriteBlocked(ctx);
    if (why) { hostLog(ctx, 'warn', `${method} 没有执行：${why}`); throw new Error(`${method} 没有执行：${why}`); }
    return withScope(scope, () => {
        if (varWriteBlocked(ctx)) throw new Error(`${method} 没有执行：${varWriteBlocked(ctx)}`);   // 等 cardvars 的期间可能换了卡
        if (scope.kind === 'message' && !state.chat[scope.index]) throw new Error(`${method}：这一楼已经不在了`);
        const { next, result } = compute(readScope(scope));
        if (next !== undefined) writeScope(scope, next);
        return result;
    });
}

const vclone = v => structuredClone(v ?? {});

// ───────────────────────────── 宿主方法 ─────────────────────────────
// 每个方法：(ctx, ...卡传来的参数)。卡传来的参数什么都可能是，一律校验。

const hostImpl = {
    getChatMessages: (ctx, range, option) => filterTavern(parseRange(range).map(i => toTavernMessage(state.chat[i], i)), option),
    setChatMessages: (ctx, updates) => {
        if (writeBlocked(ctx, 'setChatMessages')) return;
        // 先把楼层号校验、换算好（不合法的整条跳过），后面只用换算后的下标
        const list = [];
        for (const u of [].concat(updates ?? [])) {
            if (!u || typeof u !== 'object') continue;
            const i = msgIndex(ctx, u.message_id, 'setChatMessages');
            if (i !== null) list.push({ u, i });
        }
        // is_hidden（酒馆助手 setChatMessages 可以改它，对应酒馆的 is_system）：先收集，最后一次性走 setHidden，
        // 和界面上的「隐藏 / 取消隐藏」同一条路（只改标记、不碰记忆，规则见 memory-fold.js 文件头「隐藏楼层」）
        const hideIds = [], showIds = [];
        for (const { u, i } of list) if (typeof u.is_hidden === 'boolean') (u.is_hidden ? hideIds : showIds).push(i);
        // 拒绝条件和界面上的按钮一样（正在生成、正在恢复备份、已停止保存、只读），开头的 writeBlocked 已经整个拦过了
        if (hideIds.length || showIds.length) {
            setHidden(state.chat, hideIds, true);
            const shown = setHidden(state.chat, showIds, false).changed.length;
            ui.previewIsSent = false;
            if (shown) setTimeout(ensureMemories, 0);   // 同界面：只有取消隐藏才可能多出待压缩的轮
        }
        for (const { u, i } of list) {
            const m = state.chat[i];
            // 原文真的变了：这一轮的摘要作废重压（和手动编辑同一条规则，见 memory-fold.js）
            if (typeof u.message === 'string') {
                if (m.content !== u.message) { m.content = u.message; invalidateTurnAt(state.chat, i); setTimeout(ensureMemories, 0); }
                ui.rendered.delete(i);
            }
            // data = 这一楼当前候选的楼层变量（整张换掉；酒馆助手 setChatMessages 也是整张换）。不碰原文，所以不作废记忆
            if (u.data !== undefined) {
                if (varOps.isPlain(u.data)) {
                    const r = varOps.sanitize(u.data);
                    if (r.ok) setMessageVars(m, r.value); else hostLog(ctx, 'warn', `setChatMessages：第 ${i} 楼的 data 没有写入（${r.error}）`);
                } else hostLog(ctx, 'warn', `setChatMessages：第 ${i} 楼的 data 不是对象，没有写入`);
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
    setChatMessage: (ctx, update, messageId) => hostImpl.setChatMessages(ctx, [{ message_id: messageId, ...(typeof update === 'string' ? { message: update } : (update && typeof update === 'object' ? update : {})) }]),
    getLastMessageId: () => state.chat.length - 1,

    getVariables: (ctx, option) => { const s = resolveScope(ctx, option, 'getVariables', false); return withScope(s, () => vclone(readScope(s))); },
    replaceVariables: (ctx, vars, option) => {
        const v = cleanVars(ctx, vars, 'replaceVariables');
        return varWrite(ctx, option, 'replaceVariables', () => ({ next: v, result: undefined }));
    },
    insertOrAssignVariables: (ctx, vars, option) => {
        const v = cleanVars(ctx, vars, 'insertOrAssignVariables');
        return varWrite(ctx, option, 'insertOrAssignVariables', cur => { const next = varOps.merge(cur, v); return { next, result: vclone(next) }; });
    },
    insertVariables: (ctx, vars, option) => {
        const v = cleanVars(ctx, vars, 'insertVariables');
        return varWrite(ctx, option, 'insertVariables', cur => { const next = varOps.insert(cur, v); return { next, result: vclone(next) }; });
    },
    // 酒馆助手：按 lodash 路径删，返回 {variables: 删后的整张表, delete_occurred}。路径不合法 / 有危险键：不删，记日志
    deleteVariable: (ctx, path, option) => varWrite(ctx, option, 'deleteVariable', cur => {
        const r = varOps.unset(cur, path);
        if (r.bad) hostLog(ctx, 'warn', `deleteVariable：路径 ${safeJson(path)} 不合法（或含 __proto__ / constructor / prototype），没有删`);
        return { next: r.deleted ? r.value : undefined, result: { variables: vclone(r.value), delete_occurred: r.occurred } };   // 照 lodash unset：没有的路径也是 true
    }),
    /** 酒馆助手 getAllVariables：全局 → 角色卡 →（脚本里）脚本 → 聊天 →（前端卡里）0 楼到本楼的楼层变量，后面的同名变量盖前面的（浅合并） */
    getAllVariables: (ctx) => {
        const go = () => {
            const out = {};
            const add = t => { for (const [k, v] of Object.entries(t ?? {})) if (k !== '__proto__') out[k] = v; };
            add(readScope({ kind: 'global' }));
            if (persist.cardId) add(readScope({ kind: 'character' }));
            if (ctx?.kind === 'script') add(readScope({ kind: 'script', scriptId: ctx.scriptId }));
            add(readScope({ kind: 'chat' }));
            if (ctx?.kind === 'message') for (let i = 0; i <= Math.min(ctx.messageId, state.chat.length - 1); i++) add(messageVarsOf(state.chat[i]));
            return vclone(out);
        };
        return persist.cardId && persist.cardVars === undefined ? cardVarsReady().then(go) : go();
    },

    triggerSlash: (ctx, command) => runSlash(command, ctx),
    substitudeMacros: (ctx, text) => substitute(String(text ?? ''), macroContext(state.chat, structuredClone(state.variables))),
    // name：不给 / 'current' / 这张卡的名字 → 这张卡；别的名字（别的卡）→ null（我们只给当前卡）
    getCharData: (ctx, name) => (name === undefined || name === null || name === 'current' || name === card().name ? structuredClone(card().raw) : null),
    getContextSnapshot: () => ({
        name1: state.persona.name, name2: card().name, characterId: 0, chatId: 'smalltalk',
        // is_system 照酒馆的含义 = 隐藏楼层（旁白在酒馆里 is_system 是 false）
        chat: state.chat.map((m, i) => ({ name: m.name, is_user: m.role === 'user', is_system: isHidden(m), mes: m.content, message_id: i })),
    }),
    createChatMessages: (ctx, msgs) => {
        // 被拒绝时整个调用都不建（含 is_hidden: true 的：不能退成「建一条不隐藏的」，那样卡想藏起来的内容会被发给模型）
        if (writeBlocked(ctx, 'createChatMessages')) return;
        const list = [].concat(msgs ?? []);
        for (const m of list) {
            if (typeof m?.message !== 'string') continue;
            const role = ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'assistant';
            const msg = { role, name: typeof m.name === 'string' ? m.name : (role === 'user' ? state.persona.name : card().name), content: m.message };
            if (m.is_hidden === true) msg.hidden = true;   // 酒馆助手 createChatMessages 也能直接建隐藏的楼
            if (varOps.isPlain(m.data)) { const r = varOps.sanitize(m.data); if (r.ok) msg.variables = [r.value]; }
            state.chat.push(msg);
        }
        ui.rendered.clear(); save(); renderAll(); scrollChatToEnd();
    },
    deleteChatMessages: (ctx, ids) => {
        if (writeBlocked(ctx, 'deleteChatMessages')) return;
        // 楼层号同样校验、换算（负数从末尾数）；不合法的跳过
        const drop = new Set();
        for (const id of [].concat(ids ?? [])) { const i = msgIndex(ctx, id, 'deleteChatMessages'); if (i !== null) drop.add(i); }
        if (!drop.size) return;
        // 前端卡可以单删任意一楼（酒馆的接口就是这样）：删掉的楼后面那一轮变了（少了输入，或两轮并成一轮），它的摘要作废重压
        invalidateAfterDelete(state.chat, drop); setTimeout(ensureMemories, 0);
        state.chat = state.chat.filter((_, i) => !drop.has(i));
        ui.rendered.clear(); $('#chat').replaceChildren(); save(); renderAll();
        emitTavernEvent('message_deleted', state.chat.length);   // 酒馆：删完之后的楼数
    },
    getCharAvatarPath: () => state.avatar || null,   // data URL，本身就是绝对地址
    // 前端卡之间的转发 render.js 已经做了；这里再转给脚本沙箱（脚本发的事件由 script-host.js 转给前端卡，不经过这里）
    eventEmit: (ctx, name, ...args) => { if (ctx?.kind !== 'script' && typeof name === 'string') forwardFrameEvent(name, args); },
    // 卡 / 脚本的提示条（2026-11-23 安全复核）：文字前面标明来源、一律用中性样式（不用主页面「错误」的红），免得冒充「接口 key 失效，请重填」这类系统提示。
    // 限频：脚本沙箱在 script-host.js 按沙箱限（10 秒 5 条）；前端卡在这里合起来限（10 秒 5 条）；同屏条数 dom.js toast 另有上限
    toastr: (ctx, kind, text) => {
        const body = String(text ?? '').slice(0, 300);
        if (ctx?.kind === 'script') return toast(`脚本「${ctx.scriptName ?? '?'}」：${body}`, 'from-card');
        const now = Date.now();
        while (frameToastTimes.length && now - frameToastTimes[0] > 10000) frameToastTimes.shift();
        if (frameToastTimes.length >= 5) { hostLog(ctx, 'info', `提示条太多，没显示：${body.slice(0, 200)}`); return; }
        frameToastTimes.push(now);
        toast(`前端卡：${body}`, 'from-card');
    },
};
const frameToastTimes = [];

/** 宿主方法的名单（render.js 的前端卡白名单 BRIDGED_API、script-stub.js 的脚本白名单都是它的子集） */
export const HOST_METHOD_NAMES = Object.freeze(Object.keys(hostImpl));

/**
 * 按名字调一个宿主方法。不认识的名字记一条 unimplemented、返回 undefined。正在切换存档时抛错（这时的调用不知道该落在哪个存档里）。
 * @param {string} method
 * @param {any[]} args
 * @param {{kind: 'message', messageId: number} | {kind: 'script', cardId: string, scriptId: string, scriptName?: string}} ctx
 */
export function callHost(method, args, ctx) {
    if (ui.switching) throw new Error('正在切换存档，这次调用没有执行');
    if (staleScript(ctx)) throw new Error('角色卡已经换了，这次调用没有执行');
    const fn = Object.hasOwn(hostImpl, method) ? hostImpl[method] : null;
    if (!fn) {
        hostLog(ctx, 'unimplemented', `${method}(${safeJson(args)})`);
        return undefined;
    }
    return fn(ctx, ...(Array.isArray(args) ? args : []));
}

/**
 * 旧的直接调用口（浏览器测试、调试用）：参数和卡调用时一样，上下文是「不知道在哪一楼的前端卡」。
 * 不经过 callHost 的切换检查（和以前一样）。
 */
export const hostMethods = Object.fromEntries(HOST_METHOD_NAMES.map(name => [name, (...args) => hostImpl[name](ANON, ...args)]));

/** 日志的总条数上限（前端卡和脚本合在一起；「杂项」页显示最后 120 条，「脚本」页只显示脚本的） */
const LOG_LIMIT = 500;

export const frameHost = {
    call(method, args, messageId) {
        return callHost(method, args, { kind: 'message', messageId: Number.isInteger(messageId) ? messageId : -1 });
    },
    /** entry：{messageId, level, text}（前端卡）或 {scriptId, scriptName, level, text}（脚本） */
    log(entry) {
        ui.frameLog.push({ ...entry, time: new Date().toLocaleTimeString() });
        if (ui.frameLog.length > LOG_LIMIT) ui.frameLog.splice(0, ui.frameLog.length - LOG_LIMIT);
        renderMiscLog();
        if (entry.scriptId !== undefined) renderScriptLog();
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
