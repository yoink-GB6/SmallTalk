// 把模型的回复切成手机里的气泡（splitReply）。纯函数，Node 里可测（test/phone-reply.test.mjs）。规则的契约见 types.js SplitReply。
//
// 为什么「一行一条」，不用分隔符或 JSON：
//   - 每个模型都写得出换行；流式时每写完一行就能冒出一个气泡，像对方在一条一条地发；
//   - 写坏了最多是切多切少（两句挤在一行 = 一个长气泡），不会像 JSON 那样一个括号没配上就整段解析失败；
//   - 分隔符（比如 |||）模型常常忘写，忘了就整段变成一个气泡，比换行更不稳。
//
// 界面怎么用（流式）：每收到一段就对「到目前为止的全文」调一次 splitReply(text, {partial: true})。
//   bubbles = 已经写完整的那几行（画成普通气泡）；pending = 最后那行还没写完的部分（画成「正在输入」的气泡，空串就不画）。
//   每次都是从头切一遍全文，不做增量状态：全文最多几千字，切一遍是微秒级；这样不会有「上一次切错了、后面一直错」的问题。
//   流式结束（或停止）时再调一次不带 partial 的：最后那行也算完整的，得到最终要存的气泡。

import { findSticker, stickerToken } from './phone-data.js';

/** 一行里的表情标记：[表情:名字] 或 [表情：名字]（全角冒号）。名字里不能有 ] 和换行 */
export const STICKER_TOKEN = /\[表情[:：]\s*([^\]\n]*?)\s*\]/g;

/** 硬上限：超过 max(maxBubbles × 2, MIN_HARD_CAP) 行时，多出来的并进最后一个气泡 */
export const MIN_HARD_CAP = 12;

const LINE_SPLIT = /\r\n|\r|\n|\u2028|\u2029/;
// 整行被一对引号包着：ASCII 双引号、中文弯引号、直角引号、双直角引号
const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']];

/**
 * 第 1 步：去掉思维链和整段的代码围栏。
 *   <think>…</think> 整段去掉（不分大小写，可以有好几段）；剩下的里面还有 <think> 却没有结尾（还在想 / 被截断）→ 从那里到末尾都不算。
 *   整段被 ``` 围起来（有些模型爱这样包回复）→ 去掉第一行的 ```xxx 和最后的 ```；流式中只出现了开头的 ``` 也先把开头那行去掉。
 */
export function stripWrappers(text) {
    let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    const open = t.search(/<think>/i);
    if (open >= 0) t = t.slice(0, open);
    const trimmed = t.trim();
    if (trimmed.startsWith('```')) {
        const nl = trimmed.indexOf('\n');
        let body = nl < 0 ? '' : trimmed.slice(nl + 1);
        if (/```\s*$/.test(body)) body = body.replace(/```\s*$/, '');
        // 保留原文末尾是否换行：流式中判断「最后一行写完没有」要看它
        t = body + (/\n\s*$/.test(t) && !body.endsWith('\n') ? '\n' : '');
    }
    return t;
}

/** 第 3 步：去掉「卡名：」前缀（和 charName 完全相同才去）和整行的引号 */
export function cleanLine(line, charName) {
    let s = line.trim();
    if (charName) {
        for (const sep of ['：', ':']) {
            const p = charName + sep;
            if (s.startsWith(p)) { s = s.slice(p.length).trim(); break; }
        }
    }
    for (const [a, b] of QUOTE_PAIRS) {
        if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) {
            const inner = s.slice(a.length, s.length - b.length);
            // 里面还有同样的引号（"他说"好""这种）就不剥，免得剥错
            if (!inner.includes(a) && !inner.includes(b)) { s = inner.trim(); break; }
        }
    }
    return s;
}

/**
 * 第 4 步：一行里的表情标记切成单独的气泡。认得出的名字写成规范的「[表情:库里的名字]」并带上 sticker id；认不出的原样留着（显示成灰色文字）。
 * @returns {{content: string, sticker?: string}[]}
 */
export function splitStickers(line, stickers) {
    const out = [];
    let last = 0;
    for (const m of line.matchAll(STICKER_TOKEN)) {
        const before = line.slice(last, m.index).trim();
        if (before) out.push({ content: before });
        const hit = findSticker(stickers, m[1]);
        out.push(hit ? { content: stickerToken(hit.name), sticker: hit.id } : { content: m[0] });
        last = m.index + m[0].length;
    }
    const rest = line.slice(last).trim();
    if (rest) out.push({ content: rest });
    return out;
}

/**
 * 把回复切成气泡。规则按顺序见 types.js SplitReply。
 * @param {string} text   到目前为止的全文
 * @param {{maxBubbles?: number, stickers?: {id: string, name: string}[], charName?: string, partial?: boolean}} [opts]
 * @returns {{bubbles: {content: string, sticker?: string}[], pending: string}}
 */
export function splitReply(text, { maxBubbles = 5, stickers = [], charName = '', partial = false } = {}) {
    const body = stripWrappers(text);
    const lines = body.split(LINE_SPLIT);
    // 流式中：最后一段还没遇到换行 = 没写完，单独放进 pending（它可能是半个表情标记，先不切）
    let pendingRaw = '';
    if (partial) pendingRaw = lines.pop() ?? '';
    const bubbles = [];
    for (const raw of lines) {
        const line = cleanLine(raw, charName);
        if (!line) continue;
        bubbles.push(...splitStickers(line, stickers));
    }
    // 第 5 步：不硬卡 maxBubbles（模型常多一两条，丢了反而怪）；太多了才把多出来的并进最后一个
    const cap = Math.max((Number(maxBubbles) || 0) * 2, MIN_HARD_CAP);
    if (bubbles.length > cap) {
        const extra = bubbles.splice(cap - 1);
        bubbles.push({ content: extra.map(b => b.content).join('\n') });   // 并起来的那个不再是表情气泡
    }
    return { bubbles, pending: partial ? cleanLine(pendingRaw, charName) : '' };
}
