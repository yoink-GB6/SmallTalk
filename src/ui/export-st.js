// 「导出成酒馆格式」的界面层小工具：触发下载、卡 → 文件、世界书 → 文件。
// 纯数据转换在 ../card-export.js（exportCardJson / serializeWorldbook / safeFileName）和 ../png.js（writeCardToPng），
// 这里只管 Blob、下载和提示。「存档」页（导出卡）和「世界书」页（导出书）共用。
//
// 依赖：只引了 dom.js（叶子）和纯函数模块，不引任何兄弟 ui 模块，所以不会加重 ui 之间的循环依赖。

import { toast } from './dom.js';
import { exportCardJson, serializeWorldbook, safeFileName } from '../card-export.js';
import { writeCardToPng, dataUrlToBytes, isPng } from '../png.js';

/** 触发浏览器下载一个 Blob。文件名可以带中文 / emoji（浏览器按 UTF-8 处理）；用完释放临时地址 */
export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // 不能马上 revoke：有的浏览器是异步开始下载的
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 酒馆的 JSON 文件是 4 空格缩进（和酒馆自己保存的一致，方便对比） */
const jsonBlob = (obj) => new Blob([JSON.stringify(obj, null, 4)], { type: 'application/json' });

/**
 * JPEG / WebP 头像 → PNG 字节。writeCardToPng 只认 PNG，所以先画到 canvas 上再导成 PNG
 * （酒馆在服务端用 Jimp 做的是同一件事）。图画不出来（数据坏了）会抛错。
 * @param {string} dataUrl
 * @returns {Promise<Uint8Array>}
 */
async function avatarToPngBytes(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('头像无法转成 PNG');
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 把一张卡做成要下载的文件：有头像就是 PNG（卡数据写在图里），否则 / 要求 JSON / 头像出问题就是 JSON。
 * @param {import('../types.js').Card} card
 * @param {string} avatar            头像 data URL，可为空
 * @param {{asJson?: boolean}} [opts]
 * @returns {Promise<{blob: Blob, filename: string, kind: 'png'|'json', note?: string}>}
 */
export async function cardToFile(card, avatar, { asJson = false } = {}) {
    // stripPrivate：和酒馆导出一致，清掉收藏标记和当前聊天指向，免得把私人状态分享出去
    const json = exportCardJson(card, { stripPrivate: true });
    const asJsonFile = (note) => ({ blob: jsonBlob(json), filename: safeFileName(card.name, 'json'), kind: /** @type {'json'} */ ('json'), note });
    if (asJson) return asJsonFile();
    if (!avatar) return asJsonFile('这张卡没有头像，导出的是 JSON');
    try {
        let bytes = dataUrlToBytes(avatar);
        if (!isPng(bytes)) bytes = await avatarToPngBytes(avatar);
        const out = writeCardToPng(bytes, json);
        return { blob: new Blob([out], { type: 'image/png' }), filename: safeFileName(card.name, 'png'), kind: 'png' };
    } catch (e) {
        // 头像坏了不能让导出整个失败：退回 JSON，并把原因告诉用户
        return asJsonFile(`头像处理失败（${e.message}），导出的是 JSON`);
    }
}

/** 世界书条目 → 酒馆的独立世界书文件。酒馆以文件名作书名，所以文件名 = 书名 */
export function bookToFile(entries, name) {
    return { blob: jsonBlob(serializeWorldbook(entries)), filename: safeFileName(name, 'json', '世界书') };
}

/** 导出一张卡并提示。出错也提示，不静默 */
export async function exportCardFile(card, avatar, opts) {
    try {
        if (!card) return void toast('没有可导出的角色卡', 'error');
        const f = await cardToFile(card, avatar, opts);
        downloadBlob(f.filename, f.blob);
        toast(`已导出「${f.filename}」${f.note ? `（${f.note}）` : ''}`, f.note && !opts?.asJson ? '' : 'ok');
    } catch (e) {
        console.warn(e);
        toast(`导出角色卡失败：${e.message}`, 'error');
    }
}

/** 导出一本世界书并提示 */
export function exportBookFile(entries, name) {
    try {
        const f = bookToFile(entries, name);
        downloadBlob(f.filename, f.blob);
        toast(`已导出「${f.filename}」（${entries.length} 条）`, 'ok');
    } catch (e) {
        console.warn(e);
        toast(`导出世界书失败：${e.message}`, 'error');
    }
}
