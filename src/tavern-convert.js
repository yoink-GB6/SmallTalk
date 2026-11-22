// 酒馆（SillyTavern）整体备份 zip ↔ 我们自己的「备份对象」（types.js BackupFile 的形状）。纯函数 + 读 zip，不碰 DOM / IndexedDB，Node 22 里能跑。
// 界面、弹框、落盘在 src/ui/tavern-ui.js。
//
// 为什么转成「我们自己的备份对象」而不是自己写一套导入：
//   整体备份的恢复流程（src/backup.js planBackupImport + src/ui/backup.js doImport）已经处理了所有难的部分——
//   按内容去重（同一份导入两遍，第二遍全是「跳过」）、并集（人设 / 世界书 / 正则只加不删、重名加序号）、
//   一个写入事务、读回校验、失败撤销、只读 / 生成中 / 切换中的拒绝。酒馆的东西只要在内存里变成同样形状的对象，
//   以「不替换设置」的方式交给它，就全部白拿。这里只负责「转换」这一步。
//
// 导入分三步（都在这个文件）：
//   1. analyzeTavernZip(zip)：只读目录 + settings.json，给预览弹框用的摘要（不读卡、聊天的内容）
//   2. selectionStats(analysis, selection)：按勾选算要读多少个文件、多少字节，超过总量上限就让用户分批
//   3. convertTavernZip(zip, analysis, selection)：按顺序一个一个读、一个一个转换（不并发，免得把所有文件同时解进内存），
//      单个文件坏了只记一条失败，不中断；可以取消（取消 = 返回 {cancelled: true}，调用方什么都不写）
// 导出：buildTavernExport(backup, selection, deps) 把我们的备份对象变成酒馆目录结构的文件列表（交给 tavern-backup.js buildTavernLayout 摆路径）。
//
// 密码 / key：settings.json 只经 tavern-backup.js extractTavernSettings 取人设、全局正则（白名单字段），原始文本和解析出的对象
// 只活在 readSettings 这一个函数里，不进返回值；secrets.json 被 classifyTavernEntries 归进「忽略」，从来不读。

import { readEntry, ZipError } from './zip.js';
import { classifyTavernEntries, extractTavernSettings } from './tavern-backup.js';
import { readCardFromPng, writeCardToPng, dataUrlToBytes, isPng } from './png.js';
import { parseCard, parseWorldbook, detectJsonKind } from './card.js';
import { parseChatFile, serializeChatFile } from './chatfile.js';
import { exportCardJson, serializeWorldbook, safeFileName } from './card-export.js';
import { BACKUP_FORMAT, BACKUP_VERSION, tooDeep, MAX_DEPTH } from './backup.js';
import { cleanPresetBody } from './migrate.js';
import { sanitizePreset, sanitizeNotice } from './preset-sanitize.js';
import { cleanRemark } from './personas.js';

const MB = 1024 * 1024;

/**
 * 各种上限（字节，都是「解压后」的大小；zip 中央目录里声明的大小，读之前就能判断）。
 *   settings  32 MB：酒馆的 settings.json 一般几百 KB 到几 MB（快速回复、扩展设置都在里面），32 MB 足够宽，再大多半不是正常的文件。
 *   card      32 MB：带高清立绘的 PNG 卡常见 2～10 MB；头像要转成 data URL 存进 IndexedDB（再大 1/3），太大的卡在手机上也很吃力。
 *   chat      64 MB：很长的角色扮演聊天（带很多 swipe）能到几十 MB；解析成对象后内存占用是文件的好几倍。
 *   world     16 MB / preset 8 MB：正常的世界书、预设都在 1 MB 以内，这两个只是防异常文件。
 *   total    256 MB：一次导入勾选的全部文件加起来。整个备份对象要在内存里待到写入事务结束，恢复流程还会结构化拷贝一份、
 *                    读回校验时再序列化一遍，峰值内存是原始大小的好几倍；256 MB 在电脑上没问题，手机上已经接近极限。
 *                    超了不读，提示用户少勾几类分批导入（同一份备份分批导入不会重复：已有的会被认出来跳过）。
 */
export const TAVERN_LIMITS = Object.freeze({ settings: 32 * MB, card: 32 * MB, chat: 64 * MB, world: 16 * MB, preset: 8 * MB, total: 256 * MB });

/** 勾选项：每类一个开关。chats 依附于 cards（不导入卡就没有地方挂聊天） */
export const ALL_SELECTED = Object.freeze({ cards: true, chats: true, worlds: true, presets: true, personas: true, regex: true });

const stripExt = name => String(name).replace(/\.[^./]+$/, '');
const utf8 = bytes => new TextDecoder('utf-8').decode(bytes);   // 默认会去掉开头的 BOM
const mb = n => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;

