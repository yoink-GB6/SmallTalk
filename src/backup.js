// 「全部数据」的备份文件：导出时把存储里的记录打包成一个 JSON，导入时算出要新增哪些记录。
// 纯函数，不碰 DOM / IndexedDB，Node 里可测。读存储、落盘、界面在 src/ui/backup.js。
// 文件形状见 types.js「备份文件」。
//
// 导入只做「合并」：只新增，不修改、不删除任何已有的卡 / 存档 / 预设，
// 以及全局记录里的内容（人设、额外世界书、全局正则、便签、全局变量；见下面「全局记录的三类字段」「内容取并集」两节）。
// 真正的「设置」只有三样（外置记忆设置、上下文上限、世界书扫描设置），用户在弹框里答「是」才用备份里的；
// 「当前在用的选择」（当前预设、人设、接口和模型、手动模式……）永远不从备份拿，导出时也不写进备份。
// 每条新增的记录都换一个新 id（我们生成的），所以和已有数据、和另一台机器上的同名 id 都不会撞。
// 重复导入同一个文件要幂等：内容相同的东西认出来就跳过（判定规则见下面的 cardSig / chatSig / presetSig）。

//
// 「整体备份」（手机 Settings）：导出就是全部，没有勾选。备份里带 API key（只有网页版能带）时整个文件必须加密，
// 加密在 src/backup-crypto.js；这里只负责「明文的备份对象」以及识别「这是一个加密的备份」。

import { normalizeCard, makeUniqueNamer, buildIndex, indexEntry, isLegacyGlobal, isPristineGlobal, NON_GLOBAL_KEYS, UNSAFE_KEYS, cleanBooks, cleanRegexList, cleanPresetBody } from './migrate.js';
import { sanitizePreset, isSensitivePresetField, sensitiveCategories } from './preset-sanitize.js';
import { normalizeBaseUrl, cleanModels, plain, LIMITS, MAX_ENDPOINTS, isBuiltinId, CLI_TYPES } from './openai-shared.js';

/** 内置的命令行类接口（claude-code、codex）：按 id 或类型认，规则在 openai-shared.js，和服务端、llm-direct.js、model-picker.js 同一份 */
const isBuiltinEp = e => isObj(e) && (isBuiltinId(e.id) || CLI_TYPES.includes(e.type));
import { isEncryptedBackup, encryptedHeaderProblem } from './backup-crypto.js';
import { normalizeNotes, mergeNotes } from './notes.js';
import { alignPersonas, mergePersonas, switchPersona } from './personas.js';
import { bookContent, bookScopeOf, remapBookCards, setBookScope, setBookName, isBookActiveFor } from './books.js';
import { storedAuthorNote } from './author-note.js';
import { storedHighlights, mergeHighlights, chatDoc } from './highlight.js';
import { cardScripts } from './scripts.js';
import { CARDVARS_PREFIX, normalizeCardVars, unionCardVars } from './cardvars.js';
import { isPhoneBackupKey, phoneForBackup, countPhone, phoneSummaryBits, phoneAdded } from './phone-backup.js';
import { personaSig } from './personas.js';

export const BACKUP_FORMAT = 'smalltalk-backup';
export const BACKUP_VERSION = 1;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 键排好序的 JSON：同样的内容，不管对象里键的先后顺序如何，结果都一样。
 * 用来判断「内容相同」——记录经过结构化克隆、导出再导入后键顺序可能变，不能因此认成不同的东西。
 */
export function canonical(v) {
    return JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
}

// ───────────────────────────── 「内容相同」的判定 ─────────────────────────────
//
// 卡：只比「卡本体（Card，先用 normalizeCard 补齐缺的字段）+ 头像」。
//     不比 id、createdAt、usedAt、activeChatId——这些是「这张卡在这个浏览器里的元数据」，
//     导出再导入、或者在两边各自用过之后都会不一样，但卡还是那张卡。
//     卡被改过（比如在正则页切了一个开关）就是不同的卡：宁可多出一张，也不把存档并到内容不一样的卡下面。
// 存档：只比「名字 + 消息（含每条消息上的记忆摘要、swipes、st 等全部字段）+ 局部变量 + 作者注释（有的话）」。
//     不比 id、cardId、createdAt、updatedAt、greeting、stHeader、划线（highlights：相同的存档之间划线取并集，见 chatSig）。
//     同一个存档在一边接着聊了几句，消息就不同了，会作为另一个存档导入（旧的不动），不会覆盖。
// 预设：只比预设本体，并且是「一字不差」（JSON.stringify 原样比较，和 migrate.js planPresetMigration 一致）。
//     名字不算内容：内容一样、名字不一样也算重复。名字一样、内容不一样的，新的名字后面加序号。

// 卡自带世界书的整本开关（Card.worldDisabled）不算内容：它是「这张卡在这个浏览器里怎么用」，和正则的 disabled 一样。
// 只差这个开关的两张卡是同一张卡——备份里的卡并进本机那张，本机的开关不动（酒馆 zip 导入同理，见 tavern-convert.js applyWorldRules）
// 酒馆助手脚本（Card.scripts）算内容，开关（enabled）也算——它写在卡文件里、导出时带走，和卡自带正则的 disabled 一样。
// 按「现在的树」比（scripts.js cardScripts：没有 card.scripts 时从 raw 解析），所以「没改过、跟着 raw」和「写了但一样」是同一张卡。
// 没有脚本的卡不加这个键：签名和加脚本功能之前逐字相同
const cardContent = card => {
    const { worldDisabled: _w, scripts: _s, ...rest } = normalizeCard(card);
    const scripts = cardScripts({ ...rest, ...(_s !== undefined ? { scripts: _s } : {}) });
    return scripts.length ? { ...rest, scripts } : rest;
};
export const cardSig = rec => canonical([cardContent(rec?.card), typeof rec?.avatar === 'string' ? rec.avatar : '']);
// 作者注释（ChatRecord.authorNote）算存档的内容：规范化后不是默认值时追加在最后。没有 / 坏到全是默认值的存档（包括作者注释出现之前的所有备份）
// 签名和以前【逐字相同】，判重结果不变。只差作者注释的两个存档是两个存档（宁可多一个，也不丢掉一份注释）
// 划线（ChatRecord.highlights）【不算】判重的内容（用户 2026-11-28 定的）：只差划线的两个存档是同一个存档，
// 恢复时不新增存档，而是把备份里的划线并进本机那个（planBackupImport 的 highlightMerges、highlight.js mergeHighlights）。
// 所以签名和划线功能出现之前逐字相同。（2026-11-28 第一版曾把划线追加进签名，结果「本机没划线、备份划过线」会多出一个几乎一样的存档。）
export const chatSig = rec => {
    const base = [rec?.name ?? '', rec?.messages ?? [], isObj(rec?.variables) ? rec.variables : {}];
    const note = storedAuthorNote(rec?.authorNote);
    return canonical(note ? [...base, note] : base);
};
export const presetSig = rec => JSON.stringify(rec?.preset);

// ───────────────────────────── 导出 ─────────────────────────────

/**
 * 文件名（本地时间）：
 *   含 API key（一定是加密的）：smalltalk-备份-含APIkey-谨慎传播-20261122-1530.json
 *   不含 key、设了密码：        smalltalk-备份-已加密-20261122-1530.json
 *   不含 key、没设密码（明文）：smalltalk-备份-20261122-1530.json
 * 警示词放在文件名里，是因为文件名是用户转发、上传网盘时唯一一定会看到的东西。
 * @param {Date} date
 * @param {{hasKeys?: boolean, encrypted?: boolean}} [opts]
 */
export function backupFileName(date, { hasKeys = false, encrypted = false } = {}) {
    const p = n => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
    const tag = hasKeys ? '-含APIkey-谨慎传播' : encrypted ? '-已加密' : '';
    return `smalltalk-备份${tag}-${stamp}.json`;
}

/**
 * 把存储里读出来的「键 → 值」整理成备份对象。不导出 meta、index:*（都能重建）和旧版本的 state / state.v1.bak。
 * 记录原样搬运（不认识的字段也带上），只按键名归类；只有 global 去掉「当前在用的选择」（globalForBackup）。
 * 手机的数据（'phone'、'phonechat:*'、'phoneimg:*'）拼成顶层的 phone 字段（phone-backup.js phoneForBackup）；没用过手机 = 没有这个字段，备份和以前逐字相同。
 * @param {Record<string, any>} entries  键 → 存储里的值
 * @param {{now: Date, stickers?: boolean}} deps   stickers：带不带表情包（导出框里的勾，默认带）
 * @returns {{backup: Object, orphanChats: number, legacyKeys: string[]}}
 *          orphanChats：找不到所属卡的存档数（界面上本来就看不见，没导出）；legacyKeys：没导出的旧版本数据的键
 */
export function buildBackup(entries, { now, stickers = true }) {
    const cards = [], presets = [], chatsByCard = new Map(), legacyKeys = [], varsByCard = new Map(), phoneEntries = {};
    let orphanChats = 0;
    for (const [key, value] of Object.entries(entries)) {
        if (isPhoneBackupKey(key)) {
            phoneEntries[key] = value;
        } else if (key.startsWith(CARDVARS_PREFIX)) {
            // 卡的运行时数据（脚本变量、角色卡变量）：挂在那张卡的那一项上（vars）。规范化后是空的不带；卡不在了的丢掉
            const v = normalizeCardVars(value);
            if (v) varsByCard.set(key.slice(CARDVARS_PREFIX.length), v);
        } else if (key.startsWith('card:')) {
            // 键和记录里的 id 对不上的不要：archive.js 按 id 去拼键，这种记录在界面上本来就找不到
            if (isObj(value) && `card:${value.id}` === key) cards.push(value);
        } else if (key.startsWith('preset:')) {
            // 预设里酒馆的连接信息（反代密码等）在这里再去一遍：入口都清洗过，但存储里可能还留着以前导入的（规则见 preset-sanitize.js）。
            // 不改存储里的记录，只是写进备份的那一份不带
            if (isObj(value) && `preset:${value.id}` === key && isObj(value.preset)) presets.push(withoutSensitive(value));
        } else if (key.startsWith('chat:')) {
            if (!isObj(value)) continue;
            // 'chat:<卡id>:<存档id>'：卡 id 从键里取（archive.js 也是按键前缀找一张卡的存档）
            const cardId = key.slice(5, key.length - String(value.id).length - 1);
            if (`chat:${cardId}:${value.id}` !== key) continue;
            if (!chatsByCard.has(cardId)) chatsByCard.set(cardId, []);
            chatsByCard.get(cardId).push(value);
        } else if (key === 'state' || key.startsWith('state.v1.bak')) {
            legacyKeys.push(key);
        }
    }
    const cardIds = new Set(cards.map(c => c.id));
    for (const [cardId, list] of chatsByCard) if (!cardIds.has(cardId)) orphanChats += list.length;
    const byTime = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    const phone = phoneForBackup(phoneEntries, { stickers });
    return {
        backup: {
            format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(),
            // 去掉「当前在用的选择」（当前预设、人设、接口和模型……；规则见下面「全局记录的三类字段」）
            global: globalForBackup(entries.global),
            presets: presets.sort(byTime),
            cards: cards.sort(byTime).map(card => ({ card, chats: (chatsByCard.get(card.id) ?? []).sort(byTime), ...(varsByCard.has(card.id) ? { vars: varsByCard.get(card.id) } : {}) })),
            ...(phone ? { phone } : {}),
        },
        orphanChats, legacyKeys,
    };
}

/** 预设记录 → 去掉预设本体里敏感字段的副本（没有要去的就原样返回同一个对象） */
function withoutSensitive(rec) {
    const s = sanitizePreset(rec.preset);
    return s.removed.length ? { ...rec, preset: s.preset } : rec;
}

/**
 * 一份备份里有多少东西（导出对话框的小计、恢复时的提示用）。
 * keys：其中带 API key 的接口个数（只数，不碰 key 的内容）。
 */
