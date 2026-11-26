// 两个打包脚本（pack-zip.mjs 压缩包版、pack-web.mjs 网页版）共用的白名单和小工具。
// 白名单只在这里写一次：以后页面加了新的顶层文件 / 目录，改这里，两种产物都会带上，不会一边加了另一边忘了。
//
// 为什么用白名单而不是"全拷再删"：项目目录里有测试、笔记、用户自己的真实卡和预设（test-char-preset/ 等），
// 以后新增的东西默认【不会】被带出去，只有明确列在这里的才会进产物。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // 项目根
export const DIST = path.join(ROOT, 'dist');

// 页面本身：两种产物都要
// manifest.webmanifest + icons/：PWA（添加到主屏幕）要的清单和图标
// themes/：各主题自带的素材（图片等），按主题分子目录，如 themes/princesse/camellia-line.svg
// img/：酒馆页面自带的几张图（酒馆的样式里写死了 img/xxx 这样的相对地址，比如下拉框的 img/down-arrow.svg）。「允许直接操作页面」的美化脚本
//   按酒馆的 DOM 写 CSS 时会引用到；图是我们自己画的，不是从酒馆拷的
export const PAGE_FILES = ['index.html', 'style.css', 'favicon.svg', 'manifest.webmanifest'];
export const PAGE_DIRS = ['src', 'vendor', 'icons', 'themes', 'img'];
// 本地服务：只有压缩包版要（网页版没有服务端，绝不能带上 server.mjs / server/）
export const SERVER_FILES = ['package.json', 'server.mjs'];
export const SERVER_DIRS = ['server'];

/** 清空目录是危险操作：先断言要删 / 要写的东西确实在项目的 dist/ 里面 */
export function assertInsideDist(p) {
  const rel = path.relative(DIST, path.resolve(p));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作 dist/ 之外的路径：${p}`);
  }
}

/**
 * 按白名单把文件 / 目录从项目根复制到 stage，保持相对路径。
 * @param {string} stage  目标目录（必须在 dist/ 里）
 * @param {{files: string[], dirs: string[], filter?: (rel: string) => boolean}} spec
 *        filter：目录里的每个文件（相对项目根、用 / 分隔的路径）返回 false 就不复制；不给 = 全要
 */
export function copyWhitelist(stage, { files, dirs, filter = () => true }) {
  assertInsideDist(stage);
  for (const f of files) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  for (const d of dirs) {
    fs.cpSync(path.join(ROOT, d), path.join(stage, d), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(ROOT, src).split(path.sep).join('/');
        return fs.statSync(src).isDirectory() || filter(rel);
      },
    });
  }
}

/** 数一下目录里有多少个文件（汇报用） */
export function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}
