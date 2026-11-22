// 从 PNG 里读出角色卡 JSON。
//
// PNG 文件结构（学习用的简要说明）：
//   1. 文件头 8 字节：137 80 78 71 13 10 26 10（即 \x89PNG\r\n\x1a\n），用来识别是不是 PNG。
//   2. 之后是一串「块」(chunk)，每个块的布局是：
//        [4 字节 长度(大端)] [4 字节 类型，如 IHDR / tEXt / IEND] [data 长度个字节] [4 字节 CRC]
//   3. tEXt 块的 data 格式是：关键字 + 一个 0x00 分隔符 + 文本，两者都是 latin1。
//      酒馆把角色卡的 JSON 做 base64 后，放在关键字 chara（V2）或 ccv3（V3）的 tEXt 块里。
//   4. IEND 是最后一个块，遇到它就停止。
// 读取（readCardFromPng）不校验 CRC；写入（writeCardToPng）会校验，和酒馆一样遇到坏块就拒绝。

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** latin1 解码：每个字节直接对应一个 char code，不走 TextDecoder（它的 latin1 其实是 windows-1252）。 */
function latin1(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

/**
 * 从 PNG 字节里找出角色卡 JSON。ccv3 优先，其次 chara。
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function readCardFromPng(bytes) {
    // 1. 检查文件头
    if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
        throw new Error('不是有效的 PNG 文件（文件头不对）');
    }

    // 2. 逐块遍历，收集 tEXt 块（关键字小写 → 文本，保留第一次出现的）
    const texts = new Map();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const length = view.getUint32(off); // 大端长度
        const type = latin1(bytes.subarray(off + 4, off + 8));
        const start = off + 8;
        const end = start + length;
        if (end > bytes.length) break; // 长度越界：文件被截断或损坏，不再往后读
        if (type === 'IEND') break;

        if (type === 'tEXt') {
            const data = bytes.subarray(start, end);
            const nul = data.indexOf(0); // 关键字与文本之间的分隔符
            if (nul > 0) {
                const keyword = latin1(data.subarray(0, nul)).toLowerCase();
                if (!texts.has(keyword)) texts.set(keyword, latin1(data.subarray(nul + 1)));
            }
        }
        off = end + 4; // 跳过 data，再跳过 4 字节 CRC
    }

    // 3. 选 ccv3 或 chara
    const b64 = texts.get('ccv3') ?? texts.get('chara');
    if (b64 === undefined) {
        throw new Error('这张 PNG 里没有角色卡数据（找不到 chara / ccv3 文本块）');
    }

    // 4. base64 → 字节 → UTF-8 JSON（atob 和 TextDecoder 在浏览器和 Node 里都是全局函数）
    const binary = atob(b64);
    const utf8 = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(utf8));
}

// ───────────────────────────── 写：把卡塞进 PNG ─────────────────────────────
// 对应酒馆 src/character-card-parser.js 的 write（~L15），它用到的分块库：
//   png-chunks-extract（读块：要求第一个块是 IHDR、必须有 IEND、每块 CRC 都要对，否则抛错）
//   src/png/encode.js（写块：长度 + 类型 + 数据 + CRC32(类型+数据)，IEND 之后的东西不写）
//   png-chunk-text（tEXt：关键字 + 0x00 + 文本，都是 latin1）

/** CRC32 查表（PNG 规范附录里的标准算法，多项式 0xEDB88320）。只在第一次用时建表。 */
let CRC_TABLE = null;
function crc32(bytes, crc = 0xFFFFFFFF) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
}
/** 一个块的 CRC：算的是「类型 4 字节 + 数据」，不含长度 */
const chunkCrc = (typeBytes, data) => (crc32(data, crc32(typeBytes)) ^ 0xFFFFFFFF) >>> 0;

/** 字节 → base64。浏览器没有 Buffer；btoa 只吃「每字符一个字节」的字符串，先分段拼出来（一次 apply 太多参数会爆栈） */
function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
    }
    return btoa(bin);
}

/** 拼一个完整的块：[长度][类型][数据][CRC] */
function buildChunk(type, data) {
    const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, chunkCrc(typeBytes, data));
    return out;
}

/** tEXt 块：关键字 + 0x00 + 文本。文本是 base64，纯 ASCII，按 latin1 一字一字节写 */
function textChunk(keyword, text) {
    const data = new Uint8Array(keyword.length + 1 + text.length);
    for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
    data[keyword.length] = 0;
    for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i);
    return buildChunk('tEXt', data);
}

