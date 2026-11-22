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
//
// ───── 记忆再压缩：合并段（2026-11-23，设置 memory.mergeEvery = x，默认不写 = 不做） ─────
// 聊得很长以后，每轮一行的摘要也会越积越多。已经折叠进记忆块的摘要行，从最老的开始每攒够 x 行就合并成一段。
// 用户定的三条规矩：合并后原来的一行行不留；合并段覆盖的楼里有一楼变了，这段就作废，那些轮回到「待压缩」、各自按原文重压
// （以后攒够了再重新合并）；「记忆」页的输入框「每 [x] 条记忆再次压缩」，留空或 0 = 不做。
//
// 存储（都挂在 assistant 楼上；不用这个功能的人一个字段都不多）：
//   段的最后一条回复（锚）：memoryMerged = {text, count, wait?}
//     text  合并出来的那一段；count 这一段覆盖几条回复（锚自己也算，含写成「-」的那几轮）
//     wait  只在「已算好、还没换上」时有（见下面「不额外打断缓存」）；换上之后删掉
//   段里锚以外的回复（已换上之后）：memoryIn = true（「我被后面的那一段覆盖」），自己的 memory 删掉
//   段的成员 = 从锚往前数 count 条【可见的】回复（隐藏的回复不是成员，也不在段里发出去，见文件头「隐藏楼层」）。
//   不存楼层号（from / to）：前端卡单删前面的楼时楼层号会整体平移，存了反而要跟着改；成员和范围每次从锚往前数出来。
//   一段的「范围」（segmentStart … 锚）：第一条成员那一轮的第一条输入起，到锚为止；界面上的「3–24」就是它。
//
// 两种状态：
//   待换上（wait 有值）：成员各自的 memory 还在、还照常按行发（记忆块里仍是一行行的），段只是一份「算好了的提议」，成员没有 memoryIn。
//   已换上（没有 wait）：成员的 memory 删掉、锚以外的成员带 memoryIn，记忆块里这一段只占一行。
//   「没有哪一轮既有自己的摘要又被合并段覆盖」说的是已换上的段；待换上的段可以随时整份扔掉，成员的摘要一条不少。
//
// 不额外打断缓存（为什么有 wait）：
//   合并会改记忆块开头的文字。合并请求是在切点刚前移、一批原文刚换成摘要之后才发出去的（那时才攒够 x 行），
//   结果几秒后回来——要是一回来就用上，下一次发送的记忆块又变一次，提示缓存在两次切点移动之间多断一回。
//   所以结果写下时记下 wait = 这一刻的切点 − (锚 + 1)，规则是：切点 − (锚 + 1) > wait 才换上，也就是【切点再往后挪一次】才用。
//   切点本来就只在「一批原文换成摘要」时移动（foldCut 第 3 条），那一刻记忆块本来就要变，合并顺带一起换上，不多断一次。
//   性质（test/memory-merge.test.mjs 钉着）：只往后加楼、后台压缩 / 合并随便什么时候完成，记忆块的文字只在切点变化时变化。
//   wait 是相对锚的偏移、不是绝对楼层号：前端卡单删前面的楼时锚和切点一起平移，偏移不变；删的楼在锚和切点之间时偏移偏大，
//   只是晚一批换上（不会更早）。换上（commitMerged）只是存储上的收尾：删掉成员的行、打上 memoryIn——换上前后 foldCut 的结果逐字相同，
//   所以什么时候收尾都行（ensureMemories 每次开始和结束时做）。
//   切点因为删掉最近的楼而退回到一段已换上的合并段中间时：切点再退到这一段开头之前（这一段整段照发原文），
//   不把段劈开（段是一整段文字，没法只发一半）。和第 2 条「宁可多发也不丢内容」同一个方向。待换上的段被切点劈开时照旧按行发。
//
// 什么时候合并（nextMergeGroup）：只看已折叠（切点之前）的可见回复，跳过已经在某一段里（含待换上）的，从最老的开始，
//   连续攒够 x 行（写成「-」的不算行数、但算成员）就是一组；中间隔着一段的不连起来（一段作废后中间空出来、不够 x 行的就留着按行发）。
//   只做一层：合并出来的段不再被二次合并（多段按时间顺序排在记忆块里，通常就是最前面那几行）。这是有意的，以后要做多层再说。
//   改小 / 改大 / 关掉 mergeEvery：已有的段不动（已经合并的保持，待换上的照常换上），只影响之后的合并。
//
// 作废（mergedSegments 读出段，dissolve 拆掉）：拆掉已换上的段 = 删 memoryMerged、删成员的 memoryIn，成员都没有摘要了，交给 ensureMemories 逐轮重压；
//   拆掉待换上的段 = 只删 memoryMerged（成员的行原本就在）。入口：
//   - invalidateTurnAt（编辑、前端卡改原文、换候选 / 重新生成后由调用方调）：作废的那条回复在哪一段里，就拆那一段；
//   - setHidden：要改隐藏状态的楼落在某一段的「取材范围」里（从这一段前面最近的可见非用户楼起到锚，用改之前的状态算），就拆那一段——
//     隐藏 / 取消隐藏会改变成员的取材、让成员进出发送内容、或让段里多出一条可见的回复，统统作废（和「取材变了就作废」同一个规矩，偏保守）；
//   - invalidateAfterDelete（前端卡单删）：删掉的楼落在某一段的取材范围里，拆那一段；
//   - invalidateBeforeTruncate（「删这一楼及之后」）：锚在被删范围里的段（被切进了覆盖范围）拆掉；
//   - 「记忆」页的「重压」、把段的文字清空：dissolveMerged。
//   读档时（normalizeMerged，state.js applyCardChat）和 ensureMemories 开始时：形状不对的段、数不出 count 条成员的段、
//   成员状态对不上的段删掉；不属于任何合法段的 memoryIn（孤儿标记）删掉——被清掉标记的轮没有摘要，回到待压缩。坏数据不会让页面打不开。

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
            if (!wasHidden(r) && !sameList(turnInputs(chat, r, wasHidden), original(r)) && dropTurn(chat, r)) hit.push(r);
            continue;
        }
        const now = turnInputs(chat, r);
        const before = wasHidden(r) ? original(r) : turnInputs(chat, r, wasHidden);
        if (!sameList(now, before) && dropTurn(chat, r)) hit.push(r);
    }
    // 合并段：经 setHidden 来的，受影响的段在改标记之前就拆过了；直接调用本函数时这里兜底，把对不上的段 / 孤儿标记清掉
    normalizeMerged(chat);
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
    const want = [...new Set([...indexes].map(Number))];
    // 合并段：要改的楼落在哪一段的取材范围里，就先（按改之前的隐藏状态）拆掉那一段（规则见文件头「合并段」）
    const dissolved = dissolveTouched(chat, want.filter(i => Number.isInteger(i) && chat[i] && isHidden(chat[i]) !== hide));
    for (const i of want) {
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
    // 被拆掉的已换上的段，成员也算「被作废」（没有合并段时这一步什么都不加，结果和以前一样）
    return { changed, invalidated: dissolved.length ? [...new Set([...invalidated, ...dissolved])].sort((a, b) => a - b) : invalidated };
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
 * 合并段（见文件头「合并段」）：已换上的段的成员算「已有摘要」（第 2 条不被它们挡住）；一段已换上的段不能被切点劈开，
 * 劈开了就把切点再退到这一段开头之前。摘要行里，用上了的段只占一行（在锚的位置），带 merged = {from, to, count}；
 * 待换上（还没到时候）的段照旧按成员各自的行发。没有合并段时这些都不发生，结果和以前逐字相同。
 *
 * @param {{role: string, memory?: string, hidden?: boolean, memoryMerged?: object, memoryIn?: true}[]} chat
 * @param {{enabled?: boolean, keep?: number, batch?: number} | null | undefined} memory  GlobalRecord.memory（运行时调用方要把 batch 盖成 MEMORY_BATCH_DEFAULT，见上）
 * @returns {{cut: number, rows: {index: number, text: string, merged?: {from: number, to: number, count: number}}[]}}
 */
export function foldCut(chat, memory) {
    if (!memory?.enabled) return { cut: 0, rows: [] };
    const vis = [];   // 可见楼层的楼层号
    for (let i = 0; i < chat.length; i++) if (!isHidden(chat[i])) vis.push(i);
    const at = v => chat[vis[v]];
    const segs = hasMergeFields(chat) ? mergedSegments(chat).segs : [];
    const segOf = new Map();   // 楼层号 → 它所在的段
    for (const s of segs) for (const k of s.members) segOf.set(k, s);
    const done = i => Boolean(chat[i].memory) || segOf.get(i)?.pending === false;
    let cut = Math.max(0, vis.length - Math.max(0, Number(memory.keep) || 0));
    const firstMissing = vis.findIndex(i => chat[i].role === 'assistant' && !done(i));
    if (firstMissing >= 0) cut = Math.min(cut, firstMissing);
    const batch = batchSize(memory);
    cut = Math.floor(cut / batch) * batch;
    const toTurnEnd = () => { while (cut > 0 && at(cut - 1).role !== 'assistant') cut--; };
    toTurnEnd();
    if (segs.length) {
        // 已换上的段被切点劈开（第一条成员在切点前、锚在切点后）：切点退到这一段开头之前。从新到旧看，切点只会往前退
        const pos = new Map(vis.map((f, v) => [f, v]));
        for (let k = segs.length - 1; k >= 0 && cut > 0; k--) {
            const s = segs[k];
            if (s.pending) continue;
            const last = vis[cut - 1];
            if (s.anchor <= last) break;              // 这一段整段在切点前：更早的段也一样
            if (s.members[0] > last) continue;        // 整段在切点后：照发原文，和切点无关
            cut = pos.get(segmentStart(chat, s));
            toTurnEnd();
        }
    }
    const cutFloor = cut ? vis[cut - 1] + 1 : 0;
    const rows = [];
    for (let v = 0; v < cut; v++) {
        const m = at(v);
        if (m.role !== 'assistant') continue;
        const s = segOf.get(vis[v]);
        if (s && segmentInUse(s, cutFloor)) {
            if (vis[v] === s.anchor) rows.push({ index: s.anchor, text: s.text, merged: { from: segmentStart(chat, s), to: s.anchor, count: s.members.length } });
            continue;
        }
        if (m.memory !== MEMORY_SKIP) rows.push({ index: vis[v], text: m.memory });
    }
    return { cut: cutFloor, rows };
}

/** 把若干行摘要拼成发给模型的记忆块。没有合并段时和以前逐字相同；有合并段时开头那句说明多半句 */
export function memoryBlock(rows) {
    const head = rows.some(r => r.merged)
        ? '[此前剧情的记忆：按先后顺序，每行是一轮的摘要；较早的若干轮合并成了一段]'
        : '[此前剧情的记忆：按先后顺序，每行是一轮的摘要]';
    return head + '\n' + rows.map((r, k) => `${k + 1}. ${r.text}`).join('\n');
}

// ───────────────────────────── 记忆再压缩：合并段（规则见文件头「合并段」） ─────────────────────────────

/** 「每 x 条记忆再次压缩」的上下限。0 = 不做 */
export const MERGE_EVERY_MIN = 4;
export const MERGE_EVERY_MAX = 200;

/**
 * 设置里的 mergeEvery → 实际用的 x：缺失、0、负数、小数、文字……一律 0（不做）；1–3 按 4 算（合并两三行省不了几个字，
 * 而且会让合并请求太频繁）；超过 200 按 200。界面写入前也按同样的规则换算（ui/memory.js），所以存储里通常只会有 4–200。
 */
export function mergeEveryOf(memory) {
    const v = memory?.mergeEvery;
    if (typeof v !== 'number' && typeof v !== 'string') return 0;
    if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return 0;
    return Math.min(Math.max(n, MERGE_EVERY_MIN), MERGE_EVERY_MAX);
}

/** 合并段的目标字数 = 每条摘要的字数 × 4（默认 60 → 240） */
export const mergeLenOf = memory => summaryLenOf(memory) * 4;

/** 合并用的提示词（发给摘要模型）。len = 合并段的目标字数 */
export function mergeSystem(len = MEMORY_SUMMARY_LEN_DEFAULT * 4) {
    return [
        '你是剧情记录员。下面是一段角色扮演里按时间顺序排列的若干行剧情摘要，每行是一轮交互。',
        `请把它们合并成连贯的一段中文摘要，不超过 ${len} 个字：保留出场人物、关键事件、人物关系和状态的变化，以及还没有了结的事。`,
        '按时间顺序写，只写摘要里有的内容，不加评论、不评价、不推测后续。你不参与扮演，也不要续写剧情。',
        '只输出这一段摘要本身：不要标题、不要序号、不要「以下是合并后的摘要」之类的引子、不要解释、不要换行。',
    ].join('\n');
}

/** 发给摘要模型的合并请求正文：若干行摘要按时间顺序编号 */
export const mergeBody = texts => '【按时间顺序的剧情摘要】\n' + texts.map((t, k) => `${k + 1}. ${t}`).join('\n');

const isObjM = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 聊天里有没有合并段相关的字段（没有就走和以前完全一样的快路） */
const hasMergeFields = chat => chat.some(m => m?.memoryMerged !== undefined || m?.memoryIn !== undefined);

/** memoryMerged 的形状对不对：text 非空字符串、count 正整数、wait 没有或是非负整数 */
const segShape = mm => isObjM(mm) && typeof mm.text === 'string' && mm.text.trim() !== '' && Number.isInteger(mm.count) && mm.count >= 1
    && (mm.wait === undefined || (Number.isInteger(mm.wait) && mm.wait >= 0));

/** 这条回复被一段已换上的合并段覆盖了（不再自己压缩）。只看自己身上的标记；结构对不对由 normalizeMerged 保证 */
export const coveredByMerge = m => m?.memoryIn === true || (isObjM(m?.memoryMerged) && m.memoryMerged.wait === undefined);

/**
 * 读出聊天里所有合法的合并段（不改 chat）。
 * @returns {{segs: {anchor: number, members: number[], pending: boolean, text: string, wait?: number}[], bad: number[], orphans: number[]}}
 *   segs 按时间顺序，members 旧 → 新、含锚；bad = 不合法的段的锚；orphans = 带 memoryIn 却不属于任何合法的已换上的段的楼
 */
export function mergedSegments(chat) {
    const segs = [], bad = [], claimed = new Set(), coveredOk = new Set();
    for (let a = chat.length - 1; a >= 0; a--) {
        const m = chat[a];
        if (m?.memoryMerged === undefined) continue;
        const mm = m.memoryMerged;
        if (m.role !== 'assistant' || isHidden(m) || !segShape(mm) || claimed.has(a)) { bad.push(a); continue; }
        const pending = mm.wait !== undefined;
        const members = [];
        let ok = true;
        for (let k = a; k >= 0 && members.length < mm.count; k--) {
            const x = chat[k];
            if (isHidden(x) || x?.role !== 'assistant') continue;
            if (k !== a && (x.memoryMerged !== undefined || claimed.has(k))) { ok = false; break; }
            const fits = pending
                ? typeof x.memory === 'string' && x.memory !== '' && x.memoryIn === undefined                    // 待换上：成员的行都在、没有标记
                : x.memory === undefined && (k === a ? x.memoryIn === undefined : x.memoryIn === true);          // 已换上：行已删、锚以外带标记
            if (!fits) { ok = false; break; }
            members.unshift(k);
        }
        if (!ok || members.length !== mm.count) { bad.push(a); continue; }
        for (const k of members) { claimed.add(k); if (!pending) coveredOk.add(k); }
        segs.unshift(pending ? { anchor: a, members, pending, text: mm.text, wait: mm.wait } : { anchor: a, members, pending, text: mm.text });
    }
    const orphans = [];
    chat.forEach((m, i) => { if (m?.memoryIn !== undefined && !coveredOk.has(i)) orphans.push(i); });
    return { segs, bad: bad.sort((x, y) => x - y), orphans };
}

/** 一段的范围从哪一楼起：第一条成员那一轮的第一条可见输入（没有输入就是它自己） */
export function segmentStart(chat, seg) {
    const m0 = seg.members[0];
    return turnInputs(chat, m0)[0] ?? m0;
}

/** 这一段现在用不用（cutFloor = 完整记录里的切点）：已换上的整段在切点前就用；待换上的还要等切点比写下时再往后挪 */
const segmentInUse = (s, cutFloor) => s.anchor < cutFloor && (!s.pending || cutFloor - (s.anchor + 1) > s.wait);

/**
 * 读档 / 兜底的规范化（原地改 chat）：删掉不合法的段（memoryMerged）和孤儿标记（memoryIn）。
 * 被删掉标记、又没有自己摘要的轮回到待压缩（ensureMemories 会重压）；待换上的段被删，成员的行原本就在，不受影响。
 * @returns {boolean} 改没改
 */
export function normalizeMerged(chat) {
    if (!Array.isArray(chat) || !hasMergeFields(chat)) return false;
    let changed = false;
    // 删掉一段坏的之后，别的段的判断不受影响（每段只看自己的成员）；保险起见做到不再变化为止
    for (let round = 0; round < 5; round++) {
        const { bad, orphans } = mergedSegments(chat);
        if (!bad.length && !orphans.length) break;
        for (const a of bad) delete chat[a].memoryMerged;
        for (const i of orphans) delete chat[i].memoryIn;
        changed = true;
    }
    return changed;
}

/** 拆掉一段（seg 来自 mergedSegments）。已换上的：成员的标记一起删，成员没有摘要了，交给 ensureMemories 逐轮重压 */
function dissolve(chat, seg) {
    delete chat[seg.anchor].memoryMerged;
    if (!seg.pending) for (const k of seg.members) delete chat[k].memoryIn;
}

/** 第 r 条回复所在的段（没有返回 null） */
function segmentOfReply(chat, r) {
    if (!hasMergeFields(chat)) return null;
    return mergedSegments(chat).segs.find(s => s.members.includes(r)) ?? null;
}

/**
 * 拆掉第 r 条回复所在的那一段（它是那一段的成员时）。给「记忆」页、以及换候选 / 重新生成之后的调用方用。
 * @returns {number[]} 被拆的段的成员（没拆返回 []）
 */
export function dropMergedAt(chat, r) {
    const s = segmentOfReply(chat, r);
    if (!s) return [];
    dissolve(chat, s);
    return s.members;
}

/** 「记忆」页的「重压」/ 清空段文字：拆掉锚在第 anchor 楼的那一段。@returns {boolean} */
export function dissolveMerged(chat, anchor) {
    const s = hasMergeFields(chat) ? mergedSegments(chat).segs.find(x => x.anchor === anchor) : null;
    if (!s) return false;
    dissolve(chat, s);
    return true;
}

/** 一段的「取材范围」起点：第一条成员前面最近的可见非用户楼（改它的隐藏状态 / 删掉它都会让第一条成员的输入变）；没有就是 0 */
function touchStart(chat, seg) {
    for (let j = seg.members[0] - 1; j >= 0; j--) {
        if (isHidden(chat[j]) || chat[j]?.role === 'user') continue;
        return j;
    }
    return 0;
}

/** floors 里有落在某一段取材范围 [touchStart, 锚] 里的，就拆那一段。按【现在】的隐藏状态算（调用方在改之前调）。@returns {number[]} 被拆的已换上的段的成员 */
function dissolveTouched(chat, floors) {
    if (!floors.length || !hasMergeFields(chat)) return [];
    const out = [];
    for (const s of mergedSegments(chat).segs) {
        const lo = touchStart(chat, s);
        if (!floors.some(f => f >= lo && f <= s.anchor)) continue;
        dissolve(chat, s);
        if (!s.pending) out.push(...s.members);
    }
    return out;
}

/**
 * 「删除这一楼及之后」（截断到 i 楼，chat.js deleteFrom）之前调：锚在被删范围里的段（被切进了覆盖范围，或整段都要删）拆掉。
 * 留下来的成员没有摘要了，交给 ensureMemories 重压。原地改 chat。@returns {number} 拆了几段
 */
export function invalidateBeforeTruncate(chat, i) {
    if (!hasMergeFields(chat)) return 0;
    let n = 0;
    for (const s of mergedSegments(chat).segs) if (s.anchor >= i) { dissolve(chat, s); n++; }
    return n;
}

/**
 * 下一组该合并的回复（楼层号，旧 → 新）；没有返回 null。规则见文件头「什么时候合并」。
 * @param {object[]} chat
 * @param {object} memory   和 foldCut 一样的设置（运行时 batch 已盖成 10）
 * @param {number} every    mergeEveryOf 的结果；0 = 不做
 */
export function nextMergeGroup(chat, memory, every) {
    if (!memory?.enabled || !(every >= 1)) return null;
    const { cut } = foldCut(chat, memory);
    const inSeg = new Set();
    if (hasMergeFields(chat)) for (const s of mergedSegments(chat).segs) for (const k of s.members) inSeg.add(k);
    let run = [], rows = 0;
    for (let i = 0; i < cut; i++) {
        const m = chat[i];
        if (isHidden(m) || m?.role !== 'assistant') continue;
        if (inSeg.has(i) || typeof m.memory !== 'string' || !m.memory) { run = []; rows = 0; continue; }
        run.push(i);
        if (m.memory !== MEMORY_SKIP) rows++;
        if (rows >= every) return run;
    }
    return null;
}

/** 一组成员的「取材指纹」：合并请求发出去时记下，结果回来时核对（成员的原文、输入、摘要行、范围里有哪些可见回复都没变才写） */
export function mergeFingerprint(chat, members) {
    if (!Array.isArray(chat) || !members.length) return '';
    const lo = members[0], hi = members.at(-1);
    const replies = [];
    for (let k = lo; k <= hi && k < chat.length; k++) if (!isHidden(chat[k]) && chat[k]?.role === 'assistant') replies.push(k);
    return JSON.stringify([replies, members.map(k => {
        const m = chat[k];
        return m ? [m.role, isHidden(m), m.content, m.memory ?? null, turnInputs(chat, k).map(j => chat[j].content)] : null;
    })]);
}

/**
 * 合并结果写下（待换上）。调用方先用 mergeFingerprint 核对过、确认这些楼都还不在任何段里。原地改 chat。
 * wait = 这一刻的切点 − (锚 + 1)：切点再往后挪一次才换上（见文件头「不额外打断缓存」）
 */
export function applyMerge(chat, members, text, memory) {
    const anchor = members.at(-1);
    const { cut } = foldCut(chat, memory);
    chat[anchor].memoryMerged = { text, count: members.length, wait: Math.max(0, cut - (anchor + 1)) };
}

/**
 * 把已经用上了的待换上的段「换上」：删掉成员各自的行、打上 memoryIn、去掉 wait。前后 foldCut 的结果逐字相同（只是存储上的收尾）。
 * @returns {number} 换上了几段
 */
export function commitMerged(chat, memory) {
    if (!memory?.enabled || !hasMergeFields(chat)) return 0;
    const { cut } = foldCut(chat, memory);
    let n = 0;
    for (const s of mergedSegments(chat).segs) {
        if (!s.pending || !segmentInUse(s, cut)) continue;
        for (const k of s.members) {
            delete chat[k].memory;
            delete chat[k].memoryError;
            if (k !== s.anchor) chat[k].memoryIn = true;
        }
        const { wait: _w, ...rest } = chat[s.anchor].memoryMerged;
        chat[s.anchor].memoryMerged = rest;
        n++;
    }
    return n;
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
 * 第 r 条回复这一轮作废：它在某一段合并段里就先拆那一段（成员回到待压缩），再去掉它自己的摘要。
 * 返回有没有真的作废什么。没有合并段时等于 dropMemory。
 */
function dropTurn(chat, r) {
    const hit = dropMergedAt(chat, r).length > 0;
    return dropMemory(chat[r]) || hit;
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
    if (r >= 0) dropTurn(chat, r);
    const v = visibleReplyOf(chat, i);
    if (v >= 0 && v !== r) dropTurn(chat, v);
    // 兜底：换候选时 chatfile.js selectSwipe / appendSwipe 先删了这一楼的摘要，待换上的段因此数不齐成员、上面找不到它——这里清掉
    normalizeMerged(chat);
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
    // 合并段：删掉的楼落在哪一段的取材范围里（含删掉成员、锚本身），先拆掉那一段（规则见文件头「合并段」）
    dissolveTouched(chat, [...gone]);
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
    for (const k of hit) dropTurn(chat, k);
    return [...hit].sort((a, b) => a - b);
}
