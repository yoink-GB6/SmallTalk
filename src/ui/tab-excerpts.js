// 「摘抄」页签：把所有划过的文字集中看。三层折叠：角色卡 → 这张卡有划线的存档 → 每条划线一行（2026-11-28 用户改版）。
//
// 界面（用户定的）：
//   - 默认只展开当前卡的当前存档那一支，其余折着（同世界书页「默认只展开对当前卡生效的」）；展开状态只在内存里（view.open）。
//   - 每条一行，只显示一个「名字」：有备注显示备注，没有就是摘抄的前 15 个字（excerpts.js excerptName）。悬停（title）看全文和备注。
//   - 单击一行 = 跳转（切到那张卡的那个存档、把这条划线滚到聊天区中间偏上、闪一下）；双击 = 就地改备注（Enter / 失焦保存，Esc 取消，清空 = 去掉备注）。
//     单击的跳转推迟 CLICK_DELAY 毫秒：这期间同一行来了第二下就算双击，不跳。不靠浏览器的 dblclick 事件（手机上双触不一定有），
//     而是自己数两次 click 的间隔。
//   - 顶上一个搜索框（按摘抄文字和备注筛，不分大小写、按字面；匹配到的那几支自动展开），旁边「批量」：
//     每条划线、每个存档、每个角色前出现勾选框（勾存档 = 它下面全部，勾角色 = 它下面全部），「全选 / 删除 / 取消」，删除前确认一次。
//     批量模式下单击一行 / 存档头 / 角色头 = 勾选，不跳转（同 2026-11-23「批量模式点整行选中」）；▸ 箭头照旧展开 / 收起。
//     全选和勾存档 / 角色只管【现在列出来的】（有搜索时 = 匹配的那些）；已经勾上、后来被搜索藏起来的照样算在「已选」里、照样删。
//   - 当前存档和别的存档的划线都能直接删、直接改备注（archive.js editHighlightsAcross：当前的改内存，别的在一个事务里只换那条记录的 highlights）。
//   搜索词、批量勾选、展开状态都只在内存里（view）。
//
// 数据怎么来（划线只存位置不存文字，所以文字都是现切的）：
//   - 当前存档：直接用内存里的（currentHighlights + state.chat），划线刚加 / 刚改就能看到，不等落盘。
//   - 别的存档：先看目录（liveChats / cardChats，读的是 'index:<卡id>' 那条小记录）里每个存档的 hl 条数，【只读 hl > 0 的存档】的整条记录，
//     再用 highlight.js storedHighlights 按它的消息清洗、sliceHighlight 切出文字。没划过线的存档一条记录都不读。
//   - 别的存档的读取结果按「条数 | 更新时间 | 楼数」缓存（切页签回来时重新读，见 force）。改备注不改条数也不改更新时间，所以
//     本页每次改完（editHighlightsAcross 返回）都把被改的那几个存档的缓存删掉再重读，不然改过的备注显示不出来。
//
// 刷新时机：renderInspector 在这页开着时调 renderExcerptsTab（切页签进来 force=true）；当前存档的划线有增删改时 highlight-ui.js
// 的 repaintHighlights 发现列表换了，调 highlightsListChanged()。正在就地改备注时不重画（不然输入框会被换掉），改完再画。
// UI 模块之间有故意保留的循环依赖：本文件顶层只放声明，不调用兄弟 ui 模块的函数。

import { $, h, toast } from './dom.js';
import { state, persist, currentHighlights } from './state.js';
import { store } from '../store.js';
import { chatKey } from '../migrate.js';
import { listCards, cardChats, liveChats, openChat, editHighlightsAcross, highlightEditBlocked } from './archive.js';   // 循环依赖：只在函数体里调用
import { flashHighlight, repaintHighlights, scrollToHighlight } from './highlight-ui.js';     // 同上
import { restoreActive } from './backup.js';                              // 同上
import { closePhone, isClippingsShown } from './phone/phone.js';   // 这一页现在是手机里的 Clippings 应用
import { chatDoc, isShown, sliceHighlight, storedHighlights, comparePoint } from '../highlight.js';
import { excerptName, filterGroups, itemKey, chatKeys, groupKeys, allKeys, pickState, setPicked, picksToEdits } from '../excerpts.js';

