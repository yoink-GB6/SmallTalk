// 共享契约：所有模块之间只通过这里定义的数据结构和函数签名耦合。
// 这个文件没有运行时代码，只有 JSDoc 类型。改这里之前先想清楚会影响哪些模块。
//
// 原则：凡是酒馆自己有的格式（预设、世界书条目、正则脚本），一律保留酒馆的原始字段名，
// 这样对照酒馆源码和真实文件时不用做脑内翻译。只有角色卡做了一层归一化（Card）。

export {};

// ───────────────────────────── 基础 ─────────────────────────────

/** @typedef {'system'|'user'|'assistant'} Role */

/**
 * 聊天记录里的一楼。chat 数组一律「旧 → 新」排列。
 * @typedef {Object} ChatMessage
 * @property {'user'|'assistant'|'system'} role  system = 旁白
 * @property {string} name     说话人名字
 * @property {string} content  存储的原文（未经显示正则 / 发送正则处理）
 * @property {string} [memory]       外置记忆：这一轮（之前的用户输入 + 这条回复）压缩成的一句话，只挂在 assistant 楼上
 * @property {string} [memoryError]  上次压缩失败的原因
 * @property {{text: string, count: number, wait?: number}} [memoryMerged]
 *   外置记忆的「再压缩」：把较早的 count 条回复（从这条往前数的回复，含这条；隐藏的也算）的摘要合并成的一段，挂在段的最后一条回复上。
 *   wait 只在「已算好、还没换上」时有（成员各自的 memory 还在、照常按行发；切点再往后挪一次才换上）。规则见 src/memory-fold.js 文件头「合并段」。
 *   不用这个功能（memory.mergeEvery 不写）时永远不出现
 * @property {true} [memoryIn]   这条回复已被后面的合并段覆盖（自己的 memory 已删）：不再逐轮压缩。段作废时一起删掉，这一轮回到待压缩。
 *   读档时（memory-fold.js normalizeMerged）数不齐成员的段、孤儿标记都清掉
 * @property {true} [hidden]   隐藏楼层（酒馆的「隐藏消息」，jsonl 里是 is_system: true）：留在记录里、照常显示（变淡）、能编辑能搜，
 *                              但【原文不发给模型】，也不参与楼层深度、世界书扫描、上下文上限。只在隐藏时写 true，平时不写这个字段。
 *                              【不碰外置记忆】（2026-11-23）：隐藏 / 取消隐藏不作废摘要、不拆合并段、不触发压缩；已有的摘要照旧发。
 *                              整轮（回复和它的输入）都隐藏、还没压过的轮隐藏期间不压。
 *                              和旁白（role 'system'）是两回事：旁白照常发送（作为 system 消息），旁白也可以被隐藏。
 *                              逐项规则和酒馆出处见 src/memory-fold.js 的「隐藏楼层」小节、src/ui/pipeline.js computePrompt。
 *                              老存档（这个功能以前导入的：st.is_system 为真、没有 hidden）：有写权限的标签页打开这个存档时
 *                              自动按隐藏处理并提示一句（chatfile.js legacyHiddenFloors，ui/archive.js adoptLegacyHidden）。
 */

/**
 * 楼层深度：该楼之后还有几楼。最后一楼 depth = 0，倒数第二楼 = 1。
 * 正则的 minDepth/maxDepth、预设的 injection_depth、世界书的 depth 都用这个定义。
 */

/**
 * 变量仓库，会被宏（setvar 等）原地修改。
 * 值：宏写的是字符串 / 数字；酒馆助手的前端卡和脚本可以写任何能 JSON 化的值（嵌套对象、数组；2026-11-23 第 2 期起契约上放宽，
 * 以前其实也已经这样存了）。写进来之前一律过 vars-ops.js sanitize：任何一层的 __proto__ / constructor / prototype 键丢掉、超过 5 MB 不收。
 * @typedef {Object} Variables
 * @property {Record<string, any>} local   对应酒馆 chat_metadata.variables
 * @property {Record<string, any>} global  对应酒馆 extension_settings.variables.global
 */

// ───────────────────────────── 角色卡 card.js / png.js ─────────────────────────────

/**
 * 归一化后的角色卡（V1 / V2 / V3 都转成这个）。
 * @typedef {Object} Card
 * @property {string} name
 * @property {string} description
 * @property {string} personality
 * @property {string} scenario
 * @property {string} firstMes
 * @property {string[]} alternateGreetings
 * @property {string} mesExample
 * @property {string} systemPrompt             data.system_prompt（可覆盖预设的 main）
 * @property {string} postHistoryInstructions  data.post_history_instructions（可覆盖预设的 jailbreak）
 * @property {string} creatorNotes
 * @property {{prompt: string, depth: number, role: Role}|null} depthPrompt  data.extensions.depth_prompt，prompt 为空则为 null
 * @property {string} worldName                内嵌世界书的名字（没有则 ''）
 * @property {WorldEntry[]} worldEntries       内嵌 character_book 转换后的条目
 * @property {RegexScript[]} regexScripts      data.extensions.regex_scripts
 * @property {Object} raw                      原始卡 JSON，原样保留
 * @property {true} [worldDisabled]            卡自带的世界书（worldEntries）整本关掉：true = 不参与拼装（ui/pipeline.js allEntries）。
 *   【缺省 = 启用】：只有关掉时才写 true，打开就删掉这个键（读档 migrate.js normalizeCard 只认 true，别的值一律删掉）。
 *   这是 SmallTalk 自己的字段：不写进 raw、导出卡时不带（card-export.js exportCardJson 只读 raw / worldEntries / worldName / regexScripts）；
 *   整体备份里跟着卡记录走，但【不算卡的内容】——判重（backup.js cardSig）时去掉它：只差这个开关的两张卡是同一张卡，保留本机的开关。
 *   为什么需要它：酒馆运行时根本不用卡里内嵌的 character_book，只读卡用 data.extensions.world 指名绑定的世界书文件
 *   （public/scripts/world-info.js getCharacterLore）；内嵌的那份只是保存角色时服务端写进卡里的拷贝（src/endpoints/characters.js
 *   ~L628–640），可能是旧的。酒馆 zip 导入时，卡绑定的书文件一起导进来了，就把卡自带的这份关掉（tavern-convert.js applyWorldRules）。
 *   单独导入一张卡：启用（不写）。同名卡「更新」时保留旧卡的这个开关（archive.js addCard）。
 * @property {ScriptTree[]} [scripts]          酒馆助手脚本（2026-11-23 第 1 期：「脚本」页看、开关、增删、改代码；第 2 期起【运行】：
 *   当前卡启用的脚本在一个沙箱 iframe 里跑，见 ui/script-host.js。运行时数据（脚本变量、角色卡变量）不在这里，在 'cardvars:<cardId>'，见 CardVars）。
 *   【缺省 = 跟着 raw】：没有这个键时，脚本树现场从 raw 解析（src/scripts.js cardScripts / parseCardScripts：
 *   data.extensions.tavern_helper.scripts，对象或 [[k,v]] 数组；没有它才看旧键 TavernHelper_scripts）。parseCard 不写这个键，
 *   所以已导入的卡不用迁移，不用这个功能的卡存储形状不变。用户在「脚本」页第一次改动时才把整棵规范化的树写进来，之后一直有（删光了是 []）。
 *   规范化的形状 = 酒馆助手新格式（字段名原样，见下面 Script / ScriptFolder），我们不认识的字段原样保留。
 *   读档（migrate.js normalizeCard）：不是数组 → 删掉这个键（回到跟着 raw）；是数组 → 规范化（坏条目丢掉、字段校正、id 补齐）。
 *   导出（card-export.js exportCardJson → scripts.js writeScriptsInto）：和 parseCardScripts(raw) 相同 → raw 一字不动；
 *   不同 → 只改动过的条目 / 字段，规则见 scripts.js 文件头。
 *   整体备份：跟着卡记录走，【算卡的内容】（含 enabled 开关，和卡自带正则的 disabled 一样；backup.js cardSig 用 cardScripts 的值比）。
 *   同名卡「更新」：以新卡文件为准（parseCard 的结果没有这个键，旧的改动丢掉——和正则一样）。
 *   不发给模型（拼装不读它），消息里的前端卡也读不到（frame-host.js 没有接口）。脚本自己能读到自己的名字 / 说明 / 按钮（getScriptName 等）。
 */

/**
 * 酒馆助手的一个脚本（新格式，酒馆助手 4.12.2 src/type/scripts.ts；括号里是缺省值）。规范化后每个字段都有。
 * @typedef {Object} Script
 * @property {'script'} type
 * @property {boolean} enabled        卡作者 / 用户设的开关（false）
 * @property {string} name            ('')
 * @property {string} id              酒馆助手里是 uuid；缺失 / 重复时我们补一个确定的 'st-<位置>'
 * @property {string} content         代码（''）。整段被 ``` 围起来时运行前剥掉外层（scripts.js stripCodeFence，第 2 期用）
 * @property {string} info            作者写的说明（''）
 * @property {{enabled: boolean, buttons: {name: string, visible: boolean}[]}} button   脚本按钮（enabled 缺省 true；第 4 期用）
 * @property {Object} data            脚本变量的【初值】（{}）。运行时 getVariables({type:'script'}) 读：CardVars.scripts[id] 有就用它，没有才用这里的 data；
 *                                    写一律写进 CardVars.scripts[id]，不改这里（卡文件只读，没改过的卡导出逐字不变）。导出卡时不把运行时的值写回 data（2026-11-23 定的，见 CardVars）
 * @property {{data: boolean, button: boolean}} export_with   导出时带不带 data / 按钮（都缺省 true）。只在单个脚本导出时生效，导出卡时这一期不处理
 *
 * 文件夹（只有一层，里面只能是脚本）。
 * @typedef {Object} ScriptFolder
 * @property {'folder'} type
 * @property {boolean} enabled        关着的文件夹里的脚本都不运行
 * @property {string} name
 * @property {string} id
 * @property {string} icon            ('fa-solid fa-folder')
 * @property {string} [color]         原来没有就不写（酒馆助手缺省用主题的引用色）
 * @property {Script[]} scripts
 *
 * @typedef {Script|ScriptFolder} ScriptTree
 */

/**
 * 一张卡的运行时数据（酒馆助手第 2 期）：存储键 'cardvars:<cardId>'（纯逻辑 src/cardvars.js；读写 ui/state.js persist.cardVars、ui/frame-host.js 的变量作用域）。
 * 三个字段都【默认不写】，三个都没有时整条记录不存在（写空了就删键）——不用脚本的卡存储里没有这个键。
 * @typedef {Object} CardVars
 * @property {Object} [character]   角色卡变量（getVariables({type:'character'})）。没有 = 用卡文件里带的初值（data.extensions.tavern_helper.variables，
 *                                  旧卡是 TavernHelper_characterScriptVariables；scripts.js cardCharacterVars）。写过就以这里为准，哪怕是空表 {}
 * @property {Record<string, Object>} [scripts]   脚本变量，按脚本 id（getVariables({type:'script'})）。没有某个 id = 用卡里那个脚本的 data（初值）。
 *                                  脚本在「脚本」页被删掉后它的这一项留着不管（不影响任何东西，删卡时整条删）
 * @property {Record<string, string>} [storage]   前端卡 / 脚本的 localStorage「小设置」（第 6 期接上，这一期没人写）；值只能是字符串，总长上限 5 MB（STORAGE_LIMIT）
 *
 * 为什么不放进卡记录：卡记录里有头像（可能几 MB），脚本可能每条消息都写变量；也不该让「玩着玩着」改变卡的内容签名（backup.js cardSig 不看它）。
 * 读入容错（normalizeCardVars）：不是对象 = 没有；某个字段形状不对 = 那个字段没有；变量值过 vars-ops.js sanitize；storage 的非字符串值丢掉、超长从后面截掉。
 * 读的时机：换卡时异步读（state.js loadCardVars），读回来之前不写它、要读写它的先 await cardVarsReady()。
 * 整体备份：跟着卡走（备份文件里卡那一项的 vars 字段，backup.js buildBackup）。恢复时新建的卡整条带过来（卡 id 换算）；
 *   并进本机已有的卡（cardSig 判成同一张）：按键取并集、本机已有的键保留本机的值（character 按变量名，scripts 先按脚本 id 再按变量名，storage 按键；
 *   和全局变量的规矩一致，cardvars.js unionCardVars），在恢复的写入事务里做。空浏览器 = 按备份。
 * 删卡：和卡在同一个事务里删（archive.js deleteCard）。同名卡「更新」：卡 id 不变，cardvars 保留（脚本数据、小设置不丢）。
 * 导出卡（PNG / JSON、导出成酒馆目录）：【不写回】卡文件（2026-11-23 定的）。理由：卡文件只读，没改过的卡导出逐字不变是硬要求；
 *   运行时数据是「玩出来的状态」，像聊天记录一样不该跟着分享出去的卡走；要带走用整体备份。代价：导出给酒馆后，酒馆里的脚本从卡里的初值重新开始。
 *   export_with（单个脚本的导出开关）照旧只在「脚本」页导出单个脚本时生效。
 * 不发给模型（拼装、宏都不读它）；只有这张卡的前端卡（character）和脚本（character、自己的 script）读写得到。
 */

