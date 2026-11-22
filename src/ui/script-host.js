// 酒馆助手脚本的宿主侧（2026-11-23 第 2 期：沙箱运行时 + 同步副本 + 变量作用域；方案 docs/tavern-helper-plan.md §3.1、§3.5–§3.7）。
// 沙箱里的桩在 src/script-stub.js，副本的比对 / 补丁在 src/script-sync.js，宿主方法（和消息里的前端卡共用）在 ui/frame-host.js。
//
// ── 沙箱 ──
//   一张卡一个：<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">（和前端卡的 FRAME_SANDBOX 一样，【绝不】给 allow-same-origin：
//   opaque origin，读不到我们的 IndexedDB / localStorage、碰不到主页面的 DOM 和 JS 对象），srcdoc 里只有桩和库，脚本代码走 postMessage 进去、用 Blob URL 加载。
//   iframe 挂在聊天区（#chat-pane）里、这一期完全不可见（.script-sandbox：零尺寸、不接收指针）。第 5 期的悬浮区只盖聊天区（用户定的：
//   脚本不能在右侧面板 / 顶栏上画东西，免得画一个假的「接口」页骗人填 key），所以位置现在就定在这里。
//
// ── 通信（都带 smalltalk: true 和这个沙箱的随机 frameId；宿主收到的每条都先核对 event.source === 沙箱的 window 且 frameId 对得上）──
//   沙箱 → 宿主：ready（库加载完）、call（RPC，方法白名单 SCRIPT_BRIDGED、脚本 id 只认登记过的，见 script-args.js）、log、status（某个脚本跑起来了 / 出错了）
//   宿主 → 沙箱：boot（整份副本 + 脚本代码）、sync（补丁）、event（事件）、result（RPC 结果）
//   两条保序规则（postMessage 对同一个窗口保序）：先推副本再发事件（emitScriptEvent 里先 flush）；先推副本再回结果（handleCall 里先 flush）。
//   所以脚本在事件回调里、在 await setChatMessages(...) 之后同步读到的一定是新的。
//
// ── 副本什么时候推（flushScripts）──
//   state.js save() 每次被调都通知这里（persist.onSave），合并到一个微任务里做一次：聊天做首尾比对（script-sync.js diffChat），
//   变量按作用域和上次推出去的 JSON 比，卡和上下文按引用 / JSON 比，有变化才发一条 sync。不去追几十个改动入口——它们最后都会 save()。
//   事件和 RPC 结果之前也各 flush 一次（见上面的保序规则）。
//
// ── 生命周期（reconcileScripts，shell.js renderAll 末尾调；改了脚本的地方调 restartScripts）──
//   页面打开 / 换卡 / 「更新」同名卡（卡对象换了）  → 拆掉旧的，按新卡建（新卡没有启用的脚本就不建）
//   同一张卡换存档 / 新对话 / 删当前存档落到另一个   → 不重建：推整份新聊天 + 新的聊天变量，然后发 CHAT_CHANGED(存档 id)
//   「脚本」页开关 / 保存代码 / 改名 / 增删 / 重新运行、脚本自己 reloadIframe() → 重建（restartScripts：启用的脚本和代码都没变就不动）
//   删卡 / 没卡                                       → 拆
//   恢复整体备份 / 酒馆 zip 导入期间                   → 拆（ui/backup.js 一开始就调 stopScripts），结束后按当前卡重建
//   只读标签页 / 已停止保存                            → 不建（两个标签页各跑一份，自动总结之类的脚本会重复触发、重复花额度）
//   正在切换（ui.switching）                          → 先不动，切换完再来（这期间沙箱发来的调用 callHost 本来就拒绝）
//   生成中                                            → 照常运行，改聊天的调用被拒（frame-host.js writeBlocked）
//   页面关掉                                          → iframe 跟着没了
//   拆 = 把 iframe 从 DOM 里移除：它的文档整个卸载，定时器、监听、Blob URL（Blob URL 跟着创建它的文档走）一起没了；
//   宿主这边的 message 监听用 AbortController 一起摘掉。原型里核实过：移除时沙箱里会收到 pagehide，之后定时器不再触发。
//
// ── 上下文 ──
//   每次 RPC 的 ctx = {kind: 'script', cardId: 建沙箱时的卡, scriptId: 沙箱说是哪个脚本（只认登记过的）, scriptName}。
//   换卡后迟到的调用：cardId 对不上，callHost 拒绝。
//
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { FRAME_SANDBOX, emitFrameEvent } from '../render.js';
import { buildScriptSrcdoc } from '../script-stub.js';
import { diffChat } from '../script-sync.js';
import { parseSandboxMessage, scrubSecrets } from '../script-args.js';
import { cardScripts, enabledScriptsOf, stripCodeFence } from '../scripts.js';
import { state, ui, persist, card, cardVarsReady } from './state.js';
import { callHost, frameHost, readScope } from './frame-host.js';   // 循环依赖：只在函数体里调用
import { restoreActive } from './backup.js';                        // 同上
import { paintScriptStatus } from './tab-scripts.js';               // 同上

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// ───────────────────────────── 状态 ─────────────────────────────

