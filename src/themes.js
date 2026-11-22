// 主题清单（纯数据，没有逻辑，也不导入任何模块）。
//
// 一套主题 = style.css 里一段 `:root[data-theme="<id>"] { …覆盖那一批「风格」变量… }`（还可以带自己的深色覆盖）；
// 所有主题共用的只有布局和位置，颜色、圆角、边框、阴影、字体、背景图都是各主题自己的。
// 'default' 是「现在的样子」：<html> 上不设 data-theme，直接用 :root 里的值，浅色 / 深色跟随系统。
//
// 加一个新主题要改三处（别的地方都不用动）：
//   1. 这里加一项 { id, name }；
//   2. style.css 里 :root 之后的「主题」位置加 `:root[data-theme="<id>"] { … }`（骨架示例在那里）；
//   3. 如果主题需要图片 / 字体文件，放进项目并让 scripts/pack-common.mjs 的打包白名单带上它。
//
// 选了哪个存在 localStorage['smalltalk.theme']（「这台设备的界面偏好」，不进 IndexedDB、不进整体备份，登记见 data-inventory.js 末尾）。
// 页面一打开就是对的主题靠 index.html <head> 里的一小段内联脚本（样式表之前设 data-theme，免得闪一下）；
// 那段脚本不导入本模块、不校验 id，所以：值不在这个清单里时，后面 src/ui/theme.js 初始化时会把它当默认并把 data-theme 去掉。

/**
 * @typedef {{src: string, fit: 'corner' | 'width'}} DecoImage
 * @typedef {{id: string, name: string, decoPick?: {cssVar: string, fitAttr: string, images: DecoImage[]}}} ThemeInfo
 * decoPick（可选）：每次打开页面从 images 里随机挑一张，由 src/ui/theme.js 的 initTheme 做；同一次打开期间不换，刷新才重抽。
 *   挑中的那张：路径设成 <html> 上的 CSS 变量 cssVar（值是 `url("…")`），摆法设成 <html> 上的属性 fitAttr（值是 fit）。
 *   样式表里用 `var(<cssVar>, url(兜底图))` 取图、用 `[<fitAttr>="width"]` 之类的选择器换摆法，所以没有 JS / 清单为空时也有图。
 *   fit：'corner' = 贴着面板一角、完整露出的一小幅；'width' = 宽度铺满面板、贴着底边、上面留白的一整幅淡背景（太高时顶部被裁到页签栏下沿）。每种摆法的尺寸 / 位置在 style.css 里。
 *   路径相对页面（index.html 所在目录）写，网页版挂在子路径下也能用；
 *   只许字母、数字、_ - . / 组成的相对路径（theme.js 会再校验一遍），文件要放在 themes/ 下才会被打包、进离线缓存。
 */

/** @type {ThemeInfo[]} 第一项必须是默认主题 */
export const THEMES = [
    { id: 'default', name: '默认（跟随系统）' },
    // 象牙白 + 纯白 + 近黑，一点琥珀金；方正、切角、只留底线；也跟随系统深浅（深色是黑漆底）。素材在 themes/princesse/
    // 深色版右侧面板里的装饰图（鸡尾酒）：每次打开随机一张（浅色版是固定的山茶花，不在这里）。
    // 换图 / 加图：把文件放进 themes/princesse/，命名 cocktail-N.png（纯黑 + 透明底，也可以 .svg），再在下面这个数组里增删一项并选好摆法。
    { id: 'princesse', name: 'Princesse', decoPick: { cssVar: '--pr-deco-pick', fitAttr: 'data-pr-deco-fit', images: [
        { src: 'themes/princesse/cocktail-1.png', fit: 'corner' },   // 马天尼杯 + 冲剂袋：贴左下角
        { src: 'themes/princesse/cocktail-2.png', fit: 'width' },    // 带纵深的一整幅场景（酒单卡片、桌面、两只杯子）：宽度铺满、贴底
    ] } },
];

export const DEFAULT_THEME = 'default';
export const THEME_STORAGE_KEY = 'smalltalk.theme';

/** id 在清单里就原样返回，否则当默认 */
export const themeOrDefault = id => (THEMES.some(t => t.id === id) ? id : DEFAULT_THEME);
