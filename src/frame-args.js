// 前端卡（iframe 里的第三方脚本）传给宿主的参数的校验。纯函数，不碰 DOM / state，Node 里可测。
// 宿主那一侧在 src/ui/frame-host.js（它导入页面状态，Node 里没法直接测，所以把校验拆到这里）。
//
// 为什么要单独校验：卡脚本是导入的第三方代码，传来的值什么都可能是。以前 setChatMessages 直接拿 message_id 当数组下标：
//   message_id: "__proto__" 加 message 字符串 → state.chat["__proto__"] 是 Array.prototype，于是执行到 Array.prototype.content = …，
//     页面里所有数组都多了一个 content 属性；
//   message_id: "length" → state.chat.length 是个数字，往数字上写属性在严格模式下抛 TypeError，这次调用改到一半停下。
// 变量那几个方法同理：Object.assign(local, {"__proto__": …}) 走的是赋值，会把 local 的原型换掉。

import { UNSAFE_KEYS } from './migrate.js';

/**
 * 卡脚本传来的楼层号 → 合法的下标；不合法返回 null（调用方整条跳过并记日志）。
 * 接受：整数（number），或者只由数字组成的字符串（可带负号，前后空白忽略）——以前 state.chat["3"] 也能用，不改变这种写法。
 * 负数从末尾数：-1 = 最后一楼。这是本项目里已有的约定（frame-host.js parseRange 对 getChatMessages 的范围就是这样换算的，
 *   照酒馆助手 range 参数的写法），所有按楼层号取消息的宿主方法统一用它。
 * 换算后必须 0 ≤ id < length。
 * @param {unknown} id
 * @param {number} length  聊天记录的楼数
 * @returns {number|null}
 */
export function resolveMessageId(id, length) {
    let n;
    if (typeof id === 'number') n = id;
    else if (typeof id === 'string' && /^\s*-?\d+\s*$/.test(id)) n = Number(id);
    else return null;
    if (!Number.isInteger(n)) return null;
    if (n < 0) n = length + n;
    return n >= 0 && n < length ? n : null;
}

/**
 * 卡脚本传来的变量对象 → 可以安全并进变量仓库的 [键, 值] 列表。
 * 不是普通对象（null、数组、字符串……）→ 空列表；只取自有的可枚举键，去掉 __proto__ / constructor / prototype（migrate.js UNSAFE_KEYS）。
 * @param {unknown} vars
 * @returns {{pairs: [string, unknown][], dropped: number}}  dropped：去掉了几个危险键
 */
export function safeVarPairs(vars) {
    if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) return { pairs: [], dropped: 0 };
    const pairs = [];
    let dropped = 0;
    for (const k of Object.keys(vars)) {
        if (UNSAFE_KEYS.includes(k)) { dropped++; continue; }
        pairs.push([k, vars[k]]);
    }
    return { pairs, dropped };
}

/** 变量名能不能拿来删 / 读：字符串、不是危险键 */
export const isSafeVarName = k => typeof k === 'string' && !UNSAFE_KEYS.includes(k);
