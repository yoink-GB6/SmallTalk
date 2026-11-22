// 酒馆助手（JS-Slash-Runner）脚本的数据层：从卡的原始 JSON 里读出脚本树、规范化、判断改没改、导出时合并回原始 JSON。
// 纯函数，不碰 DOM / IndexedDB，浏览器和 Node 都能直接加载。第 1 期只有数据和「脚本」页，脚本【不运行】。
//
// 格式依据（只学格式、字段名，实现是自己写的；酒馆助手的许可是 PolyForm Noncommercial，不搬它的代码）：
//   酒馆助手 4.12.2 的 src/type/scripts.ts（新格式 Script / ScriptFolder）、src/type/backward.ts（旧格式）、
//   src/store/settings/character.ts（卡里存在哪、什么时候迁移旧键）。详细的对照表见 docs/tavern-helper-plan.md §1.1。
//
// ── 卡里存在哪 ──
//   新：data.extensions.tavern_helper = {scripts: ScriptTree[], variables: {...}}。这个值也可能是 [[键, 值], ...] 数组
//       （酒馆助手读的时候数组就 Object.fromEntries）。只要 tavern_helper 这个键在（哪怕值是坏的），就不再看旧键——和酒馆助手一致。
//   旧：data.extensions.TavernHelper_scripts（脚本树）+ TavernHelper_characterScriptVariables（角色卡变量）。
//       每项可能是 {type:'script', value: 旧脚本}、{type:'folder', id, name, icon, color, value: 旧脚本[]}、或者裸的旧脚本。
//       旧脚本 = {enabled, name, id, content, info, buttons: [{name, visible}], data}。
//   V1 卡（没有 data）里没有地方放，读出来是空的。
//
// ── 我们自己存什么（types.js Card.scripts）──
//   【缺省 = 跟着 raw】：卡记录里没有 scripts 字段时，cardScripts(card) 现场从 raw 解析，已导入的卡不用迁移，没用过这个功能的卡存储形状不变。
//   用户在「脚本」页第一次改动时才把整棵（规范化后的）树写进 card.scripts，之后一直有（删光了就是 []）。
//
// ── 规范化（读入容错）──
//   - 统一成新格式：脚本 {type:'script', enabled, name, id, content, info, button:{enabled, buttons}, data, export_with:{data, button}}，
//     文件夹 {type:'folder', enabled, name, id, icon, color?, scripts}；文件夹只有一层（文件夹里的文件夹认不出来）。
//   - 字段类型不对的按酒馆助手的默认值处理（enabled 只认 true；name / content / info 数字转成文字、别的当空；
//     button.enabled、export_with.* 只有 false 才是关）。我们比酒馆助手宽松：它遇到一个坏字段整张卡的脚本都读不出来，我们只校正那一个字段。
//   - 我们不认识的字段原样保留（以后的酒馆助手版本加的），__proto__ / constructor / prototype 这几个键不带进规范化结果。
//   - 认不出来的条目（不是对象、type 不认识、文件夹里套文件夹）不进列表，但留在 raw 里：导出时原样写回（见 mergeList）。
//   - id 缺失 / 重复时补一个【确定的】id（同一份 raw 每次解析出的一样），这样「导入时的样子」和「现在」才对得上号。
//
// ── 导出（cardJsonWithScripts，card-export.js exportCardJson 调它）──
//   现在的树和 parseCardScripts(raw) 一样（没在「脚本」页动过，或改了又改回去）→ raw 一字不动（逐字相同是硬要求）。
//   不一样 → 只改动过的地方：
//     - 新格式的卡：容器的形状不变（对象还是对象、[[k,v]] 还是数组，variables 等别的键不动）；
//       每个条目按 id 对回原条目，没变的条目原样（连我们规范化时改过的写法都不动），变了的只改变了的字段，新增的整条写，删了的不写；
//       认不出来的原条目原样留着（跟在它在原文件里前面那一条后面）。
//     - 旧键的卡：照酒馆助手自己的迁移写成新格式 tavern_helper = {scripts, variables: 旧的角色卡变量}，删掉两个旧键（酒馆助手读到旧键也会这么做）。
//     - 原来没有脚本的卡：写 tavern_helper = {scripts, variables: {}}；V1 卡先升级成 V2（和世界书 / 正则一样，由 card-export.js 处理）。
//   export_with（导出时清空脚本变量 / 按钮）这一期【不做】：脚本不运行，data 只是卡里原来带的，原样带出最忠实。第 2 期有了运行时的脚本变量再说。
//
// ── 判重（backup.js cardSig）──
//   脚本树算卡的内容：代码、名字、开关（enabled）都算——和卡自带正则的 disabled 一样（它们都写在卡文件里，导出卡时带走）；
//   卡自带世界书的整本开关 worldDisabled 是 SmallTalk 自己的字段、不进卡文件，所以不算。用 cardScripts(card) 比，
//   于是「缺省跟着 raw」和「写了但一样」判成同一张卡。

