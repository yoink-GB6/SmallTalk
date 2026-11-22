// 检查器「拼装」页：最近一次 computePrompt 的消息列表、出处着色、序列化文本视图。

import { serializeMessages } from '../llm.js';
import { $, h, toast } from './dom.js';
import { ui, state, save, preset, persist, setStableRandom, setPromptCache } from './state.js';
import { chatEndpointType } from './tab-provider.js';
import { refreshPreview, currentAuthorNote } from './pipeline.js';   // 循环依赖：只在函数体里调用
import { resolveContextLimit } from '../assemble.js';
import { breakdown, commonPrefix } from '../prompt-stats.js';
import { estimateTokens } from '../tokens.js';
import { lastSent, lastUsage } from './sent-log.js';
import { explainFirstDiff, scanUnstable, worldInfoRisk } from '../cache-hints.js';
import { DEFAULT_CONTEXT_LIMIT } from '../migrate.js';   // 上下文上限的默认值只在 migrate.js 定义一处
import { segView, resolveSource, messageHasEdit } from './prompt-edit.js';   // 就地编辑；循环依赖：只在函数体里调用

// ───────────────────────────── 检查器：拼装 ─────────────────────────────

export const SOURCE_KINDS = {
    prompt: '预设条目', marker: '占位条目', chat: '聊天记录', worldinfo: '世界书',
    depthPrompt: '角色卡深度提示', example: '示例对话', utility: '工具提示', prefill: '预填充', memory: '外置记忆',
    authorNote: '作者注释',
};

export function srcChip(s) {
    const label = s.kind === 'chat' ? `#${s.id} ${s.label}` : s.label;
    return h('span', { class: 'src', style: `--c: var(--src-${s.kind})`, title: `${SOURCE_KINDS[s.kind] ?? s.kind} · ${s.id} · ${s.chars} 字${s.depth != null ? ` · 深度 ${s.depth}` : ''}` },
        s.depth != null ? `@${s.depth} ` : '', label);
}