/**
 * 把角色卡 JSON 写进 PNG，返回新的 PNG 字节（不改输入）。照酒馆 write：
 *   1. 去掉关键字为 chara / ccv3 的 tEXt 块（关键字转小写后比较，所以 Chara、CCV3 也算）；其它块原样保留、顺序不变；
 *   2. 在 IEND 之前写 chara：cardJson 原样 JSON.stringify（酒馆不改它的 spec，传进来是 V3 就还是 V3）；
 *   3. 紧接着写 ccv3：同一份 JSON 把 spec 改成 'chara_card_v3'、spec_version 改成 '3.0'。
 *      酒馆是「只要 JSON 能解析就写」，对我们传对象来说就是总是写。
 *   文本编码：JSON → UTF-8 字节 → base64（酒馆 Buffer.from(data, 'utf8').toString('base64')）。
 * 读回时 ccv3 优先，所以 readCardFromPng 拿到的是 spec 为 v3 的那份，除 spec / spec_version 外与 cardJson 相同。
 *
 * 和酒馆一样会拒绝的输入：文件头不对、第一个块不是 IHDR、没有 IEND、块长度越界、CRC 不对。
 * IEND 之后如果还有字节（有些工具会在后面挂东西），和酒馆一样丢掉。
 * 酒馆还会顺带做的、这里不做的：用 Jimp 把头像重新编码成 PNG、裁剪缩放——那是图片处理，交给调用方。
 *
 * @param {Uint8Array} pngBytes
 * @param {Object} cardJson
 * @returns {Uint8Array}
 */
export function writeCardToPng(pngBytes, cardJson) {
    const bytes = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes ?? []);
    if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
        throw new Error('不是有效的 PNG 文件（文件头不对），无法写入角色卡');
    }
    if (cardJson === null || typeof cardJson !== 'object') {
        throw new Error('写入 PNG 失败：角色卡必须是 JSON 对象');
    }

    // 1. 切块，记下要保留的块（原字节切片，不重新编码）
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {Uint8Array[]} */
    const kept = [];
    let iend = null;
    let off = 8;
    while (off + 8 <= bytes.length) {
        const length = view.getUint32(off);
        const typeBytes = bytes.subarray(off + 4, off + 8);
        const type = latin1(typeBytes);
        const start = off + 8;
        const end = start + length;
        if (end + 4 > bytes.length) throw new Error(`PNG 文件已损坏：${type} 块的长度超出了文件末尾`);
        if (kept.length === 0 && type !== 'IHDR') throw new Error('PNG 文件已损坏：第一个块不是 IHDR');
        const data = bytes.subarray(start, end);
        if (view.getUint32(end) !== chunkCrc(typeBytes, data)) {
            throw new Error(`PNG 文件已损坏：${type} 块的 CRC 校验不对`);
        }
        const whole = bytes.subarray(off, end + 4);
        if (type === 'IEND') { iend = whole; break; }

        let drop = false;
        if (type === 'tEXt') {
            const nul = data.indexOf(0);
            const keyword = latin1(nul >= 0 ? data.subarray(0, nul) : data).toLowerCase();
            drop = keyword === 'chara' || keyword === 'ccv3';
        }
        if (!drop) kept.push(whole);
        off = end + 4;
    }
    if (!iend) throw new Error('PNG 文件不完整：没有找到 IEND 块');

    // 2. 两份文本：chara 原样，ccv3 改 spec
    const enc = new TextEncoder();
    const v2Text = JSON.stringify(cardJson);
    const v3 = JSON.parse(v2Text);
    v3.spec = 'chara_card_v3';
    v3.spec_version = '3.0';
    const added = [
        textChunk('chara', bytesToBase64(enc.encode(v2Text))),
        textChunk('ccv3', bytesToBase64(enc.encode(JSON.stringify(v3)))),
    ];

    // 3. 拼回去：文件头 + 保留的块 + chara + ccv3 + IEND
    const parts = [bytes.subarray(0, 8), ...kept, ...added, iend];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}

/**
 * data URL（如头像 'data:image/png;base64,....'）→ 字节。只认 base64 形式；不是 PNG 也照样返回字节，
 * 是不是 PNG 由 writeCardToPng 检查（JPEG / WebP 头像要先在页面里用 canvas 转成 PNG）。
 * @param {string} dataUrl
 * @returns {Uint8Array}
 */
export function dataUrlToBytes(dataUrl) {
    const m = /^data:[^,]*;base64,(.*)$/s.exec(String(dataUrl ?? ''));
    if (!m) throw new Error('不是 base64 形式的 data URL');
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** 字节是不是以 PNG 文件头开始（给调用方决定要不要先转码） */
export function isPng(bytes) {
    return !!bytes && bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}
