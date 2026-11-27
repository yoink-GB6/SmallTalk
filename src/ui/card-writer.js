// 「写卡」：在应用里从零写一张角色卡，或者改当前卡的名字 / 头像 / 人设（描述）/ 开场白（含备选开场白）。
// 两个入口（用户 2026-11-28 定的：「写卡」= 新建，「编辑」= 改已有的卡）：
//   「存档」页最上面的「写卡」：打开一张还完全没动过的空白卡，没有就新建一张（archive.js openBlankCard，新建 = 现成的导入卡流程）；
//   每张卡那一行的「编辑」：这张卡不是当前卡就先走现成的切卡（聊天区要当预览），再进写卡页（editCard）。
// 写卡页、挑对比的角色列表、对比用的只读视图都画在「存档」页（#tab-archive）里，不加页签、不加导航栏。
// 纯逻辑（空白卡、没动过的判断、字段写回、开场白列表、头像尺寸）在 ../card-writer.js。
//
// 画面的几种状态（只在内存里，刷新页面就回到普通的「存档」页；卡的内容本身是随写随存的）：
//   mode null      普通的「存档」页（tab-archive.js 自己画）
//   mode 'write'   写卡页：编辑的永远是「当前卡」——离开后回来接着写，导入的卡也能在这里改
//   mode 'pick'    一列角色（头像小图 + 名字，不含当前卡），点哪个就进那张卡的只读对比视图；「← 回到写卡」
//   mode 'compare' 只读地显示某张卡的内容（各字段、世界书条目、正则），「← 返回」回到写卡页
//
// 写入：直接改 state.card（applyCardFields / setGreetings，名字 / 描述 / first_mes 同时改 card.raw）/ state.avatar，然后 save()——
// state.js 的防抖保存（400 ms，连续打字最多推迟 2 秒），所以打字时不会每个字写一次带头像的卡记录。
// 聊天区的实时预览（原地重建第 0 楼）再单独防抖 300 ms（archive.js refreshGreetingInPlace）。
// 拦截条件和改聊天记录同一套（chat.js chatWriteBlocked：生成中、恢复备份中、停止保存、只读），外加正在切换卡 / 存档。
//
// 页面重画：存档每落盘一次「存档」页都会被要求重画（archive.js onFlushed → invalidateArchiveTab），renderAll 也会来。
// 写卡页如果每次都整页重建，正在打的字、输入法的候选、光标都会被冲掉——所以页面只在「换了卡」时重建，其余时候原地更新：
// 有焦点的输入框不动，别的输入框值不同才改，按钮的禁用状态和提示重新算。开场白列表的条数变了（增 / 删）才重建那一块。
//
// 循环依赖：从兄弟 ui 模块导入的函数只在函数体里调用。

import { $, h, toast } from './dom.js';
import { substitute } from '../macros.js';
import { state, ui, persist, save, STOPPED_TEXT } from './state.js';
import { store } from '../store.js';
import { cardKey } from '../migrate.js';
import {
    applyCardFields, greetingList, setGreetings, filteredIndex, slotOfFiltered, followSlot, applyListOp, fitWithin, AVATAR_MAX_SIDE,
} from '../card-writer.js';
import { parseCardScripts, flattenScripts } from '../scripts.js';
import { openBlankCard, switchCard, newChat, refreshGreetingInPlace, chatUntouched, listCards } from './archive.js';   // 循环依赖：只在函数体里调用
import { renderArchiveTab } from './tab-archive.js';                     // 同上
import { chatWriteBlocked, editMessageText } from './chat.js';           // 同上
import { macroContext, permanentRegex } from './pipeline.js';            // 同上
import { renderAll } from './shell.js';                                  // 同上

// ───────────────────────────── 状态 ─────────────────────────────

const view = { mode: /** @type {null|'write'|'pick'|'compare'} */ (null), compareId: null };

/** 「存档」页现在该不该由本模块来画（写卡页、挑对比的角色列表、对比视图） */
export const writerOwnsTab = () => view.mode !== null;

function go(mode, compareId = null) {
    view.mode = mode;
    view.compareId = compareId;
    renderArchiveTab(true);
}

/**
 * 「存档」页顶上的「写卡」：打开一张没动过的空白卡（没有就新建），进写卡页。被拒（生成中、只读……）时 archive.js 已经提示了原因，不进写卡页
 */
export async function openWriter() {
    const r = await openBlankCard();
    if (!r || !state.card) return;
    clearTimeout(previewTimer);
    toast(r === 'created' ? `已新建空白卡「${state.card.name}」：写名字、人设和开场白，聊天区就是预览`
        : `还有一张没动过的空白卡「${state.card.name}」，接着用它`, 'ok');
    go('write');
    // 新卡第一件事多半是改名：焦点放进名字框并选中
    setTimeout(() => { const el = page?.els.name; if (el && page.cardId === persist.cardId) { el.focus(); el.select(); } }, 0);
}

