// 导出：把我们的 Card / 世界书条目还原成酒馆能读的 JSON，外加一个文件名工具。
// 和 card.js（导入、解析）是反方向，分开放免得两边搅在一起。
// 纯函数，不碰 DOM / IndexedDB / fetch，浏览器和 Node 都能直接加载。
//
// 对应酒馆 1.19.0：
//   src/endpoints/characters.js
//     convertWorldInfoToCharacterBook（~L663）  世界书条目 → 卡内嵌 character_book
//     unsetPrivateFields（~L498）               导出 / 导入时清掉的私人字段
//     router.post('/export')（~L1646）          导出 PNG / JSON 的流程
//     charaFormatData / convertToV2（~L565 / ~L470）V1 卡升级成 V2
//   public/scripts/world-info.js
//     convertCharacterBook（~L5617）            character_book → 条目（我们在 card.js 里已有）
//     newWorldInfoEntryDefinition（~L4083）     独立世界书条目的字段和默认值
//     addMissingWorldInfoFields（~L2103）       酒馆读世界书时用模板补齐缺的字段
//   node_modules/sanitize-filename             酒馆处理文件名用的库

import { parseCard } from './card.js';
import { scriptsChanged, writeScriptsInto } from './scripts.js';

/** @typedef {import('./types.js').Card} Card */
/** @typedef {import('./types.js').WorldEntry} WorldEntry */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** JSON 语义上的相等：键顺序无关，undefined 的键视同不存在（和 JSON.stringify 的行为一致） */
function jsonEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => jsonEqual(x, b[i]));
    }
    if (isObj(a) && isObj(b)) {
        const ka = Object.keys(a).filter((k) => a[k] !== undefined);
        const kb = Object.keys(b).filter((k) => b[k] !== undefined);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
    }
    return false;
}

// ───────────────────────────── 条目 → character_book 条目 ─────────────────────────────

// 我们建模了的条目字段 → 写回 character_book 条目时怎么写。
// 对照的是酒馆 convertWorldInfoToCharacterBook 的字段对照（反方向是 convertCharacterBook）：
//   uid → id，key → keys，keysecondary → secondary_keys，order → insertion_order，disable → enabled（取反），
//   position → 顶层字符串 position（0 写 'before_char'，其它一律 'after_char'）+ extensions.position（数字，读回来以它为准），
//   其余放在 extensions 下，名字改成下划线风格（excludeRecursion → exclude_recursion 等）；
//   selectiveLogic / useProbability 在 extensions 里保持驼峰，酒馆就是这么写的。
// 'book' 是我们加的字段，不写回。
/** @type {Record<string, (out: any, v: any) => void>} */
const WRITERS = {
    uid: (o, v) => { o.id = v; },
    key: (o, v) => { o.keys = clone(v); },
    keysecondary: (o, v) => { o.secondary_keys = clone(v); },
    comment: (o, v) => { o.comment = v; },
    content: (o, v) => { o.content = v; },
    constant: (o, v) => { o.constant = v; },
    selective: (o, v) => { o.selective = v; },
    order: (o, v) => { o.insertion_order = v; },
    disable: (o, v) => { o.enabled = !v; },
    position: (o, v) => { o.position = v == 0 ? 'before_char' : 'after_char'; ext(o).position = v; },
    excludeRecursion: (o, v) => { ext(o).exclude_recursion = v; },
    preventRecursion: (o, v) => { ext(o).prevent_recursion = v; },
    delayUntilRecursion: (o, v) => { ext(o).delay_until_recursion = v; },
    probability: (o, v) => { ext(o).probability = v; },
    useProbability: (o, v) => { ext(o).useProbability = v; },
    depth: (o, v) => { ext(o).depth = v; },
    selectiveLogic: (o, v) => { ext(o).selectiveLogic = v; },
    outletName: (o, v) => { ext(o).outlet_name = v; },
    scanDepth: (o, v) => { ext(o).scan_depth = v; },
    caseSensitive: (o, v) => { ext(o).case_sensitive = v; },
    matchWholeWords: (o, v) => { ext(o).match_whole_words = v; },
    role: (o, v) => { ext(o).role = v; },
};
function ext(o) {
    if (!isObj(o.extensions)) o.extensions = {};
    return o.extensions;
}

