// 多卡多存档：启动（写入锁、v1 → v2 迁移）、切换卡 / 存档、新建 / 改名 / 删除、导入导出酒馆 .jsonl，以及它们的界面。
// 存储的分层和 state 的对应关系见 state.js 开头；这里只管「state 现在指向哪条记录」。
//
// 不变式：
//   1. 同一个浏览器里同时只有一个标签页能写（Web Locks）。拿不到锁的标签页只读，锁空出来后自己刷新接手。
//   2. 任何会让 state 换成另一张卡 / 另一个存档的操作，都先 flushNow()——
//      不然最后 400 ms 里打的字要么丢了，要么被写进切换后的那条记录。
//   3. state 一换，旧存档的 DOM 和前端卡 iframe 就在同一个同步块里拆掉（state.js applyCardChat → onSwap），
//      旧楼层上的按钮、旧 iframe 的调用碰不到新存档。

import { store } from '../store.js';
import {
    migrateV1, fingerprint, normalizeCard, cardKey, chatKey, chatPrefix, indexKey, buildIndex, isPristineGlobal,
    V1_BACKUP_KEY, SCHEMA_VERSION,
} from '../migrate.js';
import { unmountMessage } from '../render.js';
import { parseChatFile, serializeChatFile, legacyHiddenFloors } from '../chatfile.js';
import { setHidden } from '../memory-fold.js';
import { $, toast, uid, download } from './dom.js';
import {
    state, ui, card, persist, save, flushNow, applyGlobal, applyCardChat, applyIndex, markMetaSaved, ensureCardRecord,
    newChatRecord, queueDelete, STOPPED_TEXT, globalWriteOp, editChatHighlights, restoreChatHighlights, writeStoredHighlights,
} from './state.js';
import { unbindCardFromBooks } from '../books.js';
import { startChat, scrollChatToEnd } from './chat.js';
import { noteChatOpened, emitTavernEvent, forgetTrust } from './script-host.js';   // 循环依赖：只在函数体里调用（酒馆事件：CHAT_CHANGED / CHAT_CREATED / CHAT_DELETED，见 script-host.js syncEpoch）
import { renderAll, renderTopbar } from './shell.js';
import { invalidateArchiveTab } from './tab-archive.js';
import { askRegexFate, moveAndFlush, undoMove, refreshRegexViews, moveSummary } from './regex-delete.js';
import { enabledScripts } from '../regex-move.js';
import { restoreActive } from './backup.js';   // 循环依赖（backup.js 导入本文件）：只在函数体里调用
import { cardVarsKey } from '../cardvars.js';
import { blankCard, uniqueCardName, isPristineBlank, BLANK_CARD_NAME } from '../card-writer.js';
import { sessionsUsingCard } from './phone/phone-store.js';   // 循环依赖（phone-store.js 经 backup.js 间接导入本文件）：只在函数体里调用

// ───────────────────────────── 读列表 ─────────────────────────────

async function getAll(keys) {
    return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
}

/** 所有卡：[{id, name, avatar, createdAt, usedAt, chatCount}]，最近用过的在前 */
export async function listCards() {
    const [recs, chatKeys] = await Promise.all([getAll(await store.keys('card:')), store.keys('chat:')]);
    return recs.map(r => ({
        id: r.id, name: r.card?.name ?? '?', avatar: r.avatar ?? '', createdAt: r.createdAt, usedAt: r.usedAt ?? r.createdAt,
        chatCount: chatKeys.filter(k => k.startsWith(chatPrefix(r.id))).length,
    })).sort((a, b) => String(b.usedAt).localeCompare(String(a.usedAt)));
}

/**
 * 读某张卡的存档目录。目录丢了（第一版写的数据没有目录）或者和实际的存档键对不上，就从存档重建一次
 * （这时才把每个存档整条读一遍），fresh = true 表示重建出来的还没写回去（下次保存时写）。
 */
async function loadIndex(cardId) {
    const prefix = chatPrefix(cardId);
    const [idx, keys] = await Promise.all([store.get(indexKey(cardId)), store.keys(prefix)]);
    const ids = keys.map(k => k.slice(prefix.length)).sort();
    if (idx?.cardId === cardId && idx.chats && JSON.stringify(Object.keys(idx.chats).sort()) === JSON.stringify(ids)) {
        return { index: idx, fresh: false };
    }
    return { index: buildIndex(cardId, await getAll(keys)), fresh: true };
}

/** 目录里的存档，最近更新的在前：[{id, name, count, updatedAt, createdAt}] */
const indexList = index => Object.entries(index?.chats ?? {}).map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

/** 某张卡的存档列表（读它的目录，不读存档整条记录），最近更新的在前 */
export async function cardChats(cardId) {
    return indexList((await loadIndex(cardId)).index);
}

