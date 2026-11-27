// 「写卡」：在应用里从零写一张角色卡，或者改当前卡的名字 / 头像 / 人设（描述）/ 开场白。
// 入口是「存档」页最上面的「写卡」按钮；写卡页、对比用的只读视图都画在「存档」页（#tab-archive）里，不加页签、不加导航栏。
// 纯逻辑（空白卡、字段写回、头像几何）在 ../card-writer.js；建卡走 archive.js 的 createBlankCard（= 现成的导入卡流程）。
//
// 画面的几种状态（只在内存里，刷新页面就回到普通的「存档」页；卡的内容本身是随写随存的）：
//   mode null      普通的「存档」页（tab-archive.js 自己画）
//   mode 'write'   写卡页：编辑的永远是「当前卡」——离开后回来接着写，导入的卡也能在这里改
//   mode 'pick'    「存档」页照常画，但每张（非当前的）卡右边多一个「对比」，顶上一条「回到写卡」（tab-archive.js 读 writerPicking()）
//   mode 'compare' 只读地显示某张卡的内容（各字段、世界书条目、正则），带「返回」回到写卡页
// 「对比」按钮只在 'pick' 下出现：平时的「存档」页看不到它（用户定的「只在写卡时」）。
//
// 写入：直接改 state.card（applyCardFields 同时改 card.raw）/ state.avatar，然后 save()——state.js 的防抖保存（400 ms，连续打字最多推迟 2 秒），
// 所以打字时不会每个字写一次带头像的卡记录。聊天区的实时预览（原地重建第 0 楼）再单独防抖 300 ms（archive.js refreshGreetingInPlace）。
// 拦截条件和改聊天记录同一套（chat.js chatWriteBlocked：生成中、恢复备份中、停止保存、只读），外加正在切换卡 / 存档。
//
// 页面重画：存档每落盘一次「存档」页都会被要求重画（archive.js onFlushed → invalidateArchiveTab），renderAll 也会来。
// 写卡页如果每次都整页重建，正在打的字、输入法的候选、光标都会被冲掉——所以页面只在「换了卡」时重建，其余时候原地更新：
// 有焦点的输入框不动，别的输入框值不同才改，按钮的禁用状态和提示重新算。
//
// 循环依赖：从兄弟 ui 模块导入的函数只在函数体里调用。

import { $, h, toast } from './dom.js';
import { state, ui, persist, save, STOPPED_TEXT } from './state.js';
import { store } from '../store.js';
import { cardKey } from '../migrate.js';
import { applyCardFields, coverRect, AVATAR_W, AVATAR_H } from '../card-writer.js';
import { parseCardScripts, flattenScripts } from '../scripts.js';
import { createBlankCard, refreshGreetingInPlace } from './archive.js';   // 循环依赖：只在函数体里调用
import { renderArchiveTab } from './tab-archive.js';                     // 同上
import { chatWriteBlocked } from './chat.js';                            // 同上
import { renderAll } from './shell.js';                                  // 同上
import { exportCardFile } from './export-st.js';

// ───────────────────────────── 状态 ─────────────────────────────

const view = { mode: /** @type {null|'write'|'pick'|'compare'} */ (null), compareId: null };

/** 「存档」页现在该不该由本模块来画（写卡页或对比视图） */
export const writerOwnsTab = () => view.mode === 'write' || view.mode === 'compare';
/** 「存档」页正在给写卡挑对比的卡：每张卡多一个「对比」按钮 */
export const writerPicking = () => view.mode === 'pick';

function go(mode, compareId = null) {
    view.mode = mode;
    view.compareId = compareId;
    renderArchiveTab(true);
}

/** 「存档」页顶上的「写卡」按钮 */
export const openWriter = () => go('write');
/** 写卡页的「返回」：回到普通的「存档」页（「对比」按钮随之消失） */
export const closeWriter = () => go(null);
/** 写卡页的「对比参考…」：回到「存档」页挑一张卡 */
export const pickCompare = () => go('pick');
/** 「存档」页（挑对比时）顶上的「回到写卡」 */
export const backToWriter = () => go('write');
/** 某张卡右边的「对比」 */
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
        + `选的图会照酒馆的做法铺满裁成 ${AVATAR_W}×${AVATAR_H}、存成 PNG。`,
    description: '角色是谁：外貌、性格、说话方式、背景、和 {{user}} 的关系。对应酒馆卡的「描述」（description），每次都会发给模型。',
    firstMes: '角色说的第一句话：新对话开始时显示在第 0 楼，也给模型定下文风和格式。可以用 {{user}}、{{char}}。',
    extras: '按关键词才出现的设定（地点、人物、物品……）放世界书；美化（把回复里的标记换成好看的样子）是这张卡自带的正则。'
        + '两个按钮跳到现成的页，编辑的就是这张卡自带的那份。',
};

