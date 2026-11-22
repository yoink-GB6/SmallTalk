// 脚本沙箱发给宿主的消息的校验（纯函数，Node 里可测）。宿主一侧在 src/ui/script-host.js。
// 楼层号、变量对象、变量路径的校验在 frame-args.js / vars-ops.js（前端卡和脚本共用）；这里是脚本沙箱特有的：
// 消息的形状、方法白名单、脚本 id 只认登记过的、日志的级别和长度、发回沙箱的报错文字抹掉像 key 的东西。

import { SCRIPT_BRIDGED } from './script-stub.js';

const BRIDGED = new Set(SCRIPT_BRIDGED);
const LEVELS = new Set(['call', 'unimplemented', 'unsupported', 'error', 'warn', 'console', 'info']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 沙箱发来的一条消息（已经核对过 event.source 和 frameId）→ 规范化的样子；不认识 / 不合法 → null（宿主直接丢掉）。
 *   {kind:'ready'} | {kind:'call', id, method, args, scriptId} | {kind:'log', level, text, scriptId} | {kind:'status', scriptId, status, text}
 * scriptId：null（认不出是哪个脚本）或登记过的 id；别的值 → 当作 null（日志）/ 拒绝（调用，返回 {reject: 原因}）。
 * @param {any} d
 * @param {Set<string>} ids   这个沙箱启动时登记的脚本 id
 */
export function parseSandboxMessage(d, ids) {
    if (!isObj(d)) return null;
    const sid = d.scriptId === null || d.scriptId === undefined ? null : (typeof d.scriptId === 'string' && ids.has(d.scriptId) ? d.scriptId : undefined);
    switch (d.kind) {
        case 'ready': return { kind: 'ready' };
        case 'call': {
            if (!Number.isInteger(d.id)) return null;
            const method = typeof d.method === 'string' ? d.method.slice(0, 100) : '';
            const args = Array.isArray(d.args) ? d.args : [];
            if (sid === undefined) return { kind: 'call', id: d.id, method, args, scriptId: null, reject: `不认识的脚本 id ${JSON.stringify(String(d.scriptId)).slice(0, 80)}（只认这个沙箱启动时装进来的脚本）` };
            if (!BRIDGED.has(method)) return { kind: 'call', id: d.id, method, args, scriptId: sid, reject: `SmallTalk 不支持 ${method || '(空)'}` };
            return { kind: 'call', id: d.id, method, args, scriptId: sid };
        }
        case 'log': {
            if (!LEVELS.has(d.level)) return null;
            return { kind: 'log', level: d.level, text: String(d.text ?? '').slice(0, 2000), scriptId: sid ?? null };
        }
        case 'status': {
            if (sid === null || sid === undefined || !['running', 'error'].includes(d.status)) return null;
            return { kind: 'status', scriptId: sid, status: d.status, text: String(d.text ?? '').slice(0, 500) };
        }
        default: return null;
    }
}

/**
 * 发回沙箱 / 写进日志之前抹掉看起来像 API key 的东西（兜底：宿主方法的报错都是我们自己写的中文说明，本来就不含 key；
 * 但万一哪天哪个底层错误带着请求头或地址冒上来）。规则：sk- / rk- / pk- 等前缀的长串、Bearer 后面的、key= / api_key= 后面的、
 * 以及 32 位以上的连续字母数字串（像 token）。
 */
export function scrubSecrets(text) {
    return String(text ?? '')
        .replace(/\b(?:sk|rk|pk|ak)-[\w\-+/=.]{8,}/gi, '[已隐藏]')
        .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
        .replace(/((?:api[_-]?key|key|token|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[已隐藏]')
        .replace(/[A-Za-z0-9_\-+/]{32,}/g, '[已隐藏]');
}