/** 当前卡的存档列表：用内存里的目录，当前存档的楼数 / 名字 / 时间用 state 里的（它们随时在变，目录要等下次保存才更新） */
export function liveChats() {
    const items = indexList(persist.index).filter(c => c.id !== persist.chatId);
    if (persist.chatId) {
        const hl = persist.chatMeta?.highlights?.length ?? 0;   // 划线条数（同 migrate.js indexEntry：有才写）
        items.push({ id: persist.chatId, name: persist.chatMeta?.name ?? '新对话', count: state.chat.length,
            updatedAt: persist.chatMeta?.updatedAt ?? '', createdAt: persist.chatMeta?.createdAt ?? '', ...(hl ? { hl } : {}) });
    }
    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ───────────────────────────── 写入锁（同时只允许一个标签页写） ─────────────────────────────
// 两个标签页各自拿着一份 state 往同一个库里写，会互相覆盖（删掉的存档被写回来、刚导入的预设被旧的全局层盖掉……）。
// 所以整个页面生命周期里拿着一把排他锁；拿不到的标签页只读。
//
// 锁空出来（另一个标签页关了 / 刷新了）后，只读的标签页【整页刷新】来接手，而不是在原页面里重新读存储：
// 只读期间页面里可能已经有了不会保存的改动、前端卡 iframe、后台记忆压缩、各种快照，原地「转正」很容易把这些
// 当成新改动写进去，盖掉另一个标签页最后写下的数据；刷新则保证走的是和正常启动完全一样的路径（包括迁移）。
// 代价是只读期间输入框里没发出的字会丢——反正横幅一直写着「这里的改动不会保存」。

const LOCK_NAME = 'smalltalk-writer';
const LOCK_RETRY_MS = 2500, LOCK_RETRY_STEP = 250;   // 抢锁失败后的重试窗口（见 acquireWriterLock）

/** @returns {Promise<'held'|'busy'|'none'>} none = 浏览器什么协调手段都没有（降级：照常写，可能互相覆盖） */
function acquireWriterLock() {
    if (globalThis.navigator?.locks?.request) {
        // 抢不到不立刻判只读，先重试一小会儿（LOCK_RETRY_MS 内每 LOCK_RETRY_STEP 一次）：刷新 / 「点这里更新」重载时，
        // 自己上一次加载的文档可能还没来得及放锁，新页面就已经开始跑了；这时直接判只读会让唯一的标签页误以为有「另一个标签页」。
        // 真正的第二个标签页：锁一直被占着，重试到时限后照样变成只读；这段时间里 initArchive 还没往下走，不会读写任何数据。
        const tryOnce = () => new Promise(resolve => {
            navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => {
                if (!lock) { resolve('busy'); return undefined; }
                resolve('held');
                return new Promise(() => {});   // 一直不释放：页面关掉 / 刷新时浏览器自动释放
            }).catch(() => resolve('none'));
        });
        return (async () => {
            const until = Date.now() + LOCK_RETRY_MS;
            for (;;) {
                const r = await tryOnce();
                if (r !== 'busy' || Date.now() >= until) return r;
                await new Promise(res => setTimeout(res, LOCK_RETRY_STEP));
            }
        })();
    }
    // 退路：BroadcastChannel 问一声「有人在写吗」。两个标签页恰好同时打开时可能都以为自己是唯一的（竞态），只能尽力而为
    if (typeof BroadcastChannel === 'function') {
        return new Promise(resolve => {
            const bc = new BroadcastChannel(LOCK_NAME);
            let busy = false;
            bc.onmessage = e => { if (e.data === 'here') busy = true; };
            bc.postMessage('probe');
            setTimeout(() => {
                if (busy) { bc.close(); resolve('busy'); return; }
                bc.onmessage = e => { if (e.data === 'probe') bc.postMessage('here'); };
                addEventListener('pagehide', () => bc.postMessage('bye'));
                resolve('held');
            }, 300);
        });
    }
    return Promise.resolve('none');
}

/** 只读的标签页：等锁空出来就刷新（见上面的说明） */
function waitForWriterLock() {
    if (globalThis.navigator?.locks?.request) {
        navigator.locks.request(LOCK_NAME, () => { location.reload(); return new Promise(() => {}); });
    } else if (typeof BroadcastChannel === 'function') {
        const bc = new BroadcastChannel(LOCK_NAME);
        bc.onmessage = e => { if (e.data === 'bye') setTimeout(() => location.reload(), 200); };
    }
}

// ───────────────────────────── 启动与迁移 ─────────────────────────────

/** 存储出问题时页面顶上的常驻说明（toast 一闪就没了，这种事要一直看得见） */
export function showStoreError(text) {
    const box = $('#store-error');
    box.hidden = false;
    $('#store-error-text').textContent = text;
}

/** 备份键：已经有一份备份就另起一个名字，永远不覆盖旧备份 */
async function backupKey() {
    const existing = await store.keys(V1_BACKUP_KEY);
    return existing.includes(V1_BACKUP_KEY) ? `${V1_BACKUP_KEY}.${Date.now()}` : V1_BACKUP_KEY;
}

/** 卡、存档、目录的写操作 */
function recordWrites(recs) {
    return [
        ...recs.cards.map(c => ({ set: cardKey(c.id), value: c })),
        ...recs.chats.map(c => ({ set: chatKey(c.cardId, c.id), value: c })),
        ...recs.cards.map(c => ({ set: indexKey(c.id), value: buildIndex(c.id, recs.chats.filter(x => x.cardId === c.id)) })),
    ];
}

async function writeAndVerify(writes) {
    await store.batch(writes);
    for (const w of writes) {
        if ('del' in w) continue;
        if (JSON.stringify(await store.get(w.set)) !== JSON.stringify(w.value)) throw new Error(`读回校验不一致：${w.set}`);
    }
}

function backupNotice(key, discarded) {
    const text = `旧数据里有些内容没能放进新的存储（${discarded.join('；')}）。整份旧数据已原样备份在浏览器存储的「${key}」里，不会被自动删除。`;
    console.warn(text);
    toast(text, 'error');
}

/**
 * v1 → v2。顺序（任何一步失败，旧的 'state' 都原封不动）：
 *   1. 一个事务里写入 global / 所有卡 / 所有存档 / 目录（顺手清掉上次失败的迁移留下的同类键）；
 *      有认不出的内容时，整份旧数据也在这个事务里写进备份键
 *   2. 逐条读回，和要写的内容逐字比较
 *   3. 写 meta——meta 是「迁移完成」的标记，没有 meta 的 v2 键一律视为没完成的半成品
 *   4. 删除 'state'
 * 调用前必须已经拿到写入锁（两个标签页不会同时迁移）。
 * 返回写好的 meta；失败返回 null，同时让页面以只读方式显示旧数据。
 */
async function migrateFromV1(old) {
    let recs = null;
    try {
        recs = migrateV1(old, { now: new Date(), newId: uid });
        const meta = { ...recs.meta, v1Fingerprint: fingerprint(old) };
        const writes = [{ set: 'global', value: recs.global }, ...recordWrites(recs)];
        const bak = recs.discarded.length ? await backupKey() : null;
        if (bak) writes.push({ set: bak, value: old });
        // 没有 meta 时存在的卡 / 存档 / 目录键只可能是上次迁移失败的半成品（正常使用时 meta 和它们在同一个事务里写），清掉免得出现重复的卡
        const stale = [...await store.keys('card:'), ...await store.keys('chat:'), ...await store.keys('index:')].filter(k => !writes.some(w => w.set === k));
        await writeAndVerify([...stale.map(k => ({ del: k })), ...writes]);
        await store.set('meta', meta);
        if (JSON.stringify(await store.get('meta')) !== JSON.stringify(meta)) throw new Error('读回校验不一致：meta');
        await store.del('state');
        console.info(`已迁移到存储版本 ${SCHEMA_VERSION}：${recs.cards.length} 张卡，${recs.chats.length} 个存档`);
        if (bak) backupNotice(bak, recs.discarded);
        return { meta };
    } catch (e) {
        console.error('迁移失败', e);
        persist.readOnly = true;
        showStoreError(`升级存储格式失败：${e?.message ?? e}。旧数据原样留在浏览器里没有动；`
            + '这次打开期间可以照常看和聊，但所有改动都【不会保存】。刷新页面会再试一次迁移。');
        showV1ReadOnly(old, recs);
        return null;
    }
}

/** 只读地把 v1 旧数据显示出来（不写任何东西） */
function showV1ReadOnly(old, recs = null) {
    try {
        recs ??= migrateV1(old, { now: new Date(), newId: uid });
        applyGlobal(recs.global);
        applyCardChat(recs.cards[0] ?? null, recs.chats[0] ?? null);
    } catch (e) { console.error(e); }
}

