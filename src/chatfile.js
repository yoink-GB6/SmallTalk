// 酒馆聊天文件（.jsonl）↔ 我们的存档。纯函数，不碰 DOM / IndexedDB，Node 里可测。
//
// 酒馆怎么读写这个文件（1.19）：
//   - 写：src/endpoints/chats.js trySaveChat —— 整个 chat 数组每项 JSON.stringify 一行，用 '\n' 连接（末尾没有换行）。
//     数组第 0 项是「头」：public/script.js saveChat 里拼的 { chat_metadata, user_name: 'unused', character_name: 'unused' }。
//   - 读：src/endpoints/chats.js getChatData —— 按 '\n' 切行，每行 tryParse，解析失败的行直接丢掉；
//     然后 public/script.js getChat 里 data.shift() 把【第一条解析成功的】当成头，其余全是消息。
//     所以导出时头必须写在第一行，否则酒馆会把第一条消息当头吞掉。
//   - 导入：src/endpoints/chats.js /import 里 jsonl 分支要求头上有 user_name / name / chat_metadata 三者之一。
//
// 角色怎么对应（对照源码定下来的规则）：
//   - extra.type === 'narrator' → system（旁白）。酒馆 /sys 命令就是这么标的（scripts/slash-commands.js sendNarratorMessage），
//     发给模型时也只认这个：scripts/openai.js「if (chat[j].extra?.type === system_message_types.NARRATOR) role = 'system'」。
//   - 否则 is_user → user，其余 → assistant。
//   - is_system 在酒馆里【不是】「系统 / 旁白」，而是「不进 prompt」：
//     script.js Generate 里 coreChat = chat.filter(x => !x.is_system || 工具调用)（~L4496）；scripts/chats.js hideChatMessageRange
//     「隐藏楼层」就是把 is_system 设成 true / false（消息上的眼睛按钮、/hide /unhide 都走它），用户消息也可以被隐藏。
//     旁白（/sys，slash-commands.js sendNarratorMessage）的 is_system 是 false（只有「整条只有 bias」时才是 true），照常发送；
//     /comment（sendCommentMessage）和酒馆自己的系统提示（system-messages.js）是 is_system: true 的「天生隐藏」消息，
//     界面上同样带幽灵图标（style.css .mes[is_system="true"] .mes_ghost），也能被取消隐藏后发出去。
//     所以 is_system 只表示「隐藏」，不参与角色判定：
//       导入：is_system 为真值（酒馆按 !x.is_system 判断，1 / "true" 也算）→ ChatMessage.hidden = true；原值照旧留在 st 里。
//       导出：hidden 和 st 里的原值一致（都真 / 都假）就不动，保证没动过的行往返不变；不一致才写成 true / false。
//       我们自己的消息（没有 st）一律写 is_system: Boolean(hidden)。
//     「取消隐藏」除了去掉 hidden，还要把 st.is_system 改成 false（memory-fold.js setHidden）——否则导出时没法区分
//     「用户在这里取消了隐藏」和下面说的老存档。
//     老存档：这个功能以前，导入的隐藏楼层只把 is_system: true 留在 st 里、没有 hidden，在 smalltalk 里照常显示和发送。
//     从这一版起「st.is_system 为真、却没有 hidden」只可能是这种老存档（取消隐藏会把 st.is_system 改成 false），
//     所以打开这个存档时自动按隐藏处理（用户定的：不问，直接认成隐藏，提示一句）：
//       哪几楼 = legacyHiddenFloors（本文件，纯函数）；做在 ui/archive.js adoptLegacyHidden（存档装进 state 之后，只在有写权限时），
//       走 memory-fold.js setHidden（只改标记，不碰记忆：已有的摘要照旧留着），然后正常保存。做完这些楼有了 hidden，下次打开不会再触发。
//     解析（parseChatFile）和导出本身不迁移：导出时 hidden 和 st 一致就原样写回（见下面 messageToLine）。
//
// 作者注释（酒馆 authors-note.js metadata_keys，规则见 src/author-note.js 文件头）：
//   酒馆存在头的 chat_metadata 里：note_prompt / note_interval / note_depth / note_position / note_role。酒馆打开聊天时会把缺的键补成
//   默认值，所以酒馆存过的文件里通常五个都有（空正文也写）。
//   导入：读出来变成 ChatRecord.authorNote（author-note.js noteFromMetadata：坏值回默认，全是默认 = null，不写这个字段）；
//         五个键的原值【不从 stHeader 里删】——导出时拿它们判断要不要改写，保证没动过的文件往返不变。
//   导出：author-note.js writeNoteMetadata：有作者注释就五个键都写（原值规范化后相同的保留原值）；没有作者注释时，原文件里没有的键不补，
//         有的、而且不等于默认值的（导入后在这边清空了）改写成默认值。
//   角色卡专属注释、默认作者注释不在聊天文件里（在酒馆的 settings.json），这里碰不到。chat_metadata 里别的键（world_info、
//   chat_id_hash、插件的数据……）照旧原样留在 stHeader 里往返。
//
// swipe（同一楼的多个候选回复）：酒馆显示 / 发送的永远是 mes，swipes[swipe_id] 是它的副本，切换时用 swipes[新 id] 覆盖 mes。
//   - 行.swipes / swipe_id ↔ ChatMessage.swipes / swipeId（形状合法时才拆出来，不合法的留在 st 里原样往返）
//   - 行.swipe_info 留在 st 里：每个候选各自的 send_date / gen_started / gen_finished / extra。切换候选时照酒馆
//     syncMesToSwipe / syncSwipeToMes 换进换出（见本文件末尾的 swipe 小节）。
//   - content 是「当前候选」的唯一真相：别处（编辑、前端卡的 setChatMessage……）只改 content 也没关系，
//     任何 swipe 操作之前、以及导出时，都先把 content 写回 swipes[swipeId]（和酒馆 syncMesToSwipe 同一个意思）。
//     没编辑过的消息两者本来就相等，所以对未改动的文件是无操作。