/**
 * 一条【新】条目（原卡里对不上的）→ character_book 条目，逐字段照搬酒馆 convertWorldInfoToCharacterBook。
 * 我们的 WorldEntry 没有的字段（group、sticky、triggers…）照酒馆的 `?? 默认值` 落到默认值；
 * display_index 在酒馆里是 entry.displayIndex，我们没有，JSON 里就不出现（和酒馆序列化 undefined 的结果一样）。
 * @param {any} entry
 */
function newBookEntry(entry) {
    return {
        id: entry.uid,
        keys: clone(entry.key),
        secondary_keys: clone(entry.keysecondary),
        comment: entry.comment,
        content: entry.content,
        constant: entry.constant,
        selective: entry.selective,
        insertion_order: entry.order,
        enabled: !entry.disable,
        position: entry.position == 0 ? 'before_char' : 'after_char',
        use_regex: true, // 酒馆原注释：ST keys are always regex
        extensions: {
            position: entry.position,
            exclude_recursion: entry.excludeRecursion,
            probability: entry.probability ?? null,
            useProbability: entry.useProbability ?? false,
            depth: entry.depth ?? 4,
            selectiveLogic: entry.selectiveLogic ?? 0,
            outlet_name: entry.outletName ?? '',
            group: entry.group ?? '',
            group_override: entry.groupOverride ?? false,
            group_weight: entry.groupWeight ?? null,
            prevent_recursion: entry.preventRecursion ?? false,
            delay_until_recursion: entry.delayUntilRecursion ?? false,
            scan_depth: entry.scanDepth ?? null,
            match_whole_words: entry.matchWholeWords ?? null,
            use_group_scoring: entry.useGroupScoring ?? false,
            case_sensitive: entry.caseSensitive ?? null,
            automation_id: entry.automationId ?? '',
            role: entry.role ?? 0,
            vectorized: entry.vectorized ?? false,
            sticky: entry.sticky ?? null,
            cooldown: entry.cooldown ?? null,
            delay: entry.delay ?? null,
            match_persona_description: entry.matchPersonaDescription ?? false,
            match_character_description: entry.matchCharacterDescription ?? false,
            match_character_personality: entry.matchCharacterPersonality ?? false,
            match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
            match_scenario: entry.matchScenario ?? false,
            match_creator_notes: entry.matchCreatorNotes ?? false,
            triggers: entry.triggers ?? [],
            ignore_budget: entry.ignoreBudget ?? false,
        },
    };
}

/**
 * 把 card.worldEntries 写回 character_book.entries。
 *
 * 和酒馆有意不同的地方：酒馆保存角色时（charaFormatData）是用 convertWorldInfoToCharacterBook 把整本书【重新生成】，
 * 只留 {entries, name}，原书的 description / scan_depth / token_budget 等顶层字段、原条目顶层上酒馆不认识的字段
 * （V3 规范的 name / priority / case_sensitive 等）都会丢。这里改成「以原条目为底，只改用户动过的字段」：
 *   1. 按 uid 把每条当前条目对回原卡里的条目（原条目的 uid = 它的 id，没有 id 时 = 它在数组里的下标，和 convertCharacterBook 一致）；
 *   2. 把原条目用 convertCharacterBook 再转一遍得到「导入时的样子」，逐个建模字段比较，
 *      只有和导入时不同的字段才按上面 WRITERS 的对照写回去；没变的字段连写法都不动（比如原卡 position 字符串和
 *      extensions.position 不一致，只要用户没改位置，就保持原样）；
 *   3. 对不上的是新增条目，照酒馆的 convertWorldInfoToCharacterBook 补齐；原卡里有、现在没有的就是删了，不写出。
 * 好处是没改过的卡导出后和原文件完全一样（测试里的关键验收）。
 *
 * @param {Object[]} rawEntries   原 character_book.entries（可能没有）
 * @param {WorldEntry[]} baseline 原卡导入时转出的条目（与 rawEntries 一一对应）
 * @param {WorldEntry[]} current  现在的条目
 */