/**
 * 每张卡那一行的「编辑」：不是当前卡就先切过去（现成的 switchCard：先落盘、生成中 / 只读 / 正在恢复时拒绝并提示原因），
 * 切成了才进写卡页；被拒就停在「存档」页
 */
export async function editCard(cardId) {
    if (cardId !== persist.cardId) {
        if (!await switchCard(cardId) || persist.cardId !== cardId) return;
    }
    go('write');
}
/** 写卡页的「返回」：回到普通的「存档」页 */
export const closeWriter = () => go(null);
/** 写卡页的「对比参考…」：一列角色 */
export const pickCompare = () => go('pick');
/** 角色列表 / 对比视图的「返回」：回到写卡页 */
export const backToWriter = () => go('write');
/** 角色列表里点某个角色 */
export const openCompare = cardId => go('compare', cardId);

// ───────────────────────────── 拦截 ─────────────────────────────

/**
 * 现在能不能改卡：能返回 null，不能返回给人看的原因。
 * 「正在切换」只在真要写的那一刻拦（act = true）：切换只有一瞬间，画页面时把它也算进去的话，切换途中画出来的页面会一直灰着
 * （切换结束时不一定再重画一次）
 */
function blocked(act = false) {
    const why = chatWriteBlocked(persist.epoch, '改卡');
    if (why) return why;
    if (persist.stopped) return STOPPED_TEXT;
    if (act && ui.switching) return '正在切换，请稍等';
    return null;
}

// ───────────────────────────── 字段说明（固定的一句话） ─────────────────────────────

const HINTS = {
    name: '角色叫什么。提示词、开场白、世界书里的 {{char}} 都会换成它。改名不会回头改已有存档的名字和已经发出的楼层。',
    avatar: '可选。顶栏和「存档」页显示用；导出时有头像就导出成 PNG 卡（数据写在这张图里），没有就是 JSON。'
        + `不裁剪；长边超过 ${AVATAR_MAX_SIDE} 像素的图会等比缩小。`,
    description: '角色是谁：外貌、性格、说话方式、背景、和 {{user}} 的关系。对应酒馆卡的「描述」（description），每次都会发给模型。',
    extras: '按关键词才出现的设定（地点、人物、物品……）放世界书；美化（把回复里的标记换成好看的样子）是这张卡自带的正则。'
        + '两个按钮跳到现成的页，编辑的就是这张卡自带的那份。',
};

// ───────────────────────────── 写卡页 ─────────────────────────────

/** 当前画着的写卡页：{root, cardId, greetRows, els}；换了卡就重建 */
let page = null;
let previewTimer = null;
let greetingNote = '';   // 开场白下面那行状态：实时预览中 / 新对话才会用到 / 用的那个被删了……
let noteFor = null;      // greetingNote 是哪张卡的

const avatarPicker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'data-fk': 'cw-avatar-file' });
avatarPicker.addEventListener('change', () => {
    const file = avatarPicker.files[0];
    avatarPicker.value = '';
    if (file) setAvatarFromFile(file);
});

/**
 * 画写卡页（tab-archive.js 在 writerOwnsTab() 时调用）。
 * @param {HTMLElement} tab #tab-archive
 */
export function drawWriter(tab) {
    if (view.mode === 'compare') return drawCompare(tab);
    if (view.mode === 'pick') return drawPick(tab);
    const cardId = state.card && persist.cardId ? persist.cardId : null;
    if (page && page.cardId === cardId && tab.contains(page.root)) { updatePage(); return; }
    if (noteFor !== cardId) { greetingNote = ''; noteFor = cardId; }   // 换了卡：上一张卡的提示不作数了
    page = buildPage(cardId);
    tab.replaceChildren(page.root, avatarPicker);
    updatePage();
}