export function countBackup(b) {
    const eps = Array.isArray(b.endpoints) ? b.endpoints : [];
    return { cards: b.cards.length, chats: b.cards.reduce((n, c) => n + (Array.isArray(c.chats) ? c.chats.length : 0), 0), presets: (b.presets ?? []).length, global: !!b.global,
        endpoints: eps.length, keys: eps.filter(e => typeof e?.apiKey === 'string' && e.apiKey !== '').length, phone: countPhone(b.phone) };
}

/**
 * 「空的浏览器」（= 换新设备）：恢复时直接全部恢复，包括全局设置，不问。纯函数，调用方把现读的事实传进来。
 *   - 没有任何卡（存储里没有 card:*，内存里也没有还没落盘的占位卡）
 *   - 没有任何保存的预设（preset:*）
 *   - 全局设置是出厂默认（migrate.js 的 isPristineGlobal：「选了哪个模型」、还是默认值的上下文上限都不算用户内容）
 *   - 网页版（direct）下还要没有任何用户自己加的接口：那边的接口和 key 存在这个浏览器里，算「已有数据」。
 *     本地服务版的接口在服务端配置文件里，是这台电脑上所有浏览器共用的，不说明这个浏览器里有没有数据，不看。
 *   - 没有手机的数据（phone：phone-backup.js hasPhoneData——会话、图片，或 'phone' 记录里有聊天预设 / 表情 / 壁纸；只选了模型不算）。
 *     只有手机数据的浏览器不能当成空的：空浏览器的恢复不问就用备份里的设置（含壁纸）
 * @param {{cardKeys: number, presetKeys: number, liveCard: boolean, global: any, direct: boolean, userEndpoints: number, phone?: boolean}} f
 */
export function isEmptyForRestore({ cardKeys, presetKeys, liveCard, global, direct, userEndpoints, phone = false }) {
    // 「出厂默认」的规则只有 migrate.js isPristineGlobal 一份（接管旧版本页面遗留数据时也用它），这里不另写
    return cardKeys === 0 && presetKeys === 0 && !liveCard && isPristineGlobal(global) && (!direct || userEndpoints === 0) && !phone;
}

// ───────────────────────────── 下载前的自检 ─────────────────────────────
//
// 导出的最后一道闸（src/ui/backup.js 在 download 之前调用）。以【结构】为主，不靠「在文本里搜 key」：
//   - 设了密码：要下载的文本解析出来必须是加密容器，顶层只有已知的头部字段和 data，头部本身合法，hasKeys 和实际相符。
//     key 只可能在 data（密文）里——那里是 base64，看不出任何内容，所以不在密文里搜。
//   - 没设密码：这份备份必须不含 key（hasKeys 为假），而且解析出来的对象里任何一层都没有名为 apiKey 的键。
// 字符串搜索只是附加检查，并且只搜「非密文部分」（加密文件的头部、明文文件的全文），原样和 JSON 转义后的形式都搜：
// 含 " \ 或控制字符的 key 在 JSON 文本里是转义过的，直接搜原样搜不到。
// 短于 MIN_SEARCH_KEY 的 key 不参与搜索：太短没有区分度（3、4 个字符在几十 KB 的文本里几乎必然碰巧出现），
// 搜了只会误拦、让导出永远失败；这种 key 的安全靠上面的结构断言保证。

const ENC_TOP_KEYS = ['format', 'version', 'exportedAt', 'hasKeys', 'kdf', 'cipher', 'data'];
const ENC_KDF_KEYS = ['name', 'hash', 'iterations', 'salt'];
const ENC_CIPHER_KEYS = ['name', 'iv'];
const MIN_SEARCH_KEY = 8;
const onlyKeys = (o, allowed) => isObj(o) && Object.keys(o).every(k => allowed.includes(k));

/** 任何一层有没有名为 apiKey 的自有键（用显式的栈，不递归：再深的嵌套也不会爆栈） */
function hasApiKeyField(root) {
    const stack = [root];
    while (stack.length) {
        const v = stack.pop();
        if (v === null || typeof v !== 'object') continue;
        if (!Array.isArray(v) && Object.hasOwn(v, 'apiKey')) return true;
        for (const x of Object.values(v)) if (x !== null && typeof x === 'object') stack.push(x);
    }
    return false;
}

/**
 * 自检拦下「apikey-field」之后，给提示文字用：第一个名为 apiKey 的字段在备份的哪一类内容里。
 * 只返回给人看的类别名（「全局变量」「世界书」……），不返回字段的值；判定逻辑仍是上面的 hasApiKeyField，这里只负责说清楚在哪。
 * 为什么需要它：备份里的内容（全局变量、世界书条目、卡的扩展字段……）是用户 / 导入的卡写的，里面完全可能有一个字段恰好叫 apiKey。
 * 这不是程序把 key 漏进了明文，所以提示不该说「这是程序的问题」，而该告诉用户是哪一类内容、怎么办。
 * @returns {string|null}  null = 没找到（不该发生：只在自检已经拦下 apikey-field 时调用）
 */
export function apiKeyFieldPlace(root) {
    const stack = [[root, []]];
    while (stack.length) {
        const [v, path] = stack.pop();
        if (v === null || typeof v !== 'object') continue;
        if (!Array.isArray(v) && Object.hasOwn(v, 'apiKey')) return placeLabel(path);
        for (const [k, x] of Object.entries(v)) if (x !== null && typeof x === 'object') stack.push([x, [...path, k]]);
    }
    return null;
}

/** 路径（键名列表）→ 类别名 */
function placeLabel(path) {
    const [top, a, b, c] = path;
    if (top === 'global') {
        const label = { globalVariables: '全局变量', books: '额外世界书', globalRegex: '全局正则', notes: '便签', persona: '人设', personas: '人设',
            memory: '外置记忆设置', wi: '世界书扫描设置', contextLimit: '上下文上限' }[a];
        return label ?? '全局设置';
    }
    if (top === 'cards') return b === 'chats' ? '某个存档（消息或局部变量）' : (b === 'card' && c === 'card' ? '某张角色卡' : '某张角色卡的记录');
    if (top === 'presets') return '某个预设';
    if (top === 'endpoints') return '接口列表';
    return '备份文件';
}

/**
 * 备份对象里第一个带着敏感字段（酒馆的连接信息，清单见 preset-sanitize.js）的预设：{name, categories}；没有返回 null。
 * 只看预设本体的顶层：presets[].preset，以及旧形状 global 里的 global.preset。只返回名字和类别，不返回字段的值。
 * 自检拦下 'preset-sensitive' 之后，界面用它说清楚是哪个预设、哪一类东西。
 */
export function presetSensitivePlace(backup) {
    if (!isObj(backup)) return null;
    const bodies = [...(Array.isArray(backup.presets) ? backup.presets : []).map(p => [p?.name, p?.preset]),
        ...(isObj(backup.global) && isObj(backup.global.preset) ? [[backup.global.presetName, backup.global.preset]] : [])];
    for (const [name, body] of bodies) {
        if (!isObj(body)) continue;
        const names = Object.keys(body).filter(isSensitivePresetField);
        if (names.length) return { name: typeof name === 'string' && name ? name : '（没有名字的预设）', categories: sensitiveCategories(names) };
    }
    return null;
}

/**
 * 下载前自检。纯函数。
 * @param {string} out  要下载的文本
 * @param {{encrypted: boolean, hasKeys: boolean, secrets?: string[], plain?: Object}} o
 *        encrypted：设了密码（out 应该是加密容器）；hasKeys：这份备份里有没有 key；secrets：备份里所有 key（只用来搜，不进返回值）；
 *        plain：加密之前的备份对象（可选）。加密的文件看不到里面，预设的检查（见下）就拿它做
 * @returns {string|null}  null = 通过；否则是一个【不含 key 内容】的原因代号（给控制台和测试用，界面上统一显示一句固定的话）
 *
 * 第四类（后加的）'preset-sensitive'：任何预设本体（presets[].preset、旧形状的 global.preset）的顶层出现了酒馆的连接信息字段
 * （反代地址 / 密码、附加请求头……，清单见 preset-sanitize.js），只看字段名、不看值。buildBackup 已经去掉了它们，这里是最后一道闸：
 * 万一哪条路漏了，宁可不下载。明文的检查下载的文本本身；加密的检查 plain（密文里看不见）。前三类的判定一点没改，先查它们。
 */
export function exportSelfCheck(out, { encrypted, hasKeys, secrets = [], plain = null }) {
    let data;
    try { data = JSON.parse(out); } catch { return 'not-json'; }
    if (!isObj(data)) return 'not-object';
    let visible;   // 非密文部分：只在这里搜 key
    if (encrypted) {
        if (!isEncryptedBackup(data) || encryptedHeaderProblem(data)) return 'bad-container';
        if (!onlyKeys(data, ENC_TOP_KEYS) || !onlyKeys(data.kdf, ENC_KDF_KEYS) || !onlyKeys(data.cipher, ENC_CIPHER_KEYS)) return 'unknown-field';
        if (data.hasKeys !== hasKeys) return 'haskeys-mismatch';
        const { data: _ct, ...head } = data;
        visible = JSON.stringify(head);
    } else {
        if (hasKeys) return 'plain-with-keys';
        if (data.format !== BACKUP_FORMAT) return 'not-backup';
        if (hasApiKeyField(data)) return 'apikey-field';
        visible = out;
    }
    for (const k of secrets) {
        if (typeof k !== 'string' || k.length < MIN_SEARCH_KEY) continue;
        if (visible.includes(k) || visible.includes(JSON.stringify(k).slice(1, -1))) return 'key-in-text';
    }
    if (presetSensitivePlace(encrypted ? plain : data)) return 'preset-sensitive';
    return null;
}

// ───────────────────────────── 读文件 / 校验 ─────────────────────────────

/**
 * 解析并校验备份文件的整体形状。只看「这是不是一个我们认识的备份」，单条记录坏了不在这里拒绝（planBackupImport 会跳过它）。
 *
 * 加密的备份（format: 'smalltalk-backup-encrypted'）：头部检查通过 → 返回 {ok: false, encrypted: true, file}，
 * 由调用方问密码、解密（backup-crypto.js），再把解出来的明文用 {fromEncrypted: true} 交回这里。头部不对 → 普通的拒绝。
 *
 * 接口项里的 apiKey：【只有从加密容器里解出来的备份才保留】。明文文件里出现 apiKey——我们自己永远不会写出这样的文件，
 * 多半是别人手改 / 别的工具生成的——一律丢掉，并在 notes 里说一句（不说 key 的内容）。
 *
 * @param {string} text
 * @param {{fromEncrypted?: boolean}} [opts]
 * @returns {{ok: true, backup: Object, notes: string[]} | {ok: false, encrypted: true, file: Object} | {ok: false, error: string}}
 *          error / notes 是给人看的中文
 */