/** 毫秒时间戳 → ISO；无效的返回 null */
function isoOf(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 字节 → base64（分块拼，避免 String.fromCharCode 一次传太多参数爆栈）。btoa 在浏览器和 Node 22 都是全局函数 */
export function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/**
 * PNG 字节 → 头像 data URL。和拖文件导入 PNG 卡时 FileReader.readAsDataURL 的结果逐字相同（同样的 MIME、标准 base64），
 * 所以同一张卡不管从哪条路导入，「卡 + 头像」的内容签名都一样，能被认成重复。
 */
export const pngDataUrl = bytes => `data:image/png;base64,${bytesToBase64(bytes)}`;

/** 读一个条目时出的错 → 给人看的原因 */
function reasonOf(e, limit) {
    if (e instanceof ZipError) {
        if (e.code === 'too-big' || e.code === 'bomb') return `文件太大（上限 ${mb(limit)}）`;
        if (e.code === 'encrypted') return '文件是加密的，暂不支持';
        return e.message;
    }
    if (e instanceof SyntaxError) return '不是合法的 JSON';
    return e?.message ?? String(e);
}

// ───────────────────────────── 1. 分析 ─────────────────────────────

/** 不是酒馆备份 / 打不开时的错误码（界面按它给不同的说法） */
export const ANALYZE_ERRORS = Object.freeze({
    'not-tavern': '这个 zip 不像酒馆的整体备份：里面没有 characters/、chats/、worlds/、OpenAI Settings/ 这些文件夹，也没有 settings.json',
    encrypted: '这个压缩包是加密的（设了密码），暂不支持。请在酒馆里用「备份」重新导出，或用不加密的方式重新打包',
});

/**
 * settings.json → 只含人设、全局正则的摘要。原始文本、解析出的整个对象都只在这个函数里，返回前就丢了。
 * @returns {Promise<{settings: ReturnType<typeof extractTavernSettings>|null, error: string}>}
 */
async function readSettings(zip, entry) {
    if (!entry) return { settings: null, error: '' };
    if (entry.size > TAVERN_LIMITS.settings) return { settings: null, error: `settings.json 太大（${mb(entry.size)}，上限 ${mb(TAVERN_LIMITS.settings)}），人设和全局正则没有读` };
    try {
        let text = utf8(await readEntry(zip, entry, { maxSize: TAVERN_LIMITS.settings }));
        let obj = JSON.parse(text);
        text = null;
        const settings = extractTavernSettings(obj);
        obj = null;
        return { settings, error: '' };
    } catch (e) {
        return { settings: null, error: `settings.json 读不出来（${reasonOf(e, TAVERN_LIMITS.settings)}），人设和全局正则没有读` };
    }
}

/**
 * @typedef {Object} TavernAnalysis
 * @property {true} ok
 * @property {string} strippedPrefix          自动剥掉的外层文件夹名
 * @property {{fileName: string, baseName: string, entry: Object, chats: {fileName: string, entry: Object}[]}[]} cards
 *           要导入的卡（同名的 .png 和 .json 只留 .png），各自挂着 chats/<baseName>/ 下的聊天
 * @property {string[]} shadowed              因为有同名 .png 而不导入的 .json 卡
 * @property {string[]} duplicates            和前面一张卡同名（去掉扩展名后一样、扩展名也同类：两个 .png 或两个 .json）而不导入的卡，只导入第一个
 * @property {{dir: string, count: number, bytes: number}[]} orphans   没有对应角色卡的聊天目录（跳过）
 * @property {{name: string, fileName: string, entry: Object}[]} worlds
 * @property {{name: string, fileName: string, entry: Object}[]} presets
 * @property {{name: string, description: string, remark: string}[]} personas   remark = 酒馆的 title（备注），'' = 没有
 * @property {Object[]} regexScripts          extractTavernSettings 的 regexScripts（只有白名单字段）
 * @property {string[]} globalWorlds          酒馆里全局选中的世界书名字（extractTavernSettings 的 globalWorlds；可能有 zip 里没有的书）
 * @property {number} globalWorldCount        worlds 里名字在 globalWorlds 中的本数（预览框用）
 * @property {boolean} hasSettings
 * @property {string} settingsError           settings.json 没读成时的说明（'' = 没问题或没有这个文件）
 * @property {string[]} uncertain             名字编码不确定（可能是乱码）的条目
 * @property {{total: {count: number, bytes: number}, byTop: {name: string, count: number, bytes: number}[]}} ignored
 */

/**
 * 打开之后的第一步：分类、读 settings.json、算预览要用的数字。不读卡和聊天的内容。
 * @param {{blob: Blob, entries: Object[]}} zip   zip.js openZip 的返回值
 * @returns {Promise<TavernAnalysis | {ok: false, code: string, error: string}>}
 */
export async function analyzeTavernZip(zip) {
    const c = classifyTavernEntries(zip.entries);
    // classifyTavernEntries 只凭 settings.json / characters/ 认；我们自己导出的 zip 如果只勾了世界书或预设，就只有 worlds/ 或 OpenAI Settings/，也要认
    if (!c.isTavern && !c.worlds.length && !c.presets.length && !c.chatGroups.length) return { ok: false, code: 'not-tavern', error: ANALYZE_ERRORS['not-tavern'] };
    const relevant = [...c.cards.map(x => x.entry), ...c.chatGroups.flatMap(g => g.files.map(f => f.entry)), ...c.worlds.map(x => x.entry), ...c.presets.map(x => x.entry), ...(c.settings ? [c.settings] : [])];
    if (relevant.some(e => e.encrypted)) return { ok: false, code: 'encrypted', error: ANALYZE_ERRORS.encrypted };

    // 同一个文件名（去扩展名）既有 .png 又有 .json：只要 .png（头像就是它；酒馆自己也是以 png 为准）
    // 同类的（两个 .png、两个 .json，比如大小写不同的扩展名）同名：只要第一个，记进 duplicates。
    // 以前两种情况都记进 shadowed，预览里就把「两张同名 .png」也说成「.json 有同名的 .png」，不对
    const byBase = new Map();
    const shadowed = [], duplicates = [];
    const isPngFile = n => /\.png$/i.test(n);
    for (const card of c.cards) {
        const prev = byBase.get(card.baseName);
        if (!prev) { byBase.set(card.baseName, card); continue; }
        const nowPng = isPngFile(card.fileName), prevPng = isPngFile(prev.fileName);
        if (nowPng && !prevPng) { shadowed.push(prev.fileName); byBase.set(card.baseName, card); }
        else if (!nowPng && prevPng) shadowed.push(card.fileName);
        else duplicates.push(card.fileName);
    }
    // 聊天挂到卡上：目录名 = 卡的文件名去掉扩展名（酒馆 chats.js 的规则，见 tavern-backup.js 文件头）
    const groups = new Map(c.chatGroups.map(g => [g.dir, g.files]));
    const cards = [...byBase.values()].map(card => ({ fileName: card.fileName, baseName: card.baseName, entry: card.entry, chats: groups.get(card.baseName) ?? [] }));
    const orphans = c.chatGroups.filter(g => !byBase.has(g.dir))
        .map(g => ({ dir: g.dir, count: g.files.length, bytes: g.files.reduce((n, f) => n + (f.entry.size || 0), 0) }));

    const { settings, error: settingsError } = await readSettings(zip, c.settings);
    return {
        ok: true,
        strippedPrefix: c.strippedPrefix,
        cards, shadowed, duplicates, orphans,
        worlds: c.worlds,
        presets: c.presets,
        personas: (settings?.personas ?? []).map(p => ({ name: p.name, description: p.description, remark: cleanRemark(p.title) })),
        regexScripts: settings?.regexScripts ?? [],
        globalWorlds: settings?.globalWorlds ?? [],
        globalWorldCount: c.worlds.filter(w => (settings?.globalWorlds ?? []).includes(w.name)).length,
        hasSettings: !!c.settings,
        settingsError,
        uncertain: relevant.filter(e => e.nameUncertain).map(e => e.name),
        ignored: c.ignored,
    };
}

// ───────────────────────────── 2. 勾选后的规模 ─────────────────────────────

/** 规范化勾选：缺的当 false；不选卡就不能选聊天 */
export function normalizeSelection(sel = {}) {
    const s = Object.fromEntries(Object.keys(ALL_SELECTED).map(k => [k, !!sel[k]]));
    if (!s.cards) s.chats = false;
    return s;
}

/**
 * 按勾选要读的文件（读的顺序也在这里定）：先读所有卡（卡读坏了，它的聊天就不用读了），其余按在 zip 里的位置顺着读，
 * 这样对大文件是从头到尾顺序取片段，不来回跳。
 * @returns {{kind: 'card'|'chat'|'world'|'preset', item: Object, card?: Object}[]}
 */
function workList(a, sel) {
    const byPos = (x, y) => x.item.entry.localOffset - y.item.entry.localOffset;
    const cards = sel.cards ? a.cards.map(item => ({ kind: 'card', item })).sort(byPos) : [];
    const rest = [
        ...(sel.chats ? a.cards.flatMap(card => card.chats.map(item => ({ kind: 'chat', item, card }))) : []),
        ...(sel.worlds ? a.worlds.map(item => ({ kind: 'world', item })) : []),
        ...(sel.presets ? a.presets.map(item => ({ kind: 'preset', item })) : []),
    ].sort(byPos);
    return [...cards, ...rest];
}

/**
 * 勾选之后要读多少个文件、多少字节（解压后），有没有超过一次导入的总量上限。
 * @returns {{files: number, bytes: number, tooBig: boolean, limit: number}}
 */
export function selectionStats(a, selection) {
    const sel = normalizeSelection(selection);
    const work = workList(a, sel);
    const bytes = work.reduce((n, w) => n + (w.item.entry.size || 0), 0);
    return { files: work.length, bytes, tooBig: bytes > TAVERN_LIMITS.total, limit: TAVERN_LIMITS.total };
}

// ───────────────────────────── 3. 转换 ─────────────────────────────

const LIMIT_OF = { card: TAVERN_LIMITS.card, chat: TAVERN_LIMITS.chat, world: TAVERN_LIMITS.world, preset: TAVERN_LIMITS.preset };
const KIND_LABEL = { card: '角色卡', chat: '聊天', world: '世界书', preset: '预设' };

/** 一个文件的读取：先按声明的大小拒绝（不用解压就知道），再按同样的上限解压 */
async function readLimited(zip, entry, kind) {
    const limit = LIMIT_OF[kind];
    if (entry.size > limit) throw new Error(`文件太大（${mb(entry.size)}，上限 ${mb(limit)}）`);
    try { return await readEntry(zip, entry, { maxSize: limit }); } catch (e) { throw new Error(reasonOf(e, limit)); }
}

/** 一张卡 → {card: Card, avatar}。PNG 走 png.js 读卡（头像就是这张图），JSON 走 card.js（和拖文件导入同一套） */
function convertCard(bytes, fileName) {
    if (/\.png$/i.test(fileName)) {
        let json;
        try { json = readCardFromPng(bytes); } catch (e) { throw new Error(e instanceof SyntaxError ? 'PNG 里的卡数据不是合法的 JSON' : e.message); }
        return { card: parseCard(json), avatar: pngDataUrl(bytes) };
    }
    const json = JSON.parse(utf8(bytes));
    if (detectJsonKind(json) !== 'card') throw new Error('这个 JSON 不像角色卡');
    return { card: parseCard(json), avatar: '' };
}

/**
 * 转换出来的东西能不能交给后面的恢复流程。现在只查嵌套深度：卡的 JSON 嵌套极深（比如两万层的数组）时，
 * 后面 backup.js planBackupImport 的 canonical（JSON.stringify）、结构化拷贝、IndexedDB 都会爆栈抛 RangeError，
 * 以前一张这样的坏卡就让整次导入失败。在这里就地查出来，只把【这一个】记成失败，别的照常导入。
 * tooDeep 不递归，所以查的时候自己不会爆栈；它是线性的，比真去序列化一遍便宜（不分配字符串）。
 */
function assertSane(v) {
    if (tooDeep(v, MAX_DEPTH)) throw new Error(`内容嵌套得太深（超过 ${MAX_DEPTH} 层），文件可能损坏了，没法导入`);
}

/** 最后一条消息的发送时间（存档的「更新时间」用它；读不出来返回 null） */
function lastSendIso(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = Date.parse(messages[i]?.sendDate ?? '');
        if (Number.isFinite(t)) return new Date(t).toISOString();
    }
    return null;
}

