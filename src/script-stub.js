// 酒馆助手脚本沙箱里运行的桩（docs/tavern-helper-plan.md §3.1、§3.2、§3.5；宿主一侧是 src/ui/script-host.js）。
//
// 一张卡一个沙箱（iframe sandbox="allow-scripts …"，绝不给 allow-same-origin），这张卡所有启用的脚本都在里面，共用一个 window（能互通）。
// scriptStubMain 是【自包含】函数：buildScriptSrcdoc 用 toString() 把它（连同 vars-ops.js / script-sync.js 的两个自包含工厂）
// 原样内联进 srcdoc，所以函数体里不能引用本模块的任何变量，也不能出现字面的 `</script` 或 `<!--`（test/script-stub.test.mjs 检查）。
//
// 启动顺序：
//   1. srcdoc 的 <head>：本桩（装好消息监听、存储替身、错误转发、全局 API）→ 库（jQuery、lodash、Vue、Font Awesome，和前端卡同一批本地文件）
//      → 一小段 __smalltalkLibsReady()：包一层 $ / jQuery（找酒馆页面元素的检测），告诉宿主 {kind:'ready'}。
//   2. 宿主回 {kind:'boot', ops, scripts}：ops 是整份副本（聊天、各作用域变量、卡、上下文），scripts 是 [{id, name, info, button, code}]。
//   3. 每个脚本一个 <script type="module" src="blob:…">（代码不经过 HTML 解析，`</script>` 不是问题；报错的 filename 就是这个 blob 地址，
//      于是知道是哪个脚本）。代码前面加【同一行】前缀 `const {getScriptId, eventOn, …} = __smalltalkApi("<脚本 id>");`（行号不变），
//      模块顶层的 const 遮住同名全局，函数里都闭包着这个脚本的 id——同一个 window 里各自的 getScriptId、日志归属、事件监听都分得开。
//      脚本自己也声明了同名的顶层变量时，把那个名字从前缀里去掉（否则重复声明报错），它用到时拿到的是全局版本（按调用栈认是谁）。
//   4. 全部加载完（成功或失败）后本地发一次 APP_READY。
//
// 原型验证（2026-11-23，无头 Edge 146 / Chromium，sandbox="allow-scripts" 的 srcdoc iframe，父页面是 http://127.0.0.1）：
//   - Blob URL 的 module 脚本能加载，地址是 blob:null/<uuid>；一个 blob 模块 import 另一个 blob 模块也行；
//   - 顶层抛错、语法错、顶层 await 之后抛错：window 的 error 事件都能收到，filename = 那个 blob 地址，lineno / colno 对；
//   - 相对路径的 import（'./x.js'）：解析失败，error 事件的 filename 是 about:srcdoc（不是 blob 地址）→ 按报错里的模块名去脚本代码里找是谁；
//   - import 外部地址失败（网络不通 / 没有跨域头）：<script> 元素上的 error 事件（没有 message）→ 按元素上的 data-script-id 归属；
//   - iframe 从 DOM 里移除时，里面会收到 pagehide（之后定时器全停）；unload 不会发。所以拆沙箱不用我们另外派发 pagehide；
//   - 沙箱里 localStorage / indexedDB.open 都抛 SecurityError，parent.document 抛跨源错误。
//   Firefox / Safari 手头没有，没验。
//
// 同步读（getChatMessages、getVariables、getLastMessageId、getCharData、SillyTavern.getContext()…）直接读本地副本 M。
// 写：改聊天的函数（酒馆助手里本来就返回 Promise）走 RPC；变量写（酒馆助手里是同步的）先改本地副本、立刻返回，同时 RPC 给宿主。
//   宿主是唯一权威：应用之后（或者拒绝了）先把这个作用域的权威值推过来、再回结果。同一作用域还有没回结果的写时，推来的值先存着，
//   等最后一个写回了结果再换上——不然「连写两次」时，第一次的回推会把第二次的乐观值盖掉一瞬间。

import { FRAME_LIBS, frameLibTag, embedJson } from './render.js';
import { varOpsFactory } from './vars-ops.js';
import { chatSyncFactory } from './script-sync.js';

/**
 * @param {{frameId: string, unimplemented: Record<string, string>, versions: {helper: string, tavern: string}}} BOOT
 * @param {{varOps: ReturnType<import('./vars-ops.js').varOpsFactory>, sync: ReturnType<import('./script-sync.js').chatSyncFactory>}} LIB
 */