/**
 * 「允许直接操作页面」（脚本的直通模式，2026-11-24 起）：这台设备上对某张卡的信任记录。纯逻辑 src/script-trust.js，运行时 ui/script-host.js。
 * 存在 localStorage['smalltalk.scriptTrusted']（data-inventory.js LOCAL_STORAGE_PREFS），【不在】IndexedDB：不进整体备份、不随卡导出、恢复时不动。
 * @typedef {Object} ScriptTrust
 * @property {string} id      卡 id
 * @property {string[]} fp    打开开关那一刻启用脚本的代码指纹（每个 content 的 SHA-256 十六进制，去重排序；script-trust.js scriptFingerprint）
 *
 * 生效条件：有这条记录，且现在每个启用脚本的哈希都在 fp 里（trustCovers）。不满足 → script-host 删掉记录、提示一次，脚本回到沙箱。
 * 用户自己在「脚本」区保存代码时，如果保存前信任有效，保存后按新代码重记（tab-scripts.js saveDraft）——是用户自己写的，不算「没看过的新代码」。
 * 删卡时删记录（archive.js deleteCard → forgetTrust）。
 *
 * script-host.js 给界面的接口：
 *   trustedNow(cardId = 当前卡) → boolean   有记录且覆盖当前启用的脚本（只读，不删记录）
 *   setTrusted(on)                          对当前卡打开 / 关掉（打开 = 按现在启用的脚本记指纹），然后 restartScripts()
 *   forgetTrust(cardId)                     删记录（不重建：删卡时卡已经不在了）
 *   scriptSandboxInfo().trusted              现在跑着的是不是直通模式
 *
 * 直通模式的运行方式：同源、无 sandbox 的隐藏 iframe（挂在 <body> 下，1×1 透明），桩（script-stub.js）和沙箱同一份、协议同一套，
 * 只换传输：宿主挂在 iframe 元素上的桥 frameElement.__smalltalkBridge = {receive(msg), pull(), toStub}，不走 postMessage。
 * 脚本的 $ / jQuery 是在 iframe 里另装的一份、绑着主页面 window / document 的 jQuery（照酒馆助手：$ 指向酒馆页面）。
 * 拆的时候：移除 iframe（浏览器同步发 pagehide）→ 停掉颜色联动 → page-guard.js restorePage 把脚本加在 <html>/<head>/<body> 上和几个给脚本的空位里的东西清掉。
 *
 * 颜色联动（ui/theme-link.js，2026-11-27）：直通期间脚本改了 --SmartTheme* / --mainFontFamily / --mainFontSize，聊天一侧（#top-bar、#sheld）的我们的变量跟着变，
 * 内联写在这两个容器上，右侧面板不跟；拆的时候撤销。接口：startThemeLink() / stopThemeLink() / themeLinkInfo() → {active, styled, changed: 酒馆变量名[], applied}
 * （scriptSandboxInfo().themeLink）。只改界面外观，不碰任何存储。
 */

/**
 * png.js
 * @callback ReadCardFromPng
 * @param {Uint8Array} bytes  PNG 文件内容
 * @returns {Object}          卡的原始 JSON（优先 ccv3，其次 chara）；找不到则 throw
 *
 * card.js
 * @callback ParseCard
 * @param {Object} rawJson
 * @returns {Card}
 *
 * @callback ConvertCharacterBook      对应酒馆 world-info.js convertCharacterBook
 * @param {Object} characterBook       {name, entries:[...]}
 * @returns {WorldEntry[]}
 *
 * @callback ParseWorldbook            独立世界书文件 {entries: {"0": {...}}} → 数组，补齐默认值
 * @param {Object} rawJson
 * @param {string} bookName
 * @returns {WorldEntry[]}
 *
 * @callback DetectJsonKind            拖进来的 JSON 是什么
 * @param {Object} rawJson
 * @returns {'card'|'preset'|'worldbook'|'regex'|'unknown'}  regex = 单个脚本对象或脚本数组
 *
 * ── 导出（反方向）──
 * png.js
 * @callback WriteCardToPng            照酒馆 character-card-parser.js write：删掉旧的 chara / ccv3 tEXt 块（关键字不分大小写），
 *                                     在 IEND 前写 chara（cardJson 原样）和 ccv3（spec 改成 chara_card_v3 / 3.0）。不改输入。
 * @param {Uint8Array} pngBytes        必须是完整合法的 PNG（IHDR 开头、有 IEND、CRC 正确），否则 throw（中文说明）
 * @param {Object} cardJson            通常是 exportCardJson 的结果
 * @returns {Uint8Array}
 *
 * @callback DataUrlToBytes            'data:...;base64,...' → 字节（头像 state.avatar 就是这种）；不是 base64 data URL 则 throw
 * @param {string} dataUrl
 * @returns {Uint8Array}
 *
 * @callback IsPng                     字节是否以 PNG 文件头开始
 * @param {Uint8Array} bytes
 * @returns {boolean}
 *
 * card-export.js
 * @callback ExportCardJson            Card → 酒馆卡 JSON。以 card.raw 为底，只覆盖 card.worldEntries（→ data.character_book）
 *                                     和 card.regexScripts（→ data.extensions.regex_scripts，去掉 origin），
 *                                     以及和 raw 解析结果不同的文字字段（description / personality / scenario / mesExample →
 *                                     顶层 + data.*；systemPrompt / postHistoryInstructions → data.*；depthPrompt.prompt →
 *                                     data.extensions.depth_prompt.prompt，同酒馆 charaFormatData）；没改过的卡结果与 raw 相同。
 *                                     V1 卡只有在必须写世界书 / 正则 / 只有 data 里才有的字段时才升级成 V2。不修改 card.raw。
 *   卡的文字字段（description 等）存在 Card 上（从 raw 解析出来单存），「拼装」页就地编辑改的是它们，不改 raw。
 * @param {Card} card
 * @param {{stripPrivate?: boolean}} [options]  stripPrivate: 照酒馆导出时的 unsetPrivateFields（fav=false、删 chat），分享用
 * @returns {Object}
 *
 * @callback SerializeWorldbook        条目数组 → 酒馆独立世界书文件 {entries: {"<uid>": {...}}}；字段 = newWorldInfoEntryTemplate 默认值
 *                                     + 条目自身全部字段，去掉 book。文件里不写书名（酒馆用文件名当书名）。
 * @param {WorldEntry[]} entries
 * @returns {{entries: Object<string, Object>}}
 *
 * @callback SafeFileName              下载用的文件名：去掉 / ? < > \ : * | " 和控制字符、首尾空格和点，Windows 保留名前加 _，
 *                                     按 UTF-8 截到 200 字节，中文和 emoji 保留；空了用 fallback
 * @param {string} name
 * @param {string} [ext]               'png' 或 '.png' 都行
 * @param {string} [fallback='未命名']
 * @returns {string}
 */

// ───────────────────────────── 世界书 worldinfo.js ─────────────────────────────

/**
 * 世界书条目，字段名与酒馆 world-info 文件一致（见 world-info.js newWorldInfoEntryDefinition）。
 * 值为 null 的字段表示「用全局设置」。
 * @typedef {Object} WorldEntry
 * @property {number} uid
 * @property {string[]} key            主关键词；"/pattern/flags" 形式按正则处理
 * @property {string[]} keysecondary
 * @property {string} comment          条目标题
 * @property {string} content
 * @property {boolean} constant        常驻（蓝灯）
 * @property {boolean} selective
 * @property {0|1|2|3} selectiveLogic  0 AND_ANY, 1 NOT_ALL, 2 NOT_ANY, 3 AND_ALL
 * @property {number} order
 * @property {0|1|2|3|4|5|6|7} position  0 角色定义前, 1 角色定义后, 2 AN 上, 3 AN 下, 4 @深度, 5 示例前, 6 示例后, 7 outlet
 * @property {number} depth            position=4 时使用
 * @property {0|1|2|null} role         position=4 时使用：0 system, 1 user, 2 assistant；null 当作 0
 * @property {boolean} disable
 * @property {number} probability      0-100
 * @property {boolean} useProbability
 * @property {number|null} scanDepth
 * @property {boolean|null} caseSensitive
 * @property {boolean|null} matchWholeWords
 * @property {boolean} excludeRecursion      递归轮次里不能被激活
 * @property {boolean} preventRecursion      自己的内容不进递归缓冲
 * @property {boolean|number} delayUntilRecursion
 * @property {string} outletName       position=7 时使用
 * @property {string} book             来自哪本世界书（我们加的字段，用于界面显示）
 */

/**
 * @typedef {Object} WorldInfoSettings
 * 界面已隐藏 recursive / caseSensitive / matchWholeWords / includeNames，拼装时固定为酒馆默认（开 / 关 / 开 / 开），
 * 忽略存储里的旧值（2026-11-22 用户定，见 worldinfo.js effectiveWiSettings）；只有 scanDepth 还可调。
 * @property {number} [scanDepth=2]            扫描最近几楼
 * @property {boolean} [recursive=true]
 * @property {number} [maxRecursionSteps=0]    0 = 不限（内部仍需防死循环）
 * @property {boolean} [caseSensitive=false]
 * @property {boolean} [matchWholeWords=false]
 * @property {boolean} [includeNames=true]     扫描文本是否写成 "name: content"
 */

/**
 * @typedef {Object} WorldInfoActivation
 * @property {WorldEntry} entry
 * @property {'constant'|'key'} reason
 * @property {string} [matchedKey]         命中的主关键词
 * @property {string[]} [matchedSecondary] 参与判定的次要关键词
 * @property {number} pass                 第几轮扫描命中：0 = 首轮，>=1 = 递归
 */

/**
 * @typedef {Object} WorldInfoSkip
 * @property {WorldEntry} entry
 * @property {'disabled'|'no-key-match'|'secondary-failed'|'probability'} reason
 *   （以前还有 'unsupported-position'：作者注释上 / 下的条目。做了作者注释之后它们照常激活，不再出现在 skipped 里）
 */

/**
 * 一组 @深度 条目（同 depth 同 role 合并成一段）。
 * @typedef {Object} WorldInfoDepthGroup
 * @property {number} depth
 * @property {Role} role
 * @property {string} content       已按顺序用 \n 拼好
 * @property {WorldEntry[]} entries 组成它的条目，顺序与 content 一致
 */

/**
 * @typedef {Object} WorldInfoResult
 * @property {string} before                 position 0，已用 \n 拼好（未套 wi_format）
 * @property {string} after                  position 1
 * @property {WorldEntry[]} beforeEntries    组成 before 的条目，顺序与文本一致
 * @property {WorldEntry[]} afterEntries
 * @property {string[]} [beforeContents]     组成 before 的各条目宏替换之后的文字（与 beforeEntries 一一对应）；assemble.js 用它逐条对齐出处
 * @property {string[]} [afterContents]      同上，after
 * @property {WorldInfoDepthGroup[]} depth   position 4（每组另有 contents：各条目替换后的文字，与 entries 一一对应）
 * @property {string[]} examplesBefore       position 5，每个条目一项
 * @property {string[]} examplesAfter        position 6
 * @property {string[]} anTop                position 2「作者注释上」，每个条目一项，已是最终顺序（order 小的在上）
 * @property {WorldEntry[]} anTopEntries     与 anTop 一一对应
 * @property {string[]} anBottom             position 3「作者注释下」
 * @property {WorldEntry[]} anBottomEntries
 *   这两组只在这一轮插作者注释时才发（assemble.js「作者注释」、author-note.js 文件头）；不插的轮次照样算激活过
 * @property {Record<string, string>} outlets  position 7，outletName → 拼好的文本
 * @property {WorldInfoActivation[]} activated
 * @property {WorldInfoSkip[]} skipped
 */

/**
 * worldinfo.js
 * @callback ScanWorldInfo
 * @param {Object} args
 * @param {WorldEntry[]} args.entries
 * @param {ChatMessage[]} args.chat                 旧 → 新，包含用户刚发的那一楼
 * @param {WorldInfoSettings} [args.settings]
 * @param {(text: string) => string} [args.substitute]  宏替换，用于关键词和条目内容；默认原样返回
 * @param {() => number} [args.rng]                 默认 Math.random；测试里传固定值
 * @returns {WorldInfoResult}
 */

// ───────────────────────────── 宏 macros.js ─────────────────────────────

/**
 * @typedef {Object} MacroContext
 * @property {string} user
 * @property {string} char
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 * @property {string} [persona]
 * @property {string} [mesExamples]
 * @property {string} [original]            {{original}}，只替换一次
 * @property {ChatMessage[]} [chat]         供 lastMessage 等使用
 * @property {Variables} [variables]        会被原地修改
 * @property {Record<string, string>} [outlets]  {{outlet::name}}
 * @property {Date} [now]
 * @property {() => number} [rng]
 * @property {string} [seed]                「按存档固定」的随机种子（pipeline.js macroContext 给的是 `卡id:存档id`）。
 *   {{pick}} 用它 + 原文哈希 + 偏移取值（对应酒馆的 chatIdHash）；没有（单元测试、还没存档）时只用原文哈希 + 偏移（旧行为）。
 * @property {string} [authorsNote]         {{authorsNote}} 的值：当前存档作者注释的正文原文（酒馆 authors-note.js ~L606）。没有 = ''
 * @property {boolean} [stableRandom]       true：{{random}} / {{roll}} 也改用 seed + 原文哈希 + 偏移的确定性取值（GlobalRecord.stableRandom，酒馆没有）；
 *   此时忽略 rng。false / 省略：照旧用 rng（每次都变，和酒馆一致）
 */

/**
 * macros.js
 * @callback Substitute
 * @param {string} text
 * @param {MacroContext} ctx
 * @returns {string}
 */

// ───────────────────────────── 正则 regex.js ─────────────────────────────

/**
 * 正则脚本，字段与酒馆导出的 JSON 一致。
 * @typedef {Object} RegexScript
 * @property {string} id
 * @property {string} scriptName
 * @property {string} findRegex        "/body/flags" 或裸字符串
 * @property {string} replaceString
 * @property {string[]} trimStrings
 * @property {number[]} placement      1 用户输入, 2 AI 输出, 3 斜杠命令, 5 世界书, 6 推理
 * @property {boolean} disabled
 * @property {boolean} markdownOnly    只影响显示
 * @property {boolean} promptOnly      只影响发给模型的内容
 * @property {boolean} runOnEdit
 * @property {0|1|2} substituteRegex   0 不替换宏, 1 原样替换, 2 替换并转义
 * @property {number|null} minDepth
 * @property {number|null} maxDepth
 * @property {'global'|'preset'|'card'} [origin]  我们加的字段：来源
 */

