// 「页面直连」后端（网页版用）：没有本地服务时，由页面自己 fetch 用户填的 OpenAI 兼容接口。
// 对外的函数和 llm.js 里 server 后端那组一一对应、返回形状相同（规格见 types.js「两种后端」），
// 界面模块不知道、也不需要知道现在是哪种后端。
//
// 接口列表存在浏览器 IndexedDB 里一个单独的键 'endpoints'（形状同服务端的 config.json：{version: 2, endpoints: Endpoint[]}）。
// 它不在 'global' 里：整体备份读存储时按白名单（global / card:* / chat:* / preset:*）读，不会顺手把这个键整个带走；
// 接口（含 key）只经 exportEndpointsForBackup() 这一个出口进入备份，并且含 key 的备份一定整体加密（见 src/ui/backup.js）。
//
// key 在页面里的去向（这是本文件最要紧的约束）：
//   - 输入：「接口」页的密码框 → createEndpoint / updateEndpoint 的参数 → 校验后写进 IndexedDB。界面提交后清空密码框。
//   - 使用：只在 post() / fetchEndpointModels() 里、发请求的那一刻从存储读出来，放进 Authorization 头。用完即弃，不缓存在模块变量里。
//   - 返回：所有函数返回的都是 PublicEndpoint（只有 hasKey，没有 apiKey），是新建的对象，不和存储里那份共享任何可变部分。
//     唯一的例外是 exportEndpointsForBackup()（整体备份用，只有 src/ui/backup.js 经 llm.js 调用）：它返回明文 key，
//     调用方负责把它加密后才落到文件里。
//   - 报错：所有报错文字都先过 scrub（原文 / JSON 转义 / URL 编码三种形式都抹掉）。
// 这样页面里其它模块、前端卡的宿主桥（frame-host.js）都没有现成的途径拿到它。
// 但要说实话：key 明文存在这个网站的 IndexedDB 里，主页面一旦被注入脚本（比如我们自己的代码出了 XSS 漏洞），
// 注入的脚本照样能直接读 IndexedDB。前端卡跑在没有同源权限的 iframe 里，碰不到父页面的 IndexedDB。
//
// 和服务端共用的规则都在 openai-shared.js：字段校验、站点绑定、公开版、抹 key、采样参数白名单、SSE / 整块 JSON 的解析。
// 这里只多了浏览器特有的几件事：跨域失败的提示、redirect 'manual' 在浏览器里的样子（opaqueredirect）、只读标签页不许改。

import {
  CLAUDE_ID, isBuiltinId, MAX_ENDPOINTS, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_MODELS_TIMEOUT_MS,
  sanitizeEndpoints, publicEndpoint, newEndpoint, patchEndpoint, parseModelList,
  scrub, extractErrorMessage, pickParams, toUpstreamMessages, createCompletionReader,
  STREAM_OPTIONS, isStreamOptionsRejection, applyPromptCache,
} from './openai-shared.js';

/** IndexedDB 里存接口列表的键（不要放进 global：global 会被整体备份原样带走，key 不能走那条不加密也照样写出的路） */
export const STORE_KEY = 'endpoints';

// 网页版里没有内置的命令行类接口（Claude Code、Codex 都要在本机运行），列表里也不列它们。所以这里的文字都不提它们的名字：
// 已保存的引用默认指向 claude-code，对网页版的用户来说那就是「还没选接口」（界面上的说法见 model-picker.js 的 refUnpicked）。
export const CLAUDE_DIRECT_DETAIL = '网页版需要先添加一个 OpenAI 兼容接口';
// 文字里带「还没选聊天用的接口」：聊天区的报错提示（chat.js showGenError）据此给出建议
const CLAUDE_DIRECT_SEND = '还没选聊天用的接口：到手机 Settings 的「接口」页添加一个 OpenAI 兼容接口，再在页面顶部选它。';
const NO_ENDPOINT = '找不到这个接口（可能已被删除）：聊天用的请到手机 Settings 的「接口」页重新选，压缩用的在「记忆」页重新选。';
const BUILTIN = '这是本地版才有的内置接口，网页版里不能修改、删除或获取模型列表';
const GONE = '没有这个接口（可能已被删除）';


