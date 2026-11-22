// 「缓存友好度」的纯函数（不碰页面、不碰 state，所以能直接单元测试）。
//
// 背景：很多接口对「和上次完全相同的开头」按低价计费（提示缓存）。开头只要有一个字不同，从那个字往后的全部内容都按原价算。
// 所以要回答两个问题：
//   1. 这次和上次相比，第一处不同落在哪、是谁造成的？  → explainFirstDiff
//   2. 不用比较，光看原始文本就能看出来的「每次求值都会变」的东西有哪些、在多靠前的位置？ → scanUnstable / worldInfoRisk
// 这一步只「看得见」，不改变发给模型的任何内容。

import { CATEGORIES, categoryOf } from './prompt-stats.js';

const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// ───────────────────────────── 来源的人话 ─────────────────────────────

/**
 * 一个 Source（assemble.js 给每段内容打的出处标记）说成人话。不另造一套分类，直接用 prompt-stats.js 的 categoryOf。
 * @param {{kind:string, id?:string, label?:string}} s
 * @returns {{category:string, text:string}}
 */
export function describeSource(s) {
    const category = categoryOf(s);
    const cat = CAT_LABEL[category] ?? '其它';
    let text;
    switch (s.kind) {
        case 'chat': text = `聊天记录第 ${s.id} 楼`; break;
        case 'memory': text = '外置记忆'; break;
        case 'authorNote': text = '作者注释'; break;
        case 'worldinfo': text = `世界书条目「${s.label}」`; break;
        case 'marker': text = `${cat}（${s.label}）`; break;
        case 'depthPrompt': text = '角色卡的深度提示'; break;
        case 'example': text = `示例对话「${s.label}」`; break;
        default: text = category === 'card' ? `角色卡（${s.label}）` : `${cat}条目「${s.label}」`;
    }
    return { category, text };
}

/** 一条消息里每一段（来源）的起点偏移。assemble 保证各段之间恰好一个 '\n'；对不上时返回 null（调用方退回整条消息） */
function segmentStarts(m) {
    const sources = m.sources ?? [];
    if (!sources.length) return null;
    const expected = sources.reduce((n, s) => n + s.chars, 0) + sources.length - 1;
    if (expected !== m.content.length) return null;
    const starts = [];
    let pos = 0;
    for (const s of sources) { starts.push(pos); pos += s.chars + 1; }
    return starts;
}

// ───────────────────────────── 1. 第一处不同在哪 ─────────────────────────────

/**
 * 和上一次发送相比，第一处不同落在哪条消息、哪一段来源。
 * @param {{role:string, content:string, sources?:object[]}[]} messages  这次的 messages（要带 sources）
 * @param {{count:number, diffIndex:number|null, diffChar:number|null, identical:boolean}} cmp  prompt-stats.js 的 commonPrefix 结果
 * @returns {null | {
 *   messageIndex:number, charOffset:number, positionPct:number,
 *   source: {category:string, text:string} | null,   // 不同处落在哪段来源；这次的内容比上次短（上次多出来的被删了）时为 null
 *   shorter: boolean,                                 // true = 这次比上次少了消息，没有「这次的哪一段」可指
 * }}  完全相同返回 null
 */
export function explainFirstDiff(messages, cmp) {
    if (!cmp || cmp.identical || cmp.diffIndex == null) return null;
    const total = messages.reduce((n, m) => n + m.content.length, 0);
    const before = messages.slice(0, cmp.diffIndex).reduce((n, m) => n + m.content.length, 0);
    if (cmp.diffIndex >= messages.length) {
        // 这次的消息是上次的前缀：差别在「上次有、这次没有」的部分
        return { messageIndex: cmp.diffIndex, charOffset: before, positionPct: total ? 100 : 0, source: null, shorter: true };
    }
    const m = messages[cmp.diffIndex];
    const inMsg = cmp.diffChar ?? 0;   // 角色不同时 diffChar 为 null：整条都不同，从头算
    const starts = segmentStarts(m);
    let src = null;
    if (starts) {
        let k = 0;
        for (let i = 0; i < starts.length; i++) if (starts[i] <= inMsg) k = i;
        src = m.sources[k];
    } else if (m.sources?.length === 1) src = m.sources[0];
    return {
        messageIndex: cmp.diffIndex,
        charOffset: before + inMsg,
        positionPct: total ? ((before + inMsg) / total) * 100 : 0,
        source: src ? describeSource(src) : null,
        shorter: false,
    };
}

// ───────────────────────────── 2. 不稳定内容检查 ─────────────────────────────

/** 等级从严到轻；rank 小的更糟 */
export const LEVELS = {
    always: { rank: 0, label: '每次发送都不一样' },
    chat: { rank: 1, label: '每聊一句就变' },
    minute: { rank: 2, label: '每分钟变一次' },
    day: { rank: 3, label: '每天变一次' },
    var: { rank: 4, label: '变量被改动时才变' },
};