export function parseBackup(text, { fromEncrypted = false } = {}) {
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: '这个文件不是 JSON，不像 SmallTalk 的备份文件' }; }
    if (!isObj(data)) return { ok: false, error: '文件内容不是一个对象，不像 SmallTalk 的备份文件' };
    if (isEncryptedBackup(data)) {
        // 加密容器里不该再套一层加密容器（我们不会这样写）
        if (fromEncrypted) return { ok: false, error: '解密出来的内容不是 SmallTalk 的备份，文件可能损坏了' };
        const why = encryptedHeaderProblem(data);
        return why ? { ok: false, error: why } : { ok: false, encrypted: true, file: data };
    }
    if (data.format !== BACKUP_FORMAT) return { ok: false, error: '这个 JSON 不是 SmallTalk 的备份文件（缺少 format: "smalltalk-backup"）。角色卡、预设、世界书请用各自的导入按钮' };
    // 嵌套极深的数据（手改 / 损坏的文件，比如两万层的数组）：后面的去重比较、结构化拷贝、写进 IndexedDB 都是递归的，会爆栈抛 RangeError。
    // 整份拒绝、什么都不写，并且说人话（以前提示里是 Maximum call stack size exceeded）
    if (tooDeep(data, MAX_DEPTH)) return { ok: false, error: `备份里有嵌套得极深（超过 ${MAX_DEPTH} 层）的数据，文件可能损坏了或被改过，没法处理` };
    if (!Number.isInteger(data.version) || data.version < 1) return { ok: false, error: '备份文件的版本号不对，文件可能损坏了' };
    if (data.version > BACKUP_VERSION) return { ok: false, error: `这个备份是更新版本的 SmallTalk 导出的（备份版本 ${data.version}），这个版本只认识 ${BACKUP_VERSION}。为了不写坏数据，没有导入` };
    if (!Array.isArray(data.cards)) return { ok: false, error: '备份文件的形状不对（cards 不是数组），文件可能损坏了' };
    if (data.presets !== undefined && !Array.isArray(data.presets)) return { ok: false, error: '备份文件的形状不对（presets 不是数组），文件可能损坏了' };
    if (data.global !== undefined && data.global !== null && !isObj(data.global)) return { ok: false, error: '备份文件的形状不对（global 不是对象），文件可能损坏了' };
    // endpoints 是可选字段（老版本导出的文件没有它；老版本读到它会直接忽略）。形状不对【不拒绝整个文件】：
    // 接口列表只是附带的方便，不该因为它坏了就连卡和存档都导不进去。不是数组 → 当作没有；数组里坏的项丢掉；
    // 好的项只取 name / baseUrl / models（加密来源再加 apiKey）重新造一个对象。
    const notes = [];
    if (data.endpoints !== undefined) {
        const dropped = !fromEncrypted && Array.isArray(data.endpoints) && data.endpoints.some(e => isObj(e) && 'apiKey' in e);
        const list = cleanBackupEndpoints(data.endpoints, { allowKeys: fromEncrypted });
        if (list.length) data.endpoints = list; else delete data.endpoints;
        if (dropped) notes.push('这个备份文件没有加密，却在接口里写着 API key（SmallTalk 自己不会导出这样的文件），为了安全没有使用这些 key');
    }
    // refEndpoints：以前的版本导出时记下「聊天 / 记忆用的模型指向哪个接口地址」，恢复到空浏览器时据此自动指回去。
    // 现在接口和模型属于「当前在用的选择」，不从备份拿（也不再自动选模型），所以旧文件里的这个字段直接丢掉
    delete data.refEndpoints;
    return { ok: true, backup: data, notes };
}

/**
 * 嵌套深度的上限。正常的数据远远到不了：角色卡、聊天消息、预设都在二三十层以内（备份对象自己再套五六层）。
 * 而 JSON.stringify（带 replacer 的 canonical 更早）、structuredClone 在几千层时就会爆栈。
 */
export const MAX_DEPTH = 1000;

/**
 * v 的嵌套层数是否超过 limit（对象和数组各算一层）。用显式的栈，不递归：再深也不会爆栈，碰到第一个超深的就停。
 * 浏览器和 Node 里都能跑（tavern-convert.js 逐个检查转换出来的卡 / 聊天 / 世界书 / 预设也用它）。
 */
export function tooDeep(v, limit = MAX_DEPTH) {
    const stack = [[v, 0]];
    while (stack.length) {
        const [x, d] = stack.pop();
        if (x === null || typeof x !== 'object') continue;
        if (d >= limit) return true;
        for (const y of Array.isArray(x) ? x : Object.values(x)) if (y !== null && typeof y === 'object') stack.push([y, d + 1]);
    }
    return false;
}

/** 一条存档能不能导入：messages 必须是数组、每条消息是对象；variables 有的话必须是对象 */
function chatProblem(c) {
    if (!isObj(c)) return '不是对象';
    if (!Array.isArray(c.messages)) return '缺少 messages 数组';
    if (c.messages.some(m => !isObj(m))) return '有消息不是对象';
    if (c.variables !== undefined && !isObj(c.variables)) return 'variables 不是对象';
    if (c.name !== undefined && typeof c.name !== 'string') return '名字不是文字';
    return null;
}

/** 一条卡能不能导入：要有卡本体（对象），头像有的话必须是字符串 */
function cardProblem(entry) {
    if (!isObj(entry) || !isObj(entry.card)) return '不是对象';
    if (!isObj(entry.card.card)) return '缺少卡本体';
    if (entry.card.avatar !== undefined && typeof entry.card.avatar !== 'string') return '头像格式不对';
    if (entry.chats !== undefined && !Array.isArray(entry.chats)) return 'chats 不是数组';
    return null;
}

const nameOf = (v, fallback) => (typeof v === 'string' && v ? v : fallback);

// ───────────────────────────── 接口列表 ─────────────────────────────
//
// 备份对象里的 endpoints: [{name, baseUrl, models, apiKey?}]，方便换设备时不用重新抄接口地址、模型名，网页版还能带上 key。
// 没有 id（导入时由本机生成）、没有 hasKey / ready。
// apiKey 的来龙去脉（全流程见 src/ui/backup.js 文件头）：
//   - 导出：llm.js exportEndpointsForBackup() 是 key 离开接口层的唯一通道；网页版给 apiKey（没填的是 ''），本地服务版根本没有这个字段。
//   - 这里的清洗函数在 allowKeys 为真时才保留 apiKey（空串当作没有）；导出时和「从加密容器解出来的备份」才为真。
//   - 备份对象里只要有一个非空 apiKey，界面就强制加密整个文件（含 key 的明文永远不落到文件里）。

/** 一条接口能不能进备份 / 能不能导入：返回规范化后的 {name, baseUrl, models, apiKey?}，不行返回 null */
function cleanOneEndpoint(e, allowKeys) {
    if (!isObj(e) || typeof e.baseUrl !== 'string') return null;
    let baseUrl;
    try { baseUrl = normalizeBaseUrl(e.baseUrl.slice(0, LIMITS.baseUrl + 1)); } catch { return null; }
    if (!baseUrl || baseUrl.length > LIMITS.baseUrl) return null;
    const name = (typeof e.name === 'string' ? plain(e.name) : '').slice(0, LIMITS.name) || baseUrl.slice(0, LIMITS.name);
    const out = { name, baseUrl, models: cleanModels(e.models) };
    // key 只做和 newEndpoint 一样的 trim；超长的丢掉（写进接口层时也会被拒）
    if (allowKeys && typeof e.apiKey === 'string') {
        const k = e.apiKey.trim();
        if (k && k.length <= LIMITS.apiKey) out.apiKey = k;
    }
    return out;
}

/**
 * endpoints → 干净的列表（不是数组 → []；坏项丢掉；同一个地址只留第一条；最多 MAX_ENDPOINTS 条）。
 * @param {any} raw
 * @param {{allowKeys?: boolean}} [opts]  allowKeys：保留 apiKey（默认不保留）
 */
export function cleanBackupEndpoints(raw, { allowKeys = false } = {}) {
    if (!Array.isArray(raw)) return [];
    const out = [], seen = new Set();
    for (const e of raw) {
        const c = cleanOneEndpoint(e, allowKeys);
        if (!c || seen.has(c.baseUrl)) continue;
        seen.add(c.baseUrl);
        out.push(c);
        if (out.length >= MAX_ENDPOINTS) break;
    }
    return out;
}

/**
 * 导出：exportEndpointsForBackup() 的结果 → 写进备份的列表。内置的命令行类接口（Claude Code、Codex）本来就不在里面（它们没有地址）；
 * 这里再过一遍清洗（地址规范化、去重），apiKey 照带（网页版有，本地服务版没有）。
 * @param {Object[]} list  [{name, baseUrl, models, apiKey?}]
 */
export function endpointsForExport(list) {
    if (!Array.isArray(list)) return [];
    return cleanBackupEndpoints(list.filter(e => isObj(e) && !isBuiltinEp(e)), { allowKeys: true });
}

/**
 * 导入：备份里的接口各怎么处理。纯函数，不改输入。按【规范化后的 baseUrl】和本机比：
 *   - 本机没有同地址的 → create：新建，带上备份里的 key（如果有），再写回模型名单。
 *   - 本机有同地址的 → 名字和模型名单不动（那是用户自己的东西）；key：
 *       本机已有 key → 保留本机的（skipped）；本机没填 key 而备份里有 → fill：用备份里的补上。
 *       本机有好几个同地址的接口：每个没 key 的都补；全都有 key 才算跳过。
 * 「同地址」= 规范化后的字符串【完全相等】。宁可漏认（多建一个），不可错认（把 key 补到别处去）：
 *   同主机不同路径、大小写不同、写没写 :443 都不算同地址。不要放宽成按主机名比较。
 * 新建的接口和本机已有接口（含内置的 Claude Code / Codex）【重名】时，名字后加「（来自备份）」：
 *   一个手改 / 恶意的备份可以建一个和你已有接口同名、地址却指向别处的接口，同名会让人在选择器里认错。
 * @param {Object[]} items     备份里的 endpoints（parseBackup 已清洗；这里再清洗一遍，保留 apiKey——是否允许带 key 已经在 parseBackup 决定过）
 * @param {Object[]} existing  本机现有的 PublicEndpoint[]（只有 hasKey，没有 key）
 * @returns {{create: {name: string, baseUrl: string, models: string[], apiKey?: string, renamed?: true}[],
 *            fill: {id: string, name: string, apiKey: string}[], skipped: number, renamed: number}}
 *          renamed：create 里因为重名改了名字的个数
 */
export function planEndpointImport(items, existing) {
    const byUrl = new Map();   // 规范化地址 → 本机的接口们
    const taken = new Set();   // 本机已有的名字（加上这次新建时已经用掉的）
    for (const e of Array.isArray(existing) ? existing : []) {
        if (isObj(e) && typeof e.name === 'string') taken.add(e.name);
    }
    for (const e of Array.isArray(existing) ? existing : []) {
        if (!isObj(e) || isBuiltinEp(e) || typeof e.baseUrl !== 'string' || !e.baseUrl) continue;
        let u;
        try { u = normalizeBaseUrl(e.baseUrl); } catch { continue; /* 本机的坏地址不参与比较 */ }
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(e);
    }
    const create = [], fill = []; let skipped = 0, renamed = 0;
    for (const c of cleanBackupEndpoints(items, { allowKeys: true })) {
        const mine = byUrl.get(c.baseUrl);
        if (!mine) {
            const name = backupEndpointName(c.name, taken);
            taken.add(name);
            if (name === c.name) create.push(c);
            else { renamed++; create.push({ ...c, name, renamed: true }); }   // renamed：只给界面数「改了名的里有几个建成功了」
            continue;
        }
        const empty = c.apiKey ? mine.filter(e => !e.hasKey) : [];
        if (empty.length) for (const e of empty) fill.push({ id: e.id, name: e.name, apiKey: c.apiKey });
        else skipped++;
    }
    return { create, fill, skipped, renamed };
}

const FROM_BACKUP = '（来自备份）';

/** 新建接口的名字：没撞就原样；撞了加「（来自备份）」，还撞再加序号。整体不超过名字的长度上限 */
function backupEndpointName(name, taken) {
    if (!taken.has(name)) return name;
    for (let i = 1; ; i++) {
        const tail = i === 1 ? FROM_BACKUP : `${FROM_BACKUP} ${i}`;
        const n = name.slice(0, LIMITS.name - tail.length) + tail;
        if (!taken.has(n)) return n;
    }
}

/**
 * 给人看的主机名（恢复结果里逐个列出新建的接口指向哪里）。用 URL 的 host：国际化域名是 punycode（xn--…）形式，
 * 不会被转成 Unicode 显示，所以长得像的字（比如西里尔字母的 а 冒充拉丁字母 a）骗不了人。带端口时端口也在。
 */
export function endpointHost(baseUrl) {
    try { return new URL(baseUrl).host; } catch { return '（地址无法解析）'; }
}

