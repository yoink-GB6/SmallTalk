// 通用 zip 读 / 写。纯函数，浏览器和 Node 22 通用（顶层不碰任何 Node 专有 API）。
//
// 为什么自己写：项目没有 npm 依赖、没有构建步骤；zip 格式本身不复杂，浏览器又自带
// DecompressionStream / CompressionStream('deflate-raw')，只差"解析容器"这一层。
//
// 读（openZip / readEntry）的设计要点：
//   1. 输入是 Blob / File，只按范围取字节（blob.slice().arrayBuffer()），不会把几百 MB 的备份整个读进内存。
//   2. 必须从文件【末尾】的中央目录读起，而不是从头顺着读本地文件头。酒馆的备份是 archiver 流式写出的，
//      每个条目用"数据描述符"：本地头里的大小和 CRC 是 0，真实值只在中央目录里（见 users.js createBackupArchive）。
//   3. openZip 只读中央目录，不解压任何东西；readEntry 才按需读本地头 + 数据。
//   4. 解压时边解边数，超过声明的原始大小（或调用方给的 maxSize）立刻中止，防压缩炸弹。
//   5. DecompressionStream 不校验 CRC，所以自己算一遍。
//   6. 所有"格式不对 / 被篡改 / 不支持"的情况都抛 ZipError（中文消息，不同原因不同文字），不崩、不挂死。
//
// 写（buildZip）：已知每个条目的完整内容，所以不用数据描述符，本地头里直接写真实大小和 CRC。
//
// 没实现的：ZIP64（遇到就明确报错）、加密条目、多卷、除"存储 / deflate"以外的压缩方法。

/** zip 相关的错误。code 方便上层区分原因（界面可以只显示 message） */
export class ZipError extends Error {
    constructor(message, code = 'bad-zip') {
        super(message);
        this.name = 'ZipError';
        this.code = code;
    }
}

/** 条目数上限：超了多半是恶意文件或不是备份，不值得继续解析 */
export const MAX_ENTRIES = 200_000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xFFFF;
const ZIP64_MSG = '这个压缩包太大或文件太多（需要 ZIP64 格式），暂不支持';

// ───────────────────────────── CRC32 ─────────────────────────────
// src/png.js 里也有一份，但它没导出（而且是 PNG 块专用的"续算"形式），这里单独写一份，
// 以后可以合并成一个导出。标准多项式 0xEDB88320。

let CRC_TABLE = null;
/** @param {Uint8Array} bytes  @returns {number} 无符号 32 位 CRC */
export function crc32(bytes) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ───────────────────────────── 名字 ─────────────────────────────

/**
 * 条目名是否安全、并整理成统一写法。不安全返回 null。
 * 读取模块本身不往磁盘写，但上层会拿名字做匹配 / 当文件名用，所以要干净。
 * 不安全：绝对路径、盘符（C:）、含 `..` 或 `.` 段、空段（a//b）、控制字符（含 \0）、空名字。
 * 反斜杠先统一成 `/`；目录条目末尾的一个 `/` 会被去掉（所以返回值不带结尾斜杠）。
 * @param {string} name
 * @returns {string|null}
 */
export function safeEntryPath(name) {
    if (typeof name !== 'string' || !name) return null;
    let p = name.replace(/\\/g, '/');
    if (/[\x00-\x1f\x7f]/.test(p)) return null;
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
    if (p.endsWith('/')) p = p.slice(0, -1);
    if (!p) return null;
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.' || seg === '..') return null;
    }
    return p;
}

// CP437 高半区（0x80–0xFF）。没置 UTF-8 标志、又不是合法 UTF-8 的名字按它解（老式 zip 工具的默认编码）
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeCp437(bytes) {
    let s = '';
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    return s;
}

/** @returns {{name: string, uncertain: boolean}} */
function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return { name: new TextDecoder('utf-8').decode(bytes), uncertain: false };
    try {
        // 纯 ASCII 的名字这里也会成功，且两种编码结果一样，不算"不确定"
        const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { name, uncertain: false };
    } catch {
        return { name: decodeCp437(bytes), uncertain: true };
    }
}

// ───────────────────────────── 读 ─────────────────────────────

/** 接受 Blob / File，也接受 Uint8Array（方便测试和小文件） */
function asBlob(input) {
    if (typeof Blob !== 'undefined' && input instanceof Blob) return input;
    if (input instanceof Uint8Array) return new Blob([input]);
    if (input instanceof ArrayBuffer) return new Blob([input]);
    throw new ZipError('不是文件（需要 File / Blob）', 'bad-input');
}