export function scriptStubMain(BOOT, LIB) {
    'use strict';
    var W = window;
    var HOST = W.parent;   // parent 是可以被改掉的属性，先抓住真正的父窗口
    var FRAME_ID = BOOT.frameId;
    var V = LIB.varOps;
    var applyOps = LIB.sync.applyOps;
    var hasOwn = Object.prototype.hasOwnProperty;

    /** 副本：宿主推来的，同步读函数只读它 */
    var M = { chat: [], vars: { chat: {}, global: {}, character: {}, script: Object.create(null) }, card: { raw: null, avatar: '', name: '' }, ctx: {} };
    var SCRIPTS = Object.create(null);   // 脚本 id → {id, name, info, button, code, url, status}
    var ORDER = [];
    var URL2ID = Object.create(null);    // blob 地址 → 脚本 id
    var booted = false, libsReady = false, bootData = null;

    function post(msg) {
        msg.smalltalk = true;
        msg.frameId = FRAME_ID;
        HOST.postMessage(msg, '*');
    }

    function toText(v) {
        try {
            if (v instanceof Error) return v.name + ': ' + v.message;
            if (typeof v === 'string') return v;
            if (typeof v === 'function') return '[function]';
            var s = JSON.stringify(v);
            return s === undefined ? String(v) : s;
        } catch (e) { return String(v); }
    }
    function argsText(args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(toText(args[i]));
        var s = parts.join(', ');
        return s.length > 300 ? s.slice(0, 300) + '…' : s;
    }

    // ───────── 日志（按脚本归属；宿主那边还会限频）─────────

    var logBudget = 2000;
    function log(sid, level, text) {
        if (logBudget <= 0) return;
        logBudget--;
        if (logBudget === 0) { text = '这个沙箱的日志太多，后续日志已省略'; sid = null; }
        try { post({ kind: 'log', scriptId: sid == null ? null : String(sid), level: level, text: String(text).slice(0, 2000) }); } catch (e) { /* 父窗口不在了 */ }
    }
    var said = Object.create(null);
    function logOnce(sid, level, text) {
        var k = String(sid) + '|' + text;
        if (said[k]) return;
        said[k] = 1;
        log(sid, level, text);
    }
    function nameOf(sid) { return sid != null && SCRIPTS[sid] ? (SCRIPTS[sid].name || '(未命名)') : '某个脚本'; }

    /** 从错误栈里认出是哪个脚本（栈里有它的 blob 地址）；认不出 → null */
    function sidFromStack(stack) {
        var s = String(stack || '');
        var re = /blob:[^\s)]+?(?=:\d+:\d+|\)|\s|$)/g, m;
        while ((m = re.exec(s))) {
            var u = m[0];
            if (URL2ID[u] !== undefined) return URL2ID[u];
        }
        return null;
    }
    /** 现在是谁在调（全局版本的函数用：没经过前缀的调用不知道是哪个脚本） */
    function caller() {
        try { throw new Error('who'); } catch (e) { return sidFromStack(e.stack); }
    }
    function setStatus(sid, status, text) {
        var s = SCRIPTS[sid];
        if (!s) return;
        if (status === 'running' && s.status === 'error') return;   // 先报了错的，加载完也算出错
        s.status = status;
        try { post({ kind: 'status', scriptId: sid, status: status, text: text ? String(text).slice(0, 500) : '' }); } catch (e) { /* ignore */ }
    }

    // ───────── opaque origin 的存储 / cookie：内存替身（和前端卡一样；按卡持久化是第 6 期）─────────

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
        return new Proxy(api, {
            get: function (t, p) { if (p in t || typeof p !== 'string') return t[p]; return map.has(p) ? map.get(p) : undefined; },
            set: function (t, p, v) { if (p in t || typeof p !== 'string') return false; map.set(p, String(v)); return true; },
            deleteProperty: function (t, p) { map.delete(String(p)); return true; },
            has: function (t, p) { return p in t || map.has(String(p)); },
            ownKeys: function () { return Array.from(map.keys()); },
            getOwnPropertyDescriptor: function (t, p) { return map.has(String(p)) ? { value: map.get(String(p)), enumerable: true, configurable: true, writable: true } : undefined; },
        });
    }
    ['localStorage', 'sessionStorage'].forEach(function (name) {
        try { void W[name].length; return; } catch (e) { /* SecurityError：装内存替身 */ }
        try { Object.defineProperty(W, name, { value: makeStorage(), configurable: true, enumerable: true, writable: false }); } catch (e) { /* ignore */ }
    });
    try { void document.cookie; } catch (e) {
        var jar = new Map();
        try {
            Object.defineProperty(document, 'cookie', {
                configurable: true,
                get: function () { var out = []; jar.forEach(function (v, k) { out.push(k + '=' + v); }); return out.join('; '); },
                set: function (s) {
                    var first = String(s).split(';')[0], eq = first.indexOf('=');
                    if (eq < 0) return;
                    var k = first.slice(0, eq).trim(), v = first.slice(eq + 1).trim();
                    if (/;\s*max-age=0|;\s*expires=Thu, 01 Jan 1970/i.test(String(s))) jar.delete(k); else jar.set(k, v);
                },
            });
        } catch (e2) { /* 放弃 */ }
    }

    // ───────── 错误归属 ─────────

    function hint(msg) {
        if (/cross-origin|Blocked a frame|跨源|Permission denied to access/i.test(msg)) return ' —— 脚本访问了 parent / top（酒馆的页面），被沙箱拦截：SmallTalk 里脚本运行在独立的沙箱里，碰不到主页面';
        if (/Failed to resolve module specifier|Invalid relative url|bare specifier/i.test(msg)) return ' —— import 的地址不对：沙箱里没有相对路径（./x.js），外部模块要写完整的 https:// 地址';
        var m = /ReferenceError:\s*(?:Can't find variable:\s*)?([\w$]+)/.exec(msg);
        if (m) return ' —— 脚本用到了 SmallTalk 没有提供的全局变量 ' + m[1];
        if (/SecurityError/.test(msg)) return ' —— 沙箱（opaque origin）拦截了这次访问';
        return '';
    }
    /** 报错的 filename 不是 blob 地址时（比如模块名解析失败）：拿报错里引号中的名字去各脚本代码里找 */
    function sidFromMessage(msg) {
        var m = /["'“]([^"'”]+)["'”]/.exec(String(msg));
        if (!m) return null;
        var hit = null;
        ORDER.forEach(function (id) { if (hit === null && SCRIPTS[id].code.indexOf(m[1]) >= 0) hit = id; });
        return hit;
    }
    W.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t !== W && t.tagName) {
            var sid0 = t.getAttribute && t.getAttribute('data-script-id');
            if (sid0 !== null && sid0 !== undefined && SCRIPTS[sid0]) {
                var why = '加载失败：多半是它 import 的外部模块拿不到（网络不通、地址不对，或对方没有允许跨域）';
                log(sid0, 'error', why);
                setStatus(sid0, 'error', why);
            } else {
                log(caller(), 'error', '资源加载失败：<' + t.tagName.toLowerCase() + '> ' + (t.src || t.href || ''));
            }
            return;
        }
        var msg = e.message || (e.error ? toText(e.error) : 'Script error');
        var sid = (e.filename && URL2ID[e.filename] !== undefined) ? URL2ID[e.filename]
            : (sidFromStack(e.error && e.error.stack) ?? sidFromMessage(msg));
        var where = e.lineno ? '（第 ' + e.lineno + ' 行）' : '';
        log(sid, 'error', msg + where + hint(msg));
        if (sid !== null) setStatus(sid, 'error', msg);
    }, true);
    W.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        var msg = '没有处理的 Promise 拒绝：' + toText(r);
        var sid = r && r.smalltalkScriptId !== undefined ? r.smalltalkScriptId : sidFromStack(r && r.stack);
        log(sid, 'error', msg + hint(msg));
    });
    ['error', 'warn'].forEach(function (level) {
        var orig = console[level];
        console[level] = function () {
            var text = argsText(arguments);
            log(caller(), 'console', level + ': ' + text);
            return orig.apply(console, arguments);
        };
    });

    // ───────── RPC ─────────

    var seq = 0;
    var pending = new Map();
    var pendingVar = Object.create(null);   // 作用域 → 还没回结果的变量写的个数
    var stashed = Object.create(null);      // 作用域 → 这期间宿主推来的最新值（等写都回了再换上）
    function rpc(method, args, sid, varKey) {
        return new Promise(function (resolve, reject) {
            var id = ++seq;
            var timer = setTimeout(function () {
                if (pending.has(id)) { settleVar(pending.get(id)); pending.delete(id); reject(new Error('SmallTalk: ' + method + ' 超过 120 秒没有回应')); }
            }, 120000);
            var rec = { resolve: resolve, reject: reject, timer: timer, varKey: varKey, sid: sid };
            if (varKey) pendingVar[varKey] = (pendingVar[varKey] || 0) + 1;
            pending.set(id, rec);
            try {
                post({ kind: 'call', id: id, method: method, args: args, scriptId: sid == null ? null : String(sid) });
            } catch (e) {
                clearTimeout(timer);
                pending.delete(id);
                settleVar(rec);
                reject(new TypeError('SmallTalk: ' + method + ' 的参数没法传给宿主（不能含函数、DOM 节点等）：' + toText(e)));
            }
        });
    }
    function settleVar(rec) {
        var k = rec && rec.varKey;
        if (!k) return;
        pendingVar[k] = Math.max(0, (pendingVar[k] || 0) - 1);
        if (pendingVar[k] === 0 && stashed[k]) { var op = stashed[k]; delete stashed[k]; applyOps(M, [op]); }
    }
    var varKeyOf = function (op) { return op.scope === 'script' ? 's:' + op.id : op.scope; };

    // ───────── 事件（本地分发；宿主推 {kind:'event'}）─────────

    var listeners = new Map();   // 事件名 → [{fn, once, sid}]
    function on(sid, name, fn, opts) {
        name = String(name);
        if (typeof fn !== 'function') return { stop: function () {} };
        var list = listeners.get(name);
        if (!list) { list = []; listeners.set(name, list); }
        var exists = list.some(function (l) { return l.fn === fn; });   // 酒馆助手：同一个函数重复注册无效
        if (!exists) {
            var entry = { fn: fn, once: !!(opts && opts.once), sid: sid };
            if (opts && opts.first) list.unshift(entry); else list.push(entry);
        }
        return { stop: function () { off(name, fn); } };
    }
    function off(name, fn) {
        var list = listeners.get(String(name));
        if (!list) return;
        listeners.set(String(name), list.filter(function (l) { return l.fn !== fn; }));
    }
    function fire(name, args) {
        var list = listeners.get(String(name));
        if (!list) return;
        list.slice().forEach(function (l) {
            if (l.once) off(name, l.fn);
            var fail = function (err) { var t = '事件 ' + name + ' 的监听器出错：' + toText(err); log(l.sid ?? sidFromStack(err && err.stack), 'error', t + hint(toText(err))); };
            try {
                var r = l.fn.apply(null, args);
                if (r && typeof r.then === 'function') r.then(null, fail);
            } catch (err) { fail(err); }
        });
    }

    // ───────── 宿主的消息 ─────────

    W.addEventListener('message', function (e) {
        if (e.source !== HOST) return;
        var d = e.data;
        if (!d || d.smalltalk !== true || d.frameId !== FRAME_ID) return;
        if (d.kind === 'result') {
            var p = pending.get(d.id);
            if (!p) return;
            pending.delete(d.id);
            clearTimeout(p.timer);
            settleVar(p);
            if (d.ok) p.resolve(d.value);
            else { var err = new Error(String(d.error)); err.smalltalkScriptId = p.sid; p.reject(err); }   // 记下是谁调的：没接住的拒绝也能归属
        } else if (d.kind === 'sync') {
            var ops = Array.isArray(d.ops) ? d.ops : [];
            var now = [];
            ops.forEach(function (op) {
                if (op && op.op === 'vars' && pendingVar[varKeyOf(op)] > 0) stashed[varKeyOf(op)] = op;
                else now.push(op);
            });
            applyOps(M, now);
        } else if (d.kind === 'event') {
            fire(String(d.name), Array.isArray(d.args) ? d.args : []);
        } else if (d.kind === 'boot' && !booted) {
            bootData = d;
            maybeStart();
        }
    });

    // ───────── 同步读 ─────────

    function clone(v) { return v === undefined ? undefined : structuredClone(v); }
    function parseRange(range) {
        var last = M.chat.length - 1;
        var norm = function (n) { return n < 0 ? last + 1 + n : n; };
        var text = String(range === undefined || range === null ? '0-' + last : range).split('{{lastMessageId}}').join(String(last));
        var m = /^\s*(-?\d+)\s*(?:-\s*(-?\d+))?\s*$/.exec(text);
        if (!m) return [];
        var a = norm(Number(m[1])), b = m[2] === undefined ? a : norm(Number(m[2]));
        var out = [];
        for (var i = Math.max(0, Math.min(a, b)); i <= Math.min(last, Math.max(a, b)); i++) out.push(i);
        return out;
    }
    function getChatMessages(range, option) {
        var o = option && typeof option === 'object' ? option : {};
        var role = ['system', 'assistant', 'user'].indexOf(o.role) >= 0 ? o.role : null;
        var hs = o.hide_state === 'hidden' || o.hide_state === 'unhidden' ? o.hide_state : 'all';
        return parseRange(range).map(function (i) {
            var m = M.chat[i];
            return { message_id: i, name: m.name, role: m.role, is_hidden: m.is_hidden, message: m.message, data: clone(m.data || {}), extra: clone(m.extra || {}) };
        }).filter(function (m) { return (!role || m.role === role) && (hs === 'all' || m.is_hidden === (hs === 'hidden')); });
    }
    function resolveMessageId(id, len) {
        var n;
        if (typeof id === 'number') n = id;
        else if (typeof id === 'string' && /^\s*-?\d+\s*$/.test(id)) n = Number(id);
        else return null;
        if (!Number.isInteger(n)) return null;
        if (n < 0) n = len + n;
        return n >= 0 && n < len ? n : null;
    }

    /** option → {key, get(), set(v)}；写和读对 message 的 'latest' 不一样（照酒馆助手） */
    function scopeOf(option, sid, method, write) {
        var o = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
        var type = o.type === undefined ? 'chat' : o.type;
        if (type === 'chat' || type === 'global' || type === 'character') {
            return { key: type, get: function () { return M.vars[type] || {}; }, set: function (v) { M.vars[type] = v; } };
        }
        if (type === 'script') {
            if (sid == null) throw new Error(method + '：SmallTalk 没法确定是哪个脚本在调用（请直接在脚本里调，不要经过别的库）');
            return { key: 's:' + sid, get: function () { return M.vars.script[sid] || {}; }, set: function (v) { M.vars.script[sid] = v; } };
        }
        if (type === 'message') {
            var len = M.chat.length, index = -1;
            if (!len) throw new Error(method + '：聊天里还没有消息，没有楼层变量');
            if (o.message_id === undefined || o.message_id === 'latest') {
                if (write) index = len - 1;
                else for (var i = len - 1; i >= 0; i--) if (!M.chat[i].is_hidden) { index = i; break; }
                if (index < 0) return { key: 'empty', get: function () { return {}; }, set: function () {} };
            } else {
                index = resolveMessageId(o.message_id, len);
                if (index === null) throw new Error(method + "：提供的消息楼层号 '" + o.message_id + "' 超出了范围 [" + (-len) + ', ' + len + ')');
            }
            return { key: 'm:' + index, get: function () { return (M.chat[index] && M.chat[index].data) || {}; },
                set: function (v) { if (M.chat[index]) M.chat[index] = Object.assign({}, M.chat[index], { data: v }); } };
        }
        if (type === 'preset' || type === 'extension') return { key: 'empty', get: function () { return {}; }, set: function () {} };
        throw new Error(method + '：不认识的变量类型 ' + toText(type));
    }
    function cleanTable(vars, method) {
        if (!V.isPlain(vars)) throw new TypeError(method + '：变量必须是一个对象');
        var r = V.sanitize(vars);
        if (!r.ok) throw new Error(method + '：' + r.error);
        return r.value;
    }
    /** 变量写：先改本地副本、立刻得到结果，同时告诉宿主（宿主拒绝时它会把权威值推回来，这里记一条日志） */
    function varWrite(sid, method, option, args, compute) {
        var sc = scopeOf(option, sid, method, true);
        var r = compute(sc.get());
        if (r.next !== undefined) sc.set(r.next);
        var o = option && typeof option === 'object' ? option : {};
        var varKey = sc.key === 'empty' || sc.key.indexOf('m:') === 0 ? null : sc.key;
        rpc(method, [args[0], o], sid, varKey).then(null, function (err) {
            log(sid, 'warn', method + ' 没有生效：' + (err && err.message) + '（本地的值已经换回宿主那边的）');
        });
        return r.result;
    }

    function makeApi(fixedSid) {
        var sidOf = function () { return fixedSid !== null ? fixedSid : caller(); };
        var need = function (fn) {
            var s = sidOf();
            if (s == null) throw new Error(fn + '：SmallTalk 没法确定是哪个脚本在调用（请直接在脚本里调，不要经过别的库）');
            return s;
        };
        var buttonsNote = function (s, fn) { logOnce(s, 'unimplemented', fn + '：脚本按钮将在后续版本支持（现在按钮不会显示，改动只在这一次运行里有效）'); };
        var api = {};
        api.getScriptId = function () { return need('getScriptId'); };
        api.getScriptName = function () { return SCRIPTS[need('getScriptName')].name; };
        api.getScriptInfo = function () { return SCRIPTS[need('getScriptInfo')].info; };
        api.replaceScriptInfo = function (info) { var s = need('replaceScriptInfo'); SCRIPTS[s].info = String(info === undefined ? '' : info).slice(0, 10000); logOnce(s, 'unimplemented', 'replaceScriptInfo：改动只在这一次运行里有效（不写回卡里）'); };
        api.getIframeName = function () { var s = need('getIframeName'); return 'TH-script--' + SCRIPTS[s].name + '--' + s; };
        api.getButtonEvent = function (name) { var s = need('getButtonEvent'); buttonsNote(s, 'getButtonEvent'); return s + '_' + cyrb53(String(name)); };
        api.getScriptButtons = function () { var s = need('getScriptButtons'); return clone(SCRIPTS[s].button.buttons); };
        api.replaceScriptButtons = function (a, b) {
            var s = need('replaceScriptButtons');
            var list = Array.isArray(a) ? a : b;
            if (!Array.isArray(list)) return;
            buttonsNote(s, 'replaceScriptButtons');
            SCRIPTS[s].button.buttons = cleanButtons(list);
        };
        api.appendInexistentScriptButtons = function (a, b) {
            var s = need('appendInexistentScriptButtons');
            var list = Array.isArray(a) ? a : b;
            if (!Array.isArray(list)) return;
            buttonsNote(s, 'appendInexistentScriptButtons');
            var cur = SCRIPTS[s].button.buttons;
            cleanButtons(list).forEach(function (x) { if (!cur.some(function (y) { return y.name === x.name; })) cur.push(x); });
        };
        api.updateScriptButtonsWith = function (fn) {
            var s = need('updateScriptButtonsWith');
            buttonsNote(s, 'updateScriptButtonsWith');
            var r = fn(clone(SCRIPTS[s].button.buttons));
            var done = function (list) { if (Array.isArray(list)) SCRIPTS[s].button.buttons = cleanButtons(list); return clone(SCRIPTS[s].button.buttons); };
            return r && typeof r.then === 'function' ? r.then(done) : done(r);
        };
        api.eventOn = function (n, fn) { return on(sidOf(), n, fn); };
        api.eventOnce = function (n, fn) { return on(sidOf(), n, fn, { once: true }); };
        api.eventMakeFirst = function (n, fn) { off(n, fn); return on(sidOf(), n, fn, { first: true }); };
        api.eventMakeLast = function (n, fn) { off(n, fn); return on(sidOf(), n, fn); };
        api.eventOnButton = function (n, fn) { return api.eventOn(api.getButtonEvent(n), fn); };
        api.eventRemoveListener = function (n, fn) { off(n, fn); };
        api.eventClearEvent = function (n) { listeners.delete(String(n)); };
        api.eventClearListener = function (fn) { Array.from(listeners.keys()).forEach(function (n) { off(n, fn); }); };
        // 只清这个脚本自己注册的（酒馆助手里每个脚本一个 iframe，eventClearAll 清的也只是自己的）
        api.eventClearAll = function () {
            var s = sidOf();
            listeners.forEach(function (list, n) { listeners.set(n, list.filter(function (l) { return l.sid !== s; })); });
        };
        api.eventEmit = function (name) {
            var args = Array.prototype.slice.call(arguments, 1);
            fire(String(name), args);
            return rpc('eventEmit', [String(name)].concat(args), sidOf());
        };
        api.eventEmitAndWait = api.eventEmit;

        api.getVariables = function (option) { return clone(scopeOf(option, sidOf(), 'getVariables', false).get()); };
        api.replaceVariables = function (vars, option) {
            var s = sidOf(), v = cleanTable(vars, 'replaceVariables');
            varWrite(s, 'replaceVariables', option, [v], function () { return { next: v, result: undefined }; });
        };
        api.insertOrAssignVariables = function (vars, option) {
            var s = sidOf(), v = cleanTable(vars, 'insertOrAssignVariables');
            return varWrite(s, 'insertOrAssignVariables', option, [v], function (cur) { var next = V.merge(cur, v); return { next: next, result: clone(next) }; });
        };
        api.insertVariables = function (vars, option) {
            var s = sidOf(), v = cleanTable(vars, 'insertVariables');
            return varWrite(s, 'insertVariables', option, [v], function (cur) { var next = V.insert(cur, v); return { next: next, result: clone(next) }; });
        };
        api.deleteVariable = function (path, option) {
            var s = sidOf();
            return varWrite(s, 'deleteVariable', option, [path], function (cur) {
                var r = V.unset(cur, path);
                return { next: r.deleted ? r.value : undefined, result: { variables: clone(r.value), delete_occurred: r.deleted } };
            });
        };
        api.updateVariablesWith = function (fn, option) {
            var cur = api.getVariables(option);
            var r = fn(cur);
            var done = function (next) { next = next === undefined ? cur : next; api.replaceVariables(next, option); return next; };
            return r && typeof r.then === 'function' ? r.then(done) : done(r);
        };
        api.getAllVariables = function () {
            var s = sidOf(), out = {};
            var add = function (t) { Object.keys(t || {}).forEach(function (k) { if (k !== '__proto__') out[k] = t[k]; }); };
            add(M.vars.global); add(M.vars.character);
            if (s != null) add(M.vars.script[s]);
            add(M.vars.chat);
            return clone(out);
        };
        api.registerVariableSchema = function () { /* 只影响酒馆助手的变量管理器界面，对代码没有作用 */ };

        api.setChatMessages = function (msgs, opt) { return rpc('setChatMessages', [msgs, opt], sidOf()); };
        api.setChatMessage = function (v, id, opt) { return rpc('setChatMessage', [v, id, opt], sidOf()); };
        api.createChatMessages = function (msgs, opt) { return rpc('createChatMessages', [msgs, opt], sidOf()); };
        api.deleteChatMessages = function (ids, opt) { return rpc('deleteChatMessages', [ids, opt], sidOf()); };
        api.triggerSlash = function (cmd) { return rpc('triggerSlash', [String(cmd)], sidOf()); };
        api.triggerSlashWithResult = api.triggerSlash;
        api.substitudeMacros = function (text) { return rpc('substitudeMacros', [String(text === undefined ? '' : text)], sidOf()); };
        api.reloadIframe = function () { rpc('reloadIframe', [], sidOf()).then(null, function () {}); };
        api.errorCatched = function (fn) {
            return function () {
                var s = sidOf();
                try {
                    var r = fn.apply(this, arguments);
                    if (r && typeof r.then === 'function') return r.then(null, function (err) { log(s, 'error', toText(err) + hint(toText(err))); throw err; });
                    return r;
                } catch (err) { log(s, 'error', toText(err) + hint(toText(err))); throw err; }
            };
        };
        api.$ = jqFor(fixedSid);
        api.jQuery = api.$;
        return api;
    }

    function cleanButtons(list) {
        var out = [];
        list.forEach(function (b) {
            if (out.length >= 50 || !b || typeof b !== 'object') return;
            out.push({ name: String(b.name === undefined ? '' : b.name).slice(0, 100), visible: b.visible !== false });
        });
        return out;
    }
    /** 酒馆 utils.js getStringHash 用的 cyrb53（公有领域的 53 位字符串哈希，按算法自己写的）；酒馆助手的按钮事件名 = 脚本 id + '_' + 它 */
    function cyrb53(str) {
        var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (var i = 0; i < str.length; i++) {
            var ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    // ───────── 找酒馆页面元素：只报告、不改返回值 ─────────
    // 酒馆里脚本的 $ 是酒馆主页面的 jQuery，下面这些都是酒馆页面上的元素；SmallTalk 的沙箱里没有它们
    var TAVERN = [
        ['#send_textarea', '输入框'], ['#send_but', '发送按钮'], ['#send_form', '输入区'], ['#chat', '聊天区'], ['.mes_text', '楼层的正文'],
        ['.mes_buttons', '楼层的按钮'], ['.mes', '楼层'], ['#extensionsMenu', '扩展菜单'], ['#qr--bar', '快速回复栏'], ['#leftSendForm', '输入区左边的按钮'],
        ['#rightSendForm', '输入区右边的按钮'], ['#options', '选项菜单'], ['#top-bar', '顶栏'], ['#top-settings-holder', '顶栏的设置'],
        ['#character_popup', '角色卡弹窗'], ['#sheld', '聊天栏'], ['#expression-wrapper', '表情立绘'], ['#movingDivs', '浮动面板'],
        ['#extensions_settings', '扩展设置面板'], ['#extensions_settings2', '扩展设置面板'], ['#form_sheld', '输入区'], ['#chat_header', '聊天区顶部'],
    ];
    function tavernHit(sel) {
        if (typeof sel !== 'string') return null;
        for (var i = 0; i < TAVERN.length; i++) {
            var k = TAVERN[i][0], at = sel.indexOf(k);
            while (at >= 0) {
                var after = sel.charAt(at + k.length);
                if (!/[\w-]/.test(after)) return TAVERN[i];
                at = sel.indexOf(k, at + 1);
            }
        }
        return null;
    }
    function domCheck(sel, sid) {
        var hit = tavernHit(sel);
        if (!hit) return;
        if (sid === undefined) sid = caller();
        logOnce(sid, 'unsupported', '脚本「' + nameOf(sid) + '」想操作酒馆页面的 ' + hit[0] + '（' + hit[1] + '），SmallTalk 不支持：脚本运行在独立的沙箱里，没有酒馆的页面元素');
    }
    var JQ = null;
    var jqCache = Object.create(null);
    function jqFor(sid) {
        var k = sid === null ? '\u0000global' : sid;
        if (jqCache[k]) return jqCache[k];
        var p = new Proxy(function () {}, {
            apply: function (t, self, args) {
                if (!JQ) throw new Error('jQuery 还没加载');
                var r = JQ.apply(self, args);
                var sel = args[0];
                if (typeof sel === 'string' && sel.trim().charAt(0) !== '<' && r && r.length === 0) domCheck(sel, sid === null ? undefined : sid);
                return r;
            },
            get: function (t, prop) { return JQ ? JQ[prop] : undefined; },
            set: function (t, prop, v) { if (JQ) JQ[prop] = v; return true; },
            has: function (t, prop) { return JQ ? prop in JQ : false; },
        });
        jqCache[k] = p;
        return p;
    }
    ['querySelector', 'querySelectorAll', 'getElementById'].forEach(function (fnName) {
        var orig = Document.prototype[fnName];
        Document.prototype[fnName] = function (s) {
            var r = orig.apply(this, arguments);
            var empty = fnName === 'querySelectorAll' ? r.length === 0 : !r;
            if (empty && this === document) domCheck(fnName === 'getElementById' ? '#' + s : s);
            return r;
        };
    });

    // ───────── 全局：没实现的、SillyTavern、TavernHelper ─────────

    var unimpl = Object.create(null);
    function unimplemented(name) {
        if (!unimpl[name]) {
            var why = BOOT.unimplemented[name] || 'SmallTalk 暂不支持';
            unimpl[name] = function () {
                var s = caller();
                logOnce(s, why.indexOf('不支持') === 0 && why.indexOf('暂') < 0 ? 'unsupported' : 'unimplemented', '脚本「' + nameOf(s) + '」调用了 ' + name + '：' + why);
                return Promise.resolve(undefined);
            };
        }
        return unimpl[name];
    }

    function context() {
        var c = {
            chat: M.chat.map(function (m) { return { name: m.name, is_user: m.role === 'user', is_system: m.is_hidden, mes: m.message, message_id: m.message_id, swipe_id: m.swipe_id, swipes: m.swipes.slice() }; }),
            name1: M.ctx.name1, name2: M.ctx.name2, characterId: 0, chatId: M.ctx.chatId, groupId: null,
            characters: [{ name: M.ctx.name2, avatar: '', data: clone(M.card.raw && M.card.raw.data) }],
            chatMetadata: { variables: clone(M.vars.chat) },
            getCurrentChatId: function () { return M.ctx.chatId; },
            onlineStatus: 'connected',
        };
        return new Proxy(c, {
            get: function (t, p) {
                if (typeof p === 'string' && !(p in t) && p !== 'then' && p !== 'toJSON') logOnce(caller(), 'unsupported', 'SmallTalk 没有提供 SillyTavern.getContext().' + p + '（读到的是 undefined）');
                return t[p];
            },
        });
    }
    var SillyTavern = new Proxy({}, {
        get: function (t, p) {
            if (p === 'getContext') return context;
            if (typeof p !== 'string' || p === 'then' || p === 'toJSON') return undefined;
            return context()[p];
        },
    });

    var GLOBAL = makeApi(null);
    var impl = {};
    Object.keys(GLOBAL).forEach(function (k) { impl[k] = GLOBAL[k]; });
    impl.getChatMessages = getChatMessages;
    impl.getLastMessageId = function () { return M.chat.length - 1; };
    impl.getCurrentMessageId = function () { throw new Error('getCurrentMessageId 只能在消息里的前端卡里用（脚本不在任何一楼里）'); };
    impl.getMessageId = function (name) {
        var m = /^TH-message--(\d+)--\d+$/.exec(String(name));
        if (!m) throw new Error('getMessageId: 无法从 ' + name + ' 解析出楼层号');
        return Number(m[1]);
    };
    impl.getCharData = function (name) {
        if (name === undefined || name === null || name === 'current' || name === M.ctx.name2) return clone(M.card.raw);
        return null;
    };
    impl.getCharAvatarPath = function (name) {
        if (name === undefined || name === null || name === 'current' || name === M.ctx.name2) return M.card.avatar || null;
        return null;
    };
    impl.getCurrentCharacterName = function () { return M.ctx.name2; };
    impl.getCharacterNames = function () { return [M.ctx.name2]; };
    impl.getCurrentPersonaName = function () { return M.ctx.name1; };
    impl.getTavernHelperVersion = function () { return BOOT.versions.helper; };
    impl.getFrontendVersion = impl.getTavernHelperVersion;
    impl.getTavernVersion = function () { return BOOT.versions.tavern; };
    impl.initializeGlobal = function (name, value) {
        name = String(name);
        try { Object.defineProperty(W, name, { value: value, configurable: true, writable: true, enumerable: false }); } catch (e) { /* ignore */ }
        fire('global_' + name + '_initialized', []);
    };
    impl.waitGlobalInitialized = function (name) {
        name = String(name);
        if (name in W) return Promise.resolve(W[name]);
        return new Promise(function (resolve) { on(null, 'global_' + name + '_initialized', function () { resolve(W[name]); }, { once: true }); });
    };
    impl.getAllEnabledScriptButtons = function () {
        var out = {};
        ORDER.forEach(function (id) {
            var b = SCRIPTS[id].button;
            if (b && b.enabled) out[id] = b.buttons.filter(function (x) { return x.visible; }).map(function (x) { return { button_id: id + '_' + cyrb53(x.name), button_name: x.name }; });
        });
        return out;
    };
    impl.iframe_events = {
        MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
        GENERATION_REQUESTED: 'js_generation_requested', GENERATION_STARTED: 'js_generation_started',
        STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully', STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
        GENERATION_ENDED: 'js_generation_ended',
    };
    impl.tavern_events = {
        APP_READY: 'app_ready', MESSAGE_SWIPED: 'message_swiped', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
        MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated', CHAT_CHANGED: 'chat_id_changed',
        CHAT_CREATED: 'chat_created', CHAT_DELETED: 'chat_deleted', GENERATION_STARTED: 'generation_started', GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended', STREAM_TOKEN_RECEIVED: 'stream_token_received', USER_MESSAGE_RENDERED: 'user_message_rendered',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
    };
    function toast(type) {
        return function (message, title) { rpc('toastr', [type, toText(message), title === undefined ? '' : toText(title)], caller()).then(null, function () {}); };
    }
    impl.toastr = { info: toast('info'), success: toast('success'), warning: toast('warning'), error: toast('error'), clear: function () {}, remove: function () {}, options: {} };

    var TavernHelper = new Proxy(impl, {
        get: function (t, p) {
            if (p in t) return t[p];
            if (typeof p !== 'string' || p === 'then' || p === 'toJSON' || p === 'constructor') return undefined;
            return unimplemented(p);
        },
    });
    function define(name, value, writable) {
        try { Object.defineProperty(W, name, { value: value, configurable: true, writable: writable !== false, enumerable: false }); } catch (e) { /* ignore */ }
    }
    Object.keys(impl).forEach(function (name) { if (name !== '$' && name !== 'jQuery') define(name, impl[name]); });
    Object.keys(BOOT.unimplemented).forEach(function (name) { if (!(name in W)) define(name, unimplemented(name)); });
    define('TavernHelper', TavernHelper);
    define('SillyTavern', SillyTavern);
    define('__VUE_PROD_DEVTOOLS__', false);
    define('__VUE_OPTIONS_API__', true);
    define('__VUE_PROD_HYDRATION_MISMATCH_DETAILS__', false);

    // 每个脚本一份的函数（前缀里解构出来的就是这个对象）。只认启动时登记过的脚本 id
    var PREFIX_NAMES = Object.keys(GLOBAL);
    define('__smalltalkApi', function (sid) {
        sid = String(sid);
        if (!SCRIPTS[sid]) throw new Error('__smalltalkApi：不认识的脚本 id ' + sid);
        if (!SCRIPTS[sid].api) SCRIPTS[sid].api = makeApi(sid);
        return SCRIPTS[sid].api;
    }, false);

    /** 脚本自己声明了同名的顶层变量 / 函数 / import：这个名字不能放进前缀（会重复声明） */
    function declared(code, name) {
        var n = name.replace(/\$/g, '\\$');
        var re = new RegExp('(?:^|[^.\\w$])(?:(?:const|let|var)\\s+' + n + '(?![\\w$])|function\\s*\\*?\\s*' + n + '\\s*\\(|class\\s+' + n + '(?![\\w$])|import\\s+' + n + '(?![\\w$])|\\bas\\s+' + n + '(?![\\w$])|(?:const|let|var)\\s*[{[][^}\\]]*(?:^|[^.\\w$])' + n + '(?![\\w$]))');
        return re.test(code);
    }

    // ───────── 启动：库加载完 + 宿主的 boot 都到了才装脚本 ─────────

    function maybeStart() {
        if (booted || !libsReady || !bootData) return;
        booted = true;
        applyOps(M, Array.isArray(bootData.ops) ? bootData.ops : []);
        var list = Array.isArray(bootData.scripts) ? bootData.scripts : [];
        list.forEach(function (s) {
            var id = String(s.id);
            if (SCRIPTS[id]) return;
            SCRIPTS[id] = { id: id, name: String(s.name || ''), info: String(s.info || ''), code: String(s.code || ''),
                button: { enabled: !!(s.button && s.button.enabled !== false), buttons: cleanButtons((s.button && Array.isArray(s.button.buttons)) ? s.button.buttons : []) },
                status: 'loading', api: null };
            ORDER.push(id);
        });
        var left = ORDER.length;
        var doneOne = function () { left--; if (left === 0) fire('app_ready', []); };
        if (!left) return;
        ORDER.forEach(function (id) {
            var s = SCRIPTS[id];
            var skip = PREFIX_NAMES.filter(function (n) { return declared(s.code, n); });
            if (skip.length) log(id, 'warn', '脚本自己声明了 ' + skip.join('、') + '：这几个名字用的是全局版本（getScriptId 等按调用栈认是哪个脚本，认不出来时会报错）');
            var names = PREFIX_NAMES.filter(function (n) { return skip.indexOf(n) < 0; });
            var prefix = 'const {' + names.join(', ') + '} = __smalltalkApi(' + JSON.stringify(id) + ');';
            var url = URL.createObjectURL(new Blob([prefix + s.code], { type: 'text/javascript' }));
            s.url = url;
            URL2ID[url] = id;
            var el = document.createElement('script');
            el.type = 'module';
            el.setAttribute('data-script-id', id);
            el.onload = function () { setStatus(id, 'running'); doneOne(); };
            el.onerror = function () { doneOne(); };   // 原因由上面的 error 监听（捕获阶段）记
            el.src = url;
            document.head.appendChild(el);
        });
    }

    define('__smalltalkLibsReady', function () {
        if (libsReady) return;
        libsReady = true;
        JQ = typeof W.jQuery === 'function' ? W.jQuery : null;
        if (JQ) { define('$', jqFor(null)); define('jQuery', jqFor(null)); }
        try { post({ kind: 'ready' }); } catch (e) { /* ignore */ }
        maybeStart();
    }, false);
}

/**
 * 脚本里调用时只记一条日志、resolve(undefined) 的名字，以及日志里怎么说（「暂不支持」= 用户说先不做或以后会做；「不支持」= 注定做不了）。
 * 摘自酒馆助手 4.12.2 的 TavernHelper 全集里我们没实现的那些（只是名字，用来让「typeof xxx === 'function'」的脚本不直接 ReferenceError，
 * 也让用户在日志里看到卡要什么）。
 */
const LATER = 'SmallTalk 暂不支持（以后的版本可能会做）';
const NOT_NOW = 'SmallTalk 暂不支持（这一类功能先不做：脚本改世界书 / 预设、往发送内容里插东西、注册新的宏）';
const NEVER_SERVER = '不支持：它要用酒馆的服务器 / 酒馆主页面，SmallTalk 没有';
const NEVER_KEY = '不支持：它要用别的接口地址和 key，SmallTalk 只用你在「接口」页选的接口';
export const SCRIPT_UNIMPLEMENTED = Object.freeze({
    ...Object.fromEntries(['audioEnable', 'audioImport', 'audioMode', 'audioPlay', 'audioSelect', 'playAudio', 'pauseAudio', 'getAudioList', 'replaceAudioList',
        'appendAudioList', 'getAudioSettings', 'setAudioSettings', 'getCurrentAudio', 'rotateChatMessages', 'formatAsDisplayedMessage', 'refreshOneMessage',
        'generate', 'generateRaw', 'stopAllGeneration', 'stopGenerationById', 'getScriptTrees', 'replaceScriptTrees', 'updateScriptTreesWith',
        'formatAsTavernRegexedString', 'getTavernRegexes', 'isCharacterTavernRegexesEnabled', 'getCharacterIds', 'getCurrentCharacterId', 'getCharacter',
        'getPersonaNames', 'getPersonaIds', 'getCurrentPersonaId', 'getPersona', 'getPersonaAvatarPath'].map(n => [n, LATER])),
    ...Object.fromEntries(['getLorebooks', 'getCharLorebooks', 'getChatLorebook', 'getLorebookEntries', 'setLorebookEntries', 'createLorebookEntries',
        'deleteLorebookEntries', 'getLorebookSettings', 'setLorebookSettings', 'getWorldbookNames', 'getGlobalWorldbookNames', 'getCharWorldbookNames',
        'getChatWorldbookName', 'getOrCreateChatWorldbook', 'getWorldbook', 'createWorldbook', 'createOrReplaceWorldbook', 'deleteWorldbook', 'replaceWorldbook',
        'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries', 'rebindGlobalWorldbooks', 'rebindCharWorldbooks', 'rebindChatWorldbook',
        'getPreset', 'getPresetNames', 'getLoadedPresetName', 'loadPreset', 'createPreset', 'createOrReplacePreset', 'deletePreset', 'renamePreset',
        'replacePreset', 'updatePresetWith', 'setPreset', 'injectPrompts', 'uninjectPrompts', 'registerMacroLike', 'unregisterMacroLike',
        'replaceTavernRegexes', 'updateTavernRegexesWith', 'createCharacter', 'createOrReplaceCharacter', 'replaceCharacter', 'updateCharacterWith',
        'deleteCharacter', 'createPersona', 'createOrReplacePersona', 'replacePersona', 'updatePersonaWith', 'deletePersona'].map(n => [n, NOT_NOW])),
    ...Object.fromEntries(['retrieveDisplayedMessage', 'getChatHistoryBrief', 'getChatHistoryDetail', 'isAdmin', 'getTavernHelperExtensionId',
        'getExtensionType', 'getExtensionStatus', 'isInstalledExtension', 'installExtension', 'uninstallExtension', 'reinstallExtension', 'updateExtension',
        'getTavernFile', 'uploadTavernFile', 'deleteTavernFile', 'importRawCharacter', 'importRawPreset', 'importRawChat', 'importRawWorldbook',
        'importRawTavernRegex', 'updateTavernHelper', 'builtin'].map(n => [n, NEVER_SERVER])),
    ...Object.fromEntries(['getModelList', 'getProxyPresetNames'].map(n => [n, NEVER_KEY])),
});

/** 脚本能 RPC 到宿主的方法（白名单）。变量的读、聊天的读都在沙箱里同步做，不在这里 */
export const SCRIPT_BRIDGED = Object.freeze(['setChatMessages', 'setChatMessage', 'createChatMessages', 'deleteChatMessages',
    'replaceVariables', 'insertOrAssignVariables', 'insertVariables', 'deleteVariable', 'triggerSlash', 'substitudeMacros', 'eventEmit', 'toastr', 'reloadIframe']);

/** 兼容版本号（脚本常用来判断版本）：照着学的酒馆助手 / 酒馆版本 */
export const COMPAT_VERSIONS = Object.freeze({ helper: '4.12.2', tavern: '1.19.0' });

/** 脚本的库：和前端卡同一批本地文件，去掉 Tailwind（酒馆助手的脚本 iframe 也不带它），lodash 总是带（酒馆助手给脚本的 _ 是父页面的 lodash） */
const SCRIPT_LIBS = ['fontawesome', 'jquery', 'lodash', 'vue'];

/**
 * 沙箱的 srcdoc（纯函数，Node 里可测）。只有桩和库，【没有】脚本代码——代码在 boot 消息里，用 Blob URL 加载（见 script-stub.js 文件头）。
 * @param {{frameId: string, assetBase?: string}} opts
 */
export function buildScriptSrcdoc({ frameId, assetBase }) {
    const boot = { frameId: String(frameId), unimplemented: SCRIPT_UNIMPLEMENTED, versions: COMPAT_VERSIONS };
    const lib = `{varOps: (${varOpsFactory.toString()})(), sync: (${chatSyncFactory.toString()})()}`;
    const stub = `<script data-smalltalk-script-stub>(${scriptStubMain.toString()})(${embedJson(boot)}, ${lib});</script>`;
    const libs = SCRIPT_LIBS.map(n => FRAME_LIBS.find(l => l.name === n)).filter(Boolean)
        .map(l => (assetBase === undefined ? frameLibTag(l) : frameLibTag(l, assetBase))).join('\n');
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n`
        + `<style>html,body{margin:0;padding:0;background:transparent;}</style>\n${stub}\n${libs}\n`
        + `<script>window.__smalltalkLibsReady && window.__smalltalkLibsReady();</script>\n</head>\n<body></body>\n</html>\n`;
}
