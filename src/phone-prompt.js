// 一次手机聊天怎么拼提示（buildPhonePrompt）。纯函数，Node 里可测（test/phone-prompt.test.mjs）。契约见 types.js BuildPhonePrompt。
//
// 为什么不复用 assemble.js / ui/pipeline.js computePrompt（详见契约）：
//   assemble 按酒馆预设的 prompt_order 拼，聊天预设没有那些；computePrompt 绑着 state 里的当前 RP 卡，手机会话的卡不一定是它；
//   RP 的正则、作者注释、示例对话、prefill 放到短消息里只会帮倒忙。
//   这里只复用不绑 state 的纯函数：macros.js substitute、worldinfo.js scanWorldInfo、assemble.js messageTokens（token 估算的口径和 RP 一致）。
//
// 拼出来的样子（从上到下）：
//   [system]  预设的 system（宏替换、压空行）+ 世界书（位置 0–3）+ format + stickerHint
//   [历史]    最近 history 个气泡；相邻同角色的合成一条、用换行连起来；@深度的世界书条目插在相应位置
//   [system]  「现在是……」+ extras（timeHint 关掉且没有 extras 时没有这一条）
// 会变的东西（新气泡、时间）都在后面，前面的部分每次一样——接口的前缀缓存才命中得上。

import { substitute } from './macros.js';
import { scanWorldInfo, effectiveWiSettings } from './worldinfo.js';
import { messageTokens } from './assemble.js';
import { estimateTokens as defaultEstimate } from './tokens.js';
import { normalizeChatPreset, builtinPreset, stickerToken, DEFAULT_REPLY_TOKENS, PHONE_CHOICES } from './phone-data.js';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad2 = n => String(n).padStart(2, '0');

