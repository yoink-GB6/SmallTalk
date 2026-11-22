// 酒馆助手脚本的宿主侧（2026-11-23 第 2 期：沙箱运行时 + 同步副本 + 变量作用域；方案 docs/tavern-helper-plan.md §3.1、§3.5–§3.7）。
// 沙箱里的桩在 src/script-stub.js，副本的比对 / 补丁在 src/script-sync.js，宿主方法（和消息里的前端卡共用）在 ui/frame-host.js。
//
// ── 沙箱 ──
//   一张卡一个：<iframe sandbox="allow-scripts">（render.js SCRIPT_SANDBOX；【绝不】给 allow-same-origin：opaque origin，读不到我们的
//   IndexedDB / localStorage、碰不到主页面的 DOM 和 JS 对象；也不给 modals / popups / forms：原生 prompt 能骗人输 key，见 render.js），
//   srcdoc 里只有桩和库，脚本代码走 postMessage 进去、用 Blob URL 加载。
//   iframe 是盖在聊天区（#chat-pane）上的透明覆盖层，按脚本画出的区域裁剪（第 5 期，见下面「悬浮区」）。只盖聊天区（用户定的：
//   脚本不能在右侧面板 / 顶栏上画东西，免得画一个假的「接口」页骗人填 key）。
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

import { SCRIPT_SANDBOX, emitFrameEvent } from '../render.js';
import { buildScriptSrcdoc } from '../script-stub.js';
import { diffChat } from '../script-sync.js';
import { parseSandboxMessage, scrubSecrets, cleanButtonList, parseRegions, regionsClipPath } from '../script-args.js';
import { cardScripts, enabledScriptsOf, stripCodeFence, flattenScripts } from '../scripts.js';
import { state, ui, persist, card, cardVarsReady, save, setCardVarsField } from './state.js';
import { STORAGE_LIMIT } from '../cardvars.js';
import { callHost, frameHost, readScope } from './frame-host.js';   // 循环依赖：只在函数体里调用
import { restoreActive } from './backup.js';                        // 同上
import { paintScriptStatus, ownScriptTree, renderScriptsTab } from './tab-scripts.js';   // 同上
import { renderScriptButtons } from './script-buttons.js';          // 同上

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
    r.ro?.disconnect();
    r.iframe.remove();
    pendingOpen = null;
    paintButtons();
}

/** 主页面现在的深浅（沙箱文档的 color-scheme 必须和它一致，不然浏览器会给 iframe 画一块不透明的底色，见下面「悬浮区」） */
const pageScheme = () => (getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light');

/** 建一个新沙箱装 list 里的脚本（先拆旧的） */
function build(list) {
    teardown();
    const host = document.querySelector('#chat-pane') ?? document.body;
    const frameId = randomToken();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SCRIPT_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    // 自动播放：跨源 iframe 要靠权限策略委托才能出声（脚本的音乐播放器 new Audio().play()）。这不是 sandbox 的标志，不放宽任何隔离
    iframe.setAttribute('allow', 'autoplay');
    iframe.setAttribute('title', '酒馆助手脚本的悬浮界面');
    iframe.className = 'script-sandbox';
    iframe.dataset.fk = 'script-sandbox';
    const scheme = pageScheme();
    iframe.style.colorScheme = scheme;
    const ac = new AbortController();
    const scripts = new Map(list.map(s => [s.id, { id: s.id, name: s.name || '(未命名)' }]));
    rec = {
        cardId: persist.cardId, cardObj: state.card, frameId, iframe, ac, list, sig: signature(list), scripts, ids: new Set(scripts.keys()),
        status: new Map(list.map(s => [s.id, { status: 'loading', text: '' }])),
        booted: false, epoch: persist.epoch, shadow: null, pushed: new Map(), cardRef: null, avatarRef: null, ctxJson: null,
        logTimes: [], logMuted: false,
        pushedButtons: new Map(), themeJson: null,
        rects: [], dragOpen: false, regionsQueued: null, ro: null,
        rate: { sec: 0, n: 0, said: false }, toastTimes: [],
    };
    const me = rec;
    window.addEventListener('message', e => onMessage(me, e), { signal: ac.signal });
    // 拖动中（沙箱报了整块区域）在 iframe 外面松开鼠标：沙箱收不到 pointerup（见「悬浮区」的原型结论），由宿主告诉它
    window.addEventListener('pointerup', () => { if (me === rec && me.dragOpen) post(me, { kind: 'release' }); }, { signal: ac.signal, capture: true });
    window.addEventListener('blur', () => { if (me === rec && me.dragOpen) post(me, { kind: 'release' }); }, { signal: ac.signal });
    // 系统深浅切换 / 「杂项」页换主题：把新的 color-scheme 和主题变量推过去（不一致时浏览器会给覆盖层画不透明的底）
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (me === rec) flushScripts(); }, { signal: ac.signal }); } catch { /* ignore */ }
    const themeMo = new MutationObserver(() => { if (me === rec) flushScripts(); else themeMo.disconnect(); });
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    ac.signal.addEventListener('abort', () => themeMo.disconnect());
    iframe.srcdoc = buildScriptSrcdoc({ frameId, colorScheme: scheme });
    host.append(iframe);
    applyClip(me);
    watchLayout(me);
    runState = 'running';
    paintTab();
    paintButtons();
}