export function renderPromptTab() {
    const tab = $('#tab-prompt');
    const p = ui.preview;
    if (!p) return void tab.replaceChildren(h('div', { class: 'empty' }, '还没有内容。导入一张角色卡，或者直接发一句话。'));
    if (p.error) return void tab.replaceChildren(h('div', { class: 'empty' }, `拼装出错：${p.error.message}`));

    const total = p.messages.reduce((n, m) => n + m.content.length, 0);
    const wire = p.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content }));
    // 只有聊天模型走命令行类接口（claude-code / codex-cli，本地版才有）时才会把 messages 压平成一段文本；openai 类接口是原样发数组，没有「压平文本」可看
    const kind = chatEndpointType();
    const flat = kind === 'claude-code' || kind === 'codex-cli';
    const serialized = ui.showSerialized && flat;
    // 和上一次发送对比：只有「预览」才有意义；显示的本身就是上次发送时，没什么可比
    const prev = ui.previewIsSent ? null : lastSent();
    const cmp = prev ? commonPrefix(prev, p.messages) : null;
    const kids = [
        h('div', { class: 'summary' },
            h('span', { class: `badge ${ui.previewIsSent ? 'on' : ''}` }, ui.previewIsSent ? '上一次实际发送的' : p.hypothetical ? '预览（含输入框里的话）' : '预览'),
            h('b', null, `${p.messages.length} 条消息`), h('span', { class: 'dim' }, `${total.toLocaleString()} 字符`),
            h('span', { class: 'spacer' }),
            h('button', { onclick: () => navigator.clipboard.writeText(JSON.stringify(wire, null, 2)).then(() => toast('已复制 messages JSON', 'ok')) }, '复制 JSON'),
            !flat ? null : h('button', { onclick: () => { ui.showSerialized = !ui.showSerialized; renderPromptTab(); } }, ui.showSerialized ? '看 messages' : '看压平后的文本'),
        ),
        h('div', { class: 'usage' }, ...usageBlock(p, total, cmp, kind)),
    ].filter(Boolean);

    if (serialized) {
        // claude -p 只收一段文本，角色边界在这里被压平——这是和真酒馆最大的差别
        const { system, prompt } = serializeMessages(wire);
        kids.push(
            h('div', { class: 'section-title' }, kind === 'codex-cli' ? '系统提示（替换掉 Codex 默认的；后面还会固定追加一段「不要调用工具」的指示）' : '系统提示（替换掉 Claude Code 默认的）'),
            h('pre', { class: 'block card', style: 'padding:8px 10px' }, system),
            h('div', { class: 'section-title' }, `正文（经 stdin 传入，${prompt.length.toLocaleString()} 字符）`),
            h('pre', { class: 'block card', style: 'padding:8px 10px;max-height:none' }, prompt),
        );
        return void tab.replaceChildren(...kids);
    }

    kids.push(h('div', { class: 'legend' }, Object.entries(SOURCE_KINDS).map(([k, label]) =>
        h('span', null, h('i', { style: `background: var(--src-${k})` }), label))));

    const shown = new Set();   // 这次重画里已经画过编辑框的来源（prompt-edit.js segView）
    p.messages.forEach((m, i) => {
        // 有一段正在就地编辑的消息强制展开：重画（输入框打字、记忆压缩完成……）不能把编辑框收起来
        const open = ui.openMsgs.has(i) || messageHasEdit(m);
        const cardEl = h('div', { class: 'card' + (cmp ? (i < cmp.count ? ' cmp-same' : ' cmp-diff') : '') },
            h('header', { onclick: () => { open ? ui.openMsgs.delete(i) : ui.openMsgs.add(i); renderPromptTab(); } },
                h('span', { class: 'dim mono' }, String(i).padStart(2, '0')),
                h('span', { class: `badge role-${m.role}` }, m.role + (m.name ? ` · ${m.name}` : '')),
                h('div', { class: 'srcs' }, m.sources.slice(0, 8).map(srcChip),
                    m.sources.length > 8 ? h('span', { class: 'dim' }, `+${m.sources.length - 8}`) : null),
                h('span', { class: 'dim' }, `${m.content.length} 字`),
            ),
            open ? h('div', { class: 'body' }, segments(m, shown)) : null,
        );
        kids.push(cardEl);
    });

    if (p.regexHits.length) {
        kids.push(h('div', { class: 'section-title' }, `发送侧正则命中 ${p.regexHits.length} 次`));
        kids.push(h('div', { class: 'card', style: 'padding:6px 10px' }, p.regexHits.map(hit =>
            h('div', { class: 'log-line' }, `深度 ${hit.depth} · ${hit.script.scriptName} · ${hit.delta >= 0 ? '+' : ''}${hit.delta} 字`))));
    }
    if (p.log.length) {
        kids.push(h('div', { class: 'section-title' }, '拼装日志'));
        kids.push(h('div', { class: 'card', style: 'padding:6px 10px' }, p.log.map(l => h('div', { class: `log-line ${l.level}` }, l.message))));
    }
    tab.replaceChildren(...kids);
}

/**
 * 把一条消息按出处切成段显示。切不准（长度对不上）时退回整段显示。
 * 每段交给 prompt-edit.js segView：能就地改的段带一个「编辑」，正在编辑的段画成编辑框。
 * 只有一个出处的消息：能就地改时也画成一段（要有地方放「编辑」），不能改的照旧整段一个 <pre>。
 * @param {Set<string>} [shown]  同一次重画里共用（同一来源出现在几条消息里时，编辑框只画在第一处）
 */
export function segments(m, shown = new Set()) {
    // assemble.js 保证：content.length === Σ sources.chars + (sources.length − 1)，各段之间恰好一个 '\n'
    const expected = m.sources.reduce((n, s) => n + s.chars, 0) + m.sources.length - 1;
    const labelOf = s => `${SOURCE_KINDS[s.kind] ?? s.kind} · ${s.label}${s.depth != null ? ` · 深度 ${s.depth}` : ''}`;
    if (m.sources.length === 1 && resolveSource(m.sources[0])) return segView(m.sources[0], m.content, labelOf(m.sources[0]), shown);
    if (m.sources.length <= 1 || expected !== m.content.length) return h('pre', null, m.content);
    const parts = [];
    let pos = 0;
    for (const s of m.sources) {
        parts.push({ s, body: m.content.slice(pos, pos + s.chars) });
        pos += s.chars + 1;
    }
    return parts.map(({ s, body }) => segView(s, body, labelOf(s), shown));
}

