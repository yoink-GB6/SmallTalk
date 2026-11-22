// 外置记忆的纯逻辑（不碰页面、不碰 state，Node 里可以直接单元测试）：
//   foldCut           决定聊天记录里哪一段折叠成摘要（「攒一批再滑动」）
//   invalidateTurnAt  某一楼的原文变了：这一轮的摘要作废
//   invalidateAfterDelete  删掉了任意几楼（前端卡的 deleteChatMessages）：受影响的轮的摘要作废
// 界面那一侧（压缩、「记忆」页）在 src/ui/memory.js。
//
// 「一轮」的定义（和 ui/memory.js summarizeTurn 取材的范围一致）：一条 assistant 回复，加上紧挨在它前面的那一串连续的 user 输入。
// 摘要挂在回复上（ChatMessage.memory）。所以规则只有一条：一轮里任何一部分的原文变了（或这一轮由哪几楼组成变了），
// 挂在这一轮回复上的摘要就作废，交给 ensureMemories 重压；别的轮不动。

//
// ───── 隐藏楼层（ChatMessage.hidden，酒馆的 is_system）和记忆 ─────
// 原则：摘要反映「会发给模型的内容」。隐藏的楼不发给模型，所以在记忆这边它【等于不存在】：
//   - 一轮的取材（turnInputs）：从回复往前，跳过隐藏的楼，收集紧挨着的可见用户输入，碰到可见的非用户楼（回复 / 旁白）就停。
//     于是 U1 A1(隐藏) U2 A2 里，A2 这一轮 = U1 + U2 + A2（A1 不在了，U1 并进下一轮）。没有隐藏楼时和以前逐字相同。
//   - 隐藏的回复不压缩（ensureMemories 跳过）、已有的摘要（是按「这一轮原本的样子」压的才）留着但不进记忆块；
//     取消隐藏后，只要它这一轮恢复成了原样（见 invalidateAfterHide），摘要直接恢复使用，不用重压。
//   - 折叠切点（foldCut）、「保留最近 N 楼原文」都只数可见的楼：N 楼原文指的是发出去的 N 楼。
//     隐藏标记也是聊天内容的一部分，所以「切点只由聊天内容和设置决定、刷新后不变」照旧成立。
//   - 隐藏 / 取消隐藏改变了哪几轮发出去的内容，就作废哪几轮的摘要（invalidateAfterHide），和编辑、删楼同一个规矩。

/** 这一楼是不是隐藏楼层（只认 true：默认不写这个字段） */
export const isHidden = m => m?.hidden === true;

/**
 * 第 r 楼（一条回复）这一轮的输入：紧挨在它前面、可见的用户输入的楼层号（旧 → 新）。
 * 和 ui/memory.js summarizeTurn 的取材完全一致（它就调这个）。
 * @param {(k: number) => boolean} [hid]  第 k 楼算不算隐藏；默认看 chat 上的标记（invalidateAfterHide 用它算「隐藏之前」）
 */