// ───────────────────────────── 悬浮区（第 5 期，方案 §3.2 / §3.3）─────────────────────────────
// 酒馆里脚本的 $ 是酒馆主页面的，`$('body').append(浮窗)` 画到酒馆页面上；我们这里 $ 是沙箱自己的文档，所以让沙箱 iframe 本身成为一块
// 盖在聊天区上的透明覆盖层，脚本画的东西就显示出来了。
//
// 边界（用户定的，安全上不能松）：只盖聊天区。iframe 挂在 #chat-pane 里、position:absolute，尺寸由这里算（从聊天区顶到输入区 / 按钮排的上沿），
//   #chat-pane 是 position:relative + isolation:isolate（style.css 末尾）：iframe 的 z-index 被关在聊天区自己的层叠上下文里，
//   永远在顶栏、右侧面板、窄屏抽屉（z 16）和遮罩（15）、弹框（25）、模型下拉（28）、提示条（30）之下；iframe 的内容浏览器保证画不出它自己的框。
//   脚本改不了 iframe 元素本身的样式（跨源）。所以它画的任何东西都落不到面板、顶栏、弹框上——在那上面画假的「接口」页骗 key 做不到。
// 底部留给输入区：覆盖层不盖输入框、发送按钮和脚本按钮排（浮球贴「页面右下角」时会落在输入框上方，不会挡住发送）。
//
// 点击穿透（5a 原型，2026-11-23 无头 Edge 158 / Chrome 实测；Firefox 没跑通驱动，没验）：
//   - 沙箱里的桩量出脚本画的东西占的矩形（最多 32 个，见 script-stub.js measureRegions），这里拼成 clip-path: path(...) 设到 iframe 上。
//     clip-path 同时裁掉命中测试：区域外的点击、滚轮落到下面的聊天区（elementFromPoint 和真实点击都验过），区域内的进脚本。
//   - 没有任何区域（纯逻辑脚本、还没画）：pointer-events:none + 空的 clip-path，完全不可见、不拦任何操作。
//   - 拖动：鼠标按下后指针一下子移出裁剪区域，iframe 就收不到后续的 pointermove / pointerup（同进程的 iframe 没有跨裁剪区的鼠标捕获；
//     setPointerCapture 也不管用；触摸没问题）。每次移动后再量区域跟不上（每步 40px 就断）。所以：沙箱里一按下（pointerdown）
//     桩立刻报「整块」（drag: true），这里把裁剪放开、整个覆盖层接收指针，松开后桩再报真实区域。按下后 30ms 内一下子跳 300px 也跟得上。
//     在覆盖层外（输入区、面板）松开时沙箱收不到 pointerup：这里在主页面捕获 pointerup / 失焦，发 {kind:'release'} 让桩收尾。
//   - 透明：沙箱文档的 color-scheme 必须和主页面一致（原型：不一致时 Chromium 给 iframe 画不透明的白 / 黑底），所以建沙箱时带上、主题变化时推。
//   - 区域上报：桩用 requestAnimationFrame 合并、变了才发；这里也只在下一帧处理最新的一条。动画时约每秒几十次，宿主每次不到 0.1 毫秒。