// ───────────────────────────── 字数去向 + 和上次发送的对比 ─────────────────────────────

const openCats = new Set();   // 展开了「最大的几段」的类别（界面状态，不进存档）
const CAT_COLOR = { preset: 'prompt', card: 'example', persona: 'marker', worldinfo: 'worldinfo', chat: 'chat', memory: 'memory', note: 'authorNote', other: 'utility', joiner: 'utility' };
const TOP_N = 8;

// ───────────────────────────── 上下文上限 ─────────────────────────────

const MODE_LABEL = { preset: '跟随预设', custom: '自定义', off: '不限' };

/** 改了上限设置：存起来、重新预览（上一次发送的那份不会变，所以切回「预览」） */
function setContextLimit(patch) {
    state.contextLimit = { ...DEFAULT_CONTEXT_LIMIT, ...state.contextLimit, ...patch };
    save();
    ui.previewIsSent = false;
    refreshPreview();
}

/**
 * 「上下文上限」小节：设置（跟随预设 / 自定义 / 不限）、当前生效的上限从哪来、这次的预算用了多少、丢了几楼。
 * 规则在 assemble.js 文件头「上下文预算」；token 全是估算。
 */
function budgetBlock(p) {
    const setting = state.contextLimit ?? { ...DEFAULT_CONTEXT_LIMIT };
    const li = p.limitInfo ?? resolveContextLimit(setting, preset());
    const b = p.budget;
    const presetLabel = state.presetName || '内置默认预设';
    const source = !li.limit ? li.why
        : li.mode === 'custom' ? `自定义 ${li.limit.maxContext.toLocaleString()} token；回复预留取预设里的 openai_max_tokens（${li.limit.maxTokens.toLocaleString()}）`
            : `来自预设「${presetLabel}」：openai_max_context ${li.limit.maxContext.toLocaleString()}，openai_max_tokens（回复预留）${li.limit.maxTokens.toLocaleString()}`;
    const out = [
        h('div', { class: 'section-title' }, '上下文上限'),
        h('div', { class: 'ctx-limit' },
            h('label', { class: 'inline' }, '上限',
                h('select', { id: 'ctx-mode', onchange: e => setContextLimit({ mode: e.target.value }) },
                    Object.entries(MODE_LABEL).map(([v, label]) => h('option', { value: v, selected: (setting.mode ?? 'preset') === v }, label)))),
            setting.mode === 'custom'
                ? h('label', { class: 'inline' }, h('input', { id: 'ctx-max', type: 'number', min: 1, step: 1000, value: setting.maxContext ?? '', style: 'width:8em',
                    onchange: e => setContextLimit({ maxContext: Math.max(0, Math.floor(Number(e.target.value) || 0)) }) }), 'token')
                : null,
            h('span', { class: 'dim', id: 'ctx-source' }, `生效：${source}`)),
    ];
    if (!b) {
        out.push(h('div', { class: 'dim ctx-note' }, '超出上限时会像酒馆一样从最老的楼层开始不发（聊天记录本身不删）。'));
        return out;
    }
    const pct = b.available > 0 ? Math.min(100, (b.used / b.available) * 100) : 100;
    out.push(
        h('div', { class: 'budget-line', id: 'budget-used', 'data-used': b.used, 'data-available': b.available },
            '预算 ', h('b', null, `${b.available.toLocaleString()} token`), `（${b.limit.toLocaleString()} − 回复预留 ${b.reply.toLocaleString()}），已用 ≈ `,
            h('b', null, `${b.used.toLocaleString()}`),
            h('span', { class: 'dim' }, `　其中非聊天内容 ${(b.spent.primer + b.spent.reserved + b.spent.fixed + b.spent.utility).toLocaleString()}`
                + `${b.spent.reserved ? `（含外置记忆 ${b.spent.reserved.toLocaleString()}）` : ''}、聊天记录 ${b.spent.chat.toLocaleString()}、示例 ${b.spent.examples.toLocaleString()}`)),
        h('div', { class: 'budget-meter' + (b.droppedCount || b.overflow ? ' full' : '') }, h('i', { style: `width:${pct.toFixed(1)}%` })),
    );
    const lines = [];
    if (b.overflow) lines.push('非聊天内容（预设、角色卡、世界书' + (b.spent.reserved ? '、外置记忆' : '') + '）本身就超出了预算，聊天记录一楼都没放进去。调大上限，或者关掉一些预设条目 / 常驻世界书。');
    if (b.droppedCount) lines.push(b.keptCount
        ? `这次有 ${b.droppedCount} 楼（第 ${b.droppedFrom}–${b.droppedTo} 楼）因为超出上限没发，从最老的开始丢。`
        : `连最新的一楼都放不下：第 ${b.droppedFrom}–${b.droppedTo} 楼这次一楼都没发（酒馆也是这样，不报错）。`);
    if (b.droppedInjected) lines.push(`${b.droppedInjected} 条按深度注入的消息落在被丢的楼层之间，跟着没发。`);
    if (b.droppedExamples) lines.push(`${b.droppedExamples} 块示例对话没发（示例在聊天记录之后才占预算）。`);
    if (b.droppedSendIfEmpty) lines.push('send_if_empty 那条放不下，没发。');
    if (lines.length) {
        out.push(h('div', { class: 'budget-drop', id: 'budget-drop', 'data-dropped': b.droppedCount, 'data-from': b.droppedFrom ?? '', 'data-to': b.droppedTo ?? '' },
            ...lines.map(l => h('div', null, l)),
            h('div', { class: 'dim' }, '只影响这一次发给模型的内容，聊天记录本身一楼没删。开着外置记忆的话，这些楼层压好摘要后会以摘要的形式回来。')));
    } else {
        out.push(h('div', { class: 'dim ctx-note', id: 'budget-drop', 'data-dropped': 0 }, '没有超出上限，所有楼层都发了。'));
    }
    return out;
}