const TITLE_TEXT_MAX = 3000;   // 悬停提示里全文最多多少字（整楼划线可能很长）
const CLICK_DELAY = 250;       // 单击的跳转推迟多久（这期间来第二下 = 双击改备注）

/** 运行期的界面状态（不存盘）。open：'c:<卡id>' / 'h:<卡id>/<存档id>' → 展开与否（没记的按默认：当前卡、当前存档展开） */
const view = { query: '', batch: false, picked: new Set(), open: new Map(), editing: null, busy: false };
const cache = new Map();       // 别的存档的读取结果：'卡id/存档id' → {sig, items}
let groupsNow = [];            // 上一次读到的全部分组（没过滤）：批量删除按它算
let seq = 0;                   // 防止慢的读取把新的结果盖掉
let searchBox = null;          // 搜索框常驻（重画时挪回去，焦点和光标不丢）
let clickTimer = null, clickKey = null;

const isActive = () => isClippingsShown();   // 正显示在屏幕上才画；打开时 app.js 的 onPhoneView 会补一次
/** 能不能改（只读、停止保存、恢复中 → 删除按钮、批量删除禁用；生成中这类临时状态不禁用，点了再说原因） */
const readOnlyNow = () => persist.readOnly || persist.stopped || restoreActive();

/** 当前存档的划线有变化（highlight-ui.js 发现列表换了）：这页开着就刷新 */
export function highlightsListChanged() {
    if (isActive()) renderExcerptsTab(false);
}

/** 一条划线的行数据：{h, text, shown}。原文已经不在了（读入时本该清掉）= text 为 null */
function itemOf(hl, doc, isLive) {
    const cut = sliceHighlight(hl, doc);
    return { h: hl, text: cut ? cut.text : null, shown: isLive ? isShown(hl, doc) : true };
}

const byPosition = (a, b) => comparePoint(a.h.from, b.h.from) || comparePoint(a.h.to, b.h.to);

/** 读出所有有划线的存档：[{cardId, cardName, current, chats: [{chatId, name, current, items}]}]（形状见 excerpts.js 文件头） */
async function gather(force) {
    if (force) cache.clear();
    const cards = await listCards();
    // 当前卡排最前；存储里还没有它（没卡状态下第一次用）就不列，那时也不会有划线
    cards.sort((a, b) => (b.id === persist.cardId) - (a.id === persist.cardId));
    const groups = [];
    for (const c of cards) {
        const isCur = c.id === persist.cardId;
        const chats = isCur ? liveChats() : await cardChats(c.id);
        const out = [];
        for (const chat of chats.filter(x => x.hl > 0).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
            let items;
            if (isCur && chat.id === persist.chatId) {
                items = currentHighlights().map(hl => itemOf(hl, chatDoc(state.chat), true));
            } else {
                const key = `${c.id}/${chat.id}`, sig = `${chat.hl}|${chat.updatedAt}|${chat.count}`;
                const hit = cache.get(key);
                if (hit?.sig === sig) items = hit.items;
                else {
                    const rec = await store.get(chatKey(c.id, chat.id));   // 只读有划线的存档
                    const doc = chatDoc(rec?.messages);
                    const list = storedHighlights(rec?.highlights, doc) ?? [];
                    items = list.map(hl => itemOf(hl, doc, false));
                    cache.set(key, { sig, items });
                }
            }
            if (items.length) out.push({ chatId: chat.id, name: chat.name, current: isCur && chat.id === persist.chatId, items: items.sort(byPosition) });
        }
        if (out.length) groups.push({ cardId: c.id, cardName: isCur ? (state.card?.name ?? c.name) : c.name, current: isCur, chats: out });
    }
    return groups;
}

