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
 *   | {kind:'regions', rects, drag}（第 5 期：脚本画的东西占的矩形，见 parseRegions）
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
        case 'regions': {
            // 区域：形状在宿主处理时再按 iframe 的实际尺寸校验（parseRegions）；这里只保证是数组、不太长
            if (!Array.isArray(d.rects) || d.rects.length > 1000) return null;
            return { kind: 'regions', rects: d.rects, drag: d.drag === true };
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

/**
 * 脚本按钮列表（酒馆助手 Script.button.buttons：[{name, visible}]）规范化：只认对象，name 转成字符串截到 100 字，visible 只有 false 才算不显示，最多 50 个。
 * 宿主写回卡、推给沙箱、画按钮排之前都过它（脚本和卡文件里给的什么都可能是）
 */
export function cleanButtonList(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const b of list) {
        if (out.length >= 50) break;
        if (!isObj(b)) continue;
        out.push({ name: String(b.name ?? '').slice(0, 100), visible: b.visible !== false });
    }
    return out;
}

/** 区域最多几个（超了合并成外接矩形） */
export const MAX_REGIONS = 32;

/**
 * 沙箱报来的区域 → 规范化的 [[x, y, w, h], …]（整数，裁到 iframe 的 0..vw × 0..vh 里，去掉空的）。
 * 每项必须是 4 个有限数字；不合法的项丢掉；多于 MAX_REGIONS 个时整体换成一个外接矩形（宁可多拦一点，也不漏掉脚本的界面）
 */
export function parseRegions(rects, vw, vh) {
    if (!Array.isArray(rects) || !(vw > 0) || !(vh > 0)) return [];
    const out = [];
    for (const r of rects.slice(0, 1000)) {
        if (!Array.isArray(r) || r.length !== 4 || !r.every(n => typeof n === 'number' && Number.isFinite(n))) continue;
        const x1 = Math.max(0, Math.floor(r[0])), y1 = Math.max(0, Math.floor(r[1]));
        const x2 = Math.min(Math.ceil(vw), Math.ceil(r[0] + r[2])), y2 = Math.min(Math.ceil(vh), Math.ceil(r[1] + r[3]));
        if (x2 > x1 && y2 > y1) out.push([x1, y1, x2 - x1, y2 - y1]);
    }
    if (out.length <= MAX_REGIONS) return out;
    const x1 = Math.min(...out.map(r => r[0])), y1 = Math.min(...out.map(r => r[1]));
    const x2 = Math.max(...out.map(r => r[0] + r[2])), y2 = Math.max(...out.map(r => r[1] + r[3]));
    return [[x1, y1, x2 - x1, y2 - y1]];
}

/** 规范化后的区域 → clip-path 的值。每个矩形一条顺时针的子路径，非零填充规则下重叠处取并集 */
export function regionsClipPath(rects) {
    return `path("${rects.map(([x, y, w, h]) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`).join(' ')}")`;
}