/**
 * 'meta' 和旧的 'state' 同时存在。两种来历：
 *   a. 上次迁移已经写完并校验通过，只是没来得及删 'state'（指纹和 meta 里记的一样）→ 直接删掉
 *   b. 迁移之后，还开着的旧版页面（它不认识写入锁）又往 'state' 里写了东西（指纹不一样）→ 不能丢：
 *      把它当成额外的卡和存档导入（新 id，不覆盖任何已有记录）。全局设置：新存储里的还是出厂默认（没人动过）
 *      就用旧数据的；否则以新存储为准，旧数据整份留一份备份。然后删掉 'state'。
 */
async function resolveLeftover(meta, old) {
    if (meta.v1Fingerprint && meta.v1Fingerprint === fingerprint(old)) {
        await store.del('state');
        return;
    }
    const recs = migrateV1(old, { now: new Date(), newId: uid });
    for (const c of recs.chats) c.name += '（旧版本写入）';
    const writes = recordWrites(recs);
    const adoptGlobal = isPristineGlobal(await store.get('global'));
    if (adoptGlobal) writes.push({ set: 'global', value: recs.global });
    const why = [...recs.discarded];
    if (!adoptGlobal && !isPristineGlobal(recs.global)) why.push('全局设置（预设、人设等）和新存储里的不一样，以新存储为准');
    const bak = why.length ? await backupKey() : null;
    if (bak) writes.push({ set: bak, value: old });
    if (writes.length) await writeAndVerify(writes);
    await store.del('state');
    if (recs.cards.length) toast(`发现旧版本页面写入的数据，已作为「${recs.cards[0].card.name}」的一个新存档保留${adoptGlobal ? '（连同它的预设和设置）' : ''}`, 'ok');
    if (bak) backupNotice(bak, why);
}

/** 启动：先拿写入锁，再读 meta（必要时迁移），把上次停留的卡和存档装进 state */
export async function initArchive() {
    const lock = await acquireWriterLock();
    if (lock === 'busy') {
        persist.readOnly = true;
        showStoreError('另一个 SmallTalk 标签页正开着，这个标签页只能看：这里的任何改动都不会保存。'
            + '关掉另一个标签页（或者在那边刷新）后，这里会自动刷新并接手。');
        waitForWriterLock();
    } else if (lock === 'none') {
        console.warn('浏览器不支持 Web Locks / BroadcastChannel：同时开多个标签页时可能互相覆盖数据');
    }

    let meta, old;
    try {
        [meta, old] = await Promise.all([store.get('meta'), store.get('state')]);
    } catch (e) {
        console.error(e);
        persist.readOnly = true;
        showStoreError(`打不开浏览器存储（IndexedDB）：${e?.message ?? e}。这次的改动不会保存。`);
        return;
    }
    if (persist.readOnly) {
        // 只读的标签页不迁移、不清理，只看
        if (!meta && old) { showV1ReadOnly(old); return; }
    } else if (!meta && old) {
        const done = await migrateFromV1(old);
        if (!done) return;
        meta = done.meta;
    } else if (meta && old) {
        try { await resolveLeftover(meta, old); } catch (e) {
            console.error(e);
            toast(`处理旧数据失败：${e.message}（旧数据仍保留着）`, 'error');
        }
    }
    if (!meta) return;   // 全新的浏览器：什么都没有，第一次保存时再写
    if (meta.version !== SCHEMA_VERSION) {
        persist.readOnly = true;
        showStoreError(`存储版本是 ${meta.version}，这个版本的 SmallTalk 只认识 ${SCHEMA_VERSION}。为了不弄坏数据，这次不会保存任何改动。`);
        return;
    }
    markMetaSaved(meta);
    applyGlobal(await store.get('global'));

    let cardRec = meta.activeCardId ? await store.get(cardKey(meta.activeCardId)) : null;
    if (!cardRec) {
        // meta 指向的卡不在了（或从来没有），退到最近用过的那张
        const cards = await listCards();
        cardRec = cards[0] ? await store.get(cardKey(cards[0].id)) : null;
    }
    if (cardRec) await activateCard(cardRec, { quiet: true });
}

// ───────────────────────────── 切换 ─────────────────────────────

let working = false;

/**
 * 能不能切换：生成中、只读、停止保存之后、上一个操作没做完时都不行。
 * 所有存档 / 卡的操作（切换、新建、删除、导入卡和 .jsonl、从备份恢复）都经过 op → 这里，是统一的拦截点。
 * 停止保存之后（persist.stopped）flushNow 什么都不写：只走 flushNow 的操作会「什么都没写却提示成功」，
 * 直接写存储的（删卡、删别的存档）又会绕过停止，所以一律在这里拒绝。
 */
function canSwitch() {
    if (persist.stopped) { toast(STOPPED_TEXT, 'error'); return false; }
    if (ui.busy) { toast('正在生成回复，等它结束（或点「停止」）再切换', 'error'); return false; }
    if (persist.readOnly) { toast('存储处于只读状态（见页面顶上的说明），不能切换或新建', 'error'); return false; }
    if (working) { toast('上一个操作还没做完', 'error'); return false; }
    return true;
}

/** 包一层：检查、加锁、先落盘；落盘失败就放弃（宁可不切换也不丢数据） */
async function op(fn) {
    if (!canSwitch()) return false;
    working = true;
    ui.switching = true;   // 切换期间：发送、重新生成、删楼、编辑、手动回复、前端卡调用一律不生效（见 chat.js / frame-host.js）
    try {
        if (!await flushNow()) { toast('当前内容没能保存，已取消这次操作', 'error'); return false; }
        await fn();
        return true;
    } catch (e) {
        console.error(e);
        toast(`操作失败：${e.message}`, 'error');
        return false;
    } finally {
        working = false;
        ui.switching = false;
    }
}

/**
 * 给别的模块（ui/backup.js 的「从备份导入」）用的同一把锁：和切换 / 新建 / 删除走同一个 op，
 * 所以生成中、只读、上一个操作没做完时一样被拒绝，期间也不会有别的存档操作插进来。只是把 op 导出，行为不变。
 */
export const runArchiveOp = fn => op(fn);

/**
 * state 刚换成另一个存档（state.js applyCardChat 同步调用）：立刻拆掉旧存档的界面。
 * 先对每条消息 unmountMessage——它会真正释放前端卡 iframe 的 message 监听（只把 DOM 摘掉的话，
 * 要等下一次 mountMessage 时 pruneDisconnected 才清理，中间旧 iframe 发来的调用还会被处理）。
 */
