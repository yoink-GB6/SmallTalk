// 外置记忆的纯逻辑（不碰页面、不碰 state，Node 里可以直接单元测试）：
//   foldCut           决定聊天记录里哪一段折叠成摘要（「攒一批再滑动」）
//   markTurnEdited    某一楼的原文被手动改了（编辑、拼装页就地改、写卡页改第 0 楼、脚本 / 前端卡 setChatMessages）：只打「原文改过」的标记
//   invalidateTurnAt  这一轮的回复整个换了（换候选、重新生成）：这一轮的摘要作废
//   invalidateAfterDelete  删掉了任意几楼（前端卡的 deleteChatMessages）：受影响的轮的摘要作废
// 界面那一侧（压缩、「记忆」页）在 src/ui/memory.js；请求一个个排队发的调度在 src/memory-queue.js。
//
// 「一轮」的定义（和 ui/memory.js summarizeTurn 取材的范围一致）：一条 assistant 回复，加上紧挨在它前面的那一串连续的 user 输入。
// 摘要挂在回复上（ChatMessage.memory）。什么时候作废（2026-11-29 用户改的规则）：
//   - 这一轮的回复整个换了（换候选、重新生成）或这一轮由哪几楼组成变了（删楼）：摘要作废，交给 ensureMemories 重压；别的轮不动。
//     旧摘要描述的是另一段内容，留着只会误导。
//   - 手动改了这一轮里某一楼的原文（自己编辑，或卡的脚本 / 前端卡改的）：【不作废、不重压、不发请求】，摘要和合并段原样留着，
//     只在这一轮的回复上打一个「原文改过」的标记（ChatMessage.memoryStale，见下面「原文改过」）。
//     用户的理由：都手动改内容了，也不差手动改摘要；想更新就去「记忆」页改那一行，或点那一行的「重压」。
//     这也是花额度的地方：以前在合并段里改一个字会让整段几十轮全部重压。
//
// ───── 原文改过（ChatMessage.memoryStale = true，2026-11-29） ─────
// 意思：「这一轮压好之后原文又被手动改过，摘要没有跟着更新」。只是给人看的提示：
//   - 不发给模型（记忆块只有摘要文字），不影响切点（foldCut 不看它），不算「待压缩」（turnPending 不看它），不触发任何请求。
//   - 挂在哪：这一轮的回复上（和 memory 同一条消息）。改的是用户输入那一楼，也挂在这一轮的回复上（turnReplyIndex）；
//     这一轮还没有回复，或者改的是旁白（旁白不属于任何一轮的取材，见 turnInputs）：不打。
//   - 什么时候打（markTurnEdited）：这一轮已经「压好了」才打——有自己的摘要（含写成「-」的：那是对旧原文的判断，原文变了它也可能不对了，
//     一样提醒），或者已经被一段已换上的合并段覆盖（成员自己的 memory 已删，标记照样挂在这条回复上）。
//     还没压（待压缩 / 失败 / 整轮隐藏）的不打：到时候压的本来就是新原文。原文改了又改回去也不撤（没存旧原文，没法知道）。
//   - 合并段：标记挂在成员（回复）上，段本身不动、不作废；「记忆」页那一段只要有一条成员带标记，整段显示「原文改过」。
//     待换上（wait）的段同理：成员自己的行还在，标记挂在成员上；换上（commitMerged）之后成员变成被覆盖，标记照样合法、照样留着。
//   - 什么时候清：这一轮的摘要作废（换候选 / 重新生成 / 删楼，dropMemory）；「记忆」页点这一行的「重压」（一点就清：旧摘要那一刻就丢了，
//     重压失败也只剩失败记录，没有摘要可「过时」）或手动改这一行的摘要（含清空、改成「-」）；
//     已换上的段被拆（dissolve：「重压」这一段、清空段文字、删楼碰到它）时成员上的标记一起清（成员都没有摘要了）；
//     改段的文字（不清空）= 用户手动更新了这一段，成员上的标记一起清。待换上的段被拆时成员的标记不清：成员自己的行还在、仍然是旧原文压的。
//   - 读档（normalizeMerged 末尾的 normalizeStale）：值不是 true 的、挂在一条「没压好」的楼上的（孤儿标记）删掉。
//   - 默认不写：只有打了标记才有这个键，清掉就删键。没改过原文的存档存储形状和以前逐字相同。