/** 当前沙箱；null = 没有 */
let rec = null;
/** 为什么没在跑（给「脚本」页看）：'running' | 'nocard' | 'none' | 'readonly' | 'stopped' | 'restoring' */
let runState = 'nocard';
let flushQueued = false;
let retryTimer = null;

function randomToken() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 启用的脚本（按卡对象缓存：renderAll 很频繁，没改过的卡每次从 raw 解析一遍不划算）。
 * 「脚本」页原地改 state.card.scripts（开关等），所以它改完调 restartScripts，那里先清掉缓存
 */
let enabledCache = { cardObj: null, scriptsRef: undefined, list: [] };
function enabledNow() {
    const c = state.card;
    if (enabledCache.cardObj !== c || enabledCache.scriptsRef !== c?.scripts) {
        enabledCache = { cardObj: c, scriptsRef: c?.scripts, list: c ? enabledScriptsOf(cardScripts(c)).filter(s => !UNSAFE_IDS.has(s.id)) : [] };
    }
    return enabledCache.list;
}

/** 现在该不该跑；该跑返回 {list}（要装的脚本），不该返回原因 */
function wanted() {
    if (!state.card || !persist.cardId) return 'nocard';
    if (persist.readOnly) return 'readonly';
    if (persist.stopped) return 'stopped';
    if (persist.paused || restoreActive()) return 'restoring';
    const list = enabledNow();
    return list.length ? { list } : 'none';
}

const signature = list => JSON.stringify(list.map(s => [s.id, s.name, s.content]));

// ───────────────────────────── 建 / 拆 ─────────────────────────────

function teardown() {
    if (!rec) return;
    const r = rec;
    rec = null;
    r.ac.abort();
    r.iframe.remove();
}

/** 建一个新沙箱装 list 里的脚本（先拆旧的） */
function build(list) {
    teardown();
    const host = document.querySelector('#chat-pane') ?? document.body;
    const frameId = randomToken();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', '酒馆助手脚本');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.className = 'script-sandbox';
    iframe.dataset.fk = 'script-sandbox';
    const ac = new AbortController();
    const scripts = new Map(list.map(s => [s.id, { id: s.id, name: s.name || '(未命名)' }]));
    rec = {
        cardId: persist.cardId, cardObj: state.card, frameId, iframe, ac, list, sig: signature(list), scripts, ids: new Set(scripts.keys()),
        status: new Map(list.map(s => [s.id, { status: 'loading', text: '' }])),
        booted: false, epoch: persist.epoch, shadow: null, pushed: new Map(), cardRef: null, avatarRef: null, ctxJson: null,
        logTimes: [], logMuted: false,
    };
    const me = rec;
    window.addEventListener('message', e => onMessage(me, e), { signal: ac.signal });
    iframe.srcdoc = buildScriptSrcdoc({ frameId });
    host.append(iframe);
    runState = 'running';
    paintTab();
}

/** 停掉（恢复备份开始时 ui/backup.js 调；结束后 reconcileScripts 按当前卡重建） */
export function stopScripts() {
    teardown();
    runState = 'restoring';
    paintTab();
}

/**
 * 按现在的状态决定沙箱该不该在、要不要重建、要不要推「换了存档」。shell.js renderAll 末尾调（便宜：只比引用），也给各处的「结束之后」用。
 * @param {{force?: boolean}} [o]  force：不管变没变都重建（「重新运行」、reloadIframe）
 */
