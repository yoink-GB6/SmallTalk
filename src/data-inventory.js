// 「用户数据清单」：SmallTalk 存了哪些用户数据、每一种在导出 / 整体备份 / 恢复时怎么走。
// 只是一张登记表（代码 + 注释），运行时没有任何模块读它；test/data-inventory.test.mjs 拿它和代码的真实情况对账：
//   - 全局记录（'global'）里实际会出现的每个字段都必须在 GLOBAL_FIELDS 里登记，登记了的也必须真的存在；
//   - 标了「进整体备份」的字段，造一份非默认值走一遍「备份 → 恢复到空浏览器」，必须原样回来（或按登记的方式换算回来）；
//   - 标了「恢复时合并」的字段，各有一条合并的断言；
//   - 「当前在用的选择」（kind 'selection'）：导出的文件里没有它们，恢复到已有数据的浏览器时不管弹框怎么答都等于本机的，
//     空浏览器用默认值；设置（kind 'setting'）答「是」用备份的、答「否」是本机的。
// 所以以后加了新的全局字段却忘了想「导出 / 备份 / 恢复合并」，测试会失败并提醒你来这里登记。
//
// ── 新增一种用户数据时的检查清单 ──（CLAUDE.md 里由主代理统一写一份同样的清单，这里是代码旁边的那一份）
//   1. 字段放在哪：全局（跟着这个浏览器）还是卡 / 存档（跟着当前卡）？全局的，默认值要不要写？
//      「一条都没有时不写」的字段要加进 migrate.js 的 OPTIONAL_GLOBAL_KEYS，读档时容错（像 state.js 的 applyNotesFrom）。
//   2. 在这里登记一行：kind / backup / restore / fresh / export，说明写清「为什么」。
//   3. 想清楚它属于哪一类（规则的代码在 backup.js「全局记录的三类字段」一节）：
//        内容（kind 'content'，用户自己写 / 攒的）：恢复到已有数据的浏览器时永远取并集。
//          在 backup.js 的 unionContent 里加一类（判重规则写进那一节的注释），contentFromBackupOnly 里加上空浏览器的原样恢复，
//          summaryText 的 CONTENT_SUMMARY 里加一行。合并结果跟着新 global 在 ui/backup.js doImport 的写入事务里落盘，不用另外处理。
//        设置（kind 'setting'）：现在只有三样（backup.js SETTING_KEYS）。再加一样要先和用户确认——恢复时弹框只问一句「是否应用备份中的……」，
//          加进 SETTING_KEYS 后弹框文字（ui/backup.js SETTING_TEXT）和 backup.js SETTING_LABEL 也要加。
//        当前在用的选择（kind 'selection'：指向「现在用哪个」的东西、界面偏好、开关）：加进 backup.js 的 SELECTION_KEYS
//          （嵌在 memory 里的加进 MEMORY_SELECTION_KEYS）——导出时就不写进备份，恢复时永不从备份拿，空浏览器用默认值。
//   4. 恢复时形状不对（手改的备份）不能把页面弄坏：恢复前过一遍规范化，读档时（migrate.js normalizeGlobal）也要容错。
//   5. 单独导出导入（如果需要）：用什么格式、导入是合并还是替换。
//   6. 测试：test/data-inventory.test.mjs 会自动覆盖 1、3 的一部分；合并规则和单独导出导入要自己补用例。
//
// 字段说明：
//   kind    'content'    用户自己写 / 导入的内容（丢了就找不回来）
//           'setting'    设置项（丢了重新设一下就行）。全局记录里只有三样：外置记忆设置、上下文上限、世界书扫描设置
//           'selection'  「当前在用的选择」：当前用哪个预设 / 人设 / 接口和模型、开关、界面偏好。
//                        用户定的：整体备份「本质上是在导入数据，备份本身不包含当前在聊的用的这些」
//           'pointer'    （只用于 STORE_KEYS）能重建的引用 / 目录
//           'legacy'     旧版本留下的字段，现在不再使用或只在旧形状里出现
//   backup  'yes'      进整体备份
//           'no'       不进（写清为什么）
//   restore 恢复到【已有数据】的浏览器时：
//           'merge'      内容：和本机的取并集（backup.js unionContent）——不管弹框怎么答，本机已有的一条不删不改，备份里新的加进来，相同的跳过
//           'ask'        设置：弹框问「是否应用备份中的……」，答「是」才用备份里的；备份里缺失 / 形状不对 = 没有，本机的不动
//           'never'      永不从备份拿：保持本机的（当前选择；旧版本导出的备份里带着也忽略）
//           'none'       不处理（字段不在备份里，或旧形状里另有用途）
//   fresh   恢复到【空浏览器】（换新设备）时怎么回来：'same' 原样；'default' 不从备份拿，用默认值（写清默认是什么）；
//           'remap' 换算后回来；'none' 不回来（写清为什么）
//   export  有没有单独的导出 / 导入，在哪（没有就是 null）

