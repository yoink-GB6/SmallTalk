// 模型桥（浏览器 + Node 通用）：把拼好的 messages 压成 claude -p 能吃的单段文本，并负责"谁去请求模型"。
// 模块顶层不使用任何 Node 专有 API，也不碰 window / indexedDB / fetch：server.mjs 也会 import 这里的 serializeMessages。
//
// 两种后端（规格见 types.js「两种后端」），对外的函数签名和返回形状完全一样，界面模块不用管现在是哪种：
//   server —— 配着本地 server.mjs 跑（压缩包版 / node server.mjs）：请求发给同源的 /api/...，由服务端去找上游，key 在服务端。
//   direct —— 纯静态网页（Cloudflare Pages 等，没有任何 /api）：页面自己 fetch 用户填的接口，接口列表和 key 存在浏览器里。
//             实现在 llm-direct.js，第一次用到时才动态加载（Node 里永远走 server，不会加载它）。
// 判定：页面启动后第一次调用时探一次 GET /api/health，返回 JSON 且带布尔型 ok → server；否则 → direct。
// 结果在这次页面生命周期内缓存。地址栏加 ?backend=direct / ?backend=server 可以强制（测试用）。

import { isBuiltinId } from './openai-shared.js';

// ───────────────────────────── 选后端 ─────────────────────────────

let backendPromise = null;

/** 现在是哪种后端：Promise<'server'|'direct'>（只探测一次） */
export function backendKind() {
  if (!backendPromise) backendPromise = detectBackend();
  return backendPromise;
}

async function detectBackend() {
  // Node（server.mjs、单元测试）里没有页面：永远是 server。单元测试会替换 globalThis.fetch，这里不能多发一次探测
  if (typeof document === 'undefined' || typeof location === 'undefined') return 'server';
  const forced = new URLSearchParams(location.search).get('backend');
  if (forced === 'server' || forced === 'direct') return forced;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    // 必须是以 / 开头的绝对路径：服务端版永远挂在站点根上；网页版挂在子路径下时这里会落到别人的根上，得到 404 / HTML，正好判成 direct
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: ac.signal });
    if (!res.ok) return 'direct';
    const j = await res.json();   // 静态托管站点常把不存在的路径回成 index.html：解析失败 → direct
    return j && typeof j === 'object' && typeof j.ok === 'boolean' ? 'server' : 'direct';
  } catch {
    return 'direct';
  } finally { clearTimeout(timer); }
}

let writeGuard = () => null;
/**
 * direct 后端在增删改接口前问一句"现在能不能写"。返回 null = 可以，否则是原因（给用户看）。
 * 由界面层注入（tab-provider.js：只读标签页 / 数据已清空时不能写），这样本模块不用 import 界面模块。
 * server 后端不受它影响（那边的配置在服务端，和浏览器里的存档锁无关）。
 */
export function setWriteGuard(fn) { writeGuard = typeof fn === 'function' ? fn : () => null; }

let directPromise = null;
/** direct 后端的实例（懒加载）。存储用页面自己的 IndexedDB（store.js，键 'endpoints'） */
function direct() {
  if (!directPromise) {
    directPromise = Promise.all([import('./llm-direct.js'), import('./store.js')])
      .then(([d, s]) => d.createDirectBackend({ kv: s.store, canWrite: () => writeGuard() }))
      .catch((e) => { directPromise = null; throw e; });
  }
  return directPromise;
}

/** 是 direct 就返回它的实例，否则返回 null（走下面的 server 实现） */
async function directOrNull() {
  return (await backendKind()) === 'direct' ? direct() : null;
}

// 系统指令：固定短文本（会作为 --system-prompt 通过命令行传入，所以必须短、且不含内容相关信息）。
const SYSTEM_INSTRUCTION = [
  '你是一个纯文本补全后端，不是助手，也不是编程工具。用户给出的是一段角色扮演聊天的转录（transcript）。',
  'This is a role-play chat-completion transcript. Output ONLY the content of the next assistant message:',
  '不要前言、不要解释、不要角色标签、不要用代码块包住整条回复、不要提及这些指令。',
  'No preface, no explanation, no role tag, no markdown fence around the whole reply.',
  '回复所用语言、人称、格式遵循转录中 system 消息的要求与上下文；严格遵守其中的角色设定。',
].join('\n');