/**
 * 按勾选逐个读取、转换，拼成一份备份对象。
 * @param {{blob: Blob, entries: Object[]}} zip
 * @param {TavernAnalysis} a
 * @param {Object} selection
 * @param {{onProgress?: (p: {done: number, total: number, label: string}) => void, isCancelled?: () => boolean, now?: Date}} [opts]
 *        isCancelled：每读一个文件之前问一次；返回真 = 立刻停，返回 {cancelled: true}
 * @returns {Promise<{cancelled: true} | {cancelled: false, backup: Object, failures: {what: string, reason: string}[], warnings: string[], counts: Object, worldRules: Object}>}
 *          counts：转换成功的个数 {cards, chats, worlds, presets, personas, regex}
 *          worldRules：世界书按什么规则导入的（见 applyWorldRules）{global, bound, off, cardsOff: {cardId, card, book}[]}
 *          backup：types.js BackupFile 的形状（format / version / global / presets / cards），没有 endpoints
 */
export async function convertTavernZip(zip, a, selection, { onProgress, isCancelled, now = new Date() } = {}) {
    const sel = normalizeSelection(selection);
    const work = workList(a, sel);
    const nowIso = now.toISOString();
    const failures = [], warnings = [];
    const cardOut = new Map();     // 分析结果里的卡对象 → {rec, chats: []}
    const books = [], presets = [];
    let done = 0;

    for (const w of work) {
        if (isCancelled?.()) return { cancelled: true };
        const { kind, item } = w;
        const label = kind === 'chat' ? `${w.card.baseName}/${item.fileName}` : item.fileName;
        onProgress?.({ done, total: work.length, label: `${KIND_LABEL[kind]}「${label}」` });
        const fail = reason => failures.push({ what: `${KIND_LABEL[kind]}「${label}」`, reason });
        try {
            if (kind === 'chat' && !cardOut.has(w.card)) { fail('所属的角色卡没能导入'); continue; }
            const bytes = await readLimited(zip, item.entry, kind);
            const mtime = isoOf(item.entry.mtime) ?? nowIso;
            if (kind === 'card') {
                const { card, avatar } = convertCard(bytes, item.fileName);
                assertSane(card);
                // id 只是这份备份对象里的临时 id（恢复流程会全部换成新 id），用来让 activeChatId 指得上
                cardOut.set(item, { rec: { id: `tavern-card-${cardOut.size}`, card, avatar, createdAt: mtime, usedAt: mtime, activeChatId: null }, chats: [] });
            } else if (kind === 'chat') {
                const parsed = parseChatFile(utf8(bytes));
                if (!parsed.messages.length && !Object.keys(parsed.stHeader).length) { fail('里面没有读出任何消息，不像酒馆的聊天记录'); continue; }
                assertSane(parsed.messages); assertSane(parsed.variables); assertSane(parsed.stHeader);
                const bad = parsed.warnings.filter(x => !x.startsWith('文件没有头'));
                if (bad.length) warnings.push(`聊天「${label}」：${bad.length} 处问题已跳过（${bad.slice(0, 2).join('；')}${bad.length > 2 ? '……' : ''}）`);
                const out = cardOut.get(w.card);
                out.chats.push({
                    id: `${out.rec.id}-chat-${out.chats.length}`, cardId: out.rec.id,
                    // 存档名 = 聊天文件名去掉扩展名（和单个 .jsonl 导入一致）
                    name: stripExt(item.fileName) || parsed.name || '导入的存档',
                    createdAt: parsed.createdAt ?? mtime, updatedAt: lastSendIso(parsed.messages) ?? mtime,
                    messages: parsed.messages, variables: parsed.variables, stHeader: parsed.stHeader,
                    // 作者注释（头的 chat_metadata.note_*，和单个 .jsonl 导入一致）：默认值时不写
                    ...(parsed.authorNote ? { authorNote: parsed.authorNote } : {}),
                });
            } else if (kind === 'world') {
                const json = JSON.parse(utf8(bytes));
                if (detectJsonKind(json) !== 'worldbook') { fail('这个 JSON 不像世界书'); continue; }
                const entries = parseWorldbook(json, item.name);
                assertSane(entries);
                books.push({ name: item.name, entries });
            } else {
                const json = JSON.parse(utf8(bytes));
                if (detectJsonKind(json) !== 'preset') { fail('这个 JSON 不像对话补全预设（没有 prompts / prompt_order）'); continue; }
                assertSane(json);
                // 去掉酒馆写进预设的连接信息（反代地址 / 密码、附加请求头……）、校正正则（migrate.js cleanPresetBody）。
                // 恢复流程里还会再洗一遍；这里先洗，是为了在结果里说一句，并且让密码不在这份备份对象里多待
                const c = cleanPresetBody(json);
                const note = sanitizeNotice(c.filled, `预设「${item.name}」`);
                if (note) warnings.push(note);
                presets.push({ id: `tavern-preset-${presets.length}`, name: item.name, preset: c.preset, createdAt: mtime, updatedAt: mtime });
            }
        } catch (e) {
            // RangeError：多半是嵌套太深在别处（解析、转换）爆了栈，提示说人话
            fail(e instanceof SyntaxError ? '不是合法的 JSON' : e instanceof RangeError ? '内容嵌套得太深，文件可能损坏了，没法导入' : (e?.message ?? String(e)));
        } finally {
            done++;
        }
    }
    if (isCancelled?.()) return { cancelled: true };
    onProgress?.({ done, total: work.length, label: '' });

    // 卡：停在最近更新的那个存档上；「上次使用」= 那个存档的更新时间（恢复流程按它挑导入后切到哪张卡）。
    // 没有聊天的卡 usedAt 为 ''（「存档」页显示「—」，排在最后）：不然它的 usedAt 只能用 zip 里的文件时间，往往比聊天的时间新，
    // 空浏览器导入后会切到这张没有聊天的卡、还顺手给它开一个新存档，而不是落在最近聊过的那段上
    const cards = [...cardOut.values()].map(({ rec, chats }) => {
        const latest = chats.reduce((b, ch) => (!b || ch.updatedAt > b.updatedAt ? ch : b), null);
        return { card: { ...rec, activeChatId: latest?.id ?? null, usedAt: latest?.updatedAt ?? '' }, chats };
    });

    // 世界书开不开、对谁生效，卡自带的内嵌书关不关：按酒馆里的关系（全局选中 / 卡绑定），规则见 applyWorldRules。
    // 关掉了哪几张卡的自带世界书由 ui/tavern-ui.js 在结果框里列（要和恢复时的判重结果对照，见 summary.worldKept）
    const worldRules = applyWorldRules(books, cards, a.globalWorlds ?? []);

    // 全局记录里只放「内容」：额外世界书、全局正则、人设。没有任何设置字段——恢复时以「不替换设置」走，设置本来也不会被用
    const g = {};
    if (books.length) g.books = books;
    const regex = sel.regex ? a.regexScripts : [];
    // 没有 id 的给一个固定的（判重时不看 id，见 backup.js regexSig；和本机撞了恢复流程会换新的）
    if (regex.length) g.globalRegex = regex.map((s, i) => ({ ...s, id: s.id ?? `tavern-regex-${i}` }));
    const personas = sel.personas ? a.personas : [];
    if (personas.length) {
        // 备注为空时不写 remark 键（和本机的存储形状一致，见 types.js GlobalRecord.persona）
        const list = personas.map((p, i) => {
            const remark = cleanRemark(p.remark);
            return { id: `tavern-persona-${i}`, name: String(p.name ?? '').trim() || 'User', description: String(p.description ?? ''), ...(remark ? { remark } : {}) };
        });
        // 当前人设写成第一个只是为了形状完整：恢复时不替换设置，本机的当前人设不会变
        const { id: _id, ...first } = list[0];
        Object.assign(g, { persona: first, personas: list, activePersonaId: list[0].id });
    }
    const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: nowIso, global: Object.keys(g).length ? g : null, presets, cards };
    const counts = { cards: cards.length, chats: cards.reduce((n, c) => n + c.chats.length, 0), worlds: books.length, presets: presets.length,
        personas: personas.length, regex: regex.length };
    return { cancelled: false, backup, failures, warnings, counts, worldRules };
}

