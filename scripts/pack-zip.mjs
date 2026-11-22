// 打包脚本：把 SmallTalk 做成"解压、双击即用"的 Windows 压缩包。
// 用法：node scripts/pack-zip.mjs        产物：dist/smalltalk-win-x64.zip
//
// 打包到底是什么？就是三件事：
//   1. 挑出运行必需的文件（白名单），摆成目标目录结构；
//   2. 把"运行环境"（node.exe）一起放进去，对方电脑就不用装 Node；
//   3. 写一个启动脚本，双击就能跑；最后压成一个 zip。
// 零依赖：压缩交给系统自带的 tar.exe（Windows 10+ 自带）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DIST, PAGE_FILES, PAGE_DIRS, SERVER_FILES, SERVER_DIRS, assertInsideDist, copyWhitelist, countFiles } from './pack-common.mjs';

const STAGE = path.join(DIST, 'smalltalk');          // 压缩包里的顶层文件夹就叫 smalltalk
const ZIP = path.join(DIST, 'smalltalk-win-x64.zip');

// ── 白名单：只有这些会进包（页面 + 本地服务）。白名单写在 pack-common.mjs，和网页版的打包脚本共用。
// 用白名单而不是"全拷再删"，因为以后项目里新增的东西（测试、笔记、个人卡）默认不会被误带出去。
const FILES = [...PAGE_FILES, ...SERVER_FILES];
const DIRS = [...SERVER_DIRS, ...PAGE_DIRS];

// 第 1 步：清空并重建 dist/smalltalk（每次从零开始，避免上次的残留混进来）
fs.mkdirSync(DIST, { recursive: true });
assertInsideDist(STAGE);
fs.rmSync(STAGE, { recursive: true, force: true });
assertInsideDist(ZIP);
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 第 2 步：按白名单复制应用文件，保持相对路径
copyWhitelist(STAGE, { files: FILES, dirs: DIRS });

// 第 3 步：放进 node.exe。这就是"自带运行环境"：
// 对方电脑没装 Node 也没关系，启动脚本直接用包里这份 node.exe 跑 server.mjs。
fs.copyFileSync(process.execPath, path.join(STAGE, 'node.exe'));

// 第 4 步：启动脚本。只用 ASCII（cmd 按系统代码页读文件，中文内容会乱码），换行必须是 CRLF。
const CMD_NAME = '启动 SmallTalk.cmd'; // 文件名是 Unicode，由压缩工具和解压工具处理；内容保持 ASCII
const cmd = [
  '@echo off',
  'rem Go to the folder this script lives in, so relative paths work.',
  'cd /d "%~dp0"',
  'title SmallTalk',
  // 必须写明 "%~dp0node.exe"（%~dp0 = 这个脚本所在的文件夹），不能只写 node.exe：
  // 只写名字时 cmd 通常会先在当前目录找，但系统设了 NoDefaultCurrentDirectoryInExePath 时会跳过当前目录、
  // 直接去 PATH 上找——那样用到的就是对方电脑上装的 Node（没装就启动失败），而不是包里这份。实测踩到过。
  '"%~dp0node.exe" server.mjs --open',
  'rem If the server exited with an error, keep the window open so the message can be read.',
  'if errorlevel 1 pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(STAGE, CMD_NAME), cmd, 'ascii');

// 第 5 步：使用说明。UTF-8 带 BOM（\uFEFF）：记事本靠 BOM 才认得出这是 UTF-8，否则中文会乱码。
const readme = [
  'SmallTalk 使用说明',
  '==================',
  '',
  '【启动】',
  '双击「启动 SmallTalk.cmd」。会弹出一个黑色窗口，随后自动打开浏览器（地址 http://127.0.0.1:5178/）。',
  '',
  '【退出】',
  '关掉那个黑色窗口就是退出。',
  '',
  '【数据存在哪】',
  '- 接口配置（地址、key 等）：%USERPROFILE%\\.smalltalk 文件夹。',
  '- 聊天存档：存在浏览器里，并且和端口 5178 绑定。换端口或换浏览器，看到的存档就不一样。',
  '',
  '【关于接口】',
  '"Claude Code" 接口需要本机装了 Claude Code 才能用。没装的话，请在「接口」页改用 OpenAI 兼容接口。',
  '',
].join('\r\n');
fs.writeFileSync(path.join(STAGE, '使用说明.txt'), '\uFEFF' + readme, 'utf8');

// 第 6 步：压缩。用 Windows 自带的 tar.exe（bsdtar）：
// -a 按扩展名(.zip)自动选格式；-C 先进入 dist，这样 zip 里的顶层就是 smalltalk/。
// 实测：tar.exe 压出的 zip 里中文文件名用 UTF-8 存储，Expand-Archive 和 tar 解压出来都不乱码，所以用它（不引入任何依赖）。
const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const r = spawnSync(tarExe, ['-a', '-c', '-f', ZIP, '-C', DIST, 'smalltalk'], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('tar.exe 压缩失败');

// 第 7 步：汇报
const count = countFiles(STAGE);
const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
console.log(`已生成：${ZIP}`);
console.log(`大小：${mb} MB，包含文件数：${count}`);
