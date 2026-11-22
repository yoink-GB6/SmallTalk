// 酒馆助手脚本的「同步副本」：宿主把聊天记录等推给脚本沙箱，沙箱里同步读本地副本（docs/tavern-helper-plan.md §3.1）。
// 这里是纯函数：消息 → 副本里的一楼、两份聊天的首尾比对（diffChat）、把补丁应用到副本上（chatSyncFactory().applyOps），
// 以及楼层变量（ChatMessage.variables）的读写。浏览器和 Node 都能直接加载。
//
// 为什么要比对而不是每次全量推：几千楼的聊天全量结构化克隆一次是几十毫秒、几 MB，而改动通常只是「末尾加一楼」「改了一楼」。
// 宿主记一份「上次推出去的影子」（每楼几个字段：消息对象的引用、原文、名字、角色、隐藏、当前候选、候选数、楼层变量对象的引用），
// 从头、从尾各走一遍找到第一处不同，中间那段就是一个 splice 补丁。追加、截断、改一楼、删一楼、插一楼都是一个小补丁。
//
// chatSyncFactory 是【自包含】的（不引用本模块的任何东西）：script-stub.js 把它的源码原样内联进沙箱，
// 所以函数体里不能出现字面的 `</script` 或 `<!--`。
//
// 楼层变量（酒馆助手 getVariables({type:'message'})，酒馆聊天文件每楼的 variables 字段，按候选各一份的数组）：
//   存在 ChatMessage.variables（types.js）。从酒馆 .jsonl 导入的消息原来放在 st.variables 里（我们不认识的字段原样留在 st）：
//   读的时候两处都认；第一次写时把它从 st 提升到 ChatMessage.variables（和 ensureSwipes 提升 swipes 一样），导出 .jsonl 时写回 variables。

import { readSwipes } from './chatfile.js';
import { varOps } from './vars-ops.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 这一楼当前是第几个候选（没有候选 = 0） */
function swipeIndex(msg) {
    const s = readSwipes(msg);
    return s ? s.id : 0;
}

/** 楼层变量的原始容器：ChatMessage.variables 优先，没有就看导入时留在 st 里的；都没有 = null */
function varsContainer(msg) {
    if (msg && msg.variables !== undefined) return msg.variables;
    if (isObj(msg?.st) && msg.st.variables !== undefined) return msg.st.variables;
    return null;
}

/** 当前候选的楼层变量对象本身（不拷贝；没有 = undefined）。容器是数组或「以候选下标为键的对象」（酒馆助手两种都认） */
function rawMessageVars(msg) {
    const c = varsContainer(msg);
    if (c === null || typeof c !== 'object') return undefined;
    const v = c[swipeIndex(msg)];
    return varOps.isPlain(v) ? v : undefined;
}

/** 这一楼当前候选的楼层变量（只读；没有 = {}，每次都是同一个冻结的空对象之外的新对象，调用方不要改它） */
export function messageVarsOf(msg) {
    return rawMessageVars(msg) ?? {};
}

/**
 * 写这一楼当前候选的楼层变量（value 已经清洗过）。照酒馆助手 replaceVariables({type:'message'})：
 * 没有容器 → 建一个和候选数一样长、每格 {} 的数组；容器是对象 → 转成数组；然后换掉当前候选那一格。
 * 每次都换成【新的】数组和对象（diffChat 按引用判断这一楼的变量变没变）。
 */
export function setMessageVars(msg, value) {
    const n = Math.max(1, Array.isArray(msg.swipes) ? msg.swipes.length : (readSwipes(msg)?.swipes.length ?? 1));
    const old = varsContainer(msg);
    const arr = [];
    const len = Math.max(n, Array.isArray(old) ? old.length : 0);
    for (let i = 0; i < len; i++) {
        const x = old !== null && typeof old === 'object' ? old[i] : undefined;
        arr.push(varOps.isPlain(x) ? x : {});
    }
    arr[swipeIndex(msg)] = value;
    msg.variables = arr;
    if (isObj(msg.st) && msg.st.variables !== undefined) delete msg.st.variables;   // 提升出来了，导出时由 chatfile.js 写回
}

/**
 * 一楼 → 副本里的样子（酒馆助手 getChatMessages 的形状，再加 swipe_id / swipes）。
 * 不带记忆摘要、st 里的东西（脚本用不到，也省流量）。
 * @param {import('./types.js').ChatMessage} msg
 * @param {number} i
 */
