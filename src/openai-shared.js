// OpenAI 兼容接口的共享规则：服务端（server.mjs / server/*.mjs）和网页版的「页面直连」后端（src/llm-direct.js）用的是同一份。
// 为什么要共享：两种形态对 key 的保护规则必须一模一样（抹 key、站点绑定、采样参数白名单、字段校验……），
// 复制两份迟早会改了一边忘了另一边。
//
// 这里只放【纯函数】：不碰 Node 专有 API（fs / process / crypto 模块），也不碰 window / indexedDB / fetch，
// 所以浏览器和 Node 都能直接 import。超时这类要读环境变量的常量留在 server/openai.mjs。
//
// 分两部分：
//   ① 接口列表（原来在 server/config.mjs）：字段校验、新建 / 修改的合并规则、公开版（去掉 key）。
//   ② 上游协议（原来在 server/openai.mjs）：抹 key、错误文字、采样参数、SSE 解析、取正文。

// ═════════════════════════════ ① 接口列表 ═════════════════════════════

export const CLAUDE_ID = 'claude-code';
export const CLAUDE_MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku']; // '' = 跟随 Claude Code 的默认模型
// 内置的 Codex（OpenAI 的 Codex CLI，走 ChatGPT 订阅）。规格见 types.js「命令行类内置接口」。
// 模型名单是 2026-11-22 在 codex-cli 0.171.0 上用 `codex debug models` 看到的「列在选择器里」的那些挑了几个；
// 订阅里可用的模型会变，所以页面上允许手填别的名字。'' = 跟随 Codex 的默认模型（不传 -m）。
export const CODEX_ID = 'codex';
export const CODEX_MODELS = ['', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol'];
/** 内置接口的 id（不存盘、不能改删、不能查模型列表）→ 给人看的名字 */
export const BUILTIN_NAMES = { [CLAUDE_ID]: 'Claude Code', [CODEX_ID]: 'Codex' };
export const isBuiltinId = (id) => Object.prototype.hasOwnProperty.call(BUILTIN_NAMES, id);
/** 内置接口的类型：它们都是「在本机启动一个命令行」，不需要地址和 key，模型可以留空（= 跟随命令行自己的默认） */
export const CLI_TYPES = ['claude-code', 'codex-cli'];
export const MAX_ENDPOINTS = 50;
export const MAX_MODELS = 1000;
export const LIMITS = { name: 100, baseUrl: 500, apiKey: 4096, model: 200 };

export const defaultConfig = () => ({ version: 2, endpoints: [] });

/** 接口 id 一律由我们生成（uuid）。读存储时也只认这种形状，别的 id 当作坏数据丢弃。 */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isEndpointId = (s) => typeof s === 'string' && ID_RE.test(s);

/**
 * 生成 uuid v4。Node 22 和浏览器都有 globalThis.crypto；但浏览器的 randomUUID 只在「安全上下文」（https / localhost）里有，
 * 用 http://局域网IP 打开页面时没有它，所以退回用 getRandomValues 自己拼（getRandomValues 不受这个限制）。
 */
export function newEndpointId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // 版本 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 变体
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 去掉控制字符（含换行）并 trim：名字只当纯文本显示 */
export const plain = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

/** 规范化 baseUrl：去首尾空白、去末尾斜杠，必须是 http(s) URL。空串 = 清空。 */
export function normalizeBaseUrl(v) {
  const s = v.trim().replace(/\/+$/, '');
  if (s === '') return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('baseUrl 不是合法的 URL（形如 https://api.example.com/v1）'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('baseUrl 必须以 http:// 或 https:// 开头');
  if (u.username || u.password) throw new Error('baseUrl 里不要带用户名密码，API key 请填在密钥栏');
  return s;
}

export const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname; } catch { return ''; } };

/**
 * 模型名列表的清洗：只留字符串、trim、去空、去重、每项 ≤200 字符、最多 1000 项。
 * strict=true（用户手动提交的）：不合规直接抛错让用户知道；strict=false（读存储 / 上游返回的）：悄悄丢掉不合规的项。
 */