function teardownChatUi() {
    const box = $('#chat');
    if (!box) return;
    for (const el of box.querySelectorAll('.mes_text')) unmountMessage(el);
    box.replaceChildren();
    ui.rendered.clear();
    ui.preview = null;
    ui.previewIsSent = false;
    ui.openMsgs.clear();
    // 前端卡日志记的是旧存档里那些 iframe 的调用：清掉。脚本的日志留着（同一张卡换存档时脚本不重建；换卡时「脚本」页只显示当前卡的脚本）
    for (let i = ui.frameLog.length - 1; i >= 0; i--) if (ui.frameLog[i].scriptId === undefined) ui.frameLog.splice(i, 1);
    $('#gen-error').hidden = true;
    $('#manual-panel').hidden = true;
    $('#manual-reply').value = '';
}
persist.onSwap = () => { teardownChatUi(); adoptLegacyHidden(); };

/**
 * 老存档里酒馆的隐藏标记：打开（切换到）一个存档、它的消息刚装进 state.chat 时，把「st.is_system 为真、却没有 hidden」的楼
 * 认成隐藏（chatfile.js legacyHiddenFloors；为什么只可能是老存档见 chatfile.js 文件头）。用户定的：不问，直接认，提示一句。
 * 做在 onSwap 里：所有「state 换成另一个存档」的路（启动、切卡、切存档、删存档后落到下一个……）都经过 applyCardChat → onSwap，
 * 一处就全管到；这时 state.js 已经记下了这个存档读进来时的快照，所以这里改完 save() 会照常把它写回去。
 * 只在有写权限时做：只读标签页、已停止保存、保存暂停中、正在恢复备份时不做——只读标签页里这些楼照旧显示为未隐藏，
 *   等它接管成为写标签页（会自动刷新、重新载入）时再做；恢复备份期间的切换不做，下次打开这个存档时再做。
 * 走现成的 memory-fold.js setHidden：只改标记，不碰记忆（已有的摘要照旧留着、照旧发；不触发补压，见 memory-fold.js 文件头「隐藏楼层」）。
 * 只触发一次：做完这些楼有了 hidden，legacyHiddenFloors 不再选中它们（天然幂等）；没有这类楼的存档什么都不改、不多写一次。
 * 旁白（extra.type 'narrator'，is_system false）不受影响。
 */
function adoptLegacyHidden() {
    if (persist.readOnly || persist.stopped || persist.paused || restoreActive()) return;
    const floors = legacyHiddenFloors(state.chat);
    if (!floors.length) return;
    const { changed } = setHidden(state.chat, floors, true);
    if (!changed.length) return;
    save();
    toast(`这个存档有 ${changed.length} 楼在酒馆里是隐藏的，现在已按隐藏处理（不会发给模型）。可以在聊天区顶上点「全部取消隐藏」。`, 'ok');
}

/** 切换完成后整页重画 */
function redraw() {
    renderAll();
    scrollChatToEnd();
}

/** 新开的存档：记下它是用哪个开场白建的（判断「没动过」用，见 untouched） */
function markGreeting(index) {
    if (!persist.chatMeta) return;
    persist.chatMeta.greeting = { index, text: state.chat[0]?.content ?? '', vars: JSON.stringify(state.variables.local ?? {}) };
}

/** 让 state 指向这张卡（以及它上次停留的存档；没有存档就新开一个）。调用前必须已经 flush 过。 */
async function activateCard(cardRec, { chatId, quiet = false } = {}) {
    cardRec = { ...cardRec, card: normalizeCard(cardRec.card) };
    const { index, fresh } = await loadIndex(cardRec.id);
    const list = indexList(index);
    const want = chatId ?? cardRec.activeChatId;
    const pick = index.chats[want] ? want : list[0]?.id;
    const chat = pick ? await store.get(chatKey(cardRec.id, pick)) : null;
    $('#greeting-select').replaceChildren();   // 换了卡，开场白选择回到第一个
    if (chat) {
        applyCardChat(cardRec, chat);
        applyIndex(index, { fresh });
    } else {
        applyCardChat(cardRec, newChatRecord(cardRec.id, cardRec.card.name), { freshChat: true });
        applyIndex(index, { fresh });
        startChat(0);
        markGreeting(0);
    }
    persist.cardMeta.activeChatId = persist.chatId;
    if (!quiet) persist.cardMeta.usedAt = new Date().toISOString();
    await flushNow();
    redraw();
}

export const switchCard = cardId => op(async () => {
    if (cardId === persist.cardId) return;
    const rec = await store.get(cardKey(cardId));
    if (!rec) throw new Error('这张卡已经不在了');
    await activateCard(rec);
});

/** 同一张卡里的另一个存档（卡记录就用内存里的） */
const currentCardRec = () => ({ ...persist.cardMeta, id: persist.cardId, card: state.card, avatar: state.avatar });

export const switchChat = chatId => op(async () => {
    if (chatId === persist.chatId) return;
    const rec = await store.get(chatKey(persist.cardId, chatId));
    if (!rec) throw new Error('这个存档已经不在了');
    applyCardChat(currentCardRec(), rec);
    persist.cardMeta.activeChatId = rec.id;
    await flushNow();
    redraw();
});

/**
 * 切到某张卡的某个存档（卡不是当前卡就连卡一起切）。同一张卡里就是 switchChat；
 * 换卡时和 switchCard 走同一个 op / activateCard，只是指定了落在哪个存档上（而不是那张卡上次停留的）。
 */
export const openChat = (cardId, chatId) => {
    if (cardId === persist.cardId) return switchChat(chatId);
    return op(async () => {
        const rec = await store.get(cardKey(cardId));
        if (!rec) throw new Error('这张卡已经不在了');
        await activateCard(rec, { chatId });
    });
};

// ───────────────────────────── 存档操作 ─────────────────────────────

/**
 * 当前存档「没动过」：可以原地换开场白，不用新开。条件全部满足才算：
 *   是用开场白新建的（导入的存档不算）、只有那一楼且和建的时候一字不差、局部变量和建的时候一样、没有记忆摘要。
 * 没卡状态下还没保存过的空聊天也算。其余情况一律新开存档，旧的留着。
 */
function untouched() {
    if (!persist.chatMeta) return state.chat.length === 0 && !Object.keys(state.variables.local ?? {}).length;
    const g = persist.chatMeta.greeting;
    if (!g || state.chat.length > 1) return false;
    const m = state.chat[0];
    if ((m?.content ?? '') !== g.text || (!m && g.text !== '')) return false;
    if (m && (m.memory !== undefined || m.memoryError !== undefined || m.memoryMerged !== undefined || m.memoryIn !== undefined || m.role !== 'assistant')) return false;
    // 在开场白上划过线：算动过（划线是用户攒的内容，原地换开场白会把它们一起清掉），新开一个存档、旧的留着
    if (persist.chatMeta.highlights?.length) return false;
    return JSON.stringify(state.variables.local ?? {}) === g.vars;
}