/**
 * 接口恢复结果的一句话（给提示条用）。从不包含 key 本身。
 * @param {{added?: number, addedNoKey?: number, filled?: number, skipped?: number, failed?: number, modelsFailed?: number,
 *          hosts?: {host: string, hasKey: boolean}[], renamed?: number}} r
 *        added：新建了几个（含 addedNoKey：其中没带 key、要用户自己填的）；filled：给本机已有的同地址接口补了 key 的个数；
 *        hosts：新建成功的接口各指向哪个主机（endpointHost 的结果）、带没带 key；renamed：其中因为重名改了名字的个数
 */
export function endpointSummaryText({ added = 0, addedNoKey = 0, filled = 0, skipped = 0, failed = 0, modelsFailed = 0, hosts = [], renamed = 0 }) {
    const bits = [`接口：新建了 ${added} 个${addedNoKey ? `（其中 ${addedNoKey} 个没有 key，需要到手机 Settings 的「接口」页填 API key）` : ''}`];
    // 逐个列出新建的接口指向哪里：恢复的是别人给的文件时，用户能一眼看出 key 会被发到哪个服务器
    if (hosts.length) bits.push(`新建的接口指向：${hosts.map(x => `${x.host}${x.hasKey ? '（带 key）' : ''}`).join('、')}`);
    if (renamed) bits.push(`${renamed} 个和本机已有的接口重名，名字后面加了「${FROM_BACKUP}」`);
    if (filled) bits.push(`给 ${filled} 个本机已有的接口补上了 key`);
    if (skipped) bits.push(`${skipped} 个本机已有相同地址，跳过（本机的名字、模型名单和 key 都没动）`);
    if (failed) bits.push(`${failed} 个失败`);
    if (modelsFailed) bits.push(`${modelsFailed} 个接口的模型名单没能写入，可以到手机 Settings 的「接口」页重新获取`);
    return bits.join('，');
}

// ───────────────────────────── 全局记录的三类字段 ─────────────────────────────
//
// 全局记录（GlobalRecord）里的字段分三类（逐个字段的登记在 src/data-inventory.js）：
//
//   内容（kind 'content'）：人设、额外世界书、全局正则、便签、全局变量——用户自己写 / 攒的，丢了找不回来。
//     恢复到已有数据的浏览器：永远取并集（见下面「内容取并集」一节），弹框怎么答都一样。
//
//   设置（kind 'setting'）：只有三样——外置记忆的设置（开没开、保留几条原文、摘要字数 summaryLen……（旧备份里的 batch 照带但运行时被忽略，固定 10），【不含】压缩用的接口和模型）、
//     上下文上限 contextLimit、世界书扫描设置 wi（SETTING_KEYS）。
//     恢复到已有数据的浏览器：弹框问一句「是否应用备份中的……」，答「是」才用备份里的；备份里这一样缺失 / 形状不对 = 没有，本机的不动，
//     三样都没有就不问（backupSettings / settingsInBackup）。空浏览器：直接用备份里的，不问。
//
//   当前在用的选择（kind 'selection'）：当前用哪个预设、哪个人设、聊天用的接口和模型、记忆压缩用的接口和模型、手动模式、
//     便签的「隐藏已完成」、「拼装」页的两个缓存开关（SELECTION_KEYS + memory 里的 MEMORY_SELECTION_KEYS）。
//     用户定的规则（原话的意思）：恢复「本质上是在导入数据，备份本身不包含当前在聊的用的这些」。所以：
//       导出时：不写进备份（globalForBackup）；
//       恢复到已有数据的浏览器：一律保持本机的，不管弹框怎么答；旧版本导出的、带着这些字段的备份，这些字段一律忽略；
//       空浏览器：不从备份拿，用默认——人设 = 列表里第一个；预设 = 恢复进来的预设里的第一个（一个都没有 = 内置默认）；
//         聊天 / 记忆压缩用的接口和模型 = 不写，读档时补成默认引用（网页版里显示成「还没选接口」，本地版是默认的 Claude Code）——
//         【不按地址自动指到备份里的模型】：项目里出过「自动选中一个已下线的模型然后报错」的事；手动模式关；「隐藏已完成」关；缓存开关默认。
//
// 旧版本（这一版之前）的页面读到这种「不带当前选择」的备份不会出错（读代码确认过）：
//   缺 activePresetId → 它当作「备份里没有当前预设」= 内置默认预设；缺 chatModel / memory.modelRef → 它的 planModelRefs 判成「不覆盖」，
//   读档时 migrateModelRefs 补默认引用；缺 activePersonaId → alignPersonas 退回列表第一个（导出前已经把 persona 对齐进列表，不丢内容）；
//   缺 manual / notesHideDone / 两个缓存开关 → 默认值。最坏只是旧版本「用备份里的设置替换」时这些回到默认，不会报错、不会丢内容。

/** 当前在用的选择：顶层的这些键。model 是旧版本「聊天用的 Claude 模型别名」（读档时会被换算成 chatModel），同样是选择，一起去掉 */
export const SELECTION_KEYS = Object.freeze(['activePresetId', 'activePersonaId', 'chatModel', 'model', 'manual', 'notesHideDone', 'stableRandom', 'promptCache']);
/** memory 对象里属于「当前选择」的键：压缩用的接口和模型（modelRef），以及它的两个旧版本写法 */
export const MEMORY_SELECTION_KEYS = Object.freeze(['modelRef', 'model', 'openaiModel']);
/** 真正的设置：恢复时只问这三样 */
export const SETTING_KEYS = Object.freeze(['memory', 'contextLimit', 'wi']);
// phoneWallpaper：手机的两张壁纸。它不在 global 里（在 'phone' 记录里，phone-backup.js），所以不在 SETTING_KEYS 里，
// 但它也是「设置」：恢复到已有数据时并进同一句问话，答「是」才换（ui/backup.js），摘要里用这个名字
const SETTING_LABEL = { memory: '外置记忆设置', contextLimit: '上下文上限', wi: '世界书扫描设置', phoneWallpaper: '手机壁纸' };

/**
 * 导出时：存储里的 global → 写进备份的 global（新对象，浅拷贝；不改输入）。去掉「当前在用的选择」，其余原样（不认识的字段照带）。
 * 多人设时先把 persona 对齐进列表（alignPersonas）再去掉 activePersonaId：没有 activePersonaId 时，读的一方会退回列表第一个、
 * 以列表为准，所以当前那一项要先在列表里是最新的，不然旧版本页面只改了 persona 的那部分内容会丢。
 */
export function globalForBackup(g) {
    if (!isObj(g)) return null;
    const out = {};
    for (const k of Object.keys(g)) if (!SELECTION_KEYS.includes(k)) out[k] = g[k];
    // 旧形状的 global（多预设之前）里还带着预设本体：一样去掉酒馆的连接信息（见 buildBackup）
    if (isObj(g.preset)) out.preset = sanitizePreset(g.preset).preset;
    if (isObj(g.memory)) {
        const m = { ...g.memory };
        for (const k of MEMORY_SELECTION_KEYS) delete m[k];
        out.memory = m;
    }
    if (Array.isArray(g.personas)) {
        const a = alignPersonas(g);
        out.persona = a.persona;
        if (a.personas) out.personas = a.personas; else delete out.personas;
    }
    return out;
}

/**
 * 备份 global 里能用的设置（只看 SETTING_KEYS 三样）：形状对的才算，memory 先去掉「当前选择」的键，去掉后空了也算没有。
 * 返回 {memory?, contextLimit?, wi?}（深拷贝）。
 */
function backupSettings(g) {
    const out = {};
    if (!isObj(g)) return out;
    if (isObj(g.memory)) {
        const m = safeObj(g.memory);
        for (const k of MEMORY_SELECTION_KEYS) delete m[k];
        if (Object.keys(m).length) out.memory = m;
    }
    if (isObj(g.contextLimit) && typeof g.contextLimit.mode === 'string') out.contextLimit = safeObj(g.contextLimit);
    if (isObj(g.wi) && Object.keys(g.wi).length) out.wi = safeObj(g.wi);
    return out;
}

/** 这份备份里有哪几样设置可以应用（界面据此决定弹不弹「是否应用」的框；空数组 = 不用问） */
export function settingsInBackup(backupGlobal) {
    return Object.keys(backupSettings(isObj(backupGlobal) ? safeGlobalCopy(backupGlobal).global : null));
}

/**
 * 已有数据的浏览器里答了「是」：把备份里的设置写到 g（新 global，底子是本机的）上。memory 里本机的「当前选择」（压缩用的接口和模型）保留。
 * @returns {string[]} 实际变了的设置（SETTING_KEYS 里的键）
 */
function applyBackupSettings(g, settings) {
    const changed = [];
    for (const k of SETTING_KEYS) {
        if (!Object.hasOwn(settings, k)) continue;
        const v = structuredClone(settings[k]);
        if (k === 'memory') {
            const cur = isObj(g.memory) ? g.memory : {};
            for (const s of MEMORY_SELECTION_KEYS) if (Object.hasOwn(cur, s)) v[s] = structuredClone(cur[s]);
        }
        if (canonical(v) === canonical(g[k])) continue;
        g[k] = v;
        changed.push(k);
    }
    return changed;
}

/**
 * 空浏览器：新 global 的「设置 + 不认识的字段」部分。底子是备份里的 global（不认识的字段照带——它们是以后版本加的东西，
 * 换新设备时原样带过去，和以前一样），去掉当前选择和旧形状的预设本体；三样设置形状不对的去掉（读档时补默认值）。内容由 contentFromBackupOnly 另写。
 */
function freshBase(backupG, settings) {
    const g = {};
    for (const k of Object.keys(backupG)) {
        if (SELECTION_KEYS.includes(k) || k === 'preset' || k === 'presetName' || SETTING_KEYS.includes(k)) continue;
        g[k] = structuredClone(backupG[k]);
    }
    for (const k of SETTING_KEYS) if (Object.hasOwn(settings, k)) g[k] = structuredClone(settings[k]);
    return g;
}

// ───────────────────────────── 内容取并集 ─────────────────────────────
//
// 内容类：人设（persona / personas / activePersonaId 三个字段一起算）、额外世界书 books、全局正则 globalRegex、便签 notes、全局变量 globalVariables。
// 恢复到【已有数据】的浏览器时【永远取并集】：本机已有的一条不删、不改；备份里有而本机没有的加进来；内容相同的跳过。
// 恢复到【空浏览器】（换新设备）：内容就是备份原样（contentFromBackupOnly），只有「当前人设」按上面的规则取第一个。
//
// 「算重复」的判定（只看内容，不看 id、不看开关 / 完成状态）：
//   人设     名字（去掉首尾空白，空的算 'User'）+ 描述 + 备注 都相同（personas.js personaSig / mergePersonas，和「人设」页导入酒馆人设文件同一条规则）。
//            备注算内容：名字、描述相同而备注不同的是两个人设（用户靠备注区分重名的）。没有备注 = 空备注，所以有备注这个字段之前的备份照旧判重
//   世界书   整本去掉 name、开关 / 范围 / 绑定（enabled / scope / cards）、条目上的 book（书名的副本）之后（entries 和以后可能加的字段）
//            canonical 相同 = 重复，不管叫什么名字、开没开、绑给了谁（和预设「名字不算内容」一致；见 books.js bookContent）。
//            重复时保留本机那本和它的开关、范围；但备份里那本「只对指定的卡」绑定的卡，换算成本机的卡 id 后【并进】本机那本的 cards
//            （只在本机那本也是「只对指定的卡」时——本机那本对所有聊天生效的话，绑定没有意义，不动它）。
//            内容不同而名字和本机已有的（或这次已经加进来的）重名：两本都留，后一本名字加「 (2)」「 (3)」（makeUniqueNamer，和预设一样）。
//            世界书没有 id，别处按名字找它（导入同名世界书会替换、「世界书」页按名字显示），所以名字不能重复。
//            摘要里另外提醒：两个版本都开着、对同一张卡生效时，会重复发给模型。
//            备份里的书新加进来时，cards 按卡 id 的映射换算（planBackupImport 的 cardIdMap：备份里的卡在本机是新 id，
//            或者被判重映射到本机已有的那张卡）；映射不到的 id（那张卡没在备份里 / 格式不对被跳过）丢掉。空浏览器同样换算。
//   全局正则 脚本去掉 id、origin、disabled 之后 canonical 相同 = 重复。id 每次导入都可能重新生成；origin 是运行时的标签（见 regexSig）；
//            disabled 是开关状态——同一条正则在两边开关不同，仍是同一条，保留本机那条和它的开关。id 和本机的撞了就换新 id。
//   便签     标题（去首尾空白）+ 内容 都相同，不看是否完成（notes.js mergeNotes，和「便签」页导入 Markdown 同一条规则）；保留本机那条和它的完成状态
//   全局变量 按键：本机没有的键加进来；本机已有的键保留本机的值（不管备份里的值是不是一样，都算「跳过」）
// 备份里某一类缺失、形状不对、是空的：当作「备份里这类内容是空的」，本机的原样保留；任何情况下都不会因为备份里的坏数据清掉本机的内容。
// 坏条目（不是对象的书 / 条目 / 正则脚本）：两条路径都丢掉并计入「跳过」——原样写进去的话，scanWorldInfo 等会抛错，消息发不出去（复核实测过）。