function buildPage(cardId) {
    const back = h('button', { 'data-fk': 'cw-back', type: 'button', title: '回到「存档」页', onclick: closeWriter }, '← 返回');
    const head = h('div', { class: 'summary cw-bar' }, back, h('b', null, '写卡'), h('span', { class: 'spacer' }));
    const why = h('div', { class: 'dim cw-why', 'data-fk': 'cw-why', hidden: true });

    // 正常进不到这里（「写卡」会先建好卡）：写卡页开着时当前卡被删光了之类
    if (!cardId) {
        const root = h('div', { class: 'cw', 'data-card': '' }, head, why, h('div', { class: 'empty' }, '现在没有当前卡。点「← 返回」回到「存档」页。'));
        return { root, cardId, greetRows: [], els: { why } };
    }

    const compare = h('button', { 'data-fk': 'cw-compare', type: 'button', title: '挑一张别的卡，只读地看它的内容，写的时候参考', onclick: pickCompare }, '对比参考…');
    head.append(compare);

    const name = h('input', { class: 'cw-name', 'data-fk': 'cw-name', type: 'text', autocomplete: 'off', maxlength: 200, 'aria-label': '名字',
        oninput: e => onText('name', e.target) });
    const nameWarn = h('div', { class: 'cw-warn', hidden: true }, '名字不能为空：现在还是原来的名字');
    const img = h('img', { class: 'cw-avatar', alt: '' });
    const noImg = h('span', { class: 'cw-avatar cw-avatar-none' });
    const pickBtn = h('button', { 'data-fk': 'cw-avatar-pick', type: 'button', onclick: () => { if (guard()) avatarPicker.click(); } }, '选择图片');
    const dropBtn = h('button', { class: 'ghost', 'data-fk': 'cw-avatar-remove', type: 'button', onclick: removeAvatar }, '移除');
    const desc = h('textarea', { class: 'cw-desc', 'data-fk': 'cw-desc', rows: 8, spellcheck: false, 'aria-label': '人设（描述）',
        oninput: e => onText('description', e.target) });
    const greetBox = h('div', { class: 'cw-greets', 'data-fk': 'cw-greets' });
    const addGreet = h('button', { 'data-fk': 'cw-greet-add', type: 'button', title: '在最后加一个备选开场白', onclick: () => listOp({ type: 'add' }) }, '+ 再加一个开场白');
    const newChatBtn = h('button', { 'data-fk': 'cw-new-chat', type: 'button', title: '给这张卡新开一个存档，用勾着「当前」的那个开场白（没有勾着的就用第一个非空的），从头再聊',
        onclick: startNewChat }, '新对话');
    const greetNote = h('div', { class: 'dim cw-note', 'data-fk': 'cw-greet-note' });
    const worldBtn = h('button', { 'data-fk': 'cw-world', type: 'button', onclick: () => $('#tabs button[data-tab="world"]')?.click() }, '编辑世界书');
    const regexBtn = h('button', { 'data-fk': 'cw-regex', type: 'button', onclick: () => $('#tabs button[data-tab="regex"]')?.click() }, '编辑美化（正则）');

    const field = (label, hint, ...kids) => h('div', { class: 'cw-field' },
        h('div', { class: 'cw-label' }, label), hint ? h('div', { class: 'dim cw-hint' }, hint) : null, ...kids);
    const root = h('div', { class: 'cw', 'data-card': cardId }, head, why,
        field('名字', HINTS.name, name, nameWarn),
        field('头像', HINTS.avatar, h('div', { class: 'row cw-avatar-row' }, img, noImg, pickBtn, dropBtn)),
        field('人设（描述）', HINTS.description, desc),
        field('开场白', null, greetBox, h('div', { class: 'row' }, addGreet, newChatBtn), greetNote),
        field('世界书和美化', HINTS.extras, h('div', { class: 'row' }, worldBtn, regexBtn)));
    return { root, cardId, greetRows: [], els: { compare, why, name, nameWarn, img, noImg, pickBtn, dropBtn, desc, greetBox, addGreet, newChatBtn, greetNote, worldBtn, regexBtn } };
}

/**
 * 开场白列表那一块：每个开场白一行（标题 + ↑ ↓ 删除 + 文本框）。只在条数变了时重建（见 updatePage）；
 * 挪动不改条数，靠 updatePage 把各框的值换成新顺序（挪动是点按钮做的，焦点在按钮上，不会冲掉正在打的字）。
 */
function buildGreetRows(n) {
    page.greetRows = Array.from({ length: n }, (_, i) => {
        const ta = h('textarea', { class: 'cw-greet', 'data-fk': `cw-greet:${i}`, rows: i ? 4 : 6, spellcheck: false, 'aria-label': i ? `备选开场白 ${i}` : '开场白',
            oninput: e => onGreeting(i, e.target), onblur: () => commitFloor0() });
        const up = h('button', { class: 'ghost', 'data-fk': `cw-greet-up:${i}`, type: 'button', title: i === 1 ? '挪到第一个（成为默认开场白 first_mes）' : '往前挪',
            onclick: () => listOp({ type: 'move', from: i, to: i - 1 }) }, '↑');
        const down = h('button', { class: 'ghost', 'data-fk': `cw-greet-down:${i}`, type: 'button', title: '往后挪', onclick: () => listOp({ type: 'move', from: i, to: i + 1 }) }, '↓');
        const del = h('button', { class: 'ghost', 'data-fk': `cw-greet-del:${i}`, type: 'button', title: '删除这个开场白', onclick: () => listOp({ type: 'delete', at: i }) }, '删除');
        const cur = h('input', { type: 'radio', name: `cw-cur-${page.cardId}`, 'data-fk': `cw-greet-cur:${i}`, onchange: () => useGreeting(i) });
        const curLabel = h('label', { class: 'cw-greet-cur', title: '当前存档开头用的是这个开场白。点别的那个：当前存档改用它（只有还没聊过的存档能这样换）' }, cur, '当前');
        const row = h('div', { class: 'cw-greet-row', 'data-i': String(i) },
            h('div', { class: 'row cw-greet-head' }, h('span', { class: 'cw-greet-label' }, i ? `备选 ${i}` : '第一个（默认）'), curLabel, h('span', { class: 'spacer' }), up, down, del), ta);
        return { row, ta, up, down, del, cur };
    });
    page.els.greetBox.replaceChildren(...page.greetRows.map(r => r.row));
}