/** 「字数去向」块的内容：堆叠条、分类小表（可展开）、token 估算、和上次发送的对比 */
function usageBlock(p, total, cmp, kind) {
    const { cats } = breakdown(p.messages);
    const tokens = estimateTokens(p.messages.map(m => m.content).join('\n'));
    const shown = cats.filter(c => c.chars > 0);
    const out = [
        h('div', { class: 'section-title' }, '字数去向'),
        h('div', { class: 'usage-total' }, h('b', null, `${total.toLocaleString()} 字符`), '  ≈ ',
            h('b', null, `${tokens.toLocaleString()} token`), h('span', { class: 'dim' }, '（粗估：按 UTF-8 字节 ÷ 3.35，和酒馆没有分词器时的算法一样；中文可能偏差三四成，只看量级）')),
        h('div', { class: 'usage-bar' }, shown.map(c => h('i', { style: `flex:${c.chars};background:var(--src-${CAT_COLOR[c.key]})`, title: `${c.label} ${c.chars.toLocaleString()} 字 · ${c.pct.toFixed(1)}%` }))),
        ...budgetBlock(p),
    ];
    for (const c of shown) {
        const open = openCats.has(c.key);
        out.push(h('div', { class: 'usage-row', 'data-cat': c.key },
            h('button', { class: 'usage-head', onclick: () => { open ? openCats.delete(c.key) : openCats.add(c.key); renderPromptTab(); } },
                h('i', { style: `background:var(--src-${CAT_COLOR[c.key]})` }),
                h('span', { class: 'usage-name' }, c.label),
                h('span', { class: 'usage-chars mono' }, `${c.chars.toLocaleString()} 字`),
                h('span', { class: 'usage-pct dim' }, `${c.pct.toFixed(1)}%`),
                c.items.length ? h('span', { class: 'dim' }, open ? '▾' : '▸') : null),
            open && c.items.length ? h('div', { class: 'usage-items' },
                c.items.slice(0, TOP_N).map(it => h('div', null, h('span', null, it.label), h('span', { class: 'mono dim' }, `${it.chars.toLocaleString()} 字`))),
                c.items.length > TOP_N ? h('div', { class: 'dim' }, `…另有 ${c.items.length - TOP_N} 段较小的`) : null) : null));
    }
    out.push(h('div', { class: 'section-title' }, '和上一次发送相比'));
    if (!cmp) {
        out.push(h('div', { class: 'dim usage-cmp', id: 'usage-cmp' }, ui.previewIsSent
            ? '现在显示的就是上一次实际发送的内容，没什么可比的；在输入框里打字或改设置后再来看。'
            : '还没有可对比的上一次发送（发一条消息之后才有；刷新页面或切换存档后会清空）。'));
    } else {
        const pct = total ? ((cmp.chars / total) * 100).toFixed(1) : '0';
        out.push(h('div', { class: 'usage-cmp', id: 'usage-cmp', 'data-count': cmp.count }, cmp.identical
            ? `和上一次发送完全相同（${cmp.count} 条，${cmp.chars.toLocaleString()} 字）。`
            : `前 ${cmp.count} 条消息和上次完全相同，共 ${cmp.chars.toLocaleString()} 字，占现在总字数的 ${pct}%；`
                + `从第 ${String(cmp.diffIndex).padStart(2, '0')} 条开始不同`
                + (cmp.diffChar != null ? `，那一条从第 ${cmp.diffChar} 个字符起不同。` : '（多出来的新消息，或上次没有这一条）。')));
        const ex = explainFirstDiff(p.messages, cmp);
        if (ex) {
            out.push(h('div', { class: 'usage-cmp', id: 'usage-diff-source', 'data-pos': ex.positionPct.toFixed(1) },
                ex.source
                    ? `第一处不同：第 ${String(ex.messageIndex).padStart(2, '0')} 条消息里的「${ex.source.text}」，约在整段内容的 ${ex.positionPct.toFixed(0)}% 处——这个位置之前的内容才有机会按缓存价计费。`
                    : `这次的消息比上次少了一部分（上次多出来的没有了），所以这次发的内容是上次的开头，不同处在末尾。`));
        }
        out.push(h('div', { class: 'dim usage-cmp' }, '为什么看这个：很多接口对「和上次完全相同的开头」按低价计费，开头相同的部分越长越可能省钱。是否真的生效取决于接口，本项目没有验证过。下面消息列表里左边的绿条是和上次相同的，橙条是有变化的。'));
    }
    out.push(...lastUsageBlock(kind), ...unstableBlock(p));
    return out;
}