//
// ───── 隐藏楼层（ChatMessage.hidden，酒馆的 is_system）和记忆（2026-11-23 用户定：隐藏不碰记忆） ─────
// 规矩：隐藏 / 取消隐藏只决定【这一楼的原文】发不发，完全不碰记忆。
//   - 不让任何摘要作废，不拆、不改任何合并段，不触发任何压缩 / 合并请求：setHidden 只改标记。
//   - 一轮的取材（turnInputs）不看隐藏标记：回复 + 紧挨在它前面的那串用户输入，原文是什么就压什么。
//     所以摘要一旦压好，只有回复整个换了（换候选、重新生成）或删楼才作废；手动编辑、前端卡改原文只打「原文改过」的标记（见上面）。
//   - 已有的摘要照旧留着、照旧进记忆块、照旧发；被合并段覆盖的轮同理（合并段照旧发）。
//     【隐藏一楼不等于模型完全看不到它】：已经压成摘要的那句还会发。要彻底去掉，得到「记忆」页手动删掉那条记忆（或写成「-」）。
//     用户知情并接受。
//   - 「整轮隐藏」= 回复和它这一轮的输入全都隐藏了（turnFullyHidden）。整轮隐藏、还没压过的轮：隐藏期间不压（不发请求），
//     不算在「待压缩」里，也不挡折叠（它没有一个字会发出去，挡着只会让后面的楼白白多发原文）；取消隐藏后按正常流程压。
//     只隐藏了一部分的轮（比如只隐藏回复、输入没隐藏）照常压：不压的话，没隐藏的那条输入在切点之前既不发原文、也不在任何摘要里，
//     或者整个折叠卡在这一轮。照「原文是什么就压什么」，压的是整轮原文（含隐藏的那部分）。
//   - 折叠切点（foldCut）数【所有楼】（含隐藏的）：「保留最近 N 条原文」、攒一批（batch）都按完整记录的楼层号算。
//     所以隐藏 / 取消隐藏一个已有摘要（或被合并段覆盖）的楼，切点和记忆块一个字都不变。
//     唯一会让切点动的情形就是上一条：整轮隐藏、没摘要的轮不挡折叠——隐藏它只可能让切点前移；
//     取消隐藏它，它变回「待压缩」、重新挡住折叠，切点退到它前面（这一段照发原文，宁可多发），压好后再前移。
//     这只是发出去的内容变一下，不作废、不重压任何东西。
//     代价：最近的楼里隐藏的多，实际发出去的原文就比 N 条少（以前只数可见楼，没有隐藏楼时两种数法结果相同）。
//   - 隐藏的楼原文永远不发：切点之后的隐藏楼由 ui/pipeline.js computePrompt 去掉，切点之前的楼本来就只发摘要。
//   - 不变的：隐藏的楼不算深度、不触发世界书、宏（{{lastMessage}} 等）、作者注释间隔的计数、聊天文件里 is_system 的互认，
//     见 ui/pipeline.js、macros.js、author-note.js、chatfile.js。
//   - 按旧规矩（2026-11-23 之前：取材跳过隐藏楼、隐藏会作废摘要 / 拆段）存下的数据怎么读进来，见 normalizeMerged 上面的「旧数据」。
//     旧数据里「隐藏的回复带着摘要」现在照常发；按旧规矩压的摘要（取材跳过了隐藏楼）不重压——摘要不因为规则变了而作废。
//
// ───── 记忆再压缩：合并段（2026-11-23，设置 memory.mergeEvery = x，默认不写 = 不做） ─────
// 聊得很长以后，每轮一行的摘要也会越积越多。已经折叠进记忆块的摘要行，从最老的开始每攒够 x 行就合并成一段。
// 用户定的三条规矩：合并后原来的一行行不留；合并段覆盖的楼里有一轮的回复整个换了（换候选 / 重新生成）或删了楼，这段就作废，
// 那些轮回到「待压缩」、各自按原文重压（以后攒够了再重新合并）；「记忆」页的输入框「每 [x] 条记忆再次压缩」，留空或 0 = 不做。
// （2026-11-29 起：段里某一楼被手动编辑 / 被脚本改了原文，段【不作废】，只在那一轮的回复上打「原文改过」，见文件头。）
//
// 存储（都挂在 assistant 楼上；不用这个功能的人一个字段都不多）：
//   段的最后一条回复（锚）：memoryMerged = {text, count, wait?}
//     text  合并出来的那一段；count 这一段覆盖几条回复（锚自己也算，含写成「-」的那几轮）
//     wait  只在「已算好、还没换上」时有（见下面「不额外打断缓存」）；换上之后删掉
//   段里锚以外的回复（已换上之后）：memoryIn = true（「我被后面的那一段覆盖」），自己的 memory 删掉
//   段的成员 = 从锚往前数 count 条回复（隐藏的也算：隐藏不碰记忆，见文件头「隐藏楼层」）。
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
// 什么时候合并（nextMergeGroup）：只看已折叠（切点之前）的回复（隐藏的也算），跳过已经在某一段里（含待换上）的，从最老的开始，
//   连续攒够 x 行（写成「-」的不算行数、但算成员）就是一组；中间隔着一段的不连起来（一段作废后中间空出来、不够 x 行的就留着按行发）。
//   只做一层：合并出来的段不再被二次合并（多段按时间顺序排在记忆块里，通常就是最前面那几行）。这是有意的，以后要做多层再说。
//   改小 / 改大 / 关掉 mergeEvery：已有的段不动（已经合并的保持，待换上的照常换上），只影响之后的合并。
//
// 作废（mergedSegments 读出段，dissolve 拆掉）：拆掉已换上的段 = 删 memoryMerged、删成员的 memoryIn，成员都没有摘要了，交给 ensureMemories 逐轮重压；
//   拆掉待换上的段 = 只删 memoryMerged（成员的行原本就在）。入口：
//   - invalidateTurnAt（换候选 / 重新生成后由调用方调）：作废的那条回复在哪一段里，就拆那一段；
//   - 手动编辑、前端卡 / 脚本改原文（markTurnEdited）：【不拆】，只打「原文改过」（见文件头）；
//   - 隐藏 / 取消隐藏：【不拆】（隐藏不碰记忆，见文件头「隐藏楼层」）；
//   - invalidateAfterDelete（前端卡单删）：删掉的楼落在某一段的取材范围里（从这一段前面最近的非用户楼起到锚），拆那一段；
//   - invalidateBeforeTruncate（「删这一楼及之后」）：锚在被删范围里的段（被切进了覆盖范围）拆掉；
//   - 「记忆」页的「重压」、把段的文字清空：dissolveMerged。
//   读档时（normalizeMerged，state.js applyCardChat）和 ensureMemories 开始时：形状不对的段、数不出 count 条成员的段、
//   成员状态对不上的段删掉；不属于任何合法段的 memoryIn（孤儿标记）删掉——被清掉标记的轮没有摘要，回到待压缩。坏数据不会让页面打不开。
//   最后清掉孤儿的「原文改过」（memoryStale 挂在没压好的楼上，见文件头）。
//   按旧规矩（成员跳过隐藏的回复）存下的已换上的段先「升级」再判断，见 normalizeMerged 上面的「旧数据」。

