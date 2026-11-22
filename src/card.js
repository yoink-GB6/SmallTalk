// 角色卡 / 世界书 / 拖入 JSON 的识别与归一化。
// 对应酒馆：src/endpoints/characters.js 的 readFromV2 / importFromJson / charaFormatData，
// 以及 public/scripts/world-info.js 的 convertCharacterBook / newWorldInfoEntryDefinition。
// 纯函数，不依赖 Node API，浏览器可直接加载。

import { looksLikePersonasFile } from './personas.js';
import { sanitizeRegexScript } from './regex.js';

/** @typedef {import('./types.js').Card} Card */
/** @typedef {import('./types.js').WorldEntry} WorldEntry */

const DEFAULT_DEPTH = 4; // 对应 world-info.js DEFAULT_DEPTH

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 对应 world-info.js newWorldInfoEntryDefinition 的默认值（只取 WorldEntry 里有的字段，外加几个酒馆自带字段原样保留）。
 * @returns {WorldEntry}
 */
export function defaultEntry() {
    return {
        uid: 0, key: [], keysecondary: [], comment: '', content: '',
        constant: false, selective: true, selectiveLogic: 0,
        order: 100, position: 0, depth: DEFAULT_DEPTH, role: 0,
        disable: false, probability: 100, useProbability: true,
        scanDepth: null, caseSensitive: null, matchWholeWords: null,
        excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
        outletName: '', book: '',
    };
}

/**
 * 对应 world-info.js convertCharacterBook（~L5617）。注意：酒馆返回 {entries:{id:entry}}，这里直接给数组（保持输入顺序）。
 * @param {Object} characterBook
 * @returns {WorldEntry[]}
 */
export function convertCharacterBook(characterBook) {
    const book = characterBook ?? {};
    const bookName = str(book.name);
    return arr(book.entries).map((entry, index) => {
        const ext = isObj(entry.extensions) ? entry.extensions : {};
        return {
            ...defaultEntry(),
            // id 缺失时用下标（酒馆会回写 entry.id，这里不改原对象）
            uid: entry.id ?? index,
            key: arr(entry.keys),
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: str(entry.content),
            constant: entry.constant || false,
            selective: entry.selective || false, // 酒馆在这里默认 false，和独立世界书模板的 true 不同
            order: entry.insertion_order ?? 100,
            // extensions.position 优先，否则看 V2 规范里的字符串 position
            position: ext.position ?? (entry.position === 'before_char' ? 0 : 1),
            excludeRecursion: ext.exclude_recursion ?? false,
            preventRecursion: ext.prevent_recursion ?? false,
            delayUntilRecursion: ext.delay_until_recursion ?? false,
            disable: !entry.enabled,
            probability: ext.probability ?? 100,
            useProbability: ext.useProbability ?? true,
            depth: ext.depth ?? DEFAULT_DEPTH,
            selectiveLogic: ext.selectiveLogic ?? 0,
            outletName: ext.outlet_name ?? '',
            scanDepth: ext.scan_depth ?? null,
            caseSensitive: ext.case_sensitive ?? null,
            matchWholeWords: ext.match_whole_words ?? null,
            role: ext.role ?? 0,
            book: bookName,
        };
    });
}

/**
 * 独立世界书文件 {entries:{"0":{...}}} 或 entries 为数组 → 补齐默认值的数组，按 uid 排序。
 * @param {Object} rawJson
 * @param {string} bookName
 * @returns {WorldEntry[]}
 */
export function parseWorldbook(rawJson, bookName) {
    const entries = rawJson?.entries;
    /** @type {[string, any][]} */
    const pairs = Array.isArray(entries)
        ? entries.map((e, i) => [String(i), e])
        : isObj(entries) ? Object.entries(entries) : [];
    const out = pairs.filter(([, e]) => isObj(e)).map(([k, e]) => {
        const merged = { ...defaultEntry(), ...e };
        // 显式 null/undefined 的非空字段回落到默认（scanDepth 等本来就允许 null）
        const d = defaultEntry();
        for (const f of ['key', 'keysecondary', 'comment', 'content', 'order', 'position', 'depth', 'probability', 'selectiveLogic', 'role', 'outletName']) {
            if (merged[f] == null) merged[f] = d[f];
        }
        const n = Number(e.uid ?? k);
        merged.uid = Number.isNaN(n) ? Number(k) || 0 : n;
        merged.book = bookName;
        return /** @type {WorldEntry} */ (merged);
    });
    return out.sort((a, b) => a.uid - b.uid);
}

