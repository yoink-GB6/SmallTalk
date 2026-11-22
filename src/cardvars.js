// 每张卡一份的「运行时数据」：存储键 'cardvars:<cardId>' → CardVars（契约见 types.js CardVars）。纯函数，浏览器和 Node 都能加载。
//
// 放什么（酒馆助手第 2 期，docs/tavern-helper-plan.md §3.8）：
//   character  角色卡变量（getVariables({type:'character'})）。酒馆里存在卡文件的 data.extensions.tavern_helper.variables；
//              我们的卡文件（card.raw）只读不写，所以运行时写的值放这里。没写过 = 用卡文件里带的那份（scripts.js cardCharacterVars）。
//   scripts    脚本变量（{type:'script'}），按脚本 id。酒馆里就是脚本对象的 data 字段；同理，卡文件里的 data 是【初值】，
//              运行时第一次写之后以这里为准（脚本在「脚本」页被删掉后这里的那一项留着不管，不影响任何东西；删卡时整条删）。
//   storage    前端卡 / 脚本的 localStorage「小设置」（第 6 期才接上；这一期只有契约和规范化，没人写）。
// 为什么不放进卡记录 'card:<id>'：卡记录里有头像（data URL，可能几 MB），脚本可能每条消息都写变量，每次重写整张卡太重；
//   也不该让「玩着玩着」改变卡的内容签名（backup.js cardSig 不看它）。
// 默认不写：三个字段都默认没有；整条记录三个都没有时不写（已经写了的删掉）。不用脚本的卡存储里没有这个键。
//   character / scripts[id] 一旦写过，哪怕是空表 {} 也留着（= 脚本把它清空了，不能退回卡文件里的初值）；storage 空了就去掉。
// 读入容错（normalizeCardVars）：不是对象 → 当作没有；某个字段形状不对 → 那个字段当作没有；变量值过一遍 vars-ops.js sanitize（危险键丢掉）；
//   storage 的值不是字符串的丢掉，总长超过 5 MB 时从后面截掉。

import { varOps } from './vars-ops.js';

export const CARDVARS_PREFIX = 'cardvars:';
export const cardVarsKey = cardId => `${CARDVARS_PREFIX}${cardId}`;
/** localStorage 小设置的总上限（字符数，和浏览器的 localStorage 一个量级） */
export const STORAGE_LIMIT = 5 * 1024 * 1024;

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const isPlain = varOps.isPlain;

/** 一张变量表（普通对象）的清洗；不是普通对象 / 清洗失败 → null */
function cleanTable(v) {
    if (!isPlain(v)) return null;
    const r = varOps.sanitize(v);
    return r.ok && isPlain(r.value) ? r.value : null;
}

/**
 * 存储里 / 备份里读来的 CardVars → 规范的样子；没有内容 → null。
 * @param {any} v
 * @returns {import('./types.js').CardVars|null}
 */
export function normalizeCardVars(v) {
    if (!isPlain(v)) return null;
    const out = {};
    // 空表也留着：「脚本把角色卡变量清空了」和「从没写过（用卡文件里的初值）」是两回事
    const ch = cleanTable(v.character);
    if (ch) out.character = ch;
    if (isPlain(v.scripts)) {
        const s = {};
        for (const [id, t] of Object.entries(v.scripts)) {
            if (UNSAFE.has(id)) continue;
            const c = cleanTable(t);
            if (c) s[id] = c;
        }
        if (Object.keys(s).length) out.scripts = s;
    }
    if (isPlain(v.storage)) {
        const s = {};
        let total = 0;
        for (const [k, x] of Object.entries(v.storage)) {
            if (UNSAFE.has(k) || typeof x !== 'string') continue;
            total += k.length + x.length;
            if (total > STORAGE_LIMIT) break;
            s[k] = x;
        }
        if (Object.keys(s).length) out.storage = s;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * 恢复整体备份到【已有的卡】时：按键取并集，本机已有的键保留本机的值（和全局变量 backup.js unionVars 一个规矩）。
 *   character：按变量名；scripts：先按脚本 id、再按变量名；storage：按键。
 * 两边都先规范化。返回合并后的（null = 都空）和新加了几个键。
 * @returns {{value: import('./types.js').CardVars|null, added: number}}
 */
export function unionCardVars(mine, theirs) {
    const a = normalizeCardVars(mine) ?? {}, b = normalizeCardVars(theirs) ?? {};
    let added = 0;
    const unionTable = (x = {}, y = {}) => {
        const out = { ...x };
        for (const [k, v] of Object.entries(y)) if (!Object.hasOwn(out, k)) { out[k] = v; added++; }
        return out;
    };
    const out = {};
    if (a.character || b.character) out.character = unionTable(a.character, b.character);
    if (a.scripts || b.scripts) {
        const s = { ...(a.scripts ?? {}) };
        for (const [id, t] of Object.entries(b.scripts ?? {})) s[id] = Object.hasOwn(s, id) ? unionTable(s[id], t) : (added += Object.keys(t).length, t);
        out.scripts = s;
    }
    if (a.storage || b.storage) out.storage = unionTable(a.storage, b.storage);
    return { value: normalizeCardVars(out), added };
}