export function turnInputs(chat, r, hid = k => isHidden(chat[k])) {
    const out = [];
    for (let j = r - 1; j >= 0; j--) {
        if (hid(j)) continue;
        if (chat[j]?.role !== 'user') break;
        out.unshift(j);
    }
    return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

/**
 * 隐藏 / 取消隐藏之后，哪些回复的摘要要作废。chat 是【改完之后】的数组，wasHidden(k) 是改之前第 k 楼的隐藏状态。原地改 chat。
 *
 * 要守住的性质（test/hide.test.mjs 用随机操作序列钉着）：
 *   每条【可见】且有摘要的回复，摘要是按它【现在】的取材（turnInputs）压的；
 *   每条【隐藏】且有摘要的回复，摘要是按它「原本的样子」（不管隐藏标记、紧挨着的那串用户输入）压的。
 * 后一条让「取消隐藏时恢复原样就保留摘要」这个推断总是成立。规则：
 *   - 改之前就可见、现在也可见的回复：它这一轮的输入变了就作废。
 *     例：隐藏一条用户输入 → 它那一轮少了输入；隐藏一条回复 → 它前面的输入并进下一轮，下一轮作废。
 *   - 这次被隐藏的回复：隐藏之前的取材和「原本的样子」不同（它前面有输入已经被隐藏了，摘要是缺着那几句压的）→ 作废；
 *     相同就留着（取消隐藏、恢复原样后直接用）。
 *   - 这次才取消隐藏的回复：拿「原本的样子」和现在的取材比较，一样就直接恢复使用，不一样（它的输入还隐藏着）才作废。
 *     最常见的「把一段很早的剧情整段隐藏、之后整段取消隐藏」因此一条都不用重压。
 *   - 一直隐藏着的回复：不动（它不进记忆块；它的「原本的样子」只会被编辑 / 删楼改变，那两条路各自会作废它）。
 * 为什么要第二条（以前没有，复核实测出的漏洞）：①隐藏用户输入 U1 ②压缩完成，回复 A 的摘要里没有 U1 ③隐藏 A（摘要留着）
 *   ④取消隐藏 U1（A 还隐藏着，不比较）⑤取消隐藏 A → 「原本的样子」= U1 + A，现在的取材也是 U1 + A，相同，于是保留了缺 U1 的摘要。
 *   现实里的触发：先隐藏某条输入，过一会儿「隐藏至此」盖过它，再「全部取消隐藏」。在第③步就作废，⑤ 时 A 没有摘要，照常重压。
 * @param {{role: string, hidden?: boolean, memory?: string}[]} chat
 * @param {(k: number) => boolean} wasHidden
 * @returns {number[]} 被作废的回复下标
 */
export function invalidateAfterHide(chat, wasHidden) {
    const hit = [];
    const original = r => turnInputs(chat, r, () => false);
    for (let r = 0; r < chat.length; r++) {
        if (chat[r]?.role !== 'assistant') continue;
        if (isHidden(chat[r])) {
            // 这次被隐藏的：隐藏之前的取材（摘要就是按它压的）和原本的样子对不上 → 作废
            if (!wasHidden(r) && !sameList(turnInputs(chat, r, wasHidden), original(r)) && dropMemory(chat[r])) hit.push(r);
            continue;
        }
        const now = turnInputs(chat, r);
        const before = wasHidden(r) ? original(r) : turnInputs(chat, r, wasHidden);
        if (!sameList(now, before) && dropMemory(chat[r])) hit.push(r);
    }
    return hit;
}

/**
 * 把一批楼设成隐藏 / 取消隐藏（原地改 chat），顺带按 invalidateAfterHide 作废受影响的摘要。
 * 对应酒馆 scripts/chats.js hideChatMessageRange：逐楼 message.is_system = hide。
 *   - 隐藏写 hidden = true；取消隐藏删掉这个字段（默认不写），并把 st.is_system 改成 false：
 *     导入的行原来是 is_system: true，不改的话导出时会被当成「老存档」原样写回 true（见 chatfile.js 文件头）。
 * @param {object[]} chat
 * @param {Iterable<number>} indexes
 * @param {boolean} hide
 * @returns {{changed: number[], invalidated: number[]}}  changed：状态真的变了的楼
 */
export function setHidden(chat, indexes, hide) {
    const before = chat.map(isHidden);
    const changed = [];
    for (const i of new Set([...indexes].map(Number))) {
        const m = chat[i];
        if (!Number.isInteger(i) || !m) continue;
        const stFlag = m.st && typeof m.st === 'object' && m.st.is_system;
        if (hide) {
            if (isHidden(m)) continue;
            m.hidden = true;
        } else {
            // 本来就没隐藏的不动——包括 st 里还留着 is_system: true 的老存档楼层（不迁移，见 chatfile.js 文件头）
            if (!isHidden(m)) continue;
            delete m.hidden;
            if (stFlag) m.st.is_system = false;
        }
        changed.push(i);
    }
    changed.sort((a, b) => a - b);
    const invalidated = changed.length ? invalidateAfterHide(chat, k => before[k] ?? false) : [];
    return { changed, invalidated };
}

/** 摘要写成这个值表示「这一轮没有值得记的内容」：算作已处理（不挡住后面的折叠），但不进记忆块。也可以在记忆页手动填。 */
export const MEMORY_SKIP = '-';

/**
 * 批大小的默认值（楼数）。界面已隐藏这项设置，运行时固定用它（2026-11-22 用户定）：
 * ui/memory.js foldChat 调 foldCut 前把 memory.batch 盖成这个值，存储 / 备份里残留的别的值一律忽略（不改写存储）。
 * foldCut / batchSize 本身仍认 memory.batch，是为了让单元测试能直接验证各种批大小下的切点性质。
 */
export const MEMORY_BATCH_DEFAULT = 10;

/** 每条摘要的目标字数：默认值 = 压缩提示词里原来写死的 60；上限只是防手滑 */
export const MEMORY_SUMMARY_LEN_DEFAULT = 60;
export const MEMORY_SUMMARY_LEN_MAX = 1000;

/** 设置里的 summaryLen → 实际用的字数：不是正整数（缺失、0、负数、小数、文字、null……）一律当默认；超过上限按上限 */
export function summaryLenOf(memory) {
    const v = memory?.summaryLen;
    if (typeof v !== 'number' && typeof v !== 'string') return MEMORY_SUMMARY_LEN_DEFAULT;
    if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) return MEMORY_SUMMARY_LEN_DEFAULT;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return MEMORY_SUMMARY_LEN_DEFAULT;
    return Math.min(n, MEMORY_SUMMARY_LEN_MAX);
}