const CONTENT_LABEL = { persona: '人设', books: '世界书', globalRegex: '全局正则', notes: '便签', globalVariables: '全局变量' };
const PERSONA_KEYS = ['persona', 'personas', 'activePersonaId'];

/** 一个对象的浅拷贝（值深拷贝），去掉 __proto__ / constructor / prototype：备份里的对象来自 JSON.parse，可能带着自有的 __proto__ 键 */
function safeObj(src) {
    const o = {};
    for (const k of Object.keys(src)) if (!UNSAFE_KEYS.includes(k)) o[k] = structuredClone(src[k]);
    return o;
}

const bookSig = b => canonical(bookContent(b));
// 正则还要忽略 origin：它不是脚本的内容，是运行时打的标签——ui/pipeline.js allScripts 每次拼装都会在脚本对象上写 origin = 'global' / 'preset' / 'card'，
// 跟着下一次保存进了存储，而导入的文件里没有它。不忽略的话，同一份备份恢复第二次，每条正则都会被当成新的再加一遍（浏览器测试实际碰到过）。
// disabled（开关）同理不算内容：用户在这台机器上关掉了一条正则，恢复另一台机器的备份时不该因此多出一条「开着的同一条正则」
export const regexSig = s => { const { id: _i, origin: _o, disabled: _d, ...rest } = s; return canonical(rest); };
/** 出厂默认的人设（名字 User、没有描述、没有备注）：不是用户写的内容（没动过人设的浏览器导出的备份里都是它），合并时不把它当成一个新人设加进来 */
const isDefaultPersona = p => p.name === 'User' && p.description === '' && !p.remark;

/** 备份里的世界书过一遍严格的容错（cleanBooks strict），坏的书 / 条目计入 summary.skipped，返回干净的列表（条目已深拷贝、去掉危险键） */
function cleanBackupBooks(raw, summary) {
    const c = cleanBooks(raw, { strict: true });
    if (c.badBooks) summary.skipped.push(`${c.badBooks} 本世界书（格式不对）`);
    if (c.badEntries) summary.skipped.push(`${c.badEntries} 个世界书条目（格式不对）`);
    return c.list.map(b => ({ ...safeObj(b), entries: b.entries.map(safeObj) }));
}

/** 备份里的全局正则过一遍容错：不是对象的丢掉并计入 summary.skipped；返回去掉危险键的拷贝 */
function cleanBackupRegex(raw, summary) {
    const c = cleanRegexList(raw);
    if (c.bad) summary.skipped.push(`${c.bad} 条全局正则（格式不对）`);
    return c.list.map(safeObj);
}

/**
 * 额外世界书取并集。theirs 已经过 cleanBackupBooks；cardIdMap：备份里的卡 id → 本机的卡 id（planBackupImport 里建的）。
 * 返回 {list, added, dup, renamed: 改了名的本数, rebound: 因为判重而多绑了卡的本机书的本数}
 */
function unionBooks(mine, theirs, renamedLog, cardIdMap) {
    // 本机这一边：读档时 normalizeGlobal 已经清过，这里再过一遍宽松的容错（存储里可能还是写坏的旧值），不删书、不改名字以外的东西
    const list = cleanBooks(mine).list;
    const bySig = new Map();   // 内容签名 → 在 list 里的位置（重复时要往那一本里并绑定）
    list.forEach((b, i) => { const s = bookSig(b); if (!bySig.has(s)) bySig.set(s, i); });
    const nameFor = makeUniqueNamer(list.map(b => b.name).filter(n => typeof n === 'string'));   // 线性：见 migrate.js makeUniqueNamer
    let added = 0, dup = 0, renamed = 0;
    const rebound = new Set();
    for (const raw of theirs) {
        const b = remapBookCards(raw, cardIdMap);
        const s = bookSig(b);
        if (bySig.has(s)) {
            dup++;
            const i = bySig.get(s);
            const mineScope = bookScopeOf(list[i]), theirScope = bookScopeOf(b);
            if (mineScope.scope === 'cards' && theirScope.scope === 'cards') {
                const extra = theirScope.cards.filter(id => !mineScope.cards.includes(id));
                // 换成新对象（list 里的书可能是本机 global 里的同一个对象，不能原地改）
                if (extra.length) { list[i] = setBookScope({ ...list[i] }, { cards: [...mineScope.cards, ...extra] }); rebound.add(i); }
            }
            continue;
        }
        const want = nameOf(b.name, '导入的世界书');
        const name = nameFor(want);
        if (name !== want) { renamed++; renamedLog.push(`世界书「${want}」→「${name}」`); }
        bySig.set(s, list.length);
        // 改了名的：条目上的 book 字段一起改（books.js setBookName），不然「世界书」页按「书名 + uid」对触发结果时会和另一本 X 串。
        // 先拷贝书和条目再改（theirs 是 cleanBackupBooks 的拷贝，但不在这里假设调用方的对象可以动）
        list.push(name === b.name ? { ...b } : setBookName({ ...b, entries: Array.isArray(b.entries) ? b.entries.map(e => (isObj(e) ? { ...e } : e)) : b.entries }, name));
        added++;
    }
    return { list, added, dup, renamed, rebound: rebound.size };
}

/** 全局正则取并集。theirs 已经过 cleanBackupRegex。返回 {list, added, dup} */
function unionRegex(mine, theirs, newId) {
    const list = cleanRegexList(mine).list;
    const sigs = new Set(list.map(regexSig));
    const ids = new Set(list.map(s => s.id).filter(x => x !== undefined && x !== null));
    let added = 0, dup = 0;
    for (const s of theirs) {
        const sig = regexSig(s);
        if (sigs.has(sig)) { dup++; continue; }
        const r = { ...s };
        // 没有 id 的给一个（和拖文件导入正则时一样）；撞了本机的（或这次刚加的）换新的，免得「正则」页按 id 切开关时切错
        if (r.id === undefined || r.id === null || ids.has(r.id)) { let id = newId(); for (let i = 0; i < 20 && ids.has(id); i++) id = newId(); r.id = id; }
        ids.add(r.id); sigs.add(sig);
        list.push(r);
        added++;
    }
    return { list, added, dup };
}

/**
 * 全局变量按键合并：本机的键【原样保留】（哪怕叫 constructor / prototype——那是用户自己的变量）；
 * 危险键（__proto__ / constructor / prototype）只从备份那一边过滤。返回 {vars, added, dup}
 * 结果对象用 Object.fromEntries 造：它对每个键做的是「定义自有数据属性」（CreateDataProperty），
 * 键叫 __proto__ 也只是多一个普通字段，不会去换结果对象的原型；而 obj[k] = v 遇到 '__proto__' 会改原型。
 */
function unionVars(mine, theirs) {
    const pairs = Object.entries(isObj(mine) ? mine : {});
    const have = new Set(pairs.map(([k]) => k));
    let added = 0, dup = 0;
    for (const k of Object.keys(theirs)) {
        if (UNSAFE_KEYS.includes(k)) continue;
        if (have.has(k)) { dup++; continue; }
        pairs.push([k, structuredClone(theirs[k])]);
        have.add(k);
        added++;
    }
    return { vars: Object.fromEntries(pairs), added, dup };
}

/**
 * 人设取并集（三个字段一起）。本机当前选中的人设永远不变（「当前人设」是当前选择，不从备份拿）。
 * @returns {{rec: Object, added: number, dup: number}}
 *          rec：{persona, personas?, activePersonaId?}；只有一个人设时没有后两个字段（存储形状不变，见 personas.js 文件头）
 */
function unionPersonas(localG, backupG, newId) {
    const theirs = alignPersonas(backupG);
    // 去掉 id（判重不看 id），备注照带（alignPersonas 已经规范化过：没有备注的项上没有 remark 键）
    let items = theirs.personas ? theirs.personas.map(({ id: _id, ...p }) => p) : [theirs.persona];
    if (!theirs.personas && isDefaultPersona(theirs.persona)) items = [];
    const r = mergePersonas({ persona: localG.persona, personas: localG.personas, activePersonaId: localG.activePersonaId }, items, newId);
    return { rec: r.rec, added: r.added, dup: r.skipped };
}

/**
 * 本机没有全局记录时（空浏览器，或者极少见的「有卡但从没存过全局记录」）：内容就是备份里的（「和空集取并集」），
 * 过一遍和合并路径同样的容错（坏的书 / 条目 / 正则丢掉、便签 normalizeNotes）。形状不对的字段不写，读档时 normalizeGlobal 补成默认值。
 * 人设：列表原样，当前人设 = 列表里第一个（当前选择不从备份拿）。
 */
function contentFromBackupOnly(g, backupG, summary, deps) {
    for (const k of [...PERSONA_KEYS, 'books', 'globalRegex', 'notes', 'globalVariables']) delete g[k];
    const p = alignPersonas(backupG);
    if (p.personas) {
        const first = switchPersona(p, p.personas[0].id);
        Object.assign(g, { persona: first.persona, personas: first.personas, activePersonaId: first.activePersonaId });
    } else if (Object.hasOwn(backupG, 'persona')) g.persona = p.persona;
    summary.personasAdded = p.personas ? p.personas.length : (Object.hasOwn(backupG, 'persona') && !isDefaultPersona(p.persona) ? 1 : 0);
    // 世界书原样回来，只有绑定的卡 id 换算成恢复后的新 id（映射不到的丢掉）
    if (Array.isArray(backupG.books)) { g.books = cleanBackupBooks(backupG.books, summary).map(b => remapBookCards(b, deps.cardIdMap)); summary.booksAdded = g.books.length; }
    if (Array.isArray(backupG.globalRegex)) { g.globalRegex = cleanBackupRegex(backupG.globalRegex, summary); summary.regexAdded = g.globalRegex.length; }
    if (isObj(backupG.globalVariables)) { g.globalVariables = safeObj(backupG.globalVariables); summary.varsAdded = Object.keys(g.globalVariables).length; }
    const notes = normalizeNotes(backupG.notes, deps);
    if (notes.length) { g.notes = notes; summary.notesAdded = notes.length; }
}

/**
 * 本机有全局记录时：把五类内容和本机的取并集，有变化的那几类写到 g 上（g 是新 global，底子是本机的；没变化的保持本机原样，逐字节不变）。
 * @returns {boolean} 内容有没有变化（没变化、设置也没变就不用写 global）
 */