/** 原地更新：输入框的值（有焦点的不动）、头像、开场白列表、禁用状态和原因 */
function updatePage() {
    const e = page.els;
    const why = blocked();
    const ro = why !== null;
    e.why.hidden = !why;
    e.why.textContent = why ? `现在不能改：${why}` : '';
    if (!page.cardId) return;
    const c = state.card;
    const setVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
    setVal(e.name, c.name);
    if (document.activeElement !== e.name) e.nameWarn.hidden = true;
    setVal(e.desc, c.description ?? '');
    const list = greetingList(c);
    if (page.greetRows.length !== list.length) buildGreetRows(list.length);
    const curSlot = trackedSlot();   // 当前存档用的是哪一个（跟丢了 / 开的时候一个都没有 = 哪个都不勾）
    page.greetRows.forEach((r, i) => {
        r.cur.checked = curSlot === i;
        r.cur.disabled = ro || !list[i];   // 空着的开场白不能选（新对话也不会用到它）
        setVal(r.ta, list[i]);
        r.ta.readOnly = ro;
        r.up.disabled = ro || i === 0;
        r.down.disabled = ro || i === list.length - 1;
        r.del.disabled = ro || list.length < 2;   // 至少留一个（不想要开场白就把它清空）
    });
    e.addGreet.disabled = ro;
    e.newChatBtn.disabled = ro;
    for (const el of [e.name, e.desc]) el.readOnly = ro;
    e.pickBtn.disabled = ro;
    e.dropBtn.disabled = ro || !state.avatar;
    e.img.hidden = !state.avatar;
    e.noImg.hidden = !!state.avatar;
    if (state.avatar && e.img.getAttribute('src') !== state.avatar) e.img.src = state.avatar;
    e.greetNote.textContent = greetingNote;
}

/** 有不能改的原因就提示并返回 false */
function guard() {
    const why = blocked(true);
    if (why === null) return true;
    if (why) toast(why, 'error');
    return false;
}

/** 这个写卡页还是当前卡的吗（换了卡之后旧页面上迟到的事件不能写进新卡） */
const stillMine = () => !!page && page.cardId === persist.cardId && !!state.card;

function onText(field, el) {
    if (!stillMine()) return;
    if (!guard()) { el.value = field === 'description' ? state.card.description : state.card.name; return; }
    if (field === 'name') {
        const empty = !el.value.trim();
        page.els.nameWarn.hidden = !empty;
        if (empty) return;   // 空名字不接受：卡还是原来的名字，输入框里先留着让用户接着打
    }
    let changed;
    try { changed = applyCardFields(state.card, { [field]: el.value }); } catch (err) { toast(err.message, 'error'); return; }
    if (!changed.length) return;
    save();
    schedulePreview(field === 'name');   // 改名：第 0 楼里的 {{char}} 和楼层上的名字要跟着重建；改描述不碰聊天区
}

// ── 开场白列表 ──

function onGreeting(i, el) {
    if (!stillMine()) return;
    const list = greetingList(state.card);
    if (!guard()) { el.value = list[i] ?? ''; return; }
    if (i >= list.length) return;
    trackedSlot();   // 改之前先记下「存档是用哪个开场白开的」（改的正是那个时，改完再按文字去认就认不出了）
    const before = list[i];
    list[i] = el.value;
    if (!setGreetings(state.card, list)) return;
    save();
    if (chatUntouched()) { schedulePreview(true); return; }
    // 聊过的存档：不每个字改一次第 0 楼（每次改原文都会让这一轮的外置记忆作废、开着记忆时会发一次压缩请求，花额度），
    // 记下「这次编辑前」的开场白，失焦（onblur）或停手 1.5 秒时 commitFloor0 写一次
    if (pendingFloor0 && pendingFloor0.slot !== i) commitFloor0();
    if (!pendingFloor0) pendingFloor0 = { slot: i, base: before, cardId: persist.cardId, epoch: persist.epoch };
    clearTimeout(floor0Timer);
    floor0Timer = setTimeout(commitFloor0, 1500);
    schedulePreview(false);   // 顶栏、开场白下拉框、拼装预览
}

/**
 * 聊过的存档里改开场白：攒着的一次编辑（{slot, base: 这次编辑前的开场白原文, cardId, epoch}）。
 * 失焦或停手 1.5 秒时 commitFloor0 处理，处理完清空。
 */
let pendingFloor0 = null;
let floor0Timer = null;