/**
 * 对应 characters.js readFromV2：V2/V3 取 data.*（优先），V1 取顶层。
 * @param {Object} rawJson
 * @returns {Card}
 */
export function parseCard(rawJson) {
    if (!isObj(rawJson)) throw new Error('角色卡解析失败：输入不是 JSON 对象');
    const data = isObj(rawJson.data) ? rawJson.data : {};
    // data.* 优先，缺了再看顶层镜像（V1 没有 data，全部走顶层）
    const pick = (k) => data[k] ?? rawJson[k];

    const name = str(pick('name')).trim();
    if (!name) throw new Error('角色卡解析失败：没有找到角色名（name）');

    const ext = isObj(data.extensions) ? data.extensions : {};

    let depthPrompt = null;
    const dp = ext.depth_prompt;
    if (isObj(dp) && str(dp.prompt).trim()) {
        const depth = Number(dp.depth);
        depthPrompt = {
            prompt: str(dp.prompt),
            depth: dp.depth == null || Number.isNaN(depth) ? 4 : depth,
            role: dp.role || 'system',
        };
    }

    const book = isObj(data.character_book) ? data.character_book : null;
    const worldEntries = book
        ? convertCharacterBook({ ...book, name: str(book.name) || name }) // 条目的 book 名：书名，缺省用卡名
        : [];
    const worldName = (book && str(book.name)) || str(ext.world) || '';

    // 卡自带的正则先校正字段类型、丢掉没法用的（规则见 regex.js sanitizeRegexScript；和 migrate.js cleanRegexList 同一个函数）
    const regexScripts = arr(ext.regex_scripts).map(sanitizeRegexScript).filter(Boolean)
        .map((s) => ({ ...s, origin: /** @type {'card'} */ ('card') }));

    return {
        name,
        description: str(pick('description')),
        personality: str(pick('personality')),
        scenario: str(pick('scenario')),
        firstMes: str(pick('first_mes')),
        alternateGreetings: arr(data.alternate_greetings),
        mesExample: str(pick('mes_example')),
        systemPrompt: str(data.system_prompt),
        postHistoryInstructions: str(data.post_history_instructions),
        creatorNotes: str(data.creator_notes ?? rawJson.creatorcomment),
        depthPrompt,
        worldName,
        worldEntries,
        regexScripts,
        raw: rawJson,
    };
}

const looksLikeRegex = (o) => isObj(o) && typeof o.findRegex === 'string' && ('scriptName' in o || 'replaceString' in o);

/**
 * 拖进来的 JSON 是什么。
 * @param {Object} rawJson
 * @returns {'card'|'preset'|'worldbook'|'regex'|'personas'|'unknown'}
 */
export function detectJsonKind(rawJson) {
    if (Array.isArray(rawJson)) {
        return rawJson.length > 0 && rawJson.every(looksLikeRegex) ? 'regex' : 'unknown';
    }
    if (!isObj(rawJson)) return 'unknown';
    if (looksLikeRegex(rawJson)) return 'regex';
    if (rawJson.spec && isObj(rawJson.data)) return 'card';
    if (Array.isArray(rawJson.prompts) && rawJson.prompt_order) return 'preset';
    // 酒馆「人设管理 → 备份」：顶层只有 personas / persona_descriptions / default_persona，不会和上面几种撞；
    // 放在带 name 的角色卡判断之前，免得哪天备份里多出 name 字段被当成卡
    if (looksLikePersonasFile(rawJson)) return 'personas';
    if (rawJson.name && ('first_mes' in rawJson || 'description' in rawJson || 'char_persona' in rawJson)) return 'card';
    if ((Array.isArray(rawJson.entries) || isObj(rawJson.entries)) && !rawJson.prompts && !rawJson.spec) return 'worldbook';
    return 'unknown';
}