/**
 * @typedef {Object} RegexRunOptions
 * @property {number} placement              本次调用的位置（1 / 2 / ...）
 * @property {boolean} [isMarkdown=false]    为显示而调用
 * @property {boolean} [isPrompt=false]      为拼 prompt 而调用
 * @property {boolean} [isEdit=false]
 * @property {number} [depth]                楼层深度；不传则不做深度过滤
 * @property {(text: string) => string} [substitute]  宏替换；默认原样返回
 * @property {(info: {script: RegexScript, before: string, after: string}) => void} [onApply]  每条脚本实际改动文本时回调，供界面展示
 */

/**
 * regex.js
 * @callback RunRegexScripts
 * @param {string} text
 * @param {RegexScript[]} scripts   调用方已按「全局 → 预设 → 角色卡」排好序
 * @param {RegexRunOptions} options
 * @returns {string}
 *
 * @callback RegexFromString       对应酒馆 utils.js regexFromString
 * @param {string} input
 * @returns {RegExp|undefined}
 */

// ───────────────────────────── 拼装 assemble.js ─────────────────────────────

/**
 * 预设：就是酒馆 OpenAI 预设的原始 JSON，不做转换。
 * 关键字段：prompts[]、prompt_order[]、squash_system_messages、names_behavior、wi_format、
 * scenario_format、personality_format、new_chat_prompt、new_example_chat_prompt、send_if_empty、
 * assistant_prefill、extensions.regex_scripts。
 * @typedef {Object} Preset
 */

/**
 * 一条输出消息里某一段内容的出处。
 * @typedef {Object} Source
 * @property {'prompt'|'marker'|'chat'|'worldinfo'|'depthPrompt'|'example'|'utility'|'prefill'|'memory'|'authorNote'} kind
 *   prompt       预设里的普通条目（含被注入到聊天记录里的绝对位置条目）
 *   marker       预设里的占位条目被填上了内容（角色描述、persona 等）
 *   chat         聊天记录里的一楼
 *   worldinfo    世界书（before/after 标记，或 @深度 条目）
 *   depthPrompt  角色卡自带的深度提示
 *   example      示例对话
 *   utility      new_chat_prompt / new_example_chat_prompt / send_if_empty 这类工具提示
 *   prefill      assistant_prefill
 *   memory       外置记忆（app.js 在 assemble 之后插入的；assemble 本身不产生）
 *   authorNote   这个存档的作者注释正文（id 'authorNote'）。和它拼在一起的世界书「作者注释上 / 下」条目仍是 worldinfo
 * @property {string} id      预设条目的 identifier / 楼层号 / 世界书 uid 等
 * @property {string} label   给人看的名字
 * @property {number} chars   这一段的字符数
 * @property {number} [depth] 若是按深度注入的，注入深度
 * @property {'system_prompt'|'post_history_instructions'} [cardField]  kind 'prompt' 且这段是角色卡覆盖 main / jailbreak 的内容时：
 *   原文来自卡的哪个字段（「拼装」页就地编辑用，src/ui/prompt-edit.js）
 * @property {string} [book]  kind 'worldinfo' 且能逐条对齐时：条目所在的书名（WorldEntry.book；和 id = uid 一起认出是哪一条）
 */

/**
 * @typedef {Object} AssembledMessage
 * @property {Role} role
 * @property {string} content
 * @property {string} [name]
 * @property {Source[]} sources  合并（同深度同角色合并、squash）后一条消息可能有多个出处，顺序与 content 一致
 *
 * 「拼装」页的字数统计（src/prompt-stats.js）只读 sources：按 kind（marker 再按 id）归成
 * 预设 / 角色卡 / persona / 世界书 / 聊天 / 记忆 / 其它，各段之间的 '\n' 记为「连接符」。
 * 所以新增 Source.kind 或 marker id 时，要同步改 prompt-stats.js 的 categoryOf，否则会落进「其它」。
 */

/**
 * @typedef {Object} AssembleLogEntry
 * @property {'info'|'warn'} level
 * @property {string} message   例如「main 被角色卡 system_prompt 覆盖」「条目 xxx 未启用，跳过」
 */

/**
 * 有上下文上限时 assemble 多返回的预算结果。token 数都是估算。
 * @typedef {Object} AssembleBudget
 * @property {number} limit        openai_max_context（或自定义的上限）
 * @property {number} reply        给回复预留的 openai_max_tokens
 * @property {number} available    limit − reply
 * @property {number} used         实际占用 = Σ spent
 * @property {{primer: number, reserved: number, fixed: number, utility: number, chat: number, examples: number}} spent
 *   primer 回复开头固定的 3；reserved 调用方先占的（外置记忆块）；fixed 非聊天内容；
 *   utility new_chat_prompt + send_if_empty；chat 聊天记录（含按深度注入的条目）；examples 示例对话
 * @property {boolean} overflow    非聊天内容本身就超出了预算（这时聊天记录一楼都不发）
 * @property {number|null} droppedFrom   因超出预算没发的楼层：从第几楼（完整聊天记录里的楼层号，已加 chatOffset）
 * @property {number|null} droppedTo     到第几楼（含）。丢的总是最老的连续若干楼，所以 droppedFrom 就是传进来的第一楼
 * @property {number} droppedCount
 * @property {number} keptCount          传进来的楼层里没因预算丢掉的楼数
 * @property {number} droppedInjected    跟着被丢的按深度注入的消息条数
 * @property {number} droppedExamples    没发的示例块数
 * @property {boolean} droppedSendIfEmpty
 */

/**
 * assemble.js
 * @callback Assemble
 * @param {Object} args
 * @param {Preset} args.preset
 * @param {Card} args.card
 * @param {{name: string, description: string}} args.persona
 * @param {ChatMessage[]} args.chat                旧 → 新
 * @param {WorldInfoResult} args.worldInfo         调用方先跑完 scanWorldInfo 再传进来
 * @param {Variables} args.variables               会被原地修改（setvar）
 * @param {(msg: ChatMessage, depth: number) => string} [args.transformChat]
 *        聊天记录每一楼入 prompt 前的改写钩子（调用方在这里跑 promptOnly 正则）；默认返回 msg.content
 * @param {Date} [args.now]
 * @param {() => number} [args.rng]
 * @param {string} [args.macroSeed]     传给宏的 MacroContext.seed（pipeline.js 给 `卡id:存档id`）；不传 = {{pick}} 只看原文 + 偏移
 * @param {boolean} [args.stableRandom] 传给宏的 MacroContext.stableRandom
 * @param {number} [args.chatOffset]   chat[0] 在完整聊天记录里是第几楼（外置记忆截掉了前面的楼层时传）；
 *        只影响 Source.id（kind 'chat'）、日志和 budget 里的楼层号。默认 0
 * @param {number[]} [args.chatFloors]  chat[k] 在完整聊天记录里是第几楼（去掉了隐藏楼层，楼层号不再连续时传；给了就不看 chatOffset）。
 *        同样只影响楼层号；另外「开场白先替换一次」只对真正的第 0 楼做（chatFloors[0] === 0；没给 chatFloors 时 chatOffset === 0）
 * @param {ChatMessage[]} [args.macroChat]  宏（{{lastMessage}} 等）看到的聊天记录。默认 = chat。
 *        调用方传完整记录（含隐藏楼层、含被外置记忆折叠的楼层）：酒馆的这些宏读的是整个 chat，不是 coreChat
 * @param {Object} [args.authorNote]  这个存档的作者注释（ChatRecord.authorNote；不传 / 坏值 = 内置默认：空正文、每次都插、聊天内深度 4、system）。
 *        「这一轮插不插」按 macroChat（完整记录）里的用户消息数算；插的时候连同 worldInfo.anTop / anBottom 一起拼。规则见 author-note.js 文件头
 * @param {{maxContext: number, maxTokens: number, reserved?: number}|null} [args.contextLimit]
 *        上下文上限（酒馆的 openai_max_context / openai_max_tokens）。不传或 null = 不限，输出与没有这个功能时逐字节相同。
 *        reserved：调用方要另外插进去、但必须先占预算的 token 数（外置记忆块）。调用方用 resolveContextLimit 从设置 + 预设算出来
 * @param {(text: string) => number} [args.estimateTokens]  字数 → token 的估算函数，默认 tokens.js 的 estimateTokens
 * @returns {{messages: AssembledMessage[], log: AssembleLogEntry[], budget?: AssembleBudget}}  budget 只在有上限时才有
 *
 * 预算规则（详见 assemble.js 文件头「上下文预算」）：非聊天内容先占，聊天记录（连同按深度注入的条目）从新到旧放，
 * 放不下就停；示例对话用剩下的。只影响这一次发送，聊天记录本身一楼不删。
 *
 * 宏的求值顺序很重要：按 prompt_order 列表顺序逐条求值、共享同一个 variables，
 * 这样前面条目里的 {{setvar}} 才能被后面条目的 {{getvar}} 读到。未启用的条目不求值。
 */

// ───────────────────────────── 渲染 render.js ─────────────────────────────

/**
 * iframe 前端卡 → 宿主页面的桥。前端卡里调用的酒馆 / 酒馆助手 API 会通过 postMessage 落到这里。
 * @typedef {Object} FrameHost
 * @property {(method: string, args: any[], messageId: number) => any|Promise<any>} call
 *           处理一次 API 调用；不认识的方法 throw 或返回 undefined 均可。args 就是卡传来的参数，不追加任何东西
 *           （ui/frame-host.js 把 messageId 包成上下文 {kind:'message', messageId} 交给宿主方法；脚本沙箱用 {kind:'script', cardId, scriptId}，见那个文件头）
 * @property {(entry: {messageId: number, level: 'call'|'unimplemented'|'error'|'console', text: string}) => void} log
 *
 * 日志条目（ui.frameLog，「杂项」页和「脚本」页共用一份，最多 500 条）：前端卡 {time, messageId, level, text}；
 * 酒馆助手脚本 {time, scriptId（认不出是哪个脚本时为 null）, scriptName, cardId, level, text}。level 还可能是 'warn' / 'unsupported'（脚本用：SmallTalk 做不到的事）
 */

/**
 * render.js
 * @callback FormatMessage         纯字符串变换，不碰 DOM 以外的全局状态
 * @param {string} text            已经跑完显示正则的文本
 * @returns {string}               净化后的 HTML
 *
 * @callback MountMessage          把 HTML 放进容器，并把其中的前端卡 <pre> 升级成沙箱 iframe
 * @param {HTMLElement} container
 * @param {string} html            formatMessage 的输出
 * @param {{messageId: number, host: FrameHost}} options
 * @returns {void}
 */

// ───────────────────────────── 模型 llm.js / server.mjs ─────────────────────────────

/**
 * llm.js
 * @callback Generate
 * @param {{role: Role, content: string, name?: string}[]} messages
 * @param {{onDelta?: (textSoFar: string) => void, signal?: AbortSignal, model?: string, promptCache?: boolean}} [options]
 *   promptCache：false = 不加提示缓存标记（GlobalRecord.promptCache）；请求体里只在 false 时才带 promptCache: false
 * @returns {Promise<string>}  完整回复
 *
 * @callback CheckHealth
 * @returns {Promise<{ok: boolean, claudePath: string|null, error?: string}>}
 *
 * HTTP 接口（server.mjs，仅监听 127.0.0.1）：
 *   GET  /api/health    → {ok, claudePath, error?}
 *   POST /api/generate  请求体 {messages, model?, promptCache?: false}；响应为分块纯文本流（text/plain; charset=utf-8），
 *                        promptCache 没带 = 开：OpenAI 兼容接口经 OpenRouter 调 anthropic/ 模型时，转发前加 1 小时缓存标记
 *                        （openai-shared.js applyPromptCache；网页版 llm-direct.js 同一条规则）；别的接口 / 模型请求体不变。
 *                        出错时状态码非 2xx，响应体为 {error}
 */

// ───────────────────────────── 存储 store.js ─────────────────────────────

/**
 * store.js：IndexedDB 上的键值封装，值用结构化克隆（可以存对象 / Blob）。
 * @callback StoreGet   @param {string} key  @returns {Promise<any>}  不存在返回 undefined
 * @callback StoreSet   @param {string} key  @param {any} value  @returns {Promise<void>}
 * @callback StoreDel   @param {string} key  @returns {Promise<void>}
 * @callback StoreKeys  @param {string} [prefix]  @returns {Promise<string[]>}
 */

// ═════════════════════════════ 第二阶段 ═════════════════════════════

// ───────────────────────────── 多卡多存档 ─────────────────────────────
//
// 三层：卡 → 存档（每张卡可以有多个）；另有一层全局。
// 运行时的 `state`（见 app 的状态模块）形状不变：state.card / state.avatar / state.chat / state.variables
// 永远指向「当前卡的当前存档」。存档层只负责：启动时把当前卡和存档装进 state、改动后写回各自的键、切换。
// 这样拼装、渲染、记忆这些模块完全不用知道有多卡多存档这回事。
//
// IndexedDB（库 smalltalk，表 kv）的键布局，schema 版本 2：
//   'meta'                     → StoreMeta
//   'global'                   → GlobalRecord
//   'card:<cardId>'            → CardRecord
//   'chat:<cardId>:<chatId>'   → ChatRecord
//   'preset:<presetId>'        → PresetRecord（多预设，后加的；global 里只存 activePresetId）
// 版本 1 是单独一个键 'state'（把上面所有东西打包在一起）。迁移规则见 MigrateV1。
//
// 实现过程中追加的（数据丢失复核之后）：
//   'cardvars:<cardId>' → CardVars（酒馆助手脚本的运行时数据：脚本变量、角色卡变量；2026-11-23 第 2 期加，见 CardVars）
//   'index:<cardId>'  → {cardId, chats: {[chatId]: {name, count, updatedAt, createdAt}}}
//                       每张卡的存档目录，和存档写入在同一个事务里维护；缺失或对不上时自动重建
//   'state.v1.bak'    → 迁移时旧数据里有认不出的内容才会写：旧 state 的完整备份，不会被自动删除
//   StoreMeta.v1Fingerprint   已迁移过的旧 state 的指纹，用来识别「旧版本标签页又写了一次 state」
//   CardRecord.usedAt         上次使用时间（ISO），卡片切换器排序用
//   ChatRecord.greeting       {index, text, vars}：这个存档是用哪条开场白建的，用来判断它是否「没动过」
//   MigrateV1 的返回值多一个 discarded: string[]（被丢弃内容的说明；非空时调用方要留备份）
// 写入约束：同一个浏览器配置下同时只允许一个标签页写（Web Lock 'smalltalk-writer'），其余标签页只读。