/**
 * 开场白原文 → 进第 0 楼时存下的样子：照 chat.js startChat 建第 0 楼的做法——先宏替换（macroContext([], 变量)），再跑永久生效的正则
 * （permanentRegex，「编辑」时跑的正则和新建时可能不同，所以两种都算）。变量用副本：这里只是为了比较 / 生成文字，
 * 不能让开场白里的 {{setvar}} 之类在比较时真的改了这个存档的变量。宏里有随机的（{{random}} 没开固定结果时）两次算出来会不同，
 * 那时就认不出、不改——宁可不动。
 */
function renderGreeting(text) {
    const sub = substitute(text, macroContext([], structuredClone(state.variables)));
    return { sub, stored: new Set([permanentRegex(sub, 'assistant'), permanentRegex(sub, 'assistant', true)]) };
}

/**
 * 把攒着的那次开场白编辑写进这个（聊过的）存档的第 0 楼——只在这两条都成立时：
 *   1. 这个存档开头用的就是正在改的这一项（trackedSlot，和实时预览同一套跟踪；用别的开场白开的不动）；
 *   2. 第 0 楼现在存的原文 = 这次编辑【前】的开场白进第 0 楼时会存的样子（renderGreeting）——用户手动改过第 0 楼、
 *      或者第 0 楼根本不是开场白（开的时候没有开场白，第 0 楼是用户的话），就对不上，不动。
 * 写的时候走界面上「编辑一楼并保存」的同一个函数 chat.js editMessageText（它负责永久正则、候选同步、这一轮的外置记忆作废重压、
 * 存盘、重画、发 MESSAGE_EDITED / UPDATED）；拦截条件照它的调用方的规矩先判断（chatWriteBlocked，见 guard）。
 * 写进去的是新开场白宏替换之后的文字（和 startChat 一样，第 0 楼里不留 {{user}} 这种宏）。
 */
function commitFloor0() {
    clearTimeout(floor0Timer);
    const p = pendingFloor0;
    pendingFloor0 = null;
    if (!p || p.cardId !== persist.cardId || p.epoch !== persist.epoch || !state.card) return;
    if (chatUntouched()) return;   // 这期间存档变成了没聊过的（不会发生，防御）：实时预览那条路已经管了
    if (blocked(true) !== null) { greetingNote = '现在不能改聊天记录，这个存档的第 0 楼没有跟着改。'; if (page) updatePage(); return; }
    const list = greetingList(state.card);
    const now = list[p.slot] ?? '';
    if (now === p.base) return;
    const m = state.chat[0];
    const slot = trackedSlot();
    if (slot !== p.slot) greetingNote = '这个存档开头用的不是这个开场白，没有改它；新对话才会用到新的开场白。';
    else if (!m || m.role !== 'assistant' || !renderGreeting(p.base).stored.has(m.content)) greetingNote = '这个存档的第 0 楼和开场白对不上（手动改过，或者开头不是开场白），没有改它；新对话才会用到新的开场白。';
    else if (!now) greetingNote = '开场白清空了：这个存档的第 0 楼没有跟着删，新对话才会用到。';
    else {
        editMessageText(0, renderGreeting(now).sub);
        greetingNote = '已经改到这个存档的第 0 楼（后面的楼没动）。';
    }
    if (page) updatePage();
}

/**
 * 写卡页的「新对话」：给这张卡新开一个存档，用勾着「当前」的那个开场白（没有勾着的就用第一个非空的）。
 * 走「存档」页「新对话」的同一条路（archive.js newChat：先落盘；生成中 / 只读 / 正在恢复时拒绝并提示；存档还没动过就原地换开场白）。
 */
async function startNewChat() {
    if (!stillMine() || !guard()) return;
    commitFloor0();
    const list = greetingList(state.card);
    const slot = trackedSlot();
    const fi = typeof slot === 'number' && filteredIndex(list, slot) >= 0 ? filteredIndex(list, slot) : 0;
    clearTimeout(previewTimer);
    previewChat = false;
    const sel = $('#greeting-select');
    if (sel && fi < sel.options.length) sel.value = String(fi);   // 「存档」页的下拉框也指到这一项
    await newChat(fi);
    if (page) updatePage();
}

/**
 * 点某个开场白的「当前」：当前存档改用它。走「存档」页换开场白的同一条路（archive.js newChat：存档没动过就原地换第 0 楼，
 * 照常发酒馆的 CHAT_CREATED 等事件），换完存档的 greeting 记录变了，trackedSlot 自然认到这一项。
 * 存档已经聊过：不能原地换（newChat 会另开一个存档，这里不该这么做），提示一句，勾选回到原来那个。
 */