import { noteFromMetadata, writeNoteMetadata } from './author-note.js';

const HEADER_KEYS = ['chat_metadata', 'user_name', 'character_name', 'create_date'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 看起来像头：是对象、没有 mes、带着头特有的键之一 */
const looksLikeHeader = o => isObj(o) && !('mes' in o) && HEADER_KEYS.some(k => k in o);

/** 酒馆旧版的 create_date / humanizedDateTime 形如 "2023-5-12 @21h 32m 29s 224ms" 或 "2026-10-16@01h08m05s041ms" */
function parseStDate(s) {
    if (typeof s === 'number') {
        // 超出 Date 范围的数字（比如 1e20）toISOString 会抛错：当作认不出的日期，原值留在 st 里
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof s !== 'string' || !s) return null;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?/);
    const d = m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? 0)) : new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 和酒馆 RossAscends-mods.js humanizedDateTime 同样的格式：2026-11-20@15h55m53s924ms（本地时间） */
export function humanizedDateTime(date) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
        + `@${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}s${p(date.getMilliseconds(), 3)}ms`;
}

/** 出现最多的名字（头里的名字现在都是 'unused'，只能从消息里看是谁在说话） */
function mostCommon(names) {
    const n = new Map();
    for (const x of names) if (x) n.set(x, (n.get(x) ?? 0) + 1);
    let best = '', c = 0;
    for (const [k, v] of n) if (v > c) { best = k; c = v; }
    return best;
}