// ───────────────────────────── 上次请求的缓存命中 + 不稳定内容检查 ─────────────────────────────

const fmt = n => n.toLocaleString();
const openHints = new Set();   // 展开了细节的小节（界面状态，不进存档）

/**
 * 「上次请求」一行：上游在流末尾报的用量（见 llm.js 的 setUsageListener）。几种情况文字不同，不能混：
 * 没有用量 / 有用量但没报缓存（不能显示成 0%，那会误导）/ 都有。
 * 用的是「现在」的聊天接口类型判断是不是命令行类，所以上次发完又换了接口时这句可能不准——只是展示。
 */
function lastUsageBlock(kind) {
    const flat = kind === 'claude-code' || kind === 'codex-cli';
    const u = lastUsage();
    let text, st;
    if (!lastSent()) { text = '上次请求：还没有发送过（发一条消息之后才有；刷新页面或切换存档后会清空）。'; st = 'none'; }
    else if (flat) { text = '上次请求：这种接口（命令行）不提供用量信息。'; st = 'cli'; }
    else if (!u) { text = '上次请求：这个接口没有返回用量信息（有的中转不认识要求它报用量的字段，或者本来就不报）。'; st = 'nousage'; }
    else if (u.cachedTokens == null) {
        text = `上次请求：${u.inputTokens != null ? `输入 ${fmt(u.inputTokens)} token，` : ''}这个接口没有报告缓存命中。`; st = 'nocache';
    } else {
        const pct = u.inputTokens ? Math.round((u.cachedTokens / u.inputTokens) * 100) : null;
        text = `上次请求：${u.inputTokens != null ? `输入 ${fmt(u.inputTokens)} token，其中 ` : ''}${fmt(u.cachedTokens)} 命中缓存${pct != null ? `（${pct}%）` : ''}`
            + (u.cacheWriteTokens != null ? `，写入缓存 ${fmt(u.cacheWriteTokens)}` : '') + '。';
        st = 'full';
    }
    return [h('div', { class: 'usage-cmp', id: 'usage-last', 'data-state': st }, text)];
}

