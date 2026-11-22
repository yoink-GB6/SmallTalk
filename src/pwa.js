// "安装到主屏幕"的页面一侧：注册离线缓存脚本、发现新版本、切换到新版本、安装提示、请求持久存储。
// 只管状态和事件，不碰 DOM 结构（界面在 src/ui/pwa-ui.js，它订阅这里的 'change' 事件重画）。
// 也不 import 任何界面模块：重载前要做的数据保护（等回复生成完、先落盘）由界面层通过 setBeforeReload 注入。
//
// 离线缓存脚本只在网页版（direct 后端）里注册。它的源码是 scripts/sw-template.js，打包时才生成 sw.js（见 scripts/pack-web.mjs），
// 项目根目录没有 sw.js：本地版既不会注册它（下面先看后端），即使注册也只会拿到 404。
//
// 版本切换的完整流程（为什么这样设计见 sw-template.js 文件头）：
//   1. 浏览器打开页面时自己会去比对 sw.js；变了就在后台装新版，装好后新版进入"等待"（旧版继续管着页面）。
//   2. 这里发现"有一个等待中的新版、而且页面已经被旧版管着"（= 不是第一次安装）→ 通知界面"有新版本"。
//   3. 用户点"更新" → applyUpdate() 给等待中的新版发 skip-waiting → 新版接管 → 每个标签页都收到 controllerchange。
//   4. 每个标签页在 controllerchange 时都重载（先跑 beforeReload 保护数据）。为什么所有标签页都要重载：
//      没点按钮的标签页内存里还是旧代码，之后再懒加载模块就会从新版缓存里拿到新文件，新旧混用。
//   5. 防死循环：第一次安装时缓存脚本调用 clients.claim()，也会触发一次 controllerchange（从"没人管"变成"有人管"），
//      那次不能重载。判断办法：变化之前有没有控制者——之前没有 = 第一次接管，只更新状态不重载。
//      重载之后页面直接由新版管着、也没有等待中的版本，不会再触发。

import { backendKind } from './llm.js';

const hasWindow = typeof window !== 'undefined' && typeof navigator !== 'undefined';
const swSupported = hasWindow && 'serviceWorker' in navigator;

/** 对外的状态（只读快照用 getPwaState()） */
const st = {
    backend: null,          // 'direct' | 'server' | null（还没探测完）
    sw: 'off',              // 离线缓存：'off' 未启用 | 'pending' 正在准备 | 'ready' 已就绪 | 'failed' 没装上
    swReason: '',           // sw 为 'off' / 'failed' 时的原因（给界面显示）
    version: '',            // 正在用的这一版的版本号（问缓存脚本要的）
    updateReady: false,     // 有一个等待中的新版本
    newVersion: '',         // 等待中的新版本号（问不到就是空）
    updating: false,        // 已经发了 skip-waiting，正在等新版接管
    installable: false,     // 浏览器给了安装提示（beforeinstallprompt，安卓 / 桌面 Chromium）
    standalone: false,      // 现在是以"装到主屏幕的应用"打开的（独立窗口）
    justInstalled: false,   // 这次页面里刚装上（appinstalled）
    persisted: null,        // 浏览器是否已承诺不自动清理数据：true / false / 'unsupported' / null（还没查）
    persistAsked: null,     // 用户点过"请浏览器保留数据"之后的结果：'granted' | 'denied' | 'unsupported' | 'error' | null
};

export const pwaEvents = hasWindow ? new EventTarget() : null;
const emit = () => pwaEvents?.dispatchEvent(new Event('change'));
export const getPwaState = () => ({ ...st });

let registration = null;
let deferredPrompt = null;
let beforeReload = async () => {};
let reloading = false;

/** 界面层注入：重载前要做的事（等生成结束、落盘、暂存输入框）。返回的 Promise 结束后才重载 */
export function setBeforeReload(fn) { beforeReload = typeof fn === 'function' ? fn : async () => {}; }

// ───────────────────────────── 安装提示 / 独立窗口 ─────────────────────────────
// 这两个监听放在模块顶层：beforeinstallprompt 可能在页面启动流程（读存储）还没走完时就来了，晚注册会错过。

function readStandalone() {
    try { return !!(matchMedia('(display-mode: standalone)').matches || navigator.standalone === true); } catch { return false; }
}
if (hasWindow) {
    st.standalone = readStandalone();
    addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();          // 不让浏览器自己弹小横条，改由「杂项」页的「安装」按钮触发
        deferredPrompt = e;
        st.installable = true;
        emit();
    });
    addEventListener('appinstalled', () => {
        deferredPrompt = null;
        st.installable = false;
        st.justInstalled = true;
        emit();
    });
    try { matchMedia('(display-mode: standalone)').addEventListener('change', () => { st.standalone = readStandalone(); emit(); }); } catch {}
}

/** 触发浏览器的安装对话框。返回 'accepted' | 'dismissed' | 'unavailable' */
export async function promptInstall() {
    const e = deferredPrompt;
    if (!e) return 'unavailable';
    deferredPrompt = null;           // 一个提示只能用一次
    st.installable = false;
    emit();
    try {
        await e.prompt();
        const { outcome } = await e.userChoice;
        return outcome;
    } catch { return 'unavailable'; }
}

