// 变量的纯操作：清洗（挡危险键、限大小）、深合并、按路径删除。浏览器和 Node 都能直接加载。
//
// 谁用：
//   - 宿主（src/ui/frame-host.js）：前端卡和脚本发来的变量写入，都在这里先清洗、再合并进权威数据。
//   - 脚本沙箱里的桩（src/script-stub.js）：变量的「乐观更新」要在沙箱里先算一遍新表，用的是同一份代码——
//     varOpsFactory 是【自包含】的（函数体里不引用本模块的任何东西），桩用 varOpsFactory.toString() 原样内联进沙箱的 srcdoc。
//     所以函数体里不能出现字面的 `</script` 或 `<!--`（test/script-stub.test.mjs 会检查）。
//
// 行为依据（只学行为，实现自己写；酒馆助手的许可是 PolyForm Noncommercial）：酒馆助手 4.12.2 src/function/variables.ts——
//   insertOrAssignVariables = lodash mergeWith(旧表, 新值, 数组整体替换)；insertVariables = mergeWith({}, 新值, 旧表, 数组整体替换)（已有的不覆盖）；
//   deleteVariable(path) = lodash unset(旧表, path)，返回 {variables, delete_occurred}。
// 和酒馆助手不一样的地方（有意的）：
//   - 任何一层的 __proto__ / constructor / prototype 键都丢掉（lodash 的 merge 自己挡了 __proto__，但我们的数据要进 IndexedDB、进备份，统一在入口洗干净）；
//   - delete_occurred：lodash unset 对「本来就没有的路径」也返回 true（它只看 delete 运算符的结果），我们只在【真的删掉了一个已有的键】时才是 true，
//     这才是这个字段名字的意思（脚本拿它判断删没删）。
//   - 路径里有危险键（'a.__proto__.b'）→ 整个不删，delete_occurred = false。

/**
 * @returns {{
 *   isPlain: (v: any) => boolean,
 *   sanitize: (v: any, maxBytes?: number) => {ok: boolean, value?: any, dropped: number, error?: string},
 *   merge: (base: object, patch: object) => object,
 *   insert: (base: object, patch: object) => object,
 *   parsePath: (path: any) => string[]|null,
 *   unset: (obj: object, path: any) => {value: object, deleted: boolean, bad: boolean},
 * }}
 */
