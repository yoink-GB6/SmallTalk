// 打包脚本：把 SmallTalk 做成"纯静态网页"，可以原样上传到 Cloudflare Pages / GitHub Pages 这类静态托管。
// 用法：node scripts/pack-web.mjs                 产物：dist/web/（一个目录，不压缩）
//       node scripts/pack-web.mjs --out <目录>    产物放到别处（必须仍在 dist/ 里；浏览器测试用它打两个不同的包）
// 这个脚本【只在本地生成目录】：不上传、不调用任何部署命令。发布是对外的动作，每次都要用户自己决定。
//
// 网页版和压缩包版是同一份页面代码。差别只在"谁去请求模型、key 放哪"：
//   压缩包版：页面 → 本地 server.mjs（/api/...）→ 上游接口，key 在服务端；
//   网页版：  没有 /api，页面自己请求上游接口，接口列表和 key 存在浏览器的 IndexedDB 里。
// 页面启动时探一次 /api/health 自己判断是哪种（见 src/llm.js 文件头），所以这里不用改任何代码，只是挑文件。
//
// 打包就四步：
//   1. 按白名单挑出页面需要的文件（和压缩包版共用 pack-common.mjs 里的白名单，只是不要本地服务那部分）；
//   2. 写一个 _headers 文件（Cloudflare Pages 的响应头配置），让前端卡 iframe 能加载图标字体；
//   3. 生成离线缓存脚本 sw.js（"添加到主屏幕"后断网也能打开；清单和版本号由产物内容算出，见 sw-build.mjs）；
//   4. 检查一遍：产物里不能有服务端代码、测试、用户的卡和预设、说明文档。
//
// 关于 CSP（内容安全策略）：先【不加】。前端卡会从任意 CDN 加载脚本，而 srcdoc iframe 继承父页面的 CSP，
// 贸然加一条会把很多卡弄坏。以后要加，得先想清楚怎么给卡单独放行。

import fs from 'node:fs';
import path from 'node:path';
import { DIST, PAGE_FILES, PAGE_DIRS, assertInsideDist, copyWhitelist, countFiles } from './pack-common.mjs';
import { writeSw } from './sw-build.mjs';

// 输出目录：默认 dist/web；--out 可以换（相对当前目录解析）。下面第 1 步会先断言它在 dist/ 里再清空
const outArg = process.argv.indexOf('--out');
if (outArg !== -1 && !process.argv[outArg + 1]) throw new Error('--out 后面要跟一个目录');
const OUT = outArg === -1 ? path.join(DIST, 'web') : path.resolve(process.argv[outArg + 1]);

// 第 1 步：清空并重建 dist/web（先断言它确实在 dist/ 里，再删）
fs.mkdirSync(DIST, { recursive: true });
assertInsideDist(OUT);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 第 2 步：按白名单复制。目录里的 .md 一律不要（只有 vendor/README.md 例外：它记着第三方库的来源和许可证，随库一起发布）。
copyWhitelist(OUT, {
  files: PAGE_FILES,
  dirs: PAGE_DIRS,
  filter: (rel) => !rel.toLowerCase().endsWith('.md') || rel === 'vendor/README.md',
});

// 第 3 步：_headers（Cloudflare Pages 的格式：一行路径，下面缩进的若干行"头: 值"）。
// 为什么要它：前端卡跑在 sandbox iframe 里（没有 allow-same-origin），origin 是 null。Font Awesome 的 @font-face
// 按跨源规则加载字体，响应里没有 Access-Control-Allow-Origin 时浏览器不肯用，图标就成了方块。
// 本地版是 server.mjs 给 vendor/ 下的字体开的例外（isVendorFont）；网页版没有服务端，就靠托管平台加这个头。
// 只放字体所在的目录：这些是公开的开源字体（SIL OFL），谁读到都无所谓。页面源码和别的文件不加这个头。
// 注意：GitHub Pages 不认 _headers（不能自定义响应头），挂在那上面时图标字体会加载失败，其它功能不受影响。
const headers = [
  '# Cloudflare Pages 的响应头配置（由 scripts/pack-web.mjs 生成，别手改）。GitHub Pages 不认这个文件。',
  '# 前端卡 iframe 的 origin 是 null，图标字体按跨源规则加载，需要这个头。',
  '/vendor/font-awesome/6.7.2/webfonts/*',
  '  Access-Control-Allow-Origin: *',
  '# 离线缓存脚本：每次都让浏览器回来问一声有没有新版（不然平台的默认缓存可能让"有新版本"晚很久才出现）。',
  '/sw.js',
  '  Cache-Control: no-cache',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, '_headers'), headers, 'utf8');

// 第 3 步半：离线缓存脚本。必须在复制完、写完 _headers 之后做：清单就是此刻产物目录里的全部文件（不含 _headers 和 sw.js 自己），
// 版本号是这些文件内容的哈希。源码在 scripts/sw-template.js；项目根目录不放 sw.js，所以本地版永远装不上它。
const sw = writeSw(OUT);

// 第 4 步：检查。白名单已经挡住了绝大多数东西，这里再兜一层：万一以后有人往 src/ 里放了不该发布的东西，宁可打包失败。
const bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(OUT, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (['server', 'test', 'browser-tests', 'test-char-preset', 'scripts', 'node_modules', '.git'].includes(e.name)) bad.push(rel + '/');
      walk(p);
    } else if (/^server\.m?js$/.test(e.name) || e.name === 'node.exe' || (rel.toLowerCase().endsWith('.md') && rel !== 'vendor/README.md')) {
      bad.push(rel);
    }
  }
})(OUT);
if (bad.length) throw new Error(`产物里出现了不该发布的文件：${bad.join('、')}`);
if (!fs.existsSync(path.join(OUT, 'sw.js')) || !sw.files.includes('index.html')) throw new Error('离线缓存脚本没生成，或清单里没有 index.html');

// 第 5 步：汇报
console.log(`已生成：${OUT}`);
console.log(`包含文件数：${countFiles(OUT)}`);
console.log(`离线缓存：版本 ${sw.version}，清单 ${sw.files.length} 个文件`);
console.log('这只是本地目录，没有上传到任何地方。');
