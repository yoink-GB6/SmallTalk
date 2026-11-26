// 酒馆助手脚本的「允许直接操作页面」（直通模式）：这台设备上对某张卡的信任记录（纯函数，Node 里可测）。
// 运行时在 ui/script-host.js（建同源 iframe、清理页面），开关在 ui/tab-scripts.js，确认框在 ui/trust-confirm.js。
//
// 为什么要有指纹：信任是对「打开开关那一刻正在运行的那几段代码」给的。卡被「更新」（同名卡导入覆盖）、脚本代码被换掉、
// 又启用了一个打开开关时没在运行的脚本——这些都是没被看过的新代码，信任自动作废（script-host.js 发现后关掉并提示一次）。
//   指纹 = 每个启用脚本的 content 各算一个 SHA-256（十六进制）。还有效 = 现在每个启用脚本的哈希都在记下的集合里
//   （所以关掉其中一个脚本不会作废；又打开它也不会）。
//   用 SHA-256 而不是 scripts.js 的 cyrb53：53 位的非密码学哈希能被人为造出碰撞（「更新」一张卡、让新代码的哈希和旧的一样）。
//   要同步算（script-host 的建 / 拆都是同步的），浏览器的 crypto.subtle 是异步的，所以按 FIPS 180-4 自己写了一份。
// 防不住的：脚本只是个加载器、真正的代码每次从外链拉——指纹不变、行为在变。这是信任卡作者的问题，开关旁那句话已经说了。
//
// 存哪：localStorage['smalltalk.scriptTrusted']，JSON 数组 [{id: 卡 id, fp: [哈希…]}]，最多 200 张卡；一张都没有时不存这个键。
//   是「这台设备上的决定」：不进卡文件、不进整体备份（localStorage 本来就不进），恢复到别的浏览器自然是关的；
//   删卡时一起删掉（archive.js deleteCard 调 forgetTrust），免得同一个卡 id 从备份里回来时又是开的。
//   data-inventory.js LOCAL_STORAGE_PREFS 登记过。

export const TRUST_KEY = 'smalltalk.scriptTrusted';
export const TRUST_MAX_CARDS = 200;
const MAX_FP = 500;
const HEX64 = /^[0-9a-f]{64}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// ───────── SHA-256（FIPS 180-4），输入按 UTF-8 编码 ─────────
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {string} text  @returns {string} 64 位十六进制 */
export function sha256Hex(text) {
    const bytes = new TextEncoder().encode(String(text));
    const bitLen = bytes.length * 8;
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
            const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
}

// ───────── 指纹 ─────────

/** 一组脚本（启用的那些）→ 去重后的 content 哈希，按字典序 */
export function scriptFingerprint(list) {
    const set = new Set();
    for (const s of Array.isArray(list) ? list : []) set.add(sha256Hex(typeof s?.content === 'string' ? s.content : ''));
    return [...set].sort();
}

/** 信任记录还覆盖得了现在这组启用的脚本吗（每个的哈希都在记下的集合里；没有启用的脚本 = 覆盖） */
export function trustCovers(entry, list) {
    if (!entry || !Array.isArray(entry.fp)) return false;
    const have = new Set(entry.fp);
    return scriptFingerprint(list).every(x => have.has(x));
}

// ───────── localStorage 里的那一项 ─────────

/**
 * 读出来的字符串 → [{id, fp}]（坏数据丢掉、同一个 id 只留最后一条、最多 TRUST_MAX_CARDS 条）。永不抛错
 * @param {string|null} raw
 * @returns {{id: string, fp: string[]}[]}
 */
export function parseTrustList(raw) {
    let v;
    try { v = JSON.parse(raw || '[]'); } catch { return []; }
    if (!Array.isArray(v)) return [];
    const byId = new Map();
    for (const x of v) {
        if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 200 || UNSAFE.has(x.id) || !Array.isArray(x.fp)) continue;
        const fp = [...new Set(x.fp.filter(f => typeof f === 'string' && HEX64.test(f)))].slice(0, MAX_FP).sort();
        byId.delete(x.id);
        byId.set(x.id, { id: x.id, fp });
    }
    return [...byId.values()].slice(-TRUST_MAX_CARDS);
}

/** [{id, fp}] → 要存的字符串；空列表 → null（调用方删掉这个键） */
export function serializeTrustList(list) {
    const clean = parseTrustList(JSON.stringify(Array.isArray(list) ? list : []));
    return clean.length ? JSON.stringify(clean) : null;
}

/** 在列表里设 / 删一张卡（返回新列表，不改原来的）。entry 为 null = 删 */
export function withTrust(list, id, entry) {
    const out = (Array.isArray(list) ? list : []).filter(x => x && x.id !== id);
    if (entry) out.push({ id, fp: [...entry.fp] });
    return out.slice(-TRUST_MAX_CARDS);
}