/** @typedef {import('./types.js').Script} Script */
/** @typedef {import('./types.js').ScriptFolder} ScriptFolder */
/** @typedef {import('./types.js').ScriptTree} ScriptTree */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** 酒馆助手的 z.coerce.string 的宽松版：字符串原样，数字 / 布尔转文字，别的（null、对象、数组）当空 */
const coerceStr = v => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');

/** JSON 语义的相等：键顺序无关，值为 undefined 的键视同不存在（和 card-export.js 里那个一样） */
export function jsonEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => jsonEqual(x, b[i]));
    }
    if (isObj(a) && isObj(b)) {
        const ka = Object.keys(a).filter(k => a[k] !== undefined);
        const kb = Object.keys(b).filter(k => b[k] !== undefined);
        if (ka.length !== kb.length) return false;
        return ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
    }
    return false;
}

/** 对象的自有键里除了 skip 和危险键以外的，原样拷到一个新对象（值不深拷贝） */
function extras(o, skip) {
    const out = {};
    for (const k of Object.keys(o)) if (!skip.has(k) && !UNSAFE.has(k)) out[k] = o[k];
    return out;
}

const SCRIPT_KEYS = new Set(['type', 'enabled', 'name', 'id', 'content', 'info', 'button', 'data', 'export_with']);
const FOLDER_KEYS = new Set(['type', 'enabled', 'name', 'id', 'icon', 'color', 'scripts']);
const LEGACY_SCRIPT_KEYS = new Set(['type', 'enabled', 'name', 'id', 'content', 'info', 'buttons', 'data']);

function normButtons(list) {
    if (!Array.isArray(list)) return [];
    // 酒馆助手的 ScriptButton：{name: z.coerce.string(), visible: z.boolean()}；旧格式 visible 缺省 true。不是对象的按钮丢掉
    return list.filter(isObj).map(b => ({ ...extras(b, new Set(['name', 'visible'])), name: coerceStr(b.name), visible: b.visible !== false }));
}

/** 新格式的一个脚本 → 规范化的 Script（不检查 type，调用方已经认过） */
function normScript(s) {
    const btn = isObj(s.button) ? s.button : null;
    const ew = isObj(s.export_with) ? s.export_with : null;
    return {
        type: 'script',
        enabled: s.enabled === true,
        name: coerceStr(s.name),
        id: coerceStr(s.id),
        content: coerceStr(s.content),
        info: coerceStr(s.info),
        button: btn ? { ...extras(btn, new Set(['enabled', 'buttons'])), enabled: btn.enabled !== false, buttons: normButtons(btn.buttons) }
            : { enabled: true, buttons: [] },
        data: isObj(s.data) ? s.data : {},
        export_with: ew ? { ...extras(ew, new Set(['data', 'button'])), data: ew.data !== false, button: ew.button !== false } : { data: true, button: true },
        ...extras(s, SCRIPT_KEYS),
    };
}