async function useGreeting(i) {
    if (!stillMine() || !guard()) { updatePage(); return; }
    const list = greetingList(state.card);
    const fi = filteredIndex(list, i);
    if (fi < 0) { updatePage(); return; }
    if (!chatUntouched()) {
        toast('这个存档已经聊过了，不能换开头的开场白：点旁边的「新对话」用它从头开一个', 'error');
        updatePage();
        return;
    }
    clearTimeout(previewTimer);   // 还没到点的预览别在换完之后又按旧的一项重建
    previewChat = false;
    const sel = $('#greeting-select');
    if (sel && fi < sel.options.length) sel.value = String(fi);   // 「存档」页的下拉框也指到这一项
    await newChat(fi);
    if (page) updatePage();
}

/** 增 / 删 / 挪：先算出存档用的那个开场白去了哪，再改列表、存盘、重画 */
function listOp(op) {
    if (!stillMine() || !guard()) return;
    const list = greetingList(state.card);
    if (op.type === 'move' && (op.to < 0 || op.to >= list.length)) return;
    if (op.type === 'delete' && list.length < 2) return;
    const slot = trackedSlot();
    setGreetings(state.card, applyListOp(list, op));
    if (track) track.slot = typeof slot === 'number' ? followSlot(slot, op) : slot;
    save();
    updatePage();
    schedulePreview(true);
    if (op.type === 'add') setTimeout(() => page?.greetRows.at(-1)?.ta.focus(), 0);
}

/**
 * 实时预览要跟着「当前存档是用哪个开场白开的」走。存档只记了它在过滤掉空开场白之后的列表里是第几个（greeting.index）和当时的文字。
 * 第一次需要时按 greeting.index 换算成槽位（未过滤列表里的位置），之后写卡页每次增删挪都把槽位跟着挪（listOp → followSlot），
 * 被删掉就是 null（不再跟，聊天区不动，提示一句）。存档的 greeting 记录一变（换了存档、在「存档」页换了开场白、
 * 我们自己重建了第 0 楼）就重新换算——记录里的 index / text 就是判断依据；我们自己重建之后会立刻把记录对上（见 schedulePreview），
 * 所以不会把「跟丢了」又重算回来。
 * 特例：存档开的时候一个开场白都没有（greeting.text 为空，第 0 楼不存在，比如刚新建的空白卡）——它没有「用的那个」，
 * 记成 'auto'：哪个开场白成了第一个非空的，就用哪个（= 这时点新对话会出现的那个）。
 */
let track = null;   // {epoch, cardId, gi, gt, slot: 槽位 | null（跟丢了）| 'auto'}
function trackedSlot() {
    const g = persist.chatMeta?.greeting;
    if (!g) { track = null; return null; }
    if (track && track.epoch === persist.epoch && track.cardId === persist.cardId && track.gi === g.index && track.gt === g.text) return track.slot;
    const slot = g.text === '' ? 'auto' : slotOfFiltered(greetingList(state.card), Number(g.index) || 0);
    track = { epoch: persist.epoch, cardId: persist.cardId, gi: g.index, gt: g.text, slot };
    return slot;
}

/**
 * 改完之后：聊天区第 0 楼（没聊过的存档）原地重建、顶栏的卡名、开场白下拉框、拼装预览跟着变。防抖 300 ms，
 * 到点时卡已经换了就什么都不做（新卡自己会整页重画）。chat = false（只改了描述）时不碰聊天区。
 */
let previewChat = false;
function schedulePreview(chat) {
    clearTimeout(previewTimer);
    previewChat ||= chat;
    const cardId = persist.cardId;
    previewTimer = setTimeout(() => {
        const doChat = previewChat;
        previewChat = false;
        if (persist.cardId !== cardId || !state.card) return;
        let updated = false;
        if (doChat) {
            const slot = trackedSlot();
            const list = greetingList(state.card);
            const fi = slot === 'auto' ? (list.some(Boolean) ? 0 : -1) : slot === null ? -1 : filteredIndex(list, slot);
            if (!chatUntouched()) { /* 聊过的存档：改开场白走 commitFloor0；改名不回头改已发出的楼层 */ }
            else if (slot === null) greetingNote = '这个存档开头用的那个开场白已经删掉了：聊天区先不动，点「存档」页的「新对话」会按新的列表开。';
            else if (fi < 0) greetingNote = slot === 'auto' ? '' : '这个存档开头用的那个开场白现在是空的：聊天区先不动，写上内容后会接着跟着变。';
            else {
                const r = refreshGreetingInPlace(fi);   // 'updated' 时它自己已经 startChat → renderAll
                if (r === 'updated') {
                    updated = true;
                    const g = persist.chatMeta.greeting;
                    const now = slot === 'auto' ? slotOfFiltered(list, 0) : slot;
                    track = { epoch: persist.epoch, cardId: persist.cardId, gi: g.index, gt: g.text, slot: now };
                    greetingNote = now === 0 ? '这个存档还没聊过：聊天区第 0 楼跟着实时变。' : `这个存档还没聊过，开头用的是「备选 ${now}」：改它时聊天区第 0 楼跟着变。`;
                }
            }
        }
        if (!updated) { ui.previewIsSent = false; renderAll(); }   // 顶栏、开场白下拉框（renderTopbar）、拼装预览
        if (page && page.cardId === cardId) updatePage();
    }, 300);
}

