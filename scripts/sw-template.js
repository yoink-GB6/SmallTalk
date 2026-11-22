// SmallTalk 网页版的离线缓存脚本（service worker）。
// ★ 这是模板：scripts/pack-web.mjs 打包时把下面两个占位符换成真实的文件清单和版本号，写成产物里的 sw.js。
//   项目根目录没有 sw.js，所以本地版（node server.mjs）请求 sw.js 是 404，永远装不上——离线缓存只属于网页版。
//
// 策略：「整版缓存、缓存优先」。
//   - 安装时把这一版的【全部】文件一次取齐，放进名为 smalltalk-<版本号> 的缓存；少一个就整个安装失败，下次再试。
//   - 之后页面要的文件一律从这份缓存里回。为什么不"有网就走网络"：页面有懒加载的模块（比如 llm-direct.js），
//     如果一半来自旧缓存、一半来自新上传的站点，新旧代码混在一起可能直接跑不起来。整版缓存保证任何时候拿到的都是同一版。
//   - 站点更新后，浏览器发现 sw.js 变了（版本号不同），新的一版在后台装好、进入"等待"；页面提示"有新版本"，
//     用户点了才切换（页面发 skip-waiting → 新版接管 → 所有标签页重载）。所以这里【不】自动 skipWaiting。
//   - 运行时不往缓存里加任何东西，缓存里永远只有安装时那份清单。
//
// 安全底线：发给模型接口的请求带着用户的 API key，而且都是跨源的。这个脚本对跨源请求【完全不经手】
// （不调用 respondWith，浏览器照常直接发），所以 key 不会进缓存，也不会被这里看到内容。
// /api/health（页面用它判断是网页版还是本地版）也不在清单里，同样原样放行，保证每次都真的问到网络。

const VERSION = '@@VERSION@@';
const FILES = /*@@FILES@@*/[];
const CACHE_PREFIX = 'smalltalk-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const FILE_SET = new Set(FILES);

/**
 * 纯函数：这个请求该不该由离线缓存来回？该 → 返回它对应清单里的哪个文件（相对路径）；不该 → null。
 * 只有同时满足这些才管：GET；和 scope 同源；路径在 scope 下面；去掉 scope 前缀和查询串后正好是清单里的文件。
 * scope 根（'./'，以及带查询串的 './?backend=direct'）算 index.html。
 * 地址全按 scope 算，所以挂在子路径（https://x/sub/）下也对。
 * @param {string} method   请求方法
 * @param {string} url      请求的完整地址
 * @param {string} scope    缓存脚本的 scope（以 / 结尾的完整地址）
 * @param {Set<string>} fileSet 清单
 * @returns {string|null}
 */
function routeFor(method, url, scope, fileSet) {
  if (method !== 'GET') return null;
  let u, s;
  try { u = new URL(url); s = new URL(scope); } catch { return null; }
  if (u.origin !== s.origin) return null;               // 跨源（比如模型接口）：绝不经手
  if (!u.pathname.startsWith(s.pathname)) return null;  // scope 之外（比如根站点上的 /api/health）
  // URL 解析时已经把 /a/../b 这类点段处理掉了，所以 ../ 跳不出 scope。
  // 剩下的部分按段解码（清单里存的是解码后的文件名），但解码后出现 / \ . .. 的段一律不认：
  // 防止 %2F、%2e%2e 这类编码字符拼出清单之外的东西。
  const rest = u.pathname.slice(s.pathname.length);
  if (rest === '') return fileSet.has('index.html') ? 'index.html' : null;
  const parts = [];
  for (const seg of rest.split('/')) {
    let d;
    try { d = decodeURIComponent(seg); } catch { return null; }
    if (d === '' || d === '.' || d === '..' || /[\/\\]/.test(d)) return null;   // 空段 = 以 / 结尾的目录或 //，也不认
    parts.push(d);
  }
  const rel = parts.join('/');
  return fileSet.has(rel) ? rel : null;
}

/** 清单里某个文件在缓存里用的键（完整地址）。安装和读取都用它，两边一定对得上 */
function cacheKey(rel) { return new URL(rel, self.registration.scope).href; }

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 全部并行取。cache: 'reload' = 绕过浏览器自己的 HTTP 缓存，确保取到的是站点上现在这一版，而不是旧的缓存副本。
    await Promise.all(FILES.map(async (rel) => {
      const res = await fetch(new Request(cacheKey(rel), { cache: 'reload', credentials: 'same-origin' }));
      if (!res.ok) throw new Error(`离线缓存：取 ${rel} 失败（HTTP ${res.status}）`);
      // 有的托管平台会把 /index.html 重定向到 /（Cloudflare Pages 的"漂亮地址"）。
      // 重定向得来的响应不能拿去回答页面导航（浏览器会拒绝），所以重新包一层，去掉"重定向过"的标记。
      const clean = res.redirected
        ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
        : res;
      await cache.put(cacheKey(rel), clean);
    }));
    // 任何一个失败 → 上面抛错 → 这次安装失败，浏览器丢掉这个新版本，下次打开页面时再试。
    // 失败时把这次写了一半的缓存删掉，别留垃圾
  })().catch(async (e) => { await caches.delete(CACHE_NAME); throw e; }));
  // 注意：这里故意不调 self.skipWaiting()。有旧版在用时，新版装好后就等着，由用户在页面上点"更新"。
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 新版接管了：旧版的缓存没用了，删掉（只删自己的 smalltalk- 前缀，别的东西不碰）
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    // 让已经打开的页面立刻归这一版管（第一次安装时，打开着的那个页面不用刷新就能离线）。
    // 这会让页面收到一次 controllerchange：页面那边（src/pwa.js）认得出这是"第一次接管"，不会因此重载。
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const rel = routeFor(req.method, req.url, self.registration.scope, FILE_SET);
  if (rel === null) return;   // 不归我们管：不调用 respondWith，浏览器照常走网络（跨源 / 非 GET / /api/health / 清单外）
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey(rel));
    // 正常情况下一定命中（安装时全取齐了）；万一缓存被浏览器清掉了一部分，退回网络，至少别让页面打不开
    return hit || fetch(req);
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'skip-waiting') self.skipWaiting();   // 页面上用户点了"更新到新版本"
  else if (msg.type === 'version') {
    // 页面问"你是哪一版"：有 MessageChannel 的端口就从端口回，否则回给发消息的页面
    const reply = { type: 'version', version: VERSION, files: FILES.length };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});