/**
 * @typedef {Object} StoreMeta
 * @property {2} version
 * @property {string|null} activeCardId
 */

/**
 * 全局层：和哪张卡无关的东西。「当前用哪个预设」放这里（和酒馆一样，换卡不用重新选预设）。
 * 预设本体不在这里，在各自的 'preset:<id>'：发消息时会重写 global，不能每次把所有预设都重写一遍。
 * 运行时 state 上仍是 state.preset / state.presetName（指向当前预设），由 state.js 映射到 PresetRecord。
 * 旧形状（多预设之前）：没有 activePresetId 这个键，而是 preset: Preset|null + presetName: string。
 *   启动时升级：先写 'preset:<新id>' 并读回校验，成功后才把 global 改成新形状；失败则 global 原样不动，照旧用里面的预设。
 *   preset 为 null 时不建记录。重复执行时复用内容一字不差的已有记录，不会多出重复的预设（migrate.js planPresetMigration）。
 * @typedef {Object} GlobalRecord
 * @property {string|null} activePresetId  当前预设的 PresetRecord.id；null = 用内置默认预设（DEFAULT_PRESET）
 * @property {ExtraBook[]} books   额外导入的世界书（不是角色卡内嵌的那本）。开关 / 生效范围 / 绑定的规则见下面 ExtraBook
 * @property {RegexScript[]} globalRegex
 * @property {{name: string, description: string, remark?: string}} persona   永远是【当前人设】的副本；运行时 state.persona 的形状不变，其它模块只读它
 * @property {{id: string, name: string, description: string, remark?: string}[]} [personas]   多人设列表（可选，纯逻辑在 personas.js）
 *   remark（备注，2026-11-22 加）：只用来在「人设」页的列表上区分重名的人设；不发给模型，宏、拼装、前端卡都不读它。
 *     【默认不写】：空备注时对象上没有这个键（不用备注的人存储形状不变）。规范化（personas.js cleanRemark，读档 / 改 / 导入 / 恢复都走）：
 *     不是字符串 → 没有；换行类字符压成空格；去首尾空白；最长 MAX_REMARK（200）字，超出截掉。
 *     对应酒馆 power_user.persona_descriptions[头像].title（public/scripts/personas.js getUserAvatarBlock 读、editPersonaTitle 写），
 *     人设文件导入导出、酒馆整体备份 zip 导入都带着它。它是内容的一部分：判重时名字 + 描述 + 备注一起比。
 * @property {string} [activePersonaId]   personas 里当前那一项的 id
 *   这两个字段【默认不写】：只有一个人设时存储里只有 persona，和以前一模一样；用户新建第二个人设时才写入
 *   （现有 persona 变成第一项）。defaultGlobal() 不带它们——migrate.js 的 isPristineGlobal（备份的「空浏览器」判定也用它）
 *   靠「global 等于默认值」判断用户是否改过设置，给默认值加字段会弄坏它。
 *   对齐规则（读档和每次保存前，personas.js alignPersonas）：persona 与 personas 里当前项对不上时【以 persona 为准】，
 *   更新那一项（旧版本页面只改 persona 的情况）；activePersonaId 指向不存在的项时退回第一项（persona 也变成它的副本），列表不丢。
 *   删到只剩一个时两个字段照旧保留。整体备份导出整个 global，所以多人设自然跟着备份走。
 *   恢复整体备份到已有数据的浏览器：三个字段一起和本机的取并集（名字 + 描述 + 备注都相同的跳过；没有备注 = 空备注），本机当前人设永远不变，
 *   合并后仍只有一个人设时照旧不写 personas / activePersonaId。activePersonaId 是「当前在用的选择」：导出时不写进备份
 *   （导出前先 alignPersonas 把 persona 对齐进列表），恢复到空浏览器时当前人设 = 列表里第一个。
 * @property {Note[]} [notes]   便签（src/notes.js 纯逻辑，src/ui/tab-notes.js 界面，挂在「人设」页下方的「便签」一节；以前是单独的「便签」页签）。顺序就是显示顺序。
 *   【默认不写】：一条都没有时没有这个字段（删光了也把字段删掉），理由同 personas——不用便签的人存储形状不变，isPristineGlobal 不受影响。
 *   不发给模型（assemble / pipeline 不读它），前端卡的 iframe 也拿不到（frame-host.js 只暴露聊天和变量）。
 *   读档时（state.js setNotesField）过一遍 normalizeNotes：形状不对的条目丢掉、缺的补默认值、重复的 id 换新的。
 *   整体备份：跟着整个 global 走。恢复到已有数据的浏览器时【永远追加】（弹框怎么答都一样；backup.js unionContent，
 *   标题 + 内容相同的跳过——不看是否完成，保留本机那条的状态；id 撞了换新的）；空浏览器时按备份里的来（先规范化）。
 *   备份里没有 notes / 不是数组 = 备份里没有便签，本机的不动。
 *   单独的导出 / 导入：界面精简（2026-11-22）后界面上没有了（按钮只留「删除已完成」）。Markdown 任务列表的读写函数
 *   （notesToMarkdown / parseNotesMarkdown / mergeNotes，文件大小上限 MAX_NOTES_FILE_BYTES 2 MB）还在 notes.js 里。
 *   新增：多行文本块，一行一条（notes.js splitNoteLines：空行忽略）。
 * @property {true} [notesHideDone]   【已废弃】以前「便签」页的「隐藏已完成」开关（当前选择，不进整体备份）。2026-11-22 界面精简时去掉了：
 *   界面不再读写它，读到旧值忽略，不主动清理。仍在 OPTIONAL_GLOBAL_KEYS / SELECTION_KEYS 里，所以旧值照旧不进备份、存储里没有时 state 上也删掉。
 * @property {Record<string, string|number>} globalVariables   对应 Variables.global
 * @property {WorldInfoSettings} wi
 * @property {{enabled: boolean, model: string, keep: number, batch?: number, summaryLen?: number, mergeEvery?: number}} memory
 *   mergeEvery：「每 x 条记忆再次压缩」（记忆再压缩，src/memory-fold.js 文件头「合并段」）。属于「设置」，和 summaryLen 一样跟着 memory 进整体备份、
 *   恢复到已有数据时跟「外置记忆设置」那句问话走。【默认不写】= 不做（界面上留空 / 0 / 乱填都是删掉这个键）。
 *   读入容错 mergeEveryOf：不是正整数 = 0（不做），1–3 按 4，超过 200 按 200。改它不动已有的合并段，只影响之后的合并
 *   batch：外置记忆「攒一批再滑动」的批大小（src/memory-fold.js）。【界面已隐藏，固定 10（2026-11-22 用户定）】：
 *   运行时（ui/memory.js foldChat）一律按 MEMORY_BATCH_DEFAULT = 10 算，存储 / 整体备份里残留的别的值被忽略（不改写存储）；
 *   界面不会再写这个键。foldCut 本身仍认 memory.batch，只为让单元测试验证各种批大小。
 *   summaryLen：每条摘要的目标字数（写进压缩提示词「不超过 N 个字」）。属于「设置」：跟着 memory 一起进整体备份、恢复到已有数据时跟「外置记忆设置」那句问话走。
 *   【默认不写】：没有这个键 = 60（MEMORY_SUMMARY_LEN_DEFAULT，也就是这项设置出现之前写死的值）。读入容错：summaryLenOf——
 *   不是正整数一律当 60，超过 1000 按 1000。改它【不】让已有摘要作废，只影响之后压的
 * @property {true} [stableRandom]   「拼装」页的开关：{{random}} / {{roll}} 在同一存档里固定结果（见 MacroContext.stableRandom）。
 *   【默认不写】（OPTIONAL_GLOBAL_KEYS）：只认 true，关掉就删掉这个字段。属于「当前在用的选择」：不进整体备份，恢复时永不从备份拿
 * @property {false} [promptCache]   「拼装」页的开关：经 OpenRouter 调 Anthropic 模型时自动加 1 小时缓存标记（openai-shared.js applyPromptCache）。
 *   【默认不写】= 开；只有关掉时写 false（OPTIONAL_GLOBAL_KEYS），别的值一律当作开、下次保存时删掉。属于「当前在用的选择」：不进整体备份
 * @property {{mode: 'preset'|'custom'|'off', maxContext: number}} [contextLimit]
 *   上下文上限：'preset'（默认）跟随当前预设的 openai_max_context；'custom' 用 maxContext；'off' 不限。
 *   旧数据没有这个字段，读进来时用 state 里的默认值（migrate.js DEFAULT_CONTEXT_LIMIT；不在 defaultGlobal() 里）。只影响发送，不删聊天记录。
 *   页面第一次保存就会把默认值写进来，所以 isPristineGlobal 把「等于默认值的 contextLimit」视同没有
 * GlobalRecord 里【不该出现】card / avatar / chat / variables（migrate.js NON_GLOBAL_KEYS，属于当前卡 / 存档）和 __proto__ / constructor / prototype
 * （UNSAFE_KEYS）。万一存储里的 global 带着它们（手改的备份等），state.js 读档时跳过、不赋给 state；备份恢复在计划阶段就丢掉。
 * @property {boolean} manual
 * @property {string} model
 */

/**
 * 一本额外世界书（GlobalRecord.books 的元素）。纯逻辑在 src/books.js，界面在 src/ui/tab-world.js。
 * 世界书有两种：卡自带的（CardRecord 里的 card.worldEntries，只对这张卡生效，没有下面这些字段，只有一个整本的开关 Card.worldDisabled）和额外世界书（这里）。
 * 两种书的名字也不该重：「世界书」页按「书名 + uid」对触发结果，改名时也查卡自带那本的名字（ui/tab-world.js renameBook）。
 * 对应酒馆的三种「选中」：全局选中的世界书（settings.json world_info_settings.world_info.globalSelect）≈ 启用 + scope 'all'；
 * 角色卡绑定的主世界书（卡的 data.extensions.world）≈ 启用 + scope 'cards' + cards 里有那张卡；聊天绑定的（chat_metadata.world_info）没有对应。
 * @typedef {Object} ExtraBook
 * @property {string} name          书名。额外世界书之间不重名（导入同名文件 = 替换、导出文件名、条目上的 book 都用它）；改名时重名会被拒绝
 * @property {WorldEntry[]} entries
 * @property {false} [enabled]      false = 关掉，对谁都不生效。【缺省 = 启用】：只有关掉时才写；读档时 false 以外的值（true / 字符串 / 数字……）一律当作启用
 * @property {'cards'} [scope]      'cards' = 只对 cards 里的卡生效。【缺省 = 'all'，对所有聊天生效】：只有 'cards' 时才写；别的值一律当作 'all'
 * @property {string[]} [cards]     绑定的卡（CardRecord.id）。scope 为 'cards' 时一定有（可以是 [] = 没有绑定任何卡 = 对谁都不生效）；
 *                                  scope 为 'all' 时只有非空才留着（记住以前绑过的卡，切回「只对指定的卡」不用重绑）。
 *                                  读档时不是数组当作 []，里面不是字符串 / 空串的丢掉，重复的只留一个
 *   为什么要显式的 scope，不用「cards 为空 = 所有聊天」：绑定的卡被删光时，这本书必须变成对谁都不生效，而不是悄悄变成对所有聊天生效。
 *   默认值时三个字段都不写：没用过这个功能的人，存储里的书和以前一模一样（规范化在 books.js normalizeBookScope，migrate.js cleanBooks 调它，
 *   读档 normalizeGlobal、恢复备份都经过这里）。
 *   是否生效（books.js isBookActiveFor，ui/pipeline.js allEntries 用它挑参与拼装的书）：enabled !== false 且（scope 不是 'cards' 或 cards 含当前卡 id）。
 *     当前卡 = persist.cardId；还没有任何卡时只有 scope 'all' 的书生效。不生效的书不参与世界书扫描，「世界书」页照样能看能改。
 *   删卡（ui/archive.js deleteCard）：所有书的 cards 里去掉这张卡的 id（books.js unbindCardFromBooks），和删卡在同一个事务里写 global；
 *     变空的书保持 scope 'cards'，不删、不变成所有聊天。
 *   导入单个世界书文件：全新的书 = 启用、所有聊天（不写这三个字段），排在最后；和已有的书同名 = 【只换条目】，
 *     旧书的开关、范围、绑定、在列表里的位置都保留（books.js replaceBookEntries；用户把它设成「只对卡 A」后拖入更新过的文件，不该突然对所有聊天生效）。
 *   酒馆整体备份 zip：按酒馆里的关系定（tavern-convert.js applyWorldRules，见「和酒馆整体互通」一节）。
 *   整体备份：三个字段跟着书走（是内容的一部分）。恢复时判重不看它们（books.js bookContent：去掉 name、这三个字段、条目上的 book）；
 *     重复时保留本机那本和它的开关、范围，备份里那本 scope 'cards' 的绑定换算成本机的卡 id 后并进本机那本的 cards（本机那本也是 'cards' 时）；
 *     新加进来的书（含空浏览器）cards 按卡 id 的映射换算（backup.js planBackupImport 的 cardIdMap），映射不到的丢掉。
 *   导出成酒馆格式（单本导出、tavern-convert.js buildTavernExport）：只序列化 entries，不带这三个字段（酒馆不认）。
 *     不会因为一本书只绑定了某张卡就去改那张卡导出时的 extensions.world（那会改动卡的原始数据）。
 */