/** 一行消息 → ChatMessage。我们认识的字段拆出来，其余整行原样进 st。 */
function lineToMessage(line) {
    const st = structuredClone(line);
    const extra = isObj(st.extra) ? st.extra : null;
    const role = extra?.type === 'narrator' ? 'system' : st.is_user ? 'user' : 'assistant';
    const msg = { role, name: typeof st.name === 'string' ? st.name : '', content: typeof st.mes === 'string' ? st.mes : '' };
    // 隐藏楼层：is_system 真值（见文件头）。原值留在 st 里不删，导出时据此判断要不要改写
    if (st.is_system) msg.hidden = true;
    // name / mes 只有是字符串时才算「认识」；别的类型（比如 mes 是 null）留在 st 里，导出时原样放回
    if (typeof st.name === 'string') delete st.name;
    if (typeof st.mes === 'string') delete st.mes;
    // send_date：酒馆现在写 ISO 字符串；很老的文件可能是别的格式的字符串（原样当 sendDate）或数字（换算成 ISO，原值留在 st）
    if (typeof st.send_date === 'string') { msg.sendDate = st.send_date; delete st.send_date; }
    else if (typeof st.send_date === 'number') msg.sendDate = parseStDate(st.send_date) ?? undefined;
    if (msg.sendDate === undefined) delete msg.sendDate;
    // 我们自己的命名空间 extra.smalltalk：记忆摘要，以及记忆再压缩的合并段 / 覆盖标记（memory-fold.js 文件头「合并段」）。
    // 合并段和标记只看形状（对象 / true）就拆出来；成员数得对不对，打开存档时 normalizeMerged 再核对（对不上的清掉、那几轮重压）
    const ours = extra && isObj(extra.smalltalk) ? extra.smalltalk : null;
    if (ours) {
        if (typeof ours.memory === 'string') { msg.memory = ours.memory; delete ours.memory; }
        if (typeof ours.memoryError === 'string') { msg.memoryError = ours.memoryError; delete ours.memoryError; }
        if (isObj(ours.memoryMerged)) { msg.memoryMerged = ours.memoryMerged; delete ours.memoryMerged; }
        if (ours.memoryIn === true) { msg.memoryIn = true; delete ours.memoryIn; }
        // 「原文改过」（memory-fold.js 文件头）：跟着摘要往返，这样导出再导入后「记忆」页还能提醒这条摘要过时了。
        // 只认 true；别的值丢掉（不留在 st 里，免得导出时原样写回）。挂在没摘要的楼上的，打开存档时 normalizeMerged 清掉
        if (ours.memoryStale !== undefined) { if (ours.memoryStale === true) msg.memoryStale = true; delete ours.memoryStale; }
        if (!Object.keys(ours).length) delete extra.smalltalk;
    }
    // swipes / swipe_id：形状合法（字符串数组、swipe_id 是范围内的整数）才拆出来；否则原样留在 st 里，
    // 等用户真的去滑这一楼时再由 ensureSwipes 照酒馆的规矩修整（保证没动过的文件往返不变）
    if (Array.isArray(st.swipes) && st.swipes.length && st.swipes.every(s => typeof s === 'string')
        && Number.isInteger(st.swipe_id) && st.swipe_id >= 0 && st.swipe_id < st.swipes.length) {
        msg.swipes = st.swipes;
        msg.swipeId = st.swipe_id;
        delete st.swipes;
        delete st.swipe_id;
    }
    msg.st = st;
    return msg;
}

/**
 * @param {string} text  .jsonl 全文
 * @returns {{name: string, userName: string, characterName: string, createdAt: string|null, messages: object[],
 *            variables: Record<string, any>, stHeader: object, warnings: string[], hiddenCount: number}}
 *   hiddenCount：酒馆里被隐藏的楼数（导入后仍是隐藏的）
 */
export function parseChatFile(text) {
    const warnings = [];
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
    let header = null;
    const messages = [];
    let first = true;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw) continue;
        let obj;
        try { obj = JSON.parse(raw); } catch (e) {
            // 坏行不算「第一行」：酒馆读取时坏行直接被丢掉，然后把【第一条解析成功的】当成头（见文件开头）
            warnings.push(`第 ${i + 1} 行不是合法的 JSON，已跳过`);
            continue;
        }
        // 头只可能是第一条解析成功的行；后面再出现像头的对象也按坏行处理（酒馆里它会变成一条奇怪的消息）
        if (first && looksLikeHeader(obj)) { header = obj; first = false; continue; }
        first = false;
        if (!isObj(obj)) { warnings.push(`第 ${i + 1} 行不是一条消息（${Array.isArray(obj) ? '数组' : typeof obj}），已跳过`); continue; }
        if (looksLikeHeader(obj)) { warnings.push(`第 ${i + 1} 行像是文件头却不在第一行，已跳过`); continue; }
        messages.push(lineToMessage(obj));
    }
    if (!header) warnings.push('文件没有头（第一行的 chat_metadata），按全部是消息处理');

    const stHeader = header ? structuredClone(header) : {};
    let variables = {};
    if (isObj(stHeader.chat_metadata) && 'variables' in stHeader.chat_metadata) {
        if (isObj(stHeader.chat_metadata.variables)) {
            variables = stHeader.chat_metadata.variables;
            delete stHeader.chat_metadata.variables;
        } else warnings.push('chat_metadata.variables 不是对象，原样保留（导出时写回），不当作变量');
    }
    const real = v => (typeof v === 'string' && v && v !== 'unused' ? v : '');
    const userName = real(header?.user_name) || mostCommon(messages.filter(m => m.role === 'user').map(m => m.name));
    const characterName = real(header?.character_name) || mostCommon(messages.filter(m => m.role === 'assistant').map(m => m.name));
    const createdAt = parseStDate(header?.create_date) ?? parseStDate(messages[0]?.sendDate) ?? null;
    const hiddenCount = messages.filter(m => m.hidden === true).length;
    const name = characterName && typeof header?.create_date === 'string' ? `${characterName} - ${header.create_date}` : '';
    // 作者注释（见文件头「作者注释」）：读出来，note_* 原值不从 stHeader 里删
    const authorNote = noteFromMetadata(stHeader.chat_metadata);
    return { name, userName, characterName, createdAt, messages, variables, stHeader, warnings, hiddenCount, authorNote };
}