/** 旧格式的一个脚本（buttons 在顶层）→ 规范化的 Script：照酒馆助手 backward.ts 的转换，button.enabled = true、export_with 全开 */
function normLegacyScript(s) {
    return {
        type: 'script',
        enabled: s.enabled === true,
        name: coerceStr(s.name),
        id: coerceStr(s.id),
        content: coerceStr(s.content),
        info: coerceStr(s.info),
        button: { enabled: true, buttons: normButtons(s.buttons) },
        data: isObj(s.data) ? s.data : {},
        export_with: { data: true, button: true },
        ...extras(s, LEGACY_SCRIPT_KEYS),
    };
}

function normFolder(f, children) {
    const out = {
        type: 'folder',
        enabled: f.enabled === true,
        name: coerceStr(f.name),
        id: coerceStr(f.id),
        icon: typeof f.icon === 'string' ? f.icon : 'fa-solid fa-folder',
        scripts: children,
        ...extras(f, FOLDER_KEYS),
    };
    // 颜色：酒馆助手缺省时用当前主题的引用色（运行时才知道），所以原来没有就不写，交给它自己补
    if (typeof f.color === 'string') out.color = f.color;
    return out;
}

/**
 * 解析一个新格式的列表。recognized 收集认出来的原条目（对象引用），导出时用来分辨「认不出来、要原样留着」的条目。
 * @returns {ScriptTree[]}
 */
function parseNewList(list, recognized, nested = false) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (!isObj(item)) continue;
        const type = item.type === undefined ? 'script' : item.type;
        if (type === 'script') {
            out.push(normScript(item));
            recognized?.add(item);
        } else if (type === 'folder' && !nested) {
            out.push(normFolder(item, parseNewList(item.scripts, recognized, true)));
            recognized?.add(item);
        }
    }
    return out;
}

/** 旧格式的列表（三种条目形状都认）。文件夹照酒馆助手的迁移一律启用 */
function parseLegacyList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (!isObj(item)) continue;
        if (item.type === 'folder') {
            const kids = Array.isArray(item.value) ? item.value.filter(isObj).map(normLegacyScript) : [];
            const { value: _v, ...rest } = item;
            out.push(normFolder({ ...rest, enabled: true }, kids));
        } else if (item.type === 'script' && isObj(item.value)) {
            out.push(normLegacyScript(item.value));
        } else if (item.type === undefined || item.type === 'script') {
            out.push(normLegacyScript(item));   // 裸的旧脚本
        }
    }
    return out;
}

/**
 * 补 id：缺失或和前面重复的，换成一个确定的 'st-<位置>'（避开已有的 id）。原地改 tree（tree 是刚规范化出来的新对象）。
 * 确定的意思是同一份数据每次解析得到同样的 id——导出时要按 id 把现在的条目对回原条目。
 */
function fixIds(tree) {
    const all = new Set();
    for (const t of tree) { all.add(t.id); if (t.type === 'folder') for (const s of t.scripts) all.add(s.id); }
    const seen = new Set();
    const fix = (item, pos) => {
        if (item.id && !seen.has(item.id)) { seen.add(item.id); return; }
        let id = `st-${pos}`, n = 2;
        while (all.has(id) || seen.has(id)) id = `st-${pos}-${n++}`;
        item.id = id;
        seen.add(id);
    };
    tree.forEach((t, i) => {
        fix(t, String(i));
        if (t.type === 'folder') t.scripts.forEach((s, j) => fix(s, `${i}.${j}`));
    });
    return tree;
}

/**
 * 卡的原始 JSON 里脚本放在哪：
 *   {kind: 'new', container, settings, list}   tavern_helper 在（container 是原值，settings 是它转成对象后的样子）
 *   {kind: 'legacy', list, vars}               只有旧键
 *   {kind: 'none'}
 */
function locate(raw) {
    const ext = isObj(raw) && isObj(raw.data) && isObj(raw.data.extensions) ? raw.data.extensions : null;
    if (!ext) return { kind: 'none' };
    if (Object.hasOwn(ext, 'tavern_helper')) {
        const th = ext.tavern_helper;
        const settings = Array.isArray(th) ? pairsToObject(th) : isObj(th) ? th : {};
        return { kind: 'new', container: th, settings, list: settings.scripts };
    }
    if (ext.TavernHelper_scripts !== undefined || ext.TavernHelper_characterScriptVariables !== undefined) {
        return { kind: 'legacy', list: ext.TavernHelper_scripts, vars: ext.TavernHelper_characterScriptVariables };
    }
    return { kind: 'none' };
}