// ───────────────────────────── 写卡页 ─────────────────────────────

/** 当前画着的写卡页：{root, cardId, els}；换了卡就重建 */
let page = null;
let previewTimer = null;
let greetingNote = '';   // 开场白下面那行状态：实时预览中 / 新对话才会用到
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
    const cardId = state.card && persist.cardId ? persist.cardId : null;
    if (page && page.cardId === cardId && tab.contains(page.root)) { updatePage(); return; }
    if (noteFor !== cardId) { greetingNote = ''; noteFor = cardId; }   // 换了卡：上一张卡的「实时变 / 新对话才会用到」不作数了
    page = buildPage(cardId);
    tab.replaceChildren(page.root, avatarPicker);
    updatePage();
}

function buildPage(cardId) {
    const back = h('button', { 'data-fk': 'cw-back', type: 'button', title: '回到「存档」页', onclick: closeWriter }, '← 返回');
    const create = h('button', { class: 'primary', 'data-fk': 'cw-new', type: 'button', title: '新建一张空白卡并切过去：聊天区就是它的实时预览',
        onclick: onCreate }, '新建空白卡');
    const head = h('div', { class: 'summary cw-bar' }, back, h('b', null, '写卡'), h('span', { class: 'spacer' }), create);
    const why = h('div', { class: 'dim cw-why', 'data-fk': 'cw-why', hidden: true });

    if (!cardId) {
        const root = h('div', { class: 'cw', 'data-card': '' }, head, why,
            h('div', { class: 'empty' }, '现在还没有角色卡。点「新建空白卡」从零开始写一张：它会直接成为当前卡，聊天区就是开场白和美化的实时预览。'
                + '也可以先导入一张卡，再回到这里改它。'));
        return { root, cardId, els: { create, why } };
    }

    const compare = h('button', { 'data-fk': 'cw-compare', type: 'button', title: '回到「存档」页，挑一张别的卡只读地看它的内容，写的时候参考', onclick: pickCompare }, '对比参考…');
    const exportBtn = h('button', { 'data-fk': 'cw-export', type: 'button', title: '导出成酒馆角色卡：有头像是 PNG，没有是 JSON',
        onclick: () => exportCardFile(state.card, state.avatar) }, '导出');
    head.append(compare, exportBtn);

    const name = h('input', { class: 'cw-name', 'data-fk': 'cw-name', type: 'text', autocomplete: 'off', maxlength: 200, 'aria-label': '名字',
        oninput: e => onText('name', e.target) });
    const nameWarn = h('div', { class: 'cw-warn', hidden: true }, '名字不能为空：现在还是原来的名字');
    const img = h('img', { class: 'cw-avatar', alt: '' });
    const noImg = h('span', { class: 'cw-avatar cw-avatar-none' });
    const pickBtn = h('button', { 'data-fk': 'cw-avatar-pick', type: 'button', onclick: () => { if (guard()) avatarPicker.click(); } }, '选择图片');
    const dropBtn = h('button', { class: 'ghost', 'data-fk': 'cw-avatar-remove', type: 'button', onclick: removeAvatar }, '移除');
    const desc = h('textarea', { class: 'cw-desc', 'data-fk': 'cw-desc', rows: 8, spellcheck: false, 'aria-label': '人设（描述）',
        oninput: e => onText('description', e.target) });
    const greet = h('textarea', { class: 'cw-greet', 'data-fk': 'cw-greet', rows: 6, spellcheck: false, 'aria-label': '开场白',
        oninput: e => onText('firstMes', e.target) });
    const greetNote = h('div', { class: 'dim cw-note', 'data-fk': 'cw-greet-note' });
    const worldBtn = h('button', { 'data-fk': 'cw-world', type: 'button', onclick: () => $('#tabs button[data-tab="world"]')?.click() }, '编辑世界书');
    const regexBtn = h('button', { 'data-fk': 'cw-regex', type: 'button', onclick: () => $('#tabs button[data-tab="regex"]')?.click() }, '编辑美化（正则）');

    const field = (label, hint, ...kids) => h('div', { class: 'cw-field' },
        h('div', { class: 'cw-label' }, label), h('div', { class: 'dim cw-hint' }, hint), ...kids);
    const root = h('div', { class: 'cw', 'data-card': cardId }, head, why,
        field('名字', HINTS.name, name, nameWarn),
        field('头像', HINTS.avatar, h('div', { class: 'row cw-avatar-row' }, img, noImg, pickBtn, dropBtn)),
        field('人设（描述）', HINTS.description, desc),
        field('开场白', HINTS.firstMes, greet, greetNote),
        field('世界书和美化', HINTS.extras, h('div', { class: 'row' }, worldBtn, regexBtn)));
    return { root, cardId, els: { create, compare, why, name, nameWarn, img, noImg, pickBtn, dropBtn, desc, greet, greetNote, worldBtn, regexBtn } };
}