/**
 * 一条便签（GlobalRecord.notes 的元素，src/notes.js）。
 * 认识的是下面六个字段；不认识的字段（以后的版本加的）规范化时原样带着（只挡 __proto__ / constructor / prototype），
 * 旧版本打开、保存一次不会把它们丢掉。Markdown 导出只写标题、内容、是否完成。
 * @typedef {Object} Note
 * @property {string} id          我们生成的 id
 * @property {string} title       单行：\r \n、U+2028 / U+2029、U+0085、\v、\f 都压成空格（notes.js oneLine，新增 / 改标题 / 读档 / 导入 / 导出都用它）。
 *                                可以是空的（编辑时清空了）：Markdown 里写成「- [ ]」，读回来仍是空标题
 * @property {string} body        详细内容，多行，可以为空
 * @property {boolean} done       打勾了没有
 * @property {number} createdAt   毫秒时间戳
 * @property {number|null} doneAt 打勾的时间（毫秒时间戳）；没完成时为 null
 */

/**
 * 「用户数据清单」（src/data-inventory.js，代码 + 注释）：全局记录的每个字段、以及全局记录以外的每一种存储键，
 * 各登记一行：是什么、哪一类、进不进整体备份、恢复到已有数据的浏览器时怎么处理、有没有单独的导出导入。
 * test/data-inventory.test.mjs 会核对「实际会出现的全局字段」和清单一一对应（新加字段没登记 → 测试失败）。
 * 「全局字段有哪些」的来源：运行时 state 的初值（globalFromState / toGlobalV2 写出来的那些）+ migrate.js 的 OPTIONAL_GLOBAL_KEYS
 *（只在用到时才写进 global 的字段：personas / activePersonaId / notes / notesHideDone）。新加一个「默认不写」的全局字段时，要加进 OPTIONAL_GLOBAL_KEYS。
 * 清单里每个全局字段还分三类：「内容」（kind 'content'：恢复整体备份时永远取并集）、「设置」（'setting'：只有三样，恢复时问一句、答「是」才用备份的）、
 *「当前在用的选择」（'selection'：不进备份、永不从备份拿、空浏览器用默认值）。规则的代码在 backup.js「全局记录的三类字段」一节。
 */

/**
 * 一个保存下来的预设。导入预设文件 = 新增一条并切过去（同名不合并，名字后加「 (2)」区分）。
 * 预设页里对条目的开关 / 排序 / 编辑 / 增删改的是当前这条；只改内容时只写这一个键，切换预设时只写 global。
 * 在内置默认预设上第一次改动时，自动存成一条新记录（名为「默认预设（已修改）」）。
 * @typedef {Object} PresetRecord
 * @property {string} id         我们生成的 id，不是名字——同名预设可以并存
 * @property {string} name       给人看的名字，可改；导出文件名用它
 * @property {Preset} preset     酒馆预设的原始 JSON，不转换（导出就是把它原样下载）——唯一的例外是下面的清洗
 * @property {string} createdAt  ISO 时间
 * @property {string} updatedAt  内容或名字最后一次改动的时间
 *
 * 预设本体的清洗（src/preset-sanitize.js、migrate.js cleanPresetBody）：酒馆保存预设时会把连接信息写进去
 * （反代地址 reverse_proxy、反代密码 proxy_password、custom_url、附加请求头 / 请求体……，清单见 SENSITIVE_PRESET_FIELDS，另有按字段名的兜底规则）。
 * SmallTalk 不用它们（接口在「接口」页单独配置），所以：
 *   - 进入系统的每个入口都去掉它们：导入预设文件（importer.js）、酒馆 zip（tavern-convert.js）、整体备份恢复（backup.js planBackupImport，
 *     含旧形状 global.preset）、旧格式迁移（normalizeGlobal / planPresetMigration）、读档（state.js applyPresetRecord 装进内存时）；
 *     同时校正预设自带正则（extensions.regex_scripts）的字段类型；
 *   - 打开页面时（有写权限）把存储里每条 preset:* 的这些字段删掉写回（state.js scrubStoredPresets，只删清单里的顶层字段）；
 *   - 所有导出出口再去一遍：「预设」页的导出、整体备份 buildBackup、导出成酒馆目录 buildTavernExport；exportSelfCheck 还有第四类 'preset-sensitive' 兜底。
 * 只看顶层字段，不往 prompts / extensions 里钻。提示里只说类别，不出现值。
 */

/**
 * @typedef {Object} CardRecord
 * @property {string} id            我们生成的 id（uuid），不是卡名——同名卡可以并存
 * @property {Card} card           卡自带世界书的整本开关在这里面（Card.worldDisabled），跟着 state.card 一起存，不在 raw 里
 * @property {string} avatar        data URL，没有则 ''
 * @property {string} createdAt     ISO 时间
 * @property {string|null} activeChatId  这张卡上次停在哪个存档
 */

/**
 * @typedef {Object} ChatRecord
 * @property {string} id
 * @property {string} cardId
 * @property {string} name          给人看的名字，默认「角色名 - 日期时间」，可改
 * @property {string} createdAt     ISO 时间
 * @property {string} updatedAt
 * @property {ChatMessage[]} messages   旧 → 新。每轮的记忆摘要就挂在消息上（ChatMessage.memory）
 * @property {Record<string, string|number>} variables   对应 Variables.local（酒馆的 chat_metadata.variables）
 * @property {Object} [stHeader]    从酒馆 jsonl 导入时首行里我们不认识的字段，原样保留，导出时放回去
 * @property {{prompt: string, interval: number, depth: number, position: 0|1|2, role: 0|1|2}} [authorNote]
 *   这个存档的作者注释（2026-11-22 加；纯逻辑 src/author-note.js，界面 src/ui/author-note.js，拼装 assemble.js「作者注释」）。
 *   字段名 = 酒馆 authors-note.js metadata_keys 的键（prompt ↔ chat_metadata.note_prompt，interval ↔ note_interval……），
 *   取值照酒馆的数字编码：position 0 在主提示之后 / 1 聊天内 @深度 / 2 在主提示之前；role 0 system / 1 user / 2 assistant。
 *   【默认不写】：五个字段都等于内置默认值（空正文、interval 1、depth 4、position 1、role 0；AUTHOR_NOTE_DEFAULTS）时没有这个键——
 *     不用作者注释的人存储形状不变。改动时（state.js setAuthorNote）先规范化，变回默认就删掉。
 *   读入容错（author-note.js normalizeAuthorNote）：不是对象 / 某个字段类型或范围不对 → 那个字段用默认值；页面打开时（state.js applyCardChat）
 *     规范化后放进 persist.chatMeta，存储里的坏值等下次写这条记录时被换掉。
 *   运行时：当前存档的在 persist.chatMeta.authorNote（state 的形状不变），pipeline.js 读它传给 assemble。
 *   它算存档的【内容】：整体备份跟着存档走；判重（backup.js chatSig）在名字 + 消息 + 变量之外加上它——但只在规范化后不是默认值时才加，
 *     所以没有作者注释的存档（包括所有旧备份里的）签名和以前逐字相同。恢复时新加进来的存档的 authorNote 也规范化（默认值就删掉）。
 *   聊天文件（.jsonl）：导入时从头的 chat_metadata 里读那五个键（note_* 原值仍留在 stHeader 里），导出时写回（规则见 author-note.js writeNoteMetadata）。
 *   前端卡【读不到也改不了】它：frame-host.js 只给聊天记录和变量；酒馆助手里有没有对应接口没查，这次不做。
 *   宏 {{authorsNote}} 读的是它的正文原文（macros.js）。
 *   角色卡专属注释、默认作者注释（酒馆 settings.json 的 extension_settings.note）不做，见 author-note.js 文件头。
 */

/**
 * ChatMessage 在第二阶段新增的可选字段（基础定义在文件开头）：
 * @typedef {Object} ChatMessageExtra
 * @property {string} [sendDate]  ISO 时间
 * @property {string[]} [swipes]  这一楼的所有候选回复（酒馆的 swipes）。只在 AI 回复上有意义；swipes[swipeId] 是 content 的副本。
 *                                 content 才是当前候选的唯一真相：任何 swipe 操作之前、以及导出时，先把 content 写回 swipes[swipeId]。
 *                                 我们生成的回复一写完就带上 [content]（同酒馆 saveReply）；没有时等同于 [content]。
 * @property {number} [swipeId]   当前显示 / 发送的是第几个候选（酒馆的 swipe_id），0 起
 * @property {Object[]} [variables]   楼层变量（酒馆助手 getVariables({type:'message'})、getChatMessages 返回的 data；酒馆聊天文件每行的 variables），
 *                                 每个候选一份，下标同 swipes。【默认不写】：前端卡 / 脚本第一次写这一楼的楼层变量时才有（script-sync.js setMessageVars）。
 *                                 从酒馆 .jsonl 导入的消息原来的值在 st.variables 里：读的时候两处都认，第一次写时从 st 提升到这里；导出 .jsonl 时写回 variables。
 *                                 不发给模型，不碰记忆（改它不作废摘要）
 * @property {Object} [st]        从酒馆 jsonl 导入时这一行里我们不认识的字段（swipe_info、force_avatar、
 *                                 插件数据、extra 里的其它键……），原样保留，导出时放回去。
 *                                 例外：swipe 操作会读写 st.swipe_info / st.extra / st.send_date 等（每个候选各一份，照酒馆换进换出），
 *                                 规则见 src/chatfile.js 的 swipe 小节。
 *                                 老存档（导入时还没拆出 swipes）的 swipes / swipe_id 仍在 st 里：readSwipes 能读，第一次滑时 ensureSwipes 提升出来。
 */

/**
 * 酒馆聊天文件（.jsonl）互转。纯函数，不碰 DOM / IndexedDB，Node 里可测。
 *
 * 文件格式（以酒馆 1.19 实际写出的文件为准，不要只信这段注释，去读源码和 data/default-user/chats/ 下的真实文件）：
 *   第 1 行（头）：{ user_name, character_name, create_date?, chat_metadata: { variables: {...}, ...其它 } }
 *   之后每行一条消息：{ name, is_user, is_system, send_date, mes, extra: {...}, swipes?, swipe_id?, swipe_info?, ...其它 }
 *
 * 字段对照：
 *   头.chat_metadata.variables        ↔ ChatRecord.variables
 *   头.chat_metadata.note_*（五个）     ↔ ChatRecord.authorNote（导入时读出来，原值仍留在 stHeader 里，导出时只改和 authorNote 对不上的键）
 *   头的其余部分                        ↔ ChatRecord.stHeader（原样）
 *   行.name / mes / send_date          ↔ ChatMessage.name / content / sendDate
 *   行.is_user（及 extra.type）         ↔ ChatMessage.role —— 具体规则由实现者对照酒馆源码确定并写进注释
 *                                        （注意酒馆里 is_system 的真实含义，以及旁白消息是怎么标记的）
 *   行.is_system（真值）                ↔ ChatMessage.hidden = true（隐藏楼层，不进 prompt）。导入的行 is_system 原值仍留在 st 里，
 *                                        导出时只在和 hidden 不一致时改写（取消隐藏会把 st.is_system 改成 false），保证没动过的行往返不变。
 *                                        规则见 src/chatfile.js 文件头。
 *   行.extra.smalltalk.memory / memoryError ↔ ChatMessage.memory / memoryError
 *   行.extra.smalltalk.memoryMerged / memoryIn ↔ ChatMessage.memoryMerged / memoryIn（记忆再压缩；只看形状：对象 / true。
 *                                        在酒馆里删楼、换候选之后导回来，数不齐成员的段在打开存档时被清掉，那几轮重压——不做指纹，同 memory 的已知局限）
 *                                        （放在 extra 下我们自己的命名空间里；酒馆会原样保留 extra 中不认识的键）
 *   行的其余部分（含 extra 里其它键）     ↔ ChatMessage.st（原样）
 *
 * 往返要求：酒馆文件 → parse → serialize 得到的每一行，JSON 语义上与原行相同
 *（键顺序可以变；我们新加的 extra.smalltalk 只在有记忆时出现）。
 *
 * @callback ParseChatFile
 * @param {string} text   .jsonl 全文（可能是 \r\n 换行，可能有空行、尾部换行）
 * @returns {{name: string, userName: string, characterName: string, createdAt: string|null,
 *            messages: ChatMessage[], variables: Record<string, string|number>, stHeader: Object, authorNote: Object|null}}
 *          authorNote：头里的作者注释（author-note.js noteFromMetadata；全是默认值 / 没有 = null，调用方 null 时不写 ChatRecord.authorNote）
 *          坏行不要让整个导入失败：跳过并在返回值里另给 warnings: string[]
 *          另给 hiddenCount: number —— 酒馆里被隐藏的楼数（导入后仍是隐藏的）。
 *          （以前叫 hidden，含义是「酒馆里隐藏、这里照常发送」；含义变了，所以换了名字，免得旧提示文字说错话）
 *
 * @callback SerializeChatFile
 * @param {ChatRecord} chat
 * @param {{userName: string, characterName: string}} names
 * @returns {string}   .jsonl 全文，\n 换行，末尾带一个换行
 */

/**
 * 版本 1 → 2 迁移。纯函数：给旧的 state 对象，返回要写入的各条记录；由调用方负责落盘。
 * 规则：
 *   - 旧 state.card 非空 → 一条 CardRecord + 一条 ChatRecord（messages = state.chat，variables = state.variables.local）
 *   - 旧 state.card 为空但 state.chat 非空 → 仍然要保住聊天：建一张名为 Assistant 的空卡挂着它
 *   - 其余字段进 GlobalRecord（variables.global → globalVariables）
 *   - 旧数据里没有的字段用当前默认值补齐
 * 落盘顺序：先写完所有新键并读回校验，最后才删除旧的 'state' 键；中途失败则旧键必须原封不动。
 *
 * @callback MigrateV1
 * @param {Object} oldState
 * @param {{now: Date, newId: () => string}} deps
 * @returns {{meta: StoreMeta, global: GlobalRecord, cards: CardRecord[], chats: ChatRecord[]}}
 */