/** [[k, v], ...] → 对象；不是两项数组的、键不是字符串的、危险键跳过（酒馆助手直接 Object.fromEntries，坏的会让它整份读不出来） */
function pairsToObject(pairs) {
    const out = {};
    for (const p of pairs) if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'string' && !UNSAFE.has(p[0])) out[p[0]] = p[1];
    return out;
}

/** 解析 + 记下每个规范化条目的 id 对应的原条目（只有新格式有意义） */
function parseDetailed(raw) {
    const loc = locate(raw);
    const recognized = new Set();
    let tree = [];
    try {
        if (loc.kind === 'new') tree = parseNewList(loc.list, recognized);
        else if (loc.kind === 'legacy') tree = parseLegacyList(loc.list);
    } catch { tree = []; }   // 兜底：任何意外都不能让卡打不开
    fixIds(tree);
    return { loc, tree, recognized };
}

/**
 * 卡的原始 JSON → 规范化的脚本树（深拷贝，可以随便改）。坏数据 / 没有脚本 → []，永不抛错。
 * @param {Object} raw
 * @returns {ScriptTree[]}
 */
export function parseCardScripts(raw) {
    return clone(parseDetailed(raw).tree) ?? [];
}

/**
 * 卡现在的脚本树：card.scripts 有（用户在「脚本」页改过）就用它，没有就从 raw 解析。只读，不要原地改返回值
 * （改之前先把树写进 card.scripts，见 ui/tab-scripts.js ownScripts）。
 * @param {import('./types.js').Card} card
 * @returns {ScriptTree[]}
 */
export function cardScripts(card) {
    if (!isObj(card)) return [];
    if (Array.isArray(card.scripts)) return card.scripts;
    return parseCardScripts(card.raw);
}

/**
 * 存储里 / 备份里的 card.scripts 的容错（migrate.js normalizeCard 调它）：
 *   不是数组 → null（调用方删掉这个键，回到「跟着 raw」）；是数组 → 规范化（坏条目丢掉、字段校正、id 补齐）。
 *   已经是规范的 → 返回【同一个数组】（调用方可以拿 === 判断变没变）。
 * @returns {ScriptTree[]|null}
 */
export function normalizeScriptTree(list) {
    if (!Array.isArray(list)) return null;
    const tree = fixIds(parseNewList(list, null));
    return jsonEqual(tree, list) ? list : tree;
}

/** 树里的所有脚本（文件夹里的展开），按显示顺序 */
export function flattenScripts(tree) {
    const out = [];
    for (const t of Array.isArray(tree) ? tree : []) {
        if (t?.type === 'folder') out.push(...(Array.isArray(t.scripts) ? t.scripts : []));
        else if (t) out.push(t);
    }
    return out;
}

/** 会运行的脚本：启用的顶层脚本 + 启用的文件夹里启用的脚本（酒馆助手 store/scripts.ts 的规则）。第 1 期没人用，留给第 2 期 */
export function enabledScriptsOf(tree) {
    const out = [];
    for (const t of Array.isArray(tree) ? tree : []) {
        if (t?.type === 'folder') { if (t.enabled) out.push(...t.scripts.filter(s => s.enabled)); }
        else if (t?.enabled) out.push(t);
    }
    return out;
}

/** 新脚本（「脚本」页的「新增」）。默认值照酒馆助手的 Script 定义 */
export function newScript(id, name = '新脚本') {
    return {
        type: 'script', enabled: false, name, id, content: '', info: '',
        button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true },
    };
}

/**
 * 代码整段被 ``` 围起来时剥掉外层围栏（酒馆助手运行前也这么做）。第 1 期不运行，留给第 2 期
 * @param {string} code
 */