function mergeBookEntries(rawEntries, baseline, current) {
    const used = new Set();
    return current.map((entry, outIndex) => {
        const i = baseline.findIndex((b, j) => !used.has(j) && String(b.uid) === String(entry.uid));
        if (i < 0) return newBookEntry(entry);
        used.add(i);
        const out = clone(rawEntries[i]);
        const base = baseline[i];
        for (const [field, write] of Object.entries(WRITERS)) {
            if (!jsonEqual(entry[field], base[field])) write(out, entry[field]);
        }
        // 原条目没有 id、uid 是靠下标推出来的：前面删了条目，下标就会移动，读回来 uid 会变。
        // 这时补上 id 把 uid 钉住（酒馆 convertCharacterBook 自己也会回写 entry.id = index）。
        if (out.id === undefined && String(outIndex) !== String(entry.uid)) out.id = entry.uid;
        return out;
    });
}

// ───────────────────────────── 卡的文字字段 ─────────────────────────────

const s = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 「拼装」页 / 「写卡」页能改的卡字段 → 写回酒馆卡 JSON 的哪里。照酒馆保存角色时的 charaFormatData（characters.js ~L580–625）：
 *   name / description / personality / scenario / first_mes / mes_example：顶层和 data.* 两处都写（V1 只有顶层，就只写顶层；
 *   V3 卡的正文也在 data.*，PNG 里的 ccv3 块是同一份 JSON 改了 spec，见 png.js writeCardToPng）；
 *   这两页改字段时本来就同时改了 card.raw（prompt-edit.js / card-writer.js 的 writeRaw），这里是兜底：raw 没跟着改的情况下导出也对；
 *   system_prompt / post_history_instructions：只在 data.*；
 *   深度提示：data.extensions.depth_prompt.prompt（缺 depth / role 时照酒馆补默认 4 / system）。
 * dataOnly 的字段 V1 卡没地方放：改了就要升级成 V2（upgradeV1 用的是 Card 上的当前值，已经带着改动）。
 */
const TEXT_FIELDS = [
    ...[['name', 'name'], ['description', 'description'], ['personality', 'personality'], ['scenario', 'scenario'], ['firstMes', 'first_mes'], ['mesExample', 'mes_example']].map(([k, key]) => ({
        get: (c) => s(c?.[k]),
        write: (o, v) => { o[key] = v; if (isObj(o.data)) o.data[key] = v; },
    })),
    ...[['systemPrompt', 'system_prompt'], ['postHistoryInstructions', 'post_history_instructions']].map(([k, key]) => ({
        dataOnly: true,
        get: (c) => s(c?.[k]),
        write: (o, v) => { o.data[key] = v; },
    })),
    {
        dataOnly: true,
        get: (c) => s(c?.depthPrompt?.prompt),
        write: (o, v) => {
            if (!isObj(o.data.extensions)) o.data.extensions = {};
            const dp = isObj(o.data.extensions.depth_prompt) ? o.data.extensions.depth_prompt : { depth: 4, role: 'system' };
            dp.prompt = v;
            o.data.extensions.depth_prompt = dp;
        },
    },
    // 备选开场白（写卡页的开场白列表）：只在 data.alternate_greetings（charaFormatData 的 _.set(char, 'data.alternate_greetings', …)），
    // V1 没有这个字段，所以是 dataOnly：V1 卡加了备选开场白，导出时照酒馆导入 V1 的做法（convertToV2 → charaFormatData）升级成 V2。
    // 是数组，按 JSON 比（eq）；写卡页不把它写进 raw（理由见 card-writer.js「多个开场白」），所以这里是它唯一的写出口
    {
        dataOnly: true,
        get: (c) => (Array.isArray(c?.alternateGreetings) ? c.alternateGreetings : []),
        eq: jsonEqual,
        write: (o, v) => { o.data.alternate_greetings = clone(v); },
    },
];