/** @typedef {{what: string, kind: 'content'|'setting'|'selection'|'pointer'|'legacy', backup: 'yes'|'no', restore: 'merge'|'ask'|'never'|'none', fresh: 'same'|'default'|'remap'|'none', export: string|null, how?: string}} InventoryEntry */

/**
 * 全局记录（存储键 'global'，types.js GlobalRecord）的每个字段。
 * 整体备份导出 global 时去掉 kind = 'selection' 的字段（backup.js globalForBackup；memory 里的 modelRef 也去掉），其余原样带走。
 * 恢复到已有数据的浏览器时（backup.js planBackupImport）：新 global 的底子永远是本机现在的 global（当前选择、不认识的字段都是本机的）；
 *   内容类字段换成「本机 + 备份」的并集（unionContent）；答了「是」时三样设置换成备份里的（applyBackupSettings）。什么都没变时 out.global 为 null（不写）。
 *   之后 ui/backup.js 在同一个写入事务里写下新 global，最后 state.js reloadGlobalFromStore 读进内存。
 * 空浏览器：内容和设置是备份原样（contentFromBackupOnly / freshBase），当前选择用默认值。
 * @type {Record<string, InventoryEntry>}
 */
export const GLOBAL_FIELDS = {
    activePresetId: {
        what: '当前用的是哪个预设（preset:<id> 的 id；null = 内置默认预设）',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的；空浏览器：恢复进来的预设里的第一个（备份导出时按建立时间排；一个都没有 = null，内置默认预设）',
    },
    preset: {
        what: '旧形状（多预设之前）的 global 里的预设本体。新形状的 global 里没有它（toGlobalV2 去掉），运行时 state.preset 指向当前预设',
        kind: 'legacy', backup: 'yes', restore: 'none', fresh: 'remap', export: '「预设」页：导出（酒馆预设 JSON）/ 导入预设',
        how: '只有旧形状的备份里才有：planBackupImport 把它当成备份里的又一个预设导入（legacyPreset），global 里不再保留。它是内容（一个预设），不是「当前选择」',
    },
    presetName: {
        what: '旧形状 global 里的预设名字。新形状里没有（预设名在 PresetRecord.name）',
        kind: 'legacy', backup: 'yes', restore: 'none', fresh: 'remap', export: null,
        how: '同 preset：旧形状的备份里它变成导入预设的名字',
    },
    books: {
        what: '额外导入的世界书 [{name, entries, enabled?: false, scope?: \'cards\', cards?: 卡id[]}]（不是角色卡内嵌的那本）。'
            + '后三个是开关 / 生效范围 / 绑定的卡，默认（启用、所有聊天）时不写（types.js ExtraBook、books.js）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'remap', export: '「世界书」页：每本书的「导出」（酒馆世界书 JSON，不带开关和绑定）；导入走拖文件 / 「存档」页的导入…（启用、所有聊天）；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（合并；开关和绑定按酒馆里的全局选中 / 卡绑定定） / 导出成酒馆目录结构的 zip（worlds/）',
        how: 'unionBooks：去掉 name、enabled / scope / cards、条目上的 book 之后内容相同的跳过（不管叫什么、开没开、绑给了谁），保留本机那本和它的开关、范围；'
            + '但备份里那本「只对指定的卡」绑定的卡换算成本机的卡 id 后并进本机那本的 cards（本机那本也是「只对指定的卡」时；摘要里的 booksRebound）。'
            + '内容不同而重名的两本都留，后一本名字加「 (2)」（世界书按名字找，名字不能重复），摘要里提醒可能重复发给模型。'
            + '新加进来的书 cards 按 planBackupImport 的 cardIdMap 换算（备份里的卡 id → 新 id，或判重后本机已有的卡），映射不到的丢掉——空浏览器也一样，所以登记成 fresh = remap。'
            + '三个字段类型不对的按缺省处理（books.js normalizeBookScope，经 migrate.js cleanBooks）。'
            + '不是对象的书 / 条目、entries 不是数组的书丢掉并计入跳过（读档时 normalizeGlobal 也清掉坏条目）',
    },
    globalRegex: {
        what: '单独导入的全局正则脚本',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: '手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（settings.json 里的全局正则，合并）；导出 zip 不带',
        how: '导入走拖文件 / 「存档」页的导入…；没有单独导出（角色卡导出时只带卡自己的正则）。'
            + '恢复时 unionRegex：去掉 id、origin（运行时的标签）、disabled（开关状态）之后内容相同的跳过，保留本机那条和它的开关；id 和本机的撞了换新 id；不是对象的丢掉',
    },
    persona: {
        what: '当前人设 {name, description, remark?}（永远是当前那一项的副本，宏 {{user}} 和拼装只读名字和描述）。'
            + 'remark = 备注，只用来在列表上区分重名的人设，不发给模型；空备注时不写这个键（personas.js cleanRemark：非字符串丢掉、压成一行、最长 200 字）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'remap', export: '「人设」页：批量 → 导出（酒馆人设备份文件，备注 ↔ title）/ 导入（合并）；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（settings.json 里的人设，含备注，合并、不切换当前人设）；导出 zip 不带',
        how: '和 personas 一起合并（unionPersonas → personas.js mergePersonas）：名字、描述、备注都相同的算重复（备注算内容，没有备注 = 空备注）；本机当前人设永远不变。'
            + '备份里只有一个出厂默认人设（User、没有描述、没有备注）时不加进来。空浏览器：有列表时变成列表第一项的副本（当前人设 = 第一个），只有一个人设时原样',
    },
    personas: {
        what: '多人设列表 [{id, name, description, remark?}]；只有一个人设时不写（OPTIONAL_GLOBAL_KEYS）。remark 见 persona',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: '「人设」页：批量 → 导出 / 导入（合并，personas.js mergePersonas）；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（合并）',
        how: '见 persona。导出前先 alignPersonas 把 persona 对齐进列表（因为 activePersonaId 不进备份，读的一方以列表为准）。'
            + '合并后仍只有一个人设（备份里的都是重复的）时不写这个字段，存储形状不变；有新增时本机原来那个变成第一项',
    },
    activePersonaId: {
        what: 'personas 里当前那一项的 id；只有多人设时才有（OPTIONAL_GLOBAL_KEYS）',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的当前人设（合并进来的人设只是加进列表）；空浏览器：列表里第一个',
    },
    notes: {
        what: '便签 [{id, title, body, done, createdAt, doneAt, ...}]；一条都没有时不写（OPTIONAL_GLOBAL_KEYS）。不认识的附加字段原样保留',
        // 界面精简（2026-11-22 用户定）：便签搬进「人设」页下方，按钮只留「删除已完成」，导出 / 导入按钮去掉了。
        // notes.js 的 notesToMarkdown / parseNotesMarkdown 还在（单元测试用），界面上没有入口；整体备份照旧带便签
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: null,
        how: 'mergeNotes 追加：标题（去首尾空白）+ 内容都相同的算同一条、跳过，不看是否完成（保留本机那条和它的完成状态）；id 撞了换新的；'
            + '备份里没有 / 不是数组 = 没有便签，本机的不动',
    },
    notesHideDone: {
        // 【已废弃】界面精简（2026-11-22）去掉了「隐藏已完成」开关：界面不再读写它，读到旧值忽略，也不主动清理已存的值。
        // 仍留在 OPTIONAL_GLOBAL_KEYS 和 backup.js SELECTION_KEYS 里：这样旧数据里的 true 照旧不进整体备份、恢复时不从备份拿
        what: '（已废弃）以前「便签」页的「隐藏已完成」开关；只认 true，不隐藏时不写（OPTIONAL_GLOBAL_KEYS）。现在界面上没有这个开关，读到旧值忽略',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的；空浏览器：默认（不写）。没有任何代码再按它显示或隐藏便签',
    },
    globalVariables: {
        what: '全局变量（宏 {{setglobalvar}} 写的；运行时是 state.variables.global）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: null,
        how: 'unionVars 按键合并：本机没有的键加进来，本机已有的键（哪怕叫 constructor）保留本机的值；__proto__ / constructor / prototype 只从备份一侧过滤',
    },
    wi: {
        // 界面已隐藏，固定为酒馆默认（2026-11-22 用户定），只有扫描深度还可调；备份 / 酒馆 zip 带进来的其余四项也因此被忽略（worldinfo.js effectiveWiSettings）
        what: '世界书的全局设置（现在界面上只有扫描深度；递归、全词匹配、带名字、区分大小写固定为酒馆默认）',
        kind: 'setting', backup: 'yes', restore: 'ask', fresh: 'same', export: null,
        how: '弹框答「是」才用备份里的（不是对象 / 空对象 = 没有，本机的不动）',
    },
    manual: {
        what: '手动模式开关（手机 Settings）',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的；空浏览器：关',
    },
    model: {
        what: '旧版本的「聊天用的 Claude 模型别名」。现在由 chatModel 取代；运行时 state 上一直是 \'\'，每次保存都照写一个空串',
        kind: 'legacy', backup: 'no', restore: 'never', fresh: 'none', export: null,
        how: '它也是「聊天用哪个模型」，属于当前选择：导出时不写；旧备份里带着也忽略（不然读档时 migrateModelRefs 会拿它换算出一个 chatModel）',
    },
    memory: {
        what: '外置记忆设置 {enabled, keep, summaryLen?, mergeEvery?, modelRef}（modelRef = 记忆压缩用的「接口 + 模型」；summaryLen = 每条摘要的目标字数，默认不写 = 60；'
            + 'mergeEvery = 「每 x 条记忆再次压缩」，默认不写 = 不做（memory-fold.js mergeEveryOf：非正整数 = 不做，1–3 按 4，上限 200）；'
            + 'batch 界面已隐藏，固定 10（2026-11-22 用户定）：存储 / 备份里残留的 batch 值运行时被忽略，见 memory-fold.js）',
        kind: 'setting', backup: 'yes', restore: 'ask', fresh: 'remap', export: null,
        how: 'enabled / keep / summaryLen / mergeEvery 等是设置：弹框答「是」才用备份里的（不是对象 / 去掉 modelRef 后为空 = 没有）。'
            + '【modelRef（以及旧写法 model / openaiModel）是当前选择】：导出时去掉；答「是」时也保留本机的；空浏览器：设置原样、modelRef 不写 = 读档时补默认引用（所以登记成 fresh = remap）',
    },
    stableRandom: {
        what: '「拼装」页的「随机宏在同一个存档里固定结果」开关；只认 true，关着时不写（OPTIONAL_GLOBAL_KEYS）。酒馆没有这个设置',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的；空浏览器：默认（关）',
    },
    promptCache: {
        what: '「拼装」页的「经 OpenRouter 用 Claude 时自动请它缓存开头」开关；默认开、不写，只有关掉时是 false（OPTIONAL_GLOBAL_KEYS）',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份；已有数据：保持本机的；空浏览器：默认（开）',
    },
    chatModel: {
        what: '聊天用的「接口 + 模型」引用 {endpoint: 接口 id, model}',
        kind: 'selection', backup: 'no', restore: 'never', fresh: 'default', export: null,
        how: '导出时不写进备份（以前另记的 refEndpoints 也不再写，旧文件里的忽略）；已有数据：保持本机的；'
            + '空浏览器：不写 = 读档时补默认引用（网页版里显示「还没选接口」，本地版是 Claude Code）。不按地址自动指到备份里的模型',
    },
    contextLimit: {
        what: '上下文上限 {mode, maxContext}（「拼装」页）',
        kind: 'setting', backup: 'yes', restore: 'ask', fresh: 'same', export: null,
        how: '弹框答「是」才用备份里的（不是对象 / 没有 mode = 没有，本机的不动）',
    },
};

