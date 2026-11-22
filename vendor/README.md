# vendor/：本地第三方库

页面和前端卡 iframe 用到的库都放在这里，不再从 CDN 加载。原因：离线也能用，方便之后打包成压缩包 / exe，
也避免 CDN 被墙、改版或下架时页面直接坏掉。版本固定，不要随手升级（升级前先确认酒馆助手用的是同一版本）。

许可证一栏只抄各文件头部的版权注释；文件头里没有的写"见上游"，没有去猜。

| 库 | 版本 | 本地路径 | 原始下载地址 | 许可证 | 谁在用 |
|---|---|---|---|---|---|
| Showdown | 2.1.0 | `showdown/2.1.0/showdown.min.js` | https://cdnjs.cloudflare.com/ajax/libs/showdown/2.1.0/showdown.min.js | 见上游（文件头无声明） | 主页面（`index.html`）：Markdown 渲染 |
| DOMPurify | 3.2.4 | `dompurify/3.2.4/purify.min.js` | https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js | Apache 2.0 与 MPL 2.0 双许可（文件头） | 主页面：消息 HTML 消毒 |
| jQuery | 3.7.1 | `jquery/3.7.1/jquery.min.js` | https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js | 见文件头 `jquery.org/license`（OpenJS Foundation） | 前端卡 iframe |
| Vue | 3.5.13 | `vue/3.5.13/vue.global.prod.min.js` | https://cdnjs.cloudflare.com/ajax/libs/vue/3.5.13/vue.global.prod.min.js | 见上游（文件头无声明） | 前端卡 iframe |
| Lodash | 4.17.21 | `lodash/4.17.21/lodash.min.js` | https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js | MIT（文件头） | 前端卡 iframe（卡代码用到 `_` 时才加载） |
| Tailwind CSS（浏览器版） | 4.1.12 | `tailwindcss-browser/4.1.12/index.global.js` | https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.12/dist/index.global.js | MIT（文件内嵌的输出横幅） | 前端卡 iframe |
| Font Awesome Free | 6.7.2 | `font-awesome/6.7.2/css/all.min.css` 和 `webfonts/`（woff2 + ttf 共 8 个） | https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/ （css 与 webfonts 目录） | 图标 CC BY 4.0，字体 SIL OFL 1.1，代码 MIT（文件头） | 前端卡 iframe |

## 前端卡 iframe 怎么加载到字体

iframe 是 srcdoc + 没有 `allow-same-origin` 的 sandbox，所以它的 origin 是 `null`。Font Awesome 的 `@font-face`
按跨源规则加载，请求会带 `Origin: null`；而 `server.mjs` 的 Host/Origin 校验（有意的）只放行本机 origin。
脚本和样式表不受影响（普通 `<script>` / `<link>` 不是 CORS 请求，不带 Origin），只有字体会被拦。

所以 `server.mjs` 给这道校验开了**唯一一个很窄的例外**（函数 `isVendorFont`）：同时满足
GET/HEAD、`Host` 是本机、`Origin` 恰好是 `null`、请求的是本目录下真实存在的 `.woff2` / `.woff` / `.ttf` 文件
（按解开符号链接后的真实路径判断）时才放行，并且只给这种响应加 `Access-Control-Allow-Origin: *`。
这里的字体都是公开的开源字体，谁读到都无所谓；`/api/*`、POST、其它静态文件（包括本目录里的 js / css）对 `Origin: null` 仍然 403。
测试见 `test/font-origin.test.mjs`。往这里放新字体时，文件名只能用字母、数字、`_`、`-`、`.`，扩展名小写，否则不会命中例外。