// ───────────────────────────── 卡 → 酒馆卡 JSON ─────────────────────────────

/**
 * 酒馆 unsetPrivateFields（characters.js ~L498）：导出（PNG / JSON 都是）和导入时都会调用。
 *   _.set(char, 'fav', false); _.set(char, 'data.extensions.fav', false); _.unset(char, 'chat');
 * 注意它是「设成 false」而不是删掉，原来没有这两个键的卡也会被加上。原地修改并返回同一个对象。
 * @param {any} char
 */
export function unsetPrivateFields(char) {
    char.fav = false;
    if (!isObj(char.data)) char.data = {};
    if (!isObj(char.data.extensions)) char.data.extensions = {};
    char.data.extensions.fav = false;
    delete char.chat;
    return char;
}

/**
 * V1 老卡（没有 spec / data）升级成 V2。依据：酒馆从不保存 V1——导入 V1 时就走 convertToV2 → charaFormatData
 * 升成 V2（characters.js importFromJson 的 v1 分支），导出 JSON 时 getCharaCardV2 遇到没有 spec 的也会升级。
 * 所以导出成酒馆的样子就是 V2。字段照 charaFormatData 写，原卡顶层字段全部保留（charaFormatData 也是以原 JSON 为底）。
 * 有意不同：不写 chat（私人字段，酒馆导出时也会删掉）、avatar: 'none'、create_date（酒馆写当前时间，
 * 我们要求同一张卡导出两次结果一样）；V1 的顶层镜像字段原样保留。
 * @param {any} raw V1 卡（会被修改，调用方传副本）
 * @param {Card} card
 */
function upgradeV1(raw, card) {
    const tags = typeof raw.tags === 'string' ? raw.tags.split(',').map((x) => x.trim()).filter((x) => x) : Array.isArray(raw.tags) ? raw.tags : [];
    const dp = card.depthPrompt;
    return Object.assign(raw, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name,
            description: card.description,
            personality: card.personality,
            scenario: card.scenario,
            first_mes: card.firstMes,
            mes_example: card.mesExample,
            creator_notes: card.creatorNotes,
            system_prompt: card.systemPrompt ?? '',
            post_history_instructions: card.postHistoryInstructions ?? '',
            tags,
            creator: raw.creator || '',
            character_version: raw.character_version || '',
            alternate_greetings: clone(card.alternateGreetings ?? []),
            extensions: {
                talkativeness: raw.talkativeness || 0.5,
                fav: raw.fav === true || raw.fav === 'true',
                world: '',
                depth_prompt: { prompt: dp?.prompt ?? '', depth: dp?.depth ?? 4, role: dp?.role ?? 'system' },
            },
        },
    });
}

/**
 * 把我们的 Card 还原成酒馆的卡 JSON。以 card.raw（导入时原样保留的原始 JSON）为底，
 * 只覆盖我们这边会被用户改的几块：卡内嵌世界书（card.worldEntries）、卡自带正则（card.regexScripts）、
 * 酒馆助手脚本（card.scripts → data.extensions.tavern_helper，合并规则在 scripts.js writeScriptsInto），
 * 以及「拼装」页 / 「写卡」页改过的文字字段（TEXT_FIELDS：名字、描述、性格、场景、开场白、备选开场白、示例对话、system_prompt、post_history_instructions、深度提示）。
 * 其余字段一个不动；没改过的卡导出结果与 card.raw JSON 语义相同。不修改 card.raw。
 *
 * 注意：酒馆导出时会跑 unsetPrivateFields（fav 设成 false、删 chat）。为了让「没改过 = 原样」可验证，
 * 默认不做；要和酒馆的导出完全一致（给别人分享）就传 {stripPrivate: true}。
 *
 * @param {Card} card
 * @param {{stripPrivate?: boolean}} [options]
 * @returns {Object}
 */