// ───────────────────────────── 操作 ─────────────────────────────

/**
 * 跳转：切到那张卡的那个存档，把这条划线滚到聊天区中间偏上（highlight-ui.js scrollToHighlight，跨楼的按第一楼那一段），闪一下。
 * 以前是 row.scrollIntoView({block: 'center'})：把【整楼】居中——楼比聊天区还高时露出来的是这一楼的中段，划在靠后位置的字落在屏幕外。
 * 划线现在画不出来（别的候选上、被显示正则吃掉）：滚到那一楼的顶部，提示照旧。
 */
async function jump(cardId, chatId, hl) {
    const same = cardId === persist.cardId && chatId === persist.chatId;
    if (!same && !await openChat(cardId, chatId)) return;   // 被拒（只读、生成中……）openChat 里已经弹过原因
    closePhone();   // 手机盖着聊天区（窄屏铺满全屏，宽屏浮在聊天区上）：先收起，再滚动、闪
    const cur = currentHighlights().find(x => x.id === hl.id);
    const floor = cur?.from.floor ?? hl.from.floor;
    const row = $('#chat').children[floor];
    if (!cur || !row) { toast('这条划线对应的楼已经不在了', 'error'); return; }
    const shown = isShown(cur, chatDoc(state.chat));
    const found = scrollToHighlight(shown ? cur.id : null, row);
    const eaten = shown && !found && typeof Highlight !== 'undefined' && !!globalThis.CSS?.highlights;
    if (!shown || eaten) {
        toast(eaten ? '这条划线在现在的显示里画不出来（可能被显示正则换掉了），已滚到那一楼'
            : `这条划在另一个候选上（第 ${cur.from.swipe + 1} 个候选），那一楼现在显示的不是它`);
        row.classList.add('hl-flash-row');
        setTimeout(() => row.classList.remove('hl-flash-row'), 1700);
        return;
    }
    flashHighlight(cur.id);
}

/** 改一批：交给 archive.js editHighlightsAcross；之后被改的存档的缓存作废（改备注不改条数和更新时间，见文件头）、聊天里的高亮重画、本页重读 */
async function applyEdits(edits) {
    view.busy = true;
    let r = null;
    try { r = await editHighlightsAcross(edits); } finally { view.busy = false; }
    for (const e of edits) cache.delete(`${e.cardId}/${e.chatId}`);
    if (r && edits.some(e => e.cardId === persist.cardId && e.chatId === persist.chatId)) repaintHighlights();
    await renderExcerptsTab(false);
    if (r?.gone) toast(`有 ${r.gone} 个存档已经不在了，跳过了它们`, 'error');
    return r;
}

/** 单条删除（当前存档和别的存档都行）。带备注的先确认 */
async function removeOne(cardId, chatId, hl) {
    const why = highlightEditBlocked([{ cardId, chatId }]);
    if (why) return void toast(why, 'error');
    if (hl.note && !confirm('这条划线带着备注，删除后备注也没了。确定删除？')) return;
    await applyEdits([{ cardId, chatId, remove: [hl.id] }]);
}

/** 批量删除：勾选的全部（含被搜索藏起来的），确认一次，一个事务 */
async function batchDelete() {
    const { edits, count, chats } = picksToEdits(groupsNow, view.picked);
    if (!count) return;
    // 生成中：只涉及别的存档的照删；里面有当前存档的整批拒绝（archive.js highlightEditBlocked）
    const why = highlightEditBlocked(edits);
    if (why) return void toast(why, 'error');
    if (!confirm(`删除选中的 ${count} 条划线（涉及 ${chats} 个存档）？删掉就找不回来了。`)) return;
    const r = await applyEdits(edits);
    if (r) {
        view.batch = false; view.picked.clear();
        toast(`已删除 ${r.removed} 条划线`, 'ok');
        draw();
    }
}

