// 前端卡 iframe 里运行的桩（stub）。
//
// frameStubMain 是一个**自包含**函数：render.js 用 frameStubMain.toString() 把它的源码原样内联进
// srcdoc（`(源码)(BOOT)`），所以函数体里不能引用本模块的任何变量，也不能出现字面的 `</script` 或 `<!--`
// （测试会检查）。这样 iframe 不需要从我们的服务器 fetch 任何文件——srcdoc + 沙箱下它的 origin 是 opaque 的。
//
// 它做的事：
//   1. opaque origin 的坑：localStorage / sessionStorage / document.cookie 访问会抛 SecurityError，换成内存实现；
//      window.parent.xxx / top.xxx 属性访问会抛错，没法修，但 error / unhandledrejection 处理器会把错误
//      （附中文提示）转发到宿主日志，让用户知道卡为什么坏了。
//   2. 自动高度：ResizeObserver 量内容高度，postMessage 给宿主（对应酒馆助手的 adjust_iframe_height.js）。
//      视口高度变量 --TH-viewport-height（对应 adjust_viewport.js）：初值来自 BOOT，之后由宿主推送。
//   3. RPC 桥：酒馆助手常用的全局函数 → postMessage 给宿主 → 等宿主回 result。
//   4. 事件：eventOn 的回调留在 iframe 里，只把事件名告诉宿主；宿主推 {kind:'event'} 时在这里分发。
//   5. TavernHelper 是 Proxy：读到没实现的名字会得到一个记录 unimplemented 并 resolve(undefined) 的异步函数。

/**
 * 不要在这里引用外部变量（见文件头）。
 * @param {{frameId: string, messageId: number, frameIndex: number, context: any, viewportHeight: number,
 *          maxHeight: number, bridged: string[], unimplemented: string[]}} BOOT
 */
