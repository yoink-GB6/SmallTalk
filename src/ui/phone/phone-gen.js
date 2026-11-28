// 手机聊天的一次生成：拼提示（src/phone-prompt.js）→ 请求模型（llm.js generate）→ 切气泡（src/phone-reply.js）→ 写回会话（phone-store.js appendReply）。
// 界面（C 阶段的 Chat 应用）只调 phoneReply / stopPhoneReply / isPhoneBusy / phonePromptFor。
//
// 并发（用户定的：RP 正在生成时手机照样能发，互不影响）：
//   - 手机自己一个忙碌标记 phoneGen.busy，【不用 ui.busy】（RP 的；记忆、隐藏、前端卡、恢复备份都看它）。同一时间整个手机只有一次生成。
//   - 恢复备份在手机正在回复时拒绝（ui/backup.js importBlocked 问 isPhoneBusy）。
//   - 生成开始时记下会话 id；写回时按 id 走 phone-store.js（事务里读最新的记录、接在末尾），不管现在打开的是哪个会话、RP 那边在干什么。
//   - 中途停止：已经收到的全部留下（同 RP「停止时留下收到的部分」）；一个字没收到 / 出错：什么都不写，用户的气泡留着，可以空发送或重新生成。
// 用户量：generate 带 usageLog: false，手机的请求不顶掉「拼装」页「上次请求」那一行（那是 RP 的）。

import { store } from '../../store.js';
import { cardKey } from '../../migrate.js';
import { generate } from '../../llm.js';
import { effectiveWiSettings } from '../../worldinfo.js';
import { entriesForCard } from '../../books.js';
import { buildPhonePrompt } from '../../phone-prompt.js';
import { splitReply } from '../../phone-reply.js';
import { resolvePreset, resolvePersona, phoneModelRef } from '../../phone-data.js';
import { state, persist } from '../state.js';
import { phoneMem, ensurePhoneLoaded, getSession, sessionLocked, prepareRegenerate, appendReply, phoneWriteBlocked } from './phone-store.js';

/** 手机的忙碌标记（和 RP 的 ui.busy 分开）。sessionId：正在给哪个会话回；abort：停止用 */
export const phoneGen = { busy: false, sessionId: null, abort: null };
export const isPhoneBusy = () => phoneGen.busy;

/** 停止正在进行的手机回复（已经收到的会留下） */
export function stopPhoneReply() { phoneGen.abort?.abort(); }

/**
 * 一个会话这次生成要用的全部东西（BuildPhonePrompt 的参数）+ 用哪个模型。也给以后「看看发了什么」的调试界面用。
 * 卡：是当前 RP 卡就用内存里的（可能有还没保存的改动），否则读存储。世界书：和 RP 通的，按这张卡现在生效的现算（books.js entriesForCard）。
 * @returns {Promise<{args: import('../../types.js').PhonePromptArgs, modelRef: {endpoint: string, model: string}, notes: string[]}>}
 *          notes：给人看的提醒（原来选的人设 / 预设已删除，改用了当前 / 默认）
 */
export async function phonePromptFor(session) {
    await ensurePhoneLoaded();
    const cardId = session.cards[0];
    const card = cardId === persist.cardId && state.card ? state.card : (await store.get(cardKey(cardId)))?.card;
    if (!card) throw new Error('这个会话用到的角色卡已经删了');
    const notes = [];
    const p = resolvePersona(state, session.personaId);
    if (p.missing) notes.push('原来选的人设已删除，这次用的是当前人设');
    const pr = resolvePreset(phoneMem.record, session.presetId);
    if (pr.missing) notes.push('原来选的聊天预设已删除，这次用的是默认聊天预设');
    const args = {
        preset: pr.preset, cards: [card], persona: p.persona, messages: session.messages,
        worldEntries: entriesForCard(card, cardId, state.books),
        stickers: pr.preset.stickers ? (phoneMem.record?.stickers ?? []) : [],
        wi: effectiveWiSettings(state.wi), globalVariables: state.variables.global ?? {},
        seed: `phone:${session.id}`, now: new Date(),
    };
    return { args, modelRef: phoneModelRef(phoneMem.record, state.chatModel), notes };
}

/**
 * 给一个会话生成一批回复。
 * @param {string} sessionId
 * @param {{regenerate?: boolean, markAsRead?: boolean, onProgress?: (p: {bubbles: {content: string, sticker?: string}[], pending: string}) => void}} [opts]
 *   regenerate：先删掉最后一批（PHONE_CHOICES.regenerate）再生成；markAsRead：会话正开着时传 true（新气泡不算未读）；
 *   onProgress：流式中每来一段调一次（splitReply partial 的结果），界面据此画「已经写完的气泡 + 正在输入」
 * @returns {Promise<{ok: boolean, added: number, aborted?: boolean, error?: string, notes: string[]}>}
 *   ok = false 且 added = 0：什么都没写（被拒 / 出错 / 回复是空的），error 是给人看的原因
 */
export async function phoneReply(sessionId, { regenerate = false, markAsRead = false, onProgress } = {}) {
    const blocked = phoneWriteBlocked();
    if (blocked) return { ok: false, added: 0, error: blocked, notes: [] };
    if (phoneGen.busy) return { ok: false, added: 0, error: '手机里正在回复，等这次结束再发', notes: [] };
    phoneGen.busy = true;
    phoneGen.sessionId = sessionId;
    phoneGen.abort = new AbortController();
    let text = '', notes = [], stickers = [], maxBubbles = 5, charName = '';
    try {
        const why = await sessionLocked(sessionId);
        if (why) return { ok: false, added: 0, error: why, notes };
        if (regenerate) await prepareRegenerate(sessionId);
        const session = await getSession(sessionId);
        if (!session) return { ok: false, added: 0, error: '这个会话已经不在了', notes };
        const ctx = await phonePromptFor(session);
        notes = ctx.notes;
        stickers = ctx.args.stickers; maxBubbles = ctx.args.preset.maxBubbles; charName = ctx.args.cards[0].name ?? '';
        const prompt = buildPhonePrompt(ctx.args);
        const opts = { stickers, maxBubbles, charName };
        let error = null, aborted = false;
        try {
            text = await generate(prompt.messages, {
                signal: phoneGen.abort.signal,
                endpoint: ctx.modelRef.endpoint,
                model: ctx.modelRef.model || undefined,
                params: ctx.args.preset.params,
                promptCache: state.promptCache !== false,
                usageLog: false,
                onDelta: soFar => { text = soFar; try { onProgress?.(splitReply(soFar, { ...opts, partial: true })); } catch (e) { console.error(e); } },
            });
        } catch (e) {
            aborted = e?.name === 'AbortError';
            if (!aborted) error = e?.message ?? String(e);
        }
        // 结束（或停止 / 出错）：收到多少存多少。最后一行也算写完了（不带 partial）
        const { bubbles } = splitReply(text, opts);
        if (!bubbles.length) return { ok: false, added: 0, aborted, error: error ?? (aborted ? undefined : '回复是空的'), notes };
        await appendReply(sessionId, bubbles, { markAsRead });
        return { ok: !error, added: bubbles.length, aborted, ...(error ? { error } : {}), notes };
    } catch (e) {
        return { ok: false, added: 0, error: e?.message ?? String(e), notes };
    } finally {
        phoneGen.busy = false;
        phoneGen.sessionId = null;
        phoneGen.abort = null;
    }
}
