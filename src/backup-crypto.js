// 整体备份的加密 / 解密。纯函数模块：只用 WebCrypto（globalThis.crypto.subtle），不碰 DOM、存储、网络。
// 浏览器和 Node 22 都有 crypto.subtle，所以能在 Node 里做单元测试（test/backup-crypto.test.mjs）。
// 文件形状见 types.js「备份文件」里的 EncryptedBackupFile。调用方只有 src/ui/backup.js（导出 / 恢复流程）和 src/backup.js（识别文件头）。
//
// 方案（为什么这么选）：
//   - 密钥派生：PBKDF2-HMAC-SHA-256，600000 次迭代（OWASP 目前对 PBKDF2-SHA256 的建议值），随机 16 字节盐。
//     WebCrypto 里没有 Argon2 / scrypt，PBKDF2 是浏览器和 Node 都原生支持的唯一选择。迭代次数让"猜密码"变慢：
//     每猜一次都要算 60 万次哈希。代价是我们自己导出 / 恢复时也要等这么久（电脑上零点几秒，手机上可能一两秒）。
//   - 加密：AES-256-GCM，随机 12 字节 IV。GCM 自带完整性校验：密文被改了一个字节、或者密码不对，解密都会失败，
//     而且这两种情况在 GCM 下【无法区分】，所以只能统一提示"密码不对，或文件已损坏"。
//   - 每次导出都重新生成盐和 IV：同一个密码、同一份内容导出两次，得到的文件也完全不同（同一个密钥绝不能重复用同一个 IV）。
//   - 头部的明文字段（format / version / exportedAt / hasKeys / kdf / cipher）作为 AES-GCM 的附加认证数据（AAD）：
//     它们不加密（打开文件前要靠它们知道怎么解），但被"签"进了密文。谁改了头部（比如把 hasKeys 改成 false 骗人、
//     把迭代次数改小），解密就会失败。
//
// 明文（备份的 JSON 文本）只在调用方的局部变量里短暂存在；这个模块不缓存任何东西，报错文字里也从不带明文或密码。

export const ENCRYPTED_FORMAT = 'smalltalk-backup-encrypted';
export const ENCRYPTED_VERSION = 1;
export const KDF_ITERATIONS = 600000;
// 解密时接受的迭代次数范围。上限：防止恶意 / 损坏的文件写一个天文数字，把浏览器卡死几分钟；
// 下限：我们自己从不写出比这更弱的文件，比这还小的不是我们导出的。
export const MIN_KDF_ITERATIONS = 100000;
export const MAX_KDF_ITERATIONS = 2000000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** 加密模块的错误：code 给程序判断用，message 是给人看的中文（不含密码、不含明文） */
export class BackupCryptoError extends Error {
    /** @param {'unavailable'|'format'|'too-new'|'wrong-password'|'password'|'failed'} code */
    constructor(code, message) {
        super(message);
        this.name = 'BackupCryptoError';
        this.code = code;
    }
}

export const WRONG_PASSWORD = '密码不对，或文件已损坏';
const UNAVAILABLE = '这个浏览器现在不提供加密功能（网页不是在安全环境里打开的：需要 https:// 地址，或在本机用 localhost / 127.0.0.1 打开），'
    + '所以没法加密 / 解密备份。请换用 https 地址或本机地址打开 SmallTalk 再试。';

/** 拿到 crypto.subtle；没有（非安全上下文，比如 http://局域网IP）就抛一个看得懂的错，而不是 "Cannot read properties of undefined" */
function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') throw new BackupCryptoError('unavailable', UNAVAILABLE);
    return c.subtle;
}

/** 现在能不能加密（界面上提前提示用） */
export function cryptoAvailable() {
    try { subtle(); return true; } catch { return false; }
}