export function varOpsFactory() {
    // 不能写成对象字面量 {'__proto__': 1}：字面量里的 __proto__ 键是「设原型」，不是一个自有键
    function unsafe(k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; }
    var hasOwn = Object.prototype.hasOwnProperty;
    function isPlain(v) {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
        var p = Object.getPrototypeOf(v);
        return p === null || p === Object.prototype;
    }
    // 定义自有属性（不用赋值：对 __proto__ 赋值会换掉原型；危险键调用方已经挡了，这里再稳一层）
    function put(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); }

    /**
     * 外来的变量值 → 能放心存的副本：只留 JSON 能表示的东西（JSON 往返），任何一层的危险键丢掉。
     * maxBytes：JSON 的长度上限（默认 5 MB），超了不收（ok: false）。嵌套太深（JSON.stringify 爆栈）同样不收。
     */
    function sanitize(v, maxBytes) {
        var limit = typeof maxBytes === 'number' ? maxBytes : 5 * 1024 * 1024;
        var dropped = 0;
        var text;
        try { text = JSON.stringify(v === undefined ? null : v); } catch (e) { return { ok: false, dropped: 0, error: '变量的值不能转成 JSON（有循环引用或嵌套太深）' }; }
        if (text === undefined) text = 'null';
        if (text.length > limit) return { ok: false, dropped: 0, error: '变量太大（超过 ' + Math.round(limit / 1024 / 1024) + ' MB）' };
        var value = JSON.parse(text, function (k, x) {
            if (k !== '' && unsafe(k)) { dropped++; return undefined; }
            return x;
        });
        // JSON.parse 建对象时用的是「定义属性」，"__proto__" 只是一个普通的自有键，不会换原型；reviver 返回 undefined 就把它删掉
        return { ok: true, value: value, dropped: dropped };
    }

    /** 深合并（不改输入）：patch 里的普通对象逐层合并进 base；数组和其它值整体替换；危险键跳过 */
    function merge(base, patch) {
        if (!isPlain(patch)) return patch;
        var out = {};
        var k;
        if (isPlain(base)) for (k in base) if (hasOwn.call(base, k) && !unsafe(k)) put(out, k, base[k]);
        for (k in patch) {
            if (!hasOwn.call(patch, k) || unsafe(k)) continue;
            var pv = patch[k];
            put(out, k, isPlain(pv) && isPlain(out[k]) ? merge(out[k], pv) : (isPlain(pv) ? merge({}, pv) : pv));
        }
        return out;
    }

    /** insertVariables：只补没有的（已有的值不覆盖，数组也不动）= merge(patch, base) */
    function insert(base, patch) { return merge(merge({}, isPlain(patch) ? patch : {}), isPlain(base) ? base : {}); }

    /**
     * lodash 路径 → 段：'a.b'、'a[0].b'、'a["x.y"]'、"a['x']"。不是字符串 / 空 / 语法不对 → null；任何一段是危险键 → null。
     */
    function parsePath(path) {
        if (typeof path === 'number' && isFinite(path)) path = String(path);
        if (typeof path !== 'string' || path === '') return null;
        var out = [], i = 0, cur = '', n = path.length;
        while (i < n) {
            var c = path[i];
            if (c === '.') { if (cur === '' && (out.length === 0 || path[i - 1] !== ']')) return null; if (cur !== '') out.push(cur); cur = ''; i++; continue; }
            if (c === '[') {
                if (cur !== '') { out.push(cur); cur = ''; }
                var close = path.indexOf(']', i);
                if (close < 0) return null;
                var inner = path.slice(i + 1, close).trim();
                var q = inner[0];
                if ((q === '"' || q === "'") && inner[inner.length - 1] === q && inner.length >= 2) inner = inner.slice(1, -1);
                else if (!/^\d+$/.test(inner)) return null;
                out.push(inner);
                i = close + 1;
                continue;
            }
            cur += c; i++;
        }
        if (cur !== '') out.push(cur);
        if (!out.length) return null;
        for (var j = 0; j < out.length; j++) if (unsafe(out[j])) return null;
        return out;
    }

    /** 按路径删（不改输入，返回新表）。bad = 路径不合法 / 有危险键（没删）；deleted = 真的删掉了一个已有的键 */
    function unset(obj, path) {
        var segs = parsePath(path);
        var base = isPlain(obj) ? obj : {};
        if (!segs) return { value: base, deleted: false, bad: true };
        // 只复制路径上的那几层，别的原样共用（调用方拿到的是新表，不会改到旧表）
        var root = Object.assign({}, base);
        var node = root;
        for (var i = 0; i < segs.length - 1; i++) {
            var nx = node[segs[i]];
            if (nx === null || typeof nx !== 'object' || !hasOwn.call(node, segs[i])) return { value: base, deleted: false, bad: false };
            nx = Array.isArray(nx) ? nx.slice() : Object.assign({}, nx);
            put(node, segs[i], nx);
            node = nx;
        }
        var last = segs[segs.length - 1];
        if (!hasOwn.call(node, last)) return { value: base, deleted: false, bad: false };
        delete node[last];   // 数组也照 lodash unset 用 delete（留一个空位，存成 JSON 是 null），不挪后面的元素
        return { value: root, deleted: true, bad: false };
    }

    return { isPlain: isPlain, sanitize: sanitize, merge: merge, insert: insert, parsePath: parsePath, unset: unset };
}

export const varOps = varOpsFactory();