// ───────────────────────────── 酒馆的人设备份文件（「人设」页的导出 / 导入，src/personas.js） ─────────────────────────────
// 对应酒馆 public/scripts/personas.js 的 onBackupPersonas（导出）/ onPersonasRestoreInput（恢复）。
/**
 * @typedef {Object} PersonasFile
 * @property {Object<string, string>} personas   头像文件名 → 人设名字。我们没有头像，导出时键是 smalltalk-<人设 id>.png（单人设时 smalltalk-current.png）
 * @property {Object<string, {description: string, position: number, depth: number, role: number, lorebook: string, title: string, connections?: Array}>} persona_descriptions
 *           酒馆新建人设时（initPersona）写入的字段：position 0（IN_PROMPT）、depth 2、role 0、lorebook ''、title ''（connections 是后来加的可选字段）。
 *           导出时 description、title 取我们的（title = 备注，没有备注时 ''），其余填这些默认值；导入时只读 description 和 title，其余丢弃
 * @property {string|null} default_persona       酒馆的「默认人设」（新开聊天时自动选中的）。导出恒为 null：我们的「当前人设」不等于它；导入时忽略
 * 字段对照：我们的 {name, description, remark} ↔ 酒馆的 personas[键]、persona_descriptions[键].description、persona_descriptions[键].title。
 * 一个文件里可以有多个人设：「人设」页的批量导出把勾选的几个写进同一个文件（exportPersonasFile 的 ids）。
 * 酒馆恢复的校验：personas 和 persona_descriptions 都得是对象（我们的 looksLikePersonasFile 同样要求，并排除数组）。
 * 导入是合并：名字、描述、备注都相同的跳过，其余新增，不覆盖、不切换当前人设（mergePersonas）；card.js 的 detectJsonKind 把它认作 'personas'。
 */

// ───────────────────────────── 备份文件 ─────────────────────────────
//
// 「杂项」页「整体备份」一节：「备份全部数据」写出、「从备份恢复」读入的 .json
// （src/backup.js 纯函数，src/backup-crypto.js 加密，src/ui/backup.js 读写存储和弹框）。用途是换设备。
// 整体备份就是全部，没有勾选：所有卡和存档、所有预设、全局设置、接口列表。只读标签页也能备份（备份存储里已保存的内容）。
// 不导出 'meta'、'index:*'（都能重建）、旧版本的 'state' / 'state.v1.bak*'。
// 记录原样搬运：不认识的字段（包括以后 GlobalRecord 新加的设置项）一起带上，导入时也原样写回。
//
// API key 和加密：
//   网页版（direct）：接口和 key 都在这个浏览器里，备份默认带上 key（endpoints[].apiKey）。
//   本地服务版（server）：key 在服务端，页面读不到（有意的隔离），备份里的接口只有名字、地址、模型名单。
//   备份里【只要有一个非空 apiKey】：必须设密码（至少 8 个字符），整个 BackupFile 的 JSON 加密成 EncryptedBackupFile；
//     文件名 smalltalk-备份-含APIkey-谨慎传播-YYYYMMDD-HHMM.json。
//   不含 key：密码可选。留空 = 明文 BackupFile，文件名 smalltalk-备份-YYYYMMDD-HHMM.json；
//     设了密码 = EncryptedBackupFile（hasKeys: false），文件名 smalltalk-备份-已加密-YYYYMMDD-HHMM.json。
//   底线：导出的文件里永远不出现明文 key。下载前还有一道自检（src/backup.js exportSelfCheck，结构断言为主）：
//     设了密码 → 必须是只有已知头部字段 + data 的加密容器、头部合法、hasKeys 与实际相符；没设密码 → 不含 key、任何一层都没有 apiKey 键。
//     附加：在非密文部分（加密文件的头部 / 明文全文）搜每个 ≥8 字符的 key 的原样和 JSON 转义形式。不通过就不下载。
//   读明文文件时（parseBackup 不带 fromEncrypted），接口项里的 apiKey 一律丢掉并在结果 notes 里提示一句；
//   只有从加密容器里解出来的备份（parseBackup(text, {fromEncrypted: true})）才保留 apiKey。
//
// 恢复：
//   加密的文件 → 先弹密码框（可重试；取消 = 什么都不做）→ 解密 → 之后和明文备份走同一条路。
//   「空的浏览器」（src/backup.js isEmptyForRestore：没有 card:* / preset:*、内存里没有占位卡、global 是出厂默认
//     （migrate.js isPristineGlobal）、网页版下还要没有任何用户加的接口）= 换新设备：内容和三样设置按备份恢复，不弹任何选择框，
//     当前在用的选择用默认值（见下面 global 一节），并自动落在备份里原来的当前卡和存档上；
//     拿到存档锁之后用同样的输入（含接口）再核对一次，期间有了数据就中止、什么都不写。
//   备份 global 里的 NON_GLOBAL_KEYS 和 UNSAFE_KEYS 在计划阶段丢掉，摘要里说一句「N 个字段已忽略」。
//   已有数据：下面的「只新增」规则；备份里有可应用的设置时弹框问一句。
//   恢复进行中整页盖着「正在恢复…」的遮罩（ui/backup.js withRestoreOverlay：其它元素 inert、键盘事件在捕获阶段吞掉，结束一定撤掉）。
//   读回校验失败而撤销也失败时停止保存（stopSaving），页面顶上提示「恢复没有完整完成，请刷新页面」。
//   接口（planEndpointImport）：本机没有同地址（规范化后的 baseUrl）的 → 新建，带上备份里的 key（如果有），再写回模型名单；
//     本机已有同地址的 → 名字和模型名单不动；key：本机已有就保留本机的，本机没填而备份里有就用备份里的补上。
//     「同地址」= 规范化后的字符串完全相等（同主机不同路径、大小写、:443 都不算）。新建的和本机已有接口重名 → 名字加「（来自备份）」。
//     一个接口失败不影响其它；结果摘要里说明新建、补 key、跳过、失败各几个，并逐个列出新建接口的主机名（URL.host，国际化域名是 punycode）
//     和带不带 key，从不出现 key 本身。
//     走的都是 llm.js 现成的 createEndpoint / updateEndpoint（网页版导出的带 key 备份也能恢复到本地服务版）。
//
// 导入只新增：每张卡 / 存档 / 预设都换新 id（ChatRecord.cardId、CardRecord.activeChatId、global.activePresetId 跟着换）。
// 「内容相同」就不新建（重复导入幂等）：
//   卡   = normalizeCard(卡本体，去掉 worldDisabled 开关) + 头像 相同（不看 id / createdAt / usedAt / activeChatId）→ 存档并进已有的那张卡，
//          本机那张卡的 worldDisabled 不动
//   存档 = 名字 + messages + variables 相同（键顺序无关）→ 跳过
//   预设 = 预设本体 JSON 一字不差 → 跳过；名字相同内容不同 → 新的加「 (2)」
// global 里分三类（逐个字段见 src/data-inventory.js，规则的代码在 src/backup.js「全局记录的三类字段」）：
//   内容（人设、额外世界书、全局正则、便签、全局变量）：【永远取并集】，不管弹框怎么答。判重只比内容（src/backup.js「内容取并集」一节）：
//     人设 = 名字 + 描述；世界书 = 去掉 name、enabled / scope / cards、条目上的 book 后的整本内容（重名不同内容的两本都留、后一本加「 (2)」，
//       摘要提醒可能重复发给模型；绑定的换算与并入见 ExtraBook）；
//     全局正则 = 去掉 id、origin（运行时标签）、disabled（开关）后的脚本（id 撞了换新的）；便签 = 标题 + 内容（不看是否完成）；
//     全局变量 = 按键（本机已有的键保留本机的值）。备份里缺失 / 形状不对 / 空 = 当作没有，本机的不动；不是对象的书 / 条目 / 正则丢掉并计入跳过。
//   设置（SETTING_KEYS：外置记忆设置——不含压缩用的接口和模型、上下文上限 contextLimit、世界书扫描设置 wi）：
//     已有数据：备份里有形状对的（settingsInBackup）才弹框，只问一句「是否应用备份中的……？」（是 / 否 / 取消）；答「是」才用备份里的。空浏览器：直接用。
//   当前在用的选择（SELECTION_KEYS：activePresetId、activePersonaId、chatModel、旧字段 model、manual、notesHideDone、stableRandom、promptCache，
//     以及 memory 里的 modelRef / model / openaiModel）：导出时不写进备份（globalForBackup），恢复时永不从备份拿（旧备份里带着也忽略）；
//     空浏览器用默认值：预设 = 恢复进来的预设里的第一个（没有 = 内置默认）、人设 = 列表第一个、两个模型引用不写（读档时补默认引用，不自动选模型）、
//     手动模式关、「隐藏已完成」关、缓存开关默认。以前的 refEndpoints / planModelRefs / 模型弹框都去掉了；旧文件里的 refEndpoints 读时丢掉。
//   已有数据时新 global 的底子是本机的（备份里不认识的字段不带）；空浏览器时底子是备份的（不认识的字段照带，向前兼容）。
//   新的 global 和卡、存档、预设在同一个写入事务里落盘、一起读回校验；没有任何变化时不写。
//   所有弹框都在拿锁、写入之前；点取消 = 什么都不写。
// version 比我们认识的新、format 不对、cards 不是数组 → 整个拒绝；单条记录坏了 → 跳过并在结果里说明。
// 原子性、读回校验、失败回滚、拒绝条件（只读标签页、生成中、切换中、预设操作中）同上一版，见 src/ui/backup.js 文件头。

/**
 * @typedef {Object} BackupFile
 * @property {'smalltalk-backup'} format
 * @property {1} version
 * @property {string} exportedAt               ISO 时间
 * @property {GlobalRecord|null} global        存储里的 'global' 原样（从没保存过则 null；可能是旧形状，导入时会转成新形状）
 * @property {PresetRecord[]} presets
 * @property {{card: CardRecord, chats: ChatRecord[], vars?: CardVars}[]} cards
 *           vars：这张卡的 'cardvars:<cardId>'（2026-11-23 第 2 期加，可选；没有 / 形状不对 = 没有）。version 仍是 1：老版本读到会忽略这个字段
 * @property {{name: string, baseUrl: string, models: string[], apiKey?: string}[]} [endpoints]   可选：接口列表（没有 id / hasKey / ready）。
 *           只含用户自己加的 OpenAI 类接口，内置的 Claude Code 不导出；没有接口就没有这个字段。version 仍是 1：老版本读到不认识的字段会忽略。
 *           apiKey：只有网页版导出、且这个接口填了 key 时才有；有它的备份一定是加密的（见上）。本地服务版导出的永远没有这个字段。
 *           读文件时（parseBackup）形状不对不拒绝整个文件：不是数组 → 当作没有，坏的项丢掉，只取 name / baseUrl / models（加密来源再加 apiKey）。
 * @property {{chat?: string, memory?: string}} [refEndpoints]   【已废弃】以前的版本导出时记下两个模型引用指向的接口地址，空浏览器恢复后自动指回去。
 *           接口和模型现在是「当前在用的选择」，不进备份、不自动选：新版本不再写它，读旧文件时（parseBackup）直接丢掉。
 */

/**
 * 加密的备份文件（src/backup-crypto.js）。解密后得到的是 BackupFile 的 JSON 文本（UTF-8）。
 * @typedef {Object} EncryptedBackupFile
 * @property {'smalltalk-backup-encrypted'} format
 * @property {1} version
 * @property {string} exportedAt          ISO 时间
 * @property {boolean} hasKeys            明文标记：里面有没有 API key。只用于提示（恢复时的密码框上说一句），不泄露内容
 * @property {{name: 'PBKDF2', hash: 'SHA-256', iterations: number, salt: string}} kdf
 *           iterations 导出时固定 600000；解密时只接受 100000～2000000 的整数（防止恶意文件写个天文数字把浏览器卡死）。salt 是 16 字节的 base64
 * @property {{name: 'AES-GCM', iv: string}} cipher   iv 是 12 字节的 base64。每次导出都重新生成 salt 和 iv
 * @property {string} data                AES-256-GCM 密文（含 128 位认证标签）的 base64
 *
 * 附加认证数据（AAD）：JSON.stringify([format, version, exportedAt, hasKeys, kdf.name, kdf.hash, kdf.iterations, kdf.salt, cipher.name, cipher.iv]) 的 UTF-8，
 *   所以改动头部任何一个字段都会解密失败。密码先做 Unicode NFC 规范化再派生密钥。
 * 密码错和文件被改动在 AES-GCM 下无法区分，统一提示「密码不对，或文件已损坏」。
 * 算法名 / 哈希名不认识、迭代次数不在范围内、盐 / IV 长度不对 → 不尝试解密，直接拒绝。version 更新 → 拒绝并说明。
 * crypto.subtle 不可用（非安全上下文）→ 看得懂的中文提示；含 key 的备份这时不能导出。
 */

/**
 * @callback PlanBackupImport   src/backup.js，纯函数
 * @param {BackupFile} backup
 * @param {{cards: CardRecord[], chats: ChatRecord[], presets: PresetRecord[], global?: GlobalRecord|null}} existing   存储里已有的全部记录。
 *          global：存储里的 'global'（内容取并集的本机一边）；null / 不传 = 本机没有全局记录（空浏览器：内容按备份原样）
 * @param {{newId: () => string, now: Date, fresh?: boolean, applySettings?: boolean}} deps
 *          fresh：空浏览器（内容和三样设置按备份、当前选择用默认值）；applySettings：已有数据时弹框答了「是」（只影响三样设置）
 * @returns {{cards: CardRecord[], chats: ChatRecord[], presets: PresetRecord[], indexes: Object[],
 *            merges: {cardId: string, chats: ChatRecord[]}[], global: GlobalRecord|null, settingsApplied: string[],
 *            target: {cardId: string, chatId: string|null}|null, summary: Object}}
 *          merges：并进已有卡的存档（目录在写入事务里现读、补条目）；target：备份里最近使用的卡和它停留的存档（导入后的 id）；
 *          global：要写的新 global（null = 不用写）；summary 里每类内容各有 xxxAdded / xxxDup 两个数（见 backup.js planBackupImport）
 */