/**
 * 全局记录以外的存储键（IndexedDB smalltalk / kv；键布局见 types.js「多卡多存档」）。和 GLOBAL_FIELDS 合起来就是「全部用户数据」的总目录。
 * 本地服务版的接口列表和 key 不在浏览器里，在服务端的 ~/.smalltalk/config.json，也登记在这里（键名用 'server:config.json' 表示）。
 * @type {Record<string, InventoryEntry & {key: string}>}
 */
export const STORE_KEYS = {
    meta: {
        key: 'meta', what: '存储的版本号和「当前是哪张卡」（StoreMeta）',
        kind: 'pointer', backup: 'no', restore: 'none', fresh: 'remap', export: null,
        how: '能重建，不进备份；恢复到空浏览器时 ui/backup.js 按 plan.target 切到备份里原来的当前卡和存档',
    },
    card: {
        key: 'card:<cardId>', what: '角色卡（CardRecord：卡本体 + 头像 + 停在哪个存档）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: '「存档」页：卡的导出（酒馆 PNG / JSON）；导入走拖文件 / 导入…；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（合并） / 导出成酒馆目录结构的 zip（characters/）；「脚本」页：单个脚本 / 文件夹的导出导入（酒馆助手脚本 JSON）',
        how: '恢复时换新 id；内容相同（cardSig，不看卡自带世界书的开关 card.worldDisabled）的不新建，存档并进已有的卡，本机那张的开关不动；开关跟着卡记录进备份，不进导出的酒馆卡。'
            + '酒馆助手脚本（card.scripts，2026-11-23 第 1 期加、第 2 期起运行；缺省 = 跟着 raw，见 types.js Card.scripts、src/scripts.js）是卡内容的一部分：'
            + '跟着卡记录进整体备份；判重时算内容（代码、名字、开关 enabled 都算，和卡自带正则的 disabled 一样——它们都写在卡文件里），用 cardScripts 的值比，'
            + '「没改过、跟着 raw」和「写了但一样」判成同一张卡；新加进来的卡先规范化（不是数组的删掉、坏条目丢掉）。'
            + '导出卡（PNG / JSON、酒馆目录 zip）时合并回 data.extensions.tavern_helper，没改过的卡和原文件逐字相同；从酒馆 zip 导入时跟着 raw 自然带进来。'
            + '单个脚本 / 文件夹另有导出导入（「脚本」页，酒馆助手的脚本文件格式）。不发给模型；前端卡读不到。'
            + '脚本运行时写的变量不在这里，在 cardvars:<cardId>（见 STORE_KEYS.cardvars）',
    },
    cardvars: {
        key: 'cardvars:<cardId>', what: '每张卡的酒馆助手运行时数据（types.js CardVars：角色卡变量 character、脚本变量 scripts[脚本 id]，以后还有前端卡的 localStorage 小设置 storage）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'remap', export: null,
        how: '2026-11-23 第 2 期加。三个字段默认不写，都没有时整条不存在。进整体备份：挂在备份文件里卡那一项的 vars 上（backup.js buildBackup）。'
            + '恢复时卡是新建的 → 整条带过来（卡 id 换算成新的，所以登记成 fresh = remap）；卡和本机已有的判成同一张（cardSig，不看 cardvars）→ '
            + '按键取并集、本机已有的键保留本机的值（character 按变量名，scripts 先按脚本 id 再按变量名，storage 按键；cardvars.js unionCardVars，'
            + '和全局变量一个规矩），在恢复的写入事务里做；备份里判成同一张的两张卡各带一份时也按键并起来。'
            + '读入容错 normalizeCardVars：不是对象 = 没有，坏字段丢掉，变量值过 vars-ops.js sanitize。删卡时和卡在同一个事务里删；同名卡「更新」时保留（卡 id 不变）。'
            + '没有单独的导入导出；导出卡时【不写回】卡文件（运行时状态不随分享的卡走；卡文件里的 tavern_helper.variables 和脚本的 data 只当初值）。'
            + '不发给模型；只有这张卡的前端卡和脚本读写得到（frame-host.js 的变量作用域）',
    },
    chat: {
        key: 'chat:<cardId>:<chatId>', what: '存档（ChatRecord：消息、局部变量、名字、作者注释 authorNote（默认值时不写）、划线 highlights（没有时不写）……）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: '「存档」页：存档的导出 / 导入（酒馆 .jsonl；作者注释在头的 chat_metadata.note_*）；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（合并） / 导出成酒馆目录结构的 zip（chats/<卡文件名>/）',
        how: '恢复时换新 id；名字 + 消息 + 变量 + 作者注释相同（chatSig）的跳过——作者注释只在不是默认值时才参与比较，所以没有作者注释的存档（含旧备份）判重和以前一样；'
            + '新加进来的存档的作者注释先规范化（坏值回默认）。'
            + '作者注释（2026-11-22 加，types.js ChatRecord.authorNote）是存档内容的一部分：跟着存档进整体备份、跟着 .jsonl 往返；'
            + '会发给模型（按它的位置 / 深度 / 频率插进拼装结果，assemble.js）；前端卡读不到也改不了它（frame-host.js 不提供接口，这次有意不做）。'
            + '角色卡专属注释、默认作者注释（酒馆 settings.json 里）没做，不存。'
            + '外置记忆的摘要（ChatMessage.memory）和再压缩的合并段 / 覆盖标记（memoryMerged / memoryIn，2026-11-23 加，规则见 memory-fold.js 文件头「合并段」）'
            + '都挂在消息上：跟着存档进整体备份、参与 chatSig 判重（只差合并状态的两个存档不算重复）、跟着 .jsonl 的 extra.smalltalk 往返；'
            + '会发给模型（记忆块）；前端卡读不到（getChatMessages / getContextSnapshot 不给 memory 一类字段）。读档时 normalizeMerged 清掉坏段和孤儿标记'
            + '（按旧规矩存下的、成员跳过隐藏回复的已换上的段先升级再判断）。隐藏标记（hidden）不碰记忆：隐藏的楼已有的摘要照旧发。'
            + '楼层变量（ChatMessage.variables，酒馆助手的 message 作用域，2026-11-23 第 2 期加）挂在消息上：跟着存档进备份、参与 chatSig、'
            + '跟着 .jsonl 的 variables 往返；不发给模型，前端卡和脚本读写得到。'
            + '划线（ChatRecord.highlights，2026-11-28 加；types.js「划线」、src/highlight.js）：【内容】，挂在存档记录上、不挂在消息上（消息对象的形状不变），'
            + '一条都没有时不写这个键。只记位置（第几楼、第几个候选、原文的第几个字）不存文字。跟着存档进整体备份；'
            + '恢复时【判重不看划线】（chatSig 和划线功能出现之前逐字相同，2026-11-28 用户定的）：备份里的存档和本机的除划线外完全相同 → 不新增存档，'
            + '备份里的划线并进本机那个（backup.js planBackupImport 的 highlightMerges → ui/backup.js doImport 的写入事务里现读那条记录、mergeChatHighlights 只换 highlights，'
            + '消息 / 变量 / 作者注释 / 名字 / updatedAt 不动，目录 hl 跟着重算；读回不一致时整条换回写之前的）。并集：位置相同（两端楼 / 候选 / offset、整楼标记）算同一条、保留本机的，'
            + '本机没备注而备份有就补上；本机的一条不删不挪；撞 id 换确定的新 id（highlight.js mergeHighlights）。没有新东西可并就不写，所以同一份备份导两遍第二遍全是跳过、零写入。'
            + '备份里两个除划线外相同的存档（都不在本机）：进来第一个，划线取并集。当前存档被并入时 state.js adoptRestoredHighlights 让内存跟上。'
            + '新加进来的存档的划线按它的消息清洗（越界 / 坏的丢掉）；并进来的同样先清洗。读档时（state.js applyCardChat）同样清洗。'
            + '【不发给模型】（拼装只读消息）；【前端卡和脚本读不到】（getChatMessages / getContextSnapshot / 推给脚本沙箱的副本都只有消息）；'
            + '【不进 .jsonl】（serializeChatFile 不读它；酒馆没有对应的东西），所以「导出存档 → 再导入」会丢掉划线；酒馆 zip 导入导出同样不带。'
            + '单独的导出（摘抄导出）以后再做',
    },
    index: {
        key: 'index:<cardId>', what: '每张卡的存档目录（名字、楼数、时间、划线条数 hl——有划线才写），切换时只读它',
        kind: 'pointer', backup: 'no', restore: 'none', fresh: 'remap', export: null,
        how: '能从存档重建，不进备份；恢复时为新卡新建、为并进的卡补条目（buildIndex / mergeIndex）。hl 给摘抄页挑出有划线的存档用（migrate.js indexEntry），重建时跟着重算',
    },
    preset: {
        key: 'preset:<presetId>', what: '保存下来的预设（PresetRecord）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: '「预设」页：导出（酒馆预设 JSON）/ 导入预设；手机 Settings「和酒馆整体互通」：从酒馆整体备份 zip 导入（合并） / 导出成酒馆目录结构的 zip（OpenAI Settings/）',
        how: '恢复时换新 id；本体一字不差的跳过，同名不同内容的加「 (2)」。'
            + '酒馆写进预设的连接信息（反代地址 / 密码、附加请求头……）在所有入口去掉、打开页面时从存储里删掉、所有导出出口再去一遍（types.js PresetRecord「预设本体的清洗」）',
    },
    endpoints: {
        key: 'endpoints', what: '网页版（direct）的接口列表和 API key（{version: 2, endpoints}）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: null,
        how: '不按键原样搬：经 llm.js exportEndpointsForBackup 进备份的 endpoints 字段（带 key 时整个文件强制加密）；'
            + '恢复时 planEndpointImport：没有同地址的新建，同地址的只在本机没 key 时补 key',
    },
    serverConfig: {
        key: 'server:config.json', what: '本地服务版的接口列表和 API key（服务端 ~/.smalltalk/config.json，不在浏览器里）',
        kind: 'content', backup: 'yes', restore: 'merge', fresh: 'same', export: null,
        how: '只有名字、地址、模型名单进备份（页面读不到服务端的 key，有意的隔离）；恢复规则同 endpoints',
    },
    legacyState: {
        key: 'state', what: '版本 1 的整份旧数据（迁移完成后会删掉）',
        kind: 'legacy', backup: 'no', restore: 'none', fresh: 'none', export: null,
        how: '启动时迁移成新布局（migrate.js migrateV1）；备份只看在不在，不导出',
    },
    legacyBackup: {
        key: 'state.v1.bak*', what: '迁移时有认不出的内容才写的旧数据整份备份，程序永远不自动删',
        kind: 'legacy', backup: 'no', restore: 'none', fresh: 'none', export: null,
        how: '备份里不带（可能很大，而且是旧版本的东西）；导出提示里说一句',
    },
};