/** 现在这次拼装里的原始文本（宏替换之前），每项带「在 messages 里怎么认出它」：at 对应 assemble.js 给 sources 的 kind / id */
function collectRawItems(p) {
    const items = [];
    const add = (label, text, at) => { if (typeof text === 'string' && text) items.push({ label, text, at }); };
    for (const pr of preset().prompts ?? []) add(`预设条目「${pr.name ?? pr.identifier}」`, pr.content, [{ kind: 'prompt', id: pr.identifier }]);
    const c = state.card ?? {};
    add('角色卡（描述）', c.description, [{ kind: 'marker', id: 'charDescription' }]);
    add('角色卡（性格）', c.personality, [{ kind: 'marker', id: 'charPersonality' }]);
    add('角色卡（场景）', c.scenario, [{ kind: 'marker', id: 'scenario' }]);
    add('角色卡（示例对话）', c.mesExample, [{ kind: 'example', idPrefix: 'mes_example' }]);
    add('角色卡的深度提示', c.depthPrompt?.prompt, [{ kind: 'depthPrompt', id: 'DEPTH_PROMPT' }]);
    add('人设（persona）', state.persona?.description, [{ kind: 'marker', id: 'personaDescription' }]);
    const wi = p.worldInfo;
    const wiAt = (e, marker) => [{ kind: 'worldinfo', id: String(e.uid) }, ...(marker ? [{ kind: 'marker', id: marker }] : [])];
    for (const e of wi?.beforeEntries ?? []) add(`世界书条目「${e.comment || e.uid}」`, e.content, wiAt(e, 'worldInfoBefore'));
    for (const e of wi?.afterEntries ?? []) add(`世界书条目「${e.comment || e.uid}」`, e.content, wiAt(e, 'worldInfoAfter'));
    for (const g of wi?.depth ?? []) for (const e of g.entries ?? []) add(`世界书条目「${e.comment || e.uid}」`, e.content, wiAt(e));
    // 作者注释：正文 + 拼在它上下的世界书条目（只在这一轮插了的时候才在 messages 里，没插时 scanUnstable 找不到它们、不算）
    add('作者注释', currentAuthorNote().prompt, [{ kind: 'authorNote', id: 'authorNote' }]);
    for (const e of [...(wi?.anTopEntries ?? []), ...(wi?.anBottomEntries ?? [])]) add(`世界书条目「${e.comment || e.uid}」`, e.content, wiAt(e));
    return items;
}

