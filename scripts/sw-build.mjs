// 生成网页版离线缓存脚本（产物里的 sw.js）用的纯函数。pack-web.mjs 调用它；单元测试（test/sw.test.mjs）直接测它。
//
// 三件事：
//   listFiles(dir)          产物目录里有哪些文件 → 缓存清单（相对路径、/ 分隔、排序；不含 _headers 和 sw.js 自己）
//   computeVersion(dir, files)  版本号 = sha256(排好序的每个「路径 + 内容」) 的前 12 位十六进制。内容不变 → 版本不变
//   renderSw(template, {files, version})  把清单和版本号填进 scripts/sw-template.js 的占位符
// writeSw(dir) 把三步串起来，写出 <dir>/sw.js（浏览器测试改了产物副本之后也用它重新生成）。
//
// 为什么版本号要跟内容走：浏览器每次打开页面都会去比对 sw.js 有没有变（逐字节比）。
// 文件清单和版本号都写在 sw.js 里，所以【任何一个文件内容变了】→ 版本号变 → sw.js 变 → 浏览器装新版；
// 什么都没变就重新打包一次，sw.js 一字不差，浏览器不会无故提示"有新版本"。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sw-template.js');
/** 不进清单的文件：_headers 是给托管平台看的配置（浏览器请求不到）；sw.js 是脚本自己（浏览器另有一套更新检查，不能缓存它） */
export const EXCLUDE = new Set(['_headers', 'sw.js']);

/** 按 UTF-16 码元比较排序（不用 localeCompare：那个随系统语言变，同一批文件在不同电脑上会排出不同顺序 → 不同版本号） */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 产物目录 → 清单：全部文件的相对路径（/ 分隔），排序，去掉顶层的 _headers 和 sw.js */
export function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return out.filter((rel) => !EXCLUDE.has(rel)).sort(byCodeUnit);
}

/**
 * 版本号：对排好序的清单，依次喂进 sha256「路径、\0、内容长度、\0、内容」。
 * 加分隔和长度是为了不产生歧义（不然 a + bc 和 ab + c 会算出一样的值）。
 * @param {string} dir 产物目录
 * @param {string[]} files 清单（listFiles 的结果；这里会再排一次序，保证和传入顺序无关）
 */
export function computeVersion(dir, files) {
  const hash = crypto.createHash('sha256');
  for (const rel of [...files].sort(byCodeUnit)) {
    const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
    hash.update(rel, 'utf8'); hash.update('\0'); hash.update(String(buf.length)); hash.update('\0'); hash.update(buf);
  }
  return hash.digest('hex').slice(0, 12);
}

/** 把清单和版本号填进模板。用函数做替换值：避免 String.replace 把 $& 这类字符当成特殊写法 */
export function renderSw(template, { files, version }) {
  if (!template.includes("'@@VERSION@@'") || !template.includes('/*@@FILES@@*/[]')) throw new Error('sw-template.js 里找不到占位符');
  return template
    .replace("'@@VERSION@@'", () => JSON.stringify(version))
    .replace('/*@@FILES@@*/[]', () => JSON.stringify(files, null, 2));
}

/** 生成并写出 <dir>/sw.js。返回 {files, version} */
export function writeSw(dir) {
  const files = listFiles(dir);
  const version = computeVersion(dir, files);
  const js = renderSw(fs.readFileSync(TEMPLATE_PATH, 'utf8'), { files, version });
  fs.writeFileSync(path.join(dir, 'sw.js'), js, 'utf8');
  return { files, version };
}