export function reconcileScripts({ force = false } = {}) {
    if (ui.switching) {
        // 切换的中间态：等切完（这期间旧沙箱发来的调用都会被拒绝）
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => reconcileScripts({ force }), 50);
        return;
    }
    const sameCard = rec && rec.cardId === persist.cardId && rec.cardObj === state.card;
    if (sameCard && !force && !persist.readOnly && !persist.stopped && !persist.paused && !restoreActive()) {
        // 同一张卡：只看是不是换了存档（换了就整份重推并发 CHAT_CHANGED，见 syncEpoch）
        if (rec.booted && rec.epoch !== persist.epoch) syncEpoch(rec);
        else flushScripts();
        return;
    }
    const w = wanted();
    if (typeof w === 'string') { teardown(); runState = w; paintTab(); return; }
    build(w.list);
}

/** 「脚本」页改了脚本（开关、代码、名字、增删）：启用的脚本或它们的代码变了才重建 */
export function restartScripts() {
    enabledCache = { cardObj: null, scriptsRef: undefined, list: [] };
    const w = wanted();
    if (typeof w === 'string') { teardown(); runState = w; paintTab(); return; }
    if (rec && rec.cardId === persist.cardId && rec.cardObj === state.card && rec.sig === signature(w.list)) return;
    if (ui.switching) { reconcileScripts({ force: true }); return; }
    build(w.list);
}

// ───────────────────────────── 副本 ─────────────────────────────

/** 现在的上下文（脚本同步读的那些「不是聊天、不是变量」的东西）。不含任何接口 / 模型 / key 相关的东西 */
const ctxNow = () => ({ name1: state.persona?.name ?? 'User', name2: card().name, chatId: persist.chatId ?? null, chatName: persist.chatMeta?.name ?? '' });

/** 要推的变量作用域：[推送用的键, 作用域] */
function varScopes(r) {
    const out = [['chat', { kind: 'chat' }], ['global', { kind: 'global' }]];
    // 角色卡 / 脚本变量要等 cardvars 读回来；没读回来就先不推（读回来后下一次 flush 会推）
    if (persist.cardVars !== undefined) {
        out.push(['character', { kind: 'character' }]);
        for (const id of r.ids) out.push([`s:${id}`, { kind: 'script', scriptId: id }]);
    }
    return out;
}

/** 算出要推的补丁（不发），以及推成功之后要记下的东西 */
function collectOps(r) {
    const ops = [];
    const chat = diffChat(r.shadow, state.chat);
    ops.push(...chat.ops);
    const pushed = [];
    for (const [key, scope] of varScopes(r)) {
        const v = readScope(scope);
        const json = JSON.stringify(v);
        if (r.pushed.get(key) === json) continue;
        ops.push(scope.kind === 'script' ? { op: 'vars', scope: 'script', id: scope.scriptId, value: v } : { op: 'vars', scope: scope.kind, value: v });
        pushed.push([key, json]);
    }
    let cardChanged = false;
    if (r.cardRef !== state.card || r.avatarRef !== state.avatar) {
        ops.push({ op: 'card', value: { raw: card().raw ?? null, avatar: state.avatar || '', name: card().name } });
        cardChanged = true;
    }
    const ctx = ctxNow();
    const ctxJson = JSON.stringify(ctx);
    if (ctxJson !== r.ctxJson) ops.push({ op: 'ctx', value: ctx });
    const commit = () => {
        r.shadow = chat.shadow;
        for (const [k, j] of pushed) r.pushed.set(k, j);
        if (cardChanged) { r.cardRef = state.card; r.avatarRef = state.avatar; }
        r.ctxJson = ctxJson;
    };
    return { ops, commit };
}

function post(r, msg) {
    const win = r.iframe.contentWindow;
    if (!win) return false;
    // 目标 origin 只能写 '*'：沙箱的 origin 是 opaque 的（序列化成 "null"），没有可以填的值。可以接受：发出去的只有给这张卡的副本、
    // 它自己请求的结果和事件；就算它把自己导航到了别处，对方拿到的也只是本来就给这张卡的东西
    try { win.postMessage({ smalltalk: true, frameId: r.frameId, ...msg }, '*'); return true; } catch (e) {
        if (msg.kind === 'result') {
            try { win.postMessage({ smalltalk: true, frameId: r.frameId, kind: 'result', id: msg.id, ok: false, error: '宿主的返回值没法传进沙箱（不能结构化克隆）' }, '*'); } catch { /* ignore */ }
        }
        console.error('推给脚本沙箱失败', e?.message ?? e);
        return false;
    }
}