export function mirrorMessage(msg, i) {
    const s = readSwipes(msg);
    const content = typeof msg?.content === 'string' ? msg.content : '';
    return {
        message_id: i,
        name: typeof msg?.name === 'string' ? msg.name : '',
        role: msg?.role === 'user' || msg?.role === 'system' ? msg.role : 'assistant',
        is_hidden: msg?.hidden === true,
        message: content,
        data: messageVarsOf(msg),
        extra: {},
        swipe_id: s ? s.id : 0,
        swipes: s ? s.swipes.map(x => (typeof x === 'string' ? x : '')) : [content],
    };
}

/** 影子里的一楼：判断「这一楼变没变」要看的东西 */
function fingerprint(msg) {
    return {
        ref: msg, content: msg?.content, name: msg?.name, role: msg?.role, hidden: msg?.hidden === true,
        swipeId: msg?.swipeId, nSwipes: Array.isArray(msg?.swipes) ? msg.swipes.length : -1, vars: rawMessageVars(msg),
    };
}

function same(fp, msg) {
    return fp.ref === msg && fp.content === msg?.content && fp.name === msg?.name && fp.role === msg?.role
        && fp.hidden === (msg?.hidden === true) && fp.swipeId === msg?.swipeId
        && fp.nSwipes === (Array.isArray(msg?.swipes) ? msg.swipes.length : -1) && fp.vars === rawMessageVars(msg);
}

/** 一份聊天的影子（全量推之后记下） */
export const shadowOf = chat => chat.map(fingerprint);

/**
 * 上次推出去的影子 vs 现在的聊天 → 补丁。shadow 为 null（还没推过 / 换了存档）→ 全量 {op:'chat'}。
 * @param {Object[]|null} shadow
 * @param {import('./types.js').ChatMessage[]} chat
 * @returns {{ops: Object[], shadow: Object[]}}  ops 为空 = 没变；shadow 是新的影子（调用方推送成功后换上）
 */
export function diffChat(shadow, chat) {
    if (!Array.isArray(shadow)) return { ops: [{ op: 'chat', value: chat.map(mirrorMessage) }], shadow: shadowOf(chat) };
    const n = shadow.length, m = chat.length;
    let i = 0;
    while (i < n && i < m && same(shadow[i], chat[i])) i++;
    if (i === n && i === m) return { ops: [], shadow };
    let j = 0;
    while (j < n - i && j < m - i && same(shadow[n - 1 - j], chat[m - 1 - j])) j++;
    const items = [];
    for (let k = i; k < m - j; k++) items.push(mirrorMessage(chat[k], k));
    const next = shadow.slice(0, i).concat(chat.slice(i, m - j).map(fingerprint), shadow.slice(n - j));
    return { ops: [{ op: 'splice', start: i, del: n - i - j, items }], shadow: next };
}

/**
 * 沙箱里应用补丁（自包含，见文件头）。M = {chat, vars: {chat, global, character, script: {id: 表}}, card, ctx}。
 *   {op:'chat', value}                  整份换
 *   {op:'splice', start, del, items}    中间换一段；之后的楼层号重排
 *   {op:'vars', scope, id?, value}      一个作用域整个换（script 带脚本 id）
 *   {op:'card', value} / {op:'ctx', value}
 */
export function chatSyncFactory() {
    function applyOps(M, ops) {
        for (var i = 0; i < ops.length; i++) {
            var o = ops[i];
            if (!o || typeof o !== 'object') continue;
            if (o.op === 'chat') M.chat = Array.isArray(o.value) ? o.value : [];
            else if (o.op === 'splice') {
                var start = o.start | 0, del = o.del | 0;
                M.chat = M.chat.slice(0, start).concat(Array.isArray(o.items) ? o.items : [], M.chat.slice(start + del));
                for (var k = start; k < M.chat.length; k++) if (M.chat[k]) M.chat[k].message_id = k;
            } else if (o.op === 'vars') {
                if (o.scope === 'script') M.vars.script[String(o.id)] = o.value;
                else M.vars[o.scope] = o.value;
            } else if (o.op === 'card') M.card = o.value;
            else if (o.op === 'ctx') M.ctx = o.value;
        }
        return M;
    }
    return { applyOps: applyOps };
}

export const { applyOps } = chatSyncFactory();
