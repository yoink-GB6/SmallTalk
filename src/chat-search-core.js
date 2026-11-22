// 聊天内搜索的纯函数部分：不碰 DOM、不碰 state，所以能直接在 node 里单元测试
// （src/ui/chat-search.js 会把这里的东西原样转出，界面一侧从那里用）。
//
// 规则：
//   - 只在每一楼"当前显示的那个候选"的原文（msg.content）上找。我们的 swipe 设计里 msg.content 永远
//     等于当前候选（见 chatfile.js 的 syncSwipeSlot），所以不用去翻 msg.swipes，没显示的候选自然搜不到。
//   - 不分大小写、按字面匹配：用户输入的 . * ( 等符号都当普通字符，不是正则。
//   - 匹配只在字符串上做，几千楼也只是几千次 indexOf，输入时不会卡。

/** 把用户输入变成"按字面匹配"的正则源码：所有正则特殊字符加反斜杠 */
export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
}

/** 不分大小写的字面匹配正则（逐词高亮用）。关键词为空返回 null */
export function makeMatcher(query) {
    if (typeof query !== 'string' || query === '') return null;
    return new RegExp(escapeRegExp(query), 'gi');
}

/**
 * 在聊天数组里找命中的楼层。
 * @param {Array<{content?: unknown}>} chat
 * @param {string} query
 * @returns {number[]} 命中的楼层下标（升序）。关键词为空、聊天不是数组 → []
 */
export function searchMessages(chat, query) {
    if (!Array.isArray(chat) || typeof query !== 'string' || query === '') return [];
    const needle = query.toLowerCase();
    const hits = [];
    for (let i = 0; i < chat.length; i++) {
        const text = chat[i]?.content;
        if (typeof text !== 'string') continue;   // 脏数据：文本不是字符串就当没有，别崩
        if (text.toLowerCase().includes(needle)) hits.push(i);
    }
    return hits;
}