export function frameStubMain(BOOT) {
    'use strict';
    var W = window;
    // parent 是 [Replaceable] 属性，卡可以把它改掉；先抓住真正的父窗口。
    var HOST = W.parent;
    var FRAME_ID = BOOT.frameId;
    var MESSAGE_ID = BOOT.messageId;
    var logBudget = 300;

    function post(msg) {
        msg.smalltalk = true;
        msg.frameId = FRAME_ID;
        // 父页面的 origin 对我们来说是已知的，但发 '*' 也无妨：收件方只能是我们的父窗口。
        HOST.postMessage(msg, '*');
    }

    function toText(v) {
        try {
            if (v instanceof Error) return v.name + ': ' + v.message;
            if (typeof v === 'string') return v;
            if (typeof v === 'function') return '[function]';
            var s = JSON.stringify(v);
            return s === undefined ? String(v) : s;
        } catch (e) {
            return String(v);
        }
    }

    function argsText(args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(toText(args[i]));
        var s = parts.join(', ');
        return s.length > 300 ? s.slice(0, 300) + '…' : s;
    }

    function hostLog(level, text) {
        if (logBudget <= 0) return;
        logBudget--;
        if (logBudget === 0) text = '这个 iframe 的日志太多，后续日志已省略';
        try {
            post({ kind: 'log', level: level, text: String(text).slice(0, 2000) });
        } catch (e) { /* 父窗口不在了 */ }
    }

    // ───────── 1. opaque origin 的存储 / cookie ─────────

    function makeStorage() {
        var map = new Map();
        var api = {
            getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
            setItem: function (k, v) { map.set(String(k), String(v)); },
            removeItem: function (k) { map.delete(String(k)); },
            clear: function () { map.clear(); },
            key: function (i) { var keys = Array.from(map.keys()); return i in keys ? keys[i] : null; },
        };
        Object.defineProperty(api, 'length', { get: function () { return map.size; } });
        // 支持 localStorage.foo = 'x' / localStorage.foo 这种写法
        return new Proxy(api, {
            get: function (t, p) {
                if (p in t || typeof p !== 'string') return t[p];
                return map.has(p) ? map.get(p) : undefined;
            },
            set: function (t, p, v) {
                if (p in t || typeof p !== 'string') return false;
                map.set(p, String(v));
                return true;
            },
            deleteProperty: function (t, p) { map.delete(String(p)); return true; },
            has: function (t, p) { return p in t || map.has(String(p)); },
            ownKeys: function () { return Array.from(map.keys()); },
            getOwnPropertyDescriptor: function (t, p) {
                if (map.has(String(p))) return { value: map.get(String(p)), enumerable: true, configurable: true, writable: true };
                return undefined;
            },
        });
    }

    ['localStorage', 'sessionStorage'].forEach(function (name) {
        try {
            void W[name].length;
            return; // 能用（理论上沙箱无同源时不会走到这里）
        } catch (e) { /* SecurityError：装内存实现 */ }
        try {
            // Window 是 [Global] 接口，localStorage 是实例上的可配置访问器属性，可以直接重定义。
            Object.defineProperty(W, name, { value: makeStorage(), configurable: true, enumerable: true, writable: false });
        } catch (e) {
            hostLog('error', name + ' 无法替换为内存实现：' + toText(e));
        }
    });

    try {
        void document.cookie;
    } catch (e) {
        var jar = new Map();
        try {
            Object.defineProperty(document, 'cookie', {
                configurable: true,
                get: function () {
                    var out = [];
                    jar.forEach(function (v, k) { out.push(k + '=' + v); });
                    return out.join('; ');
                },
                set: function (s) {
                    var first = String(s).split(';')[0];
                    var eq = first.indexOf('=');
                    if (eq < 0) return;
                    var k = first.slice(0, eq).trim();
                    var v = first.slice(eq + 1).trim();
                    if (/;\s*max-age=0|;\s*expires=Thu, 01 Jan 1970/i.test(String(s))) jar.delete(k);
                    else jar.set(k, v);
                },
            });
        } catch (e2) { /* 放弃 */ }
    }

    // ───────── 错误转发 ─────────

    function hint(msg) {
        if (/cross-origin|Blocked a frame|跨源|Permission denied to access/i.test(msg)) {
            return ' —— 这张卡访问了 parent/top，被沙箱拦截（前端卡运行在没有同源权限的沙箱 iframe 里，不能读写宿主页面）';
        }
        var m = /ReferenceError:\s*(?:Can't find variable:\s*)?([\w$]+)/.exec(msg);
        if (m) return ' —— 这张卡用到了 SmallTalk 没有提供的全局变量 ' + m[1];
        if (/SecurityError/.test(msg)) return ' —— 沙箱（opaque origin）拦截了这次访问';
        return '';
    }

    W.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t !== W && t.tagName) {
            hostLog('error', '资源加载失败：<' + t.tagName.toLowerCase() + '> ' + (t.src || t.href || ''));
            return;
        }
        var msg = e.message || (e.error ? toText(e.error) : 'Script error');
        var where = e.lineno ? ' (第 ' + e.lineno + ' 行)' : '';
        hostLog('error', msg + where + hint(msg));
    }, true);

    W.addEventListener('unhandledrejection', function (e) {
        var msg = 'Unhandled rejection: ' + toText(e.reason);
        hostLog('error', msg + hint(msg));
    });

    ['error', 'warn'].forEach(function (level) {
        var orig = console[level];
        console[level] = function () {
            var text = argsText(arguments);
            // Tailwind 浏览器版每次都警告「不要用于生产」，酒馆助手的副本把它删掉了；这里不转发
            if (!/^The browser build of Tailwind CSS/.test(String(arguments[0]))) hostLog('console', level + ': ' + text);
            return orig.apply(console, arguments);
        };
    });

    // ───────── 2. 高度 / 视口 ─────────

    function setViewportHeight(h) {
        if (typeof h === 'number' && h > 0) {
            document.documentElement.style.setProperty('--TH-viewport-height', h + 'px');
        }
    }
    setViewportHeight(BOOT.viewportHeight);

    var lastHeight = -1;
    var scheduled = false;
    function measure() {
        scheduled = false;
        var body = document.body;
        var html = document.documentElement;
        if (!body || !html) return;
        var h = Math.ceil(Math.max(body.scrollHeight, html.getBoundingClientRect().height));
        if (!isFinite(h) || h <= 0 || h === lastHeight) return;
        lastHeight = h;
        if (h > BOOT.maxHeight) html.style.setProperty('overflow-y', 'auto', 'important');
        try { post({ kind: 'height', height: h }); } catch (e) { /* ignore */ }
    }
    // 不用 requestAnimationFrame：Chromium 对屏幕外的跨源 iframe 会暂停 rAF（ResizeObserver 也跟着渲染节拍走），
    // 聊天里还没滚到的楼层就会一直停在初始高度。setTimeout + MutationObserver 不受影响，读 scrollHeight 会强制同步布局。
    function scheduleMeasure() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(measure, 16);
    }
    function startObserving() {
        measure();
        if (typeof ResizeObserver === 'function') {
            var ro = new ResizeObserver(scheduleMeasure);
            ro.observe(document.documentElement);
            if (document.body) ro.observe(document.body);
        }
        if (typeof MutationObserver === 'function') {
            new MutationObserver(scheduleMeasure).observe(document.documentElement,
                { subtree: true, childList: true, attributes: true, characterData: true });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserving);
    else startObserving();
    W.addEventListener('load', scheduleMeasure);
    // 图片 / 字体等子资源加载完会改变高度（load 事件不冒泡，用捕获）
    W.addEventListener('load', scheduleMeasure, true);
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', scheduleMeasure);

    // ───────── 3. RPC ─────────

    var seq = 0;
    var pending = new Map();
    function rpc(method, args) {
        return new Promise(function (resolve, reject) {
            var id = ++seq;
            var timer = setTimeout(function () {
                if (pending.delete(id)) reject(new Error('SmallTalk: ' + method + ' 超过 120 秒没有回应'));
            }, 120000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            try {
                post({ kind: 'call', id: id, method: method, args: args });
            } catch (e) {
                clearTimeout(timer);
                pending.delete(id);
                reject(new TypeError('SmallTalk: ' + method + ' 的参数无法跨 iframe 传递（不能含函数、DOM 节点等）：' + toText(e)));
            }
        });
    }

    // ───────── 4. 事件 ─────────

    var listeners = new Map(); // name → [{fn, once}]
    function eventOn(name, fn, opts) {
        name = String(name);
        if (typeof fn !== 'function') return { stop: function () {} };
        var list = listeners.get(name);
        if (!list) {
            list = [];
            listeners.set(name, list);
            try { post({ kind: 'subscribe', name: name }); } catch (e) { /* ignore */ }
        }
        var exists = list.some(function (l) { return l.fn === fn; });
        if (!exists) {
            var entry = { fn: fn, once: !!(opts && opts.once) };
            if (opts && opts.first) list.unshift(entry); else list.push(entry);
        }
        return { stop: function () { eventRemoveListener(name, fn); } };
    }
    function dropIfEmpty(name) {
        var list = listeners.get(name);
        if (list && list.length === 0) {
            listeners.delete(name);
            try { post({ kind: 'unsubscribe', name: name }); } catch (e) { /* ignore */ }
        }
    }
    function eventRemoveListener(name, fn) {
        name = String(name);
        var list = listeners.get(name);
        if (!list) return;
        listeners.set(name, list.filter(function (l) { return l.fn !== fn; }));
        dropIfEmpty(name);
    }
    function fireLocal(name, args) {
        var list = listeners.get(name);
        if (!list) return;
        list.slice().forEach(function (l) {
            if (l.once) eventRemoveListener(name, l.fn);
            try {
                var r = l.fn.apply(null, args);
                if (r && typeof r.then === 'function') {
                    r.then(null, function (err) { hostLog('error', '事件 ' + name + ' 的监听器出错：' + toText(err) + hint(toText(err))); });
                }
            } catch (err) {
                hostLog('error', '事件 ' + name + ' 的监听器出错：' + toText(err) + hint(toText(err)));
            }
        });
    }

    W.addEventListener('message', function (e) {
        if (e.source !== HOST) return;
        var d = e.data;
        if (!d || d.smalltalk !== true || d.frameId !== FRAME_ID) return;
        if (d.kind === 'result') {
            var p = pending.get(d.id);
            if (!p) return;
            pending.delete(d.id);
            clearTimeout(p.timer);
            if (d.ok) p.resolve(d.value);
            else p.reject(new Error(String(d.error)));
        } else if (d.kind === 'event') {
            fireLocal(String(d.name), Array.isArray(d.args) ? d.args : []);
        } else if (d.kind === 'viewport') {
            setViewportHeight(d.height);
        }
    });

    // ───────── 5. 全局 API ─────────

    var unimplementedCache = new Map();
    function unimplemented(name) {
        if (!unimplementedCache.has(name)) {
            unimplementedCache.set(name, function () {
                hostLog('unimplemented', name + '(' + argsText(arguments) + ')');
                return Promise.resolve(undefined);
            });
        }
        return unimplementedCache.get(name);
    }

    var impl = {};
    BOOT.bridged.forEach(function (name) {
        impl[name] = function () { return rpc(name, Array.prototype.slice.call(arguments)); };
    });

    var iframeName = 'TH-message--' + MESSAGE_ID + '--' + BOOT.frameIndex;
    impl.getCurrentMessageId = function () { return MESSAGE_ID; }; // 酒馆助手里是同步的
    impl.getIframeName = function () { return iframeName; };
    impl.getMessageId = function (name) {
        var m = /^TH-message--(\d+)--\d+$/.exec(String(name));
        if (!m) throw new Error('getMessageId: 无法从 ' + name + ' 解析出楼层号');
        return Number(m[1]);
    };
    impl.errorCatched = function (fn) {
        return function () {
            try {
                var r = fn.apply(this, arguments);
                if (r && typeof r.then === 'function') {
                    return r.then(null, function (err) { hostLog('error', toText(err) + hint(toText(err))); });
                }
                return r;
            } catch (err) {
                hostLog('error', toText(err) + hint(toText(err)));
            }
        };
    };
    // updateVariablesWith 的参数是函数，没法跨 iframe；在这里拆成 get + replace。
    impl.updateVariablesWith = function (updater, option) {
        return impl.getVariables(option).then(function (vars) {
            return Promise.resolve(updater(vars || {})).then(function (next) {
                next = next === undefined ? vars : next;
                return impl.replaceVariables(next, option).then(function () { return next; });
            });
        });
    };
    impl.triggerSlashWithResult = impl.triggerSlash;

    impl.eventOn = function (n, fn) { return eventOn(n, fn); };
    impl.eventOnButton = function (n, fn) { return eventOn(n, fn); };
    impl.eventMakeLast = function (n, fn) { eventRemoveListener(n, fn); return eventOn(n, fn); };
    impl.eventMakeFirst = function (n, fn) { eventRemoveListener(n, fn); return eventOn(n, fn, { first: true }); };
    impl.eventOnce = function (n, fn) { return eventOn(n, fn, { once: true }); };
    impl.eventRemoveListener = function (n, fn) { eventRemoveListener(n, fn); };
    impl.eventClearEvent = function (n) { listeners.set(String(n), []); dropIfEmpty(String(n)); };
    impl.eventClearListener = function (fn) {
        Array.from(listeners.keys()).forEach(function (n) { eventRemoveListener(n, fn); });
    };
    impl.eventClearAll = function () {
        Array.from(listeners.keys()).forEach(function (n) { impl.eventClearEvent(n); });
    };
    // 先发给本 iframe 自己的监听器，再交给宿主（宿主会转发给其他订阅了的 iframe，并调用 host.call('eventEmit')）
    impl.eventEmit = function (name) {
        var args = Array.prototype.slice.call(arguments, 1);
        fireLocal(String(name), args);
        return rpc('eventEmit', [String(name)].concat(args));
    };
    impl.eventEmitAndWait = impl.eventEmit;

    impl.iframe_events = {
        MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
        MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
        GENERATION_STARTED: 'js_generation_started',
        STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
        STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
        GENERATION_ENDED: 'js_generation_ended',
    };
    impl.tavern_events = {
        APP_READY: 'app_ready',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_UPDATED: 'message_updated',
        CHAT_CHANGED: 'chat_id_changed',
        GENERATION_STARTED: 'generation_started',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
        USER_MESSAGE_RENDERED: 'user_message_rendered',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    };

    function toast(type) {
        return function (message, title) {
            rpc('toastr', [type, toText(message), title === undefined ? '' : toText(title)]).then(null, function () {});
        };
    }
    var toastr = { info: toast('info'), success: toast('success'), warning: toast('warning'), error: toast('error'),
        clear: function () {}, remove: function () {}, options: {} };

    var TavernHelper = new Proxy(impl, {
        get: function (t, p) {
            if (p in t) return t[p];
            if (typeof p !== 'string' || p === 'then' || p === 'toJSON' || p === 'constructor') return undefined;
            return unimplemented(p);
        },
    });

    var context = BOOT.context && typeof BOOT.context === 'object' ? BOOT.context : {};
    function getContext() { return Object.assign({}, context); }
    var SillyTavern = Object.assign({}, context, { getContext: getContext });

    function define(name, value) {
        try {
            Object.defineProperty(W, name, { value: value, configurable: true, writable: true, enumerable: false });
        } catch (e) { /* ignore */ }
    }
    Object.keys(impl).forEach(function (name) { define(name, impl[name]); });
    BOOT.unimplemented.forEach(function (name) { if (!(name in W)) define(name, unimplemented(name)); });
    define('TavernHelper', TavernHelper);
    define('SillyTavern', SillyTavern);
    define('toastr', toastr);
    // 酒馆助手 predefine.js 统一设置的 Vue 标志
    define('__VUE_PROD_DEVTOOLS__', false);
    define('__VUE_OPTIONS_API__', true);
    define('__VUE_PROD_HYDRATION_MISMATCH_DETAILS__', false);
}

/**
 * 通过 RPC 转发给宿主 host.call(method, args, messageId) 的方法，以及宿主要实现的参数形状。
 * 参数 / 返回值必须能被结构化克隆（不能含函数）。形状沿用酒馆助手（JS-Slash-Runner）的签名。
 */
export const BRIDGED_API = Object.freeze([
    { name: 'getChatMessages', args: '[range: number|string, option?: {role?, hide_state?, include_swipes?}]', returns: '酒馆助手 ChatMessage[]：{message_id, name, role, is_hidden, message, data, extra}' },
    { name: 'setChatMessages', args: '[messages: {message_id, message?, name?, role?, is_hidden?, data?}[], option?: {refresh?}]', returns: 'void' },
    { name: 'setChatMessage', args: '[field_values: {message?, data?} | string, message_id: number, option?: {swipe_id?, refresh?}]', returns: 'void（旧 API）' },
    { name: 'createChatMessages', args: '[messages: {role, message, name?, is_hidden?, data?}[], option?: {insert_at?, refresh?}]', returns: 'void' },
    { name: 'deleteChatMessages', args: '[message_ids: number[], option?: {refresh?}]', returns: 'void' },
    { name: 'getLastMessageId', args: '[]', returns: 'number（酒馆助手里是同步的，这里是 Promise）' },
    { name: 'getVariables', args: '[option?: {type?: "chat"|"global"|"message"|"character"|"script", message_id?}]', returns: 'Record<string, any>（同上，Promise）' },
    { name: 'replaceVariables', args: '[variables: object, option?]', returns: 'void' },
    { name: 'insertOrAssignVariables', args: '[variables: object, option?]', returns: 'void' },
    { name: 'insertVariables', args: '[variables: object, option?]', returns: 'void' },
    { name: 'deleteVariable', args: '[path: string, option?]', returns: '{variables, delete_occurred}' },
    { name: 'triggerSlash', args: '[command: string]', returns: 'string（triggerSlashWithResult 是别名）' },
    { name: 'substitudeMacros', args: '[text: string]', returns: 'string（拼写沿用酒馆助手）' },
    { name: 'getCharData', args: '[name?: string]', returns: '角色卡原始 JSON 或 null' },
    { name: 'getCharAvatarPath', args: '[name?: string]', returns: 'string（注意 iframe 是 opaque origin，相对路径要换成绝对 URL）' },
    { name: 'eventEmit', args: '[name: string, ...args]', returns: 'any；桥会先转发给其他订阅了该事件的 iframe，host.call 抛错会被忽略' },
    { name: 'toastr', args: '[type: "info"|"success"|"warning"|"error", message: string, title: string]', returns: '忽略（不等待）' },
]);

/** iframe 内本地实现、不经过宿主的 API。 */
export const LOCAL_API = Object.freeze([
    'getCurrentMessageId', 'getIframeName', 'getMessageId', 'errorCatched', 'updateVariablesWith',
    'triggerSlashWithResult', 'eventOn', 'eventOnButton', 'eventMakeLast', 'eventMakeFirst', 'eventOnce',
    'eventRemoveListener', 'eventClearEvent', 'eventClearListener', 'eventClearAll', 'eventEmitAndWait',
    'iframe_events', 'tavern_events', 'toastr', 'TavernHelper', 'SillyTavern',
    'localStorage', 'sessionStorage', 'document.cookie',
]);

/**
 * 酒馆助手 TavernHelper 上其余的名字（摘自 JS-Slash-Runner src/function/index.ts）。
 * 在 iframe 里它们作为全局函数存在，调用时记一条 unimplemented 日志并 resolve(undefined)，
 * 这样「typeof xxx === 'function'」的卡不会直接 ReferenceError，用户也能在日志里看到卡需要什么。
 */
export const UNIMPLEMENTED_API = Object.freeze([
    'audioEnable', 'audioImport', 'audioMode', 'audioPlay', 'audioSelect', 'playAudio', 'pauseAudio',
    'getAudioList', 'replaceAudioList', 'appendAudioList', 'getAudioSettings', 'setAudioSettings', 'getCurrentAudio',
    'getCharacterNames', 'getCharacterIds', 'getCurrentCharacterName', 'getCurrentCharacterId', 'createCharacter',
    'createOrReplaceCharacter', 'deleteCharacter', 'getCharacter', 'replaceCharacter', 'updateCharacterWith',
    'rotateChatMessages', 'formatAsDisplayedMessage', 'retrieveDisplayedMessage', 'refreshOneMessage',
    'generate', 'generateRaw', 'stopAllGeneration', 'stopGenerationById', 'getModelList',
    'getLorebooks', 'getCharLorebooks', 'getChatLorebook', 'getLorebookEntries', 'setLorebookEntries',
    'createLorebookEntries', 'deleteLorebookEntries', 'getLorebookSettings', 'setLorebookSettings',
    'getPreset', 'getPresetNames', 'getLoadedPresetName', 'loadPreset', 'replacePreset', 'updatePresetWith',
    'getCurrentPersonaName', 'getPersona', 'getChatHistoryBrief', 'getChatHistoryDetail',
    'registerMacroLike', 'unregisterMacroLike', 'getAllEnabledScriptButtons', 'getScriptTrees',
    'formatAsTavernRegexedString', 'getTavernRegexes', 'replaceTavernRegexes', 'updateTavernRegexesWith',
    'isCharacterTavernRegexesEnabled', 'registerVariableSchema', 'getTavernHelperVersion', 'getFrontendVersion',
    'getTavernVersion', 'getWorldbookNames', 'getGlobalWorldbookNames', 'getCharWorldbookNames',
    'getChatWorldbookName', 'getOrCreateChatWorldbook', 'getWorldbook', 'replaceWorldbook', 'updateWorldbookWith',
    'createWorldbookEntries', 'deleteWorldbookEntries', 'rebindGlobalWorldbooks', 'rebindCharWorldbooks',
    'rebindChatWorldbook', 'initializeGlobal', 'waitGlobalInitialized', 'getScriptButtons', 'replaceScriptButtons',
    'getButtonEvent', 'reloadIframe', 'getAllVariables',
]);
