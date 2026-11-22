// smalltalk 本地服务：① 提供静态文件 ② 把拼好的 messages 转给 `claude -p`（无头模式）并流式回传。
// 零依赖，仅监听 127.0.0.1。启动：node server.mjs（端口取环境变量 PORT，默认 5178）。
// 用法：node server.mjs [--open]    --open：监听成功后用系统默认浏览器打开页面（给"双击即用"的启动脚本用）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeMessages } from './src/llm.js';
import {
  CLAUDE_ID, CODEX_ID, BUILTIN_NAMES, isBuiltinId, MAX_ENDPOINTS, MAX_MODELS, loadConfig, saveConfig, configDir, publicEndpoint, publicEndpoints,
  newEndpoint, patchEndpoint, cleanModels,
} from './server/config.mjs';
import { runCli } from './server/cli-common.mjs';
import { findCodex, codexArgs, codexEnv, codexInstructions, createCodexReader, codexFinish, isSafeModelName } from './server/cli-codex.mjs';
import {
  FIRST_BYTE_TIMEOUT_MS, MODELS_TIMEOUT_MS, scrub, extractErrorMessage, eventErrorText,
  pickParams, toUpstreamMessages, createSseParser, contentOf, normalizeUsage, isStreamOptionsRejection, STREAM_OPTIONS, applyPromptCache,
} from './server/openai.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5178;
const MAX_BODY = 20 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// ───────── 定位 claude（启动时只做一次，结果可能为 null）─────────
function findClaude() {
  // 1. 显式指定。测试用的小把戏：若是 .js/.mjs，则用当前 node 去跑它（不用 shell 也能有「假 claude」）。
  if (process.env.SMALLTALK_CLAUDE) return fs.existsSync(process.env.SMALLTALK_CLAUDE) ? process.env.SMALLTALK_CLAUDE : null; // 显式指定但不存在 → 视为未找到
  // 2. VS Code 扩展自带的原生二进制，取版本号最高的
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = [];
  for (const dir of ['.vscode', '.vscode-insiders']) {
    const extDir = path.join(os.homedir(), dir, 'extensions');
    let names = [];
    try { names = fs.readdirSync(extDir); } catch {}
    for (const n of names) {
      const m = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/.exec(n);
      const bin = path.join(extDir, n, 'resources', 'native-binary', exe);
      if (m && fs.existsSync(bin)) found.push({ v: m[1].split('.').map(Number), bin });
    }
  }
  found.sort((a, b) => { // 逐段比较版本号，大的在前
    for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) if ((a.v[i] || 0) !== (b.v[i] || 0)) return (b.v[i] || 0) - (a.v[i] || 0);
    return 0;
  });
  if (found.length) return found[0].bin;
  // 3. PATH 上的 claude：必须 --version 真能跑通才算（npm 的坏 shim 会失败）
  try { if (spawnSync('claude', ['--version'], { timeout: 15000 }).status === 0) return 'claude'; } catch {}
  return null;
}
const CLAUDE = findClaude();
// codex：同样启动时只找一次（只检查文件在不在，不启动它，所以不拖慢启动）。规则见 server/cli-codex.mjs 的 findCodex
const CODEX = findCodex();

// ───────── 小工具 ─────────
const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error(`请求体过大（上限 ${max >> 20 || '<1'}MB）`), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ───────── /api/generate ─────────
const NO_ENDPOINT = '找不到这个接口（可能已被删除）：请到右侧「接口」页检查，再在顶栏（聊天）或「记忆」页重新选择模型。';

