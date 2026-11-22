// 检查器「存档」页：所有角色卡和它们的存档，一棵树。浏览、切换、新建、改名、删除、导入导出都在这里。
//
// 这一页只管画和接线，真正的操作全部是 archive.js 里现成的函数（它们负责落盘、切换保护、只读、
// 生成中拒绝、同步拆掉旧存档的界面、维护目录）。这里不碰 state，也不自己读写存储。
//
// 数据来源：
//   - 卡列表：listCards()（卡记录 + 存档键的个数；不读任何存档）
//   - 当前卡的存档：内存里的目录（liveChats，楼数 / 名字随 state 实时变）
//   - 其它卡的存档：只在展开时读它的目录 'index:<卡id>'（cardChats），不读存档整条记录
// 画的时候用缓存（model），只有「存储里的东西变了」（invalidateArchiveTab）才重新读。

import { $, h, toast } from './dom.js';
import { state, persist } from './state.js';
import { store } from '../store.js';
import { cardKey, indexKey } from '../migrate.js';
import { detectJsonKind } from '../card.js';
import { exportCardFile } from './export-st.js';
import {
    listCards, cardChats, liveChats, openChat, switchCard, newChat, renameChat, deleteChat, exportChat,
    importChatFile, deleteCard,
} from './archive.js';
import { importFiles, importBlockedReason } from './importer.js';   // 循环依赖（importer 导入 archive）：只在函数体里调用
import { openSearch } from './chat-search.js';   // 「搜索聊天记录」按钮用（只在函数体里调用）
import { closeDrawer } from './drawer.js';

// ───────────────────────────── 运行期界面状态（不持久化，刷新页面就没了） ─────────────────────────────

const open = new Set();     // 展开着的卡 id
const auto = new Set();     // 其中是「因为它成了当前卡」自动展开的（用户自己点开的不在这里）：换卡后自动收回去
let lastActive;             // 上一次画的时候的当前卡
let model = null;           // {cards: listCards() 的结果, chats: Map<卡id, 目录里的存档列表>}（非当前卡的存档列表只在展开后才有）
let dirty = true;           // 存储里的东西变了，下次画之前要重新读
let loadSeq = 0;            // 防止慢的读取把新的结果盖掉
const fetching = new Set(); // 正在读目录的卡 id

