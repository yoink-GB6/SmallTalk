// 额外世界书（GlobalRecord.books 的每一本）的「开关 + 生效范围」。纯函数，不碰 DOM / IndexedDB，Node 里可测。
// 规则的出处见 types.js GlobalRecord.books 一节。
//
// 每本书在 {name, entries} 之外多三个字段：
//   enabled  false = 关掉（谁都不生效）。【缺省 = 启用】：只有关掉时才写 enabled: false，启用时删掉这个键。
//   scope    'cards' = 只对 cards 里的卡生效。【缺省 = 'all'（所有聊天）】：只有 'cards' 时才写。
//   cards    绑定的卡 id（CardRecord.id）。scope 为 'cards' 时一定写（可以是空数组 = 没有绑定任何卡 = 谁都不生效）；
//            scope 为 'all' 时只有非空才留着（记住以前绑过哪些卡，切回「只对指定的卡」时不用重新绑）。
// 为什么要显式的 scope，而不是「cards 为空 = 对所有聊天」：绑定的卡被删光时，这本书必须变成「谁都不生效」，
// 而不能悄悄变成对所有聊天生效（那样一删卡，一本私人设定的书就跑进了别的角色的每一次发送里）。
// 默认值时不写这些字段：没用过这个功能的人，存储里的书和以前一模一样。
//
// 容错（读档 normalizeGlobal → cleanBooks、恢复备份、酒馆 zip 都经过这里）：
//   enabled 不是 false 的（true、'no'、0、null……）一律当作启用；scope 不是 'cards' 的一律当作 'all'；
//   cards 不是数组当作 []；数组里不是字符串（或是空串）的丢掉；重复的只留一个。

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 一本书的三个字段读出来（已容错）。不改输入 */
export function bookScopeOf(book) {
    const b = isObj(book) ? book : {};
    const cards = Array.isArray(b.cards) ? [...new Set(b.cards.filter(x => typeof x === 'string' && x !== ''))] : [];
    return { enabled: b.enabled !== false, scope: b.scope === 'cards' ? 'cards' : 'all', cards };
}

/**
 * 把 {enabled, scope, cards}（已容错的值）按「默认值不写」的规则写到 out 上（原地改 out，返回 out）。
 * 先删掉三个键再按需写回，所以键的顺序固定在最后。
 */
function writeScope(out, { enabled, scope, cards }) {
    delete out.enabled; delete out.scope; delete out.cards;
    if (!enabled) out.enabled = false;
    if (scope === 'cards') { out.scope = 'cards'; out.cards = cards; }
    else if (cards.length) out.cards = cards;
    return out;
}

/** 两份 scope 字段是否一样（cards 按顺序比） */
const sameScope = (a, b) => a.enabled === b.enabled && a.scope === b.scope && a.cards.length === b.cards.length && a.cards.every((x, i) => x === b.cards[i]);

/** 存储里的写法和规范写法是否一致（键在不在、值对不对） */
function isCanonical(book, s) {
    const want = writeScope({}, s);
    for (const k of ['enabled', 'scope', 'cards']) {
        if (Object.hasOwn(want, k) !== Object.hasOwn(book, k)) return false;
        if (k === 'cards' && Object.hasOwn(want, k)) {
            if (!Array.isArray(book.cards) || book.cards.length !== want.cards.length || book.cards.some((x, i) => x !== want.cards[i])) return false;
        } else if (Object.hasOwn(want, k) && book[k] !== want[k]) return false;
    }
    return true;
}

/**
 * 规范化一本书的三个字段（读档、恢复都用；migrate.js cleanBooks 调它）。
 * 已经是规范写法时返回【同一个对象】（调用方可以拿 === 判断变没变，没变就不必重写存储）；否则返回浅拷贝。
 */
export function normalizeBookScope(book) {
    if (!isObj(book)) return book;
    const s = bookScopeOf(book);
    if (isCanonical(book, s)) return book;
    return writeScope({ ...book }, s);
}

/**
 * 这本书对某张卡生效吗？启用 且（范围是所有聊天，或者绑定里有这张卡）。
 * cardId 为 null / ''（还没有任何角色卡）时只有「所有聊天」的书生效。
 */
export function isBookActiveFor(book, cardId) {
    const s = bookScopeOf(book);
    if (!s.enabled) return false;
    if (s.scope !== 'cards') return true;
    return typeof cardId === 'string' && cardId !== '' && s.cards.includes(cardId);
}

/**
 * 原地改一本书的开关 / 范围 / 绑定（「世界书」页用：页面上按书对象记展开状态，所以不能换成新对象）。
 * patch 里没给的字段保持原值。写回时照「默认值不写」的规则。返回 book。
 */
export function setBookScope(book, patch) {
    const cur = bookScopeOf(book);
    const next = {
        enabled: 'enabled' in patch ? patch.enabled !== false : cur.enabled,
        scope: 'scope' in patch ? (patch.scope === 'cards' ? 'cards' : 'all') : cur.scope,
        cards: 'cards' in patch ? bookScopeOf({ cards: patch.cards }).cards : cur.cards,
    };
    return writeScope(book, next);
}