export function stripCodeFence(code) {
    const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(String(code ?? ''));
    return m ? m[1] : String(code ?? '');
}

// ───────────────────────────── 导出：合并回原始 JSON ─────────────────────────────

/** 现在的树和导入时的样子不一样吗 */
export function scriptsChanged(card) {
    if (!isObj(card) || !Array.isArray(card.scripts)) return false;
    return !jsonEqual(card.scripts, parseCardScripts(card.raw));
}

/**
 * 一个条目写回：有原条目（新格式）→ 以原条目为底，只改和「导入时的样子」不同的字段；没有 → 整条写。
 * 文件夹的 scripts 另外按列表合并。id 永远钉成现在的 id（原条目缺 id / id 重复时我们补过）。
 */
function mergeItem(cur, ctx) {
    const hit = ctx.byId.get(cur.id);
    if (!hit) {
        const out = clone(cur);
        if (cur.type === 'folder') out.scripts = mergeList(cur.scripts, [], ctx);
        return out;
    }
    const { raw, base } = hit;
    const out = clone(raw);
    const keys = new Set([...Object.keys(cur), ...Object.keys(base)]);
    for (const k of keys) {
        if (UNSAFE.has(k) || (cur.type === 'folder' && k === 'scripts')) continue;
        if (jsonEqual(cur[k], base[k])) continue;
        if (cur[k] === undefined) delete out[k]; else out[k] = clone(cur[k]);
    }
    if (out.id !== cur.id) out.id = cur.id;
    if (cur.type === 'folder') out.scripts = mergeList(cur.scripts, Array.isArray(raw.scripts) ? raw.scripts : [], ctx);
    return out;
}

/**
 * 一层列表写回。认不出来的原条目（不是对象、type 不认识……）原样留着：放在它在原文件里前面那个认得出的条目后面；
 * 那个条目没了（删了 / 挪走了）就放到最后；前面没有认得出的就放最前面。
 */
function mergeList(curList, rawList, ctx) {
    const junkAfter = new Map();   // 认得出的原条目的 id（'' = 最前面）→ 跟在它后面的认不出的原条目
    let anchor = '';
    for (const r of rawList) {
        if (isObj(r) && ctx.recognized.has(r)) { anchor = ctx.idOfRaw.get(r) ?? anchor; continue; }
        if (!junkAfter.has(anchor)) junkAfter.set(anchor, []);
        junkAfter.get(anchor).push(clone(r) ?? null);
    }
    const out = [...(junkAfter.get('') ?? [])];
    junkAfter.delete('');
    for (const cur of curList) {
        out.push(mergeItem(cur, ctx));
        if (junkAfter.has(cur.id)) { out.push(...junkAfter.get(cur.id)); junkAfter.delete(cur.id); }
    }
    for (const rest of junkAfter.values()) out.push(...rest);
    return out;
}

/**
 * 把脚本树写回卡的原始 JSON（card-export.js exportCardJson 在最后调它）。
 *   card.scripts 不存在 / 和导入时的样子相同 → 原样返回 out（不碰）。
 *   不同 → 按文件头「导出」一节改 out（out 是 raw 的副本，调用方已经保证是 V2：out.data 是对象）。
 * @param {Object} out    导出中的卡 JSON（会被原地改）
 * @param {import('./types.js').Card} card
 * @returns {Object} out
 */