/** 把改动推给沙箱（同步做完）。没有沙箱 / 还没 boot / 卡已经换了：什么都不做 */
export function flushScripts() {
    flushQueued = false;
    const r = rec;
    if (!r || !r.booted || r.cardId !== persist.cardId) return;
    if (r.epoch !== persist.epoch) return;   // 换了存档：由 reconcileScripts 整份重推并发 CHAT_CHANGED
    const { ops, commit } = collectOps(r);
    if (!ops.length) return;
    if (post(r, { kind: 'sync', ops })) commit();
}

/** state.js save() 的回调：排一个微任务合并推送 */
persist.onSave = () => {
    if (!rec || flushQueued) return;
    flushQueued = true;
    queueMicrotask(flushScripts);
};

/** 某个作用域下次一定重推（变量写之后：不管宿主应用了还是拒绝了，沙箱里的乐观值都要换成权威值） */
function invalidateVars(r, scriptId) {
    r.pushed.delete('chat'); r.pushed.delete('global'); r.pushed.delete('character');
    if (scriptId) r.pushed.delete(`s:${scriptId}`);
}

/**
 * 给沙箱发一个事件（先推副本）。还没 boot 的沙箱收不到（那时脚本还没开始监听）。
 * 第 2 期只发：CHAT_CHANGED（换存档，reconcileScripts）、MESSAGE_SENT、MESSAGE_RECEIVED（chat.js）。完整的酒馆事件是第 3 期
 */
export function emitScriptEvent(name, ...args) {
    const r = rec;
    if (!r || !r.booted || r.cardId !== persist.cardId) return;
    if (r.epoch !== persist.epoch) syncEpoch(r);   // 换了存档还没来得及通知：先通知，再发这个事件
    else flushScripts();
    post(r, { kind: 'event', name: String(name), args });
}

/** 同一张卡换了存档：整份新聊天（和新的聊天变量、上下文）推过去，然后 CHAT_CHANGED(存档 id) */
function syncEpoch(r) {
    r.epoch = persist.epoch;
    r.shadow = null;
    const { ops, commit } = collectOps(r);
    if (post(r, { kind: 'sync', ops })) commit();
    post(r, { kind: 'event', name: 'chat_id_changed', args: [persist.chatId] });
}

/** 消息里的前端卡 eventEmit 了一个事件：也发给脚本（frame-host.js eventEmit 调） */
export function forwardFrameEvent(name, args) {
    emitScriptEvent(name, ...(Array.isArray(args) ? args : []));
}

// ───────────────────────────── 收消息 ─────────────────────────────

/** 一个沙箱 10 秒里最多记 60 条日志（死循环里 console.error 的脚本不能把日志刷屏、把别的脚本的日志挤掉） */
function logAllowed(r) {
    const now = Date.now();
    while (r.logTimes.length && now - r.logTimes[0] > 10000) r.logTimes.shift();
    if (r.logTimes.length >= 60) {
        if (!r.logMuted) { r.logMuted = true; frameHost.log({ scriptId: null, scriptName: '脚本沙箱', cardId: r.cardId, level: 'warn', text: '脚本的日志太多，10 秒内的后续日志已省略' }); }
        return false;
    }
    r.logMuted = false;
    r.logTimes.push(now);
    return true;
}

function scriptLog(r, scriptId, level, text) {
    if (r !== rec || !logAllowed(r)) return;
    const name = scriptId === null ? '脚本沙箱' : (r.scripts.get(scriptId)?.name ?? scriptId);
    frameHost.log({ scriptId, scriptName: name, cardId: r.cardId, level, text: scrubSecrets(text) });
}

function onMessage(r, event) {
    // 两道校验：来源必须是这个沙箱的窗口（不是它打开的弹窗、不是它里面嵌的 iframe、不是别的卡的），且带着只有它的 srcdoc 里才有的随机 frameId
    if (r !== rec || event.source !== r.iframe.contentWindow) return;
    const raw = event.data;
    if (!raw || typeof raw !== 'object' || raw.smalltalk !== true || raw.frameId !== r.frameId) return;
    const d = parseSandboxMessage(raw, r.ids);
    if (!d) return;
    if (d.kind === 'ready') void sendBoot(r);
    else if (d.kind === 'log') scriptLog(r, d.scriptId, d.level, d.text);
    else if (d.kind === 'status') { r.status.set(d.scriptId, { status: d.status, text: d.text }); paintTab(); }
    else if (d.kind === 'call') void handleCall(r, d);
}