/** 压缩提示词。len = 每条摘要的目标字数（默认 60 = 这项设置出现之前写死的值，所以默认时发出去的字和以前一模一样） */
export function memorySystem(len = MEMORY_SUMMARY_LEN_DEFAULT) {
    return [
        '你是剧情记录员。下面是一段角色扮演里的一轮交互（用户的输入，以及角色的回复）。',
        `请把这一轮压缩成一句中文摘要，不超过 ${len} 个字，写清：谁做了什么、说了什么关键内容，以及地点或关系状态有什么变化。`,
        '只写实际发生的事，不评价、不推测后续。你不参与扮演，也不要续写剧情。',
        '只输出这一句摘要本身：不要引号、不要序号、不要「以下是摘要」之类的引子、不要解释、不要换行。',
    ].join('\n');
}
export const MEMORY_SYSTEM = memorySystem();

/** 设置里的 batch → 实际用的批大小：没写 = 默认；0 / 1 / 非法值 = 1（每轮都滑动，也就是以前的行为） */
export function batchSize(memory) {
    if (!memory || memory.batch === undefined) return MEMORY_BATCH_DEFAULT;
    const n = Math.floor(Number(memory.batch));
    return Number.isFinite(n) && n > 1 ? n : 1;
}

/**
 * 决定哪些楼层折叠成记忆。返回 cut：chat[0..cut) 不发原文；rows：对应的摘要行。
 *
 * 规则（每一条都只看聊天内容和设置，不看内存里的「上次切到哪」——刷新页面后必须得到同一个切点）：
 *   1. 目标：保留最近 keep 楼原文，cut = 楼数 − keep。
 *   2. 折叠段里每条回复都必须已有摘要：摘要还没压好（或压缩失败）的那一轮及之后一律照发原文，宁可多发也不丢内容。
 *      → cut 不超过第一条「还没有摘要的回复」的下标。
 *   3. 攒一批再滑动（batch，默认 10 楼）：上面两条得出的 cut 向下对齐到 batch 的整数倍。
 *      为什么：提示缓存只认「和上次一字不差的开头」。以前每多一轮，最老的一楼就从原文换成摘要，记忆块和它后面的原文起点
 *      每轮都变，从记忆块往后的内容永远吃不到缓存。对齐到固定的边界后，切点只在楼数跨过下一个边界时才一次前移一批，
 *      中间这几轮切点不动，记忆块和聊天段的开头都保持不变。代价是原文最多比以前多发 batch − 1 楼。
 *      对齐用的是「楼层号的整数倍」而不是「上次切到哪 + batch」：后者要记状态，刷新、删楼、导入之后就对不上了。
 *      第 2 条的上限也一起对齐：摘要一条条补上来的过程中，切点不会跟着一楼一楼地挪。
 *   4. 折叠段必须停在一轮结束处（最后一楼是回复）：不然会出现「用户输入被折叠、它的回复却照发原文」。
 *      → 从对齐后的位置往前退到最近的一条回复之后。
 * batch = 1 时第 3 条什么都不做，和以前逐轮滑动的结果完全相同。
 *
 * 隐藏楼层（见文件头「隐藏楼层」小节）：上面四条都在「去掉隐藏楼层之后的那串楼」上算——keep、batch 数的是可见的楼，
 * 第 2 条只看可见的回复（隐藏的回复永远不压，不能让它挡住折叠），摘要行也只取可见的回复。
 * 算完再换回完整记录里的楼层号：cut = 最后一条被折叠的可见楼 + 1。夹在中间、或紧跟在切点后面的隐藏楼层本来就不发，
 * 切在它们前面还是后面结果一样。没有隐藏楼层时可见下标 = 楼层号，和以前逐字相同。
 *
 * 和「上下文上限」（assemble.js）的配合：先折叠、后上限。上限只在 chat.slice(cut) 里从最老的开始丢，
 * 所以多发的那几楼要是超了上限，会照常被丢掉；等切点前移，它们会以摘要的形式回来。
 *
 * @param {{role: string, memory?: string, hidden?: boolean}[]} chat
 * @param {{enabled?: boolean, keep?: number, batch?: number} | null | undefined} memory  GlobalRecord.memory（运行时调用方要把 batch 盖成 MEMORY_BATCH_DEFAULT，见上）
 * @returns {{cut: number, rows: {index: number, text: string}[]}}
 */