function unionContent(g, localG, backupG, { summary, newId, now, cardIdMap }) {
    const shapeBad = (k, ok) => {
        if (Object.hasOwn(backupG, k) && !ok) summary.notes.push(`备份里的${CONTENT_LABEL[k]}格式不对，没有导入（这里原来的${CONTENT_LABEL[k]}都还在）`);
    };
    let changed = false;
    const put = (k, v, didChange) => { if (didChange) g[k] = v; changed ||= didChange; };

    const books = unionBooks(localG.books, Array.isArray(backupG.books) ? cleanBackupBooks(backupG.books, summary) : [], summary.renamed, cardIdMap);
    shapeBad('books', backupG.books === undefined || Array.isArray(backupG.books));
    Object.assign(summary, { booksAdded: books.added, booksDup: books.dup, booksRenamed: books.renamed, booksRebound: books.rebound });
    put('books', books.list, books.added > 0 || books.rebound > 0);

    const regex = unionRegex(localG.globalRegex, Array.isArray(backupG.globalRegex) ? cleanBackupRegex(backupG.globalRegex, summary) : [], newId);
    shapeBad('globalRegex', backupG.globalRegex === undefined || Array.isArray(backupG.globalRegex));
    Object.assign(summary, { regexAdded: regex.added, regexDup: regex.dup });
    put('globalRegex', regex.list, regex.added > 0);

    const vars = unionVars(localG.globalVariables, isObj(backupG.globalVariables) ? backupG.globalVariables : {});
    shapeBad('globalVariables', backupG.globalVariables === undefined || isObj(backupG.globalVariables));
    Object.assign(summary, { varsAdded: vars.added, varsDup: vars.dup });
    put('globalVariables', vars.vars, vars.added > 0);

    // 便签：本机的先规范化（读档时本来就规范化过，存储里的和内存里的一样），备份的交给 mergeNotes 逐条容错
    const deps = { newId, now: now.getTime() };
    const notes = mergeNotes(normalizeNotes(localG.notes, deps), Array.isArray(backupG.notes) ? backupG.notes : [], deps);
    shapeBad('notes', backupG.notes === undefined || Array.isArray(backupG.notes));
    Object.assign(summary, { notesAdded: notes.added, notesDup: notes.skipped });
    put('notes', notes.list, notes.added > 0);

    const p = unionPersonas(localG, backupG, newId);
    Object.assign(summary, { personasAdded: p.added, personasDup: p.dup });
    if (p.added) {
        g.persona = p.rec.persona;
        if (p.rec.personas) { g.personas = p.rec.personas; g.activePersonaId = p.rec.activePersonaId; }
        changed = true;
    }
    return changed;
}

// ───────────────────────────── 导入计划 ─────────────────────────────

/**
 * 算出导入要写的所有记录。纯函数：不改 backup / existing。
 *
 * @param {Object} backup   parseBackup 通过的备份对象
 * @param {{cards: Object[], chats: Object[], presets: Object[], global?: Object|null}} existing
 *        存储里已有的记录（全部的 CardRecord、ChatRecord、PresetRecord，用来查重和避开重名）；
 *        global：存储里现在的 'global'（内容取并集的「本机这一边」，也是新 global 的底子——当前选择都从它来）。fresh 时不看。
 * @param {{newId: () => string, now: Date, fresh?: boolean, applySettings?: boolean}} deps
 *        fresh：这是一个空浏览器（换新设备，ui/backup.js isEmptyForRestore 判定）：内容和三样设置都按备份原样，当前选择用默认值。
 *        applySettings：已有数据的浏览器里，用户在弹框里答了「是」：用备份里的三样设置（SETTING_KEYS）。fresh 时不看（总是用）。
 *        当前选择（SELECTION_KEYS）两个参数怎么给都不从备份拿。
 * @returns {{
 *   cards: Object[],              新卡的 CardRecord（新 id）
 *   chats: Object[],              新存档的 ChatRecord（新 id；cardId 指向新卡或已有的卡）
 *   presets: Object[],            新预设的 PresetRecord（新 id）
 *   indexes: Object[],            新卡的存档目录（buildIndex 的结果）
 *   merges: {cardId: string, chats: Object[]}[],   并进【已有的卡】的存档（它们的目录要在写入的事务里读出来再补条目）
 *   highlightMerges: {cardId: string, chatId: string, copies: Highlight[][]}[],
 *                                 要并进【本机已有存档】的划线（备份里的存档和它除划线外完全相同，chatSig）。copies：备份里每个这样的存档的划线
 *                                 （已按消息清洗）。写入事务里现读那条存档记录，按顺序 mergeChatHighlights 进去、只改 highlights；
 *                                 只列真的会并进新东西（新划线或补上的备注）的存档，所以同一份备份导第二遍这里是空的
 *   summary 另有 highlightsMerged（并进已有存档的划线条数）、highlightNotesFilled（给本机已有的同位置划线补上了几条备注）、highlightChats（涉及几个存档）。
 *   备份里两个除划线外相同、都不在本机的存档：只进来第一个，后面的划线并进它（还在 chats 里，直接改；不计入上面三个数）
 *   cardvars: {cardId: string, value: CardVars}[],        新建的卡的 cardvars:<id>（规范化过）
 *   cardvarsMerges: {cardId: string, value: CardVars}[],  并进【已有的卡】的 cardvars（写入事务里和本机那条按键取并集，见 cardvars.js unionCardVars）
 *   global: Object|null,          要写进 'global' 的新记录；null = 不用动
 *   settingsApplied: string[],    实际用了备份里的哪几样设置（SETTING_KEYS 里的键；空浏览器是备份里有的那几样）
 *   target: {cardId: string, chatId: string|null}|null,  备份里原来的当前卡 / 存档在导入后的 id（取最近使用的那张卡）
 *   summary: {cardsAdded, cardsMerged, chatsAdded, chatsDup, presetsAdded, presetsDup,
 *             personasAdded, personasDup, booksAdded, booksDup, booksRenamed, booksRebound（判重后多绑了卡的本机世界书本数）, regexAdded, regexDup, notesAdded, notesDup, varsAdded, varsDup,
 *             settingsApplied: string[], renamed: string[], skipped: string[], notes: string[],
 *             worldKept: {srcId, cardId, name}[]（备份里自带世界书关着、并进的本机那张卡开着的卡：本机的开关没动），
 *             worldReenabled: {srcId, cardId, name, books: string[]}[]（新建的卡：自带世界书在备份里关着，但合并后替它的书没有对它生效，
 *               于是去掉了 worldDisabled；books 是本机保留下来的那几本的名字，见 keepEmbeddedWorlds）}
 *            （summary.notes 是给人看的附注句子，和便签无关——名字早于便签功能；便签的数目是 notesAdded / notesDup）
 * }}
 */