/** 原地更新：输入框的值（有焦点的不动）、头像、禁用状态和原因 */
function updatePage() {
    const e = page.els;
    const why = blocked();
    const ro = why !== null;
    e.why.hidden = !why;
    e.why.textContent = why ? `现在不能改：${why}` : '';
    // 新建也是一次「切到另一张卡」：照 archive.js canSwitch 的条件（它自己还会再查一遍并提示）
    e.create.disabled = ro || ui.busy || persist.readOnly;
    if (!page.cardId) return;
    const c = state.card;
    const setVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
    setVal(e.name, c.name);
    if (document.activeElement !== e.name) e.nameWarn.hidden = true;
    setVal(e.desc, c.description ?? '');
    setVal(e.greet, c.firstMes ?? '');
    for (const el of [e.name, e.desc, e.greet]) el.readOnly = ro;
    for (const el of [e.pickBtn, e.dropBtn]) el.disabled = ro;
    if (state.avatar) e.dropBtn.disabled = ro; else e.dropBtn.disabled = true;
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
    if (!guard()) { el.value = field === 'description' ? state.card.description : field === 'firstMes' ? state.card.firstMes : state.card.name; return; }
    if (field === 'name') {
        const empty = !el.value.trim();
        page.els.nameWarn.hidden = !empty;
        if (empty) return;   // 空名字不接受：卡还是原来的名字，输入框里先留着让用户接着打
    }
    let changed;
    try { changed = applyCardFields(state.card, { [field]: el.value }); } catch (err) { toast(err.message, 'error'); return; }
    if (!changed.length) return;
    save();
    schedulePreview();
}

/**
 * 改完之后：聊天区第 0 楼（没聊过的存档）原地重建、顶栏的卡名、开场白下拉框、拼装预览跟着变。防抖 300 ms，
 * 到点时卡已经换了就什么都不做（新卡自己会整页重画）。
 */
function schedulePreview() {
    clearTimeout(previewTimer);
    const cardId = persist.cardId;
    previewTimer = setTimeout(() => {
        if (persist.cardId !== cardId || !state.card) return;
        const r = refreshGreetingInPlace();   // 'updated' 时它自己已经 startChat → renderAll
        if (r === 'kept') greetingNote = '这个存档已经聊过了，不改它的历史：新对话才会用到新的开场白。';
        else if (r === 'updated') greetingNote = '这个存档还没聊过：聊天区第 0 楼跟着实时变。';
        if (r !== 'updated') { ui.previewIsSent = false; renderAll(); }
        if (page && page.cardId === cardId) updatePage();
    }, 300);
}

async function onCreate() {
    if (!guard()) return;
    clearTimeout(previewTimer);
    greetingNote = '';
    const ok = await createBlankCard();
    if (!ok || !state.card) return;
    toast(`已新建空白卡「${state.card.name}」：在这里写名字、人设和开场白，聊天区就是预览`, 'ok');
    view.mode = 'write';
    renderArchiveTab(true);
    // 新卡第一件事多半是改名：焦点放进名字框并选中
    setTimeout(() => { const el = page?.els.name; if (el && page.cardId === persist.cardId) { el.focus(); el.select(); } }, 0);
}

// ───────────────────────────── 头像 ─────────────────────────────

/**
 * 选好的图片 → 卡的头像。照酒馆上传头像时的做法（characters.js writeCharacterData：Jimp cover 到 AVATAR_WIDTH × AVATAR_HEIGHT，再存 PNG）：
 * 铺满裁成 512×768、编码成 PNG 的 data URL。这样头像大小有上限（卡记录里不会塞进一张十几 MB 的照片），
 * 导出 PNG 卡时（export-st.js cardToFile）直接就是 PNG，不用再转一次。酒馆还会让用户手动框选裁剪区域，我们只做居中裁剪。
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

async function imageToAvatar(file) {
    const src = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = src;
        await img.decode();
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸是 0');
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_W;
        canvas.height = AVATAR_H;
        const r = coverRect(img.naturalWidth, img.naturalHeight, AVATAR_W, AVATAR_H);
        canvas.getContext('2d').drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, AVATAR_W, AVATAR_H);
        return canvas.toDataURL('image/png');
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