// ───────────────────────────── base64（分段，大文件不爆栈） ─────────────────────────────
//
// 备份里的头像是 data URL，整个文件可能几十 MB。String.fromCharCode(...大数组) 会把每个字节当一个函数参数，
// 几十万个参数就超出调用栈；一次 atob / btoa 一整个大字符串也会占双份内存。所以按块处理：
// 编码每块 3 的倍数个字节（这样每块的 base64 拼起来正好是整体的 base64，中间不会出现 '='），解码每块 4 的倍数个字符。

const ENC_CHUNK = 3 * 8192;   // 24576 字节 / 块
const DEC_CHUNK = 4 * 8192;   // 32768 个字符 / 块
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i += ENC_CHUNK) {
        parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + ENC_CHUNK))));
    }
    return parts.join('');
}

/** @param {string} str @returns {Uint8Array}  不是合法的 base64 → 抛 BackupCryptoError('format') */
export function base64ToBytes(str) {
    if (typeof str !== 'string' || str.length % 4 !== 0 || !B64_RE.test(str)) throw new BackupCryptoError('format', '加密备份文件里的数据格式不对，文件可能损坏了');
    const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
    const out = new Uint8Array((str.length / 4) * 3 - pad);
    let o = 0;
    for (let i = 0; i < str.length; i += DEC_CHUNK) {
        const bin = atob(str.slice(i, i + DEC_CHUNK));
        for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
    }
    return out;
}

// ───────────────────────────── 头部 ─────────────────────────────

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 一个 JSON 对象是不是（声称是）加密备份 */
export const isEncryptedBackup = data => isObj(data) && data.format === ENCRYPTED_FORMAT;

/** base64 字段能不能解成指定长度的字节 */
function b64Len(s, n) {
    try { return base64ToBytes(s).length === n; } catch { return false; }
}

/**
 * 检查加密备份的头部（不碰密码、不解密）。返回 null = 没问题；否则是给人看的原因。
 * 我们只认识自己写出的那一种组合：算法名、哈希名不对就拒绝，不去猜。
 */