/**
 * 世界书按酒馆里的关系决定导入后开不开、对谁生效（原地给 books 里的书写 enabled / scope / cards，写法见 books.js），
 * 以及卡自带的内嵌书关不关（原地给卡写 Card.worldDisabled）。
 *
 * 先说酒馆实际怎么用世界书（1.19 源码）：
 *   - 生成时，卡的世界书只读卡【指名绑定】的那本文件：public/scripts/world-info.js getCharacterLore 取 data.extensions.world，
 *     loadWorldInfo(书名) 去 worlds/<书名>.json 读。卡里内嵌的 data.character_book【运行时根本不用】。
 *   - 内嵌的那份只是保存角色时服务端顺手写进卡里的拷贝（src/endpoints/characters.js ~L628–640：读 data.world 指名的书文件，
 *     写成 character_book），用户只改了世界书、没重存角色时，它就是旧的；绑定换过书时甚至是另一本书的内容。
 *   - 导入一张带内嵌书的卡时，酒馆问用户要不要把内嵌书导成一本世界书并绑定（world-info.js checkEmbeddedWorld → importEmbeddedWorldInfo）。
 * 所以规则（一行一种情况）：
 *   | 情况                                                              | 书                         | 卡自带的内嵌书 |
 *   | 书名在全局选中列表里（settings.json world_info.globalSelect）       | 启用、所有聊天               | 绑定它的卡：关掉 |
 *   | 某张导入的卡用 extensions.world 指名绑定了它，书文件在这次的 books 里 | 启用、只对这些卡（scope 'cards'）| 关掉（酒馆用的是文件那本）|
 *   | 卡指名绑定了一本书，但 books 里没有（zip 里没有、没勾世界书、读失败）  | —                          | 保持启用（它是唯一的一份）|
 *   | 卡没绑定任何书，但有内嵌书                                          | —                          | 保持启用（和单独导入一张卡一样）|
 *   | 既没全局选中、也没被卡绑定的书                                       | 关闭、所有聊天               | — |
 *   「又全局选中、又被卡绑定」：书按全局（启用、所有聊天；酒馆 getCharacterLore 发现卡绑的书已经在全局里就跳过不重复加载），
 *   绑定它的卡的内嵌书照样关掉——不然同一本书的两份都开着，条目发两遍。
 *   只有内嵌书真有条目（worldEntries 非空）时才写 worldDisabled（空书关不关都一样，默认值不写）。
 * cards 里是这份备份对象里的临时卡 id（'tavern-card-N'）；恢复流程 planBackupImport 用 cardIdMap 换算成最终落进存储的 id——
 *   卡和本机已有的相同而被判重跳过时，书绑到本机那张；本机那张卡的开关【不改】（只新增、不改现有的；判重本来就不看这个开关，
 *   见 backup.js cardSig），于是它开着的内嵌书和新导入的书可能重复：planBackupImport 把这种卡记在 summary.worldKept，结果框提醒一句。
 *   书和本机已有的一本内容相同而被判重时，保留的是本机那本和它的开关；本机那本关着 / 没对这张新卡生效的话，这里关掉的内嵌书
 *   会在 planBackupImport 里重新打开（backup.js keepEmbeddedWorlds，summary.worldReenabled），不然这张卡一条世界书都没有。
 * 没勾「角色卡」（cards 为空）时看不到卡的绑定，非全局的书都导入为关闭。卡要是本机早先已经导入过、这次没勾，同样认不出绑定。
 * 名字按原样精确比较（酒馆也是拿书名字符串直接找 worlds/<名>.json）。
 * 聊天绑定的世界书（chat_metadata.world_info）、酒馆的「额外绑定」（world_info.charLore）没有处理。
 * @param {{name: string, entries: Object[]}[]} books   convertTavernZip 读出的世界书（会被原地改）
 * @param {{card: {id: string, card: Object}}[]} cards  convertTavernZip 拼好的卡（card.card 是 parseCard 的结果，raw 是原始 JSON；会被原地改）
 * @param {string[]} globalWorlds
 * @returns {{global: number, bound: number, off: number, cardsOff: {cardId: string, card: string, book: string}[]}}
 *          global：启用、所有聊天；bound：启用、只对指定的卡；off：关闭、所有聊天；
 *          cardsOff：自带的内嵌书被关掉的卡（临时 id、卡名、它绑定的书名）
 */