export function cleanModels(list, strict = false) {
  if (!Array.isArray(list)) { if (strict) throw new Error('models 必须是字符串数组'); return []; }
  const out = []; const seen = new Set();
  for (const m of list) {
    if (typeof m !== 'string') { if (strict) throw new Error('models 里每一项都必须是字符串'); continue; }
    const v = m.trim();
    if (!v) continue;
    if (v.length > LIMITS.model) { if (strict) throw new Error(`模型名太长（上限 ${LIMITS.model} 字符）`); continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    if (out.length >= MAX_MODELS) { if (strict) throw new Error(`模型太多（上限 ${MAX_MODELS} 个）`); break; }
    out.push(v);
  }
  return out;
}

/**
 * 从存储里读出来的 v2 配置（{version: 2, endpoints}）→ 干净的 Endpoint[]。字段类型不对的回落成空值，
 * id 不是 uuid / 重复的整项丢掉（不替它编新 id，免得和浏览器里存的引用悄悄对不上），最多 50 项。绝不抛错。
 * 服务端读 config.json、网页版读 IndexedDB 都走这里。
 */
export function sanitizeEndpoints(list) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object' || out.length >= MAX_ENDPOINTS) continue;
    if (!isEndpointId(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    const s = (k) => (typeof e[k] === 'string' ? e[k].slice(0, LIMITS[k]) : '');
    out.push({
      id: e.id, name: plain(s('name')) || '未命名接口', type: 'openai', baseUrl: s('baseUrl').trim(), apiKey: s('apiKey').trim(),
      models: cleanModels(e.models), modelsFetchedAt: typeof e.modelsFetchedAt === 'string' ? e.modelsFetchedAt.slice(0, 40) : null,
    });
  }
  return out;
}

/** 浏览器能看到的接口：apiKey 换成 hasKey；ready = 地址和 key 都有。返回的是新对象，和存储里那份不共享任何可变部分。 */
export function publicEndpoint(e) {
  const missing = [!e.baseUrl && '接口地址', !e.apiKey && 'API Key'].filter(Boolean);
  const out = {
    id: e.id, name: e.name, type: 'openai', baseUrl: e.baseUrl, hasKey: e.apiKey.length > 0,
    models: [...e.models], modelsFetchedAt: e.modelsFetchedAt, ready: missing.length === 0,
  };
  if (missing.length) out.detail = `缺少${missing.join('、')}`;
  return out;
}

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 校验一个字符串字段（类型、长度），返回处理后的值 */
function strField(body, k, fix) {
  need(typeof body[k] === 'string', `${k} 必须是字符串`);
  const v = fix(body[k]);
  need(v.length <= LIMITS[k], `${k} 太长（上限 ${LIMITS[k]} 字符）`);
  return v;
}

/**
 * 新建接口的请求体 → 新接口（id 在这里生成，绝不采用调用方给的）。校验失败抛 Error（message 给用户看）。
 * @param {object} body  {name?, baseUrl, apiKey?}
 * @param {() => string} [newId]  测试可以注入
 */
export function newEndpoint(body, newId = newEndpointId) {
  need(obj(body), '请求体必须是 JSON 对象');
  const baseUrl = strField(body, 'baseUrl', normalizeBaseUrl);
  need(baseUrl, '接口地址不能为空');
  const name = 'name' in body && body.name !== '' ? strField(body, 'name', plain) : '';
  const apiKey = 'apiKey' in body ? strField(body, 'apiKey', (s) => s.trim()) : '';
  return {
    id: newId(), name: name || hostOf(baseUrl) || 'OpenAI 兼容接口', type: 'openai',
    baseUrl, apiKey, models: [], modelsFetchedAt: null,
  };
}

/**
 * 修改：patch 合并到一个接口上，返回新对象（不改入参）。
 * 不认识的键（包括 id、type）直接忽略；apiKey：非空字符串 = 设置，空串 = 清除，不带 = 保持。
 */
export function patchEndpoint(cur, patch) {
  need(obj(patch), '请求体必须是 JSON 对象');
  const next = { ...cur, models: [...cur.models] };
  if ('name' in patch) next.name = strField(patch, 'name', plain) || cur.name;
  if ('baseUrl' in patch) next.baseUrl = strField(patch, 'baseUrl', normalizeBaseUrl);
  if ('apiKey' in patch) next.apiKey = strField(patch, 'apiKey', (s) => s.trim());
  if ('models' in patch) { next.models = cleanModels(patch.models, true); next.modelsFetchedAt = cur.modelsFetchedAt; }
  // key 是「给某个站点的凭证」，不能跟着地址走：地址换到另一个站点（协议 + 主机 + 端口不同）时，
  // 如果这次请求没有同时给新的 key，就把旧 key 清掉，要求重新填。
  // 否则只要有什么东西能改掉 baseUrl，下一次请求就会把你的 key 当作 Bearer 发到别人的服务器上。
  // 站点绑定是【每个接口各自】的：改 A 的地址只会清 A 的 key，B 不受影响（B 根本不在这次合并里）。
  // 另外，换了站点以后旧站点缓存的模型列表也不再可信，一并清空。
  const site = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const gaveKey = typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '';
  if (site(next.baseUrl) !== site(cur.baseUrl)) {
    if (cur.apiKey && !gaveKey) next.apiKey = '';
    if (!('models' in patch)) { next.models = []; next.modelsFetchedAt = null; }
  }
  return next;
}

/**
 * /models 的响应正文 → 排好序的模型名列表；格式不认识返回 null。模型名也过一遍 scrub（有的中转会把 key 拼进返回里）。
 * @returns {string[]|null}
 */
export function parseModelList(j, key) {
  const list = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : null;
  if (!list) return null;
  const ids = cleanModels(list.map((x) => (typeof x === 'string' ? x : x && typeof x.id === 'string' ? x.id : '')).map((s) => scrub(s, key)));
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.slice(0, MAX_MODELS);
}

// ═════════════════════════════ ② 上游协议 ═════════════════════════════

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60000; // 连接 / 首字节（响应头）超时；服务端可用环境变量改
export const DEFAULT_MODELS_TIMEOUT_MS = 15000;
const ERR_MAX = 500; // 透传给用户的上游错误文本上限

/** 抹掉文本里出现的 key（原文、JSON 转义形式、URL 编码形式）。 */
export function scrub(text, key) {
  let s = String(text ?? '');
  if (!key) return s;
  const forms = new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]);
  for (const f of forms) if (f) s = s.split(f).join('[已隐藏]');
  return s;
}