// ───────────────────────────── 持久存储 ─────────────────────────────
// 浏览器在磁盘紧张时可能清掉网站数据（Safari 还会清掉 7 天没访问的网站）。persist() 是请浏览器"别自动清"。
// 只在用户点按钮时调用 persist()：Firefox 会为它弹权限框，启动时偷偷调用会莫名其妙弹窗。persisted() 只是查询，不弹框。

async function refreshPersisted() {
    try {
        st.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : 'unsupported';
    } catch { st.persisted = 'unsupported'; }
    emit();
}

/** 请浏览器保留数据（用户点按钮时调用）。返回并记下 'granted' | 'denied' | 'unsupported' | 'error' */
export async function requestPersist() {
    let r;
    if (!navigator.storage?.persist) r = 'unsupported';
    else {
        try { r = (await navigator.storage.persist()) ? 'granted' : 'denied'; } catch { r = 'error'; }
    }
    st.persistAsked = r;
    if (r === 'granted') st.persisted = true;
    else await refreshPersisted();   // 被拒也再查一次真实状态（有的浏览器早就批准过）
    emit();
    return r;
}

// ───────────────────────────── 离线缓存脚本 ─────────────────────────────

/** 问某个缓存脚本"你是哪一版"（它在 message 事件里从端口回）。3 秒没回就算了 */
function askVersion(worker) {
    if (!worker) return Promise.resolve('');
    return new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(''), 3000);
        ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data?.version ?? ''); };
        try { worker.postMessage({ type: 'version' }, [ch.port2]); } catch { clearTimeout(timer); resolve(''); }
    });
}

async function markReady() {
    const active = registration?.active;
    if (!active) return;
    st.sw = 'ready';
    st.version = await askVersion(active) || st.version;
    emit();
}

async function markUpdate(worker) {
    st.updateReady = true;
    emit();
    st.newVersion = await askVersion(worker);
    emit();
}

/** 盯住一个注册：现成的等待中的新版、以后再出现的新版 */
function watch(reg) {
    // 页面已经被管着（不是第一次安装）且有等待中的新版 → 有新版本
    if (reg.waiting && navigator.serviceWorker.controller) markUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        if (!navigator.serviceWorker.controller) { st.sw = 'pending'; emit(); }
        w.addEventListener('statechange', () => {
            // installed = 装好了、在等待。只有在已经有旧版管着页面时才算"新版本"（第一次安装会直接激活）
            if (w.state === 'installed' && navigator.serviceWorker.controller) markUpdate(w);
            if (w.state === 'activated') markReady();
            if (w.state === 'redundant' && !reg.active) { st.sw = 'failed'; st.swReason = '离线缓存没能准备好（可能是网络中断），下次打开页面会再试'; emit(); }
        });
    });
    if (reg.active) markReady();
    else if (reg.installing || reg.waiting) { st.sw = 'pending'; emit(); }
}

function listenControllerChange() {
    let last = navigator.serviceWorker.controller;   // 这个页面加载时有没有被管着
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
        const prev = last;
        last = navigator.serviceWorker.controller;
        if (!prev) { markReady(); return; }          // 第一次接管（clients.claim）：不重载，见文件头第 5 条
        if (reloading) return;
        reloading = true;
        st.updating = true;
        emit();
        try { await beforeReload(); } catch (e) { console.warn('重载前的保存出了问题', e); }
        location.reload();
    });
}

/**
 * 启动时调用一次（src/ui/pwa-ui.js 的 initPwaUi 里）。不会抛错，失败只留一条 debug 级的日志。
 * 只有网页版（direct）且浏览器支持才注册；本地版（server）什么都不做。
 */
export async function initPwa() {
    if (!hasWindow) return;
    try { st.backend = await backendKind(); } catch { st.backend = 'server'; }
    if (st.backend !== 'direct') { st.sw = 'off'; st.swReason = '本地版不需要离线缓存'; emit(); return; }
    refreshPersisted();
    if (!swSupported) { st.sw = 'off'; st.swReason = '这个浏览器不支持离线缓存'; emit(); return; }
    listenControllerChange();
    st.sw = 'pending';
    emit();
    try {
        // 相对地址：网页版挂在子路径下也对。updateViaCache: 'none' = 检查新版时 sw.js 绕过 HTTP 缓存
        registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch (e) {
        // 离线时重新打开页面，浏览器去检查 sw.js 失败也可能让 register 报错；这时之前装好的那一版仍然在，照常用它
        registration = await navigator.serviceWorker.getRegistration().catch(() => null) ?? null;
        if (!registration) {
            // 典型情况：本地用 ?backend=direct 调试，项目根目录没有 sw.js（404）。这不是问题，只留一条说明
            console.debug('离线缓存脚本没有注册（本地调试时没有 sw.js 是正常的）：', e?.message ?? e);
            st.sw = 'off'; st.swReason = '这个网址上没有离线缓存脚本';
            emit();
            return;
        }
    }
    watch(registration);
    // 页面开着的时候也能发现新版：切回这个标签页时让浏览器再检查一次（sw.js 很小，且不走缓存）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration?.update().catch(() => {});
    });
}

/**
 * 切换到等待中的新版本（界面在确认可以重载之后调用）。真正的重载发生在 controllerchange 里，所有标签页都一样。
 * @returns {boolean} false = 没有等待中的新版本
 */
export function applyUpdate() {
    const w = registration?.waiting;
    if (!w) return false;
    st.updating = true;
    emit();
    w.postMessage({ type: 'skip-waiting' });
    return true;
}