// 和 src/macros.js 里真正实现的宏一一对应（正则也照抄它的写法）。注意 macros.js 里 {{random}} 必须带内容（{{random::a,b}} / {{random:a,b}}），
// 单写 {{random}} 不会被求值、会原样发出去，所以这里也不算。
// stableRandom: true 的两条：「拼装」页打开「随机宏按存档固定」（GlobalRecord.stableRandom）后，macros.js 对它们改用确定性取值，
// 同一存档里每次结果相同，就不再算「每次都变」（findUnstableMacros 的 opts.stableRandom）。
const RULES = [
    { name: 'random', show: '{{random::…}}', re: /{{random\s?::?([^}]+)}}/gi, level: 'always', stableRandom: true,
      advice: '换成 {{pick::…}}：只要这段文字不变，结果就固定，不会每次发送都换一个。也可以在下面打开「随机宏在同一个存档里固定结果」。' },
    { name: 'roll', show: '{{roll::…}}', re: /{{roll[ : ]([^}]+)}}/gi, level: 'always', stableRandom: true,
      advice: '掷骰每次都是新结果。想吃缓存就把它挪到最靠后的位置，或者改成 {{pick::…}} 列出几个固定选项；也可以在下面打开「随机宏在同一个存档里固定结果」。' },
    { name: 'incvar', show: '{{incvar::…}}', re: /{{incvar::([^}]+)}}/gi, level: 'always', advice: '每发送一次计数就加一，内容每次都不同；放得越靠前影响越大，尽量挪到靠后。' },
    { name: 'decvar', show: '{{decvar::…}}', re: /{{decvar::([^}]+)}}/gi, level: 'always', advice: '每发送一次计数就减一，内容每次都不同；放得越靠前影响越大，尽量挪到靠后。' },
    { name: 'incglobalvar', show: '{{incglobalvar::…}}', re: /{{incglobalvar::([^}]+)}}/gi, level: 'always', advice: '每发送一次计数就加一，内容每次都不同；尽量挪到靠后。' },
    { name: 'decglobalvar', show: '{{decglobalvar::…}}', re: /{{decglobalvar::([^}]+)}}/gi, level: 'always', advice: '每发送一次计数就减一，内容每次都不同；尽量挪到靠后。' },
    { name: 'lastMessage', show: '{{lastMessage}}', re: /{{lastMessage}}/gi, level: 'chat', advice: '内容是上一楼的原文，聊一句就变。放在开头会让后面全部失效，尽量挪到消息列表最末尾。' },
    { name: 'lastMessageId', show: '{{lastMessageId}}', re: /{{lastMessageId}}/gi, level: 'chat', advice: '是最后一楼的编号，每多一楼就变。尽量挪到最末尾，或去掉。' },
    { name: 'lastUserMessage', show: '{{lastUserMessage}}', re: /{{lastUserMessage}}/gi, level: 'chat', advice: '内容是你最新那句话，每次都变。尽量挪到消息列表最末尾。' },
    { name: 'lastCharMessage', show: '{{lastCharMessage}}', re: /{{lastCharMessage}}/gi, level: 'chat', advice: '内容是角色最新那条回复，每次都变。尽量挪到消息列表最末尾。' },
    { name: 'time', show: '{{time}}', re: /{{time}}/gi, level: 'minute', advice: '精确到分钟，每分钟都不同；缓存的有效期通常也只有几分钟。放在开头会让后面全部失效，不需要就去掉，或挪到最靠后。' },
    { name: 'isotime', show: '{{isotime}}', re: /{{isotime}}/gi, level: 'minute', advice: '精确到分钟，每分钟都不同。不需要就去掉，或挪到最靠后。' },
    { name: 'date', show: '{{date}}', re: /{{date}}/gi, level: 'day', advice: '同一天里不变，只是跨天那一次会让缓存失效，影响很小。' },
    { name: 'weekday', show: '{{weekday}}', re: /{{weekday}}/gi, level: 'day', advice: '同一天里不变，只是跨天那一次会让缓存失效，影响很小。' },
    { name: 'isodate', show: '{{isodate}}', re: /{{isodate}}/gi, level: 'day', advice: '同一天里不变，只是跨天那一次会让缓存失效，影响很小。' },
    { name: 'getvar', show: '{{getvar::…}}', re: /{{getvar::([^}]+)}}/gi, level: 'var', advice: '只有这个变量被改了才变。如果变量每轮都在变（比如被 incvar），它就等于每次都不同。' },
    { name: 'getglobalvar', show: '{{getglobalvar::…}}', re: /{{getglobalvar::([^}]+)}}/gi, level: 'var', advice: '只有这个变量被改了才变。如果变量每轮都在变，它就等于每次都不同。' },
];

/**
 * 一段文本里有哪些「会变」的宏：[{name, show, level, advice, count}]（同一种宏合并计数）
 * @param {string} text
 * @param {{stableRandom?: boolean}} [opts]  stableRandom：随机宏已按存档固定，{{random}} / {{roll}} 不算
 */