/**
 * 老存档里「酒馆里隐藏、这里还没认成隐藏」的楼（见文件头「老存档」）：st.is_system 为真值（同导入时的判断：酒馆按 !x.is_system，
 * 1 / "true" 也算）、但没有 hidden。旁白（extra.type 'narrator'、is_system false）不在其中；我们自己的消息没有 st，也不在其中。
 * @param {object[]} messages
 * @returns {number[]} 楼层号（升序）
 */
export function legacyHiddenFloors(messages) {
    const out = [];
    if (!Array.isArray(messages)) return out;
    messages.forEach((m, i) => { if (isObj(m) && m.hidden !== true && isObj(m.st) && m.st.is_system) out.push(i); });
    return out;
}

/** ChatMessage → 一行对象 */
function messageToLine(msg, sendDateFallback) {
    // 从酒馆导入的消息（有 st）：原来没有的字段尽量不补，保证往返后每行 JSON 语义不变；
    // 我们自己产生的消息（没有 st）：把酒馆读取时用到的字段都写全。
    const imported = isObj(msg.st);
    const line = imported ? structuredClone(msg.st) : {};
    const isUser = msg.role === 'user';
    // name / mes 原来不是字符串时 parse 把原值留在了 st 里；我们这边也没填内容，就保持原值
    if (!(imported && 'name' in line && !msg.name)) line.name = msg.name ?? '';
    // is_user：原来有且含义一致就不动（保持原值，比如 0/1）；缺了又是 assistant 时也不补（酒馆按假值处理）。
    // 旁白（extra.type=narrator）的角色不看 is_user，所以原来的 is_user 不管是什么都原样保留
    if (msg.role === 'system' && imported) { /* 不动 */ }
    else if ('is_user' in line ? Boolean(line.is_user) !== isUser : (isUser || !imported)) line.is_user = isUser;
    // is_system 是「隐藏」（见文件头）：我们自己的消息照 hidden 写；导入的只在和 hidden 不一致时改写，
    // 一致时（包括缺省 = 不隐藏、原值是 1 之类的真值）原样保留
    const hidden = msg.hidden === true;
    if (!imported) line.is_system = hidden;
    else if (hidden && !line.is_system) line.is_system = true;
    // 不隐藏、st 里却是真值：只可能是「这个功能以前导入的老存档」（取消隐藏时 setHidden 已经把 st.is_system 改成了 false），
    // 而且是还没在有写权限的标签页里打开过的（打开时会自动认成隐藏，见文件头）。导出这里不迁移，原样写回 true
    if (msg.sendDate !== undefined) {
        // 数字形式的老日期：st 里还留着原值，没改过就原样写回
        if (!(typeof line.send_date === 'number' && parseStDate(line.send_date) === msg.sendDate)) line.send_date = msg.sendDate;
    } else if (!imported) line.send_date = sendDateFallback;
    if (!(imported && 'mes' in line && !msg.content)) line.mes = msg.content ?? '';
    const OURS = ['memory', 'memoryError', 'memoryMerged', 'memoryIn', 'memoryStale'];   // 挂在 extra.smalltalk 下的（见 lineToMessage）
    const hasOurs = OURS.some(k => msg[k] !== undefined);
    const needExtra = !imported || msg.role === 'system' || hasOurs;
    const extra = isObj(line.extra) ? line.extra : needExtra ? (line.extra = {}) : {};
    if (msg.role === 'system') extra.type = 'narrator';
    else if (extra.type === 'narrator') delete extra.type;   // 角色被改掉了，旁白标记也要去掉
    if (hasOurs) {
        const ours = isObj(extra.smalltalk) ? extra.smalltalk : (extra.smalltalk = {});
        for (const k of OURS) if (msg[k] !== undefined) ours[k] = msg[k];
    }
    if (Array.isArray(msg.swipes) && msg.swipes.length) {
        // 拆出来的（或我们自己生成的）候选：写回酒馆的三个字段
        line.swipes = msg.swipes.map(s => (typeof s === 'string' ? s : ''));
        line.swipe_id = clampId(msg.swipeId, line.swipes.length);
        if (Array.isArray(line.swipe_info)) {
            // 酒馆要求 swipe_info 与 swipes 等长（ensureSwipes 会回填缺的）。只补不删：原文件里多出来的不碰
            for (let k = 0; k < line.swipes.length; k++) if (!isObj(line.swipe_info[k])) line.swipe_info[k] = backfillInfo(line);
        } else if (!imported) {
            // 我们自己生成的消息不存 swipe_info（没有 st 可放），导出时按酒馆 ensureSwipes 的回填方式补齐
            line.swipe_info = line.swipes.map(() => backfillInfo(line));
        }
        // 导入的、原来就没有 swipe_info 的（很老的酒馆文件）：不补，保持往返不变；酒馆读到时自己会回填
    }
    if (typeof line.mes === 'string' && Array.isArray(line.swipes) && Number.isInteger(line.swipe_id) && line.swipe_id >= 0 && line.swipe_id < line.swipes.length) {
        line.swipes[line.swipe_id] = line.mes;
    }
    // 楼层变量（酒馆助手的 message 作用域，每个候选一份的数组；types.js ChatMessage.variables）：写过才有，写回酒馆的 variables 字段。
    // 没写过的导入消息，原值还在 st.variables 里，上面已经原样带上了
    if (Array.isArray(msg.variables)) line.variables = structuredClone(msg.variables);
    return line;
}

