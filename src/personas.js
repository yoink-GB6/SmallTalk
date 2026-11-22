// 多人设的纯逻辑：不碰 DOM、不碰存储，输入输出都是「全局层里和人设有关的那三个字段」：
//   { persona: {name, description, remark?}, personas?: [{id, name, description, remark?}], activePersonaId?: string }
// remark（备注）：只用来在列表上区分重名的人设，不发给模型、宏里也读不到。【默认不写】：空备注时对象上没有这个键
// （不用备注的人存储形状和以前一样，isPristineGlobal 也不受影响）。对应酒馆 persona_descriptions[头像].title，规则见 cleanRemark。
// 规则的完整说明见 types.js 的 GlobalRecord。要点：
//   - persona 永远是「当前人设」的副本，运行时其它模块只读它（宏 {{user}}、拼装里的 persona 描述都来自它）；
//   - personas / activePersonaId 是【可选】字段：只有一个人设时根本不写，存储里和以前完全一样。
//     原因：migrate.js 的 isPristineGlobal 靠「global 等于默认值」判断用户有没有改过设置，
//     给全新用户的 global 加字段会把它弄坏；
//   - persona 和 personas 对不上时【以 persona 为准】（比如旧版本页面只改了 persona）。
// 所有函数都返回新对象，不改输入（UI 层拿结果去换 state 上的字段）。

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d) => (typeof v === 'string' ? v : d);

/** 备注最长多少字：只是列表上的一个标签，再长没有意义；手改的备份 / 酒馆文件里塞了大段文字时截掉 */
export const MAX_REMARK = 200;

/**
 * 备注的规范化（读档、改备注、导入酒馆文件、恢复备份都走这里）：
 * 不是字符串 → ''；换行一类的字符压成空格（它只占一行）；去掉首尾空白（酒馆 editPersonaTitle 也 trim）；超过 MAX_REMARK 截掉。
 * 返回 '' 表示没有备注（对象上不写这个键）。换行类字符的正则 REMARK_BREAKS 在下面。
 */
export function cleanRemark(v) {
    if (typeof v !== 'string') return '';
    return v.replace(REMARK_BREAKS, ' ').trim().slice(0, MAX_REMARK);
}
// 换行类字符：\r \n \v \f、U+0085、U+2028 / U+2029（和 notes.js 的 LINE_BREAKS 一样用 fromCharCode 拼，源码里不直接写这两个看不见的字符）
const REMARK_BREAKS = new RegExp(`[\\r\\n\\v\\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+`, 'g');

/** 一个人设的内容字段 {name, description, remark?}（name 空 → 'User'，和输入框的行为一致；备注为空时不带 remark 键） */
function fields(o) {
    const out = { name: str(o.name, '').trim() || 'User', description: str(o.description, '') };
    const remark = cleanRemark(o.remark);
    if (remark) out.remark = remark;
    return out;
}

/** 把 persona 整理成 {name, description, remark?} */
function cleanPersona(p) {
    return fields(isObj(p) ? p : {});
}

/** 整理列表：丢掉不是对象 / 没有 id 的项，id 重复的只留第一个。返回新数组（可能是空的） */
function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(), out = [];
    for (const e of list) {
        if (!isObj(e) || typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ id: e.id, ...fields(e) });
    }
    return out;
}

/** 列表里的一项 → 当前人设的副本（去掉 id） */
const copyOf = e => fields(e);

/** 判重用的键：名字 + 描述 + 备注。备注算内容——名字、描述相同而备注不同的是两个人设（用户就是靠备注区分重名的） */
export const personaSig = p => JSON.stringify([p.name, p.description, p.remark ?? '']);

/** 结果对象：只有真有列表时才带 personas / activePersonaId */
function result(persona, list, activeId) {
    return list && list.length ? { persona, personas: list, activePersonaId: activeId } : { persona };
}

/**
 * 读档 / 保存前的对齐。
 *   没有（或清空了）personas → 只返回 {persona}，不产生那两个字段；
 *   activePersonaId 指向的项存在 → 以 persona 为准，更新那一项；
 *   activePersonaId 无效 → 退回第一项，persona 也跟着变成第一项的副本（这时没有「当前项」可对，列表里的数据一条都不丢）。
 */
export function alignPersonas(rec) {
    const r = isObj(rec) ? rec : {};
    const persona = cleanPersona(r.persona);
    const list = cleanList(r.personas);
    if (!list.length) return { persona };
    const idx = list.findIndex(e => e.id === r.activePersonaId);
    if (idx < 0) return result(copyOf(list[0]), list, list[0].id);
    list[idx] = { id: list[idx].id, ...persona };
    return result(persona, list, list[idx].id);
}

