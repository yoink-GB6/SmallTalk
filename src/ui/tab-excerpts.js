// 「摘抄」页签（划线第二段）：把所有划过的文字集中看，按 角色卡 → 存档 分组，每条只占一行：摘出的文字、有备注的带标记、跳转（当前存档的还有删除）。
//
// 数据怎么来（划线只存位置不存文字，所以文字都是现切的）：
//   - 当前存档：直接用内存里的（currentHighlights + state.chat），划线刚加 / 刚改就能看到，不等落盘。
//   - 别的存档：先看目录（liveChats / cardChats，读的是 'index:<卡id>' 那条小记录）里每个存档的 hl 条数，【只读 hl > 0 的存档】的整条记录，
//     再用 highlight.js storedHighlights 按它的消息清洗、sliceHighlight 切出文字。没划过线的存档一条记录都不读。
//   - 别的存档的读取结果按「条数 | 更新时间 | 楼数」缓存（切页签回来时重新读，见 force），免得每次聊天重画都读一遍 IndexedDB。
// 删除：只给当前存档的划线（走 state.js removeChatHighlight，和聊天里点高亮删除是同一条路）。别的存档这一版只有「跳转」——
//   跳过去就是当前存档了，在那边删；不为它写「改非当前存档的记录」这条路（要防的竞态太多）。
// 跳转：archive.js openChat（和存档页点存档是同一个函数，落盘、只读、生成中拒绝都在它里面）→ 收抽屉 → 滚到那一楼 → 闪一下高亮。
//   划在不是当前显示的那个候选上的：照样跳到那一楼，提示一句。
//
// 刷新时机：renderInspector 在这页开着时调 renderExcerptsTab（切页签进来 force=true）；当前存档的划线有增删改时 highlight-ui.js
// 的 repaintHighlights 发现列表换了，调 highlightsListChanged()。
// UI 模块之间有故意保留的循环依赖：本文件顶层只放声明，不调用兄弟 ui 模块的函数。

import { $, h, toast } from './dom.js';
import { state, persist, currentHighlights, removeChatHighlight } from './state.js';
import { store } from '../store.js';
import { chatKey } from '../migrate.js';
import { listCards, cardChats, liveChats, openChat } from './archive.js';   // 循环依赖：只在函数体里调用
import { chatWriteBlocked } from './chat.js';                               // 同上
import { flashHighlight, repaintHighlights } from './highlight-ui.js';     // 同上
import { closeDrawer } from './drawer.js';
import { chatDoc, isShown, sliceHighlight, storedHighlights, comparePoint } from '../highlight.js';

const ROW_TEXT_MAX = 200;      // 一行里最多放多少字（再长的靠 CSS 省略号，展开看全文）
const DETAIL_TEXT_MAX = 3000;  // 展开后的全文最多多少字（整楼划线可能很长）

const open = new Set();        // 展开着的划线（卡id/存档id/划线id）：运行期状态，不存盘
const cache = new Map();       // 别的存档的读取结果：'卡id/存档id' → {sig, items}
let seq = 0;                   // 防止慢的读取把新的结果盖掉

const isActive = () => $('#tabs button.active')?.dataset.tab === 'excerpts';

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

/** 读出所有有划线的存档：[{cardId, cardName, current, chats: [{chatId, name, current, items}]}] */
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

const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/** 跳转：切到那张卡的那个存档，滚到那一楼，闪一下 */
async function jump(cardId, chatId, hl) {
    const same = cardId === persist.cardId && chatId === persist.chatId;
    if (!same && !await openChat(cardId, chatId)) return;   // 被拒（只读、生成中……）openChat 里已经弹过原因
    closeDrawer();   // 窄屏下抽屉盖着聊天区
    const cur = currentHighlights().find(x => x.id === hl.id);
    const floor = cur?.from.floor ?? hl.from.floor;
    const row = $('#chat').children[floor];
    if (!cur || !row) { toast('这条划线对应的楼已经不在了', 'error'); return; }
    row.scrollIntoView({ block: 'center' });
    if (!isShown(cur, chatDoc(state.chat))) {
        toast(`这条划在另一个候选上（第 ${cur.from.swipe + 1} 个候选），那一楼现在显示的不是它`);
        row.classList.add('hl-flash-row');
        setTimeout(() => row.classList.remove('hl-flash-row'), 1700);
        return;
    }
    flashHighlight(cur.id);
}