/** 「2026年11月28日 星期六 21:03」：按 now 的本地时间，自己拼，不靠宏（宏的日期格式是照酒馆的，不一定是中文） */
export function phoneTimeText(now) {
    return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 宏替换之后：连续三个以上的换行压成两个、去首尾空白（卡里空着的字段不会留下一串空行） */
export const squeezeBlankLines = s => String(s ?? '').replace(/\n[ \t]*(\n[ \t]*){2,}/g, '\n\n').trim();

/**
 * 表情列表的文字（{{stickers}} 换成它）。withDesc：带不带描述（PHONE_CHOICES.stickerDesc，用户定的：不发）。
 * @param {{name: string, desc?: string}[]} stickers
 */
export function stickerListText(stickers, withDesc) {
    return stickers.map(s => (withDesc && s.desc ? `${s.name}（${s.desc}）` : s.name)).join('、');
}

/**
 * 历史：去掉 system 气泡、取最后 n 条，表情气泡换成表情【现在】的名字，相邻同角色的合并成一条。
 * 返回的每条另带 bubbles（合并了几个气泡），预算丢楼时数「丢了几个气泡」用。
 */
export function historyMessages(messages, n, { stickers, userName, charName }) {
    const byId = new Map(stickers.map(s => [s.id, s]));
    const list = (Array.isArray(messages) ? messages : []).filter(m => m.role === 'user' || m.role === 'assistant');
    const recent = n > 0 ? list.slice(-n) : [];
    const out = [];
    for (const m of recent) {
        const st = m.sticker ? byId.get(m.sticker) : null;
        const text = st ? stickerToken(st.name) : m.content;
        const prev = out[out.length - 1];
        if (prev && prev.role === m.role) { prev.content += '\n' + text; prev.bubbles++; continue; }
        out.push({ role: m.role, name: m.role === 'user' ? userName : charName, content: text, bubbles: 1 });
    }
    return out;
}

/**
 * @type {import('./types.js').BuildPhonePrompt}
 * 额外的可选参数（契约之外、为了好改）：args.stickerDesc（默认 PHONE_CHOICES.stickerDesc）。
 */
export function buildPhonePrompt(args) {
    const preset = normalizeChatPreset(args.preset) ?? builtinPreset();
    const card = args.cards?.[0] ?? {};
    const persona = args.persona ?? { name: 'User', description: '' };
    const userName = persona.name || 'User';
    const charName = card.name || 'Assistant';
    const stickers = Array.isArray(args.stickers) ? args.stickers : [];
    const est = args.estimateTokens ?? defaultEstimate;
    const tokensOf = m => messageTokens(m, est);
    const now = args.now instanceof Date ? args.now : new Date();
    const log = [];
    const info = message => log.push({ level: 'info', message });

    // 2. 历史（先做，宏的 chat 和世界书扫描都要它）
    const hist = historyMessages(args.messages, preset.history, { stickers, userName, charName });

    // 1. 宏上下文。手机聊天没有自己的变量：{{setvar}} 写进这份一次性的副本，用完就扔
    const variables = { local: {}, global: structuredClone(args.globalVariables ?? {}) };
    const ctx = {
        user: userName, char: charName,
        description: card.description ?? '', personality: card.personality ?? '', scenario: card.scenario ?? '', persona: persona.description ?? '',
        chat: hist.map(({ role, name, content }) => ({ role, name, content })),
        variables, outlets: {}, now, seed: args.seed ?? '',
    };
    const sub = text => substitute(String(text ?? ''), ctx);

    // 3. 世界书：扫的是第 2 步的历史（合并后的条数 = 扫描深度数的「楼」）
    const worldInfo = scanWorldInfo({
        entries: Array.isArray(args.worldEntries) ? args.worldEntries : [],
        chat: ctx.chat, settings: args.wi ?? effectiveWiSettings({}), substitute: sub,
    });
    ctx.outlets = worldInfo.outlets ?? {};   // {{outlet::名字}} 在后面的文字里才取得到
    const wiText = [worldInfo.before, worldInfo.after, ...(worldInfo.anTop ?? []), ...(worldInfo.anBottom ?? [])]
        .map(s => String(s ?? '').trim()).filter(Boolean).join('\n');
    if (worldInfo.activated?.length) info(`世界书：激活 ${worldInfo.activated.length} 条`);
    if ((worldInfo.examplesBefore?.length ?? 0) + (worldInfo.examplesAfter?.length ?? 0)) info('世界书里「示例对话前 / 后」位置的条目在手机聊天里不用，没发');

    // 4. 第一条 system。我们自己的占位符先换掉，再交给宏（宏不认识它们）
    const parts = [squeezeBlankLines(sub(preset.system))];
    if (wiText) parts.push(wiText);
    parts.push(squeezeBlankLines(sub(preset.format.replaceAll('{{maxBubbles}}', String(preset.maxBubbles)))));
    if (preset.stickers && stickers.length) {
        const withDesc = args.stickerDesc ?? PHONE_CHOICES.stickerDesc;
        parts.push(squeezeBlankLines(sub(preset.stickerHint.replaceAll('{{stickers}}', stickerListText(stickers, withDesc)))));
    }
    const head = { role: 'system', content: parts.filter(Boolean).join('\n\n') };

    // 6. 最后一条 system：时间 + extras
    const tailLines = [];
    if (preset.timeHint) tailLines.push(`现在是 ${phoneTimeText(now)}。`);
    for (const x of Array.isArray(args.extras) ? args.extras : []) if (x && x.text) tailLines.push(`${x.label}：${x.text}`);
    const tail = tailLines.length ? { role: 'system', content: tailLines.join('\n') } : null;

    // 3'. @深度的条目：同 RP（populationInjectionPrompts）——深度 d = 它后面还有 d 条历史消息。
    //     每条挂在「它后面紧挨着的那条历史」上（anchor），预算丢历史时跟着一起丢；深度超过历史条数的放在最前面（挂第 0 条）。
    //     深度 0 = 在所有历史之后，挂最后一条（最新的那条永远会发，所以它也一定发）。
    const injections = (worldInfo.depth ?? []).filter(g => String(g.content ?? '').trim()).map(g => {
        const at = Math.max(0, hist.length - Number(g.depth));
        return { at, anchor: hist.length ? Math.min(at, hist.length - 1) : -1, msg: { role: g.role, content: g.content } };
    });

    // 7. 上限：头尾必须发；历史从新到旧放，放不下就停
    const reply = typeof preset.params?.max_tokens === 'number' ? preset.params.max_tokens : DEFAULT_REPLY_TOKENS;
    const budget = preset.contextTokens - reply;
    const required = tokensOf(head) + (tail ? tokensOf(tail) : 0) + injections.filter(x => x.anchor < 0).reduce((n, x) => n + tokensOf(x.msg), 0);
    const injCost = i => injections.filter(x => x.anchor === i).reduce((n, x) => n + tokensOf(x.msg), 0);
    let used = required, from = hist.length;
    const overflow = required > budget;
    if (overflow) {
        from = Math.max(0, hist.length - 1);   // 只留最新的一条
        log.push({ level: 'warn', message: `系统提示本身就超出了上下文上限（${preset.contextTokens}），这次只发系统提示和最新的一条` });
    } else {
        for (let i = hist.length - 1; i >= 0; i--) {
            const cost = tokensOf(hist[i]) + injCost(i);
            if (used + cost > budget) break;
            used += cost; from = i;
        }
    }
    const dropped = hist.slice(0, from).reduce((n, m) => n + m.bubbles, 0);
    if (dropped) info(`超出上下文上限：最早的 ${dropped} 个气泡这次没发`);

    // 5. 组装：历史，@深度条目插在第 at 条历史之前（at = 历史条数 = 放在最后）。
    //    挂靠的那条历史因为上限没发的，条目跟着不发（同 RP）；没有历史时（anchor -1）照发
    const kept = injections.filter(x => x.anchor < 0 || x.anchor >= from);
    const body = [];
    for (let i = from; i <= hist.length; i++) {
        for (const x of kept) if (x.at === i) body.push(x.msg);
        if (i < hist.length) body.push({ role: hist[i].role, content: hist[i].content });
    }
    const messages = [head, ...body, ...(tail ? [tail] : [])];
    return { messages, log, dropped, overflow, worldInfo };
}