/**
 * @param {{name?: string, createdAt?: string, messages: object[], variables?: object, stHeader?: object}} chat  ChatRecord
 * @param {{userName: string, characterName: string}} names
 * @returns {string}  .jsonl 全文，'\n' 换行，末尾一个换行
 */
export function serializeChatFile(chat, names) {
    const header = isObj(chat.stHeader) ? structuredClone(chat.stHeader) : {};
    // 头的必备字段：酒馆导入要求 user_name / name / chat_metadata 之一；读取时只用 chat_metadata
    if (!('user_name' in header)) header.user_name = names?.userName || 'User';
    if (!('character_name' in header)) header.character_name = names?.characterName || 'Assistant';
    if (!('create_date' in header) && !isObj(chat.stHeader)) {
        const d = new Date(chat.createdAt ?? Date.now());
        header.create_date = humanizedDateTime(Number.isNaN(d.getTime()) ? new Date() : d);
    }
    if (!isObj(header.chat_metadata)) header.chat_metadata = {};
    // 原文件里 variables 不是对象（parse 时原样留在 stHeader 里）：我们这边也没有变量，就原样写回；
    // 有了变量才用我们的（这时只能二选一）
    const keepOdd = 'variables' in header.chat_metadata && !isObj(header.chat_metadata.variables) && !Object.keys(chat.variables ?? {}).length;
    if (!keepOdd) header.chat_metadata.variables = structuredClone(chat.variables ?? {});
    // 作者注释：只改和 chat.authorNote 对不上的 note_* 键（没动过的文件往返不变；规则见 author-note.js writeNoteMetadata）
    writeNoteMetadata(header.chat_metadata, chat.authorNote);
    // 没有发送时间的消息（smalltalk 第一阶段的老消息）用存档的创建时间兜底，酒馆显示时间戳需要它
    const fallback = new Date(chat.createdAt ?? Date.now());
    const fallbackIso = Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString();
    const out = [JSON.stringify(header)];
    for (const msg of chat.messages ?? []) out.push(JSON.stringify(messageToLine(msg, fallbackIso)));
    return out.join('\n') + '\n';
}