const cap = (s) => (s.length > ERR_MAX ? s.slice(0, ERR_MAX) + '…' : s);

/** 从上游错误响应体里挑出人能读的那句话：JSON 的 error.message / error / message，否则原文。 */
export function extractErrorMessage(bodyText, key) {
  let msg = bodyText.trim();
  try {
    const j = JSON.parse(bodyText);
    const e = j && j.error;
    const m = (e && typeof e === 'object' ? e.message : typeof e === 'string' ? e : null) ?? (j && typeof j.message === 'string' ? j.message : null);
    if (typeof m === 'string' && m) msg = m;
  } catch {}
  return cap(scrub(msg, key));
}

/** 把 SSE / JSON 事件里的 error 字段变成文字（error 可能是对象、字符串）。 */
export function eventErrorText(err, key) {
  const m = err && typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : String(err);
  return cap(scrub(String(m), key));
}

/** 只允许的采样参数，且必须是有限数字；max_tokens 还必须 >= 1（取整）。其余键丢弃。 */
export function pickParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const k of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
    if (typeof params[k] === 'number' && Number.isFinite(params[k])) out[k] = params[k];
  }
  if (typeof params.max_tokens === 'number' && Number.isFinite(params.max_tokens) && params.max_tokens >= 1) out.max_tokens = Math.floor(params.max_tokens);
  return out;
}

/** 发给上游的消息：{role, content, name?} 原样（name 只在是非空字符串时保留）。 */
export const toUpstreamMessages = (messages) =>
  messages.map((m) => (typeof m.name === 'string' && m.name ? { role: m.role, content: m.content, name: m.name } : { role: m.role, content: m.content }));