export function writeScriptsInto(out, card) {
    if (!scriptsChanged(card)) return out;
    const { loc, tree: baseTree, recognized } = parseDetailed(card.raw);
    if (!isObj(out.data)) out.data = {};
    if (!isObj(out.data.extensions)) out.data.extensions = {};
    const ext = out.data.extensions;
    const cur = card.scripts;

    if (loc.kind !== 'new') {
        // 旧键 / 没有：照酒馆助手的迁移写成新格式的对象，删掉旧键
        const vars = loc.kind === 'legacy' && isObj(loc.vars) ? clone(loc.vars) : {};
        delete ext.TavernHelper_scripts;
        delete ext.TavernHelper_characterScriptVariables;
        ext.tavern_helper = { scripts: clone(cur), variables: vars };
        return out;
    }

    // 新格式：按 id 对回原条目。raw 里的条目对象 → 规范化后的 id（recognized 收的是 raw 里的对象引用，所以从 card.raw 上走，不从 out 的副本上走）
    const byId = new Map(), idOfRaw = new Map();
    const rawTop = Array.isArray(loc.list) ? loc.list.filter(r => isObj(r) && recognized.has(r)) : [];
    rawTop.forEach((r, i) => {
        const b = baseTree[i];
        byId.set(b.id, { raw: r, base: b }); idOfRaw.set(r, b.id);
        if (b.type === 'folder') {
            const kids = Array.isArray(r.scripts) ? r.scripts.filter(x => isObj(x) && recognized.has(x)) : [];
            kids.forEach((k, j) => { const kb = b.scripts[j]; byId.set(kb.id, { raw: k, base: kb }); idOfRaw.set(k, kb.id); });
        }
    });
    const ctx = { byId, idOfRaw, recognized };
    const scripts = mergeList(cur, Array.isArray(loc.list) ? loc.list : [], ctx);

    const th = ext.tavern_helper;   // out 里的副本：形状和原来一样
    if (Array.isArray(th)) {
        const i = th.findIndex(p => Array.isArray(p) && p[0] === 'scripts');
        if (i >= 0) th[i] = [...th[i].slice(0, 1), scripts, ...th[i].slice(2)];
        else th.push(['scripts', scripts]);
    } else if (isObj(th)) {
        th.scripts = scripts;
    } else {
        ext.tavern_helper = { scripts, variables: {} };   // 原值是坏的（null、数字……）：酒馆助手也读不出来，换成规范的
    }
    return out;
}

// ───────────────────────────── 单个脚本 / 文件夹的文件（酒馆助手「导出」「导入」的格式）─────────────────────────────
// 酒馆助手导出一个脚本：整个脚本对象（含 id、enabled），JSON 两格缩进，文件名「酒馆助手脚本-名字.json」；
// 导出时 export_with.data 为 false 就把 data 清成 {}，export_with.button 为 false 就把 button.buttons 清成 []（它弹框让人选，默认按 export_with）。
// 文件夹同理（文件夹对象，scripts 里是脚本）。导入：有 buttons 键的按旧格式读，否则按新格式；id 全部换新、导入后一律关着。

/** 导出一个条目的文件内容（对象）。不改输入 */
export function scriptFileObject(item) {
    const strip = s => {
        const o = clone(s);
        if (o.export_with?.data === false) o.data = {};
        if (o.export_with?.button === false && isObj(o.button)) o.button.buttons = [];
        return o;
    };
    if (item?.type === 'folder') return { ...clone(item), scripts: (item.scripts ?? []).map(strip) };
    return strip(item);
}

/**
 * 读一个酒馆助手的脚本 / 文件夹文件（也认数组：一次装了好几个的）。返回规范化的条目（id 用 newId() 换新、enabled = false），
 * 认不出来返回 null。不读角色卡这类别的文件。
 * @param {any} json
 * @param {() => string} newId
 * @returns {ScriptTree[]|null}
 */
export function parseScriptFile(json, newId) {
    const items = Array.isArray(json) ? json : [json];
    const looks = o => isObj(o) && (o.type === 'script' || o.type === 'folder' || (o.type === undefined && typeof o.content === 'string' && ('name' in o || 'id' in o)));
    if (!items.length || !items.every(looks)) return null;
    const out = [];
    for (const o of items) {
        let t;
        if (Object.hasOwn(o, 'buttons')) t = normLegacyScript(o);
        else t = parseNewList([o], null)[0];
        if (!t) return null;
        t = clone(t);
        t.id = newId(); t.enabled = false;   // 酒馆助手：导入的条目一律先关着；文件夹里的脚本只换 id，开关不动
        if (t.type === 'folder') for (const s of t.scripts) s.id = newId();
        out.push(t);
    }
    return out;
}