const RO_TIP = '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能操作';
const timeText = iso => (iso ? new Date(iso).toLocaleString() : '—');
/** 年-月-日（本地时间）；没有或不是合法时间返回 '' */
function dayText(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 一批存档里最近的更新时间（ISO 字符串能直接比大小）；没有返回 '' */
const latestOf = list => list.reduce((m, x) => (typeof x?.updatedAt === 'string' && x.updatedAt > m ? x.updatedAt : m), '');

// 批量模式（运行期状态，不持久化）：开着时每张卡前有勾选框，顶上是「导出 / 删除 / 取消」
let batch = false;
const picked = new Set();     // 勾选的卡 id
let batchBusy = false;        // 批量导出 / 删除正在跑：别重复点
let batchFmt = 'auto';        // 批量导出的格式：'auto' = 和单张导出一样（有头像 PNG，没有 JSON）；'json' = 全部 JSON

/**
 * 「导入」按钮的文件选择框：只收角色卡（PNG / JSON）和聊天记录（.jsonl，进当前卡的新存档），可多选。
 * 世界书、正则、预设、人设的文件请到各自的页导入。拖文件进页面的总入口（importer.js importFiles）认所有类型，不受这里限制；
 * 这里先按类型挑出合格的，再原样交给 importFiles（阻挡条件、同名卡的询问、提示都在它里面）。
 */
const importPicker = h('input', { type: 'file', id: 'archive-import-input', accept: '.png,.json,.jsonl', multiple: true, hidden: true });
importPicker.addEventListener('change', async () => {
    const files = [...importPicker.files];
    importPicker.value = '';
    if (!files.length) return;
    const why = importBlockedReason();
    if (why) return void toast(why, 'error');
    const good = [], skipped = [];
    for (const f of files) {
        if (/\.(png|jsonl)$/i.test(f.name) || f.type === 'image/png') { good.push(f); continue; }
        if (/\.json$/i.test(f.name)) {
            try { if (detectJsonKind(JSON.parse(await f.text())) === 'card') { good.push(f); continue; } } catch { /* 读不出来：当作不合格 */ }
        }
        skipped.push(f.name);
    }
    if (skipped.length) toast(`「${skipped.join('」「')}」不是角色卡或聊天记录，请到对应的页（世界书、正则、预设、人设）导入`, 'error');
    if (good.length) await act(() => importFiles(good));
});

/** 给 .jsonl 导入用的文件选择框（只有一个，点哪张卡的「导入」就把目标卡 id 记在上面） */
const picker = h('input', { type: 'file', id: 'archive-file-input', accept: '.jsonl', hidden: true });
picker.addEventListener('change', () => {
    const file = picker.files[0], cardId = picker.dataset.card;
    picker.value = '';
    if (file) act(() => importChatFile(file, cardId));
});

// ───────────────────────────── 读和画 ─────────────────────────────

const tabIsActive = () => $('#tabs button.active')?.dataset.tab === 'archive';

/** 存储里的卡 / 存档变了（任何存档操作之后、消息写完之后）：下次画之前重新读；这一页正开着就马上读 */
export function invalidateArchiveTab() {
    dirty = true;
    if (tabIsActive()) renderArchiveTab();
}

/** 操作之后刷新：不管操作成没成功都重读一次（失败也可能改了点什么，比如导入到一半） */
async function act(fn) {
    try { return await fn(); } finally { invalidateArchiveTab(); }
}

async function load() {
    const mine = ++loadSeq;
    const cards = await listCards();
    const chats = new Map();
    await Promise.all(cards.filter(c => open.has(c.id) && c.id !== persist.cardId)
        .map(async c => chats.set(c.id, await cardChats(c.id))));
    // 每张卡「最后聊天的日期」：直接读它的目录记录（小）取最近的 updatedAt；不用 cardChats，那个目录对不上时会把存档整条重读重建。
    // 读不出来 / 没有目录就不显示日期。当前卡用内存里的（draw 里算），这里不读
    const last = new Map();
    await Promise.all(cards.filter(c => c.id !== persist.cardId).map(async c => {
        try { const t = latestOf(Object.values((await store.get(indexKey(c.id)))?.chats ?? {})); if (t) last.set(c.id, t); } catch (e) { console.error(e); }
    }));
    if (mine !== loadSeq) return;
    model = { cards, chats, last };
    dirty = false;
    draw();
}

/** @param {boolean} [force] 从别的页切进来时为 true：重新读一遍 */
export function renderArchiveTab(force = false) {
    if (force) dirty = true;
    if (dirty || !model) load().catch(e => { console.error(e); $('#tab-archive').replaceChildren(h('div', { class: 'empty' }, `读取存档列表失败：${e.message}`)); });
    else draw();
}

/** 展开 / 收起（不切换卡；展开非当前卡时只读它的目录） */
function toggle(cardId) {
    auto.delete(cardId);   // 手动点过：不再自动收起
    if (open.has(cardId)) open.delete(cardId); else open.add(cardId);
    draw();
}

/** 展开着的非当前卡里还没读过目录的，读一次（draw 里调用，所以不管从哪条路展开都会补上） */
function fetchMissing() {
    for (const id of open) {
        if (id === persist.cardId || model.chats.has(id) || fetching.has(id)) continue;
        fetching.add(id);
        cardChats(id).then(list => { model?.chats.set(id, list); }, e => { console.error(e); model?.chats.set(id, []); })
            .finally(() => { fetching.delete(id); draw(); });
    }
}

function draw() {
    const tab = $('#tab-archive');
    if (!tab || !model) return;
    if (persist.cardId !== lastActive) {
        // 换了当前卡：新的当前卡默认展开；上一张是自动展开的就收回去（手动展开的留着）
        if (auto.delete(lastActive)) open.delete(lastActive);
        lastActive = persist.cardId;
        if (persist.cardId && !open.has(persist.cardId)) { open.add(persist.cardId); auto.add(persist.cardId); }
    }
    fetchMissing();

    const ro = persist.readOnly;
    const cards = model.cards.map(c => c.id === persist.cardId
        ? { ...c, name: state.card?.name ?? c.name, avatar: state.avatar ?? c.avatar, chats: liveChats(), active: true }
        : { ...c, chats: model.chats.get(c.id) ?? null, active: false });
    // 没卡状态下发了第一条消息：占位卡的记录还没落盘，列表里先用内存里的
    if (persist.cardId && !cards.some(c => c.active)) {
        cards.unshift({ id: persist.cardId, name: state.card?.name ?? 'Assistant', avatar: state.avatar, usedAt: persist.cardMeta?.usedAt, chats: liveChats(), active: true });
    }
    for (const c of cards) {
        if (c.chats) c.chatCount = c.chats.length;
        c.lastDay = dayText((c.chats ? latestOf(c.chats) : '') || model.last?.get(c.id));
    }
    // 批量模式：卡没了（删掉了）就从勾选里去掉；一张卡都没有就退出
    for (const id of [...picked]) if (!cards.some(c => c.id === id)) picked.delete(id);
    if (!cards.length) batch = false;
    const total = cards.reduce((n, c) => n + (c.chatCount ?? 0), 0);

    // 重画会把按钮换成新的：原来焦点在这一页的哪个按钮上，画完放回去（焦点在别处就不碰）
    const fk = tab.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;

    const importCard = h('button', { class: 'primary', 'data-fk': 'import-card', disabled: ro, title: ro ? RO_TIP : '导入角色卡（PNG / JSON，作为新卡添加）或聊天记录（.jsonl，进当前卡的新存档），可一次选多个。世界书、正则、预设、人设请到各自的页导入；也可以直接把文件拖进页面',
        onclick: () => importPicker.click() }, '导入');
    // 聊天内搜索的入口（原来在「杂项」页）：排在这一行最后。窄屏下检查器是盖住聊天区的抽屉，先收起才看得到搜索栏
    const searchBtn = h('button', { id: 'misc-search-btn', 'data-fk': 'misc-search', type: 'button', title: '在当前存档里搜索',
        onclick: () => { closeDrawer(); openSearch(); } }, '搜索聊天记录');
    // 整体备份 / 恢复在「杂项」页（src/ui/backup.js 的 backupSection），这一页不再有备份那一行
    const kids = [];
    if (!cards.length) {
        kids.push(h('div', { class: 'empty' }, '还没有角色卡。导入一张 PNG / JSON 角色卡后，它和它的聊天存档会按卡列在这里；'
            + '也可以不导入，直接和 Assistant 聊（发出第一条消息后会自动建一张占位卡）。'),
        h('div', { class: 'row', style: 'justify-content:center' }, importCard, searchBtn));
    } else {
        // 顶上的「新对话」去掉了：每张卡那一行自己有「新对话」（当前卡的那个和以前顶上的一样，读同一个开场白下拉框）
        const bar = batch
            ? [h('button', { 'data-fk': 'batch-all', disabled: batchBusy, title: '全部勾上；已经全勾时再点就全不选',
                onclick: () => { const all = cards.every(c => picked.has(c.id)); picked.clear(); if (!all) for (const c of cards) picked.add(c.id); draw(); } },
                cards.every(c => picked.has(c.id)) ? '全不选' : '全选'),
            h('button', { class: 'primary', 'data-fk': 'batch-export', disabled: batchBusy || !picked.size,
                title: '把勾选的卡逐张导出为酒馆角色卡（有头像的默认是 PNG，没有头像的是 JSON；右边可以改成全部 JSON）', onclick: () => batchExport(cards) }, '导出'),
            h('select', { 'data-fk': 'batch-format', id: 'batch-format', title: '批量导出的格式', onchange: e => { batchFmt = e.target.value; } },
                h('option', { value: 'auto', selected: batchFmt === 'auto' }, '默认格式'), h('option', { value: 'json', selected: batchFmt === 'json' }, '全部 JSON')),
            h('button', { class: 'danger', 'data-fk': 'batch-delete', disabled: ro || batchBusy || !picked.size,
                title: ro ? RO_TIP : '删除勾选的角色卡和它们的全部存档', onclick: () => batchDelete(cards) }, '删除'),
            h('button', { 'data-fk': 'batch-cancel', disabled: batchBusy, onclick: () => { batch = false; picked.clear(); draw(); } }, '取消'),
            h('span', { class: 'dim' }, `已选 ${picked.size} 张`)]
            : [importCard,
                h('button', { 'data-fk': 'batch', title: '多选角色卡，一次导出或删除', onclick: () => { batch = true; draw(); } }, '批量'),
                searchBtn];
        kids.push(h('div', { class: 'summary' }, ...bar,
            h('span', { class: 'spacer' }),
            h('span', { class: 'dim' }, `${cards.length} 张卡 · ${total} 个存档`)));
        kids.push(...cards.map(c => cardBlock(c, ro)));
    }
    kids.push(picker, importPicker);
    // 开场白下拉框 #greeting-select 是全页唯一的常驻元素（别处直接读它的值）：重画前先挪回 index.html 里的停放处，
    // 免得被 replaceChildren 一起丢掉；cardBlock 给当前卡那一行画好后再把它挪进去（做法同人设页的 #persona-fields）
    const sel = $('#greeting-select'), home = $('#greeting-home');
    if (sel && home && !home.contains(sel)) home.append(sel);
    tab.replaceChildren(...kids);
    const slot = tab.querySelector('.arch-greeting-slot');
    if (slot && sel) slot.append(sel);
    if (fk) tab.querySelector(`[data-fk="${CSS.escape(fk)}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

// ───────────────────────────── 树的节点 ─────────────────────────────

/** 一个操作按钮：只读时禁用并说明原因 */
const actionBtn = (label, title, fk, ro, onclick, cls = 'ghost') =>
    h('button', { class: cls, 'data-fk': fk, disabled: ro, title: ro ? RO_TIP : title, onclick }, label);

/**
 * 导出一张卡为酒馆格式。
 * - 当前卡：直接取运行时的 state.card / state.avatar。用户在「世界书」页的改动是原地改在这个对象上的，
 *   保存只是有 400ms 防抖的落盘，所以内存里的永远是最新的，不用等落盘，也不写存储。
 * - 其它卡：只读存储里的 'card:<id>' 记录（和 archive.js 里切卡前读卡记录的方式一样），不切换当前卡、不写任何东西。
 */
async function exportCard(c, asJson) {
    try {
        let card, avatar;
        if (c.active) ({ card, avatar } = state);
        else {
            const rec = await store.get(cardKey(c.id));
            if (!rec) return void toast('这张卡已经不在了', 'error');
            ({ card, avatar } = rec);
        }
        await exportCardFile(card, avatar, { asJson });
    } catch (e) {
        console.error(e);
        toast(`导出角色卡失败：${e.message}`, 'error');
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 批量导出：勾选的卡按列表顺序逐张导出（不写任何东西，只读标签页也能用）。连着下载多个文件，中间留一小段，免得浏览器当成一次性弹出拦掉 */
async function batchExport(cards) {
    const list = cards.filter(c => picked.has(c.id));
    if (!list.length || batchBusy) return;
    batchBusy = true; draw();
    try {
        for (const [i, c] of list.entries()) {
            if (i) await sleep(350);
            await exportCard(c, batchFmt === 'json');
        }
    } finally {
        batchBusy = false; batch = false; picked.clear();
        invalidateArchiveTab();
    }
}

/**
 * 批量删除：先统一确认一次（几张卡、共几个存档），再逐张走 archive.js 的 deleteCard（confirmed：不再逐张问，
 * 但带启用正则的卡照旧弹三选一框）。deleteCard 里选了「取消」或失败时卡还在，就在这一张停下，提示已经删了几张。
 */
async function batchDelete(cards) {
    const list = cards.filter(c => picked.has(c.id));
    if (!list.length || batchBusy) return;
    const chats = list.reduce((n, c) => n + (c.chatCount ?? 0), 0);
    if (!confirm(`删除选中的 ${list.length} 张角色卡，连同它们共 ${chats} 个存档？删掉就找不回来了。`)) return;
    batchBusy = true; draw();
    let done = 0, stoppedAt = null;
    try {
        for (const c of list) {
            const ok = await deleteCard(c.id, { confirmed: true });
            // deleteCard 里点了取消也会正常返回，所以以「卡还在不在」为准
            const still = (await listCards()).some(x => x.id === c.id);
            if (!ok || still) { stoppedAt = c.name; break; }
            done++; picked.delete(c.id);
        }
    } catch (e) {
        console.error(e);
        toast(`批量删除出错：${e.message}`, 'error');
    } finally {
        batchBusy = false;
        if (stoppedAt === null) { batch = false; picked.clear(); }
        invalidateArchiveTab();
    }
    if (stoppedAt !== null) toast(`已删除 ${done} 张，停在「${stoppedAt}」（取消或没能删除），剩下的没有动`, done === list.length ? 'ok' : 'error');
}

function avatarOf(c) {
    return c.avatar ? h('img', { class: 'arch-avatar', src: c.avatar, alt: '' }) : h('span', { class: 'arch-avatar arch-avatar-none' }, (c.name ?? '?').slice(0, 1));
}

function cardBlock(c, ro) {
    const isOpen = open.has(c.id);
    const sub = `${c.chatCount ?? '…'} 个存档 · 上次使用 ${timeText(c.usedAt)}`;
    const head = h('header', { class: `arch-head${batch ? ' batch-row' : ''}${batch && picked.has(c.id) ? ' batch-picked' : ''}` },
        batch ? h('input', { type: 'checkbox', class: 'arch-pick', 'data-fk': `pick:${c.id}`, checked: picked.has(c.id), disabled: batchBusy,
            title: `选中「${c.name}」`, 'aria-label': `选中「${c.name}」`,
            onchange: e => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); draw(); } }) : null,
        h('button', { class: 'ghost arch-toggle', 'data-fk': `toggle:${c.id}`, 'aria-expanded': String(isOpen), title: isOpen ? '收起' : '展开', onclick: () => toggle(c.id) }, isOpen ? '▾' : '▸'),
        h('button', { class: 'arch-main', 'data-fk': `card:${c.id}`, disabled: ro && !c.active,
            title: c.active ? `当前角色卡：${c.name}` : (ro ? RO_TIP : `切换到「${c.name}」（回到它上次停留的存档）`),
            onclick: () => act(() => switchCard(c.id)) },   // 点的就是当前卡时 switchCard 什么都不做
        avatarOf(c),
        h('span', { class: 'arch-text' }, h('b', { class: 'arch-name' }, c.name), h('span', { class: 'dim arch-sub' }, sub))),
        c.active ? h('span', { class: 'badge on' }, '当前') : null,
        actionBtn('新对话', `给「${c.name}」新开一个存档并切过去`, `new:${c.id}`, ro, () => act(() => newChat(c.active ? (Number($('#greeting-select').value) || 0) : 0, c.id))),
        // 当前卡这一行的开场白下拉框落脚处（draw 里把 #greeting-select 挪进来；只有一个开场白时它自己是 hidden 的）
        c.active ? h('span', { class: 'arch-greeting-slot' }) : null,
        actionBtn('导入', `导入酒馆的聊天记录（.jsonl），作为「${c.name}」的新存档并切过去`, `import:${c.id}`, ro, () => { picker.dataset.card = c.id; picker.click(); }),
        // 每卡的导出 / 删除按钮收进了顶上的「批量」。这个位置显示这张卡最后聊天的日期（没有存档记录就不显示）
        c.lastDay ? h('span', { class: 'dim arch-last', title: '最后聊天的日期' }, c.lastDay) : null);

    // 批量模式下点头部（空白处或卡名）= 切换勾选，不再切卡。用捕获阶段拦：卡名是个按钮，不拦的话它自己的 onclick 会先跑。
    // 头部里别的控件（展开箭头、新对话、导入、复选框自己）照常工作
    head.addEventListener('click', e => {
        if (!batch) return;
        const t = e.target.closest('button, a, input, select, textarea, label, summary');
        if (t && t !== head && !t.classList.contains('arch-main')) return;
        e.preventDefault(); e.stopPropagation();
        if (batchBusy) return;
        if (picked.has(c.id)) picked.delete(c.id); else picked.add(c.id);
        draw();
    }, true);

    let body = null;
    if (isOpen) {
        body = h('div', { class: 'body' },
            c.chats === null ? h('div', { class: 'dim' }, '读取中…')
                : !c.chats.length ? h('div', { class: 'dim' }, '这张卡还没有存档（切到它时会新开一个）')
                    : h('div', { class: 'plist' }, c.chats.map(x => chatRow(c, x, ro))));
    }
    return h('div', { class: `card arch-card${c.active ? ' current' : ''}`, 'data-card': c.id }, head, body);
}

function chatRow(c, x, ro) {
    const active = c.active && x.id === persist.chatId;
    return h('div', { class: `pitem arch-chat${active ? ' current' : ''}`, 'data-chat': x.id },
        h('header', null,
            h('button', { class: 'arch-main', 'data-fk': `chat:${x.id}`, disabled: ro && !active,
                title: active ? `当前存档：${x.name}` : (ro ? RO_TIP : `切换到存档「${x.name}」${c.active ? '' : `（角色卡「${c.name}」）`}`),
                onclick: () => act(() => openChat(c.id, x.id)) },   // 点的就是当前存档时 switchChat 什么都不做
            // 时间放进悬停提示；楼数拿出来显示在改名按钮左边（当前存档的数字取 state.chat.length，见 archive.js liveChats）
            h('span', { class: 'arch-text' }, h('span', { class: 'arch-name', title: timeText(x.updatedAt) }, x.name))),
            active ? h('span', { class: 'badge on' }, '当前') : null,
            h('span', { class: 'dim arch-count', 'data-fk': `count:${x.id}`, title: '楼层数' }, `${x.count ?? 0} 楼`),
            actionBtn('改名', '给这个存档改名', `ren:${x.id}`, ro, () => act(() => renameChat(c.id, x.id))),
            actionBtn('导出', '导出为酒馆的聊天记录（.jsonl）', `exp:${x.id}`, ro, () => exportChat(c.id, x.id)),
            actionBtn('✕', '删除这个存档', `del:${x.id}`, ro, () => act(() => deleteChat(c.id, x.id)))));
}