export function planBackupImport(backup, existing, { newId, now, fresh = false, applySettings = false }) {
    const summary = { cardsAdded: 0, cardsMerged: 0, chatsAdded: 0, chatsDup: 0, presetsAdded: 0, presetsDup: 0,
        personasAdded: 0, personasDup: 0, booksAdded: 0, booksDup: 0, booksRenamed: 0, booksRebound: 0, regexAdded: 0, regexDup: 0, notesAdded: 0, notesDup: 0, varsAdded: 0, varsDup: 0,
        highlightsMerged: 0, highlightNotesFilled: 0, highlightChats: 0,
        settingsApplied: [], renamed: [], skipped: [], notes: [], worldKept: [], worldReenabled: [] };
    const out = { cards: [], chats: [], presets: [], indexes: [], merges: [], highlightMerges: [], cardvars: [], cardvarsMerges: [], global: null, settingsApplied: summary.settingsApplied, target: null, summary,
        // 手机会话里的引用要跟着换算（phone-backup.js planPhoneImport）：cards = 备份里的卡 id → 本机的卡 id（新建的卡是新 id，判重并进的是本机那张）；
        // personas = 备份里的人设 id → 合并后同一个人设（personaSig 相同）在本机的 id（人设的 id 恢复时会换，只能按内容对）
        maps: { cards: new Map(), personas: new Map() } };
    const ex = { cards: existing?.cards ?? [], chats: existing?.chats ?? [], presets: existing?.presets ?? [] };

    // ── 预设 ──
    // 内容相同的跳过（不看名字）；名字撞了加序号（线性的起名函数，见 migrate.js makeUniqueNamer）
    // 两边都按清洗后的本体比（cleanPresetBody：去掉酒馆的连接信息、校正正则）：备份里的那份带着反代密码，
    // 和本机那份（入口清洗过；存储里残留的旧记录也按同样规则看）其实是同一个预设，要认成重复
    const presetBySig = new Set(ex.presets.filter(p => isObj(p) && isObj(p.preset)).map(p => presetSig({ preset: cleanPresetBody(p.preset).preset })));
    const cleanedNames = [];   // 去掉了有内容的连接信息的预设（只记名字，不记值）
    const presetName = makeUniqueNamer(ex.presets.map(p => p?.name));
    const srcPresets = [...(backup.presets ?? [])];
    // 旧形状的 global（多预设之前：预设本体在 global.preset 里）：把它当成备份里的又一个预设，规则和 planPresetMigration 一样
    const legacyPreset = isObj(backup.global) && isLegacyGlobal(backup.global) && isObj(backup.global.preset);
    if (legacyPreset) srcPresets.push({ name: nameOf(backup.global.presetName, '导入的预设'), preset: backup.global.preset });
    srcPresets.forEach((p, i) => {
        if (!isObj(p) || !isObj(p.preset)) { summary.skipped.push(`第 ${i + 1} 个预设（格式不对）`); return; }
        // 备份里的预设也是「进入系统」：去掉酒馆的连接信息、校正正则（规则见 migrate.js cleanPresetBody）
        const c = cleanPresetBody(p.preset);
        p = { ...p, preset: c.preset };
        if (c.filled.length) cleanedNames.push(nameOf(p.name, '导入的预设'));
        const sig = presetSig(p);
        if (presetBySig.has(sig)) { summary.presetsDup++; return; }
        const want = nameOf(p.name, '导入的预设');
        const name = presetName(want);
        if (name !== want) summary.renamed.push(`预设「${want}」→「${name}」`);
        const iso = now.toISOString();
        // 不认识的字段原样带上，只换 id 和（必要时）名字
        const { id: _old, ...rest } = p;
        const rec = { ...structuredClone(rest), id: newId(), name, preset: structuredClone(p.preset), createdAt: p.createdAt ?? iso, updatedAt: p.updatedAt ?? iso };
        out.presets.push(rec);
        presetBySig.add(sig);
        summary.presetsAdded++;
    });
    // 提示只说类别（反代地址 / 密码……），不出现任何值；重复而跳过的预设也算（它的密码同样没进来）
    if (cleanedNames.length) summary.notes.push(`${cleanedNames.length} 个预设（${cleanedNames.slice(0, 3).map(n => `「${n}」`).join('、')}${cleanedNames.length > 3 ? ' 等' : ''}）里带着酒馆的反代地址 / 密码等连接信息，SmallTalk 用不到，已去掉`);

    // ── 卡和存档 ──
    // 内容签名 → 导入后挂到哪张卡（已有的卡，或这次新建的卡）。备份里两张一模一样的卡也会并成一张
    const cardBySig = new Map();
    for (const c of ex.cards) if (isObj(c) && isObj(c.card)) { const s = cardSig(c); if (!cardBySig.has(s)) cardBySig.set(s, { id: c.id, isNew: false, rec: c }); }
    // 每张卡（含新建的）已有存档的签名 → {id, rec, isNew}，用来跳过重复的存档、把重复存档的划线并进去。
    // 本机自己就有两个签名相同的存档（只差划线，按旧规矩恢复出来的）：认存储里排在前面的那个，划线只并进它
    const chatSigs = new Map();
    for (const ch of ex.chats) {
        if (!isObj(ch) || chatProblem(ch)) continue;
        if (!chatSigs.has(ch.cardId)) chatSigs.set(ch.cardId, new Map());
        const s = chatSig(ch), m = chatSigs.get(ch.cardId);
        if (!m.has(s)) m.set(s, { id: ch.id, rec: ch, isNew: false });
    }
    // 并进【本机已有存档】的划线：'卡id\n存档id' → {cardId, chatId, copies（备份里每个重复存档的划线各一份，清洗过，按出现顺序）,
    // list（按计划合并后的）, added, filled}。只记真的会有变化的（没有新划线可并 = 不写，同一份备份导第二遍零写入）
    const hlMerges = new Map();
    const mergeMap = new Map();   // 已有卡 id → 并进去的新存档
    // 备份里的卡 id → 导入后的卡 id（新建的卡是新 id；内容和本机已有的相同而没新建的，指向本机那张）。
    // 额外世界书的绑定（books[].cards）靠它换算；格式不对被跳过的卡不在里面，绑定到它的 id 会被丢掉
    const cardIdMap = out.maps.cards;
    let best = null;              // 备份里最近使用的那张卡：{usedAt, cardId, activeChatId 映射后的}

    backup.cards.forEach((entry, i) => {
        const bad = cardProblem(entry);
        const label = isObj(entry?.card?.card) ? `「${nameOf(entry.card.card.name, '?')}」` : `第 ${i + 1} 张卡`;
        if (bad) { summary.skipped.push(`角色卡${label}（${bad}）及它的存档`); return; }
        const src = entry.card;
        const sig = cardSig(src);
        let target = cardBySig.get(sig);
        let newCard = null;
        if (target) {
            if (!target.isNew) {
                summary.cardsMerged++;
                // 备份里这张卡的自带世界书是关着的、本机那张开着：本机的开关不动（只新增、不改现有的）。
                // 记下来给酒馆 zip 导入的结果框用——它关掉卡的自带书是因为一起导入了绑定的那本书文件，现在两份可能都开着
                if (src.card?.worldDisabled === true && target.rec?.card?.worldDisabled !== true) {
                    summary.worldKept.push({ srcId: src.id, cardId: target.id, name: nameOf(src.card.name, '?') });
                }
            }
        } else {
            const { id: _old, ...rest } = src;
            const iso = now.toISOString();
            newCard = { ...structuredClone(rest), id: newId(), avatar: typeof src.avatar === 'string' ? src.avatar : '',
                createdAt: src.createdAt ?? iso, activeChatId: null };
            // 卡自带的正则校正字段类型、丢掉没法用的（cardSig 也是按 normalizeCard 校正后的比的，两边一致）
            if (isObj(newCard.card) && newCard.card.regexScripts !== undefined) {
                const before = newCard.card.regexScripts;
                const fixed = normalizeCard(newCard.card).regexScripts;
                if (fixed !== before) newCard.card = { ...newCard.card, regexScripts: fixed };
            }
            // 酒馆助手脚本同理（不是数组的删掉 = 回到跟着 raw；坏条目丢掉）。读档时 normalizeCard 也会再做一遍，这里先做是为了存进去的就是干净的
            if (isObj(newCard.card) && Object.hasOwn(newCard.card, 'scripts')) {
                const fixed = normalizeCard(newCard.card);
                if (fixed.scripts !== newCard.card.scripts) {
                    const { scripts: _old, ...restCard } = newCard.card;
                    newCard.card = fixed.scripts === undefined ? restCard : { ...restCard, scripts: fixed.scripts };
                }
            }
            target = { id: newCard.id, isNew: true, rec: newCard };
            cardBySig.set(sig, target);
            out.cards.push(newCard);
            summary.cardsAdded++;
        }
        if (typeof src.id === 'string' && src.id !== '' && !cardIdMap.has(src.id)) cardIdMap.set(src.id, target.id);
        // 这张卡的运行时数据（cardvars：脚本变量、角色卡变量；形状不对 = 没有）。新建的卡整条带过来；
        // 并进本机已有的卡：在写入事务里和本机那条按键取并集（本机已有的键不动，ui/backup.js doImport）。
        // 备份里两张判成同一张的卡各带一份：也按键并起来，先出现的那份优先
        const cv = normalizeCardVars(entry.vars);
        if (cv) {
            const list = target.isNew ? out.cardvars : out.cardvarsMerges;
            const hit = list.find(x => x.cardId === target.id);
            if (hit) hit.value = unionCardVars(hit.value, cv).value;
            else list.push({ cardId: target.id, value: cv });
        }
        if (!chatSigs.has(target.id)) chatSigs.set(target.id, new Map());
        const sigs = chatSigs.get(target.id);
        const chatMap = new Map();   // 备份里的存档 id → 导入后的 id（重复的指向已有的那个）
        let latest = null;           // 这张卡导入后最近更新的存档（activeChatId 指向的存档坏了 / 没有时用它）
        (entry.chats ?? []).forEach((ch, j) => {
            const why = chatProblem(ch);
            if (why) { summary.skipped.push(`角色卡${label}的第 ${j + 1} 个存档${typeof ch?.name === 'string' ? `「${ch.name}」` : ''}（${why}）`); return; }
            const s = chatSig(ch);
            const dup = sigs.get(s);
            if (dup) {
                chatMap.set(ch.id, dup.id);
                summary.chatsDup++;
                // 除划线以外完全相同：备份里的划线并进那个存档（规矩见 highlight.js mergeHighlights）。备份里的先按它自己的消息清洗——
                // 消息和那个存档的一样（签名相同），所以按哪边清洗结果都一样
                if (ch.highlights !== undefined) {
                    const theirs = storedHighlights(ch.highlights, chatDoc(ch.messages));
                    if (theirs) {
                        if (dup.isNew) {
                            // 备份里两个互为重复的存档（都不在本机）：进来的是第一个，后面的划线并进它（它还在 out.chats 里，直接改）
                            const r = mergeHighlights(dup.rec.highlights, theirs, chatDoc(dup.rec.messages));
                            if (r.changed) dup.rec.highlights = r.list;
                        } else {
                            const k = `${target.id}\n${dup.id}`;
                            const prev = hlMerges.get(k);
                            const r = mergeHighlights(prev ? prev.list : dup.rec.highlights, theirs, chatDoc(dup.rec.messages));
                            if (r.changed) {
                                if (prev) { prev.copies.push(theirs); prev.list = r.list; prev.added += r.added; prev.filled += r.filled; }
                                else hlMerges.set(k, { cardId: target.id, chatId: dup.id, copies: [theirs], list: r.list, added: r.added, filled: r.filled });
                            }
                        }
                    }
                }
                return;
            }
            const { id: _old, ...rest } = ch;
            const iso = now.toISOString();
            const rec = { ...structuredClone(rest), id: newId(), cardId: target.id, name: nameOf(ch.name, '导入的存档'),
                createdAt: ch.createdAt ?? iso, updatedAt: ch.updatedAt ?? iso, variables: isObj(ch.variables) ? structuredClone(ch.variables) : {} };
            // 作者注释：规范化后再存（坏的字段回默认值，全是默认就不写这个键），和读档时的容错一致
            if ('authorNote' in rec) { const n = storedAuthorNote(rec.authorNote); if (n) rec.authorNote = n; else delete rec.authorNote; }
            // 划线：按这个存档的消息清洗后再存（越界 / 坏的丢掉，一条不剩就不写这个键），和读档时的容错一致。id 和建立时间原样保留
            if ('highlights' in rec) { const hl = storedHighlights(rec.highlights, chatDoc(rec.messages)); if (hl) rec.highlights = hl; else delete rec.highlights; }
            out.chats.push(rec);
            sigs.set(s, { id: rec.id, rec, isNew: true });
            if (ch.id !== undefined) chatMap.set(ch.id, rec.id);
            if (!latest || String(rec.updatedAt ?? '') > String(latest.updatedAt ?? '')) latest = rec;
            if (!target.isNew) {
                if (!mergeMap.has(target.id)) mergeMap.set(target.id, []);
                mergeMap.get(target.id).push(rec);
            }
            summary.chatsAdded++;
        });
        // 新卡停在哪个存档：备份里它原来停的那个（映射成新 id）；那个坏了 / 没导出就退到最近更新的
        const active = chatMap.get(src.activeChatId) ?? latest?.id ?? null;
        if (newCard) newCard.activeChatId = active;
        else if (target.isNew && !target.rec.activeChatId) target.rec.activeChatId = active;
        const used = String(src.usedAt ?? src.createdAt ?? '');
        if (!best || used > best.used) best = { used, cardId: target.id, chatId: active };
    });

    for (const c of out.cards) out.indexes.push(buildIndex(c.id, out.chats.filter(x => x.cardId === c.id)));
    out.merges = [...mergeMap].map(([cardId, chats]) => ({ cardId, chats }));
    out.highlightMerges = [...hlMerges.values()].map(({ cardId, chatId, copies }) => ({ cardId, chatId, copies }));
    for (const m of hlMerges.values()) { summary.highlightsMerged += m.added; summary.highlightNotesFilled += m.filled; }
    summary.highlightChats = hlMerges.size;
    if (best) out.target = { cardId: best.cardId, chatId: best.chatId };

    // ── 全局记录：内容取并集；设置看 fresh / applySettings；当前选择永远不从备份拿 ──
    if (!isObj(backup.global)) {
        // 备份里没有全局记录（以前「勾选导出」得到的部分文件）：空浏览器里恢复进来了预设的话，当前预设照样是第一个，其余全用默认值
        if (fresh && out.presets.length) out.global = { activePresetId: out.presets[0].id };
        // 备份里没有世界书，也就没有「因为一起来了绑定的书才关掉」的卡，不用做 keepEmbeddedWorlds
        return out;
    }
    // 备份的 global 先过 safeGlobalCopy：属于当前卡 / 存档的键、会改原型的键都不要
    const { global: backupG, dropped } = safeGlobalCopy(backup.global);
    if (dropped) summary.notes.push(`备份的全局设置里有 ${dropped} 个不认识的 / 不该出现的字段，已忽略`);
    const settings = backupSettings(backupG);
    const deps = { newId, now: now.getTime(), cardIdMap };
    let g, changed;
    if (fresh) {
        // 空浏览器：设置和不认识的字段用备份的，内容按备份原样，当前选择用默认值
        g = freshBase(backupG, settings);
        contentFromBackupOnly(g, backupG, summary, deps);
        // 当前预设 = 恢复进来的预设里的第一个（备份导出时按建立时间排过；旧形状 global 里的那个排在最后）；一个都没有 = 内置默认（null）
        g.activePresetId = out.presets[0]?.id ?? null;
        summary.settingsApplied.push(...SETTING_KEYS.filter(k => Object.hasOwn(settings, k)));
        changed = true;
    } else {
        const localG = isObj(existing?.global) ? safeGlobalCopy(existing.global).global : null;
        // 底子是本机现在的 global：当前选择、没被问到的设置、不认识的字段全都是本机的
        g = localG ? { ...localG } : {};
        if (localG) changed = unionContent(g, localG, backupG, { summary, newId, now, cardIdMap });
        else { contentFromBackupOnly(g, backupG, summary, deps); changed = true; }   // 有卡却从没存过全局记录：内容和空集取并集
        if (applySettings) summary.settingsApplied.push(...applyBackupSettings(g, settings));
        changed ||= summary.settingsApplied.length > 0;
    }
    if (changed) out.global = g;
    out.maps.personas = personaIdMap(backupG, changed ? g : existing?.global);
    // 最终的书列表：写了新 global 就是它的；没写（内容没变化）就是本机原来的
    keepEmbeddedWorlds(out.cards, backup.cards, backupG.books, changed ? g.books : existing?.global?.books, cardIdMap, summary);
    return out;
}

/**
 * 备份里的人设 id → 合并后本机里同一个人设（名字 + 描述 + 备注相同，personas.js personaSig）的 id。
 * 本机合并后没有人设列表（只有一个人设）→ 映射是空的：会话里的 personaId 换算不到就变成 null（跟随当前人设），而本机只有一个人设，结果一样。
 */
