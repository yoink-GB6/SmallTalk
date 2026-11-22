// OpenAI 兼容上游：构造请求、解析 SSE 流、错误信息整理（含抹掉 key）。
// 这些纯函数现在放在 src/openai-shared.js（网页版的「页面直连」后端用同一份），这里原样转出去，
// server.mjs 和测试照旧从这里 import。这里只留要读环境变量的超时设置。

import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_MODELS_TIMEOUT_MS } from '../src/openai-shared.js';

export {
  scrub, extractErrorMessage, eventErrorText, pickParams, toUpstreamMessages, createSseParser, contentOf,
  normalizeUsage, isStreamOptionsRejection, STREAM_OPTIONS, applyPromptCache,
} from '../src/openai-shared.js';

export const FIRST_BYTE_TIMEOUT_MS = Number(process.env.SMALLTALK_UPSTREAM_TIMEOUT_MS) || DEFAULT_FIRST_BYTE_TIMEOUT_MS; // 连接 / 首字节（响应头）超时
export const MODELS_TIMEOUT_MS = Number(process.env.SMALLTALK_MODELS_TIMEOUT_MS) || DEFAULT_MODELS_TIMEOUT_MS;