const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * 造一个直连后端。参数都是"外面的世界"，测试时换成假的：
 * @param {{
 *   kv: {get(key: string): Promise<any>, transact(keys: string[], fn: (values: any[]) => any[]): Promise<boolean>},
 *   fetchFn?: typeof fetch,              默认每次现取 globalThis.fetch（这样测试 / 页面里后来包一层 fetch 也能生效）
 *   canWrite?: () => string|null,        返回 null = 可以写；否则是不能写的原因（只读标签页等）
 *   pageUrl?: () => string,              当前页面地址（判断 https 页面请求 http 地址的情况）
 *   firstByteTimeoutMs?: number, modelsTimeoutMs?: number,
 * }} deps
 */
export function createDirectBackend({
  kv,
  fetchFn = (...a) => globalThis.fetch(...a),
  canWrite = () => null,
  pageUrl = () => globalThis.location?.href ?? '',
  firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  modelsTimeoutMs = DEFAULT_MODELS_TIMEOUT_MS,
} = {}) {
  // 不认识 stream_options 的接口（按 baseUrl）：只记在内存里（页面刷新就忘，不写存储），之后的请求不再带这个字段
  const noStreamOptions = new Set();

  // ───────── 存储 ─────────
  // 每次现读、现清洗：存储里的东西可能是旧版本 / 手改坏的，清洗规则和服务端读 config.json 一样
  const readList = async () => {
    const raw = await kv.get(STORE_KEY);
    return sanitizeEndpoints(raw && raw.version === 2 ? raw.endpoints : []);
  };

  /**
   * 读-改-写放在同一个 IndexedDB 事务里（别的写插不进来）。fn(list) 返回 {list?, result}：给了 list 就写回。
   * fn 里抛的错（校验失败等）会中止事务、原样抛给调用方。
   */
  async function mutate(fn) {
    const why = canWrite();
    if (why) throw new Error(why);
    let result;
    await kv.transact([STORE_KEY], ([raw]) => {
      const r = fn(sanitizeEndpoints(raw && raw.version === 2 ? raw.endpoints : []));
      result = r.result;
      return r.list ? [{ set: STORE_KEY, value: { version: 2, endpoints: r.list } }] : [];
    });
    return result;
  }

  const findIndex = (list, id) => list.findIndex((e) => e.id === id);

  // ───────── 接口列表 ─────────
  async function listEndpoints() {
    return (await readList()).map(publicEndpoint); // 只有用户自己加的；内置的命令行类接口网页版没有，不列
  }

  function createEndpoint(input) {
    return mutate((list) => {
      if (list.length >= MAX_ENDPOINTS) throw new Error(`接口最多 ${MAX_ENDPOINTS} 个，请先删掉不用的`);
      const ep = newEndpoint(input);
      return { list: [...list, ep], result: publicEndpoint(ep) };
    });
  }

  function updateEndpoint(id, patch) {
    if (isBuiltinId(id)) return Promise.reject(new Error(BUILTIN));
    return mutate((list) => {
      const i = findIndex(list, id);
      if (i < 0) throw new Error(GONE);
      const next = patchEndpoint(list[i], patch);
      list[i] = next;
      return { list, result: publicEndpoint(next) };
    });
  }

  /**
   * 整体备份用（只给 llm.js 的同名函数转用，规则见那里）：[{name, baseUrl, models, apiKey}]，没填 key 的 apiKey 为 ''。
   * 不含 id。返回新建的对象，不和存储里那份共享可变部分。
   */
  async function exportEndpointsForBackup() {
    return (await readList()).map((e) => ({ name: e.name, baseUrl: e.baseUrl, models: [...e.models], apiKey: e.apiKey }));
  }

  async function deleteEndpoint(id) {
    if (isBuiltinId(id)) throw new Error(BUILTIN);
    await mutate((list) => {
      const i = findIndex(list, id);
      if (i < 0) throw new Error(GONE);
      list.splice(i, 1);
      return { list };
    });
  }

  // ───────── 发请求的公共部分 ─────────

  /**
   * 浏览器里 fetch 失败只会抛一个没有细节的 TypeError（"Failed to fetch"）：跨域被拦、地址不存在、断网，长得一模一样。
   * 页面拿不到更多信息，所以把几种可能都说出来，并指出压缩包版不受跨域限制。
   */
  function networkFailText(e, url, key) {
    let target = null, pageProto = '';
    try { target = new URL(url); } catch {}
    try { pageProto = new URL(pageUrl()).protocol; } catch {}
    const raw = scrub((e && e.message) || String(e), key);
    const where = target ? target.origin : '这个接口';
    if (pageProto === 'https:' && target && target.protocol === 'http:') {
      return `连不上 ${where}：这个网页是用 https 打开的，浏览器一般不允许它去请求 http:// 开头的地址（"混合内容"）。`
        + '局域网 / 本机上的模型（Ollama 等）请用压缩包版（由本地服务转发，不受这个限制）；如果接口本身支持 https，把地址改成 https://。'
        + `（浏览器给的原始信息：${raw}）`;
    }
    return `连不上 ${where}。可能的原因：① 这个接口不允许网页直接访问（跨域 / CORS：浏览器拦下了请求；有的厂商或中转站只允许服务器调用，`
      + '也有的只在请求成功时才带跨域头，key 填错时浏览器同样只能报这个错）；② 接口地址写错了；③ 网络不通（或需要代理）。'
      + `压缩包版由本地服务转发请求，不受跨域限制，可以换它试试。（浏览器给的原始信息：${raw}）`;
  }

  /**
   * fetch 一次上游，处理：合并调用方的中止信号、首字节超时、不跟随重定向、只带 Authorization / Content-Type 两个头、不带 cookie。
   * 返回 {res, ac, cleanup}；失败抛 Error（文字已抹 key），调用方中止抛 AbortError。
   */
  async function upstream(url, { method, key, body, signal, timeoutMs, timeoutText }) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) throw abortError(); signal.addEventListener('abort', onAbort); }
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    // 只带这两个自定义头：有的厂商的跨域预检只放行 authorization 和 content-type。
    // Accept 本来是"安全"头不会触发预检，但也不加，保持最少。
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    let res;
    try {
      res = await fetchFn(url, {
        method, headers, body, signal: ac.signal,
        redirect: 'manual',          // 不跟随重定向：免得带着 key 被转去别处（浏览器里会得到 type 为 opaqueredirect 的响应）
        credentials: 'omit',         // 不带 cookie / HTTP 认证
        referrerPolicy: 'no-referrer', // 不把页面地址告诉上游（Origin 头浏览器还是会带，跨域必须）
      });
    } catch (e) {
      clearTimeout(timer); cleanup();
      if (signal && signal.aborted) throw abortError();
      if (timedOut) throw new Error(timeoutText);
      throw new Error(networkFailText(e, url, key));
    }
    clearTimeout(timer);
    return { res, ac, cleanup };
  }

  const isRedirect = (res) => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
  const readText = async (res, max) => { try { return (await res.text()).slice(0, max); } catch { return ''; } };

  // ───────── 模型列表 ─────────
  async function fetchEndpointModels(id) {
    if (isBuiltinId(id)) throw new Error(BUILTIN);
    const why = canWrite(); // 结果要写进存储：只读标签页连请求都不发
    if (why) throw new Error(why);
    const ep = (await readList()).find((e) => e.id === id);
    if (!ep) throw new Error(GONE);
    const { baseUrl, apiKey } = ep;
    const bad = (msg) => new Error(scrub(msg, apiKey));
    if (!baseUrl) throw bad('还没有设置接口地址（Base URL）。');
    const { res, cleanup } = await upstream(`${baseUrl}/models`, {
      method: 'GET', key: apiKey, timeoutMs: modelsTimeoutMs,
      timeoutText: `查询模型列表超时（${modelsTimeoutMs / 1000} 秒）`,
    });
    let text;
    try { text = await readText(res, 4 * 1024 * 1024); } finally { cleanup(); }
    if (isRedirect(res)) throw bad(`上游返回了重定向${res.status ? `（HTTP ${res.status}）` : ''}，请检查接口地址。`);
    if (!res.ok) throw bad(`上游返回 HTTP ${res.status}：${extractErrorMessage(text, apiKey) || res.statusText}`);
    let j; try { j = JSON.parse(text); } catch { throw bad('上游返回的不是合法 JSON'); }
    const ids = parseModelList(j, apiKey);
    if (!ids) throw bad('上游返回的格式不认识（期望 {data:[{id}]} 或数组）');
    // 查询期间配置可能变了：同一个事务里重新读，只有「接口还在、地址和 key 都没变」才写缓存
    return mutate((list) => {
      const i = findIndex(list, id);
      if (i < 0) throw new Error('没有这个接口（查询期间被删除了）');
      const cur = list[i];
      if (cur.baseUrl !== baseUrl || cur.apiKey !== apiKey) throw new Error('查询期间接口的地址或 key 被修改了，请重新获取');
      cur.models = ids; cur.modelsFetchedAt = new Date().toISOString();
      return { list, result: publicEndpoint(cur) };
    });
  }

  // ───────── 生成 ─────────

  /**
   * 对应服务端的 /api/generate（handleGenerate + handleOpenAI）：同样的校验、同样的报错文字、同样的流式规则。
   * @param {object} body  {messages, endpoint?, model?, params?} 或 {system?, prompt, endpoint?, model?, params?}
   * @param {{onDelta?: (textSoFar: string) => void, onUsage?: (usage: import('./types.js').NormalizedUsage) => void, signal?: AbortSignal}} opts
   *   onUsage：上游报了用量时在回复结束前调用一次（统一格式见 normalizeUsage）；没报就不调用
   * @returns {Promise<string>}
   */
  async function post(body, { onDelta, onUsage, signal } = {}) {
    if (body.endpoint != null && typeof body.endpoint !== 'string') throw new Error('endpoint 必须是字符串（接口 id）');
    const endpointId = body.endpoint ?? CLAUDE_ID;
    if (isBuiltinId(endpointId)) throw new Error(CLAUDE_DIRECT_SEND); // claude-code / codex：网页版没有，等于还没选接口
    const raw = typeof body.prompt === 'string' && body.prompt.length > 0;
    const ok = raw
      ? (body.system == null || typeof body.system === 'string')
      : (Array.isArray(body.messages) && body.messages.length > 0 &&
        body.messages.every((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string'));
    if (!ok) throw new Error('messages 必须是非空数组，每项形如 {role: system|user|assistant, content: string, name?}；或者给 {system?, prompt}');
    if (body.model != null && typeof body.model !== 'string') throw new Error('model 必须是字符串');

    // 每次请求现读存储，所以删 / 改接口立刻生效。key 只活在这个函数的局部变量里
    const ep = (await readList()).find((e) => e.id === endpointId);
    if (!ep) throw new Error(NO_ENDPOINT);
    const { baseUrl, apiKey } = ep;
    const missing = [];
    if (!baseUrl) missing.push('接口地址（Base URL）');
    if (!apiKey) missing.push('API Key');
    if (missing.length) throw new Error(`接口「${scrub(ep.name, apiKey)}」还没配置好：缺${missing.join('、')}。请到手机 Settings 的「接口」页补全。`);
    const model = body.model;
    if (!model) throw new Error('没有选择模型：聊天用的请到手机 Settings 的「接口」页选，压缩用的在「记忆」页选。');

    // 和服务端 handleOpenAI 同一条规则：聊天请求经 OpenRouter 调 anthropic/ 模型时加缓存标记（openai-shared.js applyPromptCache），
    // promptCache: false = 「拼装」页关掉了；直通（记忆压缩）不加。不满足条件时 messages 原样不变
    const messages = raw
      ? [...(body.system ? [{ role: 'system', content: body.system }] : []), { role: 'user', content: body.prompt }]
      : applyPromptCache(toUpstreamMessages(body.messages), { baseUrl, model, enabled: body.promptCache !== false });
    // 请求体：带 stream_options 才能让上游在流末尾报用量；这个接口拒绝过就不带
    const payloadOf = (withUsage) => JSON.stringify({ model, messages, stream: true, ...(withUsage ? { stream_options: STREAM_OPTIONS } : {}), ...pickParams(body.params) });
    const fail = (msg) => new Error(scrub(msg, apiKey));
    const send = (withUsage) => upstream(`${baseUrl}/chat/completions`, {
      method: 'POST', key: apiKey, body: payloadOf(withUsage), signal, timeoutMs: firstByteTimeoutMs,
      timeoutText: `连接上游超时（${firstByteTimeoutMs / 1000} 秒内没有响应），请检查接口地址和网络。`,
    });

    const withUsage = !noStreamOptions.has(baseUrl);
    let up = await send(withUsage);
    // 只有「被拒绝」（还没有任何正文）时才会走到重试，所以不可能把回复生成两次、也不会重复发已经流出的内容。
    // 重试用的头、地址、key 和第一次完全一样，只是请求体里少了 stream_options；最多重试这一次。
    let errText = null;
    if (withUsage && !isRedirect(up.res) && !up.res.ok) {
      errText = await readText(up.res, 65536);
      if (isStreamOptionsRejection(up.res.status, errText)) {
        noStreamOptions.add(baseUrl);
        up.cleanup();
        up = await send(false);
        errText = null;
      }
    }
    const { res, cleanup } = up;
    try {
      if (isRedirect(res)) throw fail(`上游返回了重定向${res.status ? `（HTTP ${res.status}）` : ''}，请检查接口地址是否正确（协议 http/https、结尾的 /v1）。`);
      if (!res.ok) {
        const text = errText ?? await readText(res, 65536);
        const msg = extractErrorMessage(text, apiKey) || res.statusText;
        throw fail(`上游返回 HTTP ${res.status}${msg ? '：' + msg : ''}`);
      }

      let text = '';
      const reader = createCompletionReader((t) => { text += t; if (onDelta) onDelta(text); }, apiKey);
      // 读流：getReader + 流式 TextDecoder（跨 chunk 的多字节字符不会被截坏）。
      // 不用 for await 遍历 res.body、不用 {mode: 'byob'}：iOS Safari 对这两种支持有坑。
      const r = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let readErr = null;
      try {
        while (!reader.stopped) {
          const { done, value } = await r.read();
          if (done) break;
          reader.feed(dec.decode(value, { stream: true }));
        }
        if (!reader.stopped) reader.feed(dec.decode());
      } catch (e) { readErr = e; }
      if (reader.stopped) r.cancel().catch(() => {});
      // 用户点了「停止」：和 server 后端一样抛 AbortError（已经收到的部分调用方通过 onDelta 拿到了）
      if (signal && signal.aborted) throw abortError();
      if (!readErr) reader.finish();
      if (onUsage && reader.usage) { try { onUsage(reader.usage); } catch {} }   // 用量只是展示用的，回调出错不能影响回复
      if (text) return text;              // 已经开始出字：后面出任何问题都只是结束（和服务端一致）
      if (readErr) throw fail(`读取上游响应失败：${(readErr && readErr.message) || readErr}`);
      if (reader.error) throw fail(`上游报错：${reader.error}`);
      throw fail('上游没有返回任何正文（可能只返回了推理内容，或被内容审核拦截）');
    } finally { cleanup(); }
  }

  /** 网页版没有 claude 可执行文件可找 */
  async function checkHealth() {
    return { ok: false, claudePath: null, error: CLAUDE_DIRECT_DETAIL };
  }

  return { listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, fetchEndpointModels, post, checkHealth, exportEndpointsForBackup };
}
