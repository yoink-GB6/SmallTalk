// 作者注释（Author's Note）：每个存档一段文字，按设定的位置 / 深度插进发给模型的内容里。纯函数，Node 里可测。
// 存在哪、怎么拼、怎么往返见 types.js ChatRecord.authorNote；拼装在 assemble.js「作者注释」一节；界面在 ui/author-note.js。
//
// ─────────────────────────── 酒馆 1.19.0 的规则（读源码得来，行号是大致的） ───────────────────────────
// 存储：public/scripts/authors-note.js metadata_keys（~L30）——作者注释存在【聊天】的 chat_metadata 里，五个键：
//   note_prompt   正文（字符串）
//   note_interval 插入频率：每 N 句用户输入插一次。0 = 关，1 = 每次都插（界面上写着「0 = Disable, 1 = Always」）
//   note_depth    聊天内的深度（只在 note_position = 1 时有用），界面 min 0 max 9999；输入负数时取绝对值（~L149）
//   note_position extension_prompt_types（public/script.js ~L484）：0 IN_PROMPT「在主提示之后」、1 IN_CHAT「聊天内 @深度」、
//                 2 BEFORE_PROMPT「在主提示之前」（-1 NONE 界面上选不到）
//   note_role     extension_prompt_roles（script.js ~L494）：0 system、1 user、2 assistant。只在界面上「聊天内」那一项旁边，
//                 但 openai.js 对另外两个位置同样用它（getPromptRole(authorsNote.role)，~L1400）
// 默认值（loadSettings ~L271-297）：打开一个聊天时，缺的键用 extension_settings.note 里的「默认作者注释」补上，再缺就用
//   prompt ''、interval 1、position 1、depth 4、role 0（system）。补上之后会随下一次保存写进聊天文件，
//   所以酒馆存过的 .jsonl 头里通常五个键都在（哪怕是空正文）。
// 这一轮插不插（setFloatingPrompt ~L324-392，每次生成时 script.js Generate ~L4619 调一次，此时用户刚发的那句已经在 chat 里）：
//   n = chat.filter(m => m.is_user).length        ← 整个 chat 里的用户消息数：【隐藏的（is_system）用户消息也算】，开场白不算
//   interval === 1 → n = 1（严格等于数字 1；所以「每次都插」连一句用户输入都没有时也插）
//   n <= 0 或 interval <= 0 → 不插
//   还差几句 = n >= interval ? n % interval : interval - n；为 0 时这一轮插
// 插的是什么：正文；角色卡专属注释（下面「没做的」）勾了「使用」时替换 / 拼在前后。setExtensionPrompt('2_floating_prompt', 文本, position, depth,
//   allowWIScan, role)——不插的轮次文本为 ''（扩展提示为空就什么都不发）。
// 世界书「作者注释上 / 下」（world_info_position ANTop 2 / ANBottom 3，world-info.js ~L5195-5272）：
//   条目照常扫描、激活（内容也进递归缓冲），排序和别的桶一样（order 小的在上，同 order 激活晚的在上——unshift）。
//   之后【只在这一轮插作者注释时】（shouldWIAddPrompt）才把它们拼进去：
//     `${上方条目.join('\n')}\n${正文}\n${下方条目.join('\n')}`.replace(/(^\n)|(\n$)/g, '')
//   不插的轮次这些条目就不发（照样算激活过）。正文为空、interval 是 1 时照样插——所以默认设置下 ANTop / ANBottom 条目
//   会以 system 身份出现在聊天内深度 4。
// 拼进对话补全（openai.js）：
//   - preparePromptsForChatCompletion（~L1398）：值非空就作为 systemPrompts 里的 'authorsNote' 一项，preparePrompt 对它做一次宏替换
//     （不管位置是哪种都会做这一次，所以正文里的 {{setvar}} / {{incvar}} 在「聊天内」位置下会执行两次——这里照做）；
//   - 位置 0 / 2（getPromptPosition ~L1140 → 'end' / 'start'）：populateChatCompletion 末尾的 injectToMain（~L1265）把它作为
//     【单独一条消息】插进 main 那一组的末尾 / 开头，即紧跟在 main 之后 / 紧挨在 main 之前（不管 main 后面是不是场景）。
//     main 没启用时 getPromptCollection 会放一个空内容的 main 替身（PromptManager.js ~L1531），位置照样找得到；
//     main 是「聊天内（绝对位置）」时，复制一份按 main 的角色 / 深度 / order 放进注入列表、排在 main 前 / 后（~L1270-1280）；
//     预设里压根没有 main 时不发。knownPrompts 的顺序是 summary → authorsNote → ……（我们没有 summary 这类扩展）。
//   - 位置 1：populationInjectionPrompts（~L810）里 getExtensionPrompt(IN_CHAT, 深度, '\n', 角色)（script.js ~L3301）按键名排序取值：
//     '2_floating_prompt' < 'DEPTH_PROMPT'（角色卡深度提示）< 'customDepthWI…'（世界书 @深度）——数字排在大写字母前、大写在小写前，
//     所以同深度同角色时作者注释在最前；各值先 trim、用 '\n' 连接、整体再宏替换一次，和预设里 order 100 的 @深度 条目合成一条消息。
// 宏：authors-note.js registerAuthorsNoteMacros（~L587）注册了 {{authorsNote}}（= 正文原文）、{{charAuthorsNote}}、{{defaultAuthorsNote}}，
//   见 macros.js。
// 斜杠命令 /note /note-depth /note-frequency /note-position /note-role（~L501-581）：我们没有斜杠命令框，不做。
//
// ─────────────────────────── 没做 / 和酒馆不一样的 ───────────────────────────
//   - 角色卡专属注释（extension_settings.note.chara：按卡的文件名存，useChara 勾上时替换 / 拼在正文前后）和
//     「默认作者注释」（extension_settings.note.default / defaultInterval / defaultDepth / defaultPosition / defaultRole）：
//     都是酒馆 settings.json 里的全局设置，不在聊天文件里，不做。所以新存档的作者注释永远是空正文 + 上面那组内置默认值；
//     {{charAuthorsNote}} / {{defaultAuthorsNote}} 永远是空串。酒馆整体备份 zip 导入时这两样不读（settings.json 里只挑人设和全局正则）。
//   - allowWIScan（「Include in World Info Scanning」，全局设置，默认关）：不做，作者注释的文字永远不参与世界书扫描（等于默认的关）。
//   - 人设描述放在「作者注释上 / 下」（persona_description_position TOP_AN / BOTTOM_AN，script.js ~L3213）：我们的人设只有「在提示词里」一种位置，不做。
//   - 预设里若有 identifier 为 'authorsNote' 的条目，酒馆会用它的 role / 注入位置覆盖（~L1475）。极少见，不做。
//   - 群聊、文本补全（openai.js 之外的分支）：不做。
//   - 读入时的容错比酒馆严格：值不对的键回到内置默认值（见 normalizeAuthorNote），而酒馆是原样拿去算。
//     间隔是数字字符串 "1" 时酒馆的 `=== 1` 不成立（没有用户输入的第一轮不插），这里先转成数字 1——酒馆自己的界面只会写数字，不影响正常文件。

