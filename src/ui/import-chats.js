// 导入聊天记录（.jsonl，可多个）：每个文件按角色名自动对到一张卡，作为那张卡的新存档。
// 入口：存档页顶上「导入 → 导入聊天记录」的文件选择框（tab-archive.js），和拖文件进页面时的 .jsonl（importer.js importFiles）。
//
// 匹配规则（纯函数）在 src/chat-match.js，里面写了酒馆的聊天文件头为什么只能靠名字。这里管：
//   - 恰好对到一张卡：直接导；
//   - 对到好几张（同名卡）或一张都没对到：弹页内选择框，让用户挑一张卡或跳过这个文件；
//   - 真正写存档仍然走 archive.js 的 importChatFile（先落盘、只读 / 生成中 / 停止保存的拒绝、切换保护都在那里），这里不另写存储。
// 只有一个文件：和以前点行内「导入」一样，导完切到那张卡的新存档。多个文件：逐个导，最后回到原来的位置，只给一条汇总提示。
//
// UI 模块之间有循环依赖：这个文件顶层不调用从兄弟 ui 模块导入的函数。

import { h, toast } from './dom.js';
import { state, ui, persist, STOPPED_TEXT } from './state.js';
import { store } from '../store.js';
import { chatKey } from '../migrate.js';
import { parseChatFile } from '../chatfile.js';
import { matchChatToCards, summarizeChatImport } from '../chat-match.js';
import { listCards, importChatFile, openChat } from './archive.js';
import { importBlockedReason } from './importer.js';   // 循环依赖（importer 导入本文件）：只在函数体里调用

let running = false;   // 一批还没做完（选择框开着也算）：不接第二批

/**
 * 现有的卡（和存档页画的一样：当前卡用内存里的名字 / 头像，没卡状态下发过消息的占位卡也算）。
 * @returns {Promise<{id: string, name: string, avatar: string}[]>}
 */
async function cardsForMatch() {
    const list = await listCards();
    const live = list.map(c => c.id === persist.cardId ? { ...c, name: state.card?.name ?? c.name, avatar: state.avatar ?? c.avatar } : c);
    if (persist.cardId && !live.some(c => c.id === persist.cardId) && state.card) live.unshift({ id: persist.cardId, name: state.card.name, avatar: state.avatar ?? '' });
    return live;
}

/**
 * 弹框：这个文件该进哪张卡。
 * @param {{file: string, name: string, count: number, cards: {id: string, name: string, avatar: string}[], same: boolean, index: number, total: number}} o
 *   same = true：候选是几张同名卡；false：没对上，候选是全部卡
 * @returns {Promise<string|null>} 选中的卡 id；null = 跳过这个文件（Esc / 点遮罩 / 按钮）
 */
function askTargetCard(o) {
    return new Promise(resolve => {
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        const close = r => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(r); };
        const items = o.cards.map(c => h('button', { type: 'button', class: 'ic-pick-item', 'data-fk': `ic-pick:${c.id}`, title: `导进「${c.name}」`, onclick: () => close(c.id) },
            c.avatar ? h('img', { class: 'arch-avatar', src: c.avatar, alt: '' }) : h('span', { class: 'arch-avatar arch-avatar-none' }, (c.name || '?').slice(0, 1)),
            h('b', { class: 'arch-name' }, c.name || '(未命名)')));
        const skip = h('button', { type: 'button', 'data-fk': 'ic-skip', onclick: () => close(null) }, '跳过这个文件');
        const title = o.total > 1 ? `导入聊天记录（${o.index} / ${o.total}）` : '导入聊天记录';
        const who = o.name ? `角色名「${o.name}」` : '里面找不到角色名';
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': 'ic-dialog', onmousedown: e => { if (e.target === overlay) close(null); } },
            h('div', { class: 'bk-panel imp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
                h('div', { class: 'bk-head' }, h('b', null, title)),
                h('div', { class: 'bk-body imp-body' },
                    h('p', { class: 'imp-lead', 'data-fk': 'ic-lead' }, `「${o.file}」：${who}，${o.count} 条消息。`),
                    h('p', { class: 'imp-question' }, o.same ? '有好几张同名的角色卡，导进哪一张？' : '没有找到名字对得上的角色卡，导进哪一张？'),
                    h('div', { class: 'ic-pick-list', 'data-fk': 'ic-list' }, ...items)),
                h('div', { class: 'bk-foot' }, skip)));
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        skip.focus();   // 初始焦点在「跳过」：手滑按回车不会把记录导进错的卡
    });
}