export function foldCut(chat, memory) {
    if (!memory?.enabled) return { cut: 0, rows: [] };
    const vis = [];   // 可见楼层的楼层号
    for (let i = 0; i < chat.length; i++) if (!isHidden(chat[i])) vis.push(i);
    const at = v => chat[vis[v]];
    let cut = Math.max(0, vis.length - Math.max(0, Number(memory.keep) || 0));
    const firstMissing = vis.findIndex(i => chat[i].role === 'assistant' && !chat[i].memory);
    if (firstMissing >= 0) cut = Math.min(cut, firstMissing);
    const batch = batchSize(memory);
    cut = Math.floor(cut / batch) * batch;
    while (cut > 0 && at(cut - 1).role !== 'assistant') cut--;
    const rows = [];
    for (let v = 0; v < cut; v++) {
        if (at(v).role === 'assistant' && at(v).memory !== MEMORY_SKIP) rows.push({ index: vis[v], text: at(v).memory });
    }
    return { cut: cut ? vis[cut - 1] + 1 : 0, rows };
}

/** 第 i 楼所在的那一轮的回复：它自己是回复就是它；是用户输入（或旁白）就是它后面第一条回复；没有返回 -1 */
export function turnReplyIndex(chat, i) {
    for (let k = i; k < chat.length; k++) if (chat[k]?.role === 'assistant') return k;
    return -1;
}

/** 把一条回复上的摘要（和压缩失败的记录）去掉，交给 ensureMemories 重压。返回有没有真的去掉什么 */
function dropMemory(msg) {
    if (!msg || (msg.memory === undefined && msg.memoryError === undefined)) return false;
    delete msg.memory;
    delete msg.memoryError;
    return true;
}

/**
 * 第 i 楼是可见的用户输入时，按「隐藏楼层」的取材规则（turnInputs）它属于哪条回复：往后跳过隐藏的楼，
 * 第一条可见的非用户楼是回复就是它，是旁白（或者没有）就是 -1。没有隐藏楼层时等于 turnReplyIndex。
 */
function visibleReplyOf(chat, i) {
    if (isHidden(chat[i]) || chat[i]?.role !== 'user') return -1;
    for (let k = i + 1; k < chat.length; k++) {
        if (isHidden(chat[k])) continue;
        if (chat[k].role === 'user') continue;
        return chat[k].role === 'assistant' ? k : -1;
    }
    return -1;
}

/**
 * 第 i 楼的原文变了（编辑、前端卡的 setChatMessage……）：这一轮的摘要作废。原地改 chat。
 * 有隐藏楼层时，一条用户输入可能「结构上」属于后面第一条回复（那条被隐藏了），「取材上」却并进了再后面那条可见的回复
 * （见文件头「隐藏楼层」）：两条都作废（偏保守，多压一次不会少记）。
 * @returns {number} 被作废的那条回复的下标（结构上的那条）；没有返回 -1
 */
export function invalidateTurnAt(chat, i) {
    const r = turnReplyIndex(chat, i);
    if (r >= 0) dropMemory(chat[r]);
    const v = visibleReplyOf(chat, i);
    if (v >= 0 && v !== r) dropMemory(chat[v]);
    return r;
}

/**
 * 删掉了任意几楼之后（drop = 原来的楼层号），哪些回复的摘要要作废。chat 是【删之前】的数组，原地改它上面剩下的回复。
 * 规则：每删掉一楼，它后面第一条【没被删】的回复所在的那一轮就变了——
 *   删的是用户输入（或旁白）：那一轮少了一部分输入；
 *   删的是回复：它前面的那串输入并进了下一轮（两轮合并）。
 * 被删的回复自己的摘要跟着它一起没了，不用管。
 * 偏保守：同时删掉「一轮的输入 + 它的回复」时，下一轮其实没变，这里也会把它作废（多压一次，不会少记）。
 * 「删除这一楼及之后」（chat.js deleteFrom）是截断，后面没有剩下的楼，这里什么都不会作废。
 * @param {{role: string, memory?: string}[]} chat
 * @param {Iterable<number>} drop
 * @returns {number[]} 被作废的回复在【删之前】的下标
 */
export function invalidateAfterDelete(chat, drop) {
    const gone = new Set([...drop].map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < chat.length));
    const hit = new Set();
    for (const i of gone) {
        for (let k = i + 1; k < chat.length; k++) {
            if (gone.has(k) || chat[k]?.role !== 'assistant') continue;
            hit.add(k);
            break;
        }
        // 隐藏楼层：上面找到的那条要是隐藏的，「取材上」受影响的是再往后第一条没被删的可见回复（见文件头「隐藏楼层」）。
        // 删的是可见的楼才会影响取材；一并作废（偏保守）。没有隐藏楼层时找到的就是上面那条，不会多作废
        if (!isHidden(chat[i])) {
            for (let k = i + 1; k < chat.length; k++) {
                if (gone.has(k) || isHidden(chat[k]) || chat[k]?.role !== 'assistant') continue;
                hit.add(k);
                break;
            }
        }
    }
    for (const k of hit) dropMemory(chat[k]);
    return [...hit].sort((a, b) => a - b);
}