/** 五个字段的内置默认值（authors-note.js loadSettings 的 DEFAULT_*）。全部等于它时 ChatRecord 上不写 authorNote */
export const AUTHOR_NOTE_DEFAULTS = Object.freeze({ prompt: '', interval: 1, depth: 4, position: 1, role: 0 });

/** note_position 的三个取值（extension_prompt_types） */
export const NOTE_POSITION = Object.freeze({ after: 0, chat: 1, before: 2 });
/** note_role 的三个取值（extension_prompt_roles）→ 消息的 role */
export const NOTE_ROLES = Object.freeze(['system', 'user', 'assistant']);
/** script.js MAX_INJECTION_DEPTH；酒馆界面上限是 9999，注入循环到 10000 */
export const MAX_NOTE_DEPTH = 10000;
/** 酒馆界面上限 */
export const MAX_NOTE_INTERVAL = 9999;

/** 字段名 ↔ 聊天文件 chat_metadata 的键（authors-note.js metadata_keys） */
export const NOTE_METADATA_KEYS = Object.freeze({
    prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role',
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 数字或数字字符串 → 数字；别的 → NaN（酒馆用 Number(...) 读界面输入，setExtensionPrompt 也是 Number(...)） */
const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * 一个字段的值是否合法；合法返回规范化后的值，不合法返回 undefined（调用方用默认值）。
 *   prompt：字符串
 *   interval：0..9999 的整数（负整数当 0 = 关：酒馆里 <= 0 都是不插）
 *   depth：0..10000 的整数
 *   position：0 / 1 / 2
 *   role：0 / 1 / 2
 */
export function normalizeNoteField(key, v) {
    switch (key) {
        case 'prompt': return typeof v === 'string' ? v : undefined;
        case 'interval': {
            const n = num(v);
            if (!Number.isInteger(n)) return undefined;
            return n < 0 ? 0 : Math.min(n, MAX_NOTE_INTERVAL);
        }
        case 'depth': {
            const n = num(v);
            return Number.isInteger(n) && n >= 0 && n <= MAX_NOTE_DEPTH ? n : undefined;
        }
        case 'position': case 'role': {
            const n = num(v);
            return n === 0 || n === 1 || n === 2 ? n : undefined;
        }
        default: return undefined;
    }
}

/**
 * 任意值 → 完整的五个字段（坏的、缺的用默认值）。读入容错的唯一入口：页面、拼装、备份判重都经过它，坏数据不会让页面打不开。
 * @param {any} v  ChatRecord.authorNote（可能缺失、可能被手改坏）
 * @returns {{prompt: string, interval: number, depth: number, position: 0|1|2, role: 0|1|2}}
 */
export function normalizeAuthorNote(v) {
    const src = isObj(v) ? v : {};
    /** @type {any} */
    const out = {};
    for (const k of Object.keys(AUTHOR_NOTE_DEFAULTS)) out[k] = normalizeNoteField(k, src[k]) ?? AUTHOR_NOTE_DEFAULTS[k];
    return out;
}

export const isDefaultNote = n => Object.keys(AUTHOR_NOTE_DEFAULTS).every(k => n[k] === AUTHOR_NOTE_DEFAULTS[k]);

/**
 * 要存进 ChatRecord 的形状：规范化后全是默认值就返回 null（= 不写这个字段，不用作者注释的人存储形状不变）。
 * @returns {{prompt: string, interval: number, depth: number, position: number, role: number}|null}
 */
export function storedAuthorNote(v) {
    const n = normalizeAuthorNote(v);
    return isDefaultNote(n) ? null : n;
}

/** 聊天文件头的 chat_metadata → 要存的作者注释（null = 默认）。不改 meta */
export function noteFromMetadata(meta) {
    if (!isObj(meta)) return null;
    const v = {};
    for (const [k, mk] of Object.entries(NOTE_METADATA_KEYS)) if (mk in meta) v[k] = meta[mk];
    return storedAuthorNote(v);
}

/**
 * 把作者注释写回聊天文件头的 chat_metadata（原地改 meta）。规则（保证没动过的文件往返不变）：
 *   - 有作者注释（note 非 null）：五个键都写；但原文件里这个键的值规范化后和要写的一样时，保留原值（比如数字字符串 "4"）。
 *   - 没有（默认值）：原文件里没有的键不补（酒馆打开时会用它自己的「默认作者注释」补，和在酒馆里新开聊天一样）；
 *     原文件里有、规范化后不等于默认值的（导入后在这边清空 / 改回了默认）改写成默认值；等于默认值的保留原值。
 * @param {object} meta  chat_metadata（导入时原样留在 ChatRecord.stHeader 里的那份的拷贝）
 * @param {any} note     ChatRecord.authorNote
 */
export function writeNoteMetadata(meta, note) {
    const want = normalizeAuthorNote(note);
    const has = storedAuthorNote(note) !== null;
    for (const [k, mk] of Object.entries(NOTE_METADATA_KEYS)) {
        const present = mk in meta;
        if (!has && !present) continue;
        if (present && normalizeNoteField(k, meta[mk]) === want[k]) continue;
        meta[mk] = want[k];
    }
    return meta;
}

/**
 * 这一轮插不插（setFloatingPrompt 的计数规则，见文件头）。
 * @param {{interval: number}} note  normalizeAuthorNote 的结果
 * @param {{role: string}[]} chat    【完整】聊天记录（含隐藏楼层、含被外置记忆折叠的楼层），用户刚发的那句已经在里面
 * @returns {{insert: boolean, userCount: number, untilNext: number|null}}
 *   userCount 用户消息数（隐藏的也算）；untilNext 还差几句用户输入才插（这一轮插 = 0；关掉 = null）
 */
export function noteTurn(note, chat) {
    const userCount = Array.isArray(chat) ? chat.filter(m => m?.role === 'user').length : 0;
    const interval = note.interval;
    const n = interval === 1 ? 1 : userCount;
    if (n <= 0 || interval <= 0) return { insert: false, userCount, untilNext: interval <= 0 ? null : interval - n };
    const until = n >= interval ? n % interval : interval - n;
    return { insert: until === 0, userCount, untilNext: until };
}

/** 酒馆拼世界书「作者注释上 / 下」的公式（world-info.js ~L5270） */
export function joinNoteText(top, prompt, bottom) {
    return `${top.join('\n')}\n${prompt}\n${bottom.join('\n')}`.replace(/(^\n)|(\n$)/g, '');
}