// 定界符选择：消息正文里常有 XML 式标签（<tag>）、markdown 围栏（```）、甚至 </message>，
// 所以不用 <message> 这种常见写法，而用 <<<ST:MSG ...>>> / <<<ST:END>>>：
// 三个尖括号加自造前缀，几乎不会出现在角色卡或预设里。并且定界符各自独占一行。
// 消息正文原样放入，一个字节都不改。
const OPEN = (role, name) =>
  `<<<ST:MSG role=${JSON.stringify(String(role))}${name ? ` name=${JSON.stringify(String(name).replace(/[\r\n]+/g, ' '))}` : ''}>>>`;
const CLOSE = '<<<ST:END>>>';

/**
 * @param {{role: string, content: string, name?: string}[]} messages
 * @returns {{system: string, prompt: string}}
 */
export function serializeMessages(messages) {
  const blocks = messages.map((m) => `${OPEN(m.role, m.name)}\n${m.content}\n${CLOSE}`);
  const last = messages[messages.length - 1];
  const prefill = last && last.role === 'assistant';
  const cue = prefill
    ? '上面最后一条 assistant 消息是预填内容（尚未写完）。请从它的末尾无缝接着往下写，只输出续写的部分，不要重复预填内容。\n' +
      'The last assistant message above is a prefill. Continue seamlessly from its last character; output only the continuation.'
    : '现在请只输出下一条 assistant 消息的正文（不要输出定界符）。\n' +
      'Now output ONLY the body of the next assistant message (no delimiters).';
  return {
    system: SYSTEM_INSTRUCTION,
    prompt:
      '以下是聊天转录，每条消息以 <<<ST:MSG ...>>> 开头、以 <<<ST:END>>> 结尾：\n\n' +
      blocks.join('\n') +
      '\n\n' +
      cue +
      '\n',
  };
}

/**
 * @param {{role: string, content: string, name?: string}[]} messages
 * @param {{onDelta?: (textSoFar: string) => void, signal?: AbortSignal, endpoint?: string, model?: string, params?: object}} [options]
 *        endpoint = 接口 id（省略 = 'claude-code'）；model：claude-code 下 ''/省略 = 默认模型，openai 类接口必须给；
 *        params 只对 openai 类接口生效（见 samplerParamsFromPreset）
 * @type {import('./types.js').Generate}
 */
export function generate(messages, { onDelta, onUsage, signal, endpoint, model, params, promptCache, usageLog } = {}) {
  // 只有「聊天生成」（generate）报用量，记忆压缩（complete）不报：上次请求的缓存命中说的是聊天那一次。
  // usageLog === false：这次请求【不】报给 setUsageListener 登记的监听（手机聊天用：「拼装」页的「上次请求」说的是 RP，
  // 手机的请求不能把它顶掉）。调用方自己的 onUsage 照常调；两样都没有时连用量都不去取（不带 usageId）。usageLog 本身不进请求体
  const quiet = usageLog === false;
  const both = quiet ? onUsage : (u) => { try { usageListener(u); } catch {} if (onUsage) onUsage(u); };
  // promptCache === false：「拼装」页关掉了「经 OpenRouter 用 Claude 时自动缓存开头」。只有关掉时才带这个字段（没带 = 开），
  // 真正加不加标记由后端按接口地址和模型名判断（openai-shared.js applyPromptCache）
  const body = { messages, endpoint, model, params };
  if (promptCache === false) body.promptCache = false;
  return post(body, { onDelta, onUsage: both, signal });
}

let usageListener = () => {};
/**
 * 登记一个「聊天生成拿到了上游用量」的监听（拼装页的「上次请求」就是靠它，见 ui/sent-log.js）。
 * 这样 chat.js 不用改：它照旧调 generate()，用量从旁路过来。只有上游真的报了用量才会调用（命令行类接口永远不会）。
 * 参数是 normalizeUsage 的结果：{inputTokens, cachedTokens, cacheWriteTokens, outputTokens}，没有的项为 null。
 */