/** 这一楼是不是隐藏楼层（只认 true：默认不写这个字段） */
export const isHidden = m => m?.hidden === true;

/**
 * 第 r 楼（一条回复）这一轮的输入：紧挨在它前面的那串用户输入的楼层号（旧 → 新），碰到别的楼（回复 / 旁白）就停。
 * 不看隐藏标记（隐藏不碰记忆，见文件头「隐藏楼层」）。和 ui/memory.js summarizeTurn 的取材完全一致（它就调这个）。
 */
export function turnInputs(chat, r) {
    const out = [];
    for (let j = r - 1; j >= 0; j--) {
        if (chat[j]?.role !== 'user') break;
        out.unshift(j);
    }
    return out;
}

/** 第 r 条回复这一轮是不是「整轮隐藏」：回复和它这一轮的输入全都隐藏了（规则见文件头「隐藏楼层」） */
export function turnFullyHidden(chat, r) {
    return isHidden(chat[r]) && turnInputs(chat, r).every(j => isHidden(chat[j]));
}

/**
 * 第 r 楼是不是一条「待压缩」的回复：没有摘要、没有失败记录、没被合并段覆盖、不是整轮隐藏。
 * ui/memory.js 的压缩队列按它挑下一条、「记忆」页按它数「待压缩 N」。（正在流式输出的最后一楼由调用方另外排除）
 */
export function turnPending(chat, r) {
    const m = chat[r];
    return m?.role === 'assistant' && !m.memory && !m.memoryError && !coveredByMerge(m) && !turnFullyHidden(chat, r);
}