export function applyWorldRules(books, cards, globalWorlds) {
    const globalSet = new Set(globalWorlds);
    const names = new Set(books.map(b => b.name));
    const boundBy = new Map();   // 书名 → [临时卡 id]
    const out = { global: 0, bound: 0, off: 0, cardsOff: [] };
    for (const { card: rec } of cards) {
        const ext = rec?.card?.raw?.data?.extensions;
        const world = ext && typeof ext === 'object' ? ext.world : undefined;
        if (typeof world !== 'string' || !world) continue;
        if (!boundBy.has(world)) boundBy.set(world, []);
        boundBy.get(world).push(rec.id);
        // 绑定的书文件这次一起导进来了：酒馆运行时用的是它，卡自带的那份关掉
        if (names.has(world) && (rec.card.worldEntries?.length ?? 0) > 0) {
            rec.card.worldDisabled = true;
            out.cardsOff.push({ cardId: rec.id, card: rec.card.name, book: world });
        }
    }
    for (const b of books) {
        delete b.enabled; delete b.scope; delete b.cards;
        if (globalSet.has(b.name)) { out.global++; continue; }
        const by = boundBy.get(b.name);
        if (by) {
            b.scope = 'cards';
            b.cards = [...new Set(by)];
            out.bound++;
            continue;
        }
        b.enabled = false;
        out.off++;
    }
    return out;
}