export function setUsageListener(fn) { usageListener = typeof fn === 'function' ? fn : () => {}; }

/**
 * 直通调用：不套「角色扮演转录」的包装，system 和 prompt 原样交给模型。给摘要这类工具型任务用。
 * @param {string} system  短的系统提示（claude-code 下会走命令行参数，别超过 4000 字）
 * @param {string} prompt
 * @param {{onDelta?: (textSoFar: string) => void, signal?: AbortSignal, endpoint?: string, model?: string, params?: object}} [options]
 * @returns {Promise<string>}
 */
export function complete(system, prompt, { onDelta, signal, endpoint, model, params } = {}) {
  return post({ system, prompt, endpoint, model, params }, { onDelta, signal });
}

// ───────── 接口列表（server 后端：服务端 /api/endpoints，规格见 types.js「模型接口 v2」；direct 后端见 llm-direct.js）─────────

async function jsonOrThrow(res) {
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok) throw new Error(j && j.error ? String(j.error) : `HTTP ${res.status}`);
  return j;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
// server 后端的 /api/... 是页面代码里唯一以 / 开头的地址：服务端版永远挂在站点根上
const epPath = (id) => '/api/endpoints/' + encodeURIComponent(id);

/** 全部接口（内置的 claude-code 永远第一个）。PublicEndpoint[]：没有 key，只有 hasKey。 */
export async function listEndpoints() {
  const d = await directOrNull();
  if (d) return d.listEndpoints();
  return (await jsonOrThrow(await fetch('/api/endpoints'))).endpoints;
}

/** 新建接口：{name, baseUrl, apiKey?} → PublicEndpoint。校验失败抛 Error（message 是给人看的中文原因）。 */
export async function createEndpoint(input) {
  const d = await directOrNull();
  if (d) return d.createEndpoint(input);
  return jsonOrThrow(await fetch('/api/endpoints', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) }));
}

/** 修改接口：patch = {name?, baseUrl?, apiKey?, models?}。apiKey 非空 = 设置，'' = 清除，不带 = 保持。→ PublicEndpoint */
export async function updateEndpoint(id, patch) {
  const d = await directOrNull();
  if (d) return d.updateEndpoint(id, patch);
  return jsonOrThrow(await fetch(epPath(id), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(patch) }));
}

/** 删除接口 */
export async function deleteEndpoint(id) {
  const d = await directOrNull();
  if (d) return d.deleteEndpoint(id);
  const res = await fetch(epPath(id), { method: 'DELETE' });
  if (!res.ok) await jsonOrThrow(res);
}

/**
 * 整体备份要带走的接口列表。这是 API key 离开接口层的【唯一通道】：
 * 除了 src/ui/backup.js 的「备份全部数据」导出流程，不许有任何别的调用方（别的地方要列接口请用 listEndpoints，它没有 key）。
 * 拿到结果的一方要负责：含 key 时整个备份必须加密后才能落到文件里；结果不进 state、DOM、console、提示文字。
 *
 *   direct（网页版）：[{name, baseUrl, models, apiKey}]，key 本来就存在这个浏览器里；没填 key 的 apiKey 为 ''。
 *   server（本地服务版）：[{name, baseUrl, models}]，【没有 apiKey 字段】。key 在服务端，页面读不到——这是有意的隔离，
 *     不为备份加任何能让页面读到 key 的服务端接口，所以这里只是把 listEndpoints() 的公开信息挑出来。
 * 两种后端都不含 id、不含内置的 Claude Code。
 * 恢复不需要新通道：用现成的 createEndpoint({name, baseUrl, apiKey}) / updateEndpoint(id, {apiKey, models})，
 * 它们在两种后端下都是「页面把 key 交出去」的正常路径（网页版导出的带 key 备份因此也能恢复到本地服务版）。
 * @returns {Promise<{name: string, baseUrl: string, models: string[], apiKey?: string}[]>}
 */