// ───────────────────────────── 头像 ─────────────────────────────

/**
 * 选好的图片 → 卡的头像（data URL，存在卡记录的 avatar 上，和导入 PNG 卡时一样）。
 *   - 不裁剪、保持比例。长边不超过 AVATAR_MAX_SIDE：原文件原样存（readAsDataURL，和 importer.js 导入 PNG 卡同一种存法；JPEG / WebP 也原样）。
 *   - 长边超过：画到 canvas 上等比缩小再编码。PNG / GIF（可能有透明）编成 PNG；JPEG / WebP 等照片编成 JPEG（质量 0.92）——
 *     照片编成 PNG 会大好几倍。导出卡时 export-st.js cardToFile 本来就会把不是 PNG 的头像先画成 PNG 再写数据进去，所以存 JPEG 不影响导出。
 */
async function setAvatarFromFile(file) {
    if (!stillMine() || !guard()) return;
    const cardId = persist.cardId;
    let url;
    try {
        url = await imageToAvatar(file);
    } catch (e) {
        console.warn(e);
        return void toast(`这张图片读不出来：${e.message}`, 'error');
    }
    // 读图是异步的：期间换了卡 / 开始生成 / 变只读，就不写
    if (persist.cardId !== cardId || !stillMine() || !guard()) return;
    state.avatar = url;
    save();
    ui.rendered.clear();
    renderAll();
    updatePage();
}

/** 文件 → 头像 data URL（规则见 setAvatarFromFile） */
export async function imageToAvatar(file) {
    const src = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = src;
        await img.decode();
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸是 0');
        const size = fitWithin(img.naturalWidth, img.naturalHeight);
        if (!size) {
            return await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error);
                r.readAsDataURL(file);
            });
        }
        const canvas = document.createElement('canvas');
        canvas.width = size.w;
        canvas.height = size.h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size.w, size.h);
        const keepAlpha = /^image\/(png|gif)$/i.test(file.type) || /\.(png|gif)$/i.test(file.name ?? '');
        return keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
    } finally {
        URL.revokeObjectURL(src);
    }
}

function removeAvatar() {
    if (!stillMine() || !guard() || !state.avatar) return;
    state.avatar = '';
    save();
    ui.rendered.clear();
    renderAll();
    updatePage();
}

// ───────────────────────────── 挑对比的角色（一列） ─────────────────────────────

let pickSeq = 0;

/** 一列角色：头像小图 + 名字（不含当前正在写的这张卡），点哪个进它的对比视图。读卡列表（listCards），不写任何东西 */
function drawPick(tab) {
    page = null;   // 回到写卡页时重建
    if (tab.querySelector(':scope > .cw-pick-view')) return;   // 已经画着（落盘引起的重画）：不重读
    const back = h('button', { class: 'primary', 'data-fk': 'cw-pick-back', type: 'button', title: '回到写卡页', onclick: backToWriter }, '← 回到写卡');
    const body = h('div', { class: 'cw-pick-list' }, h('div', { class: 'dim' }, '读取中…'));
    tab.replaceChildren(h('div', { class: 'cw cw-pick-view' }, h('div', { class: 'summary cw-bar' }, back, h('b', null, '对比参考：挑一张卡')), body));
    const mine = ++pickSeq;
    listCards().then(cards => {
        if (mine !== pickSeq || view.mode !== 'pick') return;
        const others = cards.filter(c => c.id !== persist.cardId);
        body.replaceChildren(...(others.length ? others.map(c => h('button', { class: 'cw-pick-item', 'data-fk': `cw-pick:${c.id}`, type: 'button',
            title: `只读地看「${c.name}」的内容，不切换当前卡`, onclick: () => openCompare(c.id) },
            c.avatar ? h('img', { class: 'arch-avatar', src: c.avatar, alt: '' }) : h('span', { class: 'arch-avatar arch-avatar-none' }, String(c.name ?? '?').slice(0, 1)),
            h('span', { class: 'arch-name' }, c.name)))
            : [h('div', { class: 'empty' }, '没有别的卡可以对比')]));
    }, e => {
        console.error(e);
        if (mine === pickSeq) body.replaceChildren(h('div', { class: 'empty' }, `读取失败：${e.message}`));
    });
}

// ───────────────────────────── 对比（只读） ─────────────────────────────

let compareSeq = 0;

/**
 * 只读地显示一张卡的内容：读存储里那张卡的记录（'card:<id>'），不切换当前卡、不写任何东西。
 * 要对比的就是当前卡时用内存里的（存储里的可能还差最后几百毫秒的改动）。
 */