export function exportCardJson(card, options = {}) {
    const raw = isObj(card?.raw) ? card.raw : {};
    let out = clone(raw);
    // 「导入时的样子」：用同一个 parseCard 再解析一遍原卡，用来判断用户改了什么
    let baseline = null;
    try { baseline = parseCard(raw); } catch { /* raw 不完整（比如旧数据迁移来的空 raw）：当作什么都没有 */ }
    const baseEntries = baseline?.worldEntries ?? [];
    const baseRegex = (baseline?.regexScripts ?? []).map(stripOrigin);

    const entries = Array.isArray(card.worldEntries) ? card.worldEntries : [];
    const regex = (Array.isArray(card.regexScripts) ? card.regexScripts : []).map(stripOrigin);
    const worldName = typeof card.worldName === 'string' ? card.worldName : '';

    const bookChanged = !jsonEqual(entries, baseEntries) || worldName !== (baseline?.worldName ?? '');
    const regexChanged = !jsonEqual(regex, baseRegex);
    // 酒馆助手脚本（card.scripts，规则见 scripts.js 文件头「导出」）：没在「脚本」页改过 = 不碰 raw
    const scriptsDirty = scriptsChanged(card);
    // 文字字段（「拼装」页可以就地改）：和「导入时的样子」逐个比，只有变了的才写。改了又改回原样 = 没改
    const fieldsChanged = baseline ? TEXT_FIELDS.filter((f) => !(f.eq ?? Object.is)(f.get(card), f.get(baseline))) : [];
    const needsData = fieldsChanged.some((f) => f.dataOnly);

    // V1：只有真要写世界书 / 正则 / 脚本 / V1 没有位置的字段（system_prompt 等）时才升级。什么都没改就原样还回去，
    // 酒馆导入 V1 时自己会升级，结果和我们升级后再导入是一样的，原样更不容易出错。
    // raw 解析不出卡（迁移来的空卡 emptyCard() 的 raw = {}）：没有底可用，直接用 Card 的字段拼一张 V2。
    const isV1 = !isObj(out.data);
    if (!baseline || (isV1 && (bookChanged || regexChanged || scriptsDirty || needsData))) out = upgradeV1(out, card);
    for (const f of fieldsChanged) f.write(out, f.get(card));

    if (bookChanged) {
        const rawBook = isObj(out.data.character_book) ? out.data.character_book : null;
        if (rawBook || entries.length) {
            const book = rawBook ?? {};
            const rawEntries = Array.isArray(book.entries) ? book.entries : [];
            book.entries = mergeBookEntries(rawEntries, baseEntries, entries);
            // 书名：没改就不动（原卡可能根本没有 name，名字来自 extensions.world）；
            // 新建的书照酒馆 convertWorldInfoToCharacterBook 带上 name，缺省用卡名（和 parseCard 给条目的 book 一致）
            if (!rawBook || worldName !== (baseline?.worldName ?? '')) book.name = worldName || card.name || '';
            out.data.character_book = book;
        }
    }

    if (regexChanged) {
        if (!isObj(out.data.extensions)) out.data.extensions = {};
        out.data.extensions.regex_scripts = regex;
    }

    if (scriptsDirty) writeScriptsInto(out, card);

    if (options.stripPrivate) unsetPrivateFields(out);
    return out;
}

function stripOrigin(s) {
    if (!isObj(s)) return s;
    const { origin, ...rest } = s; // origin 是我们加的（标记来源），酒馆文件里没有
    return clone(rest);
}

// ───────────────────────────── 独立世界书文件 ─────────────────────────────