/**
 * 「新对话」和换开场白：当前存档没动过就原地换开场白，否则给当前卡新开一个存档并切过去，旧存档留着。
 * 给另一张卡新开（cardId）：同一个 op 里先切到那张卡（activateCard，和切换卡一样），再照上面的规则办——
 * 新对话的结果本来就是「切过去」，所以不另写一套。
 */
export const newChat = (greetingIndex = 0, cardId = persist.cardId) => op(async () => {
    if (cardId && cardId !== persist.cardId) {
        const rec = await store.get(cardKey(cardId));
        if (!rec) throw new Error('这张卡已经不在了');
        await activateCard(rec);
    }
    // 酒馆里新对话就是一个新聊天文件：CHAT_CHANGED、CHAT_CREATED、（只有开场白时）first_message。「原地换开场白」时存档 id 不变，也照这样发
    noteChatOpened({ created: true });
    if (untouched()) {
        $('#chat').replaceChildren();
        startChat(greetingIndex);
        markGreeting(greetingIndex);
        await flushNow();
        return;
    }
    ensureCardRecord();
    const rec = newChatRecord(persist.cardId, card().name);
    applyCardChat(currentCardRec(), rec, { freshChat: true });
    startChat(greetingIndex);
    markGreeting(greetingIndex);
    persist.cardMeta.activeChatId = rec.id;
    await flushNow();
    redraw();
});

/**
 * 改名。默认改当前存档（改内存里的 chatMeta，走正常保存）；指定了别的存档就直接改存储里那条记录和目录
 * （一个事务里读-改-写，不动 state，也不改它的 updatedAt）。
 */
export async function renameChat(cardId = persist.cardId, chatId = persist.chatId) {
    if (persist.readOnly) return toast('存储处于只读状态，不能改名', 'error');
    if (persist.stopped) return toast(STOPPED_TEXT, 'error');   // 改别的存档是直接写存储的，不经过 op
    if (!chatId) return toast('这段聊天还没保存过（发一条消息后就会保存）', 'error');
    if (cardId === persist.cardId && chatId === persist.chatId) {
        const name = prompt('存档名字', persist.chatMeta.name)?.trim();
        if (!name) return;
        persist.chatMeta.name = name;
        save();
        return;
    }
    const entry = (cardId === persist.cardId && persist.index?.cardId === cardId ? persist.index : (await loadIndex(cardId)).index).chats[chatId];
    if (!entry) return toast('这个存档已经不在了', 'error');
    const name = prompt('存档名字', entry.name)?.trim();
    if (!name || name === entry.name) return;
    const ck = chatKey(cardId, chatId), ik = indexKey(cardId);
    const wrote = await store.transact([ck, ik], ([rec, idx]) => {
        if (!rec) return [];   // 提示框开着的时候被删了：什么都不写，不复活
        rec.name = name;
        const ops = [{ set: ck, value: rec }];
        if (idx?.chats?.[chatId]) { idx.chats[chatId].name = name; ops.push({ set: ik, value: idx }); }
        return ops;
    });
    if (!wrote) return toast('这个存档已经不在了', 'error');
    // 这张卡正是当前卡：内存里还有一份目录，也要改，不然下次保存会用旧名字把存储里的目录盖回去
    if (cardId === persist.cardId && persist.index?.chats?.[chatId]) { persist.index.chats[chatId].name = name; save(); }
}

/**
 * 现在能不能改这些划线（摘抄页的删除 / 改备注 / 批量删除用，界面也拿它决定禁不禁用）：能 = null，不能 = 给人看的原因。
 * edits 不给 = 问「一般能不能改」（不看生成中）；给了 = 问这一批能不能改。
 * 规矩（2026-11-28 用户定）：
 *   - 只读标签页、停止保存之后、正在恢复备份、正在切换 / 上一个存档操作没做完：一律不能。
 *   - 正在生成：只涉及【别的存档】的能改（生成写的是当前存档，和它们无关；为什么不会互相盖见 state.js writeStoredHighlights、types.js「划线」）；
 *     里面有【当前存档】的划线就整批拒绝（当前存档的划线生成中本来就不能改，同 chat.js chatWriteBlocked），不悄悄只做一半。
 */
export function highlightEditBlocked(edits) {
    if (persist.readOnly) return '这个标签页是只读的（见页面顶上的说明），不能改划线';
    if (persist.stopped) return STOPPED_TEXT;
    if (restoreActive()) return '正在恢复，请稍等';
    if (ui.switching || working) return '上一个操作还没做完';
    if (edits && ui.busy && edits.some(isCurrentChat)) {
        return edits.length > 1 ? '里面有当前存档的划线，等这次回复生成完再删' : '正在生成回复，等这次结束再改当前存档的划线';
    }
    return null;
}

const isCurrentChat = e => e.cardId === persist.cardId && e.chatId === persist.chatId;

/**
 * 改划线，可以一次跨多个存档、多张卡（摘抄页的删除、改备注、批量删除都走这里；types.js「划线」写着契约）。
 * edits：[{cardId, chatId, remove?: 划线 id[], notes?: {划线 id: 新备注}}]，一个存档一项。
 * - 只涉及别的存档：直接交给 state.js writeStoredHighlights（一个事务里现读、只换 highlights、重算目录 hl；排在写入链后面），
 *   不走存档层的 op，所以生成中也能做。
 * - 里面有当前存档（生成中被 highlightEditBlocked 整批拒绝）：在 op 里做（落盘、加锁）。当前存档走内存（state.js editChatHighlights → 落盘），
 *   和聊天里点高亮删除是同一条路，不另外直接写它的存储记录（免得两边各写一遍互相盖）；别的存档同上一个事务。
 *   全成或全不成：当前存档落盘失败 → 换回原来的列表、什么都不写；别的存档的事务失败（IndexedDB 整体回滚）→ 当前存档也换回去并落盘。
 *   只有「事务失败之后换回当前存档时又落盘失败」这种双重失败会留下当前存档已改、别的没改。
 * 成功返回 {removed, noted, gone}（gone：已经不在、跳过了的存档数）；被拒 / 失败返回 null（已经提示过）。
 */
