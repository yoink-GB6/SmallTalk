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

/** @typedef {{id: string, name: string}} ThemeInfo */

/** @type {ThemeInfo[]} 第一项必须是默认主题 */
export const THEMES = [
    { id: 'default', name: '默认（跟随系统）' },
];

export const DEFAULT_THEME = 'default';
export const THEME_STORAGE_KEY = 'smalltalk.theme';

/** id 在清单里就原样返回，否则当默认 */
export const themeOrDefault = id => (THEMES.some(t => t.id === id) ? id : DEFAULT_THEME);