/** 人设页要显示的列表。只有一个人设（没有 personas 字段）时返回一项，id 为 ''（虚拟项，不能删） */
export function listPersonas(rec) {
    const a = alignPersonas(rec);
    if (!a.personas) return [{ id: '', ...a.persona, active: true }];
    return a.personas.map(e => ({ ...e, active: e.id === a.activePersonaId }));
}

/**
 * 新建一个人设并切过去。第一次新建时，把现有的 persona 变成第一项（这时才开始写 personas / activePersonaId）。
 * @param {Object} rec
 * @param {{id: string, name?: string, description?: string}} init  id 由调用方生成（保持这里是纯函数）
 */
export function addPersona(rec, { id, name = '新人设', description = '' }) {
    const a = alignPersonas(rec);
    const list = a.personas ?? [{ id: `${id}-first`, ...a.persona }];
    const fresh = { id, name: String(name).trim() || '新人设', description: String(description) };
    return result(copyOf(fresh), [...list, fresh], id);
}

/** 切换到另一个人设。id 不存在 / 就是当前这个 / 没有列表：原样返回（对齐后的） */
export function switchPersona(rec, id) {
    const a = alignPersonas(rec);
    if (!a.personas || id === a.activePersonaId) return a;
    const e = a.personas.find(x => x.id === id);
    if (!e) return a;
    return result(copyOf(e), a.personas, e.id);
}

/** 改当前人设的名字 / 描述 / 备注（patch 里给哪个改哪个；备注给 '' = 去掉）；列表里当前那一项同步更新 */
export function updateCurrent(rec, patch) {
    const a = alignPersonas(rec);
    const persona = cleanPersona({ ...a.persona, ...(isObj(patch) ? patch : {}) });
    return alignPersonas({ persona, personas: a.personas, activePersonaId: a.activePersonaId });
}

/**
 * 改列表里任意一个人设（「人设」页每个人设的框展开后都能直接改，不用先切过去）。
 * id 是当前那个（或只有一个人设时的虚拟项 ''）→ 等于 updateCurrent；别的 id → 只改列表里那一项，当前人设不变。id 不存在：原样返回（对齐后的）。
 */
export function updatePersona(rec, id, patch) {
    const a = alignPersonas(rec);
    if (!a.personas || id === a.activePersonaId || id === '') return updateCurrent(a, patch);
    const i = a.personas.findIndex(x => x.id === id);
    if (i < 0) return a;
    const list = [...a.personas];
    list[i] = { id, ...fields({ ...list[i], ...(isObj(patch) ? patch : {}) }) };
    return result(a.persona, list, a.activePersonaId);
}

/**
 * 删除一个人设。至少保留一个：只剩一个（或没有列表）时返回 null 表示不能删；id 不存在也返回 null。
 * 删的是当前的 → 切到它后面那个（它是最后一个就切到前一个）。
 * 删到只剩一个时两个字段照旧保留（不去还原成「没有 personas」：留着没有坏处，也省得再改一遍存储）。
 */
export function deletePersona(rec, id) {
    const a = alignPersonas(rec);
    if (!a.personas || a.personas.length <= 1) return null;
    const i = a.personas.findIndex(x => x.id === id);
    if (i < 0) return null;
    const list = a.personas.filter(x => x.id !== id);
    if (id !== a.activePersonaId) return result(a.persona, list, a.activePersonaId);
    const next = list[Math.min(i, list.length - 1)];
    return result(copyOf(next), list, next.id);
}

/**
 * 一次删好几个（「人设」页的批量删除）。规则和 deletePersona 一样，一个一个删：
 * 要删的覆盖了全部（会一个不剩）、或者一个都不在列表里 → 返回 null 表示不能删；列表里没有的 id 忽略。
 * 当前的被删了 → 按 deletePersona 的规则切到剩下的某一个。
 */
export function deletePersonas(rec, ids) {
    const a = alignPersonas(rec);
    if (!a.personas) return null;
    const drop = new Set(ids);
    const hit = a.personas.filter(x => drop.has(x.id));
    if (!hit.length || hit.length >= a.personas.length) return null;
    let r = a;
    for (const e of hit) r = deletePersona(r, e.id);
    return r;
}

// ───────────────────────────── 和酒馆「人设管理 → 备份 / 恢复」互通 ─────────────────────────────
// 酒馆（public/scripts/personas.js 的 onBackupPersonas / onPersonasRestoreInput）的备份文件长这样：
//   { personas: {<头像文件名>: <人设名字>}, persona_descriptions: {<头像文件名>: {description, position, depth, role, lorebook, title, connections?}}, default_persona: <头像文件名>|null }
// 字段对照（详见 types.js 的 PersonasFile）：我们建模 name、description 和 remark（↔ persona_descriptions[键].title，
// 酒馆人设列表上名字下面那行小字，「重命名」弹框里的「Persona Title (optional, display only)」：public/scripts/personas.js
// getUserAvatarBlock 约 235–239 行读、editPersonaTitle 约 822–851 行写）；其余字段导出时填酒馆新建人设时的默认值，导入时丢弃。