function removeLive(hl) {
    const why = chatWriteBlocked(persist.epoch, '删除划线');
    if (why !== null) { if (why) toast(why, 'error'); return; }
    if (hl.note && !confirm('这条划线带着备注，删除后备注也没了。确定删除？')) return;
    removeChatHighlight(hl.id);
    repaintHighlights();   // 聊天里的高亮撤掉；列表变了会回头刷新本页
}

function rowOf(group, chat, it) {
    const hl = it.h, key = `${group.cardId}/${chat.chatId}/${hl.id}`;
    const gone = it.text === null;
    const text = gone ? '（原文已经不在了）' : oneLine(it.text, ROW_TEXT_MAX) || '（空白）';
    const detail = h('div', { class: 'exc-detail', 'data-fk': 'exc-detail', hidden: !open.has(key) },
        h('div', { class: 'exc-full' }, gone ? '' : it.text.slice(0, DETAIL_TEXT_MAX) + (it.text.length > DETAIL_TEXT_MAX ? '……' : '')),
        hl.note ? h('div', { class: 'exc-note' }, h('b', {}, '备注：'), hl.note) : null);
    const main = h('button', { class: 'exc-main', 'data-fk': 'exc-main', type: 'button', title: '点开看全文和备注',
        onclick: () => { detail.hidden = !detail.hidden; if (detail.hidden) open.delete(key); else open.add(key); } },
        hl.note ? h('span', { class: 'exc-notemark', 'data-fk': 'exc-notemark', title: '这条有备注' }, '备注') : null,
        h('span', { class: 'exc-text' }, text));
    return h('div', { class: 'exc-item', 'data-fk': 'exc-item', 'data-id': hl.id },
        h('div', { class: 'exc-row' },
            main,
            h('span', { class: 'dim exc-floor' }, hl.from.floor === hl.to.floor ? `#${hl.from.floor}` : `#${hl.from.floor}–${hl.to.floor}`),
            h('button', { class: 'ghost', 'data-fk': 'exc-jump', type: 'button', title: '切到这个存档，滚到这一楼',
                onclick: () => jump(group.cardId, chat.chatId, hl) }, '跳转'),
            chat.current ? h('button', { class: 'ghost', 'data-fk': 'exc-del', type: 'button', title: '删除这条划线',
                onclick: () => removeLive(hl) }, '删除') : null),
        detail);
}

export async function renderExcerptsTab(force = false) {
    const tab = $('#tab-excerpts');
    if (!tab) return;
    const mine = ++seq;
    let groups;
    try { groups = await gather(force); } catch (e) { console.error(e); if (mine === seq) tab.replaceChildren(h('div', { class: 'log-line error' }, `读取划线失败：${e.message}`)); return; }
    if (mine !== seq) return;   // 读的时候又触发了新的刷新：以新的为准
    const total = groups.reduce((n, g) => n + g.chats.reduce((m, c) => m + c.items.length, 0), 0);
    if (!total) {
        tab.replaceChildren(h('div', { class: 'empty', 'data-fk': 'exc-empty' },
            '还没有划线。在聊天里选中一段文字（手机上长按选字），点旁边冒出来的「划线」，它就会记在这里；点已划的文字可以写备注、删除。'));
        return;
    }
    tab.replaceChildren(
        h('div', { class: 'dim exc-summary', 'data-fk': 'exc-summary' }, `共 ${total} 条划线（点一条看全文和备注）`),
        ...groups.map(g => h('div', { class: 'exc-card', 'data-fk': 'exc-card' },
            h('div', { class: 'section-title' }, g.cardName),
            ...g.chats.map(c => h('div', { class: 'exc-chat', 'data-fk': 'exc-chat' },
                h('div', { class: 'dim exc-chat-name' }, `${c.name ?? '新对话'}${c.current ? '（当前）' : ''} · ${c.items.length} 条`),
                ...c.items.map(it => rowOf(g, c, it)))))));
}