/**
 * 删一张卡时：所有书的 cards 里去掉这张卡的 id。去掉后变空的书【保持】scope 'cards'（于是谁都不生效），不删书、不改成所有聊天。
 * 不改输入：返回新数组，没碰到的书是同一个对象，碰到的书是浅拷贝。
 * @returns {{list: Object[], changed: number}}  changed：改了几本
 */
export function unbindCardFromBooks(books, cardId) {
    if (!Array.isArray(books)) return { list: [], changed: 0 };
    let changed = 0;
    const list = books.map(b => {
        if (!isObj(b)) return b;
        const s = bookScopeOf(b);
        if (!s.cards.includes(cardId)) return b;
        changed++;
        return writeScope({ ...b }, { ...s, cards: s.cards.filter(x => x !== cardId) });
    });
    return { list, changed };
}

/**
 * 一本书的 cards 按卡 id 的映射换算（恢复备份、酒馆 zip 导入：备份里的卡在本机是新 id，或被判重映射到本机已有的卡）。
 * 映射不到的 id 丢掉。不改输入；没有任何变化时返回同一个对象。
 * @param {Object} book
 * @param {Map<string, string>} idMap  备份里的卡 id → 本机的卡 id
 */
export function remapBookCards(book, idMap) {
    if (!isObj(book)) return book;
    const s = bookScopeOf(book);
    const cards = [...new Set(s.cards.map(id => idMap?.get(id)).filter(x => typeof x === 'string' && x !== ''))];
    const next = { ...s, cards };
    if (sameScope(s, next) && isCanonical(book, next)) return book;
    return writeScope({ ...book }, next);
}

/**
 * 给一本书改名：书名和每个条目上的 book 字段一起改（原地改 book，返回 book）。
 * 为什么条目也要改：条目上的 book 是书名的副本，「世界书」页按「book + uid」对触发结果（activated / skipped 里的条目带着它），
 * 只改书名的话，这本书的条目会和另一本同名的书串在一起。「世界书」页改名、整体备份恢复时给重名的书加「 (2)」都走这里。
 * 调用方要原地改还是改副本自己定（备份恢复里先浅拷贝书和条目再调它，本机 global 里的对象不能动）。
 */
export function setBookName(book, name) {
    book.name = name;
    if (Array.isArray(book.entries)) for (const e of book.entries) if (isObj(e)) e.book = name;
    return book;
}

/**
 * 导入一本世界书文件（拖文件，ui/importer.js）：同名的已有书【只换条目】，开关 / 范围 / 绑定、它在列表里的位置、别的字段都保留；
 * 没有同名的就加在最后，启用、所有聊天（不写那三个字段）。
 * 为什么不整本替换：用户把书 X 设成「只对卡 A 生效」或关掉之后，再拖入更新过的 X.json，期望的是「内容更新了」，
 * 而不是这本书突然对所有聊天生效、还跑到列表末尾。
 * 万一列表里已经有好几本同名的（旧数据），换第一本，其余同名的去掉（和以前「同名整本替换」去掉的一样多）。
 * 不改输入：返回新数组；被换掉条目的书是浅拷贝（新对象），没碰到的书是同一个对象。
 * @returns {{list: Object[], replaced: boolean}}  replaced：是不是替换了已有的书
 */
export function replaceBookEntries(books, name, entries) {
    const list = Array.isArray(books) ? books : [];
    const at = list.findIndex(b => isObj(b) && b.name === name);
    if (at < 0) return { list: [...list, { name, entries }], replaced: false };
    const out = [];
    list.forEach((b, i) => {
        if (i === at) out.push({ ...b, name, entries });
        else if (!(isObj(b) && b.name === name)) out.push(b);
    });
    return { list: out, replaced: true };
}

/**
 * 卡自带那本世界书的名字（「世界书」页显示的、条目上 book 字段写的）；卡没有自带条目时返回 null（没有这本书，谁都不撞）。
 * 和 ui/tab-world.js cardBookName 同一条规则：条目上的 book → character_book.name → 卡名。
 * 用途：额外世界书不能和它同名（「世界书」页按「书名 + uid」对触发结果），导入世界书文件时用它查（ui/importer.js）。
 */
export function cardBookNameOf(card) {
    if (!isObj(card) || !(Array.isArray(card.worldEntries) && card.worldEntries.length)) return null;
    return card.worldEntries[0]?.book ?? (card.raw?.data?.character_book?.name || card.name || '');
}

/**
 * 判重用：去掉书名和这三个字段（以及条目上的 book 字段——它就是书名的副本）之后的内容。
 * 返回一个新对象，调用方自己 canonical / JSON 化。
 */
export function bookContent(book) {
    const { name: _n, enabled: _e, scope: _s, cards: _c, ...rest } = isObj(book) ? book : {};
    if (Array.isArray(rest.entries)) rest.entries = rest.entries.map(e => { if (!isObj(e)) return e; const { book: _b, ...x } = e; return x; });
    return rest;
}
