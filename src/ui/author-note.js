// 「人设」页最下面（便签下面）的「作者注释」小框（可折叠，默认收起；每个存档一份，标题写明「当前存档」。2026-11-23 从「存档」页挪来）。规则见 src/author-note.js，数据见 types.js ChatRecord.authorNote。
//
// 为什么放在「存档」页：作者注释是「这个存档」的东西（酒馆里写着 Unique to this chat），放在当前存档那一行下面最直观；
// 「拼装」页是看结果的地方，「记忆」页是另一个功能。
//
// 这个框是【常驻的】一组 DOM（只建一次），和开场白下拉框 #greeting-select 一个做法：「存档」页每次重画时由 tab-archive.js 把它挪进
// 当前存档那一行的落脚处（mountNoteBox）。这样展开 / 收起的状态、正在打的字都不会因为重画丢掉。
// 「存档」页在每次落盘后都会重画（楼数要跟着变）；重画会把这个框从页面上摘下来再放回去，焦点和输入法的组字就断了，
// 所以焦点在框里时 tab-archive.js 先不重画，等焦点离开再补（noteBoxHasFocus / onNoteBoxBlur）。
//
// 改动立即生效：正文每个字都写进 persist.chatMeta（state.js setAuthorNote，保存本身有防抖），其它控件改完就写；然后刷新预览。
// 不能改的时候（只读标签页、正在生成、正在恢复备份、已停止保存、正在切换存档）整个框禁用；万一改的那一下条件变了，拒绝并把框恢复成存着的值。

import { h, toast } from './dom.js';
import { state, persist, setAuthorNote } from './state.js';
import { currentAuthorNote, refreshPreview } from './pipeline.js';   // 循环依赖：只在函数体里调用
import { chatWriteBlocked } from './chat.js';                         // 同上
import { noteTurn, NOTE_POSITION, MAX_NOTE_DEPTH, MAX_NOTE_INTERVAL } from '../author-note.js';

const prompt = h('textarea', { id: 'an-prompt', rows: 4, 'data-fk': 'an-prompt', placeholder: '这个存档的作者注释', title: '支持宏，比如 {{char}}、{{user}}' });
const position = h('select', { id: 'an-position', title: '插在哪里' },
    h('option', { value: String(NOTE_POSITION.before) }, '主提示之前'),
    h('option', { value: String(NOTE_POSITION.after) }, '主提示之后'),
    h('option', { value: String(NOTE_POSITION.chat) }, '聊天内'));
const depth = h('input', { id: 'an-depth', type: 'number', min: 0, max: MAX_NOTE_DEPTH - 1, step: 1, title: '聊天内的深度：0 = 最后一楼之后，1 = 倒数第一楼之前……（隐藏的楼不算）' });
const role = h('select', { id: 'an-role', title: '以什么身份发出' },
    h('option', { value: '0' }, 'system'), h('option', { value: '1' }, 'user'), h('option', { value: '2' }, 'assistant'));
const interval = h('input', { id: 'an-interval', type: 'number', min: 0, max: MAX_NOTE_INTERVAL, step: 1, title: '每几句用户输入插一次：1 = 每次，0 = 关' });
const mark = h('span', { class: 'an-mark dim', id: 'an-mark' });
const status = h('span', { class: 'an-status dim', id: 'an-status' });

const box = h('details', { class: 'an-box', id: 'an-box', 'data-fk': 'an-box' },
    h('summary', { class: 'an-head' }, '作者注释（当前存档）', mark),
    h('div', { class: 'an-body' },
        prompt,
        h('div', { class: 'an-fields' },
            h('label', { class: 'inline' }, '位置', position),
            h('label', { class: 'inline an-depth' }, '深度', depth),
            h('label', { class: 'inline' }, '角色', role),
            h('label', { class: 'inline' }, '频率', interval),
            status)));

const controls = [prompt, position, depth, role, interval];
let filledEpoch = null;   // 框里现在显示的是哪个存档（persist.epoch）的值