export function findUnstableMacros(text, opts = {}) {
    const out = [];
    if (!text || !String(text).includes('{{')) return out;
    for (const r of RULES) {
        if (opts.stableRandom && r.stableRandom) continue;
        const n = (String(text).match(new RegExp(r.re.source, 'gi')) ?? []).length;
        if (n) out.push({ name: r.name, show: r.show, level: r.level, advice: r.advice, count: n });
    }
    return out;
}

/**
 * 在 messages 里找一段来源：返回它在整段内容里的起点（字符数）和所在消息下标；没找到（比如这条被关掉、被丢掉了）返回 null。
 * @param {{kind:string, id?:string, idPrefix?:string} | {kind:string, id?:string, idPrefix?:string}[]} at
 *        按 kind + id（或 id 前缀）匹配 assemble 给的 sources；给数组时按顺序试，哪个先找到用哪个（同一条内容可能以不同的出处出现，
 *        比如世界书条目能逐条对齐时是 worldinfo 出处，对不齐时被并进「世界书前/后」那个占位出处）
 */
export function locateSource(messages, at) {
    for (const a of Array.isArray(at) ? at : [at]) {
        const r = locateOne(messages, a);
        if (r) return r;
    }
    return null;
}

function locateOne(messages, at) {
    let before = 0;
    for (let mi = 0; mi < messages.length; mi++) {
        const m = messages[mi];
        const starts = segmentStarts(m);
        const sources = m.sources ?? [];
        for (let si = 0; si < sources.length; si++) {
            const s = sources[si];
            if (s.kind !== at.kind) continue;
            const hit = at.idPrefix != null ? String(s.id ?? '').startsWith(at.idPrefix) : s.id === at.id;
            if (hit) return { messageIndex: mi, offset: before + (starts ? starts[si] : 0), source: s };
        }
        before += m.content.length;
    }
    return null;
}

/**
 * 不稳定内容检查：扫描【参与拼装的原始文本】（宏替换之前的预设条目、卡字段、世界书条目内容）。
 * @param {{label:string, text:string, at:{kind:string, id?:string, idPrefix?:string}}[]} items
 *        label = 给人看的来源名；at = 在 messages 里怎么认出它（kind + id，和 assemble 的 sources 一致）
 * @param {{role:string, content:string, sources?:object[]}[]} messages  这次拼出来的 messages，用来确认「它真的参与了拼装」和算位置
 * @param {{stableRandom?: boolean}} [opts]  见 findUnstableMacros
 * @returns {{level:string, levelLabel:string, show:string, advice:string, count:number, where:string, positionPct:number}[]}
 *          按严重程度、再按位置（越靠前越靠前）排序。没出现在 messages 里的条目（被关掉 / 被丢掉）不算。
 */
export function scanUnstable(items, messages, opts = {}) {
    const total = messages.reduce((n, m) => n + m.content.length, 0);
    const found = [];
    for (const it of items) {
        const hits = findUnstableMacros(it.text, opts);
        if (!hits.length) continue;
        const loc = locateSource(messages, it.at);
        if (!loc) continue;
        const pct = total ? (loc.offset / total) * 100 : 0;
        for (const h of hits) {
            found.push({ level: h.level, levelLabel: LEVELS[h.level].label, show: h.show, advice: h.advice, count: h.count, where: it.label, positionPct: pct });
        }
    }
    found.sort((a, b) => LEVELS[a.level].rank - LEVELS[b.level].rank || a.positionPct - b.positionPct);
    return found;
}

/**
 * 世界书里会「进进出出」的条目：它们在系统提示区（角色定义前 / 后）时，进或出都会让后面的全部内容失效。
 * 看的是这次扫描的结果（worldinfo.js 的返回值）。
 * @returns {{probabilistic:number, triggered:number, probabilisticSkipped:number}}
 *   probabilistic        这次进来了、而且带概率（useProbability 且不是 100%）的条目数——下次可能就不进了
 *   triggered            这次进来了、靠关键词触发（不是常驻）的条目数——关键词不再出现时就会出去
 *   probabilisticSkipped 这次因为概率没进来的、位置在系统提示区的条目数——下次可能就进来了
 */
export function worldInfoRisk(worldInfo) {
    const out = { probabilistic: 0, triggered: 0, probabilisticSkipped: 0 };
    if (!worldInfo) return out;
    for (const e of [...(worldInfo.beforeEntries ?? []), ...(worldInfo.afterEntries ?? [])]) {
        if (e.useProbability && e.probability !== 100) out.probabilistic++;
        if (!e.constant) out.triggered++;
    }
    for (const s of worldInfo.skipped ?? []) {
        if (s.reason === 'probability' && (s.entry.position === 0 || s.entry.position === 1)) out.probabilisticSkipped++;
    }
    return out;
}