/** 「不稳定内容检查」：默认只有一两行结论，点开看明细。不依赖和上次比较，第一次发送前就能看。 */
function unstableBlock(p) {
    // 开了「随机宏按存档固定」：{{random}} / {{roll}} 同一存档里每次结果相同，不再算「每次都变」
    const found = scanUnstable(collectRawItems(p), p.messages, { stableRandom: state.stableRandom === true });
    const risk = worldInfoRisk(p.worldInfo);
    const open = openHints.has('unstable');
    const worst = found[0];
    const head = found.length
        ? `发现 ${found.length} 处每次发送内容可能不一样的宏，最严重的是 ${worst.show}（${worst.levelLabel}），在${worst.where}，约在整段内容的 ${worst.positionPct.toFixed(0)}% 处。`
        : '没发现会让开头每次都变的宏（{{random::…}}、{{roll::…}}、{{time}}、{{lastMessage}} 这类）。';
    const wiTotal = risk.probabilistic + risk.triggered + risk.probabilisticSkipped;
    const wiLine = wiTotal
        ? `世界书里有会进进出出的条目：概率触发 ${risk.probabilistic + risk.probabilisticSkipped} 条（其中这次没进来的 ${risk.probabilisticSkipped} 条）、靠关键词触发 ${risk.triggered} 条，位置都在角色定义前 / 后。它们进来或出去时，后面的全部内容都按原价算。`
        : '世界书在角色定义前 / 后的条目里，没有概率触发或靠关键词触发的。';
    const out = [
        h('div', { class: 'section-title' }, '不稳定内容检查'),
        h('div', { class: 'usage-cmp', id: 'unstable-head', 'data-count': found.length, 'data-wi': wiTotal }, head),
        h('div', { class: 'usage-cmp dim', id: 'unstable-wi' }, wiLine),
    ];
    if (found.length) {
        out.push(h('button', { class: 'usage-head', id: 'unstable-toggle', onclick: () => { open ? openHints.delete('unstable') : openHints.add('unstable'); renderPromptTab(); } },
            h('span', null, open ? '收起明细 ▾' : '展开明细 ▸')));
        if (open) {
            out.push(h('div', { class: 'hint-list', id: 'unstable-list' }, found.map(f =>
                h('div', { class: `hint-item lv-${f.level}` },
                    h('div', null, h('b', { class: 'mono' }, f.show), f.count > 1 ? ` ×${f.count}` : '', `　${f.levelLabel}`),
                    h('div', { class: 'dim' }, `${f.where} · 约在整段内容的 ${f.positionPct.toFixed(0)}% 处（越靠前，变一次丢的缓存越多）`),
                    h('div', null, f.advice)))));
        }
    }
    out.push(...cacheSwitches());
    return out;
}

/**
 * 和提示缓存有关的两个开关（全局设置，GlobalRecord.stableRandom / promptCache；默认值时都不写字段，见 state.js setStableRandom / setPromptCache）。
 * 只读标签页里禁用（改了也存不下来）。改完重新预览：预览会按新设置重算（发出去的那份不变）。
 */
function cacheSwitches() {
    const ro = persist.readOnly;
    const changed = () => { save(); ui.previewIsSent = false; refreshPreview(); renderPromptTab(); };
    return [
        h('div', { class: 'section-title' }, '让开头更稳定'),
        h('div', { class: 'cache-switch' },
            h('label', { class: 'inline' },
                h('input', { type: 'checkbox', id: 'stable-random', checked: state.stableRandom === true, disabled: ro,
                    onchange: e => { setStableRandom(e.target.checked); changed(); } }),
                '随机宏在同一个存档里固定结果'),
            h('div', { class: 'dim' }, '打开后，{{random::…}} 和 {{roll::…}} 在同一个存档里每次结果相同，这样接口的缓存才能命中；代价是失去「每次都不一样」的效果。酒馆没有这个功能，默认关。（世界书条目的触发概率不受影响，照旧每次随机。）')),
        h('div', { class: 'cache-switch' },
            h('label', { class: 'inline' },
                h('input', { type: 'checkbox', id: 'prompt-cache', checked: state.promptCache !== false, disabled: ro,
                    onchange: e => { setPromptCache(e.target.checked); changed(); } }),
                '经 OpenRouter 用 Anthropic 的模型时自动缓存开头'),
            h('div', { class: 'dim' }, '经 OpenRouter 用 Anthropic 的模型（模型名以 anthropic/ 开头）时自动请它缓存开头，保留 1 小时。第一次写入缓存比平时贵一倍，之后命中的部分只要一成的价。别的接口和模型不受影响。')),
        ro ? h('div', { class: 'dim' }, '这个标签页是只读的，开关改不了。') : null,
    ].filter(Boolean);
}