export async function editHighlightsAcross(edits) {
    const why = highlightEditBlocked(edits);
    if (why) { toast(why, 'error'); return null; }
    const curEdit = edits.find(isCurrentChat);
    const others = edits.filter(e => !isCurrentChat(e));
    const failText = e => `改划线没能写进存储（${e?.message ?? e}），什么都没有改`;
    if (!curEdit) {
        try { return await writeStoredHighlights(others); } catch (e) {
            console.error('改划线失败', e?.message ?? e);
            toast(failText(e), 'error');
            return null;
        }
    }
    let result = null;
    await op(async () => {
        // op 里不会换存档，但进 op 之前那一下可能换过：按现在的当前存档重新分
        const cur = edits.find(isCurrentChat);
        const rest = edits.filter(e => !isCurrentChat(e));
        let removed = 0, noted = 0, gone = 0;
        let curDone = null;
        if (cur) {
            curDone = editChatHighlights(cur);
            if (curDone.changed && !await flushNow()) {
                restoreChatHighlights(curDone.before);
                throw new Error('当前存档的改动没能保存，什么都没有改');
            }
            removed += curDone.removed; noted += curDone.noted;
        }
        if (rest.length) {
            let r;
            try { r = await writeStoredHighlights(rest); } catch (e) {
                // 事务整个没写进去：当前存档那部分也换回去
                if (curDone?.changed) { restoreChatHighlights(curDone.before); await flushNow(); }
                throw new Error(failText(e));
            }
            removed += r.removed; noted += r.noted; gone += r.gone;
        }
        result = { removed, noted, gone };
    });
    return result;
}

/**
 * 删除存档。默认删当前存档（先让 state 离开它，再删）；指定了别的存档就只删它：
 * state 不动，当前存档不受影响，只是存储里少一条记录和目录里少一项。
 */
export const deleteChat = (cardId = persist.cardId, chatId = persist.chatId) => op(async () => {
    if (cardId === persist.cardId && chatId === persist.chatId) return deleteCurrentChat();
    const sameCard = cardId === persist.cardId && persist.index?.cardId === cardId;
    const index = sameCard ? persist.index : (await loadIndex(cardId)).index;
    const entry = index.chats[chatId];
    if (!entry) { toast('这个存档已经不在了', 'error'); return; }
    if (!confirm(`删除存档「${entry.name}」（${entry.count} 楼）？删掉就找不回来了。`)) return;
    const key = chatKey(cardId, chatId);
    if (sameCard) {
        // 当前卡：内存里的目录是写入的依据，改它再和删存档放进同一次保存
        delete persist.index.chats[chatId];
        queueDelete(key);
        if (!await flushNow()) throw new Error('删除没能保存');
    } else {
        delete index.chats[chatId];
        const next = indexList(index)[0]?.id ?? null;
        await store.transact([cardKey(cardId)], ([rec]) => {
            const ops = [{ del: key }, { set: indexKey(cardId), value: index }];
            // 那张卡上次停留的正是被删的存档：改成它最近的另一个（没有就清空，切到它时会新开）
            if (rec?.activeChatId === chatId) ops.push({ set: cardKey(cardId), value: { ...rec, activeChatId: next } });
            return ops;
        });
    }
    toast(`已删除存档「${entry.name}」`, 'ok');
    if (cardId === persist.cardId) emitTavernEvent('chat_deleted', chatId);   // 酒馆删别的聊天文件也发 CHAT_DELETED(名字)；别的卡的存档脚本看不到，不发
});

async function deleteCurrentChat() {
    if (!persist.chatId) { toast('这段聊天还没保存过，不用删', 'error'); return; }
    const n = state.chat.length;
    if (!confirm(`删除存档「${persist.chatMeta.name}」（${n} 楼）？删掉就找不回来了。`)) return;
    const oldId = persist.chatId;
    const rest = indexList(persist.index).filter(c => c.id !== oldId);
    const next = rest[0] ? await store.get(chatKey(persist.cardId, rest[0].id)) : null;
    // 先让 state 离开要删的存档（之后任何保存都不会再写回它），再把「删存档 + 改目录」放进同一次保存
    if (next) applyCardChat(currentCardRec(), next);
    else { applyCardChat(currentCardRec(), newChatRecord(persist.cardId, card().name, new Date(), oldId), { freshChat: true }); startChat(Number($('#greeting-select').value) || 0); markGreeting(Number($('#greeting-select').value) || 0); }
    persist.cardMeta.activeChatId = persist.chatId;
    if (persist.index) delete persist.index.chats[oldId];
    queueDelete(chatKey(persist.cardId, oldId));
    if (!await flushNow()) throw new Error('删除没能保存');
    noteChatOpened({ deleted: oldId, created: !next });   // 酒馆：CHAT_DELETED(被删的)，再按打开了另一个存档发 CHAT_CHANGED …
    redraw();
    toast(next ? `已删除，切到「${persist.chatMeta.name}」` : '已删除；这张卡没有别的存档了，开了一个新的', 'ok');
}

// ───────────────────────────── 角色卡操作 ─────────────────────────────

/**
 * 导入一张角色卡：加一张新卡并切过去（新存档带开场白），不动任何已有的卡和存档。
 * 同名卡已存在时问一下：确定 = 更新那张卡的定义、保留它的存档；取消 = 作为另一张卡导入。
 */
export const addCard = (parsed, avatar) => op(async () => {
    const same = (await listCards()).find(c => c.name === parsed.name);
    if (same && confirm(`已经有一张叫「${parsed.name}」的卡（${same.chatCount} 个存档）。\n\n`
        + `确定：用这次导入的内容更新那张卡，它的存档都保留\n取消：作为另一张同名卡导入`)) {
        const rec = await store.get(cardKey(same.id));
        // 卡自带世界书的整本开关（Card.worldDisabled）是用户在这里设的，不是卡文件的内容：更新卡的定义时保留它
        //（和拖入同名世界书文件时保留它的开关是一个道理，见 books.js replaceBookEntries）
        if (rec.card?.worldDisabled === true) parsed.worldDisabled = true;
        rec.card = parsed;   // 酒馆助手脚本（Card.scripts）以新卡文件为准：parsed 里没有这个键，旧卡在「脚本」页的改动随之丢掉（和卡自带正则一样）
        if (avatar) rec.avatar = avatar;   // JSON 卡没有头像：保留原来的
        if (same.id === persist.cardId) {
            state.card = rec.card; state.avatar = rec.avatar;
            persist.cardMeta.usedAt = new Date().toISOString();
            await flushNow();
            ui.rendered.clear();
            renderAll();
        } else {
            await store.set(cardKey(same.id), rec);
            await activateCard(rec);
        }
        toast(`已更新角色卡「${parsed.name}」，原有存档保留`, 'ok');
        return;
    }
    const now = new Date().toISOString();
    const cardRec = { id: uid(), card: parsed, avatar: avatar ?? '', createdAt: now, usedAt: now, activeChatId: null };
    const chat = newChatRecord(cardRec.id, parsed.name);
    cardRec.activeChatId = chat.id;
    $('#greeting-select').replaceChildren();
    applyCardChat(cardRec, chat, { freshCard: true, freshChat: true });
    startChat(0);
    markGreeting(0);
    await flushNow();
    redraw();
});