async function sendBoot(r) {
    if (r.booted) return;
    try { await cardVarsReady(); } catch (e) {
        scriptLog(r, null, 'error', `没有启动脚本：${e.message}`);
        return;
    }
    if (r !== rec || r.booted) return;
    r.epoch = persist.epoch;
    r.shadow = null;
    const { ops, commit } = collectOps(r);
    const scripts = r.list.map(s => ({ id: s.id, name: s.name, info: s.info, button: s.button, code: stripCodeFence(s.content) }));
    r.booted = true;
    if (post(r, { kind: 'boot', ops, scripts })) commit();
}

/** 会改聊天 / 触发生成的调用：日志里记一行（用户能看到是谁在改、是谁在花额度）。变量写太频繁，不记 */
const LOGGED_CALLS = new Set(['setChatMessages', 'setChatMessage', 'createChatMessages', 'deleteChatMessages', 'triggerSlash']);
const VAR_CALLS = new Set(['replaceVariables', 'insertOrAssignVariables', 'insertVariables', 'deleteVariable']);

function shortArgs(args) {
    let s;
    try { s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(', '); } catch { s = '…'; }
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

async function handleCall(r, d) {
    const reply = (ok, v) => {
        if (r !== rec) return;
        post(r, ok ? { kind: 'result', id: d.id, ok: true, value: v } : { kind: 'result', id: d.id, ok: false, error: scrubSecrets(String(v)) });
    };
    if (d.reject) {
        scriptLog(r, d.scriptId, 'unimplemented', `${d.method}：${d.reject}`);
        return reply(false, d.reject);
    }
    const ctx = { kind: 'script', cardId: r.cardId, scriptId: d.scriptId, scriptName: d.scriptId === null ? '脚本沙箱' : r.scripts.get(d.scriptId)?.name };
    if (d.method === 'reloadIframe') {
        scriptLog(r, d.scriptId, 'call', 'reloadIframe()：重新运行这张卡的全部脚本');
        reply(true, undefined);
        setTimeout(() => { if (r === rec) reconcileScripts({ force: true }); }, 0);
        return;
    }
    if (d.method === 'eventEmit') {
        // 转给消息里的前端卡（沙箱里的脚本自己已经在本地分发过了）
        const [name, ...rest] = d.args;
        if (typeof name === 'string') { try { emitFrameEvent(name, rest); } catch { /* 前端卡收不到就算了 */ } }
        return reply(true, undefined);
    }
    if (LOGGED_CALLS.has(d.method)) scriptLog(r, d.scriptId, 'call', `${d.method}(${shortArgs(d.args)})`);
    try {
        const value = await callHost(d.method, d.args, ctx);
        if (r !== rec) return;
        if (VAR_CALLS.has(d.method)) invalidateVars(r, d.scriptId);
        flushScripts();
        reply(true, value);
    } catch (err) {
        if (r !== rec) return;
        const text = String(err?.message ?? err);
        if (!/没有执行/.test(text)) scriptLog(r, d.scriptId, 'error', `${d.method} 失败：${text}`);   // 「没有执行」的原因宿主方法已经记过了
        if (VAR_CALLS.has(d.method)) invalidateVars(r, d.scriptId);
        flushScripts();
        reply(false, text);
    }
}

// ───────────────────────────── 给「脚本」页的 ─────────────────────────────

/** 现在整体的运行状态：'running' | 'nocard' | 'none'（没有启用的脚本）| 'readonly' | 'stopped' | 'restoring' */
export const scriptsRunState = () => runState;

/**
 * 一个脚本的运行状态：'running' | 'loading' | 'error' | 'off'（没启用 / 不在这个沙箱里）| 'readonly' | 'stopped' | 'restoring'
 * @returns {{status: string, text: string}}
 */
export function scriptStatus(id) {
    if (runState === 'readonly' || runState === 'stopped' || runState === 'restoring') return { status: runState, text: '' };
    if (!rec || rec.cardId !== persist.cardId || !rec.status.has(id)) return { status: 'off', text: '' };
    return rec.status.get(id);
}

/** 测试 / 调试用：现在有没有沙箱、属于哪张卡、装了哪些脚本 */
export function scriptSandboxInfo() {
    return { live: !!rec, cardId: rec?.cardId ?? null, ids: rec ? [...rec.ids] : [], booted: !!rec?.booted, runState,
        frames: document.querySelectorAll('iframe.script-sandbox').length };
}

let paintQueued = false;
function paintTab() {
    if (paintQueued) return;
    paintQueued = true;
    queueMicrotask(() => { paintQueued = false; try { paintScriptStatus(); } catch (e) { console.error(e); } });
}
