// 一次性脚本：造 test/fixtures/tavern-backup-sample.zip（一个"酒馆整体备份"形状的小夹具）。
//
// 用法（在 smalltalk 目录下）：node scripts/make-tavern-fixture.mjs
// 前提：../SillyTavern-release/node_modules/archiver 存在（酒馆自己的依赖）。
//       夹具造好并提交后，测试只读 zip，不再依赖酒馆目录。
//
// 打包方式照抄酒馆 src/users.js createBackupArchive：archiver('zip') 流式写出，
// archive.glob('**/*', { cwd, follow: false, stat: true, dot: true })。流式 => 条目用"数据描述符"，
// 本地头里大小 / CRC 是 0，这正是 src/zip.js 必须从中央目录读起的原因。
//
// 内容全部是假的：卡和预设取自 test/fixtures 的小卡小预设，密码类字段是明显的假字符串。
// 绝不使用用户真实的酒馆数据（../SillyTavern-release/data、../things、test-char-preset）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../src/zip.js';
import { writeCardToPng } from '../src/png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.resolve(root, '../SillyTavern-release/node_modules/') + path.sep);
const archiver = require('archiver');

const miniCard = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/mini-card.json'), 'utf8'));
// 预设用带假连接信息的那份（mini-preset.json + 酒馆会写进预设的反代地址 / 密码 / 附加请求头……，值都是明显的假字符串）：
// 导入后这些字段必须被去掉，结果应当和 mini-preset.json 一字不差（test/tavern-convert.test.mjs、browser-tests/tavern-ui.mjs 查）
const miniPreset = fs.readFileSync(path.join(root, 'test/fixtures/mini-preset-secrets.json'), 'utf8');

/** 造一张 8x8 纯色 PNG（只用来装卡数据） */
function tinyPng(r, g, b) {
    const chunk = (type, data) => {
        const t = Buffer.from(type, 'latin1');
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
        return Buffer.concat([len, t, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB
    const raw = Buffer.alloc(8 * (1 + 8 * 3));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const o = y * 25 + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
    return new Uint8Array(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-fixture-'));
const put = (rel, data) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
};
const json = o => JSON.stringify(o, null, 4);
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

// 卡：文件名含中文、含空格；第三张是 .json
const withName = (name, extra = {}) => ({ ...miniCard, name, data: { ...miniCard.data, name, ...extra } });
put('characters/艾拉.png', writeCardToPng(tinyPng(200, 80, 80), withName('艾拉')));
put('characters/Space Card 空格.png', writeCardToPng(tinyPng(80, 200, 80), withName('空格卡')));
put('characters/第三张.json', json(withName('第三张')));

const chatHead = (user, ch) => ({ user_name: user, character_name: ch, create_date: '2026-11-20@10h00m00s', chat_metadata: {} });
const msg = (name, isUser, mes) => ({ name, is_user: isUser, is_system: false, send_date: '2026-11-20T10:00:00.000Z', mes });
put('chats/艾拉/2026-11-20@10h00m00s.jsonl', jsonl([chatHead('小明', '艾拉'), msg('艾拉', false, '【艾拉的开场】'), msg('小明', true, '你好')]));
put('chats/艾拉/第二段 聊天.jsonl', jsonl([chatHead('小明', '艾拉'), msg('艾拉', false, '又见面了 🌊')]));
put('chats/Space Card 空格/a.jsonl', jsonl([chatHead('小明', '空格卡'), msg('空格卡', false, 'hi')]));
put('chats/已删除的角色/orphan.jsonl', jsonl([chatHead('小明', '已删除'), msg('已删除', false, '没有对应的卡')])); // 孤儿聊天

put('worlds/灯塔世界.json', json({ entries: { 0: { uid: 0, key: ['灯塔'], keysecondary: [], comment: '灯塔', content: '灯塔高一百二十级。', constant: false, selective: false, order: 100, position: 0, disable: false } } }));
put('OpenAI Settings/迷你预设.json', miniPreset);

const FAKE = 'FAKE-PASSWORD-DO-NOT-USE';
put('settings.json', json({
    username: '小明',
    user_avatar: '1700000000000-a.png',
    power_user: {
        personas: { '1700000000000-a.png': '小明', 'user-default.png': '默认人设' },
        persona_descriptions: {
            '1700000000000-a.png': { description: '一个爱数台阶的旅人。', title: '', connections: [] },
            'user-default.png': { description: '', title: '' },
        },
    },
    extension_settings: {
        apiKey: FAKE,
        regex: [
            { id: 'rx-1', scriptName: '去掉星号', findRegex: '/\\*/g', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, password: FAKE },
        ],
    },
    oai_settings: { preset_settings_openai: '迷你预设', proxy_password: FAKE, custom_include_headers: `Authorization: ${FAKE}` },
    proxies: [{ name: 'p', url: 'http://x', password: FAKE }],
}));
put('secrets.json', json({ api_key_openai: 'FAKE-SECRET-IN-SECRETS-JSON' })); // 酒馆默认不打这个，这里放进去是为了测"绝不外泄"

// 该被忽略的目录
put('backups/chat_艾拉_20261120.jsonl', jsonl(Array.from({ length: 300 }, (_, i) => msg('艾拉', false, `备份行 ${i} `.repeat(8)))));
put('thumbnails/bg/艾拉.jpg', Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) & 255)));
put('extensions/some-ext/index.js', '// fake extension\n');
put('User Avatars/1700000000000-a.png', tinyPng(10, 20, 30));

// ── 照酒馆的方式流式打包 ──
const outFile = path.join(root, 'test/fixtures/tavern-backup-sample.zip');
const archive = archiver('zip');
const ws = fs.createWriteStream(outFile);
archive.pipe(ws);
archive.glob('**/*', { cwd: dir, follow: false, stat: true, dot: true });
await new Promise((res, rej) => { ws.on('close', res); archive.on('error', rej); archive.finalize(); });
fs.rmSync(dir, { recursive: true, force: true });
console.log(`已生成 ${outFile}（${fs.statSync(outFile).size} 字节）`);
