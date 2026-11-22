// 删除角色卡 / 预设时，把它们自带的「启用中的正则」移到全局的规则（纯函数，不碰 state 和页面）。
//
// 为什么要有这一步：卡 / 预设自带的正则随它们存在，删掉就一起没了。用户可能想让其中某几条继续对所有聊天生效，
// 所以删除前问一次，选「移动至全局」就走这里。界面和落盘顺序在 ui/regex-delete.js。
//
// 规则（和整体备份恢复时的 unionRegex 是同一个「内容相同」的判定，直接用 backup.js 的 regexSig：
// 忽略 id、origin、disabled，其余字段原样比较）：
//   - 每条复制成新的全局正则：换新 id、去掉 origin（运行时的标签，见 ui/pipeline.js allScripts），其它字段（含不认识的）原样保留；
//   - 全局里已经有内容相同的就不重复加；那条如果是关着的，把它打开（用户的意图是「让它继续生效」）；
//   - 这次要移的几条之间内容相同，也只加一条；
//   - 追加在全局列表末尾，保持传进来的顺序。

import { regexSig } from './backup.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 启用的脚本（disabled 不为真）。不是对象的条目丢掉 */
export const enabledScripts = list => (Array.isArray(list) ? list : []).filter(s => isObj(s) && s.disabled !== true);

/**
 * 算出怎么移，不改任何东西。
 * @param {Object[]} globalList  现在的全局正则
 * @param {Object[]} scripts     要移的脚本（调用方已经挑好了启用的）
 * @param {() => string} newId   生成新 id
 * @returns {{add: Object[], reopen: Object[], dup: number}}
 *   add：要追加的新脚本（已换 id、去了 origin）；reopen：全局里内容相同、但关着、需要打开的那几条（原对象）；
 *   dup：因为全局里（或这次的前一条）已经有相同的而没加的条数
 */
export function planRegexMove(globalList, scripts, newId) {
    const bySig = new Map();   // 内容签名 → 全局里的那条（第一条）
    const ids = new Set();
    for (const g of Array.isArray(globalList) ? globalList : []) {
        if (!isObj(g)) continue;
        const sig = regexSig(g);
        // 内容相同的有好几条时，优先认开着的那条：已经有一条开着的，就不必去打开另一条关着的
        const prev = bySig.get(sig);
        if (!prev || (prev.disabled === true && g.disabled !== true)) bySig.set(sig, g);
        if (g.id !== undefined && g.id !== null) ids.add(g.id);
    }
    const add = [], reopen = [];
    let dup = 0;
    for (const s of scripts) {
        if (!isObj(s)) continue;
        const sig = regexSig(s);
        const same = bySig.get(sig);
        if (same) {
            dup++;
            if (same.disabled === true && !reopen.includes(same)) reopen.push(same);
            continue;
        }
        const { origin: _o, ...rest } = structuredClone(s);
        let id = newId();
        for (let i = 0; i < 20 && ids.has(id); i++) id = newId();
        ids.add(id);
        const copy = { ...rest, id, disabled: false };
        add.push(copy);
        bySig.set(sig, copy);
    }
    return { add, reopen, dup };
}