/**
 * 「存档」页顶上的「写卡」：先找一张「还完全没动过的空白卡」（card-writer.js isPristineBlank）直接打开（不是当前卡就切过去），
 * 没有才新建——不然每点一次就多一张空卡。
 * 新建：造一张空白的酒馆 V2 卡（card-writer.js blankCard），交给上面的 addCard——和导入一张卡走同一条路
 * （新卡记录 + 第一个存档 + 切过去），存储、目录、切卡、导出都不另写一套。
 * 名字避开已有的卡（「新角色」「新角色 2」…），所以 addCard 不会弹「已经有同名卡、要不要更新」。
 * 开场白是空的：startChat 什么都不推，第一个存档是 0 楼（markGreeting 记下空开场白，untouched 照样认它「没动过」）。
 * 判断要读每张卡的记录和存档目录（当前卡用内存里的）；只读不写。
 * @returns {Promise<'reused'|'created'|false>} false = 没成（只读 / 生成中 / 停止保存 / 上一个操作没做完时 op 会拒绝并提示）
 */
export async function openBlankCard() {
    if (!canSwitch()) return false;
    const cards = await listCards();
    for (const c of cards) {
        const cur = c.id === persist.cardId;
        const rec = cur ? currentCardRec() : await store.get(cardKey(c.id));
        if (!rec) continue;
        const counts = (cur ? liveChats() : await cardChats(c.id)).map(x => x.count ?? 0);
        if (!isPristineBlank(rec.card, rec.avatar ?? '', counts)) continue;
        if (!cur && !await switchCard(c.id)) return false;
        return persist.cardId === c.id ? 'reused' : false;
    }
    const name = uniqueCardName(BLANK_CARD_NAME, cards.map(c => c.name));
    return (await addCard(blankCard(name), '')) ? 'created' : false;
}

/** 当前存档「没动过」吗（untouched 给写卡页用：决定开场白下面那行提示怎么说） */
export const chatUntouched = () => !!persist.chatMeta && untouched();

/**
 * 「写卡」页改了开场白 / 名字之后：当前存档还「没动过」（untouched，只有用开场白建的那一楼）就原地用第 index 个开场白
 * （过滤掉空开场白之后的下标，和 startChat / 开场白下拉框同一种数法）重建那一楼，聊天区就是实时预览；否则不碰历史。
 * 存档是用哪个开场白开的、改动之后它变成第几个，由写卡页跟踪（card-writer.js trackedSlot），这里只管照做。
 * 做法同 newChat 里「原地换开场白」那一支（startChat + markGreeting），只是：
 *   - 不发酒馆事件（打字时每停一下就重建一次，发 CHAT_CREATED 会把脚本闹翻；楼层内容的变化由 renderAll 里的 reconcileScripts 推副本）；
 *   - 不经过 op（op 每次都先整个落盘，打字时太重）：拦截条件照 canSwitch / chatWriteBlocked 一样判断，楼层的落盘走 startChat 里的防抖 save()。
 * 「没动过」的判断本身已经保证没有外置记忆摘要、局部变量和建的时候一样（见 untouched），所以重建不会丢东西。
 * @param {number} index
 * @returns {'updated'|'kept'|'blocked'} kept = 这个存档已经聊过，新对话才会用到新的开场白
 */
export function refreshGreetingInPlace(index) {
    if (working || ui.switching || ui.busy || persist.readOnly || persist.stopped || restoreActive() || !persist.cardId) return 'blocked';
    if (!persist.chatMeta || !untouched()) return 'kept';
    // 旧的第 0 楼可能带着前端卡 iframe：先 unmountMessage 释放它的监听，再整体清掉（同 teardownChatUi）
    const box = $('#chat');
    for (const el of box.querySelectorAll('.mes_text')) unmountMessage(el);
    box.replaceChildren();
    startChat(index);
    markGreeting(index);
    return 'updated';
}

/**
 * 删除角色卡（连同它的全部存档）。
 * 这张卡自带的正则里有启用的：不走普通确认，弹 regex-delete.js 的三选一框（移动至全局 / 丢弃 / 取消）。
 * 选「移动」：先把正则加进全局并落盘（moveAndFlush），再删；删除那一步失败就把加进去的撤回（undoMove）。
 * 删非当前的卡也一样：它的正则从存储里的卡记录读（非当前的卡不在 state 里）；当前卡在 op 开头已经 flushNow，存储里的就是最新的。
 *
 * 额外世界书里绑定了这张卡的（books[].cards 里有它的 id）：把这个 id 去掉（books.js unbindCardFromBooks），
 * 新的 global 和删卡的那些键放在【同一个事务】里写（state.js globalWriteOp）——要么卡删了、绑定也清了，要么都没发生。
 * 去掉后 cards 变空的书保持「只对指定的卡」，于是不再对任何卡生效；不删书，也不悄悄变成对所有聊天生效。
 * 事务失败：state.books 换回原来的（卡还在，绑定也该还在），再撤回移动的正则。
 */
export const deleteCard = (cardId, { confirmed = false } = {}) => op(async () => {   // confirmed：批量删除已经统一确认过，不再逐张问（启用正则的去向照问）
    const info = (await listCards()).find(c => c.id === cardId);
    if (!info) return;
    const enabled = enabledScripts((await store.get(cardKey(cardId)))?.card?.regexScripts);
    let moved = null;
    // 手机里用到这张卡的会话（用户定的）：不删，留着只能看——确认框里说一句。数不出来（读手机目录失败）就不说，不挡删卡
    let phoneN = 0;
    try { phoneN = await sessionsUsingCard(cardId); } catch (e) { console.warn('数手机会话失败', e?.message ?? e); }
    const what = `删除角色卡「${info.name}」以及它的 ${info.chatCount} 个存档？删掉就找不回来了。`
        + (phoneN ? `\n有 ${phoneN} 个手机会话用到它：会话会留着、能看，但不能再聊。` : '');
    if (enabled.length) {
        const fate = await askRegexFate({ kind: 'card', title: what, scripts: enabled });
        if (!fate) return;
        if (fate === 'move') { moved = await moveAndFlush(enabled); if (!moved) return; refreshRegexViews(); }
    } else if (!confirmed && !confirm(what)) return;
    // 卡的运行时数据（脚本变量、角色卡变量，cardvars.js）和卡在同一个事务里删
    const keys = [cardKey(cardId), indexKey(cardId), cardVarsKey(cardId), ...await store.keys(chatPrefix(cardId))];
    const isCurrent = cardId === persist.cardId;
    if (isCurrent) applyCardChat(null, null);   // 先离开，之后的保存不会再写回这张卡
    const booksBefore = state.books;
    const unbound = unbindCardFromBooks(state.books, cardId);
    if (unbound.changed) state.books = unbound.list;
    const gw = unbound.changed ? globalWriteOp() : null;
    try {
        await store.batch([...keys.map(k => ({ del: k })), ...(gw ? [gw.op] : [])]);
        gw?.done();
        // 「允许直接操作页面」的信任记录（localStorage，不在这个事务里）：卡删掉了就一起删，免得同一个卡 id 从备份里回来时又是开的
        forgetTrust(cardId);
    } catch (e) {
        if (unbound.changed) state.books = booksBefore;
        if (moved) await undoMove(moved);   // 卡还在，说好保留的正则别多出一份
        throw e;
    }
    if (isCurrent) {
        const next = (await listCards())[0];
        const rec = next ? await store.get(cardKey(next.id)) : null;
        if (rec) await activateCard(rec);
        else { await flushNow(); redraw(); }
    }
    // 世界书页、拼装预览跟着变（解绑之后那几本书对谁都不生效了）
    if (unbound.changed) { save(); if (!isCurrent) renderAll(); }
    toast(`已删除「${info.name}」和 ${info.chatCount} 个存档${moveSummary(moved)}${unbound.changed ? `；${unbound.changed} 本世界书解除了和它的绑定` : ''}`, 'ok');
});