// ───────────────────────────── 和酒馆整体互通（「杂项」页；src/tavern-convert.js、src/ui/tavern-ui.js） ─────────────────────────────
//
// 导入酒馆的整体备份 zip（酒馆「备份」打出的整个用户目录）：
//   zip.js openZip → tavern-backup.js classifyTavernEntries（分类）→ tavern-convert.js analyzeTavernZip（预览用的摘要，只读 settings.json）
//   → 预览弹框勾选 {cards, chats, worlds, presets, personas, regex}（chats 依附于 cards）→ convertTavernZip（一个一个读、一个一个转换）
//   → 一份 BackupFile 形状的对象（见下）→ ui/backup.js importBackupObject（= 整体备份恢复的 doImport，以「不应用设置、不是空浏览器」走）。
//   预览框里有东西的类别都默认勾上（世界书以前默认不勾，因为那时额外世界书一律对所有聊天生效；现在按下面的规则导入，不会乱生效）。
//   世界书导入后开不开、对谁生效（tavern-convert.js applyWorldRules）：
//     名字在 settings.json 的 world_info_settings.world_info.globalSelect 里（全局选中）→ 启用、所有聊天（同时被卡绑定也一样：全局优先）；
//     否则被这次导入的卡用 data.extensions.world 指名绑定 → 启用、scope 'cards'、绑定这些卡（临时卡 id，恢复时经 cardIdMap 换成最终 id，
//       被判重跳过的卡指向本机已有的那张）；
//     都不是 → 关闭、所有聊天。
//     卡自带的内嵌书（Card.worldDisabled）：卡指名绑定的书【文件在这次导入的世界书里】（zip 里有、用户勾了世界书、读成功了）→ 关掉卡自带的那份
//       （酒馆运行时用的是文件那本，内嵌的只是拷贝；书同时全局选中也一样，不然发两遍）；文件不在 → 内嵌书保持启用（它是唯一的一份）；
//       卡没绑定任何书 → 保持启用。卡和本机已有的相同而被判重跳过时，不改本机那张卡的开关（只新增、不改现有的），
//       planBackupImport 在 summary.worldKept 里记下这些卡，结果框提醒「可能重复」。
//       新建的卡：绑定的书和本机已有的一本相同而被判重（保留本机那本和它的开关），合并后没有任何一本书对这张卡生效 →
//       去掉它的 worldDisabled（内嵌书照旧生效），记进 summary.worldReenabled，结果框 / 提示条各说一句；本机那本的开关不改。
//       我们自己的整体备份恢复同样走这条（backup.js keepEmbeddedWorlds）；备份里本来就没有书对它生效的（用户自己关的）不动。
//     预览框只给得出全局启用的本数（不读卡），三类各几本、关掉了哪几张卡的自带世界书在结果框里列。
//   extractTavernSettings 多返回 globalWorlds（只是名字字符串的数组）。聊天绑定的世界书（chat_metadata.world_info）和 world_info.charLore 不处理。
//   所以去重、并集、一个写入事务、读回校验、失败撤销、拒绝条件都和整体备份恢复一样；转换期间什么都不写，取消 = 什么都没发生。
// 转出来的 BackupFile：
//   cards[]：每张卡 {card: CardRecord（id 是临时的 'tavern-card-N'，恢复时换新 id；card = card.js parseCard；PNG 卡的 avatar 是这张图的
//            'data:image/png;base64,…'，和拖文件导入时 FileReader 的结果逐字相同；JSON 卡 avatar 为 ''）, chats: ChatRecord[]}
//            同名（去扩展名）的 .png 和 .json 只取 .png。chats/<目录>/*.jsonl 挂到文件名去扩展名等于 <目录> 的卡上；
//            存档名 = 聊天文件名去扩展名；messages / variables / stHeader 来自 chatfile.js parseChatFile（swipes、不认识的字段原样保留）。
//            没有对应卡的聊天目录（孤儿）跳过。
//   presets[]：OpenAI Settings/<名>.json，preset = 原始 JSON（不切换当前预设）
//   global：只有内容字段——books（worlds/<名>.json → {name, entries: parseWorldbook(...), enabled?, scope?, cards?}，后三个按上面的规则）、
//           globalRegex、persona / personas / activePersonaId（settings.json 里的人设；只取名字、描述和备注 title）。没有任何设置字段；什么都没有时 global 为 null。
//   没有 endpoints。settings.json 只经 extractTavernSettings 取人设、全局正则的白名单字段和全局选中的世界书名字，任何密码 / key / 代理字段都进不来。
// 单个文件坏了（PNG 里没有卡数据、JSON 坏了、jsonl 一行都读不出）记一条 {what, reason}，不中断；jsonl 的坏行记为小问题照常导入。
// 上限（tavern-convert.js TAVERN_LIMITS，解压后的字节）：settings 32 MB、卡 32 MB、聊天 64 MB、世界书 16 MB、预设 8 MB；一次勾选合计 256 MB。
//
// 导出成酒馆的目录结构（zip）：勾选 {cards, chats, worlds, presets}（chats 依附于 cards）。
//   卡 = ui/export-st.js cardToFile（和「导出卡」相同：有头像 PNG、没有 JSON）；存档 = chatfile.js serializeChatFile（和单个存档导出相同，
//   外置记忆摘要照样写在消息的 extra.smalltalk 里）；额外世界书 = card-export.js serializeWorldbook；预设 = 原始 JSON。
//   tavern-backup.js buildTavernLayout 摆路径（卡按主体名去重，「艾拉.png」「艾拉.json」→「艾拉 (2).json」，聊天目录跟着卡走）→ zip.js buildZip。
//   不带：settings.json、API key、接口列表、人设、全局正则、便签、全局变量。文件名 SmallTalk导出-酒馆格式-YYYYMMDD.zip。只读标签页也能导出。

// ───────────────────────────── 模型接口 v2：接口列表（取代下面的 provider 一节） ─────────────────────────────
//
// 下面「模型接口（provider）」一节描述的是第一版：只有一个 OpenAI 接口 + 一个「当前用哪个」的开关。
// 这一节取代它：可以存【多个】接口（不同厂商），「用哪个模型」不再是服务端的全局开关，
// 而是由使用方在每次请求里指明（聊天和记忆压缩可以各用各的）。
// 第一版里关于安全的所有要求原样保留：key 只存服务端、任何响应 / 报错 / 日志都不出现 key、
// Host / Origin 校验、PUT/POST 必须 application/json、key 与接口地址的站点绑定、不跟随重定向。

/**
 * 一个接口（磁盘上的形状）。
 * @typedef {Object} Endpoint
 * @property {string} id            服务端生成（uuid）。'claude-code' 是保留 id，不会分配给用户建的接口
 * @property {string} name          给人看的名字，如「DeepSeek」「某某中转」；可重复
 * @property {'openai'} type        目前只有 OpenAI 兼容这一种；留着这个字段是为了以后加别的厂商
 * @property {string} baseUrl       形如 https://api.example.com/v1
 * @property {string} apiKey
 * @property {string[]} models      上次「获取模型列表」拿到的结果（缓存，可能为空；用户也可以手填模型名）
 * @property {string|null} modelsFetchedAt  ISO 时间
 */

/**
 * 服务端配置文件 v2（~/.smalltalk/config.json）。
 * @typedef {Object} ServerConfigV2
 * @property {2} version
 * @property {Endpoint[]} endpoints
 *
 * 从第一版迁移：旧文件形如 {provider, openai:{baseUrl, apiKey, model}}。
 *   若 openai.baseUrl 或 apiKey 非空 → 变成一个接口（name 取 baseUrl 的主机名，models = model 非空则 [model]）；
 *   否则 endpoints 为空。旧的 provider 开关丢弃。读到旧文件时在内存里转换，下次写入时落盘为 v2。
 */

/**
 * 浏览器能看到的接口：没有 apiKey，换成 hasKey。
 * @typedef {Object} PublicEndpoint
 * @property {string} id
 * @property {string} name
 * @property {'openai'|'claude-code'} type
 * @property {string} baseUrl                  claude-code 为 ''
 * @property {boolean} hasKey                  claude-code 恒为 false
 * @property {string[]} models                 claude-code 固定为 ['', 'fable', 'opus', 'sonnet', 'haiku']（'' = 跟随 Claude Code 的默认模型）
 * @property {string|null} modelsFetchedAt
 * @property {boolean} ready                   现在能不能用：openai = 地址和 key 都有；claude-code = 找到了可执行文件
 * @property {string} [detail]                 不 ready 时缺什么；claude-code 时是可执行文件路径
 */

/**
 * 「接口 + 模型」的引用，使用方（聊天、记忆压缩）各存一份。存在浏览器的全局设置里，不在服务端。
 * @typedef {Object} ModelRef
 * @property {string} endpoint   接口 id；'claude-code' 是内置的
 * @property {string} model      模型名；claude-code 下 '' 表示默认
 *
 * 全局状态里：
 *   state.chatModel       : ModelRef   默认 {endpoint: 'claude-code', model: ''}
 *   state.memory.modelRef : ModelRef   默认 {endpoint: 'claude-code', model: 'haiku'}
 * 旧字段的迁移（读到旧存档时一次性转换，之后不再使用旧字段）：
 *   state.model（Claude 别名）            → chatModel = {endpoint:'claude-code', model: state.model}
 *   state.memory.model / openaiModel     → memory.modelRef = {endpoint:'claude-code', model: memory.model ?? 'haiku'}
 * 引用指向的接口被删了 / 不 ready：不要悄悄换成别的，在选择器上标出来，发送时报错并指向「接口」页。
 */

/**
 * HTTP 接口 v2（取代第一版的 /api/config PUT、/api/models，以及 /api/generate 里的 provider 字段）：
 *
 *   GET    /api/endpoints             → {endpoints: PublicEndpoint[]}   内置的 claude-code 永远排第一个
 *   POST   /api/endpoints             {name, baseUrl, apiKey?}  → PublicEndpoint（201）
 *   PUT    /api/endpoints/<id>        {name?, baseUrl?, apiKey?, models?}  → PublicEndpoint
 *                                     apiKey：非空 = 设置；'' = 清除；不带 = 保持。
 *                                     baseUrl 换到另一个站点且没同时给新 key → 清掉旧 key（站点绑定）。
 *                                     models：允许用户手动维护列表（字符串数组，去重、限长、限数量）。
 *   DELETE /api/endpoints/<id>        → 204
 *   POST   /api/endpoints/<id>/models → 向该接口的 /models 查询，成功则写入缓存并返回 PublicEndpoint；
 *                                       失败返回 {error}（非 2xx），缓存不动。
 *   'claude-code' 这个 id 对 PUT / DELETE / models 返回 400（它是内置的，不可改）。不存在的 id → 404。
 *   接口数量上限 50。
 *
 *   POST /api/generate   请求体两种形状不变，把 provider 换成 endpoint：
 *        {messages, endpoint?, model?, params?}
 *        {system?, prompt, endpoint?, model?, params?}
 *        endpoint 省略 = 'claude-code'。model 省略：claude-code 用其默认；openai 类接口必须给 model，否则 400。
 *        endpoint 不存在 → 400，报错里说明去「接口」页检查。
 *        其余行为（流式、报错透传并抹 key、中断、直通转换、params 白名单）与第一版完全相同。
 *
 *   GET /api/health 保留（claude 可执行文件是否找到）。
 *
 * llm.js：
 *   generate(messages, {onDelta, signal, endpoint, model, params})
 *   complete(system, prompt, {onDelta, signal, endpoint, model, params})
 *   listEndpoints() → PublicEndpoint[]
 *   createEndpoint({name, baseUrl, apiKey?}) / updateEndpoint(id, patch) / deleteEndpoint(id) / fetchEndpointModels(id)
 *   samplerParamsFromPreset(preset)、serializeMessages、checkHealth 不变。
 *   第一版的 getConfig / setConfig / listModels 以及 options.provider 删除。
 */