async function handleGenerate(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : '请求体不是合法 JSON' }); }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
  // 用哪个接口：请求里的 endpoint（省略 = 内置的 claude-code）。每次请求现查配置，所以删 / 改接口立刻生效，服务端不记「当前用哪个」
  if (body.endpoint != null && typeof body.endpoint !== 'string') return sendJson(res, 400, { error: 'endpoint 必须是字符串（接口 id）' });
  const endpointId = body.endpoint ?? CLAUDE_ID;
  const claude = endpointId === CLAUDE_ID;
  const codex = endpointId === CODEX_ID;
  const ep = claude || codex ? null : loadConfig().endpoints.find((e) => e.id === endpointId);
  if (!claude && !codex && !ep) return sendJson(res, 400, { error: NO_ENDPOINT }); // 不回显客户端给的 id
  if (claude && !CLAUDE) return sendJson(res, 503, { error: '找不到 claude 可执行文件。请安装 VS Code 的 Claude Code 扩展，或设置环境变量 SMALLTALK_CLAUDE 指向 claude.exe 的完整路径。' });
  if (codex && !CODEX) return sendJson(res, 503, { error: '找不到 codex 可执行文件。请安装 OpenAI 的 Codex CLI，并在终端运行 codex login 登录 ChatGPT 账号；或设置环境变量 SMALLTALK_CODEX 指向 codex.exe 的完整路径（改完要重启服务）。' });
  // 两种请求：{messages} 是聊天（命令行类接口下会被压平成角色扮演转录）；{system?, prompt} 是直通（外置记忆的压缩用它，
  // 因为「请做摘要」和转录模式那句「请续写下一条回复」是互相打架的）。claude-code 的 system 走命令行参数，所以限制长度；
  // codex 的 system 写进文件、openai 放在消息里，都不受此限。
  const raw = typeof body.prompt === 'string' && body.prompt.length > 0;
  const ok = raw
    ? (body.system == null || (typeof body.system === 'string' && (!claude || body.system.length <= 4000)))
    : (Array.isArray(body.messages) && body.messages.length > 0 &&
      body.messages.every((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string'));
  if (!ok) return sendJson(res, 400, { error: 'messages 必须是非空数组，每项形如 {role: system|user|assistant, content: string, name?}；或者给 {system?, prompt}（claude-code 下 system 不超过 4000 字）' });
  if (body.model != null && typeof body.model !== 'string') return sendJson(res, 400, { error: 'model 必须是字符串' });
  if (codex && body.model && !isSafeModelName(body.model)) return sendJson(res, 400, { error: '模型名只能包含字母、数字和 . _ : / -，且以字母或数字开头（不超过 200 个字符）' });
  if (claude) return runClaude(res, body, raw);
  if (codex) return runCodex(res, body, raw);
  return handleOpenAI(res, ep, body, raw);
}

/**
 * 命令行类接口共用：把请求压平成 {system, prompt}。聊天走 serializeMessages（角色扮演转录 + 固定的短系统指令）；
 * 直通原样用调用方给的 system / prompt。两个命令行（claude、codex）用同一份，所以喂给它们的文字一模一样。
 */
const flatten = (body, raw) => (raw
  ? { system: body.system || 'Follow the instructions in the user message.', prompt: body.prompt }
  : serializeMessages(body.messages));

// ───────── provider: openai（OpenAI 兼容的 /chat/completions）─────────
// 用量旁路：流式回复是纯文本流，没法夹带用量。页面随请求给一个一次性的 usageId，这里在流结束（res.end）之前把上游报的用量
// 存进内存，页面读完流后 GET /api/usage?id=… 取走（取一次就删）。只存统一格式的几个数字，不含任何文本，更不含 key。
// 容量和时效都有上限，没人取的会被挤掉 / 过期；服务重启就没了。
const USAGE_MAX = 64, USAGE_TTL_MS = 5 * 60 * 1000;
const usageStore = new Map();   // id → {usage, at}
const USAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
function putUsage(id, usage) {
  if (!id || !usage) return;
  const now = Date.now();
  for (const [k, v] of usageStore) if (now - v.at > USAGE_TTL_MS) usageStore.delete(k);
  while (usageStore.size >= USAGE_MAX) usageStore.delete(usageStore.keys().next().value);
  usageStore.set(id, { usage, at: now });
}
function handleUsage(req, res, url) {
  const id = url.searchParams.get('id') || '';
  const hit = USAGE_ID.test(id) ? usageStore.get(id) : null;
  if (hit) usageStore.delete(id);
  return sendJson(res, hit ? 200 : 404, hit ? hit.usage : { error: '没有这条用量' });
}

// 不认识 stream_options 的接口（按 baseUrl）：服务进程内存里记一下，之后不再带这个字段（不写盘，重启服务就忘）
const noStreamOptions = new Set();

// 把上游的错误整理成一行字（先抹掉 key）
const upstreamFailText = (e, key) => {
  const c = e && e.cause;
  return scrub([c && c.code, (c && c.message) || (e && e.message) || String(e)].filter(Boolean).join(' '), key);
};

async function handleOpenAI(res, ep, body, raw) {
  const { baseUrl, apiKey } = ep;
  const missing = [];
  if (!baseUrl) missing.push('接口地址（Base URL）');
  if (!apiKey) missing.push('API Key');
  if (missing.length) return sendJson(res, 400, { error: `接口「${scrub(ep.name, apiKey)}」还没配置好：缺${missing.join('、')}。请到「接口」页补全。` });
  // 模型名不再有服务端默认值：由使用方（顶栏 / 记忆页）在每次请求里指明
  const model = body.model;
  if (!model) return sendJson(res, 400, { error: '没有选择模型：请在顶栏（聊天）或「记忆」页给这个接口选一个模型名。' });

  // 聊天请求经 OpenRouter 调 anthropic/ 模型时，发送前最后一步加 1 小时缓存标记（规则见 src/openai-shared.js applyPromptCache）。
  // 页面在「拼装」页关掉开关时带 promptCache: false；没带 = 开。直通请求（记忆压缩，raw）不加。不满足条件时 messages 原样不变
  const messages = raw
    ? [...(body.system ? [{ role: 'system', content: body.system }] : []), { role: 'user', content: body.prompt }]
    : applyPromptCache(toUpstreamMessages(body.messages), { baseUrl, model, enabled: body.promptCache !== false });
  // 带 stream_options 才能让上游在流末尾报用量；这个接口拒绝过就不带
  const payloadOf = (withUsage) => JSON.stringify({ model, messages, stream: true, ...(withUsage ? { stream_options: STREAM_OPTIONS } : {}), ...pickParams(body.params) });
  const usageId = typeof body.usageId === 'string' && USAGE_ID.test(body.usageId) ? body.usageId : null;

  // 客户端断开 → 中止上游请求（正常结束后再 abort 无副作用）
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // 只给「连接 + 等到响应头」设超时；生成本身不限时
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, FIRST_BYTE_TIMEOUT_MS);
  let timer2 = null;   // 重试那一次的首字节超时
  const fail = (code, msg) => { if (!res.headersSent && !res.destroyed) sendJson(res, code, { error: msg }); else res.end(); };

  const sendUpstream = (withUsage) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${apiKey}` },
    body: payloadOf(withUsage), signal: ac.signal,
    redirect: 'manual', // 不跟随重定向：免得带着 key 被转去别处
  });
  let up;
  let errText = null;   // 被拒绝时已经读出来的错误正文（读过就不能再读第二遍）
  try {
    const withUsage = !noStreamOptions.has(baseUrl);
    up = await sendUpstream(withUsage);
    // 只有「被拒绝」（还没有任何正文，也还没给页面写过一个字节）时才重试，所以不会生成两次、不会重复发内容。
    // 重试的地址、头、key 和第一次完全一样，只是请求体里少了 stream_options；最多这一次。
    if (withUsage && !up.ok && !(up.status >= 300 && up.status < 400)) {
      try { errText = (await up.text()).slice(0, 65536); } catch { errText = ''; }
      if (isStreamOptionsRejection(up.status, errText)) {
        noStreamOptions.add(baseUrl);
        clearTimeout(timer);
        timedOut = false;
        timer2 = setTimeout(() => { timedOut = true; ac.abort(); }, FIRST_BYTE_TIMEOUT_MS);
        errText = null;
        up = await sendUpstream(false);
      }
    }
  } catch (e) {
    clearTimeout(timer2);
    clearTimeout(timer);
    if (res.destroyed) return;
    return fail(502, timedOut ? `连接上游超时（${FIRST_BYTE_TIMEOUT_MS / 1000} 秒内没有响应），请检查接口地址和网络。` : `无法连接上游接口：${upstreamFailText(e, apiKey)}`);
  }
  clearTimeout(timer); clearTimeout(timer2);

  if (!up.ok) {
    let text = errText ?? '';
    if (errText === null) { try { text = (await up.text()).slice(0, 65536); } catch {} }
    if (up.status >= 300 && up.status < 400) return fail(502, `上游返回了重定向（HTTP ${up.status}），请检查接口地址是否正确（协议 http/https、结尾的 /v1）。`);
    const msg = extractErrorMessage(text, apiKey) || up.statusText;
    return fail(502, `上游返回 HTTP ${up.status}${msg ? '：' + msg : ''}`);
  }

  let started = false, stop = false, streamErr = null, usage = null;
  const emit = (t) => {
    if (!t) return;
    if (!started) { started = true; res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); }
    res.write(t);
  };
  const onEvent = (data) => {
    if (stop) return;
    const d = data.trim();
    if (d === '[DONE]') { stop = true; return; }
    let o; try { o = JSON.parse(d); } catch { return; } // 单个坏事件跳过
    if (o && o.error) { streamErr = eventErrorText(o.error, apiKey); stop = true; return; }
    const u = normalizeUsage(o && o.usage); if (u) usage = u;   // 最后一块（choices 为空）带 usage；每块都带累计值的上游，后来的覆盖前面的
    emit(contentOf(o));
  };

  // 判别：首个非空白字符是 { → 上游无视了 stream:true，返回的是一整块 JSON；否则当 SSE 流
  const reader = up.body.getReader();
  const dec = new TextDecoder('utf-8'); // stream 模式：被拆开的多字节字符会等下一块
  const sse = createSseParser(onEvent);
  let mode = null, whole = '', pending = '';
  const feed = (text) => {
    if (!text) return;
    if (!mode) {
      pending += text;
      const first = pending.trimStart()[0];
      if (!first) return;
      mode = first === '{' ? 'json' : 'sse';
      text = pending; pending = '';
    }
    if (mode === 'json') whole += text; else sse.push(text);
  };
  let readErr = null;
  try {
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
    }
    if (!stop) feed(dec.decode());
  } catch (e) { readErr = e; }
  if (stop) reader.cancel().catch(() => {});
  if (res.destroyed) return;

  if (mode === 'sse' && !stop && !readErr) sse.end();
  if (mode === 'json' && !readErr) {
    let o = null; try { o = JSON.parse(whole); } catch {}
    if (!o) streamErr = '上游返回的内容不是合法 JSON';
    else if (o.error) streamErr = eventErrorText(o.error, apiKey);
    else { usage = normalizeUsage(o.usage) ?? usage; emit(contentOf(o)); }
  }
  if (started) { putUsage(usageId, usage); return res.end(); }   // 先存用量再结束响应：页面读完流立刻来取，不能取空 // 已经开始流式：出任何问题都只是结束
  if (readErr) return fail(502, `读取上游响应失败：${upstreamFailText(readErr, apiKey)}`);
  if (streamErr) return fail(502, `上游报错：${streamErr}`);
  return fail(502, '上游没有返回任何正文（可能只返回了推理内容，或被内容审核拦截）');
}

// ───────── provider: claude-code ─────────
// 启动、喂 stdin、按行读、断开就 kill、删临时目录都在 server/cli-common.mjs 的 runCli 里（和 codex 共用）；这里只有参数和事件解析。
function runClaude(res, body, raw) {
  const { system, prompt } = flatten(body, raw);
  const args = [
    '-p',
    '--system-prompt', system,           // 替换（不是追加）默认系统提示
    '--tools', '',                       // 禁用全部内置工具
    '--setting-sources', '',             // 不加载 user/project/local 设置（hooks、CLAUDE.md 等）
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', // 不加载任何 MCP
    '--disable-slash-commands',          // 不加载 skills / 命令
    '--no-session-persistence',          // 不在磁盘留会话
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose', // stream-json 在 -p 下必须带 --verbose
  ];
  if (body.model) args.push('--model', body.model);

  let resultText = '', resultErr = null;
  runCli(res, {
    file: CLAUDE, args, stdin: prompt, // 提示词走 stdin：几百 KB 也不会撞命令行长度上限
    // 一行 NDJSON：只转发 text_delta（thinking_delta 等一律忽略）；result 行留作兜底
    onLine(line, emit) {
      if (!line.trim()) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') emit(o.event.delta.text);
      else if (o.type === 'result') { resultText = typeof o.result === 'string' ? o.result : ''; if (o.is_error) resultErr = resultText || 'claude 返回错误'; }
    },
    finish({ code, errTail, started, emit }) {
      if (!started && !resultErr && resultText) { emit(resultText); return null; } // 兜底：没有增量但有最终结果
      if (started) return null;
      return resultErr || (code !== 0 ? errTail.trim() : '') || (code !== 0 ? `claude 退出码 ${code}` : 'claude 没有返回任何内容');
    },
  });
}

// ───────── provider: codex（OpenAI 的 Codex CLI，走 ChatGPT 订阅）─────────
// 参数、找可执行文件、事件解析、报错翻译都在 server/cli-codex.mjs；启动和流式回传和 Claude 共用 runCli。
// 系统提示（+ 固定的「禁止调用工具」指示）写进临时目录里的一个文件，用 model_instructions_file 交给它：
// 系统提示可能很长，不能放命令行参数；而这个文件实测会整段替换 Codex 内置的编程助手指令。
// 工作目录是临时目录下一个空的子目录（work/），指令文件在它外面；结束后整个临时目录删掉。
function runCodex(res, body, raw) {
  const { system, prompt } = flatten(body, raw);
  const reader = createCodexReader({
    // 工具调用类的条目：内容不转发，只记类型（不记内容：里面可能有命令行、文件路径）
    onToolItem: (type) => console.log(`smalltalk: codex 的事件里出现了工具调用类条目（类型 ${type}），没有转发`),
  });
  runCli(res, {
    file: CODEX, tmpPrefix: 'smalltalk-codex-',
    env: codexEnv(),   // 去掉 OPENAI_API_KEY 等：否则它可能改走按量付费的 API，而不是订阅
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'instructions.md'), codexInstructions(system), 'utf8'),
    args: (dir) => codexArgs({ instructionsFile: path.join(dir, 'instructions.md'), model: body.model || '' }),
    stdin: prompt,
    onLine: (line, emit) => reader.line(line, emit),
    // 首个事件超时：和 OpenAI 那条路的首字节超时是同一个设置（SMALLTALK_UPSTREAM_TIMEOUT_MS，默认 60 秒）。
    // 实测 codex 正常时 1～3 秒内就打出第一行 thread.started；没登录时也会先打出它、再重连约 17 秒后 turn.failed，不会被这个超时误伤。
    firstEventTimeoutMs: FIRST_BYTE_TIMEOUT_MS,
    finish: (r) => codexFinish(reader, r, FIRST_BYTE_TIMEOUT_MS),
  });
}

// ───────── /api/endpoints（接口列表的增删改查 + 每个接口的模型列表）─────────
// 浏览器永远只拿到 PublicEndpoint（hasKey，没有 key）。接口 id 由服务端生成；路径里的 id 只做「是否等于某个已知 id」的比较，
// 不解码、不拼路径、不进文件系统，所以没有路径花样可玩；不认识的 id → 404，也不回显它。
const JSON_CT = /^application\/json\s*(;|$)/i;
const guardJson = (req, res) => {
  // POST / PUT 必须是 application/json：这种类型的跨站请求会触发 CORS 预检，浏览器不会替恶意网页直接发出
  if (JSON_CT.test(req.headers['content-type'] || '')) return true;
  sendJson(res, 415, { error: 'Content-Type 必须是 application/json' });
  return false;
};
async function readJsonBody(req, res, max) {
  try { return { body: JSON.parse(await readBody(req, max)) }; }
  catch (e) { sendJson(res, e.status || 400, { error: e.status ? e.message : '请求体不是合法 JSON' }); return null; }
}
const saveOr500 = (res, cfg) => {
  try { saveConfig(cfg); return true; } catch (e) { sendJson(res, 500, { error: `保存配置失败：${e.code || '写入出错'}` }); return false; }
};

async function handleEndpoints(req, res, url) {
  const m = /^\/api\/endpoints(?:\/([^/]*)(\/models)?)?$/.exec(url.pathname);
  if (!m) return sendJson(res, 404, { error: 'Not Found' });
  const [, id, models] = m;

  if (id === undefined) { // 集合：GET 列表 / POST 新建
    if (req.method === 'GET') return sendJson(res, 200, { endpoints: publicEndpoints(loadConfig(), CLAUDE, CODEX) });
    if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 GET 或 POST' });
    if (!guardJson(req, res)) return;
    const j = await readJsonBody(req, res, 64 * 1024); if (!j) return;
    const cfg = loadConfig();
    if (cfg.endpoints.length >= MAX_ENDPOINTS) return sendJson(res, 400, { error: `接口最多 ${MAX_ENDPOINTS} 个，请先删掉不用的` });
    let ep; try { ep = newEndpoint(j.body); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    cfg.endpoints.push(ep);
    if (!saveOr500(res, cfg)) return;
    return sendJson(res, 201, publicEndpoint(ep));
  }

  // 单个接口：先确认方法，再确认 id
  const allowed = models ? ['POST'] : ['PUT', 'DELETE'];
  if (!allowed.includes(req.method)) return sendJson(res, 405, { error: `请使用 ${allowed.join(' 或 ')}` });
  // 内置接口（claude-code、codex）：字面比较 id，不解码
  if (isBuiltinId(id)) return sendJson(res, 400, { error: `${BUILTIN_NAMES[id]} 是内置接口，不能修改、删除或获取模型列表` });
  const known = (cfg) => cfg.endpoints.findIndex((e) => e.id === id);
  let cfg = loadConfig(); let i = known(cfg);
  if (i < 0) return sendJson(res, 404, { error: '没有这个接口（可能已被删除）' });

  if (req.method === 'DELETE') {
    // DELETE 没有请求体，所以没有 Content-Type 可查。它的防护是两层：① DELETE 不是 CORS「简单」方法，
    // 跨站页面发它必须先过预检，而我们从不回 Access-Control-* 头，预检必败；② 即便如此，路由开头的 Host / Origin 校验
    // 对所有方法一视同仁（浏览器对跨站的 DELETE 一定带 Origin，外站和 Origin: null 都 403）。不另加自定义头：加了也不会比预检更强。
    cfg.endpoints.splice(i, 1);
    if (!saveOr500(res, cfg)) return;
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }
  if (!guardJson(req, res)) return;

  if (!models) { // PUT：改名字 / 地址 / key / 手动维护的模型列表
    const j = await readJsonBody(req, res, 1024 * 1024); if (!j) return;
    cfg = loadConfig(); i = known(cfg); // 读 body 期间可能被删了：重新查（之后到落盘之间没有 await，不会交错）
    if (i < 0) return sendJson(res, 404, { error: '没有这个接口（可能已被删除）' });
    let next; try { next = patchEndpoint(cfg.endpoints[i], j.body); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    cfg.endpoints[i] = next;
    if (!saveOr500(res, cfg)) return;
    return sendJson(res, 200, publicEndpoint(next));
  }

  // POST …/models：向该接口的 /models 查询。成功才写缓存；失败（非 2xx + {error}）不碰缓存
  if (!await readJsonBody(req, res, 4 * 1024)) return;
  const { baseUrl, apiKey } = cfg.endpoints[i];
  const bad = (code, error) => sendJson(res, code, { error: scrub(error, apiKey) });
  if (!baseUrl) return bad(400, '还没有设置接口地址（Base URL）。');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, MODELS_TIMEOUT_MS);
  try {
    const up = await fetch(`${baseUrl}/models`, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: ac.signal, redirect: 'manual', // 不跟随重定向：免得带着 key 被转去别处
    });
    const text = (await up.text()).slice(0, 4 * 1024 * 1024);
    if (!up.ok) return bad(502, up.status >= 300 && up.status < 400 ? `上游返回了重定向（HTTP ${up.status}），请检查接口地址。` : `上游返回 HTTP ${up.status}：${extractErrorMessage(text, apiKey) || up.statusText}`);
    let j; try { j = JSON.parse(text); } catch { return bad(502, '上游返回的不是合法 JSON'); }
    const list = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : null;
    if (!list) return bad(502, '上游返回的格式不认识（期望 {data:[{id}]} 或数组）');
    const ids = cleanModels(list.map((x) => (typeof x === 'string' ? x : x && typeof x.id === 'string' ? x.id : '')).map((s) => scrub(s, apiKey)));
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // 查询期间配置可能变了：重新读，只有「接口还在、地址和 key 都没变」才写缓存，否则把旧结果写进别人的配置就错了
    cfg = loadConfig(); i = known(cfg);
    if (i < 0) return sendJson(res, 404, { error: '没有这个接口（查询期间被删除了）' });
    const cur = cfg.endpoints[i];
    if (cur.baseUrl !== baseUrl || cur.apiKey !== apiKey) return sendJson(res, 409, { error: '查询期间接口的地址或 key 被修改了，请重新获取' });
    cur.models = ids.slice(0, MAX_MODELS); cur.modelsFetchedAt = new Date().toISOString();
    if (!saveOr500(res, cfg)) return;
    return sendJson(res, 200, publicEndpoint(cur));
  } catch (e) {
    if (res.destroyed) return;
    bad(502, timedOut ? `查询模型列表超时（${MODELS_TIMEOUT_MS / 1000} 秒）` : `无法连接上游接口：${upstreamFailText(e, apiKey)}`);
  } finally { clearTimeout(timer); }
}

// ───────── 静态文件 ─────────
// URL 路径 → 磁盘上的文件路径。serveStatic 和下面的「字体例外」共用这一个函数，
// 保证例外判断的就是 serveStatic 真正要读的那个文件（不会出现"检查的是 A、读的是 B"）。
// 返回 { file } 或 { code, error }。
function staticFilePath(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return { code: 400, error: 'bad path' }; }
  if (rel.includes('\0')) return { code: 400, error: 'bad path' };
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + path.sep + rel);
  // 路径穿越防护：解析后必须仍在根目录内
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return { code: 403, error: 'Forbidden' };
  return { file };
}

// cors=true 只由下面的字体例外传入：仅这时 200 响应才带 Access-Control-Allow-Origin。其它任何响应都不带 Access-Control-* 头。
function serveStatic(req, res, url, cors = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method Not Allowed' });
  const r = staticFilePath(url.pathname);
  if (!r.file) return sendJson(res, r.code, { error: r.error });
  const { file } = r;
  // 兜底：万一有人把配置目录设在项目目录里，也不能让静态服务把 config.json（含 key）托管出去
  const cdir = path.resolve(configDir()).toLowerCase();
  if (file.toLowerCase() === cdir || file.toLowerCase().startsWith(cdir + path.sep)) return sendJson(res, 404, { error: 'Not Found' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not Found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size, 'cache-control': 'no-store',
      ...(cors ? { 'access-control-allow-origin': '*' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ───────── 唯一的跨源例外：前端卡 iframe 加载 vendor/ 里的字体 ─────────
// 为什么需要：前端卡跑在 srcdoc + 没有 allow-same-origin 的 sandbox iframe 里，它的 origin 是 "null"。
// <script> / <link> 不是 CORS 请求、不带 Origin，能正常加载；但 @font-face 的字体按规范必须走 CORS，
// 浏览器会带上 `Origin: null`，被下面路由开头的 Origin 校验 403，Font Awesome 图标就成了方块。
// 光放行还不够，响应里还得有 Access-Control-Allow-Origin，浏览器才肯把字体交给页面。
//
// 为什么这么窄：Origin: null 不只来自我们自己的 iframe——任何网站都能造一个 sandbox iframe 或 data: 页面发出 Origin: null。
// 所以对 null 放行的东西必须是"谁拿到都无所谓"的。这里只放：GET/HEAD + 本机 Host + vendor/ 下真实存在的 .woff2/.woff/.ttf 文件。
// 这些是公开发布的开源字体（Font Awesome Free，SIL OFL），别的网站能读到也没有损失。
// /api/*、POST、其它静态文件（页面源码、server.mjs、jquery 等）、Host 校验，全都不受影响。
//
// 为什么判断写得这么啰嗦：URL 字符串和磁盘上的文件不是一回事（%2f 编码、反斜杠、大小写、Windows 会吞掉结尾的点和空格、
// 备用数据流 x.ttf::$DATA、符号链接 / 目录联接……）。所以分两步，两步都过才算：
//   ① 对原始路径做白名单字符检查：只许 /vendor/ 开头、每段只含字母数字 _ - 和段内单个点、扩展名小写。
//      这一步就把 % 编码（含双重编码）、反斜杠、冒号、空格、结尾的点、".." 段统统挡在外面。
//   ② 用 serveStatic 同一个函数算出要读的文件，再取它的真实路径（解开符号链接 / 联接），
//      真实路径必须在 vendor/ 的真实路径之内、真实扩展名也是字体、而且是普通文件。
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf']);
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/; // 不能以点开头或结尾，不能有连续的点（所以也不可能是 . 或 ..）
let VENDOR_REAL = null; // vendor/ 的真实路径；取不到（目录不存在等）就让例外永远不生效
try { VENDOR_REAL = fs.realpathSync.native(path.join(ROOT, 'vendor')); } catch {}

function isVendorFont(pathname) {
  // ① 原始路径的白名单检查
  if (!VENDOR_REAL || pathname.length > 256) return false;
  const segs = pathname.split('/'); // '/vendor/a/b.woff2' → ['', 'vendor', 'a', 'b.woff2']
  if (segs.length < 3 || segs[0] !== '' || segs[1] !== 'vendor') return false;
  if (!segs.slice(2).every((s) => SAFE_SEGMENT.test(s))) return false;
  if (!FONT_EXTS.has(path.extname(segs[segs.length - 1]))) return false; // 区分大小写：.TTF 不算
  // ② 落到磁盘上再查一遍
  const r = staticFilePath(pathname);
  if (!r.file) return false;
  try {
    const real = fs.realpathSync.native(r.file); // 解开符号链接；文件不存在会抛错 → 不放行
    if (!real.startsWith(VENDOR_REAL + path.sep)) return false;
    if (!FONT_EXTS.has(path.extname(real))) return false; // 防"名叫 x.ttf、其实指向 jquery.min.js"的链接
    return fs.statSync(real).isFile();
  } catch { return false; }
}

// ───────── 路由 ─────────
const server = http.createServer((req, res) => {
  // 请求行里的地址可能根本不是合法 URL（比如 `GET http://[ HTTP/1.1`）。不接住的话 new URL 抛出的异常没人管，
  // 整个服务进程会直接退出——本机任何程序发一个包就能把服务打挂。浏览器发不出这种请求，所以直接回 400。
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad request' }); }
  // 只接受本页面自己发来的请求。仅监听 127.0.0.1 还不够：你浏览器里打开的任何网站都能向本机端口发跨站 POST
  // （白用你的 Claude 额度），或用 DNS 重绑定冒充同源。所以 Host 必须是本机，带 Origin 的请求 Origin 也必须是本机。
  const local = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const origin = req.headers.origin;
  const hostOk = local.has(req.headers.host);
  // 唯一的例外（见上面 isVendorFont 的注释）。Host 校验照旧：hostOk 是前提。
  // 注意 Origin 要恰好等于 'null'：同一个头出现多次时 Node 会用 ", " 拼起来，那样就不相等，不会放行。
  const fontCors = hostOk && origin === 'null' && (req.method === 'GET' || req.method === 'HEAD') && isVendorFont(url.pathname);
  if (fontCors) return serveStatic(req, res, url, true); // 直接交给静态服务，不经过下面任何 /api 分支
  if (!hostOk || (origin !== undefined && !local.has(origin.replace(/^https?:\/\//, '')))) {
    return sendJson(res, 403, { error: 'Forbidden: 只允许从本机页面访问' });
  }
  if (url.pathname === '/api/health') {
    // ok / claudePath / error 的含义不变（只说 claude）；codexPath 是新加的：codex 可执行文件的路径，没找到为 null
    return sendJson(res, 200, CLAUDE ? { ok: true, claudePath: CLAUDE, codexPath: CODEX } : { ok: false, claudePath: null, codexPath: CODEX, error: '找不到 claude，请设置 SMALLTALK_CLAUDE' });
  }
  if (url.pathname === '/api/endpoints' || url.pathname.startsWith('/api/endpoints/')) {
    return handleEndpoints(req, res, url).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) }); else res.end(); });
  }
  if (url.pathname === '/api/usage') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '请使用 GET' });
    return handleUsage(req, res, url);
  }
  if (url.pathname === '/api/generate') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST' });
    return handleGenerate(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) }); else res.end(); });
  }
  serveStatic(req, res, url);
});