// ───────────────────────────── swipe ─────────────────────────────
// 对照酒馆 1.19 public/script.js：
//   - saveReply（~6787 行）：每条 AI 回复一保存就带上 swipes=[mes]、swipe_id=0、swipe_info=[{send_date, gen_started, gen_finished, extra}]
//   - ensureSwipes（~6838）：缺 swipes / swipe_id / swipe_info 时回填；非字符串的候选改成 ''
//   - syncMesToSwipe（~6900）/ syncSwipeToMes（~6950）：切换前把 mes 和它的 send_date / gen_* / extra 存进当前格，
//     切换后从目标格整体取回来（extra 是「每个候选各一份」的，思维链、模型名等都在里面）
//   - swipe()（~9954）：向左到第一个时绕回最后一个；向右越过最后一个就用 Generate('swipe') 生成新候选
// 这里是这些规则的纯函数版本，界面在 src/ui/chat.js。
//
// 存储：ChatMessage.swipes / swipeId 放候选；导入消息的 swipe_info 继续放在 st 里（只有导入的消息有 st）。
// 我们自己生成的消息不存 swipe_info，导出时由 messageToLine 按 ensureSwipes 的方式补齐。

const clampId = (id, n) => (Number.isInteger(id) ? Math.min(Math.max(id, 0), Math.max(0, n - 1)) : 0);

/** 去掉值为 undefined 的键（和 JSON.stringify 的效果一致，免得存储里留一堆空键） */
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** 酒馆 ensureSwipes 里的 createSwipeInfo：时间沿用消息本身的，extra 为空 */
const backfillInfo = line => compact({ send_date: line.send_date, gen_started: line.gen_started, gen_finished: line.gen_finished, extra: {} });

/** 生成新候选时 extra 里要清掉的键：酒馆 swipe() 里的 clearMessageData + saveReply 对新回复重置的那几项。
 *  api / model 酒馆会改写成这次生成用的；我们没有酒馆那套名字，干脆去掉，免得显示成旧候选的模型。 */
const NEW_SWIPE_DROP = ['memory', 'display_text', 'media', 'inline_image', 'files', 'fileLength', 'generationType', 'negative',
    'title', 'append_title', 'reasoning', 'reasoning_duration', 'reasoning_signature', 'token_count', 'api', 'model'];

/**
 * 只读：这一楼的候选和当前位置，不改动消息。老存档里 swipes 还躺在 st 里的也认。
 * @returns {{swipes: string[], id: number} | null}  没有候选时 null（相当于只有一个：content 本身）
 */
export function readSwipes(msg) {
    if (Array.isArray(msg?.swipes) && msg.swipes.length) return { swipes: msg.swipes, id: clampId(msg.swipeId, msg.swipes.length) };
    const st = isObj(msg?.st) ? msg.st : null;
    if (st && Array.isArray(st.swipes) && st.swipes.length) return { swipes: st.swipes, id: clampId(st.swipe_id, st.swipes.length) };
    return null;
}

/**
 * 把 swipe 字段整理好（会改动 msg）：老存档从 st 里提升出来；没有就建 [content]；
 * 当前格写成 content（syncMesToSwipe）；导入的消息让 st.swipe_info 与 swipes 等长。
 */
export function ensureSwipes(msg) {
    const st = isObj(msg.st) ? msg.st : null;
    if (!Array.isArray(msg.swipes) || !msg.swipes.length) {
        if (st && Array.isArray(st.swipes) && st.swipes.length) {
            msg.swipes = st.swipes;
            msg.swipeId = st.swipe_id;
            delete st.swipes;
            delete st.swipe_id;
        } else {
            msg.swipes = [];
            msg.swipeId = 0;
        }
        if (!msg.swipes.length) msg.swipes.push(msg.content ?? '');
    }
    for (let k = 0; k < msg.swipes.length; k++) if (typeof msg.swipes[k] !== 'string') msg.swipes[k] = '';
    msg.swipeId = clampId(msg.swipeId, msg.swipes.length);
    msg.swipes[msg.swipeId] = msg.content ?? '';
    if (st) {
        if (!Array.isArray(st.swipe_info)) st.swipe_info = [];
        for (let k = 0; k < msg.swipes.length; k++) if (!isObj(st.swipe_info[k])) st.swipe_info[k] = backfillInfo({ ...st, send_date: msg.sendDate ?? st.send_date });
    }
    return msg;
}

/** 编辑 content 后调用：有候选数组时把当前格同步（酒馆 messageEditDone 里 mes.swipes[mes.swipe_id] = text） */
export function syncSwipeSlot(msg) {
    if (Array.isArray(msg.swipes) && msg.swipes.length) msg.swipes[clampId(msg.swipeId, msg.swipes.length)] = msg.content ?? '';
}

/** 当前这条消息的时间和 extra → 一格 swipe_info（syncMesToSwipe）。只对导入的消息（有 st）有意义 */
function infoFromMes(msg) {
    const st = msg.st;
    return compact({ send_date: msg.sendDate ?? st.send_date, gen_started: st.gen_started, gen_finished: st.gen_finished,
        extra: structuredClone(isObj(st.extra) ? st.extra : {}) });
}