export function encryptedHeaderProblem(data) {
    if (!isEncryptedBackup(data)) return '不是 SmallTalk 的加密备份文件';
    if (!Number.isInteger(data.version) || data.version < 1) return '加密备份的版本号不对，文件可能损坏了';
    if (data.version > ENCRYPTED_VERSION) return `这个加密备份是更新版本的 SmallTalk 导出的（加密格式版本 ${data.version}），这个版本只认识 ${ENCRYPTED_VERSION}。为了不写坏数据，没有恢复`;
    if (typeof data.exportedAt !== 'string') return '加密备份的头部不完整（缺少导出时间），文件可能损坏了';
    if (typeof data.hasKeys !== 'boolean') return '加密备份的头部不完整（缺少 hasKeys），文件可能损坏了';
    const k = data.kdf, c = data.cipher;
    if (!isObj(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256') return '加密备份用的密钥派生算法不认识（只认 PBKDF2 / SHA-256），没有恢复';
    if (!Number.isInteger(k.iterations) || k.iterations < MIN_KDF_ITERATIONS || k.iterations > MAX_KDF_ITERATIONS) {
        return `加密备份里的迭代次数（${String(k.iterations).slice(0, 20)}）不在认识的范围内（${MIN_KDF_ITERATIONS}～${MAX_KDF_ITERATIONS}），为了不把浏览器卡死，没有尝试解密`;
    }
    if (!b64Len(k.salt, SALT_BYTES)) return '加密备份里的盐（salt）格式不对，文件可能损坏了';
    if (!isObj(c) || c.name !== 'AES-GCM') return '加密备份用的加密算法不认识（只认 AES-GCM），没有恢复';
    if (!b64Len(c.iv, IV_BYTES)) return '加密备份里的 IV 格式不对，文件可能损坏了';
    if (typeof data.data !== 'string' || !data.data) return '加密备份里没有数据，文件可能损坏了';
    return null;
}

/**
 * 附加认证数据：头部的明文字段按【固定顺序】拼成的 JSON 数组。
 * 不直接用文件里对象的 JSON：对象的键顺序、空白都可能在传输 / 编辑器里变，那样就算内容没改也会对不上。
 */
function aadOf(hd) {
    return new TextEncoder().encode(JSON.stringify([
        hd.format, hd.version, hd.exportedAt, hd.hasKeys,
        hd.kdf.name, hd.kdf.hash, hd.kdf.iterations, hd.kdf.salt,
        hd.cipher.name, hd.cipher.iv,
    ]));
}

/**
 * 密码 → AES-256-GCM 密钥。密码先做 Unicode NFC 规范化：同一个带声调 / 组合字符的密码，
 * 不同系统的输入法可能产生不同的码点序列，规范化后才能在电脑和手机之间通用。
 */
async function deriveKey(password, saltBytes, iterations, usage) {
    const s = subtle();
    const base = await s.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// ───────────────────────────── 加密 / 解密 ─────────────────────────────

/**
 * 加密一份备份的 JSON 文本。
 * @param {string} plainText   备份对象的 JSON（format: 'smalltalk-backup'）
 * @param {string} password    非空；长度要求由界面判断（含 key 时至少 8 位）
 * @param {{hasKeys: boolean, now?: Date, iterations?: number}} opts
 *        hasKeys：里面有没有 API key（写进明文头部，只用于提示）；iterations 只给测试用（默认 600000）
 * @returns {Promise<Object>}  EncryptedBackupFile（调用方 JSON.stringify 后下载）
 */
export async function encryptBackup(plainText, password, { hasKeys, now = new Date(), iterations = KDF_ITERATIONS } = {}) {
    if (typeof plainText !== 'string') throw new BackupCryptoError('failed', '要加密的内容不是文字');
    if (typeof password !== 'string' || !password) throw new BackupCryptoError('password', '没有设置密码');
    if (typeof hasKeys !== 'boolean') throw new BackupCryptoError('failed', 'hasKeys 必须是 true / false');
    if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) throw new BackupCryptoError('failed', '迭代次数不在允许范围内');
    const s = subtle();
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const head = {
        format: ENCRYPTED_FORMAT, version: ENCRYPTED_VERSION, exportedAt: now.toISOString(), hasKeys,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) },
        cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    };
    const key = await deriveKey(password, salt, iterations, 'encrypt');
    let ct;
    try {
        ct = await s.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(head), tagLength: 128 }, key, new TextEncoder().encode(plainText));
    } catch {
        throw new BackupCryptoError('failed', '加密失败（浏览器的加密功能报错了）');
    }
    return { ...head, data: bytesToBase64(new Uint8Array(ct)) };
}

/**
 * 解密。头部不认识 → BackupCryptoError('format' / 'too-new')；密码不对或文件被改过 → BackupCryptoError('wrong-password')。
 * @param {Object} file      JSON.parse 后的 EncryptedBackupFile
 * @param {string} password
 * @returns {Promise<string>}  明文 JSON 文本（调用方用完就丢）
 */
export async function decryptBackup(file, password) {
    const why = encryptedHeaderProblem(file);
    if (why) throw new BackupCryptoError(isObj(file) && Number.isInteger(file.version) && file.version > ENCRYPTED_VERSION ? 'too-new' : 'format', why);
    if (typeof password !== 'string' || !password) throw new BackupCryptoError('password', '请输入密码');
    const s = subtle();
    const ct = base64ToBytes(file.data);
    const key = await deriveKey(password, base64ToBytes(file.kdf.salt), file.kdf.iterations, 'decrypt');
    let pt;
    try {
        pt = await s.decrypt({ name: 'AES-GCM', iv: base64ToBytes(file.cipher.iv), additionalData: aadOf(file), tagLength: 128 }, key, ct);
    } catch {
        // GCM 的认证失败：密码错、密文被改、头部被改，三者无法区分
        throw new BackupCryptoError('wrong-password', WRONG_PASSWORD);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(pt);
    } catch {
        throw new BackupCryptoError('wrong-password', WRONG_PASSWORD);
    }
}
