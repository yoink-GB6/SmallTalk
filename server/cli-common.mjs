// 命令行类接口的共用部分（Claude Code、Codex 都走这里）：
//   在一个每次新建的空临时目录里启动命令行 → 把压平后的对话从 stdin 喂进去 → 按行解析它打到 stdout 的流式事件 →
//   正文一到就写给浏览器 → 客户端断开就 kill → 结束后删掉临时目录。
// 每个工具不同的只有三件事，由调用方（适配）给：启动参数、怎么解析一行事件、结束时怎么判断成败 / 报什么错。
// 规格见 src/types.js「命令行类内置接口」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 启动一个可执行文件。不用 shell:true（路径有空格、避免注入）。
 * 测试用的小把戏：路径是 .js/.mjs 时用当前 node 去跑它，这样不经 shell 也能有「假 claude / 假 codex」。
 */
export const launch = (file, args, opts) =>
  /\.m?js$/i.test(file) ? spawn(process.execPath, [file, ...args], opts) : spawn(file, args, opts);

const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

/**
 * 跑一次命令行，把结果流式写进 res（200 + text/plain），或者在还没写出正文时回非 2xx + {error}（和 OpenAI 那条路的约定一致）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   file: string,                     可执行文件
 *   args: string[] | ((dir: string) => string[]),   参数；给函数时会拿到本次的临时目录（Codex 要把指令文件写在里面）
 *   prepare?: (dir: string) => void,  启动前在临时目录里做点事（写文件）。抛错 = 500
 *   env?: NodeJS.ProcessEnv,          子进程的环境变量（省略 = 继承）
 *   stdin: string,                    写进 stdin 的全部内容（几百 KB 也不会撞命令行长度上限）
 *   onLine: (line: string, emit: (text: string) => void) => void,   每收到完整一行 stdout 调一次
 *   finish: (r: {code: number|null, errTail: string, started: boolean, emit: (text: string) => void, timedOut: boolean}) => string|null,
 *           进程结束后调一次：可以再 emit 兜底正文；返回 null = 成功，否则是给用户看的错误（只在还没写出正文时用得上）
 *   firstEventTimeoutMs?: number,     多久没收到 stdout 的第一行就 kill 并报超时（省略 / 0 = 不限时，Claude 那条路就是不限时）
 *   timeoutText?: string,             超时时给 finish 的提示（finish 自己决定怎么用）
 *   tmpPrefix?: string,
 * }} o
 */
export function runCli(res, o) {
  // 临时目录：dir 里放命令行需要的文件，dir/work 是空的工作目录，避免它读到任何项目 / 用户上下文
  let dir, cwd;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), o.tmpPrefix || 'smalltalk-'));
    cwd = o.prepare ? path.join(dir, 'work') : dir; // 没有要准备的文件时保持原样：临时目录本身就是空的工作目录
    if (o.prepare) { fs.mkdirSync(cwd); o.prepare(dir); }
  } catch (e) {
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
    return sendJson(res, 500, { error: `准备临时目录失败：${e.code || e.message}` });
  }
  const args = typeof o.args === 'function' ? o.args(dir) : o.args;

  const child = launch(o.file, args, { cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let started = false, finished = false, gotLine = false, timedOut = false, buf = '', errTail = '';
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  const emit = (text) => {
    if (!text || res.destroyed) return;
    if (!started) { started = true; res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); }
    res.write(text);
  };
  // 客户端断开 → 杀子进程（正常结束后 finished=true，不再杀）
  res.on('close', () => { if (!finished) child.kill(); });

  // 首个事件超时：只管「启动后迟迟没有任何输出」（进程卡死、卡在某个交互提示上）；之后生成本身不限时
  const timer = o.firstEventTimeoutMs > 0
    ? setTimeout(() => { if (!gotLine && !finished) { timedOut = true; child.kill(); } }, o.firstEventTimeoutMs)
    : null;
  const line = (l) => { gotLine = true; if (timer) clearTimeout(timer); o.onLine(l, emit); };

  child.stdout.setEncoding('utf8'); // 内部用 StringDecoder，跨 chunk 的中文不会乱码
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  child.stdin.on('error', () => {}); // 子进程提前退出时写 stdin 会 EPIPE，忽略
  child.stdin.end(o.stdin);

  child.on('error', (e) => { errTail = String(e.message); });
  child.on('close', (code) => {
    finished = true; if (timer) clearTimeout(timer); cleanup();
    if (buf) { o.onLine(buf, emit); buf = ''; }
    const err = o.finish({ code, errTail, started, emit, timedOut });
    if (started) return res.end();   // 已开始流式：出任何问题都只是结束
    if (res.destroyed) return;
    sendJson(res, 502, { error: err || '命令行没有返回任何内容' });
  });
}