/** 酒馆新建人设时 persona_descriptions 里除 description 外各字段的默认值（initPersona，personas.js 约 515-530 行：
 *  position = persona_description_positions.IN_PROMPT = 0，depth = DEFAULT_DEPTH = 2，role = DEFAULT_ROLE = 0，lorebook = ''，title = ''）。 */
export const ST_PERSONA_DEFAULTS = Object.freeze({ position: 0, depth: 2, role: 0, lorebook: '', title: '' });

/** 酒馆备份文件名：personas_YYYYMMDD.json（它用 toISOString 的日期，即 UTC 日期；照抄） */
export function personasFileName(date = new Date()) {
    return `personas_${date.toISOString().split('T')[0].replace(/-/g, '')}.json`;
}

/**
 * 导出成酒馆的人设备份对象。
 * 头像文件名是酒馆里人设的键，我们没有头像，所以每个人设生成一个稳定且不重复的键：smalltalk-<id>.png
 * （只有一个人设、没有 id 时用 smalltalk-current.png）。酒馆恢复时发现这些头像不存在会自动补默认头像，所以不带头像是可行的。
 * default_persona 一律 null：我们的「当前人设」只是此刻在用哪个，不等于酒馆的「默认人设」（新开酒馆聊天时自动选中的那个）。
 */
export function exportPersonasFile(rec, ids = null) {
    const personas = {}, persona_descriptions = {};
    const pick = ids ? new Set(ids) : null;   // 批量导出只导勾选的那几个（一个文件里放多个人设，酒馆的格式本来就是这样）
    for (const p of listPersonas(rec)) {
        if (pick && !pick.has(p.id)) continue;
        let key = `smalltalk-${(p.id || 'current').replace(/[^\w-]/g, '_')}.png`;
        for (let n = 2; key in personas; n++) key = key.replace(/(-\d+)?\.png$/, `-${n}.png`);   // 清洗后撞键时加序号，保证不重复
        personas[key] = p.name;
        persona_descriptions[key] = { description: p.description, ...ST_PERSONA_DEFAULTS, title: p.remark ?? '' };
    }
    return { personas, persona_descriptions, default_persona: null };
}

/** 是不是酒馆人设备份的形状：和酒馆恢复时的校验一致（personas 和 persona_descriptions 都是对象），再排除数组 */
export function looksLikePersonasFile(json) {
    return isObj(json) && isObj(json.personas) && isObj(json.persona_descriptions);
}

/**
 * 读酒馆的人设备份：返回 [{name, description, remark?}]（按文件里的顺序）。
 * 名字不是字符串的项丢掉；有名字但没有描述记录的，描述当空；title 不是字符串 / 是空的 → 没有备注。形状不对返回 null。
 */
export function parsePersonasFile(json) {
    if (!looksLikePersonasFile(json)) return null;
    const out = [];
    for (const [key, name] of Object.entries(json.personas)) {
        if (typeof name !== 'string') continue;
        const d = json.persona_descriptions[key];
        out.push(fields({ name, description: isObj(d) ? d.description : '', remark: isObj(d) ? d.title : '' }));
    }
    return out;
}

/**
 * 把读到的人设合并进本机，和酒馆一样是「合并」不是替换：
 *   名字、描述、备注都相同的（本机已有的，或同一个文件里前面刚加过的）跳过；其余都新增（名字相同但描述或备注不同的也新增，不覆盖）。
 *   备注算内容（personaSig）：两边都没有备注时和以前完全一样，所以旧文件 / 旧备份再导一遍不会多出重复的。
 * 当前人设不变。只有一个人设（没有 personas 字段）时，有新增才开始写 personas / activePersonaId（现有那个变成第一项）；
 * 一个都没新增就原样返回，存储里什么都不多出来。
 * @param {Object} rec
 * @param {{name: string, description: string, remark?: string}[]} items  parsePersonasFile 的结果
 * @param {() => string} makeId  生成 id（保持纯函数，由调用方给）
 * @returns {{rec: Object, added: number, skipped: number}}
 */
export function mergePersonas(rec, items, makeId) {
    const a = alignPersonas(rec);
    const list = a.personas ? [...a.personas] : [{ id: makeId(), ...a.persona }];
    const have = new Set(list.map(personaSig));
    let added = 0, skipped = 0;
    for (const it of items) {
        const e = fields(isObj(it) ? it : {});
        const k = personaSig(e);
        if (have.has(k)) { skipped++; continue; }
        have.add(k); list.push({ id: makeId(), ...e }); added++;
    }
    if (!added) return { rec: a, added, skipped };
    return { rec: result(a.persona, list, a.personas ? a.activePersonaId : list[0].id), added, skipped };
}
