// 由 favicon.svg 生成 PWA 用的 PNG 图标，输出到 icons/。
//
// 用法：node scripts/make-icons.mjs
// 这是"改了 favicon.svg 才手动跑一次"的工具，不是构建步骤：生成的 PNG 直接留在 icons/ 里随项目走，
// 打包（pack-web / pack-zip）只是原样拷贝它们。零 npm 依赖，所以用无头 Edge 截图把 SVG 变成 PNG。
//
// 四张图为什么各不相同（favicon.svg 里 #bg 是深夜空蓝的圆角方形底，#meteor 是流星本体，脚本按 id 分开处理）：
//   icon-192.png / icon-512.png   原样渲染 favicon：圆角方形底，圆角之外透明。清单里 purpose 为 any，系统按原样显示。
//   icon-maskable-512.png         整张铺满夜空底（把 #bg 的圆角去掉，不透明）+ 流星单独缩到约 0.85 倍
//                                 （实际占画面约 55%）。purpose 为 maskable 的图安卓会裁成圆 / 圆角方，
//                                 只保证中间 80% 的圆内可见，所以四周要留安全区，底色必须铺满。
//   apple-touch-icon.png          180x180，同样铺满、不透明（iOS 会把透明处填成黑色，也自己裁圆角），流星约占 70%。
//   这样 maskable / apple 两张不会出现"圆角方块套在方块里"：底是脚本重新铺的，不是把圆角版缩小贴在纯色上。
//
// 底色：#0b1330（上）到 #26407a（下）的夜空渐变，写在 favicon.svg 里。
//
// ───────── 清单（manifest.webmanifest）为什么这么填（JSON 不能写注释，写在这里）─────────
//   name "Small Talk" / short_name "SmallTalk"：和 <title>、顶栏品牌名一致。
//   display "standalone"：从主屏幕打开时没有浏览器地址栏，像独立应用。
//   start_url "." / scope "."：全部用相对路径，网页版可能挂在子路径（/仓库名/）下，写 "/" 会跑到站点根。
//   icons 的 src 同理是相对路径。
//   background_color #f4f2ee：启动画面的底色，取浅色主题 --bg。
//   theme_color #ffffff：系统标题栏 / 状态栏的颜色，取浅色主题 --panel，因为页面顶栏（#topbar）就是 --panel 色。
//     清单只能写一个 theme_color，没法跟随深色模式；深色的那条放在 index.html 里用 media 区分
//     （深色顶栏 --panel 是 #1f2125），页面打开后以 <meta name="theme-color"> 为准。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge（msedge.exe）'); process.exit(1); }

const svg = fs.readFileSync(path.join(ROOT, 'favicon.svg'), 'utf8');
// [文件名, 边长, 底是否铺满（false = 保留圆角、圆角外透明）, 流星相对 favicon 的缩放]
const JOBS = [
  ['icon-192.png', 192, false, 1],
  ['icon-512.png', 512, false, 1],
  ['icon-maskable-512.png', 512, true, 0.85],
  ['apple-touch-icon.png', 180, true, 1.08],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smalltalk-icons-'));
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, size, full, scale] of JOBS) {
    let art = svg;
    if (full) {
      art = art.replace('rx="14"', 'rx="0"'); // 底铺满：去掉圆角
      // 流星绕画面中心缩放（favicon 里它本来就居中）
      art = art.replace('<g id="meteor">', `<g id="meteor" transform="translate(32 32) scale(${scale}) translate(-32 -32)">`);
      if (!art.includes('scale(')) throw new Error('favicon.svg 里找不到 <g id="meteor">');
    }
    const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
body{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center}
svg{width:${size}px;height:${size}px;display:block}
</style>${art}`;
    const page = path.join(tmp, name + '.html');
    fs.writeFileSync(page, html);
    const out = path.join(OUT, name);
    // 老式无头模式（--headless）截图时 --window-size 就是输出尺寸，透明底也认 --default-background-color
    const r = spawnSync(EDGE, ['--headless', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${out}`, 'file:///' + page.replace(/\\/g, '/')],
      { stdio: 'ignore', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(out)) { console.error('出图失败：' + name); process.exitCode = 1; continue; }
    const b = fs.readFileSync(out);
    console.log(`${name}  ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}  colorType=${b[25]}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