/** 双击：把这一行的名字换成输入框改备注 */
function startEdit(row, g, c, it) {
    const why = highlightEditBlocked([{ cardId: g.cardId, chatId: c.chatId }]);
    if (why) return void toast(why, 'error');
    const name = row.querySelector('.exc-name');
    if (!name || view.editing) return;
    view.editing = itemKey(g.cardId, c.chatId, it.h.id);
    let done = false;
    const input = h('input', { type: 'text', class: 'exc-note-input', 'data-fk': 'exc-note-input', value: it.h.note ?? '',
        placeholder: '写备注（清空 = 显示摘抄的前几个字）', 'aria-label': '备注' });
    const finish = async save => {
        if (done) return;
        done = true;
        view.editing = null;
        if (!save || input.value.trim() === (it.h.note ?? '')) { draw(); return; }
        await applyEdits([{ cardId: g.cardId, chatId: c.chatId, notes: { [it.h.id]: input.value } }]);
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
    name.replaceWith(input);
    input.focus();
    input.select();
}

/** 一行的单击：批量模式 = 勾选；否则推迟一下再跳转，期间同一行来第二下 = 改备注 */
function onRowClick(e, row, g, c, it) {
    if (e.target.closest('button, input')) return;
    const key = itemKey(g.cardId, c.chatId, it.h.id);
    if (view.batch) {
        if (view.picked.has(key)) view.picked.delete(key); else view.picked.add(key);
        draw();
        return;
    }
    if (clickTimer && clickKey === key) {
        clearTimeout(clickTimer); clickTimer = null; clickKey = null;
        startEdit(row, g, c, it);
        return;
    }
    clearTimeout(clickTimer);
    clickKey = key;
    clickTimer = setTimeout(() => { clickTimer = null; clickKey = null; jump(g.cardId, c.chatId, it.h); }, CLICK_DELAY);
}

// ───────────────────────────── 画 ─────────────────────────────

const cardOpenKey = g => `c:${g.cardId}`;
const chatOpenKey = (g, c) => `h:${g.cardId}/${c.chatId}`;
const isOpen = (k, dflt) => (view.open.has(k) ? view.open.get(k) : dflt);

function checkbox(st, fk, label, onchange) {
    return h('input', { type: 'checkbox', class: 'exc-pick', 'data-fk': fk, checked: st === 'all', indeterminate: st === 'some',
        title: label, 'aria-label': label, onclick: e => e.stopPropagation(), onchange });
}

/** 一层的头（角色 / 存档）：[勾选框][▸][名字][条数]。非批量时点头 = 展开 / 收起；批量时点头（箭头以外）= 勾选 */
function headOf({ cls, fk, openKey, open, label, count, keys, pickFk }) {
    const st = pickState(view.picked, keys);
    const toggleOpen = () => { view.open.set(openKey, !open); draw(); };
    const togglePick = on => { setPicked(view.picked, keys, on); draw(); };
    const head = h('div', { class: `${cls}${view.batch ? ' batch-row' : ''}${view.batch && st === 'all' ? ' batch-picked' : ''}`, 'data-fk': fk },
        view.batch ? checkbox(st, pickFk, `选中「${label}」下面的全部划线`, e => togglePick(e.target.checked)) : null,
        h('button', { class: 'ghost exc-toggle', type: 'button', 'data-fk': `${fk}-toggle`, 'aria-expanded': String(open), title: open ? '收起' : '展开',
            onclick: e => { e.stopPropagation(); toggleOpen(); } }, open ? '▾' : '▸'),
        h('span', { class: 'exc-head-name' }, label),
        h('span', { class: 'dim exc-head-count' }, `${count} 条`));
    head.addEventListener('click', e => {
        if (e.target.closest('button, input')) return;
        if (view.batch) togglePick(st !== 'all'); else toggleOpen();
    });
    return head;
}

function rowOf(g, c, it, ro) {
    const hl = it.h, key = itemKey(g.cardId, c.chatId, hl.id);
    const picked = view.picked.has(key);
    const full = it.text === null ? '（原文已经不在了）' : it.text.slice(0, TITLE_TEXT_MAX) + (it.text.length > TITLE_TEXT_MAX ? '……' : '');
    const title = `${full}${hl.note ? `\n\n备注：${hl.note}` : ''}\n\n${view.batch ? '单击勾选' : '单击跳转，双击改备注'}`;
    const row = h('div', { class: `exc-item${view.batch ? ' batch-row' : ''}${view.batch && picked ? ' batch-picked' : ''}${it.shown ? '' : ' exc-other-swipe'}`,
        'data-fk': 'exc-item', 'data-id': hl.id, 'data-key': key, title },
        view.batch ? checkbox(picked ? 'all' : 'none', 'exc-pick', '选中这条划线', e => { if (e.target.checked) view.picked.add(key); else view.picked.delete(key); draw(); }) : null,
        h('span', { class: 'exc-name', 'data-fk': 'exc-name' }, excerptName(hl, it.text)),
        h('span', { class: 'dim exc-floor' }, hl.from.floor === hl.to.floor ? `#${hl.from.floor}` : `#${hl.from.floor}–${hl.to.floor}`),
        view.batch ? null : h('button', { class: 'ghost', 'data-fk': 'exc-del', type: 'button', disabled: ro,
            title: ro ? (highlightEditBlocked() ?? '现在不能删') : '删除这条划线', onclick: e => { e.stopPropagation(); removeOne(g.cardId, c.chatId, hl); } }, '删除'));
    row.addEventListener('click', e => onRowClick(e, row, g, c, it));
    return row;
}

function toolbar(ro, shownKeys) {
    if (!searchBox) {
        searchBox = h('input', { type: 'search', class: 'exc-search', 'data-fk': 'exc-search', placeholder: '搜索摘抄和备注', 'aria-label': '搜索摘抄和备注' });
        searchBox.addEventListener('input', () => { view.query = searchBox.value; draw(); });
    }
    if (searchBox.value !== view.query) searchBox.value = view.query;
    if (!view.batch) {
        return h('div', { class: 'summary exc-toolbar', 'data-fk': 'exc-toolbar' }, searchBox,
            h('button', { 'data-fk': 'exc-batch', type: 'button', title: '多选划线，一次删除', onclick: () => { view.batch = true; view.picked.clear(); draw(); } }, '批量'));
    }
    const all = shownKeys.length > 0 && shownKeys.every(k => view.picked.has(k));
    const n = picksToEdits(groupsNow, view.picked).count;
    return h('div', { class: 'summary exc-toolbar', 'data-fk': 'exc-toolbar' }, searchBox,
        h('button', { 'data-fk': 'exc-batch-all', type: 'button', disabled: !shownKeys.length, title: '把现在列出来的全部勾上；已经全勾时再点就全不选',
            onclick: () => { setPicked(view.picked, shownKeys, !all); draw(); } }, all ? '全不选' : '全选'),
        h('span', { class: 'dim', 'data-fk': 'exc-batch-count' }, `已选 ${n} 条`),
        h('button', { class: 'danger', 'data-fk': 'exc-batch-delete', type: 'button', disabled: ro || !n || view.busy,
            title: ro ? (highlightEditBlocked() ?? '现在不能删') : '删除勾选的划线', onclick: batchDelete }, '删除'),
        h('button', { class: 'ghost', 'data-fk': 'exc-batch-cancel', type: 'button', onclick: () => { view.batch = false; view.picked.clear(); draw(); } }, '取消'));
}

/** 按 groupsNow 和 view 重画（不重读存储） */
function draw() {
    const tab = $('#tab-excerpts');
    if (!tab || view.editing) return;
    tab.removeAttribute('aria-busy');
    const total = groupsNow.reduce((n, g) => n + g.chats.reduce((m, c) => m + c.items.length, 0), 0);
    if (!total) {
        view.batch = false; view.picked.clear();
        tab.replaceChildren(h('div', { class: 'empty', 'data-fk': 'exc-empty' },
            '还没有划线。在聊天里选中一段文字（手机上长按选字），点旁边冒出来的「划线」，它就会记在这里；点已划的文字可以写备注、删除。'));
        return;
    }
    // 勾着的键里已经不在的去掉（删掉了 / 存档没了）
    const live = new Set(allKeys(groupsNow));
    for (const k of [...view.picked]) if (!live.has(k)) view.picked.delete(k);
    const ro = readOnlyNow();
    const searching = !!view.query.trim();
    const groups = filterGroups(groupsNow, view.query);
    const hadFocus = !!searchBox && document.activeElement === searchBox;
    const caret = hadFocus ? [searchBox.selectionStart, searchBox.selectionEnd] : null;
    const kids = [toolbar(ro, allKeys(groups))];
    if (!groups.length) kids.push(h('div', { class: 'empty', 'data-fk': 'exc-no-match' }, `没有找到包含「${view.query.trim()}」的摘抄或备注`));
    for (const g of groups) {
        // 有搜索时匹配到的那几支全部展开（不改记下的展开状态，清掉搜索就回到原样）
        const cOpen = searching || isOpen(cardOpenKey(g), g.current);
        const count = g.chats.reduce((n, c) => n + c.items.length, 0);
        const block = [headOf({ cls: 'section-title exc-card-head', fk: 'exc-card-head', openKey: cardOpenKey(g), open: cOpen, label: g.cardName ?? '?', count, keys: groupKeys(g), pickFk: 'exc-pick-card' })];
        if (cOpen) for (const c of g.chats) {
            const hOpen = searching || isOpen(chatOpenKey(g, c), c.current);
            const chatBlock = [headOf({ cls: 'exc-chat-head', fk: 'exc-chat-head', openKey: chatOpenKey(g, c), open: hOpen,
                label: `${c.name ?? '新对话'}${c.current ? '（当前）' : ''}`, count: c.items.length, keys: chatKeys(g, c), pickFk: 'exc-pick-chat' })];
            if (hOpen) chatBlock.push(...c.items.map(it => rowOf(g, c, it, ro)));
            block.push(h('div', { class: 'exc-chat', 'data-fk': 'exc-chat', 'data-chat': c.chatId, 'data-open': String(hOpen) }, ...chatBlock));
        }
        kids.push(h('div', { class: 'exc-card', 'data-fk': 'exc-card', 'data-card': g.cardId, 'data-open': String(cOpen) }, ...block));
    }
    tab.replaceChildren(...kids);
    if (hadFocus) { searchBox.focus(); try { searchBox.setSelectionRange(...caret); } catch { /* 个别浏览器的 type=search 不支持 */ } }
}

export async function renderExcerptsTab(force = false) {
    const tab = $('#tab-excerpts');
    if (!tab) return;
    if (view.editing) {
        if (!force) return;   // 正在改备注：别把输入框换掉，改完会自己重画
        view.editing = null;  // 切页签回来：上次没提交的输入框已经不在了
    }
    const mine = ++seq;
    let groups;
    tab.setAttribute('aria-busy', 'true');   // 读存储期间页面上还是旧内容：画完（draw）才去掉，读失败也去掉
    try { groups = await gather(force); } catch (e) { console.error(e); if (mine === seq) { tab.removeAttribute('aria-busy'); tab.replaceChildren(h('div', { class: 'log-line error' }, `读取划线失败：${e.message}`)); } return; }
    if (mine !== seq) return;   // 读的时候又触发了新的刷新：以新的为准
    groupsNow = groups;
    draw();
}