// ───────────────────────── 提示缓存标记（OpenRouter + Anthropic 模型）─────────────────────────
// 为什么：Anthropic 的模型只缓存「明确标了断点」的开头（cache_control），不标就完全没有缓存。经 OpenRouter 用 OpenAI 兼容格式调
// anthropic/* 模型时，OpenRouter 认消息内容 text 块上的 cache_control 并转给 Anthropic。其它厂商（OpenAI、DeepSeek……）是自动缓存，
// 不需要、也不认这个字段，所以只对「OpenRouter + anthropic/ 模型」加。
//
// 依据（2026-11-22 核对的 https://openrouter.ai/docs/guides/best-practices/prompt-caching ）：
//   - 块级写法：消息的 content 写成数组 [{type: 'text', text, cache_control: {type: 'ephemeral'}}]；文档里的块级例子全是数组形式；
//   - TTL：cache_control 里加 ttl: '1h'；不写是 5 分钟；
//   - 价格（相对原价）：5 分钟档写入 1.25 倍，1 小时档写入 2 倍，读取 0.1 倍；
//   - 显式断点最多 4 个；短于模型下限（512～4096 token，看型号）的开头不缓存；
//   - 另有请求根上一个 cache_control 的「自动」写法：断点放在最后一个可缓存的块上、随对话往后挪。没用它，原因见下面「断点放哪」。
// 为什么用 1 小时档：聊天时两条消息之间常常隔好几分钟，5 分钟档到期了就白交了写入费；1 小时档写入贵一倍，但只要一小时里再发一条就赚回来。
//
// 酒馆的做法（src/prompt-converters.js cachingSystemPromptForOpenRouter / cachingAtDepthForOpenRouterClaude，
// 由 src/endpoints/backends/chat-completions.js 在 OpenRouter + /^anthropic\/claude/ 时调用）：
//   ① 第一条 system 消息整条标一个；② 从末尾往前数「角色切换次数」（跳过末尾的预填 assistant 和所有 system），
//   在深度 N 和 N+2 处各标一个。两者默认都【关】（config.yaml 的 claude.enableSystemPromptCache / claude.cachingAtDepth），TTL 默认 5 分钟。
// 我们的差别：默认【开】、用 1 小时档；①改成标在「开头那一串 system 的最后一条」（和倒数第二条）——我们的预设 + 角色卡是好几条 system，
//   只标第一条只能缓存主提示那一小段；②沿用酒馆的思路，固定 N = 1。
//
// 断点放哪（最多 4 个，按顺序）：
//   A. 开头那一串连续 system 消息的最后一条：预设 + 角色卡 + 世界书（前 / 后）+ 外置记忆块，最大、最稳定的一块；
//   B. 同一串里的倒数第二条：开着外置记忆时，记忆块就是这一串的最后一条，它每攒够一批会变一次；B 让「预设 + 卡」那段在记忆块变了之后
//      照样能命中（没有记忆块时 B 只是一个稍短的前缀，不多花钱：同一段内容只按一次写入计费）；
//   C、D. 聊天记录里，从末尾往前数角色切换：跳过末尾的预填 assistant 和所有 system（深度注入、Post-History 等），
//      深度 0 是最新的用户输入（每次都变，不标），深度 1 是上一条回复，深度 3 是再往前一条回复。标 1 和 3：
//      下一次请求多了「一条回复 + 一条输入」，这次的深度 1 恰好变成下一次的深度 3，同一个断点位置、同样的前缀 → 命中；
//      这次的深度 1 则写入新的一段。
//   请求根上的「自动」写法只在最末尾放一个断点；我们的末尾常常是 Post-History 指令 / 预填，下一次请求里它们挪到了新消息后面，
//   上次写入的前缀在新请求里就不再是同一段，命中不了，所以不用它。
// 空内容的消息不标（Anthropic 不接受给空文本块加缓存标记），往前找最近的非空那条。
//
// 这一步是「发送前的最后一步」：只改发给上游的请求体副本，不影响「拼装」页、「和上次发送比较」、存储。
// 不满足条件时原样返回同一个数组，请求体和以前逐字节相同。