function personaIdMap(backupG, finalG) {
    const map = new Map();
    const theirs = alignPersonas(backupG).personas ?? [];
    const mine = isObj(finalG) ? alignPersonas(finalG).personas ?? [] : [];
    const bySig = new Map();
    for (const p of mine) { const s = personaSig(p); if (!bySig.has(s)) bySig.set(s, p.id); }
    for (const p of theirs) { const id = bySig.get(personaSig(p)); if (id) map.set(p.id, id); }
    return map;
}

/**
 * 新建的卡：备份里它自带的世界书是关着的（worldDisabled），而且备份里有一本书对它生效（关掉自带的那份就是因为有这本——
 * 酒馆 zip 导入时 applyWorldRules 关的；我们自己的备份里，用户在「世界书」页关的也多半是这个原因），
 * 但合并之后【最终的书列表里没有任何一本对它生效】：两份都不生效，这张卡一条世界书都没有了。这时去掉它的 worldDisabled（自带的那份照旧生效），
 * 记进 summary.worldReenabled。
 * 怎么会这样：备份里那本书和本机已有的一本内容相同而被判重，保留的是本机那本和它的开关——本机那本关着，或者是「只对指定的卡」却没绑这张卡
 * （备份那本的绑定只在两本都是「只对指定的卡」时才并过去，见 unionBooks；本机那本关着时并了也不生效）。
 * 本机那本书的开关【不改】（只新增、不改现有的）。
 * 备份里本来就没有书对它生效的（用户自己就是想关掉自带的书）：不动，保持关着。并进本机已有卡的（不是新建的）：本机那张的开关本来就不改，见 worldKept。
 * @param {Object[]} newCards     out.cards（新建的 CardRecord，会被原地改：card 已是拷贝）
 * @param {Object[]} srcEntries   backup.cards
 * @param {any} backupBooks       备份里的 global.books（未清洗）
 * @param {any} finalBooks        导入后存储里的 books
 * @param {Map<string, string>} cardIdMap
 */
function keepEmbeddedWorlds(newCards, srcEntries, backupBooks, finalBooks, cardIdMap, summary) {
    if (!newCards.length) return;
    const theirs = Array.isArray(backupBooks) ? cleanBooks(backupBooks, { strict: true }).list : [];
    const finals = Array.isArray(finalBooks) ? cleanBooks(finalBooks).list : [];
    const byId = new Map(newCards.map(c => [c.id, c]));
    const done = new Set();
    for (const entry of srcEntries) {
        const src = entry?.card;
        if (!isObj(src) || typeof src.id !== 'string' || src.id === '') continue;
        const rec = byId.get(cardIdMap.get(src.id));
        if (!rec || done.has(rec.id) || rec.card?.worldDisabled !== true) continue;
        const why = theirs.filter(b => isBookActiveFor(b, src.id));
        if (!why.length) continue;                                       // 备份里就没有书替它：用户自己关的
        if (finals.some(b => isBookActiveFor(b, rec.id))) continue;      // 合并后还有书对它生效：照旧关着
        done.add(rec.id);
        delete rec.card.worldDisabled;
        // 报的是本机保留下来的那本的名字（判重不看名字，可能和备份里的不一样）；找不到就用备份里的名字
        const names = why.map(b => { const s = bookSig(b); return finals.find(f => bookSig(f) === s)?.name ?? b.name; });
        summary.worldReenabled.push({ srcId: src.id, cardId: rec.id, name: nameOf(src.card?.name, '?'), books: [...new Set(names.map(n => nameOf(n, '?')))] });
    }
}

/** 「卡名」自带的世界书保持启用的说明（整体备份恢复的提示条和酒馆 zip 导入的结果框都用） */
export const worldReenabledText = r => `「${r.name}」自带的世界书保持启用：这里已有的${r.books.map(b => `「${b}」`).join('、')}没有对它生效`;

/**
 * 备份里的 global → 可以拿来用的拷贝（新对象，深拷贝）。只去掉两类键：
 *   - migrate.js 的 NON_GLOBAL_KEYS（card / avatar / chat / variables）：它们属于「当前卡 / 当前存档」。
 *     SmallTalk 自己导出的 global 不会有它们；手改或恶意构造的备份要是带着，写进全局记录后会被赋进运行时 state，
 *     紧接着的保存就会把【当前存档的聊天换成文件里的内容、把当前卡写成别的卡】。
 *   - UNSAFE_KEYS（__proto__ / constructor / prototype）：JSON.parse 会把 "__proto__" 当成普通的自有键，
 *     之后一旦被赋给别的对象，换掉的是那个对象的原型。
 * 做法是「只拷贝自有的、非危险的键」重建一个新对象，而不是在一个可能已被污染的对象上 delete。
 * @returns {{global: Object, dropped: number}}  dropped：去掉了几个键
 */
function safeGlobalCopy(src) {
    const out = {};
    let dropped = 0;
    for (const k of Object.keys(src)) {
        if (NON_GLOBAL_KEYS.includes(k) || UNSAFE_KEYS.includes(k)) { dropped++; continue; }
        out[k] = structuredClone(src[k]);
    }
    return { global: out, dropped };
}

/**
 * 给已有的卡补目录条目（导入时在写入事务里调用：idx 是事务里刚读出来的目录）。
 * 目录不存在或不是这张卡的：不写（返回 null），archive.js loadIndex 发现目录和存档键对不上时会自己重建。
 * 不改 idx，返回新对象。
 */
export function mergeIndex(idx, cardId, chats) {
    if (!isObj(idx) || idx.cardId !== cardId || !isObj(idx.chats)) return null;
    const next = { ...idx, chats: { ...idx.chats } };
    for (const c of chats) next.chats[c.id] = indexEntry(c);
    return next;
}

/**
 * 把备份里的划线（planBackupImport 的 highlightMerges[].copies，按顺序）并进一条本机已有的存档记录（导入时在写入事务里调用：rec 是事务里刚读出来的）。
 * 只改 highlights：消息、变量、作者注释、名字、updatedAt 一律不动（返回的新记录是 {...rec, highlights}）。
 * 按事务里现读的记录重算，而不是直接用计划里的结果：这期间迟到的记忆摘要（state.js patchStoredChat）可能改过这条记录，用旧的会把它盖掉。
 * @returns {{rec: Object|null, added: number, filled: number}}  rec = null：记录不在了 / 没有新东西可并（不写）
 */
export function mergeChatHighlights(rec, copies) {
    if (!isObj(rec)) return { rec: null, added: 0, filled: 0 };
    const doc = chatDoc(rec.messages);
    let list = rec.highlights, added = 0, filled = 0;
    for (const theirs of copies ?? []) {
        const r = mergeHighlights(list, theirs, doc);
        if (r.changed) { list = r.list; added += r.added; filled += r.filled; }
    }
    if (!added && !filled) return { rec: null, added: 0, filled: 0 };
    return { rec: { ...rec, highlights: list }, added, filled };
}

/** 恢复摘要里划线那一句（没有并进任何东西 = null） */
export function highlightMergeText(s) {
    const n = s.highlightsMerged ?? 0, f = s.highlightNotesFilled ?? 0, c = s.highlightChats ?? 0;
    if (!n && !f) return null;
    const bits = [];
    if (n) bits.push(`${n} 条划线并进了这里已有的 ${c} 个存档（存档和备份里的相同，没有另外多出存档）`);
    if (f) bits.push(`${n ? '另外' : ''}给 ${f} 条位置相同、原来没有备注的划线补上了备份里的备注${n ? '' : `（${c} 个存档）`}`);
    return bits.join('，');
}

/**
 * 全局记录里的内容逐类怎么说：[新增数的字段, 跳过数的字段, 量词 + 名字, 跳过时的说法]。
 * 全局变量的「跳过」和别的不一样：本机已有这个键就保留本机的值，备份里的值不一定相同，所以不说「完全相同」。
 */
const CONTENT_SUMMARY = [
    ['personasAdded', 'personasDup', '个人设', n => `${n} 个人设和这里已有的完全相同（名字、描述和备注都一样），跳过`],
    ['booksAdded', 'booksDup', '本世界书', n => `${n} 本世界书和这里已有的内容完全相同，跳过`],
    ['regexAdded', 'regexDup', '条全局正则', n => `${n} 条全局正则和这里已有的内容相同，跳过（保留了这里的开关状态）`],
    ['notesAdded', 'notesDup', '条便签', n => `${n} 条便签和这里已有的标题、内容都相同，跳过（保留了这里的完成状态）`],
    ['varsAdded', 'varsDup', '个全局变量', n => `${n} 个全局变量这里已经有了，保留了这里的值`],
];

/** 同名不同内容的世界书的提醒（整体备份恢复和酒馆 zip 导入的结果里都用这一句） */
export const booksRenamedText = n => `有 ${n} 本世界书和你已有的同名但内容不同，已加上序号保留。`
    + '两个版本都开着、对同一张卡生效时会重复发给模型，请到「世界书」页检查要关掉或删掉哪一本';

/**
 * 导入结果的一句话摘要（给提示条用；跳过的明细另打在控制台）。逐类说清楚新增了几个、跳过了几个重复的，以及应用了哪些设置。
 * @param {Object} s  planBackupImport 的 summary
 */
export function summaryText(s) {
    const bits = [];
    const n = k => s[k] ?? 0;
    const added = s.cardsAdded + s.chatsAdded + s.presetsAdded;
    // 划线并进已有存档也算「带进来了东西」，不说「没有新增任何东西」
    const contentAdded = CONTENT_SUMMARY.reduce((t, [a]) => t + n(a), 0) + n('highlightsMerged') + n('highlightNotesFilled') + (phoneAdded(s.phone) ? 1 : 0);
    const contentDup = CONTENT_SUMMARY.reduce((t, [, d]) => t + n(d), 0);
    if (added) bits.push(`新增 ${s.cardsAdded} 张卡、${s.chatsAdded} 个存档、${s.presetsAdded} 个预设`);
    else if (!contentAdded) bits.push('没有新增任何东西');
    for (const [a, , unit] of CONTENT_SUMMARY) if (n(a)) bits.push(`新增 ${n(a)} ${unit}`);
    if (s.cardsMerged) bits.push(`${s.cardsMerged} 张卡和已有的相同，存档并了进去`);
    const dup = s.chatsDup + s.presetsDup;
    if (dup) bits.push(`跳过了 ${dup} 个重复的（${s.chatsDup} 个存档、${s.presetsDup} 个预设）`);
    for (const [, d, , say] of CONTENT_SUMMARY) if (n(d)) bits.push(say(n(d)));
    const hl = highlightMergeText(s);
    if (hl) bits.push(hl);
    // 手机（会话、聊天预设、表情、壁纸）：ui/backup.js 把 planPhoneImport 的 summary 挂在 s.phone 上
    bits.push(...phoneSummaryBits(s.phone));
    if (!added && !contentAdded && (dup || contentDup || s.phone?.sessionsDup || s.phone?.stickersDup || s.phone?.presetsDup)) bits[0] = '没有新增任何东西：备份里的内容这里都已经有了';
    if (s.renamed.length) bits.push(`${s.renamed.length} 个重名，名字后面加了序号：${s.renamed.slice(0, 3).join('、')}${s.renamed.length > 3 ? ' 等' : ''}`);
    if (n('booksRenamed')) bits.push(booksRenamedText(n('booksRenamed')));
    for (const r of s.worldReenabled ?? []) bits.push(worldReenabledText(r));
    if (n('booksRebound')) bits.push(`${n('booksRebound')} 本已有的世界书和备份里的相同，备份里它绑定的角色卡也绑了上去`);
    if (s.skipped.length) bits.push(`${s.skipped.length} 条记录格式不对被跳过：${s.skipped.slice(0, 3).join('、')}${s.skipped.length > 3 ? ' 等（详见控制台）' : ''}`);
    const applied = s.settingsApplied ?? [];
    if (applied.length) bits.push(`已应用备份里的${applied.map(k => SETTING_LABEL[k]).join('、')}`);
    bits.push(...s.notes);
    return bits.join('；');
}