/** 框里的值 → 显示（标题旁的字数、深度只在「聊天内」时可改、下一次发送插不插） */
function refreshDerived() {
    const n = currentAuthorNote();
    mark.textContent = n.prompt ? `${n.prompt.length} 字` : '';
    depth.disabled = box.classList.contains('an-locked') || n.position !== NOTE_POSITION.chat;
    // 频率不是 1 时才说一句「下一次发送插不插」（按「再发一句」算：用户刚发的那句也计数，同酒馆 setFloatingPrompt）
    if (n.interval === 1) status.textContent = '';
    else if (n.interval <= 0) status.textContent = '已关闭';
    else status.textContent = noteTurn(n, [...state.chat, { role: 'user' }]).insert ? '下一句会插入' : '下一句不插';
}

/** 存着的值 → 控件。正在编辑的那个控件不覆盖（除非换了存档） */
function fill() {
    const n = currentAuthorNote();
    const swapped = filledEpoch !== persist.epoch;
    filledEpoch = persist.epoch;
    const set = (el, v) => { if (swapped || document.activeElement !== el) el.value = String(v); };
    set(prompt, n.prompt);
    set(position, n.position);
    set(depth, n.depth);
    set(role, n.role);
    set(interval, n.interval);
}

function applyDisabled() {
    const blocked = !persist.chatMeta || chatWriteBlocked(persist.epoch, '改作者注释') !== null;
    for (const el of controls) el.disabled = blocked;
    box.classList.toggle('an-locked', blocked);
}

/** 写一处改动。被拦下就提示并把框恢复成存着的值 */
function commit(patch) {
    // 框里填的还是【上一个存档】的内容（存档切走了，但焦点在框里，重画被推迟，见 tab-archive.js draw()）：
    // 这时再打字不能写进新存档——复核实测过，旧存档的注释加上新打的字会盖掉新存档自己的注释。丢掉这次输入，重新填成新存档的值
    if (filledEpoch !== persist.epoch) { filledEpoch = null; fill(); applyDisabled(); refreshDerived(); return; }
    const why = !persist.chatMeta ? '还没有存档' : chatWriteBlocked(persist.epoch, '改作者注释');
    if (why !== null) {
        if (why) toast(why, 'error');
        filledEpoch = null; fill(); applyDisabled(); refreshDerived();
        return;
    }
    if (setAuthorNote(patch)) refreshPreview();
    refreshDerived();
}

const intOf = el => { const n = Number(el.value); return Number.isFinite(n) ? Math.trunc(n) : NaN; };

prompt.addEventListener('input', () => commit({ prompt: prompt.value }));
position.addEventListener('change', () => commit({ position: Number(position.value) }));
role.addEventListener('change', () => commit({ role: Number(role.value) }));
// 数字框：改完（失焦 / 回车）才写；不合法的值写不进去（setAuthorNote 规范化成默认值前先挡掉），框里恢复成存着的值。
// 深度照酒馆：输入负数时取绝对值（authors-note.js onExtensionFloatingDepthInput）
depth.addEventListener('change', () => {
    let n = intOf(depth);
    if (n < 0) n = Math.abs(n);
    if (!(n >= 0 && n < MAX_NOTE_DEPTH)) { depth.value = String(currentAuthorNote().depth); return; }
    depth.value = String(n);
    commit({ depth: n });
});
interval.addEventListener('change', () => {
    let n = intOf(interval);
    if (n < 0) n = Math.abs(n);
    if (!(n >= 0 && n <= MAX_NOTE_INTERVAL)) { interval.value = String(currentAuthorNote().interval); return; }
    interval.value = String(n);
    commit({ interval: n });
});

/** 焦点在框里（包括框头）：tab-archive.js 这时先不重画 */
export const noteBoxHasFocus = () => box.contains(document.activeElement);

/** 焦点离开框之后调 cb 一次（tab-archive.js 用它补上被推迟的重画） */
export function onNoteBoxBlur(cb) {
    box.addEventListener('focusout', e => { if (!box.contains(e.relatedTarget)) setTimeout(cb, 0); });
}

/**
 * 把框挪进「存档」页当前存档那一行的落脚处，并按现在的存档 / 状态刷新内容和禁用状态。
 * slot 为 null（当前卡收起了、还没有存档）时什么都不做（框留在原处的游离状态里，下次再挂上）。
 */
export function mountNoteBox(slot) {
    if (!slot) return;
    if (filledEpoch !== persist.epoch) box.open = false;   // 换了存档：默认收起
    fill();
    applyDisabled();
    refreshDerived();
    slot.append(box);
}