/**
 * 导入一批 .jsonl。会先检查能不能导（只读 / 正在恢复 / 停止保存 / 生成中），不能就只提示原因。
 * @param {File[]} files
 */
export async function importChatFiles(files) {
    files = [...files];
    if (!files.length) return;
    const why = importBlockedReason();
    if (why) return void toast(why, 'error');
    if (ui.busy) return void toast('正在生成回复，等它结束（或点「停止」）再导入', 'error');
    if (running) return void toast('上一批聊天记录还没导完', 'error');
    running = true;
    try {
        const cards = await cardsForMatch();
        if (!cards.length) return void toast('还没有角色卡：请先导入或新建一张角色卡，再导入它的聊天记录', 'error');
        const multi = files.length > 1;
        const orig = { cardId: persist.cardId, chatId: persist.chatId };
        const r = { imported: new Map(), skipped: 0, failed: [] };
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const parsed = parseChatFile(await file.text());
                if (!parsed.messages.length && !Object.keys(parsed.stHeader).length) {
                    const msg = `「${file.name}」里没有读出任何消息，不像酒馆的聊天记录`;
                    if (multi) r.failed.push({ file: file.name, why: '不像酒馆的聊天记录' }); else toast(msg, 'error');
                    continue;
                }
                const m = matchChatToCards(parsed.characterName, cards);
                let cardId = m.ids.length === 1 ? m.ids[0] : null;
                if (!cardId) {
                    const same = m.ids.length > 1;
                    cardId = await askTargetCard({
                        file: file.name, name: m.name, count: parsed.messages.length, same, index: i + 1, total: files.length,
                        cards: same ? cards.filter(c => m.ids.includes(c.id)) : cards,
                    });
                    if (!cardId) { r.skipped++; if (!multi) toast('已跳过', ''); continue; }
                }
                // 弹框期间界面可能变了（开始生成、切到只读…）：每个文件导入前再查一遍，被拒就记失败（importChatFile 自己也会挡并提示）
                const gate = importBlockedReason() || (ui.busy ? '正在生成回复' : null) || (persist.stopped ? STOPPED_TEXT : null);
                if (gate) { r.failed.push({ file: file.name, why: gate }); if (!multi) toast(gate, 'error'); continue; }
                const out = {};
                const ok = await importChatFile(file, cardId, { quiet: multi, out });
                if (ok && out.chatId) {
                    const c = cards.find(x => x.id === cardId);
                    const cur = r.imported.get(cardId) ?? { name: c?.name ?? '?', n: 0 };
                    cur.n++; r.imported.set(cardId, cur);
                } else if (multi) r.failed.push({ file: file.name, why: out.why ? '不像酒馆的聊天记录' : '没能导入（见提示）' });
            } catch (e) {
                console.error(e);
                if (multi) r.failed.push({ file: file.name, why: e.message }); else toast(`导入「${file.name}」失败：${e.message}`, 'error');
            }
        }
        if (!multi) return;
        // 多个文件：每导一个就切到那张卡，全做完回到原来的位置（原来的存档还在才回；回不去就停在最后一个导入的存档上）
        if (r.imported.size && orig.cardId && orig.chatId && (persist.cardId !== orig.cardId || persist.chatId !== orig.chatId)
            && await store.get(chatKey(orig.cardId, orig.chatId))) {
            await openChat(orig.cardId, orig.chatId);
        }
        const s = summarizeChatImport(r);
        toast(s.text, s.ok ? 'ok' : 'error');
    } finally {
        running = false;
    }
}