/**
 * 不进 IndexedDB 的「这台设备的界面偏好」：存在浏览器的 localStorage 里。
 * 它们不是用户内容，也不是设置：不进整体备份、不进任何导出，恢复备份时不动；换设备 / 清站点数据后回到默认，这是有意的。
 * 读写一律包 try/catch（无痕窗口等用不了 localStorage 时，不记就是了）。上面的 GLOBAL_FIELDS / STORE_KEYS 只登记 IndexedDB 里的东西，
 * 这两个键不在那里，所以单独写在这儿，免得以后有人以为漏登记了；test/data-inventory.test.mjs 核对：源码里出现的 'smalltalk.xxx' 形式的键都登记在这里，这里登记的也都真的在用。
 * @type {Record<string, {what: string, where: string, default: string}>}
 */
export const LOCAL_STORAGE_PREFS = {
    'smalltalk.panelCollapsed': {
        what: '宽屏下右侧面板是否收起（"1" = 收起；默认不存）',
        where: 'src/ui/drawer.js', default: '展开',
    },
    'smalltalk.theme': {
        what: '界面主题的 id（src/themes.js 清单里的一项；默认主题不存这个键）',
        where: 'src/ui/theme.js；index.html <head> 里有一小段内联脚本在样式表之前读它，首屏就是对的主题', default: 'default（跟随系统的默认样式）',
    },
    'smalltalk.scriptFloatHidden': {
        what: '「脚本」页「隐藏悬浮界面」打了勾的卡 id 列表（JSON 数组，最多 200 个；都没勾时不存这个键）。只是这台设备上的显示偏好：脚本照常运行',
        where: 'src/ui/script-host.js FLOAT_HIDE_KEY', default: '都显示',
    },
    'smalltalk.firstRunGuideOff': {
        what: '网页版首次打开的小指引弹窗：点过「不再提示」就是 "1"（默认不存，之后每次打开都会弹，直到装到主屏幕 / 浏览器答应保留数据）',
        where: 'src/ui/first-run-guide.js GUIDE_OFF_KEY', default: '会弹（仅网页版、没装到主屏幕、浏览器还没给持久存储时）',
    },
    'smalltalk.scriptTrusted': {
        what: '「脚本」区「允许直接操作页面」打开了的卡：JSON 数组 [{id: 卡 id, fp: [启用脚本代码的 SHA-256…]}]，最多 200 张（都没开时不存这个键）。'
            + '是这台设备上的安全决定：不进整体备份、不随卡导出；删卡时一起删；脚本代码变了（指纹对不上）自动作废',
        where: 'src/script-trust.js TRUST_KEY；读写在 src/ui/script-host.js（trustedNow / setTrusted / forgetTrust）', default: '都不开（脚本在沙箱里跑）',
    },
};
