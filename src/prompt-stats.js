// 「拼装」页的统计：字数去向（按来源归类）、和上一次发送的共同前缀。
// 都是纯函数，不碰页面也不碰 state，所以能直接单元测试。

/** 归类的顺序就是界面上的顺序 */
export const CATEGORIES = [
    { key: 'preset', label: '预设' },
    { key: 'card', label: '角色卡' },
    { key: 'persona', label: '人设（persona）' },
    { key: 'worldinfo', label: '世界书' },
    { key: 'chat', label: '聊天记录' },
    { key: 'memory', label: '外置记忆' },
    { key: 'note', label: '作者注释' },
    { key: 'other', label: '其它' },
    { key: 'joiner', label: '连接符' },
];

// marker 的 id 是 assemble.js 里 markerContents 那几个（预设里的占位条目被填了内容）
const MARKER_CATEGORY = {
    charDescription: 'card', charPersonality: 'card', scenario: 'card',
    personaDescription: 'persona',
    worldInfoBefore: 'worldinfo', worldInfoAfter: 'worldinfo',
};

/** 一个 Source 属于哪一类。认不出的归 'other'，不悄悄丢掉。 */
export function categoryOf(s) {
    switch (s.kind) {
        case 'prompt':
            // 角色卡的 system_prompt 覆盖了预设的 main 时，assemble 仍给 kind:'prompt'，
            // 但内容是卡的，label 里带「角色卡 … 覆盖」，这里把它算到卡上
            return /角色卡.*覆盖/.test(s.label ?? '') ? 'card' : 'preset';
        case 'utility': case 'prefill': return 'preset';
        case 'depthPrompt': case 'example': return 'card';
        case 'marker': return MARKER_CATEGORY[s.id] ?? 'other';
        case 'worldinfo': return 'worldinfo';
        case 'chat': return 'chat';
        case 'memory': return 'memory';
        // 作者注释的正文（和它拼在一起的世界书「作者注释上 / 下」条目是 worldinfo 出处，仍算世界书）
        case 'authorNote': return 'note';
        default: return 'other';
    }
}

/**
 * 字数去向。
 * 总字数 = Σ content.length。各段 chars 之和比它少：assemble 保证
 * content.length === Σ chars + (段数 − 1)，差的就是段与段之间的 '\n'，单独记成「连接符」。
 * 没有 sources 的消息（理论上不会有）整条算「其它」。所以各类之和恒等于总字数。
 * @returns {{total:number, cats:{key,label,chars,pct,items:{label,chars,kind}[]}[]}}
 */
export function breakdown(messages) {
    const cats = new Map(CATEGORIES.map(c => [c.key, { ...c, chars: 0, pct: 0, items: [] }]));
    let total = 0;
    for (const m of messages) {
        const len = m.content.length;
        total += len;
        const sources = m.sources ?? [];
        if (!sources.length) {
            const c = cats.get('other');
            c.chars += len;
            if (len) c.items.push({ label: `(无出处的 ${m.role} 消息)`, chars: len, kind: 'other' });
            continue;
        }
        let sum = 0;
        for (const s of sources) {
            const c = cats.get(categoryOf(s));
            c.chars += s.chars;
            c.items.push({ label: s.kind === 'chat' ? `#${s.id} ${s.label}` : s.label, chars: s.chars, kind: s.kind });
            sum += s.chars;
        }
        cats.get('joiner').chars += len - sum;
    }
    const list = [...cats.values()];
    for (const c of list) {
        c.pct = total ? (c.chars / total) * 100 : 0;
        c.items.sort((a, b) => b.chars - a.chars);
    }
    return { total, cats: list };
}

const sameMsg = (a, b) => a.role === b.role && (a.name ?? '') === (b.name ?? '') && a.content === b.content;

/**
 * 两次发送的共同前缀。
 * @returns {{count:number, chars:number, diffIndex:number|null, diffChar:number|null, identical:boolean}}
 *   count      前面有几条消息完全相同
 *   chars      这些消息的字数
 *   diffIndex  第一条不同的消息的下标（一方更短时，是较短一方的长度；完全相同为 null）
 *   diffChar   那条消息里从第几个字符开始不同（只有两边都有这条、且角色相同才有）
 */
export function commonPrefix(prev, cur) {
    let count = 0, chars = 0;
    const n = Math.min(prev.length, cur.length);
    while (count < n && sameMsg(prev[count], cur[count])) chars += cur[count++].content.length;
    if (count === prev.length && count === cur.length) return { count, chars, diffIndex: null, diffChar: null, identical: true };
    let diffChar = null;
    if (count < n && prev[count].role === cur[count].role) {
        const a = prev[count].content, b = cur[count].content;
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        diffChar = i;
    }
    return { count, chars, diffIndex: count, diffChar, identical: false };
}
