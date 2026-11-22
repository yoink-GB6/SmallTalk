// Codex 适配：把 OpenAI 的 Codex CLI（`codex exec`，走 ChatGPT 订阅）当成一个「只出文字」的模型后端。
// 启动 / 喂 stdin / 按行读 / 断开就 kill 这些共用的事在 cli-common.mjs；这里只管 Codex 自己的三件事：
//   ① 找可执行文件  ② 拼参数（尽量把它的工具全关掉）  ③ 解析 `--json` 打出来的事件、整理报错。
// 下面每一条都是 2026-11-22 在 codex-cli 0.171.0（Windows，原生安装器）上实测过的，结论记在 src/types.js「命令行类内置接口」。
//
// 关键事实（实测）：
//   - `codex exec - --json`：提示从 stdin 读；stdout 每行一个 JSON 事件：thread.started → turn.started → item.* → turn.completed / turn.failed。
//   - 正文在 item.completed 且 item.type === 'agent_message' 的 text 里，【整段】到达，没有逐字增量（0.171.0 没有 item.updated 的正文）。
//   - 没登录：它会先重连 10 次（约 17 秒），最后 turn.failed，原因里有 "401 Unauthorized"。模型名不对：turn.failed "The 'x' model is not supported…"。
//   - item.type === 'error' 的条目是【非致命】警告（比如 "Code Mode is unavailable…"、"Model metadata … not found"），不能当失败。
//   - type === 'error' 的顶层事件也可能只是「Reconnecting... 2/5」这种重连提示，同样不能当失败；真正的失败看 turn.failed 和退出码。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ───────── ① 找可执行文件（只看文件在不在，不启动它：codex.exe 有 400MB，启动探测会拖慢服务启动）─────────

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** 版本号形如 26.1117.41037 的目录名，按数字逐段比较，大的在前 */
const byVersionDesc = (a, b) => {
  for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) if ((a.v[i] || 0) !== (b.v[i] || 0)) return (b.v[i] || 0) - (a.v[i] || 0);
  return 0;
};

/**
 * 找 codex 可执行文件，找不到返回 null。顺序：
 *   1. 环境变量 SMALLTALK_CODEX（显式指定但文件不存在 → 视为未找到，不再往下猜）。.js/.mjs 也行（测试里的「假 codex」）。
 *   2. 官方原生安装器的位置：%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe（实测是指向 ~/.codex/packages/standalone/… 的硬链接，
 *      就是真正的 exe，spawn 不经 shell 能直接起）；以及它背后的 ~/.codex/packages/standalone/current/bin/codex.exe。
 *   3. PATH 上的 codex(.exe)。Windows 上 npm 装的是 codex.cmd 包装脚本，不经 shell 的 spawn 起不来，
 *      所以遇到 codex.cmd 就去同目录的 node_modules/@openai/codex/vendor/<平台>/codex/codex.exe 找真正的 exe（这个目录结构没在本机实测过）。
 *   4. VS Code 的 ChatGPT 扩展自带的 codex（取版本最高的）。它的版本跟着扩展走，不一定认识我们用的参数，所以放最后；
 *      真不认识时 --strict-config 会让它直接报错退出（见 explainCodexError），不会带着没关掉的工具跑起来。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]  用户目录（测试可注入）
 */