async function readRange(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/**
 * @typedef {Object} ZipEntry
 * @property {string}  name           统一成 `/` 分隔后的原名（目录以 `/` 结尾）
 * @property {string|null} path       safeEntryPath(name)；不安全时为 null，上层不要用这个条目
 * @property {boolean} isDirectory
 * @property {boolean} nameUncertain  名字没有 UTF-8 标志、且不是合法 UTF-8，按 CP437 兜底解的，可能是乱码
 * @property {number}  method         0 = 存储，8 = deflate
 * @property {number}  compressedSize
 * @property {number}  size           原始大小（中央目录声明的）
 * @property {number}  crc
 * @property {number}  localOffset
 * @property {number}  flags          通用标志位
 * @property {boolean} encrypted      flags bit 0；readEntry 会拒绝
 * @property {number}  mtime          毫秒时间戳（DOS 时间按本地时间解释，仅供参考）
 */

/**
 * 打开 zip：只读末尾的中央目录，不解压任何内容。
 * @param {Blob|File|Uint8Array} input
 * @returns {Promise<{blob: Blob, entries: ZipEntry[], comment: string}>}
 */
export async function openZip(input) {
    const blob = asBlob(input);
    const total = blob.size;
    if (total === 0) throw new ZipError('文件是空的', 'empty');
    if (total < EOCD_MIN) throw new ZipError('这不是一个 zip 压缩包（文件太小）', 'not-zip');

    // 1. 找 EOCD（中央目录结束记录）：最后 22 字节 + 最长 64 KB 的注释，从后往前扫签名
    const tailStart = Math.max(0, total - (EOCD_MIN + MAX_COMMENT));
    const tail = await readRange(blob, tailStart, total);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let pos = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
        if (tv.getUint32(i, true) !== SIG_EOCD) continue;
        const commentLen = tv.getUint16(i + 20, true);
        if (i + EOCD_MIN + commentLen <= tail.length) { pos = i; break; } // 注释长度对得上才算，免得被注释里的假签名骗
    }
    if (pos < 0) throw new ZipError('这不是一个 zip 压缩包（找不到文件结尾标记），文件可能不完整或已损坏', 'not-zip');

    const diskNo = tv.getUint16(pos + 4, true);
    const cdDisk = tv.getUint16(pos + 6, true);
    const entriesOnDisk = tv.getUint16(pos + 8, true);
    const count = tv.getUint16(pos + 10, true);
    const cdSize = tv.getUint32(pos + 12, true);
    const cdOffset = tv.getUint32(pos + 16, true);
    const commentLen = tv.getUint16(pos + 20, true);
    const eocdAbs = tailStart + pos;

    // 2. ZIP64：有定位器，或者 EOCD 里的字段是"放不下"的占位值
    if (pos >= 20 && tv.getUint32(pos - 20, true) === SIG_ZIP64_LOCATOR) throw new ZipError(ZIP64_MSG, 'zip64');
    if (count === 0xFFFF || entriesOnDisk === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        throw new ZipError(ZIP64_MSG, 'zip64');
    }
    if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== count) {
        throw new ZipError('这是分卷压缩包，暂不支持（请先合并成一个 zip）', 'multi-volume');
    }
    if (count > MAX_ENTRIES) throw new ZipError(`压缩包里的文件太多（${count} 个）`, 'too-many');
    if (cdOffset + cdSize > eocdAbs) {
        throw new ZipError('压缩包的目录位置超出了文件范围，文件可能被截断或已损坏', 'cd-out-of-range');
    }
    if (count * 46 > cdSize) throw new ZipError('压缩包的目录和条目数对不上，文件可能已损坏', 'count-mismatch');

    // 3. 读中央目录并逐条解析
    const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
    const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > cd.length) throw new ZipError('压缩包的目录比声明的短，条目数对不上，文件可能已损坏', 'count-mismatch');
        if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('压缩包的目录格式不对，文件可能已损坏', 'bad-central');
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const dosTime = dv.getUint16(p + 12, true);
        const dosDate = dv.getUint16(p + 14, true);
        const crc = dv.getUint32(p + 16, true);
        const csize = dv.getUint32(p + 20, true);
        const usize = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const cmtLen = dv.getUint16(p + 32, true);
        const diskStart = dv.getUint16(p + 34, true);
        const localOffset = dv.getUint32(p + 42, true);
        const end = p + 46 + nameLen + extraLen + cmtLen;
        if (end > cd.length) throw new ZipError('压缩包的目录条目超出范围，文件可能已损坏', 'bad-central');
        if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || diskStart === 0xFFFF) {
            throw new ZipError(ZIP64_MSG, 'zip64');
        }
        if (diskStart !== 0) throw new ZipError('这是分卷压缩包，暂不支持（请先合并成一个 zip）', 'multi-volume');
        if (localOffset + 30 > cdOffset) throw new ZipError('压缩包里有条目的位置超出了文件范围，文件可能已损坏', 'entry-out-of-range');

        const { name: raw, uncertain } = decodeName(cd.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x0800));
        const name = raw.replace(/\\/g, '/');
        entries.push({
            name,
            path: safeEntryPath(name),
            isDirectory: name.endsWith('/'),
            nameUncertain: uncertain,
            method,
            compressedSize: csize,
            size: usize,
            crc,
            localOffset,
            flags,
            encrypted: !!(flags & 1),
            mtime: dosToMs(dosDate, dosTime),
        });
        p = end;
    }
    if (p !== cd.length) throw new ZipError('压缩包的目录里有多余的内容，条目数对不上，文件可能已损坏', 'count-mismatch');

    const commentBytes = tail.subarray(pos + EOCD_MIN, pos + EOCD_MIN + commentLen);
    return { blob, entries, comment: new TextDecoder().decode(commentBytes) };
}

