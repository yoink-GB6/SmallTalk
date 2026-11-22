// 「上一次实际发送」的记录，只存在内存里（刷新页面就没了），供「拼装」页和预览做对比。
// 故意不放进 state：state 的形状是各模块的契约，这里只是展示用的旁路数据。
//
// 按 persist.epoch 区分存档：epoch 在 state 指向另一个存档时 +1，而没卡状态下第一次保存分配
// 存档 id 时 epoch 不变——所以比起 chatId，用它才不会把「刚发的第一句」认成别的存档。

import { persist } from './state.js';
import { setUsageListener } from '../llm.js';

let last = null;   // { epoch, messages: [{role, name?, content}], usage: 上游报的用量 | null }

// 上游报的用量（缓存命中等）经 llm.js 的旁路送到这里，记在「上一次发送」名下。不进 state、不存盘。
// 只有聊天生成会报（记忆压缩不会）；命令行类接口永远没有。每次新发送都先清掉上次的。
// （llm.js 不是 ui 模块，顶层调用它不违反循环依赖的规则。）
setUsageListener((usage) => { if (last) last.usage = usage; });

/** 每次真正发送时调用（不是预览）。只留 role / name / content，不留 sources，省内存也免得被后面改动 */
export function recordSent(messages) {
    last = { epoch: persist.epoch, usage: null, messages: messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content })) };
}

/** 当前存档的上一次发送；没有、或记录属于别的存档时返回 null */
export function lastSent() {
    return last && last.epoch === persist.epoch ? last.messages : null;
}

/** 上一次发送拿到的用量（{inputTokens, cachedTokens, cacheWriteTokens, outputTokens}，见 normalizeUsage）；没拿到 / 属于别的存档为 null */
export function lastUsage() {
    return last && last.epoch === persist.epoch ? last.usage : null;
}