/** 「隐藏悬浮界面」开关：按卡记在这台设备的 localStorage（界面偏好，不进存储 / 备份；data-inventory.js LOCAL_STORAGE_PREFS 登记过） */
export const FLOAT_HIDE_KEY = 'smalltalk.scriptFloatHidden';
function hiddenCards() {
    try { const v = JSON.parse(localStorage.getItem(FLOAT_HIDE_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}
export const floatHidden = (cardId = persist.cardId) => !!cardId && hiddenCards().includes(cardId);
export function setFloatHidden(on, cardId = persist.cardId) {
    if (!cardId) return;
    const list = hiddenCards().filter(x => x !== cardId);
    if (on) list.push(cardId);
    try { if (list.length) localStorage.setItem(FLOAT_HIDE_KEY, JSON.stringify(list.slice(-200))); else localStorage.removeItem(FLOAT_HIDE_KEY); } catch { /* 存不了就只在这次有效 */ }
    if (rec) applyClip(rec);
}

/** 按现在的区域设 iframe 的裁剪和能不能点 */
function applyClip(r) {
    const f = r.iframe;
    const hide = floatHidden(r.cardId);
    f.style.visibility = hide ? 'hidden' : '';
    // 没有区域：只留左上角 1 像素（透明、不拦点击）。不裁成完全空：浏览器会把完全看不见的跨源 iframe 当成不可见，暂停它的 requestAnimationFrame，
    // 脚本的动画、靠 rAF 的初始化就停了（实测）。iframe 的布局尺寸始终等于聊天区（脚本启动时读 innerWidth / innerHeight / body.clientHeight 定位）
    if (hide || !r.rects.length) { f.style.pointerEvents = 'none'; f.style.clipPath = 'inset(0 calc(100% - 1px) calc(100% - 1px) 0)'; f.dataset.regions = '0'; return; }
    f.style.pointerEvents = 'auto';
    f.style.clipPath = r.dragOpen ? 'none' : regionsClipPath(r.rects);
    f.dataset.regions = String(r.rects.length);
}

/** 覆盖层的高度：聊天区顶到输入区（手动模式的粘贴框 / 脚本按钮排 / 输入框，取最上面那个看得见的）的上沿 */
function layoutOverlay(r) {
    const pane = r.iframe.parentElement;
    if (!pane) return;
    const top = pane.getBoundingClientRect().top;
    let stop = pane.getBoundingClientRect().bottom;
    for (const sel of ['#manual-panel', '#script-buttons', '#composer']) {
        const el = document.querySelector(sel);
        if (el && !el.hidden && el.offsetParent !== null) stop = Math.min(stop, el.getBoundingClientRect().top);
    }
    const h = Math.max(0, Math.round(stop - top));
    if (r.iframe.style.height !== `${h}px`) r.iframe.style.height = `${h}px`;
}
function watchLayout(r) {
    layoutOverlay(r);
    if (typeof ResizeObserver !== 'function') return;
    r.ro = new ResizeObserver(() => { if (r === rec) layoutOverlay(r); });
    for (const sel of ['#chat-pane', '#manual-panel', '#script-buttons', '#composer']) { const el = document.querySelector(sel); if (el) r.ro.observe(el); }
    window.addEventListener('resize', () => { if (r === rec) layoutOverlay(r); }, { signal: r.ac.signal });
}
/** 输入区那几块显示 / 隐藏之后（ResizeObserver 对 hidden 切换不一定报）：shell.js renderAll 经 reconcileScripts 调到这里 */
function relayout() { if (rec) layoutOverlay(rec); }

/** 推给沙箱的主题（只读的展示信息：深浅、几个颜色和字体。没有任何接口 / key / 地址） */
function themeNow() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim().slice(0, 200);
    return { scheme: pageScheme(), vars: { bg: v('--bg'), panel: v('--panel'), text: v('--text'), dim: v('--dim'), accent: v('--accent'), 'accent-text': v('--accent-text'), line: v('--line'), font: v('--font-ui'), radius: v('--radius-control') } };
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
        if (rec.booted && (rec.epoch !== persist.epoch || pendingOpen)) syncEpoch(rec);
        else flushScripts();
        relayout();
        paintButtons();
        return;
    }
    const w = wanted();
    if (typeof w === 'string') { teardown(); runState = w; paintTab(); return; }
    build(w.list);
}

/**
 * 存档操作告诉这里「刚开了一个存档」（archive.js）：下一次 reconcile 整份重推并发酒馆的那组事件（见 syncEpoch）。
 * created：新对话（酒馆里新对话就是新聊天文件，发 CHAT_CREATED）；「原地换开场白」时存档 id 不变，也靠这个触发。
 * deleted：删掉了当前存档（先发 CHAT_DELETED(它的 id)）
 */
let pendingOpen = null;
export function noteChatOpened({ created = false, deleted = null } = {}) {
    if (!rec) return;
    pendingOpen = { created: created || pendingOpen?.created === true, deleted: deleted ?? pendingOpen?.deleted ?? null };
}

/** 「脚本」页改了脚本（开关、代码、名字、增删）：启用的脚本或它们的代码变了才重建 */
export function restartScripts() {
    enabledCache = { cardObj: null, scriptsRef: undefined, list: [] };
    const w = wanted();
    if (typeof w === 'string') { teardown(); runState = w; paintTab(); return; }
    if (rec && rec.cardId === persist.cardId && rec.cardObj === state.card && rec.sig === signature(w.list)) { flushScripts(); paintButtons(); return; }   // 只改了按钮之类：推过去、重画按钮排，不重建
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
    // 脚本按钮（第 4 期）：卡里这几个脚本现在的 button（「脚本」页改了、或宿主拒绝了脚本的改动时，把权威值推回去）
    const btnPushed = [];
    const tree = flattenScripts(cardScripts(state.card));
    for (const id of r.ids) {
        const s = tree.find(x => x.id === id);
        const value = { enabled: s?.button?.enabled !== false, buttons: cleanButtonList(s?.button?.buttons ?? []) };
        const j = JSON.stringify(value);
        if (r.pushedButtons.get(id) === j) continue;
        ops.push({ op: 'buttons', id, value });
        btnPushed.push([id, j]);
    }
    const theme = themeNow();
    const themeJson = JSON.stringify(theme);
    if (themeJson !== r.themeJson) { ops.push({ op: 'theme', value: theme }); r.iframe.style.colorScheme = theme.scheme; }
    const commit = () => {
        r.shadow = chat.shadow;
        for (const [k, j] of pushed) r.pushed.set(k, j);
        for (const [k, j] of btnPushed) r.pushedButtons.set(k, j);
        if (cardChanged) { r.cardRef = state.card; r.avatarRef = state.avatar; }
        r.ctxJson = ctxJson;
        r.themeJson = themeJson;
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
 * 只给脚本沙箱发一个事件（先推副本）。还没 boot 的沙箱收不到（那时脚本还没开始监听）。
 * 宿主自己的酒馆事件用 emitTavernEvent（沙箱 + 消息前端卡都发）；这个只给「前端卡 eventEmit 转过来的」用（前端卡那边 render.js 已经转发过）
 */
export function emitScriptEvent(name, ...args) {
    const r = rec;
    if (!r || !r.booted || r.cardId !== persist.cardId) return;
    if (r.epoch !== persist.epoch) syncEpoch(r);   // 换了存档还没来得及通知：先通知，再发这个事件
    else flushScripts();
    post(r, { kind: 'event', name: String(name), args });
}

/**
 * 宿主发一个酒馆事件（第 3 期，方案 §1.4；事件名、参数照酒馆 1.19.0 public/script.js）：脚本沙箱和消息里的前端卡【统一从这里发】。
 * 沙箱先推副本再发（回调里同步读到新值）；前端卡只发给 eventOn 订阅了这个名字的 iframe（render.js emitFrameEvent），
 * 前端卡读数据本来就是 RPC 到宿主现取，所以读到的也是新值。发事件不碰 DOM，前端卡不会因此重画。
 */
export function emitTavernEvent(name, ...args) {
    emitScriptEvent(name, ...args);
    try { emitFrameEvent(String(name), args); } catch (e) { console.error(e); }
}

/**
 * STREAM_TOKEN_RECEIVED(到目前为止的全文)：酒馆每收到一段就发一次；我们最多 100ms 一次（流式时每秒可能几十段，
 * 每次都要推一遍最后一楼的副本），最后一段一定发（generateReply 结束时 flushStreamToken）
 */
let streamLast = 0, streamTimer = null, streamPending = null;
export function emitStreamToken(text) {
    streamPending = String(text);
    const wait = 100 - (Date.now() - streamLast);
    if (wait <= 0) { flushStreamToken(); return; }
    if (!streamTimer) streamTimer = setTimeout(flushStreamToken, wait);
}
export function flushStreamToken() {
    clearTimeout(streamTimer); streamTimer = null;
    if (streamPending === null) return;
    const t = streamPending;
    streamPending = null;
    streamLast = Date.now();
    emitTavernEvent('stream_token_received', t);
}
/** 生成没走到结尾就被换走（切存档等）时丢掉还没发的那段 */
export function dropStreamToken() { clearTimeout(streamTimer); streamTimer = null; streamPending = null; }

/**
 * 同一张卡换了存档 / 开了新对话：整份新聊天（和新的聊天变量、上下文）推过去，然后照酒馆 getChatResult 的顺序发：
 *   [CHAT_DELETED(旧存档 id)]、CHAT_CHANGED(存档 id)、[新对话：CHAT_CREATED]、[聊天只有 1 楼：MESSAGE_RECEIVED(0,'first_message')、CHARACTER_MESSAGE_RENDERED(0,'first_message')]
 * （酒馆每次打开聊天、只有一楼时都发 first_message 那两个，不只是新对话）
 */
function syncEpoch(r) {
    r.epoch = persist.epoch;
    r.shadow = null;
    const p = pendingOpen;
    pendingOpen = null;
    const { ops, commit } = collectOps(r);
    if (post(r, { kind: 'sync', ops })) commit();
    const send = (name, ...args) => { post(r, { kind: 'event', name, args }); try { emitFrameEvent(name, args); } catch { /* ignore */ } };
    if (p?.deleted) send('chat_deleted', p.deleted);
    send('chat_id_changed', persist.chatId);
    if (p?.created) send('chat_created');
    if (state.chat.length === 1) { send('message_received', 0, 'first_message'); send('character_message_rendered', 0, 'first_message'); }
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

/** 每个沙箱每秒最多处理 200 条消息（RPC、日志、区域上报……），多的直接丢掉并记一条（去重）：写坏的脚本用循环狂发时主页面不能被拖死 */
function rateOk(r, kind) {
    if (kind === 'regions') return true;   // 区域上报另有合并（只处理每帧最新的一条），不占这个额度
    const sec = Math.floor(Date.now() / 1000);
    if (r.rate.sec !== sec) { r.rate.sec = sec; r.rate.n = 0; }
    if (++r.rate.n <= 200) return true;
    if (!r.rate.said) { r.rate.said = true; frameHost.log({ scriptId: null, scriptName: '脚本沙箱', cardId: r.cardId, level: 'warn', text: '脚本 1 秒内发来的调用超过 200 次，多出来的已丢弃（这条只记一次）' }); }
    return false;
}

function onMessage(r, event) {
    // 两道校验：来源必须是这个沙箱的窗口（不是它打开的弹窗、不是它里面嵌的 iframe、不是别的卡的），且带着只有它的 srcdoc 里才有的随机 frameId
    if (r !== rec || event.source !== r.iframe.contentWindow) return;
    const raw = event.data;
    if (!raw || typeof raw !== 'object' || raw.smalltalk !== true || raw.frameId !== r.frameId) return;
    const d = parseSandboxMessage(raw, r.ids);
    if (!d || !rateOk(r, d.kind)) return;
    if (d.kind === 'ready') void sendBoot(r);
    else if (d.kind === 'log') scriptLog(r, d.scriptId, d.level, d.text);
    else if (d.kind === 'status') { r.status.set(d.scriptId, { status: d.status, text: d.text }); paintTab(); }
    else if (d.kind === 'call') void handleCall(r, d);
    else if (d.kind === 'regions') {
        // 只在下一帧处理最新的一条（动画时桩每帧都可能报一次）
        const first = r.regionsQueued === null;
        r.regionsQueued = d;
        if (first) requestAnimationFrame(() => {
            if (r !== rec || !r.regionsQueued) return;
            const q = r.regionsQueued;
            r.regionsQueued = null;
            const box = r.iframe.getBoundingClientRect();
            r.rects = parseRegions(q.rects, box.width, box.height);
            r.dragOpen = q.drag === true && r.rects.length > 0;
            applyClip(r);
        });
    }
}

/**
 * 脚本想打开一个链接（沙箱没有 allow-popups，桩把 window.open 和 <a target> 的点击换成了这个）：
 * 只认 http(s)，宿主自己先确认（写明是哪个脚本、完整网址），再用 noopener 打开。一次只问一个
 */
let openAsking = false;
function openUrl(r, scriptId, url) {
    let u;
    try { u = new URL(String(url)); } catch { throw new Error('网址不对'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只能打开 http / https 链接');
    if (openAsking) throw new Error('上一个打开链接的确认还没答');
    const name = scriptId === null ? '某个脚本' : (r.scripts.get(scriptId)?.name ?? scriptId);
    openAsking = true;
    try {
        if (!confirm(`脚本「${name}」想在新窗口打开：\n${u.href}\n\n要打开吗？`)) return false;
    } finally { openAsking = false; }
    window.open(u.href, '_blank', 'noopener,noreferrer');
    return true;
}

/**
 * 沙箱的 localStorage 改动（只含改了的键）→ cardvars:<卡 id>.storage。{clear?, set: {键: 值}, del: [键]}，键值都必须是字符串，
 * 危险键丢掉，总量不超过 STORAGE_LIMIT（沙箱那边已经按同一个上限抛过 QuotaExceededError，这里兜底）
 */
function storageWrite(r, ch) {
    const why = r.cardId !== persist.cardId ? '角色卡已经换了' : ui.switching ? '正在切换存档' : restoreActive() ? '正在恢复，请稍等'
        : persist.stopped ? '已停止保存' : persist.readOnly ? '这个标签页是只读的' : persist.cardVars === undefined ? '这张卡的数据还没读回来' : null;
    if (why) throw new Error(why);
    if (!ch || typeof ch !== 'object') throw new Error('格式不对');
    const next = ch.clear === true ? {} : { ...(persist.cardVars?.storage ?? {}) };
    for (const k of Array.isArray(ch.del) ? ch.del : []) if (typeof k === 'string') delete next[k];
    if (ch.set && typeof ch.set === 'object') for (const [k, v] of Object.entries(ch.set)) {
        if (typeof v !== 'string' || UNSAFE_IDS.has(k)) continue;
        next[k] = v;
    }
    let total = 0;
    for (const [k, v] of Object.entries(next)) total += k.length + v.length;
    if (total > STORAGE_LIMIT) throw new Error('超过了总量上限');
    setCardVarsField('storage', Object.keys(next).length ? next : undefined);
    save();
}

/** 脚本改了自己的按钮（replaceScriptButtons 等）：写回卡里的脚本（card.scripts，第一次改时整棵树拷进去），存盘，重画按钮排。不重建沙箱 */
function setScriptButtons(r, scriptId, list) {
    if (typeof scriptId !== 'string') throw new Error('SmallTalk 没法确定是哪个脚本在调用');
    const why = r.cardId !== persist.cardId ? '角色卡已经换了' : ui.switching ? '正在切换存档' : restoreActive() ? '正在恢复，请稍等'
        : persist.stopped ? '已停止保存' : persist.readOnly ? '这个标签页是只读的' : null;
    if (why) throw new Error(`按钮没有改：${why}`);
    const buttons = cleanButtonList(Array.isArray(list) ? list : []);
    const s = flattenScripts(ownScriptTree()).find(x => x.id === scriptId);
    if (!s) throw new Error('这个脚本已经不在卡里了');
    if (JSON.stringify(cleanButtonList(s.button?.buttons ?? [])) === JSON.stringify(buttons)) return;   // 酒馆助手：一样就不改
    s.button = { ...(s.button ?? { enabled: true }), buttons };
    save();
    paintButtons();
    try { renderScriptsTab(); } catch { /* 页签没开 */ }
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
    // localStorage 的整份初值只在 boot 时传这一次（壁纸之类可能几 MB），之后沙箱只把改了的键发回来（storageWrite）
    if (post(r, { kind: 'boot', ops, scripts, storage: persist.cardVars?.storage ?? {} })) commit();
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
    if (d.method === 'storageWrite') {
        try { storageWrite(r, d.args[0]); reply(true, undefined); } catch (err) { const text = String(err?.message ?? err); scriptLog(r, null, 'warn', `localStorage 没有存下来：${text}`); reply(false, text); }
        return;
    }
    if (d.method === 'replaceScriptButtons' || d.method === 'openUrl') {
        try {
            const v = d.method === 'openUrl' ? openUrl(r, d.scriptId, d.args[0]) : setScriptButtons(r, d.scriptId, d.args[0]);
            if (d.method === 'openUrl') scriptLog(r, d.scriptId, 'call', `打开链接 ${String(d.args[0]).slice(0, 200)}：${v ? '用户同意了' : '用户没同意'}`);
            flushScripts();
            reply(true, v);
        } catch (err) {
            const text = String(err?.message ?? err);
            scriptLog(r, d.scriptId, 'warn', `${d.method === 'openUrl' ? '打开链接' : '改按钮'}没有执行：${text}`);
            r.pushedButtons.delete(d.scriptId);   // 把权威的按钮推回去（沙箱里先改了的要换回来）
            flushScripts();
            reply(false, text);
        }
        return;
    }
    if (d.method === 'toastr') {
        // 提示条按沙箱限频：10 秒最多 5 条，多的只记日志
        const now = Date.now();
        r.toastTimes = r.toastTimes.filter(t => now - t < 10000);
        if (r.toastTimes.length >= 5) { scriptLog(r, d.scriptId, 'info', `提示条太多，没显示：${String(d.args[1] ?? '').slice(0, 200)}`); return reply(true, undefined); }
        r.toastTimes.push(now);
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
        frames: document.querySelectorAll('iframe.script-sandbox').length, rects: rec ? rec.rects.map(x => [...x]) : [], dragOpen: !!rec?.dragOpen };
}

/** 按钮排要画的：沙箱在跑时，按「脚本」页的顺序，每个运行中的脚本 {id, name, buttons: 看得见的按钮名}（button.enabled 关着的整组不要） */
export function runningButtons() {
    if (!rec || rec.cardId !== persist.cardId || runState !== 'running') return [];
    const tree = flattenScripts(cardScripts(state.card));
    const out = [];
    for (const s of rec.list) {
        const cur = tree.find(x => x.id === s.id);
        if (!cur || cur.button?.enabled === false) continue;
        const names = cleanButtonList(cur.button?.buttons ?? []).filter(b => b.visible).map(b => b.name);
        if (names.length) out.push({ id: s.id, name: cur.name || '(未命名)', buttons: names });
    }
    return out;
}
/** 点了脚本按钮：发事件（酒馆助手：eventSource.emit(按钮事件名)，不带参数、不管有没有人订阅） */
export function clickScriptButton(scriptId, eventName) {
    if (!rec || !rec.ids.has(scriptId)) return;
    emitTavernEvent(eventName);
}
function paintButtons() { try { renderScriptButtons(); } catch (e) { console.error(e); } if (rec) layoutOverlay(rec); }

let paintQueued = false;
function paintTab() {
    if (paintQueued) return;
    paintQueued = true;
    queueMicrotask(() => { paintQueued = false; try { paintScriptStatus(); } catch (e) { console.error(e); } });
}