/** 一格 swipe_info → 当前这条消息（syncSwipeToMes） */
function loadInfo(msg, info) {
    const st = msg.st;
    const sd = info?.send_date;
    if (typeof sd === 'string') { msg.sendDate = sd; delete st.send_date; }
    else {
        delete msg.sendDate;
        if (sd === undefined) delete st.send_date;
        else { st.send_date = sd; const iso = parseStDate(sd); if (iso) msg.sendDate = iso; }   // 老格式的数字时间：同 lineToMessage
    }
    for (const k of ['gen_started', 'gen_finished']) { if (info?.[k] === undefined) delete st[k]; else st[k] = info[k]; }
    st.extra = structuredClone(isObj(info?.extra) ? info.extra : {});
    // 酒馆同步 swipe_info 时会把整个 extra 复制进去，其中可能有我们以前导出的 extra.smalltalk（记忆摘要）。
    // 那是旧候选的摘要，不能跟着换回来（ChatMessage.memory 才是记忆的唯一出处）
    // 合并段 / 覆盖标记同理（它们属于「这一楼当时的那个候选」，换回来的旧候选上不能还挂着）
    if (isObj(st.extra.smalltalk)) {
        delete st.extra.smalltalk.memory;
        delete st.extra.smalltalk.memoryError;
        delete st.extra.smalltalk.memoryMerged;
        delete st.extra.smalltalk.memoryIn;
        delete st.extra.smalltalk.memoryStale;
        if (!Object.keys(st.extra.smalltalk).length) delete st.extra.smalltalk;
    }
}

/**
 * 按方向算目标位置（酒馆 swipe() 的规则）。
 * @param {-1|1} dir
 * @returns {number|'generate'}  'generate' = 已经在最后一个，向右要生成新候选
 */
export function swipeTarget(msg, dir) {
    const s = readSwipes(msg);
    const n = s ? s.swipes.length : 1, id = s ? s.id : 0;
    if (dir < 0) return id - 1 < 0 ? n - 1 : id - 1;   // 酒馆：第一个再往左绕回最后一个（只有一个时等于不动）
    return id + 1 >= n ? 'generate' : id + 1;
}

/**
 * 切到第 newId 个候选（会改动 msg）。外置记忆：这一楼的摘要是旧候选的，作废（由调用方触发重压）。
 * 这和酒馆自己的摘要插件一致：clearMessageData 也会删掉 extra.memory。
 * @returns {boolean} 有没有真的切换
 */
export function selectSwipe(msg, newId) {
    ensureSwipes(msg);
    if (!Number.isInteger(newId) || newId < 0 || newId >= msg.swipes.length || newId === msg.swipeId) return false;
    if (msg.st) msg.st.swipe_info[msg.swipeId] = infoFromMes(msg);
    msg.swipeId = newId;
    msg.content = msg.swipes[newId];
    if (msg.st) loadInfo(msg, msg.st.swipe_info[newId]);
    delete msg.memory;
    delete msg.memoryError;
    delete msg.memoryStale;   // 「原文改过」说的是旧候选的摘要，摘要都没了
    return true;
}

/**
 * 追加一个新生成的候选并切过去（会改动 msg）。对应酒馆 saveReply type='swipe'：swipes 加一格、mes = 新文本、
 * send_date 更新，然后把这一格的 swipe_info 写好。
 * @param {string} text
 * @param {string} [now]  ISO 时间
 */
export function appendSwipe(msg, text, now = new Date().toISOString()) {
    ensureSwipes(msg);
    if (msg.st) msg.st.swipe_info[msg.swipeId] = infoFromMes(msg);
    msg.swipes.push(text);
    msg.swipeId = msg.swipes.length - 1;
    msg.content = text;
    msg.sendDate = now;
    if (msg.st) {
        const st = msg.st;
        const extra = isObj(st.extra) ? st.extra : (st.extra = {});
        for (const k of NEW_SWIPE_DROP) delete extra[k];
        delete st.send_date;
        delete st.gen_started;
        delete st.gen_finished;
        st.swipe_info[msg.swipeId] = infoFromMes(msg);
    }
    delete msg.memory;
    delete msg.memoryError;
    delete msg.memoryStale;
    return msg;
}