export async function exportEndpointsForBackup() {
  const d = await directOrNull();
  if (d) return d.exportEndpointsForBackup();
  return (await listEndpoints())
    .filter((e) => e.type === 'openai')
    .map((e) => ({ name: e.name, baseUrl: e.baseUrl, models: [...e.models] }));
}

/** 向该接口的 /models 查询并写入缓存（服务端配置 / 浏览器存储）→ 更新后的 PublicEndpoint；失败抛 Error（缓存不动） */
export async function fetchEndpointModels(id) {
  const d = await directOrNull();
  if (d) return d.fetchEndpointModels(id);
  return jsonOrThrow(await fetch(epPath(id) + '/models', { method: 'POST', headers: JSON_HEADERS, body: '{}' }));
}

/**
 * 从酒馆预设里取出 OpenAI 兼容接口的采样参数（服务端白名单：temperature / top_p / frequency_penalty / presence_penalty / max_tokens）。
 * 选择依据（对照酒馆 public/scripts/openai.js 里构造 generate_data 的地方，约 2803-2812 行）：酒馆对通用的
 * OpenAI 兼容来源是【无条件】把这四个采样值（Number(...)）和 max_tokens 都发出去的，0 也照发——所以这里
 * 也只要预设里这个键是有限数字就带上，包括 0（频率/存在惩罚为 0 是合法值，等同于不设；酒馆本来就发 0），不做「0 视为未设」的猜测。
 * 唯一的例外：max_tokens 必须 >= 1（0 或负数发出去只会被上游拒绝）。预设里没有 / 不是数字的键就不带，让上游用它的默认值。
 * 酒馆只对 o1/o3 这类特定模型才删掉 temperature 等参数；这里不识别模型名，遇到这类上游请在预设里去掉对应值。
 * @param {object} [preset]  酒馆预设 JSON（键名：temperature, top_p, frequency_penalty, presence_penalty, openai_max_tokens）
 * @returns {{temperature?: number, top_p?: number, frequency_penalty?: number, presence_penalty?: number, max_tokens?: number}}
 */
export function samplerParamsFromPreset(preset) {
  const out = {};
  if (!preset || typeof preset !== 'object') return out;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const k of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) if (num(preset[k])) out[k] = preset[k];
  if (num(preset.openai_max_tokens) && preset.openai_max_tokens >= 1) out.max_tokens = Math.floor(preset.openai_max_tokens);
  return out;
}

async function post(body, { onDelta, onUsage, signal }) {
  const d = await directOrNull();
  if (d) return d.post(body, { onDelta, onUsage, signal });
  // 用量怎么从服务端回到页面：回复正文是纯文本流，没有「消息」这种信封，往里夹东西会改变已有格式。
  // 所以走旁路：页面随请求带一个一次性的 usageId，服务端流结束时把上游报的用量存在内存里，页面读完流再用这个 id 取一次。
  // 只对 OpenAI 兼容接口要（命令行类接口没有用量）。取不到（没报 / 过期 / 出错）就当没有，绝不影响回复。
  const usageId = onUsage && !isBuiltinId(body.endpoint ?? 'claude-code')
    ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}` : null;
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(usageId ? { ...body, usageId } : body),
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = String(j.error);
    } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8'); // stream 模式：跨 chunk 的多字节字符不会被截坏
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (onDelta) onDelta(text);
  }
  const tail = decoder.decode();
  if (tail) {
    text += tail;
    if (onDelta) onDelta(text);
  }
  if (usageId && !(signal && signal.aborted)) {
    try {
      const r = await fetch('/api/usage?id=' + encodeURIComponent(usageId), { cache: 'no-store' });
      if (r.ok) { const u = await r.json(); if (u && typeof u === 'object') onUsage(u); }
    } catch {}
  }
  return text;
}

/** @type {import('./types.js').CheckHealth} */
export async function checkHealth() {
  const d = await directOrNull().catch(() => null);
  if (d) return d.checkHealth();
  try {
    const res = await fetch('/api/health');
    return await res.json();
  } catch (e) {
    return { ok: false, claudePath: null, error: String(e && e.message ? e.message : e) };
  }
}