// ───────── 启动：--open 与端口占用处理 ─────────
const OPEN_FLAG = process.argv.includes('--open');
const PAGE_URL = `http://127.0.0.1:${PORT}/`;

// 用系统默认浏览器打开页面。用 spawn + 参数数组而不是拼 shell 字符串；url 只由常量和 PORT 组成。
// 打不开不致命：服务照常运行，只提示用户手动打开。
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`smalltalk: 没能自动打开浏览器，请手动访问 ${url}`));
    child.unref();
  } catch {
    console.log(`smalltalk: 没能自动打开浏览器，请手动访问 ${url}`);
  }
}

// 端口被占用时，探一下占着的是不是另一个 SmallTalk（/api/health 返回 JSON 且有布尔 ok 和 claudePath 键）。
function probeSmallTalk() {
  return new Promise((resolve) => {
    const req = http.get(`${PAGE_URL}api/health`, { timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(!!j && typeof j.ok === 'boolean' && 'claudePath' in j);
        } catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`smalltalk: 启动失败：${err.message}`);
    process.exit(1);
  }
  if (await probeSmallTalk()) {
    console.log(`smalltalk: 已经在运行了（${PAGE_URL}），不用再开一份。`);
    if (OPEN_FLAG) openBrowser(PAGE_URL);
    process.exit(0);
  }
  // 故意不自动换端口：聊天数据存在浏览器的 IndexedDB 里，按"协议+主机+端口"隔离，
  // 换了端口，原来的存档就看不到了。
  console.error(`smalltalk: 端口 ${PORT} 被别的程序占用了。`);
  console.error('存档是和端口绑定的（换端口会看不到原来的存档），所以不会自动换端口。');
  console.error('请关掉占用该端口的程序后重试。');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`smalltalk: ${PAGE_URL}  (claude: ${CLAUDE || '未找到'})`);
  if (OPEN_FLAG) openBrowser(PAGE_URL);
});