export const PROMPT_CACHE_CONTROL = Object.freeze({ type: 'ephemeral', ttl: '1h' });
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * 是不是「经 OpenRouter 调 Anthropic 的模型」：接口地址的主机是 openrouter.ai 或它的子域（大小写不论、末尾的点去掉），
 * 且模型名以 anthropic/ 开头（OpenRouter 文档里还有 ~anthropic/claude-sonnet-latest 这种「最新版」别名，也算）。
 * openrouter.ai.evil.com、evil-openrouter.ai 这类不算。
 */
export function isOpenRouterAnthropic(baseUrl, model) {
  let host;
  try { host = new URL(String(baseUrl)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  const onOpenRouter = host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  return onOpenRouter && typeof model === 'string' && /^~?anthropic\//i.test(model.trim());
}

/** 这条消息有没有能标的文字（字符串非空，或数组里有非空的 text 块） */
const hasText = (m) => (typeof m.content === 'string' ? m.content.length > 0
  : Array.isArray(m.content) && m.content.some((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.length > 0));

/**
 * 断点要标在哪几条消息上（下标，从小到大，最多 4 个）。规则见上面「断点放哪」。纯函数，不改 messages。
 * @param {{role: string, content: any}[]} messages
 * @returns {number[]}
 */
export function cacheBreakpoints(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = new Set();
  // A、B：开头那一串 system
  let s = 0;
  while (s < list.length && list[s] && list[s].role === 'system') s++;
  const leading = [];
  for (let i = s - 1; i >= 0 && leading.length < 2; i--) if (hasText(list[i])) leading.push(i);
  for (const i of leading) out.add(i);
  // C、D：聊天里的深度 1 和 3（照酒馆 cachingAtDepthForOpenRouterClaude 数角色切换）
  const N = 1;
  let passedPrefill = false, depth = 0, prev = '';
  for (let i = list.length - 1; i >= s; i--) {
    const m = list[i];
    if (!m) continue;
    if (!passedPrefill && m.role === 'assistant') continue;   // 末尾的预填：给它标断点没有意义（它每次都可能变）
    passedPrefill = true;
    if (m.role === 'system') continue;
    if (m.role !== prev) {
      if ((depth === N || depth === N + 2) && hasText(m)) out.add(i);
      if (depth === N + 2) break;
      depth += 1;
      prev = m.role;
    }
  }
  return [...out].sort((a, b) => a - b).slice(-MAX_CACHE_BREAKPOINTS);
}

/** 给一条消息标断点：返回新对象（content 字符串 → 单个 text 块的数组；已经是数组 → 最后一个非空 text 块加上标记），不改入参 */
function markMessage(m) {
  if (typeof m.content === 'string') return { ...m, content: [{ type: 'text', text: m.content, cache_control: { ...PROMPT_CACHE_CONTROL } }] };
  const parts = m.content.map((p) => (p && typeof p === 'object' ? { ...p } : p));
  for (let k = parts.length - 1; k >= 0; k--) {
    const p = parts[k];
    if (p && p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) { p.cache_control = { ...PROMPT_CACHE_CONTROL }; break; }
  }
  return { ...m, content: parts };
}

/**
 * 发送前的最后一步：满足条件时返回【加了缓存标记的新数组】（只有被标的那几条换成新对象，别的消息原样、content 仍是字符串）；
 * 不满足条件（开关关着、不是 OpenRouter、不是 anthropic/ 模型、没有可标的位置）时返回【同一个】数组。
 * @param {{role: string, content: any, name?: string}[]} messages  toUpstreamMessages 的结果
 * @param {{baseUrl: string, model: string, enabled: boolean}} opts  enabled = 请求里的 promptCache 不是 false
 */
export function applyPromptCache(messages, { baseUrl, model, enabled }) {
  if (!enabled || !Array.isArray(messages) || !isOpenRouterAnthropic(baseUrl, model)) return messages;
  const at = cacheBreakpoints(messages);
  if (!at.length) return messages;
  const marked = new Set(at);
  return messages.map((m, i) => (marked.has(i) ? markMessage(m) : m));
}

/**
 * 增量 SSE 解析器。push(字符串) 喂文本，每收齐一个事件就调 onData(dataString)；end() 冲刷残余。
 * 处理：事件被拆在多个 chunk、\r\n / \n / \r 换行、: 开头的注释（keep-alive）、一个事件多行 data:。
 * （data: [DONE] 也原样交给 onData，由调用方识别。）
 */
export function createSseParser(onData) {
  let buf = '';
  let dataLines = [];
  const dispatch = () => {
    if (!dataLines.length) return;
    const lines = dataLines; dataLines = [];
    const joined = lines.join('\n');
    // 规范里多行 data 要用 \n 拼成一个事件；但有的上游把每行 JSON 各写一行却不留空行——拼起来解析不了就逐行当事件
    if (lines.length > 1) {
      try { JSON.parse(joined); } catch { if (joined.trim() !== '[DONE]') { lines.forEach(onData); return; } }
    }
    onData(joined);
  };
  const line = (l) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;                     // 注释 / 心跳
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    if (field !== 'data') return;                      // event: / id: / retry: 都不关心
    let v = i < 0 ? '' : l.slice(i + 1);
    if (v.startsWith(' ')) v = v.slice(1);
    dataLines.push(v);
  };
  return {
    push(text) {
      buf += text;
      let i;
      // 找下一个换行；buf 以 \r 结尾时无法判断后面是不是 \n，先等下一块
      while ((i = buf.search(/\r\n|\n|\r(?!$)/)) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + (buf.startsWith('\r\n', i) ? 2 : 1));
        line(l);
      }
    },
    end() {
      if (buf) { const l = buf.replace(/\r$/, ''); buf = ''; line(l); }
      dispatch();
    },
  };
}

/** 从一个已解析的 chat-completions 对象（流式 chunk 或完整响应）里取出正文：只认 delta.content / message.content。 */
export function contentOf(obj) {
  const c = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (!c) return '';
  // reasoning_content / reasoning / tool_calls 一律不看
  return c.delta && typeof c.delta.content === 'string' ? c.delta.content
    : c.message && typeof c.message.content === 'string' ? c.message.content : '';
}

// ───────────────────────── 用量（usage）与 stream_options ─────────────────────────
// 为什么要用量：很多接口对「和上次完全相同的开头」按低价计费（提示缓存），命中了多少只有上游自己知道，
// 它写在响应的 usage 里。流式请求默认不带 usage，要在请求体里加 stream_options: {include_usage: true}，
// 上游才会在流的最后（[DONE] 之前）多发一块 {choices: [], usage: {...}}。（这是 OpenAI 的写法，多数兼容接口照抄；
// 酒馆 1.19.0 的源码里没有这个字段，所以没有现成的参照，这里按 OpenAI 的文档来。）
// 非流式 / 上游无视 stream:true 时，usage 就在整块响应体的顶层。

/** 请求体里要加的字段 */
export const STREAM_OPTIONS = Object.freeze({ include_usage: true });

/** 非负有限数字才算数（字符串、负数、NaN 都当没有）；取整 */
const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const first = (...vs) => { for (const v of vs) if (v != null) return v; return null; };

/**
 * 把各家不同写法的 usage 统一成 {inputTokens, cachedTokens, cacheWriteTokens, outputTokens}（没有的为 null）。
 * 完全认不出（不是对象，或四项全是 null）返回 null。
 *   OpenAI / OpenRouter / Groq / Mistral / 百炼：prompt_tokens、completion_tokens、prompt_tokens_details.cached_tokens（OpenRouter 另有 cache_write_tokens）
 *   DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens（输入 = 命中 + 未命中，没有 prompt_tokens 时用它）
 *   Anthropic 风格（有的中转透传）：cache_read_input_tokens / cache_creation_input_tokens、input_tokens / output_tokens。
 *     注意 Anthropic 原生的 input_tokens【不含】缓存部分；兼容接口的 prompt_tokens 含。这里没有 prompt_tokens 时
 *     把 input_tokens + 读缓存 + 写缓存 当作输入总数，这样「命中百分比」两种写法下含义一致。
 * 「cachedTokens 为 null」和「为 0」是两回事：前者是上游根本没报缓存，界面不能显示成 0%。
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const det = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const cached = first(cnt(det.cached_tokens), cnt(u.prompt_cache_hit_tokens), cnt(u.cache_read_input_tokens));
  const write = first(cnt(det.cache_write_tokens), cnt(u.cache_creation_input_tokens));
  const hit = cnt(u.prompt_cache_hit_tokens), miss = cnt(u.prompt_cache_miss_tokens);
  let input = cnt(u.prompt_tokens);
  if (input == null && hit != null && miss != null) input = hit + miss;
  if (input == null && cnt(u.input_tokens) != null) input = cnt(u.input_tokens) + (cnt(u.cache_read_input_tokens) ?? 0) + (cnt(u.cache_creation_input_tokens) ?? 0);
  const out = { inputTokens: input, cachedTokens: cached, cacheWriteTokens: write, outputTokens: first(cnt(u.completion_tokens), cnt(u.output_tokens)) };
  return Object.values(out).every((v) => v == null) ? null : out;
}

/**
 * 上游拒绝请求的原因是不是「不认识 stream_options」。有的中转对未知字段直接回 400（偶尔 422），
 * 错误信息里会点名 stream_options 或 include_usage。只认这种明确点名的，别的 400 不重试。
 */
export function isStreamOptionsRejection(status, text) {
  return (status === 400 || status === 422) && /stream_options|include_usage/i.test(String(text ?? ''));
}

/**
 * 读 chat-completions 响应体的「判别 + 解析」状态机（网页版直连用；server.mjs 的 handleOpenAI 里是同样逻辑的内联写法）。
 * 判别：首个非空白字符是 { → 上游无视了 stream:true，返回的是一整块 JSON；否则当 SSE 流。
 * 只把正文增量交给 onText；推理内容（reasoning_content 等）不转发；data: [DONE] 或事件里的 error 让 stopped 变成 true。
 * @param {(text: string) => void} onText
 * @param {string} key  报错文字里要抹掉的 key
 * @returns {{feed(text: string): void, finish(): void, readonly stopped: boolean, readonly error: string|null}}
 *          feed 喂解码后的文本；读完（没有提前停）调 finish；error = 上游在流里 / JSON 里报的错（已抹 key）
 */
export function createCompletionReader(onText, key) {
  let stop = false, error = null, mode = null, whole = '', pending = '', usage = null;
  const emit = (t) => { if (t) onText(t); };
  const sse = createSseParser((data) => {
    if (stop) return;
    const d = data.trim();
    if (d === '[DONE]') { stop = true; return; }
    let o; try { o = JSON.parse(d); } catch { return; } // 单个坏事件跳过
    if (o && o.error) { error = eventErrorText(o.error, key); stop = true; return; }
    const u = normalizeUsage(o && o.usage); if (u) usage = u;   // 最后一块（choices 为空）带 usage；有的上游每块都带累计值，后来的覆盖前面的
    emit(contentOf(o));
  });
  return {
    feed(text) {
      if (!text || stop) return;
      if (!mode) {
        pending += text;
        const first = pending.trimStart()[0];
        if (!first) return;
        mode = first === '{' ? 'json' : 'sse';
        text = pending; pending = '';
      }
      if (mode === 'json') whole += text; else sse.push(text);
    },
    finish() {
      if (mode === 'sse' && !stop) sse.end();
      if (mode === 'json') {
        let o = null; try { o = JSON.parse(whole); } catch {}
        if (!o) error = '上游返回的内容不是合法 JSON';
        else if (o.error) error = eventErrorText(o.error, key);
        else { usage = normalizeUsage(o.usage) ?? usage; emit(contentOf(o)); }
      }
    },
    get stopped() { return stop; },
    /** 上游报的用量（已统一格式），没有为 null */
    get usage() { return usage; },
    get error() { return error; },
  };
}