// ───────────────────────────── 导出：我们的数据 → 酒馆目录 ─────────────────────────────

/** 导出的勾选：角色卡、聊天记录（依附于卡）、额外世界书、预设 */
export const EXPORT_ALL = Object.freeze({ cards: true, chats: true, worlds: true, presets: true });

/** 导出的文件名：SmallTalk导出-酒馆格式-20261122.zip（本地日期） */
export function tavernExportFileName(date = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `SmallTalk导出-酒馆格式-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.zip`;
}

/**
 * Node / 测试用的「卡 → 文件」：头像是 PNG 就把卡写进图里，否则导出 JSON。
 * 浏览器里用 ui/export-st.js 的 cardToFile（它还能把 JPEG / WebP 头像画成 PNG）；两者对 PNG 头像的结果相同（都是 writeCardToPng）。
 * @returns {Promise<{data: Uint8Array, fileName: string, note?: string}>}
 */
export async function cardToFileNode(card, avatar) {
    const json = exportCardJson(card, { stripPrivate: true });
    if (avatar) {
        try {
            const bytes = dataUrlToBytes(avatar);
            if (isPng(bytes)) return { data: writeCardToPng(bytes, json), fileName: safeFileName(card.name, 'png') };
        } catch { /* 头像坏了：退回 JSON */ }
    }
    return { data: new TextEncoder().encode(JSON.stringify(json, null, 4)), fileName: safeFileName(card.name, 'json') };
}

