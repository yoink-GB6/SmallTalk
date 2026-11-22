// 服务端配置 v2：接口列表。读取 / 原子写入 <配置目录>/config.json，并生成给浏览器看的「公开版」。
// 规格见 src/types.js「模型接口 v2：接口列表」。
// 配置目录：环境变量 SMALLTALK_CONFIG_DIR（测试用）优先，否则 ~/.smalltalk。
// 放在用户主目录而不是项目目录：静态文件服务只托管项目目录，所以无论如何读不到 API key。
//
// 字段校验、新建 / 修改的合并规则（含 key 与站点绑定）、公开版这些【纯规则】在 src/openai-shared.js，
// 网页版的「页面直连」后端（src/llm-direct.js）用的是同一份；这里只留和 Node / 磁盘有关的部分，并把那些规则原样转出去，
// 所以 server.mjs 和测试照旧从这里 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_ID, CLAUDE_MODELS, CODEX_ID, CODEX_MODELS, BUILTIN_NAMES, isBuiltinId, MAX_ENDPOINTS, MAX_MODELS, LIMITS, defaultConfig, isEndpointId, plain, normalizeBaseUrl, hostOf,
  cleanModels, sanitizeEndpoints, publicEndpoint, newEndpoint, patchEndpoint, newEndpointId,
} from '../src/openai-shared.js';

export { CLAUDE_ID, CLAUDE_MODELS, CODEX_ID, CODEX_MODELS, BUILTIN_NAMES, isBuiltinId, MAX_ENDPOINTS, MAX_MODELS, defaultConfig, isEndpointId, cleanModels, publicEndpoint, newEndpoint, patchEndpoint };

// 每次调用都重新算，这样测试里改环境变量能立刻生效
export const configDir = () => process.env.SMALLTALK_CONFIG_DIR || path.join(os.homedir(), '.smalltalk');
export const configFile = () => path.join(configDir(), 'config.json');

// 第一版的配置文件 {provider, openai:{baseUrl, apiKey, model}} 在内存里转成一个接口。
// 转换结果按文件内容缓存：否则每次读都会生成新的随机 id，浏览器拿到的 id 两次请求之间就对不上了。
// （下次有写入时才会落盘成 v2；在那之前磁盘上仍是原文件。）
let v1Cache = { raw: null, cfg: null };
function fromV1(j, raw) {
  if (v1Cache.raw === raw) return structuredClone(v1Cache.cfg);
  const cfg = defaultConfig();
  const o = j && typeof j.openai === 'object' && j.openai ? j.openai : {};
  const str = (k) => (typeof o[k] === 'string' ? o[k].slice(0, LIMITS[k]) : '');
  let baseUrl = ''; try { baseUrl = normalizeBaseUrl(str('baseUrl')); } catch {}
  const apiKey = str('apiKey').trim();
  if (baseUrl || apiKey) {
    const model = str('model').trim();
    cfg.endpoints.push({
      id: newEndpointId(), name: plain(hostOf(baseUrl)) || 'OpenAI 兼容接口', type: 'openai',
      baseUrl, apiKey, models: model ? [model] : [], modelsFetchedAt: null,
    });
  }
  v1Cache = { raw, cfg: structuredClone(cfg) };
  return cfg;
}

let warned = false; // 损坏的配置文件只警告一次（否则每个请求都刷屏）

/** 读配置。文件不存在 / 损坏 / 字段类型不对 → 回落到默认值，绝不抛错；损坏的文件原样留在磁盘上。 */
export function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(configFile(), 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT' && !warned) { warned = true; console.warn('smalltalk: 无法读取配置文件，使用默认配置'); }
    return defaultConfig();
  }
  let j;
  try { j = JSON.parse(raw); } catch {
    // 注意：不要把 JSON.parse 的错误信息打出来——Node 的报错会带上文件内容片段，里面可能有 key
    if (!warned) { warned = true; console.warn(`smalltalk: 配置文件损坏（${configFile()}），暂用默认配置；下次保存设置时会被覆盖`); }
    return defaultConfig();
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return defaultConfig();
  if (j.version !== 2) return fromV1(j, raw);
  return { version: 2, endpoints: sanitizeEndpoints(j.endpoints) };
}

/** 内置的 Claude Code 接口（不存盘、不可改） */
export const claudeEndpoint = (claudePath) => ({
  id: CLAUDE_ID, name: 'Claude Code', type: 'claude-code', baseUrl: '', hasKey: false,
  models: [...CLAUDE_MODELS], modelsFetchedAt: null,
  ready: !!claudePath, detail: claudePath || '找不到 claude 可执行文件（可设置环境变量 SMALLTALK_CLAUDE）',
});

/** 内置的 Codex 接口（不存盘、不可改）。ready 只看找没找到可执行文件：登录状态不在这里探测（要启动进程、慢），没登录由生成请求报错说清楚 */
export const codexEndpoint = (codexPath) => ({
  id: CODEX_ID, name: 'Codex', type: 'codex-cli', baseUrl: '', hasKey: false,
  models: [...CODEX_MODELS], modelsFetchedAt: null,
  ready: !!codexPath,
  detail: codexPath || '找不到 codex 可执行文件：请安装 OpenAI 的 Codex CLI，并在终端运行 codex login 登录 ChatGPT 账号；也可以设置环境变量 SMALLTALK_CODEX 指向 codex.exe 的完整路径（改完要重启服务）',
});

/** 整个列表：内置的 claude-code 永远排第一个，codex 第二，然后是用户自己加的 */
export const publicEndpoints = (cfg, claudePath, codexPath = null) =>
  [claudeEndpoint(claudePath), codexEndpoint(codexPath), ...cfg.endpoints.map(publicEndpoint)];

/** 原子写入：先写同目录下的临时文件，再 rename 覆盖，中途崩溃也不会留下半个 config.json。 */
export function saveConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, endpoints: cfg.endpoints }, null, 2), { mode: 0o600 }); // 仅本人可读（类 Unix；Windows 忽略）
    fs.renameSync(tmp, configFile());
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  warned = false; // 成功写入后文件已是好的；以后再坏可以再警告
}