// ───────────────────────────── 酒馆 .jsonl ─────────────────────────────

const safeFileName = s => String(s).replace(/[\\/:*?"<>|\r\n]+/g, '-').trim() || 'chat';

/** 导出酒馆的 .jsonl。默认导出当前存档（用 state，包括还没保存的）；指定了别的存档就读存储里那条记录，不动 state */
export async function exportChat(cardId = persist.cardId, chatId = persist.chatId) {
    if (cardId === persist.cardId && chatId === persist.chatId) {
        const rec = { ...(persist.chatMeta ?? { name: `${card().name} - 未保存`, createdAt: new Date().toISOString() }), messages: state.chat, variables: state.variables.local };
        const text = serializeChatFile(rec, { userName: state.persona.name || 'User', characterName: card().name });
        download(`${safeFileName(rec.name)}.jsonl`, text);
        toast(`已导出 ${state.chat.length} 楼`, 'ok');
        return;
    }
    const [rec, cardRec] = await Promise.all([store.get(chatKey(cardId, chatId)), store.get(cardKey(cardId))]);
    if (!rec) return void toast('这个存档已经不在了', 'error');
    download(`${safeFileName(rec.name)}.jsonl`, serializeChatFile(rec, { userName: state.persona.name || 'User', characterName: cardRec?.card?.name ?? '?' }));
    toast(`已导出 ${rec.messages.length} 楼`, 'ok');
}

/**
 * 一个 .jsonl 变成某张卡（默认当前卡）下的一个新存档，并切过去。
 * 导进另一张卡（cardId）：同一个 op 里，文件确认能读之后才先切到那张卡（activateCard，和切换卡一样），再照常导入；
 * 文件读不出来就不切。
 */
export const importChatFile = (file, cardId = persist.cardId) => op(async () => {
    const parsed = parseChatFile(await file.text());
    if (!parsed.messages.length && !Object.keys(parsed.stHeader).length) {
        toast(`「${file.name}」里没有读出任何消息，不像酒馆的聊天记录`, 'error');
        return;
    }
    if (cardId && cardId !== persist.cardId) {
        const target = await store.get(cardKey(cardId));
        if (!target) throw new Error('这张卡已经不在了');
        await activateCard(target);
    }
    ensureCardRecord();
    const c = card();
    const now = new Date().toISOString();
    const rec = {
        id: uid(), cardId: persist.cardId, name: file.name.replace(/\.jsonl$/i, '') || parsed.name || `${c.name} - 导入`,
        createdAt: parsed.createdAt ?? now, updatedAt: now,
        messages: parsed.messages, variables: parsed.variables, stHeader: parsed.stHeader,
        // 作者注释（头的 chat_metadata.note_*）：全是默认值时 parsed.authorNote 为 null，不写这个字段
        ...(parsed.authorNote ? { authorNote: parsed.authorNote } : {}),
    };
    applyCardChat(currentCardRec(), rec, { freshChat: true });
    persist.cardMeta.activeChatId = rec.id;
    await flushNow();
    redraw();

    const bits = [`已导入 ${parsed.messages.length} 楼`];
    if (parsed.warnings.length) bits.push(`${parsed.warnings.length} 处问题已跳过（详见控制台）`);
    // 隐藏楼层现在认了（消息上的 hidden，见 chatfile.js）：导入后仍是隐藏的，照常显示但不发给模型
    if (parsed.hiddenCount) bits.push(`${parsed.hiddenCount} 楼在酒馆里是隐藏的，导入后仍是隐藏的（不会发给模型）`);
    // 「明显是别的角色」：文件里的角色名和回复者名字都对不上当前卡
    const speakers = new Set(parsed.messages.filter(m => m.role === 'assistant').map(m => m.name));
    const other = parsed.characterName && parsed.characterName !== c.name && !speakers.has(c.name);
    if (other) bits.push(`注意：这份记录看起来属于「${parsed.characterName}」，而当前角色卡是「${c.name}」`);
    if (parsed.warnings.length) console.warn(`导入「${file.name}」：`, parsed.warnings);
    toast(bits.join('；'), other || parsed.warnings.length ? 'error' : 'ok');
});

// ───────────────────────────── 界面 ─────────────────────────────

/** 切到检查器的「存档」页 */
export function openArchiveTab() {
    $('#tabs button[data-tab="archive"]').click();
}

export function bindArchive() {
    $('#card-chip').addEventListener('click', openArchiveTab);
    // 存档写完后：「存档」页里的楼数 / 名字跟着刷新（楼数只在写完时更新，生成中的每个 token 不重画整页）
    // 没卡状态下第一次保存时会建出 Assistant 占位卡：顶栏的卡名也跟着更新（只在需要时重画顶栏，免得打断别处的输入）
    persist.onFlushed = () => {
        invalidateArchiveTab();
        if (state.card && $('#card-chip').textContent !== state.card.name) renderTopbar();
    };
    // 关页面前把还在防抖里的改动写下去。pagehide 里发起的 IndexedDB 写入浏览器一般会让它做完，
    // 但不是规范保证（比如进程被直接杀掉）；所以平时的防抖只有 400 ms，最多丢这么一小段。
    addEventListener('pagehide', () => { flushNow(); });
    addEventListener('beforeunload', () => { flushNow(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
}