/** 在 used 里找一个不重复的原始文件名（只是让每张卡的「原始文件名」互不相同，最终的清洗和去重由 buildTavernLayout 做） */
function uniqueRaw(fileName, used) {
    let name = fileName;
    const m = /^(.*?)(\.[^.]+)?$/.exec(fileName);
    for (let n = 2; used.has(name); n++) name = `${m[1]} (${n})${m[2] ?? ''}`;
    used.add(name);
    return name;
}

/**
 * 我们的备份对象（backup.js buildBackup 的结果）→ buildTavernLayout 的输入。按勾选逐个生成（卡要画 PNG，可能慢），能报进度、能取消。
 * 不带的东西：settings.json、接口和 key、人设、全局正则、便签、全局变量（备份对象里有 global，但这里只取 global.books）。
 * 外置记忆摘要挂在消息上：serializeChatFile 把它写在每条消息的 extra.smalltalk 里，和「存档」页单个存档的导出完全一致。
 *
 * 卡的文件名和聊天目录名必须对得上：buildTavernLayout 按「卡的原始 fileName」查最终目录名，
 * 两张同名的卡如果传同一个 fileName，第二张的聊天会被放进第一张的目录。所以这里先把原始 fileName 弄成互不相同的。
 *
 * @param {{global: Object|null, presets: Object[], cards: {card: Object, chats: Object[]}[]}} backup
 * @param {Object} selection  {cards, chats, worlds, presets}
 * @param {{cardToFile: (card: Object, avatar: string) => Promise<{data: Uint8Array, fileName: string, note?: string}>,
 *          userName?: string, onProgress?: Function, isCancelled?: () => boolean}} deps
 * @returns {Promise<{cancelled: true} | {cancelled: false, input: {cards, chats, worlds, presets}, counts: Object, notes: string[]}>}
 */