function dosToMs(date, time) {
    const y = (date >> 9) + 1980, mo = ((date >> 5) & 15) - 1, d = date & 31;
    const h = time >> 11, mi = (time >> 5) & 63, s = (time & 31) * 2;
    const t = new Date(y, Math.max(0, mo), d || 1, h, mi, s).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * 读出一个条目的完整内容（校验长度和 CRC32）。目录返回空数组。
 * @param {{blob: Blob, entries: ZipEntry[]}} zip   openZip 的返回值
 * @param {ZipEntry} entry
 * @param {{maxSize?: number}} [opts]  解压后最大字节数，默认 256 MB；声明的大小超了直接拒绝，实际解出来超了立刻中止
 * @returns {Promise<Uint8Array>}
 */
export async function readEntry(zip, entry, { maxSize = 256 * 1024 * 1024 } = {}) {
    if (entry.isDirectory) return new Uint8Array(0);
    if (entry.encrypted) throw new ZipError(`「${entry.name}」是加密的，暂不支持`, 'encrypted');
    if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipError(`「${entry.name}」用了不支持的压缩方式（${entry.method}），只支持存储和 deflate`, 'bad-method');
    }
    if (entry.size > maxSize) {
        throw new ZipError(`「${entry.name}」解压后有 ${entry.size} 字节，超过了上限 ${maxSize}`, 'too-big');
    }
    const blob = zip.blob;
    // 本地头：30 字节固定部分 + 名字 + extra。它的 name/extra 长度可以和中央目录的不同，所以要重新读
    const lh = await readRange(blob, entry.localOffset, entry.localOffset + 30);
    if (lh.length < 30) throw new ZipError(`「${entry.name}」的文件头不完整，文件可能被截断`, 'bad-local');
    const lv = new DataView(lh.buffer, lh.byteOffset, 30);
    if (lv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`「${entry.name}」的文件头签名不对，文件可能已损坏`, 'bad-local');
    const dataStart = entry.localOffset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const dataEnd = dataStart + entry.compressedSize;
    // 数据必须落在中央目录之前；这里用整个文件大小做粗检（readRange 读不满会在下面发现）
    if (dataEnd > blob.size) throw new ZipError(`「${entry.name}」的数据超出了文件范围，文件可能被截断`, 'entry-out-of-range');
    const packed = blob.slice(dataStart, dataEnd);

    let out;
    if (entry.method === 0) {
        if (entry.compressedSize !== entry.size) {
            throw new ZipError(`「${entry.name}」的长度对不上（存储方式下压缩前后应相同）`, 'size-mismatch');
        }
        out = new Uint8Array(await packed.arrayBuffer());
    } else {
        out = await inflateLimited(packed, entry.size, entry.name);
    }
    if (out.length !== entry.size) {
        throw new ZipError(`「${entry.name}」解出来的长度和声明的不一致（${out.length} ≠ ${entry.size}）`, 'size-mismatch');
    }
    if (crc32(out) !== entry.crc) {
        throw new ZipError(`「${entry.name}」的校验和不对（CRC32），数据已损坏`, 'crc-mismatch');
    }
    return out;
}