export function findCodex(env = process.env, home = os.homedir()) {
  if (env.SMALLTALK_CODEX) return isFile(env.SMALLTALK_CODEX) ? env.SMALLTALK_CODEX : null;
  const win = process.platform === 'win32';
  const exe = win ? 'codex.exe' : 'codex';
  const cands = [];
  if (win) cands.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', exe));
  cands.push(path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', exe));
  if (!win) cands.push(path.join(home, '.local', 'bin', exe), '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  for (const c of cands) if (isFile(c)) return c;

  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (isFile(path.join(dir, exe))) return path.join(dir, exe);
    if (win && isFile(path.join(dir, 'codex.cmd'))) {
      const vendor = path.join(dir, 'node_modules', '@openai', 'codex', 'vendor');
      let plats = [];
      try { plats = fs.readdirSync(vendor); } catch {}
      for (const p of plats) { const bin = path.join(vendor, p, 'codex', exe); if (isFile(bin)) return bin; }
    }
  }

  const found = [];
  for (const d of ['.vscode', '.vscode-insiders']) {
    const extDir = path.join(home, d, 'extensions');
    let names = [];
    try { names = fs.readdirSync(extDir); } catch {}
    for (const n of names) {
      const m = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(n);
      if (!m) continue;
      let plats = [];
      try { plats = fs.readdirSync(path.join(extDir, n, 'bin')); } catch {}
      for (const p of plats) { const bin = path.join(extDir, n, 'bin', p, exe); if (isFile(bin)) found.push({ v: m[1].split('.').map(Number), bin }); }
    }
  }
  found.sort(byVersionDesc);
  return found.length ? found[0].bin : null;
}

// ───────── ② 参数 ─────────

/**
 * 关掉的 feature（`--disable <名字>` 等价于 `-c features.<名字>=false`）。名字来自 `codex features list`（0.171.0）。
 * 实测（用 `codex debug prompt-input` 看模型能看到的工具列表，不花额度）：
 *   - 现在的模型都是 code_mode_only：所有工具（exec_command、apply_patch、view_image、MCP 资源……）都要经过一个叫 exec 的
 *     「JS 编排」工具去调。关掉 code_mode_host 后它报 "Code Mode is unavailable … will fail closed"——exec 一调就失败，
 *     实测让它「运行 dir、读 secret.txt」，它试着调了一次、被拦下，最后回答「命令执行工具不可用」。这是真正挡住工具的那一条。
 *   - shell_tool / unified_exec 关掉后，嵌套工具里的 exec_command、write_stdin 消失；view_image、apps、plugins 等同理。
 *   - 关不掉的（0.171.0 没有对应开关）：collaboration 一组（spawn_agent 等，开子代理；子代理用的是同一套配置，同样没有可用的工具）、
 *     request_user_input（说明里写着只在 Plan 模式可用）、exec 本身的定义（还在列表里，但调用必失败）。
 * 每一项都经过 --strict-config 验证是它认识的名字（不认识的名字会让它直接报错退出，而不是悄悄忽略）。
 */
export const CODEX_FEATURES_OFF = [
  'code_mode_host',                  // ← 最关键：所有工具都经它调用，关掉后「fail closed」
  'shell_tool', 'unified_exec', 'shell_snapshot', // 执行命令
  'view_image', 'image_generation',  // 看图 / 生图
  'apps', 'plugins', 'remote_plugin', 'tool_suggest', 'skill_search', // 连接器、插件、技能
  'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', // 浏览器、操作电脑
  'multi_agent', 'multi_agent_v2',   // 子代理（collaboration 那组工具关不掉，见上）
  'goals', 'memories', 'hooks', 'sleep_tool',
  'daemon_auto_start',               // 不顺手拉起它的后台服务
];

/** TOML 的基本字符串：JSON 的转义（\" \\ \uXXXX）在 TOML 里也合法，所以直接用 JSON.stringify */
const tomlString = (s) => JSON.stringify(String(s));

/**
 * `codex exec` 的完整参数（最后的 '-' = 提示从 stdin 读）。每一项的作用：
 * @param {{instructionsFile: string, model?: string}} o
 */
export function codexArgs({ instructionsFile, model }) {
  return [
    'exec',
    '--json',                     // 事件以 JSONL 打到 stdout
    '--ephemeral',                // 不落会话文件（实测 ~/.codex/sessions 没有新文件）
    '--skip-git-repo-check',      // 临时目录不是 git 仓库
    '--ignore-user-config',       // 不读 ~/.codex/config.toml（用户的 MCP、模型、沙箱等设置）；登录仍用 CODEX_HOME 里的
    '--ignore-rules',             // 不读用户 / 项目的 .rules
    '--strict-config',            // 下面 -c / --disable 里有它不认识的名字 → 直接报错退出（不会带着没关掉的工具跑起来）
    '-s', 'read-only',            // 沙箱只读（挡写入和联网；工具本来就关了，这是第二道）
    '--color', 'never',
    ...CODEX_FEATURES_OFF.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',                  // 联网搜索
    '-c', 'include_permissions_instructions=false', // 不往提示里加「沙箱权限说明」
    '-c', 'include_environment_context=false',      // 不往提示里加工作目录、shell、时间这些环境信息
    '-c', 'include_apps_instructions=false',        // 不加连接器说明
    '-c', 'skills.include_instructions=false',      // 不加技能列表（~/.codex/skills 里的）
    '-c', 'project_doc_max_bytes=0',                // 不读工作目录里的 AGENTS.md（注意：挡不住全局的 ~/.codex/AGENTS.md，见 types.js）
    '-c', `model_instructions_file=${tomlString(instructionsFile)}`, // 用我们的文件【替换】它内置的那段编程助手指令
    ...(model ? [`--model=${model}`] : []),          // 用 --model=值 的写法：值不会被当成另一个参数
    '-',
  ];
}

/** 模型名只许这些字符（它会进命令行参数；不经 shell，但也不让它长得像一个参数） */
export const isSafeModelName = (m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(m);

/**
 * 子进程的环境变量：照常继承，但去掉会让它改走「按量付费的 API key」或改去别的服务器的那几个。
 * 不去掉的话，只要用户环境里有 OPENAI_API_KEY，它就可能不走 ChatGPT 订阅而是花 API 的钱。
 * （Windows 的环境变量名不分大小写，所以按不分大小写比较。）
 */
const DROP_ENV = /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_ORG_ID|OPENAI_ORGANIZATION|OPENAI_PROJECT_ID)$/i;
export function codexEnv(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!DROP_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * 固定追加在系统提示后面的一段「禁止调用工具」的指示。
 * ⚠ 这只是保险，真正的限制靠上面的参数（code_mode_host 关掉后工具调用必失败）。
 * 实测它确实有用：同样一句「运行 dir、读 secret.txt」，没有这段时模型会先试着调一次工具（被拦下）再回答；
 * 有这段时它直接用文字回答「无法运行」，连试都不试（少一轮请求，也省额度）。
 * 放在 model_instructions_file 里（和我们的系统提示同一个文件），实测这个文件会整段替换 Codex 内置的编程助手指令。
 */
export const CODEX_NO_TOOLS_NOTE = [
  '这是一个纯对话场景。不要调用任何工具，不要读取或写入任何文件，不要执行任何命令，不要联网搜索，也不要创建子代理。只用文字直接回复。',
  'This is a pure conversation. Do not call any tools, do not read or write files, do not run commands, do not search the web, and do not spawn agents. Reply with text only.',
].join('\n');

/** 写进 model_instructions_file 的全文：我们的系统提示 + 禁止调用工具的指示 */
export const codexInstructions = (system) => `${system}\n\n${CODEX_NO_TOOLS_NOTE}\n`;

// ───────── ③ 解析事件、整理报错 ─────────

/** 这些条目类型不是工具调用：正文、推理、非致命警告 */
const NOT_TOOL = new Set(['agent_message', 'reasoning', 'error']);

/**
 * 逐行读 `codex exec --json` 的输出。
 * 只把 agent_message 的正文交给 emit；推理（reasoning）不转发；工具调用类的条目（command_execution、file_change、mcp_tool_call、
 * web_search、collab_tool_call……任何不认识的类型都算）不转发内容，只调 onToolItem(类型) 让服务端记一行日志。
 * 正文现在是整段到达；万一以后的版本用 item.updated 一点点发，这里按「同一条目新文字以旧文字开头」只补发多出来的部分，也能对付。
 * @param {{onToolItem?: (type: string) => void}} [o]
 */
export function createCodexReader({ onToolItem } = {}) {
  const sent = new Map();   // 条目 id → 已经写出去的正文
  const tools = new Set();  // 已经记过日志的工具条目 id
  let failed = null, lastError = null, completed = false, anyText = false;
  return {
    /** @param {string} l 一行 stdout  @param {(t: string) => void} emit */
    line(l, emit) {
      if (!l.trim()) return;
      let o; try { o = JSON.parse(l); } catch { return; } // 不是 JSON 的行（理论上不会有）跳过
      if (!o || typeof o !== 'object') return;
      if (o.type === 'item.started' || o.type === 'item.updated' || o.type === 'item.completed') {
        const it = o.item && typeof o.item === 'object' ? o.item : {};
        const type = typeof it.type === 'string' ? it.type : '';
        const id = typeof it.id === 'string' ? it.id : JSON.stringify(it.id ?? null);
        if (type === 'agent_message') {
          if (typeof it.text !== 'string') return;
          const prev = sent.get(id) ?? '';
          if (!it.text.startsWith(prev)) return; // 前面的字被改写了：已经发出去的收不回来，不再补
          const more = it.text.slice(prev.length);
          if (!more) return;
          // 同一轮里有好几条消息时（一般不会），条与条之间空一行
          emit((anyText && !sent.has(id) ? '\n\n' : '') + more);
          anyText = true; sent.set(id, it.text);
        } else if (!NOT_TOOL.has(type) && !tools.has(id)) {
          tools.add(id);
          if (onToolItem) onToolItem(/^[A-Za-z0-9_.-]{1,40}$/.test(type) ? type : '(未知)');
        }
      } else if (o.type === 'turn.failed') {
        const m = o.error && typeof o.error === 'object' ? o.error.message : o.error;
        failed = typeof m === 'string' && m ? m : 'turn.failed';
      } else if (o.type === 'error') {
        if (typeof o.message === 'string') lastError = o.message; // 可能只是「Reconnecting... 2/5」，只当兜底
      } else if (o.type === 'turn.completed') completed = true;
    },
    get failed() { return failed; },
    get lastError() { return lastError; },
    get completed() { return completed; },
  };
}

const ERR_MAX = 500;
const capErr = (s) => { const t = String(s).replace(/\x1b\[[0-9;]*m/g, '').trim(); return t.length > ERR_MAX ? t.slice(0, ERR_MAX) + '…' : t; };

/**
 * Codex 的原始报错 → 一句看得懂的中文 + 原文。文字里都带「Codex」，聊天区的提示（chat.js showGenError）据此给建议。
 * 判断用的是实测 / 文档里见过的字样；对不上的就只给原文。
 */
export function explainCodexError(raw) {
  const r = capErr(raw);
  const say = (zh) => `${zh}（Codex 原文：${r}）`;
  if (/401|unauthori[sz]ed|not logged in|log ?in|missing bearer|authentication/i.test(r))
    return say('Codex 还没有登录，或者登录已过期：请在终端（命令提示符）运行 codex login 登录 ChatGPT 账号，然后重试');
  if (/context.?(length|window)|maximum context|too long/i.test(r))
    return say('发送的内容超过了这个模型能接受的长度：可以开「记忆」压缩聊天记录，或在「预设」页关掉一些条目');
  if (/usage limit|rate.?limit|quota|429|too many requests|exceeded/i.test(r))
    return say('Codex 的订阅额度用完了，或者请求太频繁：等一会儿再试，或换一个接口');
  if (/model .*not (supported|found|available)|unknown model|model_not_found|does not exist/i.test(r))
    return say('这个模型在你的 ChatGPT 订阅下用不了：请在模型选择器里换一个，或选「默认」');
  if (/unknown feature flag|unknown configuration field|error loading config/i.test(r))
    return say('Codex 不认识我们用来关闭工具的参数（可能是 Codex 升级 / 版本不同了）。为了安全没有继续运行；请把这段报错反馈给维护者');
  return say('Codex 运行出错');
}

/**
 * 进程结束后：成功返回 null，否则返回给用户看的错误。
 * @param {ReturnType<typeof createCodexReader>} reader
 * @param {{code: number|null, errTail: string, started: boolean, timedOut: boolean}} r
 * @param {number} timeoutMs
 */
export function codexFinish(reader, { code, errTail, started, timedOut }, timeoutMs) {
  if (started) return null;
  if (timedOut) return `Codex 启动后 ${Math.round(timeoutMs / 1000)} 秒内没有任何输出，已中止。可以在终端里运行 codex 看看是不是卡在某个提示上。`;
  if (reader.failed) return explainCodexError(reader.failed);
  if (code !== 0) {
    const tail = capErr(errTail);
    return explainCodexError(tail || reader.lastError || `codex 退出码 ${code}`);
  }
  return 'Codex 没有返回任何正文（可能被内容审核拦下，或者它试图调用工具被拦下了）。可以点「重新生成」再试一次。';
}