export async function buildTavernExport(backup, selection, { cardToFile, userName = 'User', onProgress, isCancelled }) {
    const sel = { cards: !!selection?.cards, chats: !!selection?.cards && !!selection?.chats, worlds: !!selection?.worlds, presets: !!selection?.presets };
    const books = sel.worlds && Array.isArray(backup.global?.books) ? backup.global.books.filter(b => b && Array.isArray(b.entries)) : [];
    const presetList = sel.presets ? backup.presets.filter(p => p && p.preset && typeof p.preset === 'object') : [];
    const cardList = sel.cards ? backup.cards : [];
    const total = cardList.length + (sel.chats ? cardList.reduce((n, c) => n + c.chats.length, 0) : 0) + books.length + presetList.length;
    const input = { cards: [], chats: [], worlds: [], presets: [] };
    const notes = [];
    const used = new Set();
    let done = 0;
    const step = async label => {
        if (isCancelled?.()) return false;
        onProgress?.({ done, total, label });
        // 让出一下主线程：进度能画出来，「取消」按钮也点得动
        await new Promise(r => setTimeout(r, 0));
        return !isCancelled?.();
    };

    for (const { card: rec, chats } of cardList) {
        const name = rec?.card?.name ?? '?';
        if (!await step(`角色卡「${name}」`)) return { cancelled: true };
        const f = await cardToFile(rec.card, rec.avatar ?? '');
        if (f.note) notes.push(`「${name}」：${f.note}`);
        const fileName = uniqueRaw(f.fileName, used);
        input.cards.push({ fileName, data: f.data });
        done++;
        if (!sel.chats) continue;
        for (const ch of chats) {
            if (!await step(`聊天「${ch.name}」`)) return { cancelled: true };
            // 和「存档」页的单个导出同一套序列化（swipes、不认识的字段、记忆摘要都按那边的规则）
            const text = serializeChatFile(ch, { userName, characterName: name });
            input.chats.push({ card: fileName, fileName: `${ch.name || '聊天'}.jsonl`, data: new TextEncoder().encode(text) });
            done++;
        }
    }
    for (const b of books) {
        if (!await step(`世界书「${b.name}」`)) return { cancelled: true };
        input.worlds.push({ name: String(b.name ?? ''), data: JSON.stringify(serializeWorldbook(b.entries), null, 4) });
        done++;
    }
    for (const p of presetList) {
        if (!await step(`预设「${p.name}」`)) return { cancelled: true };
        // 预设本体就是酒馆的原始 JSON（导入时存的），原样写回——只去掉酒馆的连接信息（反代地址 / 密码等）。
        // 入口都清洗过，buildBackup 也去过一遍；这里是出口的最后一道兜底（调用方传进来的不一定是 buildBackup 的结果）
        input.presets.push({ name: String(p.name ?? ''), data: JSON.stringify(sanitizePreset(p.preset).preset, null, 4) });
        done++;
    }
    onProgress?.({ done, total, label: '' });
    const counts = { cards: input.cards.length, chats: input.chats.length, worlds: input.worlds.length, presets: input.presets.length };
    return { cancelled: false, input, counts, notes };
}