/** deflate-raw 解压，边解边数，超过 limit 立即取消 */
async function inflateLimited(packedBlob, limit, name) {
    const stream = packedBlob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let got = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            got += value.length;
            if (got > limit) {
                await reader.cancel().catch(() => {});
                throw new ZipError(`「${name}」解压出来的数据比声明的大（超过 ${limit} 字节），拒绝处理`, 'bomb');
            }
            chunks.push(value);
        }
    } catch (e) {
        if (e instanceof ZipError) throw e;
        throw new ZipError(`「${name}」的压缩数据已损坏，无法解压`, 'bad-deflate');
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

// ───────────────────────────── 写 ─────────────────────────────

/** deflate-raw 压缩。读和写同时进行，避免大数据时背压导致死锁 */
async function deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const reading = new Response(cs.readable).arrayBuffer();
    const w = cs.writable.getWriter();
    // 不 await write：它要等读端消费才完成，而读端已经在 reading 里跑，两边并行就不会卡
    const writing = w.write(data).then(() => w.close());
    const [buf] = await Promise.all([reading, writing]);
    return new Uint8Array(buf);
}

function toDos(mtime) {
    let d = mtime instanceof Date ? mtime : new Date(mtime ?? Date.now());
    if (!Number.isFinite(d.getTime())) d = new Date();
    const y = Math.min(2107, Math.max(1980, d.getFullYear()));
    const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
}

/**
 * 把一组条目打成 zip。
 * - 每个条目先试 deflate，压完不比原来小就改存储；
 * - 文件名一律 UTF-8 并置 bit 11；
 * - 条目名以 `/` 结尾表示目录（data 应为空）；
 * - 总大小 / 条目数需要 ZIP64 时抛错。
 * @param {{name: string, data?: Uint8Array, mtime?: number|Date}[]} entries
 * @returns {Promise<Blob>}
 */
export async function buildZip(entries) {
    if (entries.length >= 0xFFFF) throw new ZipError(ZIP64_MSG, 'zip64');
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    const seen = new Set();
    let offset = 0;

    for (const e of entries) {
        const name = String(e.name ?? '').replace(/\\/g, '/');
        if (safeEntryPath(name) === null) throw new ZipError(`条目名不安全或为空：${JSON.stringify(e.name)}`, 'bad-name');
        if (seen.has(name)) throw new ZipError(`条目名重复：${name}`, 'dup-name');
        seen.add(name);
        const nameBytes = enc.encode(name);
        if (nameBytes.length > 0xFFFF) throw new ZipError(`条目名太长：${name.slice(0, 40)}…`, 'bad-name');
        const isDir = name.endsWith('/');
        const data = isDir ? new Uint8Array(0) : (e.data ?? new Uint8Array(0));
        if (!(data instanceof Uint8Array)) throw new ZipError(`条目「${name}」的内容必须是 Uint8Array`, 'bad-input');
        if (data.length >= 0xFFFFFFFF) throw new ZipError(ZIP64_MSG, 'zip64');

        let method = 0, body = data;
        if (data.length > 0) {
            const packed = await deflateRaw(data);
            if (packed.length < data.length) { method = 8; body = packed; }
        }
        const crc = crc32(data);
        const { date, time } = toDos(e.mtime);
        const version = method === 8 ? 20 : 10;

        const lh = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0, SIG_LOCAL, true);
        lv.setUint16(4, version, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, method, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        lh.set(nameBytes, 30);

        const ch = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(ch.buffer);
        cv.setUint32(0, SIG_CENTRAL, true);
        cv.setUint16(4, 20, true);       // 制作版本（host = 0 / FAT，不带 Unix 权限）
        cv.setUint16(6, version, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, method, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, body.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(38, isDir ? 0x10 : 0, true); // 外部属性：FAT 的目录位
        cv.setUint32(42, offset, true);
        ch.set(nameBytes, 46);

        parts.push(lh, body);
        central.push(ch);
        offset += lh.length + body.length;
        if (offset >= 0xFFFFFFFF) throw new ZipError(ZIP64_MSG, 'zip64');
    }

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    if (offset + cdSize >= 0xFFFFFFFF) throw new ZipError(ZIP64_MSG, 'zip64');
    const eocd = new Uint8Array(EOCD_MIN);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}