// 酒馆 newWorldInfoEntryDefinition 里不带 excludeFromTemplate 的字段及默认值，顺序照抄
// （= newWorldInfoEntryTemplate）。酒馆读世界书时 addMissingWorldInfoFields 会用它补齐缺的字段，
// 所以我们写出时也全部带上，酒馆读到的结果和它自己存的一样。
const WORLD_ENTRY_TEMPLATE = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '',
    constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: false,
    order: 100, position: 0, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4,
    outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
    triggers: [],
});

/**
 * 条目数组 → 酒馆独立世界书文件的对象 {entries: {"<uid>": {...}}}。
 * - 每条 = 模板默认值 + 条目自己的全部字段（parseWorldbook 会把原文件里我们不认识的字段原样带在条目上，
 *   这里也原样写回，比如 displayIndex、extensions、characterFilter）；去掉我们加的 book。
 * - uid 作键（酒馆 data.entries[uid]）；uid 重复时后面的会盖掉前面的，调用方要保证唯一（界面新增条目取最大值 + 1）。
 * - 酒馆的世界书文件里没有书名（名字就是文件名），所以这里不写名字；书名用来起文件名：safeFileName(name, 'json')。
 * - 酒馆从卡里导入的世界书文件顶层还有 originalData（原 character_book 的副本），这里不写：
 *   酒馆唯一读它的地方是 charaFormatData，而且紧接着就被重新生成的 character_book 覆盖，实际不起作用。
 * @param {WorldEntry[]} entries
 * @returns {{entries: Object<string, Object>}}
 */
export function serializeWorldbook(entries) {
    const out = {};
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!isObj(e)) continue;
        const { book, ...rest } = /** @type {any} */ (e);
        out[String(e.uid)] = { ...clone(WORLD_ENTRY_TEMPLATE), ...clone(rest) };
    }
    return { entries: out };
}

// ───────────────────────────── 文件名 ─────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_BYTES = 200; // 留出扩展名和「 (1)」的余量；酒馆的 sanitize-filename 截在 255 字节

/** 按 UTF-8 字节截断，不切断一个字符（也不把 emoji 的代理对拆开） */
function truncateUtf8(s, maxBytes) {
    const enc = new TextEncoder();
    let bytes = 0;
    let out = '';
    for (const ch of s) { // for...of 按码点走，emoji 不会被拆成半个
        const n = enc.encode(ch).length;
        if (bytes + n > maxBytes) break;
        bytes += n;
        out += ch;
    }
    return out;
}

/**
 * 给下载用的安全文件名。规则照酒馆用的 sanitize-filename 库，外加两条它没管的：
 *   - 去掉 / ? < > \ : * | "（Windows 不允许；安卓的文件系统也不接受其中大部分）和控制字符；
 *   - 去掉首尾的空格和点（Windows 会自动吃掉尾部的点和空格；开头的点在安卓 / Linux 上是隐藏文件）；
 *   - CON / PRN / AUX / NUL / COM1 / LPT1 这些 Windows 保留名，前面加下划线（sanitize-filename 是直接清空）；
 *   - 按 UTF-8 字节限制长度（sanitize-filename 是 255 字节，我们取 200 留余量），中文、emoji 原样保留；
 *   - 清完是空的就用默认名。
 * @param {string} name
 * @param {string} [ext]        扩展名，带不带点都行，如 'png' / '.json'
 * @param {string} [fallback]   名字清空后用的默认名
 * @returns {string}
 */
export function safeFileName(name, ext = '', fallback = '未命名') {
    let base = String(name ?? '')
        .replace(/[\/\?<>\\:\*\|"]/g, '')
        .replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .replace(/^[\s.]+|[\s.]+$/g, '');
    base = truncateUtf8(base, MAX_NAME_BYTES).replace(/[\s.]+$/g, '');
    if (!base) base = fallback;
    if (WINDOWS_RESERVED.test(base)) base = '_' + base;
    const e = String(ext ?? '').replace(/^\.+/, '');
    return e ? `${base}.${e}` : base;
}