/**
 * 把一批楼设成隐藏 / 取消隐藏（原地改 chat）。只改标记，【不碰记忆】（文件头「隐藏楼层」）。
 * 对应酒馆 scripts/chats.js hideChatMessageRange：逐楼 message.is_system = hide。
 *   - 隐藏写 hidden = true；取消隐藏删掉这个字段（默认不写），并把 st.is_system 改成 false：
 *     导入的行原来是 is_system: true，不改的话导出时会被当成「老存档」原样写回 true（见 chatfile.js 文件头）。
 * @param {object[]} chat
 * @param {Iterable<number>} indexes
 * @param {boolean} hide
 * @returns {{changed: number[]}}  changed：状态真的变了的楼
 */
export function setHidden(chat, indexes, hide) {
    const changed = [];
    const want = [...new Set([...indexes].map(Number))];
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
    return { changed };
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
 * 隐藏楼层（见文件头「隐藏楼层」小节）：上面四条都在完整记录上算（keep、batch 数的是所有楼，含隐藏的），
 * 隐藏标记只在一处起作用：第 2 条里「整轮隐藏」（turnFullyHidden）的回复算已处理（隐藏期间不压，它也没有一个字会发出去）。
 * 摘要行不看隐藏标记：隐藏的回复有摘要就照发。切点之后的隐藏楼由调用方（ui/pipeline.js）去掉，不发原文。
 * 没有隐藏楼层时和以前逐字相同。
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
    const segs = hasMergeFields(chat) ? mergedSegments(chat).segs : [];
    const segOf = new Map();   // 楼层号 → 它所在的段
    for (const s of segs) for (const k of s.members) segOf.set(k, s);
    const done = i => Boolean(chat[i].memory) || segOf.get(i)?.pending === false || turnFullyHidden(chat, i);
    let cut = Math.max(0, chat.length - Math.max(0, Number(memory.keep) || 0));
    const firstMissing = chat.findIndex((m, i) => m.role === 'assistant' && !done(i));
    if (firstMissing >= 0) cut = Math.min(cut, firstMissing);
    const batch = batchSize(memory);
    cut = Math.floor(cut / batch) * batch;
    const toTurnEnd = () => { while (cut > 0 && chat[cut - 1].role !== 'assistant') cut--; };
    toTurnEnd();
    if (segs.length) {
        // 已换上的段被切点劈开（第一条成员在切点前、锚在切点后）：切点退到这一段开头之前。从新到旧看，切点只会往前退
        for (let k = segs.length - 1; k >= 0 && cut > 0; k--) {
            const s = segs[k];
            if (s.pending) continue;
            const last = cut - 1;
            if (s.anchor <= last) break;              // 这一段整段在切点前：更早的段也一样
            if (s.members[0] > last) continue;        // 整段在切点后：照发原文，和切点无关
            cut = segmentStart(chat, s);
            toTurnEnd();
        }
    }
    const rows = [];
    for (let i = 0; i < cut; i++) {
        const m = chat[i];
        if (m.role !== 'assistant') continue;
        const s = segOf.get(i);
        if (s && segmentInUse(s, cut)) {
            if (i === s.anchor) rows.push({ index: s.anchor, text: s.text, merged: { from: segmentStart(chat, s), to: s.anchor, count: s.members.length } });
            continue;
        }
        // 没有摘要的只可能是整轮隐藏的那种（它算已处理，见上面第 2 条）：什么都不发
        if (typeof m.memory === 'string' && m.memory && m.memory !== MEMORY_SKIP) rows.push({ index: i, text: m.memory });
    }
    return { cut, rows };
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
        if (m.role !== 'assistant' || !segShape(mm) || claimed.has(a)) { bad.push(a); continue; }
        const pending = mm.wait !== undefined;
        const members = [];
        let ok = true;
        for (let k = a; k >= 0 && members.length < mm.count; k--) {
            const x = chat[k];
            if (x?.role !== 'assistant') continue;
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

/** 一段的范围从哪一楼起：第一条成员那一轮的第一条输入（没有输入就是它自己） */
export function segmentStart(chat, seg) {
    const m0 = seg.members[0];
    return turnInputs(chat, m0)[0] ?? m0;
}

/** 这一段现在用不用（cutFloor = 完整记录里的切点）：已换上的整段在切点前就用；待换上的还要等切点比写下时再往后挪 */
const segmentInUse = (s, cutFloor) => s.anchor < cutFloor && (!s.pending || cutFloor - (s.anchor + 1) > s.wait);

// ───── 旧数据（按 2026-11-23 之前的规矩存下的合并段）怎么读进来 ─────
// 旧规矩里段的成员是从锚往前数 count 条【可见的】回复，隐藏的回复夹在段里但不是成员（还带着它自己的 memory，或者没有）。
// 新规矩按所有回复数，这样的旧段就数不对了。不能因为规则变了就在打开存档时把它整段拆掉（成员的摘要早删了，拆掉 = 那几轮全部重压）：
//   - 已换上的旧段：要是按旧数法（跳过隐藏的回复、锚不隐藏）数得齐、成员状态也对，就把夹在段里的隐藏回复「收进」这一段——
//     删掉它自己的 memory / memoryError、打上 memoryIn、count 加上收进的条数（upgradeLegacyCommitted）。
//     发出去的记忆块逐字不变：旧规矩下隐藏回复的摘要本来就不进记忆块，段的那一行照旧。代价：那几条隐藏回复的旧摘要不留了
//     （本来就没在发）；以后取消隐藏它们，它们也算被这一段覆盖（段的文字里没有它们）。要它们重新单独压，在「记忆」页点这一段的「重压」。
//   - 待换上的旧段：按新数法数得齐就照新数法用（已知局限：段里夹着「带摘要的隐藏回复」时，新数法会把它算成员、把最早那条成员算到段外，
//     换上后段的文字和覆盖的轮对不上一条；这种段只在合并刚算好、还没换上的那几轮里存在，这个功能又是 2026-11-23 才有的，不另做标记区分）；
//     数不齐就照常当坏段删掉（只删 memoryMerged，成员的行原本就在，之后重新合并一次）。
//   - 隐藏回复带着的摘要（旧规矩下不发）：现在照常发，不改数据。按旧规矩取材（跳过了隐藏楼）压的摘要：不重压。
//   - 旧规矩下被隐藏作废、还没重压的轮：没有摘要，照新规矩（turnPending）该压就压。
// 只有新数法判成坏段时才走上面的旧数法，所以按新规矩存下的数据（任何隐藏状态下）都不会被它改动。

/**
 * 第 a 楼的段按新数法是坏段时，试着按旧数法（跳过隐藏的回复）把它当成已换上的旧段升级。成功就原地改 chat 并返回 true。
 */
function upgradeLegacyCommitted(chat, a) {
    const mm = chat[a]?.memoryMerged;
    if (chat[a]?.role !== 'assistant' || isHidden(chat[a]) || !segShape(mm) || mm.wait !== undefined) return false;
    const members = [];
    for (let k = a; k >= 0 && members.length < mm.count; k--) {
        const x = chat[k];
        if (x?.role !== 'assistant' || isHidden(x)) continue;
        if (k !== a && x.memoryMerged !== undefined) return false;
        if (x.memory !== undefined || (k === a ? x.memoryIn !== undefined : x.memoryIn !== true)) return false;
        members.unshift(k);
    }
    if (members.length !== mm.count) return false;
    const absorb = [];
    for (let k = members[0] + 1; k < a; k++) {
        const x = chat[k];
        if (x?.role !== 'assistant' || !isHidden(x)) continue;
        if (x.memoryMerged !== undefined) return false;
        absorb.push(k);
    }
    if (!absorb.length) return false;   // 没有夹着隐藏回复：不是旧数法造成的，照常当坏段
    for (const k of absorb) { delete chat[k].memory; delete chat[k].memoryError; chat[k].memoryIn = true; }
    chat[a].memoryMerged = { ...mm, count: mm.count + absorb.length };
    return true;
}

/**
 * 读档 / 兜底的规范化（原地改 chat）：删掉不合法的段（memoryMerged）和孤儿标记（memoryIn）。
 * 被删掉标记、又没有自己摘要的轮回到待压缩（ensureMemories 会重压）；待换上的段被删，成员的行原本就在，不受影响。
 * 按旧规矩存下的已换上的段先升级（见上面「旧数据」），升级不了的才删。
 * @returns {boolean} 改没改
 */
export function normalizeMerged(chat) {
    if (!Array.isArray(chat)) return false;
    // 合并段先清（清掉坏段会让一些成员变回「没压好」），再清孤儿的「原文改过」
    const merged = hasMergeFields(chat) ? normalizeSegments(chat) : false;
    return normalizeStale(chat) || merged;
}

/** normalizeMerged 的合并段那一半 */
function normalizeSegments(chat) {
    let changed = false;
    // 删掉一段坏的之后，别的段的判断不受影响（每段只看自己的成员）；保险起见做到不再变化为止
    for (let round = 0; round < 5; round++) {
        let { bad, orphans } = mergedSegments(chat);
        if (!bad.length && !orphans.length) break;
        // 旧数据：升级了就重新数一遍（被收进段的隐藏回复、原来的成员都不再是孤儿）
        if (bad.filter(a => upgradeLegacyCommitted(chat, a)).length) {   // filter 不短路：每一段都试
            changed = true;
            ({ bad, orphans } = mergedSegments(chat));
        }
        for (const a of bad) delete chat[a].memoryMerged;
        for (const i of orphans) delete chat[i].memoryIn;
        changed ||= bad.length > 0 || orphans.length > 0;
    }
    return changed;
}

/**
 * 「原文改过」的读档清洗：值不是 true，或者挂在一条没压好的楼上（turnHasSummary 为假：没有摘要、也没被已换上的段覆盖）的，删掉。
 * 要在合并段清洗之后做（coveredByMerge 只看标记，靠前面那一步保证结构对）。@returns {boolean} 改没改
 */
function normalizeStale(chat) {
    let changed = false;
    for (const m of chat) {
        if (m?.memoryStale === undefined) continue;
        if (m.memoryStale === true && turnHasSummary(m)) continue;
        delete m.memoryStale;
        changed = true;
    }
    return changed;
}

/**
 * 拆掉一段（seg 来自 mergedSegments）。已换上的：成员的覆盖标记和「原文改过」一起删，成员没有摘要了，交给 ensureMemories 逐轮重压。
 * 待换上的：只删段，成员自己的行（和行上的「原文改过」）原本就在、照旧有效
 */
function dissolve(chat, seg) {
    delete chat[seg.anchor].memoryMerged;
    if (!seg.pending) for (const k of seg.members) { delete chat[k].memoryIn; delete chat[k].memoryStale; }
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

/** 一段的「取材范围」起点：第一条成员前面最近的非用户楼（删掉它会让第一条成员的输入变）；没有就是 0 */
function touchStart(chat, seg) {
    for (let j = seg.members[0] - 1; j >= 0; j--) {
        if (chat[j]?.role === 'user') continue;
        return j;
    }
    return 0;
}

/** floors 里有落在某一段取材范围 [touchStart, 锚] 里的，就拆那一段（调用方在删楼之前调）。@returns {number[]} 被拆的已换上的段的成员 */
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
    return mergeGroups(chat, memory, every, 1)[0] ?? null;
}

/**
 * 现在能合并的组（互不重叠，旧 → 新），最多 limit 组。nextMergeGroup 取第一组；「记忆」页拿组数显示「待合并 N」。
 * 后面的组只是「照现在的样子数」：前一组合并完，后面的照旧能合并（合并只改锚上的字段，不改哪些楼已折叠）
 */
export function mergeGroups(chat, memory, every, limit = Infinity) {
    const out = [];
    if (!memory?.enabled || !(every >= 1)) return out;
    const { cut } = foldCut(chat, memory);
    const inSeg = new Set();
    if (hasMergeFields(chat)) for (const s of mergedSegments(chat).segs) for (const k of s.members) inSeg.add(k);
    let run = [], rows = 0;
    for (let i = 0; i < cut && out.length < limit; i++) {
        const m = chat[i];
        if (m?.role !== 'assistant') continue;
        if (inSeg.has(i) || typeof m.memory !== 'string' || !m.memory) { run = []; rows = 0; continue; }
        run.push(i);
        if (m.memory !== MEMORY_SKIP) rows++;
        if (rows >= every) { out.push(run); run = []; rows = 0; }
    }
    return out;
}

/**
 * 一组成员的「取材指纹」：合并请求发出去时记下，结果回来时核对（成员的摘要行、每一轮由哪几楼组成、范围里有哪些回复都没变才写）。
 * 合并的输入只有成员的摘要行（不读原文），所以【不看原文】（2026-11-29 起）：合并请求在路上时手动改了某一楼，结果照样写下，
 * 那一轮带着「原文改过」的标记，段跟着显示出来——和「编辑不作废合并段」一致，也不会因为一次编辑把这一组合并重发一遍。
 * 换候选 / 重新生成会删掉那一轮的摘要（摘要行变了），删楼会改变楼层结构，这两种照样认得出来。不看隐藏标记、不看「原文改过」
 */
export function mergeFingerprint(chat, members) {
    if (!Array.isArray(chat) || !members.length) return '';
    const lo = members[0], hi = members.at(-1);
    const replies = [];
    for (let k = lo; k <= hi && k < chat.length; k++) if (chat[k]?.role === 'assistant') replies.push(k);
    return JSON.stringify([replies, members.map(k => {
        const m = chat[k];
        return m ? [m.role, m.memory ?? null, turnInputs(chat, k)] : null;
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

/** 把一条回复上的摘要（和压缩失败的记录、「原文改过」的标记）去掉，交给 ensureMemories 重压。返回有没有真的去掉什么 */
function dropMemory(msg) {
    if (!msg || (msg.memory === undefined && msg.memoryError === undefined && msg.memoryStale === undefined)) return false;
    delete msg.memory;
    delete msg.memoryError;
    delete msg.memoryStale;   // 摘要没了，「摘要过时」也就无从说起
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

/** 这一楼带着「原文改过」的标记（只认 true：默认不写这个字段） */
export const isMemoryStale = m => m?.memoryStale === true;

/**
 * 这条回复这一轮「已经压好了」：有自己的摘要（含写成「-」的），或者被一段已换上的合并段覆盖（锚也算）。
 * 「原文改过」只打在这样的楼上（文件头「原文改过」）。覆盖只看标记，结构对不对由 normalizeMerged 保证。
 */
export const turnHasSummary = m => m?.role === 'assistant'
    && ((typeof m.memory === 'string' && m.memory !== '') || coveredByMerge(m));

/**
 * 第 i 楼的原文被手动改了（编辑、拼装页就地改、写卡页改第 0 楼、前端卡 / 脚本的 setChatMessages）：
 * 【不作废、不发请求】，这一轮已经压好的话在它的回复上打「原文改过」（memoryStale = true）。原地改 chat。
 * 规则见文件头「原文改过」：只打在 i 所在那一轮的回复上（i 是回复就是它自己；i 是这一轮的输入就是紧跟着的回复）；
 * 改的是旁白、或这一轮还没有回复、或这一轮还没压好：什么都不做。不碰合并段（段原样留着，界面按成员汇总显示）。
 * 调用方只在原文真的变了时调（没改内容就点了保存，不该打标记）。
 * @returns {number} 打了标记的回复的下标；没打返回 -1
 */
export function markTurnEdited(chat, i) {
    if (!Array.isArray(chat)) return -1;
    const r = turnReplyIndex(chat, i);
    if (r < 0) return -1;
    if (r !== i && !turnInputs(chat, r).includes(i)) return -1;   // 旁白（或 i 和回复之间隔着旁白）：不在这一轮的取材里
    if (!turnHasSummary(chat[r])) return -1;
    chat[r].memoryStale = true;
    return r;
}

/** 一段合并段（来自 mergedSegments）里有没有成员带「原文改过」：「记忆」页据此给整段打标记 */
export const segmentStale = (chat, seg) => seg.members.some(k => isMemoryStale(chat[k]));

/** 用户手动更新了这一段的文字（「记忆」页改段文字、不清空）：成员上的「原文改过」都清掉。@returns {boolean} 清没清 */
export function clearSegmentStale(chat, seg) {
    let n = 0;
    for (const k of seg.members) if (chat[k]?.memoryStale !== undefined) { delete chat[k].memoryStale; n++; }
    return n > 0;
}

/**
 * 第 r 条回复这一轮的回复整个换了（换候选 / 重新生成：chat.js swipedTurn，以及 app.js 的手动模式）：这一轮的摘要作废。原地改 chat。
 * 它在合并段里就拆那一段（文件头「合并段」）。【手动编辑不走这里】（走 markTurnEdited，2026-11-29 改的规则）。
 * 取材不看隐藏标记（文件头「隐藏楼层」），所以这一楼属于哪一轮只看结构（turnReplyIndex）。
 * @returns {number} 被作废的那条回复的下标；没有返回 -1
 */
export function invalidateTurnAt(chat, i) {
    const r = turnReplyIndex(chat, i);
    if (r >= 0) dropTurn(chat, r);
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
    }
    for (const k of hit) dropTurn(chat, k);
    return [...hit].sort((a, b) => a - b);
}