// ───────────────────────────── 命令行类内置接口（claude-code、codex） ─────────────────────────────
//
// 只有本地服务版才有：服务端在本机启动一个官方命令行，走用户的订阅，不是按量付费的 API key。
//
//   id            type          名字          可执行文件（服务启动时找一次，只看文件在不在）                     模型
//   'claude-code' 'claude-code' Claude Code   SMALLTALK_CLAUDE → VS Code 的 Claude Code 扩展 → PATH 上的 claude   CLAUDE_MODELS（固定别名）
//   'codex'       'codex-cli'   Codex         SMALLTALK_CODEX → 原生安装器位置 → PATH（codex.cmd 去包里找 exe）    CODEX_MODELS + 可手填
//                                             → VS Code 的 ChatGPT 扩展自带的
//
// 两者共用的规则（常量在 src/openai-shared.js：CLAUDE_ID / CODEX_ID / BUILTIN_NAMES / isBuiltinId / CLI_TYPES）：
//   - 保留 id：不存盘；对 PUT / DELETE / models 返回 400（"<名字> 是内置接口……"）；用户建的接口 id 永远是 uuid，撞不上。
//   - GET /api/endpoints 的顺序：claude-code、codex、然后是用户的接口。ready = 找到了可执行文件；detail = 路径，或没找到时怎么装 / 怎么指定。
//     登录状态不在列接口时探测（要启动进程、慢），没登录时由生成请求报错说清楚。
//   - ModelRef.model 可以是 ''（= 跟随命令行自己的默认，不传模型参数），选择器不报「还没选模型」。
//   - 消息怎么喂：{messages} 一律用 serializeMessages 压平成 {system, prompt}（两边的文字一模一样）；{system?, prompt} 直通原样用。
//     prompt 走 stdin。工作目录是每次新建的空临时目录，结束后删除。stdout 按行解析，只转发正文（不转发推理 / 思维链），
//     还没写出正文就失败 → 非 2xx + {error}；已经开始写 → 只是结束。客户端断开 → kill 子进程。
//     以上在 server/cli-common.mjs 的 runCli；每个工具只提供参数、逐行解析、结束时的成败判断。
//   - 页面上：「接口」页各一行只读说明；「拼装」页可以看压平后的文本。
//
// 各自不同的：
//   claude-code：system 走 --system-prompt 命令行参数（所以直通模式的 system 限 4000 字）；--tools "" 等一组参数关掉全部工具；
//     stream-json 有逐字增量（text_delta）；没有首个事件超时。
//   codex：`codex exec --json … -`（参数逐个说明见 server/cli-codex.mjs 的 codexArgs）。system + 一段固定的「禁止调用工具」指示
//     写进临时目录里的文件，用 -c model_instructions_file= 交给它（实测会整段替换 Codex 内置的编程助手指令；system 不限长度）。
//     正文是整段到达的（item.completed 且 item.type = 'agent_message'），没有逐字增量。工具调用类条目不转发内容，只在服务端日志记类型。
//     首个事件超时和 OpenAI 那条路的首字节超时同一个设置（SMALLTALK_UPSTREAM_TIMEOUT_MS，默认 60 秒）。
//     子进程环境里去掉 OPENAI_API_KEY / CODEX_API_KEY 等（否则可能改走按量付费的 API）。模型名只许 [A-Za-z0-9._:/-]，以 --model=值 传入。
//     工具：没有官方的「零工具」开关。关掉 code_mode_host 后所有工具调用「fail closed」，加上 --disable 一组 feature 和 -s read-only；
//     关不掉的是 collaboration（开子代理，子代理同样没有可用工具）和只在 Plan 模式可用的 request_user_input。
//     已知挡不住的：全局的 $CODEX_HOME/AGENTS.md 仍会被它读进提示（项目里的 AGENTS.md 已用 project_doc_max_bytes=0 挡掉）。
//     会动用户目录的：~/.codex 下的日志库、models_cache.json、tmp/arg0-windows/ 下的辅助脚本、系统技能的解压；不落会话文件（--ephemeral）。
//
// 网页版（direct）：不列任何内置接口（见下一节）。

// ───────────────────────────── 两种后端（server / direct） ─────────────────────────────
//
// 同一份页面代码有两种跑法，只差在「谁去请求模型、接口列表和 key 存在哪」：
//   server —— 配着本地 server.mjs（压缩包版 / node server.mjs）：llm.js 请求同源的 /api/...（上一节），key 在服务端的 config.json。
//   direct —— 纯静态网页（Cloudflare Pages 等，没有任何 /api）：llm-direct.js 在页面里直接 fetch 用户填的 OpenAI 兼容接口。
// llm.js 对外的函数（generate / complete / listEndpoints / createEndpoint / updateEndpoint / deleteEndpoint /
// fetchEndpointModels / checkHealth / serializeMessages / samplerParamsFromPreset）签名和返回形状两种后端完全相同。
// 新增两个导出：backendKind() → Promise<'server'|'direct'>；setWriteGuard(fn)（见下面「并发」）。
// 再加一个：exportEndpointsForBackup() → [{name, baseUrl, models, apiKey?}]，是 API key 离开接口层的【唯一通道】，
//   只给 src/ui/backup.js 的「备份全部数据」用。direct：带 apiKey（没填的为 ''）；server：没有 apiKey 字段（页面读不到服务端的 key，
//   也不为此加任何服务端接口）。都不含 id、不含内置的 Claude Code。恢复用现成的 createEndpoint / updateEndpoint，不需要新通道。

/**
 * 怎么判定（llm.js detectBackend，每个页面生命周期只探一次，结果缓存）：
 *   - Node 里（没有 document / location：server.mjs、单元测试）→ 永远 server，不发探测请求。
 *   - 地址栏 ?backend=direct / ?backend=server → 强制（测试用）。
 *   - 否则 GET /api/health：2xx、正文是 JSON 对象、且 ok 是布尔值（true / false 都算）→ server；
 *     404、正文不是 JSON（静态站点常回 index.html）、网络错误、10 秒没响应 → direct。
 *
 * direct 后端的存储：页面自己的 IndexedDB（store.js 的 smalltalk / kv），单独一个键 'endpoints'，
 *   值的形状同 ServerConfigV2：{version: 2, endpoints: Endpoint[]}（Endpoint 含明文 apiKey）。
 *   不放进 'global'；整体备份读存储时只读 global / card:* / chat:* / preset:*，不会把这个键原样带走；
 *   接口（含 key）只经 exportEndpointsForBackup() 进入备份，且含 key 的备份一定整体加密（见「备份文件」）。
 *   「清空所有数据」会删掉库里所有键，包括它。
 *   读出来时和服务端读 config.json 走同一个清洗（sanitizeEndpoints）。
 *
 * direct 后端的 key：只在 llm-direct.js 内部、发请求的那一刻从存储读出来用；对外永远只给 PublicEndpoint。
 *   请求只带 Authorization 和 Content-Type 两个自定义头，credentials: 'omit'，redirect: 'manual'，referrerPolicy: 'no-referrer'。
 *
 * 内置的命令行类接口（claude-code、codex）在 direct 下：listEndpoints() 不返回它们（2026-11-22 改：用户嫌网页版里那行"未就绪"多余），
 *   页面上任何地方都不提 Claude Code / Codex。默认的 chatModel / memory.modelRef 仍是 claude-code，【不改写】它（数据拿回本地版照常可用），
 *   只是呈现成「还没选接口」：model-picker.js 的 refUnpicked(ref) = 指向内置 id、列表里没有、列表已读完。
 *   选择器显示「选择接口…」（一个用户接口都没有时「还没有接口」），顶栏告警「⚠ 还没选接口」/「⚠ 还没添加接口」；
 *   对它 generate / complete 报错「还没选聊天用的接口：到「接口」页添加……」；外置记忆在这种情况下不发请求、不记失败。
 *   对内置 id 的 update / delete / fetchEndpointModels 仍拒绝（"本地版才有的内置接口"）。checkHealth 的 error 也是中性的说法。
 *
 * 并发：direct 下接口列表和存档一样受「同一时间只有一个标签页写」的约束。llm.js 的 setWriteGuard(fn) 由界面层注入
 *   （tab-provider.js：只读标签页 / 清空数据后返回原因），增删改接口和「获取模型列表」（要写缓存）前先问它，非 null 就抛错。
 *   读写本身放在 store.transact 的同一个事务里。server 后端不受它影响。
 *
 * 与服务端共用的规则（src/openai-shared.js，server/config.mjs 和 server/openai.mjs 从这里转出去）：
 *   字段校验与长度上限（LIMITS）、接口数量上限 50、模型名清洗（cleanModels）、读存储时的清洗（sanitizeEndpoints）、
 *   新建 / 修改的合并（newEndpoint / patchEndpoint，含 key 与站点绑定：baseUrl 换 origin 且没给新 key → 清 key 和模型缓存）、
 *   公开版（publicEndpoint）、/models 结果的解析（parseModelList）、报错抹 key（scrub：原文 / JSON 转义 / URL 编码）、
 *   上游错误文字（extractErrorMessage / eventErrorText）、采样参数白名单（pickParams）、消息形状（toUpstreamMessages）、
 *   SSE 解析（createSseParser）、只取正文不取推理内容（contentOf）、
 *   流式 / 上游忽略 stream 返回整块 JSON 的判别（createCompletionReader；server.mjs 里是同样逻辑的内联写法）。
 *   首字节超时 60 秒、查模型超时 15 秒（服务端可用环境变量改）。查模型期间配置被改 → 不写缓存。
 *
 * 只有 direct 有的：fetch 抛 TypeError（跨域被拦 / 地址错 / 断网分不清）→ 翻译成列出几种可能、并提到压缩包版不受跨域限制的提示；
 *   https 页面请求 http:// 地址 → 混合内容的提示。redirect: 'manual' 在浏览器里得到 type 为 'opaqueredirect' 的响应，按重定向报错。
 *   读流用 res.body.getReader() + 流式 TextDecoder，不用 for await、不用 byob（iOS Safari）。
 *
 * 资源地址：页面代码里除了 server 后端的 /api/... 都是相对地址（站点可能挂在子路径下）。
 *   前端卡 iframe 的库（render.js FRAME_LIBS 的 path）在生成 srcdoc 时按宿主页面的 document.baseURI 算成绝对地址。
 */

// ───────────────────────────── （第一版，已被上面取代）模型接口（provider） ─────────────────────────────
//
// 两种 provider：
//   'claude-code'  现有的：把 messages 压平成一段文本交给 `claude -p`
//   'openai'       OpenAI 兼容的 /chat/completions：messages 数组原样发过去（角色边界不再被压平）
//
// API key 只存在服务端：配置文件放在【用户主目录】下的 .smalltalk/config.json（不在项目目录里，
// 所以静态托管无论如何读不到它）。浏览器永远拿不到 key 明文——页面里会运行导入的第三方前端卡脚本，
// 即使有沙箱，也不该让 key 出现在任何浏览器可读的地方。

/**
 * 服务端保存的配置（磁盘上的形状）。
 * @typedef {Object} ServerConfig
 * @property {'claude-code'|'openai'} provider   当前用哪个
 * @property {{baseUrl: string, apiKey: string, model: string}} openai
 *           baseUrl 形如 https://api.example.com/v1 （不带 /chat/completions）
 */

/**
 * 浏览器能看到的配置：和 ServerConfig 一样，但 openai.apiKey 被换成 hasKey。
 * @typedef {Object} PublicConfig
 * @property {'claude-code'|'openai'} provider
 * @property {{baseUrl: string, hasKey: boolean, model: string}} openai
 * @property {{ok: boolean, path: string|null}} claudeCode   claude 可执行文件是否找到
 */

/**
 * HTTP 接口（server.mjs，仅 127.0.0.1，沿用现有的 Host / Origin 校验）：
 *
 *   GET  /api/config   → PublicConfig
 *   PUT  /api/config   请求体是 PublicConfig 的任意子集，另可带 openai.apiKey：
 *                        字符串非空 = 设置；空字符串 = 清除；不带这个键 = 保持不变。
 *                      → 更新后的 PublicConfig。任何响应里都不出现 key。
 *   GET  /api/models   → {models: string[]}  向当前 openai.baseUrl 的 /models 查询；失败时 {models: [], error}
 *
 *   POST /api/generate  在现有两种请求体上各加可选字段：
 *        {messages, model?, provider?, params?}     聊天
 *        {system?, prompt, model?, provider?, params?}   直通（外置记忆的压缩在用）
 *        provider 省略 = 用配置里当前的。model 省略 = claude-code 用其默认，openai 用配置里的 model。
 *        params 只对 openai 生效，是采样参数的白名单子集：
 *          temperature, top_p, frequency_penalty, presence_penalty, max_tokens（其余键忽略）
 *        openai 下直通请求转成 messages：[{role:'system',content:system}?, {role:'user',content:prompt}]
 *        响应不变：分块纯文本流；出错时非 2xx + {error}。上游返回的错误信息要透传给用户看，但不能带出 key。
 *        只转发正文增量，不转发推理内容（reasoning_content 之类）。
 *
 * llm.js：generate / complete 的 options 增加 provider?: string、params?: object，原样放进请求体。
 *         另导出 getConfig() / setConfig(patch) / listModels()，以及
 *         samplerParamsFromPreset(preset) → params：从酒馆预设里取出上面白名单里的采样参数
 *        （预设里最大回复长度的键是 openai_max_tokens，对应到 max_tokens）。
 */

// ───────────────────────────── 上游用量 / 缓存命中（llm.js、openai-shared.js、ui/sent-log.js）─────────────────────────────

/**
 * normalizeUsage（openai-shared.js）的结果：各家不同写法的 usage 统一成这四项，没有的为 null（不是 0）。
 * cachedTokens 为 null = 上游根本没报缓存（界面不能显示成 0%）；为 0 = 报了、没命中。认不出的 usage 整个是 null。
 * @typedef {{inputTokens: number|null, cachedTokens: number|null, cacheWriteTokens: number|null, outputTokens: number|null}} NormalizedUsage
 *
 * generate(messages, {onUsage}) / llm-direct 的 post(body, {onUsage})：上游报了用量时，在回复结束前调用一次 onUsage(NormalizedUsage)；
 * 没报就不调用。llm.js 另有 setUsageListener(fn)：聊天生成（generate，不含 complete）拿到用量时也会调它，sent-log.js 靠它记「上次请求」。
 * 本地服务版的传递方式：请求体里的 usageId（一次性字符串）→ 服务端流结束时存内存 → 页面 GET /api/usage?id= 取一次（取走即删，取不到 = 没有）。
 */

// ───────────────────────────── 手机壳（src/ui/phone/，第一版：空壳）─────────────────────────────

/**
 * 手机壳只有外观和导航，**不存任何数据**（不写 IndexedDB / localStorage，不进备份）：状态全在内存里，刷新后回到「收起、锁屏」。
 * 唯一碰到存储的地方是 Settings 里的主题下拉框，它复用 src/ui/theme.js 的 bindThemeSelect(select)（和「杂项」页那个同一套逻辑，互相同步）。
 *
 * phone.js：initPhone()（app.js 启动时调一次；建好 #phone 挂在 body 末尾，接上顶栏 #phone-toggle）、
 *           openPhone() / closePhone() / togglePhone()、isPhoneOpen()、phoneView()（'lock' | 'home' | 应用 id）。
 *           #phone 一直在 DOM 里，收起只是 data-open="0"；里面的 .ph-persist 是给以后的音乐播放器留的常驻层。
 * apps.js：APPS = [{id, name, icon, kind: 'view' | 'exit'}]（桌面上的应用清单）、buildAppView(app, goHome)（一个应用的画面）。
 * statusbar.js：createStatusBar({lockTime, lockDate})（时间 / 信号 / 电量，都只读浏览器当下的状态）。
 * icons.js：icon(name) → <span class="ph-ico">（内联 SVG 线条图标）。
 */