function drawCompare(tab) {
    page = null;   // 回到写卡页时重建
    // 已经在显示这张卡了就不重画（每次落盘「存档」页都会被要求重画，重读会让内容闪回「读取中…」、滚动位置也丢了）
    const shown = tab.querySelector(':scope > .cw-compare-view');
    if (shown && shown.dataset.card === String(view.compareId)) return;
    const back = h('button', { 'data-fk': 'cw-compare-back', type: 'button', title: '回到写卡页', onclick: backToWriter }, '← 返回');
    const bar = h('div', { class: 'summary cw-bar' }, back, h('b', null, '对比参考（只读）'));
    const body = h('div', { class: 'cw-compare', 'data-fk': 'cw-compare-body' }, h('div', { class: 'dim' }, '读取中…'));
    tab.replaceChildren(h('div', { class: 'cw cw-compare-view', 'data-card': String(view.compareId) }, bar, body));
    const id = view.compareId, mine = ++compareSeq;
    const read = id === persist.cardId && state.card ? Promise.resolve({ card: state.card, avatar: state.avatar }) : store.get(cardKey(id));
    read.then(rec => {
        if (mine !== compareSeq || view.mode !== 'compare') return;
        body.replaceChildren(...(rec?.card ? compareContent(rec.card, rec.avatar) : [h('div', { class: 'empty' }, '这张卡已经不在了')]));
    }, e => {
        console.error(e);
        if (mine === compareSeq) body.replaceChildren(h('div', { class: 'empty' }, `读取失败：${e.message}`));
    });
}

/** 一张卡的各部分，全部用 <pre> / 文本节点画（卡内容是不可信的，不走 innerHTML，也不渲染 markdown / 前端卡） */
function compareContent(c, avatar) {
    const s = v => (typeof v === 'string' ? v : '');
    const text = (label, v) => (s(v) ? h('div', { class: 'cw-field' }, h('div', { class: 'cw-label' }, label), h('pre', { class: 'block cw-pre' }, s(v))) : null);
    const out = [];
    out.push(h('div', { class: 'row cw-compare-head' },
        avatar ? h('img', { class: 'cw-avatar', src: avatar, alt: '' }) : null,
        h('b', { class: 'cw-compare-name' }, s(c.name) || '?')));
    out.push(text('人设（描述）', c.description), text('性格', c.personality), text('场景', c.scenario), text('开场白', c.firstMes));
    const alts = Array.isArray(c.alternateGreetings) ? c.alternateGreetings.filter(x => typeof x === 'string' && x) : [];
    alts.forEach((g, i) => out.push(text(`备选开场白 ${i + 1}`, g)));
    out.push(text('对话示例', c.mesExample), text('system_prompt', c.systemPrompt), text('post_history_instructions', c.postHistoryInstructions),
        text('深度提示', c.depthPrompt?.prompt), text('作者备注（creator_notes）', c.creatorNotes));

    const entries = Array.isArray(c.worldEntries) ? c.worldEntries : [];
    out.push(h('div', { class: 'section-title' }, `世界书（${entries.length} 条）`));
    if (!entries.length) out.push(h('div', { class: 'dim' }, '没有'));
    for (const e of entries) {
        const keys = [...(Array.isArray(e?.key) ? e.key : []), ...(Array.isArray(e?.keysecondary) ? e.keysecondary : [])].join('，');
        out.push(h('div', { class: 'card cw-item' },
            h('header', null, h('b', null, s(e?.comment) || `条目 ${e?.uid ?? '?'}`),
                e?.constant ? h('span', { class: 'badge' }, '常驻') : null,
                e?.disable ? h('span', { class: 'badge off' }, '已禁用') : null,
                keys ? h('span', { class: 'dim cw-keys' }, `关键词：${keys}`) : null),
            h('div', { class: 'body' }, h('pre', { class: 'block cw-pre' }, s(e?.content)))));
    }

    const regex = Array.isArray(c.regexScripts) ? c.regexScripts : [];
    out.push(h('div', { class: 'section-title' }, `正则（${regex.length} 条）`));
    if (!regex.length) out.push(h('div', { class: 'dim' }, '没有'));
    for (const r of regex) {
        out.push(h('div', { class: 'card cw-item' },
            h('header', null, h('b', null, s(r?.scriptName) || '(没有名字)'), r?.disabled ? h('span', { class: 'badge off' }, '已禁用') : null),
            h('div', { class: 'body' },
                h('div', { class: 'dim' }, '找：'), h('pre', { class: 'block cw-pre' }, s(r?.findRegex)),
                h('div', { class: 'dim' }, '换成：'), h('pre', { class: 'block cw-pre' }, s(r?.replaceString)))));
    }

    let nScripts = 0;
    try { nScripts = flattenScripts(parseCardScripts(c.raw)).length; } catch { /* 坏数据：当作没有 */ }
    if (nScripts) out.push(h('div', { class: 'dim cw-note' }, `这张卡还带 ${nScripts} 个酒馆助手脚本（在「正则」页下面的「脚本」区，这里不列）。`));
    return out.filter(Boolean);
}
