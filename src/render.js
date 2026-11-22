// 消息渲染：Markdown → 净化后的 HTML（formatMessage），以及把 HTML 放进 DOM、把「前端卡」升级成沙箱 iframe（mountMessage）。
//
// 对照酒馆 1.19.0：
//   public/script.js        messageFormatting（流水线顺序）、reloadMarkdownProcessor（showdown 配置）
//   public/scripts/chats.js encodeStyleTags / decodeStyleTags / addDOMPurifyHooks
//   public/scripts/showdown-underscore.js
//   JS-Slash-Runner         util/is_frontend.ts、panel/render/iframe.ts（createSrcContent / replaceVhInContent）、
//                           iframe/predefine.js、adjust_iframe_height.js、adjust_viewport.js、third_party_message.html
//
// 安全模型：消息文本来自模型和第三方角色卡，一律视为不可信。
//   - 普通美化（正则替换出来的 HTML/CSS）走 DOMPurify + CSS 作用域改写，放在宿主页面里，不允许执行任何脚本。
//   - 前端卡（```html 代码块里的完整网页）放进 sandbox iframe，**绝不**给 allow-same-origin。
//     酒馆助手用的是同源、不加沙箱的 iframe（卡可以直接 window.parent.SillyTavern...），因为它信任卡；
//     我们不信任：真实的卡会从任意 CDN 拉脚本，同源 iframe 等于把宿主页面的 DOM、IndexedDB（聊天记录、卡）
//     和 cookie 全部交给这些脚本。代价是卡对 parent/top 的直接访问会失败，只能走 postMessage RPC（见 frame-stub.js）。
//
// showdown / DOMPurify 由集成方用经典 <script> 标签提前加载（globalThis.showdown / globalThis.DOMPurify），
// 这里只在函数内部惰性访问，所以 Node 里可以 import 本模块来测试纯函数。

import { frameStubMain, BRIDGED_API, LOCAL_API, UNIMPLEMENTED_API } from './frame-stub.js';

// ───────────────────────────── 选项 ─────────────────────────────

const options = {
    // 酒馆默认 forbid_external_media = true：<style> 里含 '://' 的声明被删、外链 <img>/<video>… 被移除。
    // 我们默认允许：主人用的真实卡普遍从图床加载图片。代价：外部主机能看到你的 IP / 访问时间（追踪像素），
    // CSS 也能借 background:url(...) 外连。设为 false 则与酒馆默认行为一致。data: URL（内嵌字体等）总是保留。
    allowExternalMedia: true,
    // iframe 自动高度的上限（px）。超过后 iframe 内部出现滚动条。
    maxFrameHeight: 4000,
    // 酒馆的「自动修复 Markdown」（power_user.auto_fix_generated_markdown，酒馆默认开）。
    // 它会给星号 / 引号个数为奇数的行补一个字符，而且连代码块里也补——前端卡的 JS（比如 `vh * 0.86`）会被改坏。
    // 玩前端卡的人在酒馆里都会把它关掉，所以这里默认关。
    autoFixMarkdown: false,
};

/** @param {{allowExternalMedia?: boolean, maxFrameHeight?: number, autoFixMarkdown?: boolean}} next */
export function setRenderOptions(next) {
    if (next && typeof next.allowExternalMedia === 'boolean') options.allowExternalMedia = next.allowExternalMedia;
    if (next && typeof next.autoFixMarkdown === 'boolean') options.autoFixMarkdown = next.autoFixMarkdown;
    if (next && Number.isFinite(next.maxFrameHeight) && next.maxFrameHeight > 0) options.maxFrameHeight = next.maxFrameHeight;
}

export function getRenderOptions() {
    return { ...options };
}

// ───────────────────────────── formatMessage ─────────────────────────────

/** 酒馆 power-user.js fixMarkdown(text, forDisplay=true)（auto_fix_generated_markdown 默认开启）。 */
export function fixMarkdown(text, forDisplay = true) {
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    const matches = [];
    let match;
    while ((match = format.exec(text)) !== null) {
        matches.push(match);
    }
    let newText = text;
    for (let i = matches.length - 1; i >= 0; i--) {
        const matchText = matches[i][0];
        const replacementText = matchText.replace(/(\*|_)([\t    -   　﻿]+)|([\t    -   　﻿]+)(\*|_)/g, '$1$4');
        newText = newText.slice(0, matches[i].index) + replacementText + newText.slice(matches[i].index + matchText.length);
    }
    if (!forDisplay) return newText;
    const lines = newText.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        for (const char of ['*', '"']) {
            if (line.includes(char) && line.split(char).length % 2 === 0) {
                lines[index] = line.trimEnd() + char;
            }
        }
    }
    return lines.join('\n');
}

/**
 * 酒馆的引号包 <q>：先把标签内的 " 换成 ￾ 保护起来（encode_tags=false 的分支），
 * 然后跳过 <style> 块、代码围栏、行内代码，把各种成对引号包进 <q>。
 */
export function wrapQuotes(mes) {
    mes = mes.replace(/<([^>]+)>/g, (_, contents) => '<' + contents.replace(/"/g, '￾') + '>');
    mes = mes.replace(
        /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim,
        (match, p1, p2, p3, p4, p5, p6) => {
            if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
            if (p2) return `<q>“${p2.slice(1, -1)}”</q>`;
            if (p3) return `<q>«${p3.slice(1, -1)}»</q>`;
            if (p4) return `<q>「${p4.slice(1, -1)}」</q>`;
            if (p5) return `<q>『${p5.slice(1, -1)}』</q>`;
            if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`;
            return match;
        },
    );
    return mes.replace(/￾/g, '"');
}

/**
 * 酒馆 encodeStyleTags：把 <style> 内容 URI 编码进 <custom-style>，让 DOMPurify 不碰它，之后再解码 + 作用域化。
 * 偏差：酒馆只认不带属性的 `<style>`；带属性的 `<style media=…>` 会被 DOMPurify 原样放行而**不做作用域改写**。
 * 我们也接受带属性的写法（属性丢弃），并在 DOMPurify 里禁止裸 <style>，防止漏网。
 */
export function encodeStyleTags(text) {
    return text.replace(/<style(?:\s[^>]*)?>([\s\S]+?)<\/style\s*>/gi, (_, css) => `<custom-style>${encodeURIComponent(css)}</custom-style>`);
}

let converter = null;
function getConverter() {
    if (converter) return converter;
    const showdown = globalThis.showdown;
    if (!showdown) throw new Error('render.js: 需要先加载 showdown（globalThis.showdown）');
    // 与酒馆 reloadMarkdownProcessor 相同；markdownExclusionExt 只在 markdown_escape_strings 非空时生效，默认为空，省略。
    converter = new showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
        extensions: [markdownUnderscoreExt()],
    });
    return converter;
}

/** 酒馆 showdown-underscore.js：单下划线包住的词变 <em>，跳过 <code>/<style>。 */
function markdownUnderscoreExt() {
    return [{
        type: 'output',
        regex: new RegExp('(<code(?:\\s+[^>]*)?>[\\s\\S]*?<\\/code>|<style(?:\\s+[^>]*)?>[\\s\\S]*?<\\/style>)|\\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\\b', 'gi'),
        replace: (match, tagContent, italicContent) => {
            if (tagContent) return match;
            if (italicContent) return '<em>' + italicContent + '</em>';
            return match;
        },
    }];
}

let purifier = null;
function getPurifier() {
    if (purifier) return purifier;
    const DOMPurify = globalThis.DOMPurify;
    if (!DOMPurify) throw new Error('render.js: 需要先加载 DOMPurify（globalThis.DOMPurify）');
    // DOMPurify(window) 返回一个独立实例：钩子只挂在它身上，不污染全局 DOMPurify。
    purifier = DOMPurify(globalThis.window);

    // 酒馆：链接一律新窗口打开。我们只处理 <a>/<area>（<form> 被禁用），并加 noreferrer。
    purifier.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' || node.tagName === 'AREA') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });

    // 酒馆：所有 class 加 custom- 前缀（fa-*、note-*、monospace 除外），让卡的 CSS 碰不到界面自己的 class。
    purifier.addHook('uponSanitizeAttribute', (node, data) => {
        if (data.attrName === 'class' && data.attrValue) {
            data.attrValue = data.attrValue.split(' ').map((v) => {
                if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') return v;
                return 'custom-' + v;
            }).join(' ');
        }
    });

    purifier.addHook('uponSanitizeElement', (node) => {
        const win = globalThis.window;
        // 酒馆：未知元素（比如正则没吃掉的 <status>）里的换行变成 <br>，<pre> 里的除外。
        if (node instanceof win.HTMLUnknownElement) {
            node.innerHTML = node.innerHTML.trim();
            const candidates = [];
            const walker = node.ownerDocument.createTreeWalker(node, win.NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const textNode = walker.currentNode;
                if (!textNode.data.includes('\n')) continue;
                if (textNode.parentElement && textNode.parentElement.closest('pre')) continue;
                candidates.push(textNode);
            }
            for (const textNode of candidates) {
                const parts = textNode.data.split('\n');
                const frag = node.ownerDocument.createDocumentFragment();
                parts.forEach((part, idx) => {
                    if (part.length) frag.appendChild(node.ownerDocument.createTextNode(part));
                    if (idx < parts.length - 1) frag.appendChild(node.ownerDocument.createElement('br'));
                });
                textNode.replaceWith(frag);
            }
        }

        // 酒馆：禁止外部媒体时移除外链的 img/audio/video/source/track/embed/object。
        if (options.allowExternalMedia || !(node instanceof win.Element)) return;
        if (!['AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'EMBED', 'OBJECT', 'IMG'].includes(node.tagName)) return;
        const isExternalUrl = (url) => (url.indexOf('://') > 0 || url.indexOf('//') === 0) && !url.startsWith(win.location.origin);
        const urls = [node.getAttribute('src'), node.getAttribute('data')];
        const srcset = node.getAttribute('srcset');
        if (srcset) urls.push(...srcset.split(',').map((s) => s.trim().split(' ')[0]));
        if (urls.some((u) => u && isExternalUrl(u))) {
            node.remove();
        }
    });
    return purifier;
}

const PURIFY_CONFIG = {
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,
    ADD_TAGS: ['custom-style'],
    // 偏差（比酒馆严）：
    //   style  —— 裸 <style> 必须经过 encode/decode 作用域化，见 encodeStyleTags；
    //   form   —— 美化里的 <form> 点提交会把整个 smalltalk 页面导航走（或提交到外站），内容保留；
    //   action/formaction —— 同上。
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['action', 'formaction'],
};

/**
 * 酒馆 decodeStyleTags：解码 <custom-style>，每条选择器加 `.mes_text ` 前缀、class 加 custom-，丢 @import，
 * 禁止外部媒体时删掉含 '://' 的声明。酒馆用 css 库解析；我们没有依赖，用浏览器自己的 CSSStyleSheet 解析后自己序列化。
 */
export function decodeStyleTags(text, { prefix = '.mes_text ' } = {}) {
    return text.replace(/<custom-style>([\s\S]+?)<\/custom-style>/g, (_, style) => {
        try {
            const css = decodeURIComponent(style).replace(/<br\s*\/?>/g, '');
            return `<style>${escapeStyleText(scopeCssWithBrowser(css, prefix))}</style>`;
        } catch (error) {
            return `CSS ERROR: ${String(error && error.name)}`;
        }
    });
}

/**
 * 放进 <style> 元素之前的最后一道：`</` 一律写成 `<\/`。
 * 否则 `content:"</style><img src=x onerror=…>"` 会在 innerHTML 时提前结束 <style>（HTML 解析器只认 `</style`），
 * 后面的标签被当成 HTML 执行。在 CSS 字符串里 `\/` 就是 `/`；字符串外合法的 CSS 不会出现 `</`
 * （单独的 `<` 可以出现在 @media (width < 600px) 里，所以不能整体转义 `<`）。
 */
export function escapeStyleText(css) {
    return css.replace(/<\//g, '<\\/');
}

function scopeCssWithBrowser(cssText, prefix) {
    const win = globalThis.window;
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(cssText); // replaceSync 不处理 @import（直接忽略），正好等于酒馆的「丢弃 import」
    return serializeRules(sheet.cssRules, false, prefix, win);
}

function filterExternal(style) {
    if (options.allowExternalMedia || !style) return;
    const drop = [];
    for (let i = 0; i < style.length; i++) {
        const name = style[i];
        if (style.getPropertyValue(name).includes('://')) drop.push(name);
    }
    drop.forEach((name) => style.removeProperty(name));
}

function serializeRules(rules, nestedInStyle, prefix, win) {
    let out = '';
    for (const rule of Array.from(rules)) {
        if (rule instanceof win.CSSStyleRule) {
            filterExternal(rule.style);
            // CSS 嵌套：内层规则相对外层，只改 class，不再加前缀
            const selector = nestedInStyle ? rewriteClasses(rule.selectorText) : scopeSelector(rule.selectorText, prefix);
            const children = rule.cssRules && rule.cssRules.length ? serializeRules(rule.cssRules, true, prefix, win) : '';
            out += `${selector}{${rule.style.cssText}${children}}`;
        } else if (win.CSSNestedDeclarations && rule instanceof win.CSSNestedDeclarations) {
            filterExternal(rule.style);
            out += rule.style.cssText;
        } else if (rule instanceof win.CSSKeyframesRule) {
            // keyframe 选择器（from / 50%）不加前缀；动画名是全局的，这里和酒馆一样不处理
            for (const kf of Array.from(rule.cssRules)) filterExternal(kf.style);
            out += rule.cssText;
        } else if (rule instanceof win.CSSFontFaceRule) {
            // 保留：真实卡常用 url(data:font/woff2;base64,...) 内嵌字体
            filterExternal(rule.style);
            out += rule.cssText;
        } else if (rule instanceof win.CSSImportRule || (win.CSSNamespaceRule && rule instanceof win.CSSNamespaceRule) ||
            (win.CSSPageRule && rule instanceof win.CSSPageRule)) {
            // 丢弃
        } else if (win.CSSGroupingRule && rule instanceof win.CSSGroupingRule) {
            // @media / @supports / @container / @layer {…} / @scope / @starting-style：保留条件头，递归处理内部
            const text = rule.cssText;
            const header = text.slice(0, text.indexOf('{')).trim();
            out += `${header}{${serializeRules(rule.cssRules, nestedInStyle, prefix, win)}}`;
        } else if ((win.CSSLayerStatementRule && rule instanceof win.CSSLayerStatementRule) ||
            (win.CSSPropertyRule && rule instanceof win.CSSPropertyRule) ||
            (win.CSSCounterStyleRule && rule instanceof win.CSSCounterStyleRule) ||
            (win.CSSFontFeatureValuesRule && rule instanceof win.CSSFontFeatureValuesRule)) {
            out += rule.cssText;
        }
        // 其他未知规则丢弃
    }
    return out;
}

/**
 * 把一段已经跑完显示正则的消息文本变成净化后的 HTML。流水线对应酒馆 messageFormatting：
 *   fixMarkdown → 引号包 <q> → \begin{align*} 替换 → showdown → trim → <code> 内 &amp; 还原
 *   → encodeStyleTags → DOMPurify → decodeStyleTags(.mes_text )
 * 省略的步骤：第 0 楼宏替换、prompt bias 剥离、显示正则（调用方已做）、MessageFormatter 扩展钩子、
 * encode_tags（默认关）、推理前后缀保护、allow_name2_display 名字前缀剥离（我们不知道角色名）、
 * <code> 内换行的 \u0000 来回替换（中间没有步骤，在酒馆里也是空操作）。
 * @param {string} text
 * @returns {string}
 */
export function formatMessage(text) {
    if (!text) return '';
    let mes = String(text);
    if (options.autoFixMarkdown) mes = fixMarkdown(mes, true);
    mes = wrapQuotes(mes);
    // 与酒馆完全相同的写法：replaceAll 的替换串里 '$$' 表示一个 '$'
    mes = mes.replaceAll('\\begin{align*}', '$$');
    mes = mes.replaceAll('\\end{align*}', '$$');
    mes = getConverter().makeHtml(mes);
    mes = mes.trim();
    mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => match.replace(/&amp;/g, '&'));
    mes = encodeStyleTags(mes);
    mes = getPurifier().sanitize(mes, PURIFY_CONFIG);
    mes = decodeStyleTags(mes, { prefix: '.mes_text ' });
    return mes;
}

// ───────────────────────────── CSS 选择器改写（纯函数） ─────────────────────────────

// 参数本身是选择器的伪类：里面的 class 也要改写
const SELECTOR_PSEUDOS = new Set(['is', 'not', 'where', 'has', 'matches', 'any', '-webkit-any', '-moz-any',
    'nth-child', 'nth-last-child', 'host', 'host-context', 'slotted', 'cue', 'current', 'past', 'future']);

function isIdentStart(ch) {
    return !!ch && (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127 || ch === '\\');
}

/** 从 i 读一个 CSS 标识符（含转义），返回结束位置。 */
function readIdent(s, i) {
    while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') {
            const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(s.slice(i + 1));
            i += hex ? 1 + hex[0].length : 2;
        } else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) {
            i++;
        } else {
            break;
        }
    }
    return i;
}

/** 从 i（指向开引号）读到配对的闭引号之后。 */
function skipString(s, i) {
    const q = s[i];
    i++;
    while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1;
    return i + 1;
}

/** 从 i（指向开括号）读到配对的闭括号之后，跳过字符串和 []。 */
function skipBlock(s, i, open, close) {
    let depth = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") { i = skipString(s, i); continue; }
        if (ch === '\\') { i += 2; continue; }
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) return i + 1; }
        i++;
    }
    return i;
}

/** 按顶层逗号切分（忽略括号、[]、字符串里的逗号）。 */
export function splitSelectorList(sel) {
    const parts = [];
    let start = 0;
    let i = 0;
    while (i < sel.length) {
        const ch = sel[i];
        if (ch === '"' || ch === "'") i = skipString(sel, i);
        else if (ch === '\\') i += 2;
        else if (ch === '(') i = skipBlock(sel, i, '(', ')');
        else if (ch === '[') i = skipBlock(sel, i, '[', ']');
        else if (ch === ',') { parts.push(sel.slice(start, i)); start = ++i; }
        else i++;
    }
    parts.push(sel.slice(start));
    return parts;
}

/**
 * 把选择器里每个 `.cls` 改成 `.custom-cls`（已经是 custom- 开头的不动，与酒馆一致），
 * 递归进入 :is/:not/:has/:where 等的参数；跳过字符串、属性选择器 [...]、转义字符。
 */
export function rewriteClasses(sel) {
    let out = '';
    let i = 0;
    while (i < sel.length) {
        const ch = sel[i];
        if (ch === '"' || ch === "'") {
            const end = skipString(sel, i);
            out += sel.slice(i, end); i = end;
        } else if (ch === '\\') {
            out += sel.slice(i, i + 2); i += 2;
        } else if (ch === '[') {
            const end = skipBlock(sel, i, '[', ']');
            out += sel.slice(i, end); i = end;
        } else if (ch === '.' && (isIdentStart(sel[i + 1]) || (sel[i + 1] === '-' && (isIdentStart(sel[i + 2]) || sel[i + 2] === '-')))) {
            const end = readIdent(sel, i + 1);
            const name = sel.slice(i + 1, end);
            out += name.startsWith('custom-') ? '.' + name : '.custom-' + name;
            i = end;
        } else if (ch === ':') {
            let j = i + 1;
            if (sel[j] === ':') j++;
            const end = readIdent(sel, j);
            const name = sel.slice(j, end).toLowerCase();
            out += sel.slice(i, end);
            i = end;
            if (sel[i] === '(') {
                const close = skipBlock(sel, i, '(', ')');
                const inner = sel.slice(i + 1, close - 1);
                out += '(' + (SELECTOR_PSEUDOS.has(name) ? rewriteClasses(inner) : inner) + ')';
                i = close;
            }
        } else if (ch === '(') {
            const close = skipBlock(sel, i, '(', ')');
            out += sel.slice(i, close); i = close;
        } else {
            out += ch; i++;
        }
    }
    return out;
}

/**
 * 酒馆 decodeStyleTags 的选择器处理：逗号列表里每一项前面加 prefix（默认 `.mes_text `），并改写 class。
 * 和酒馆一样，`:root` / `html` / `body` 不做特殊处理——加前缀后变成 `.mes_text :root`、`.mes_text body`，
 * 什么都匹配不到，等于被中和。
 */
export function scopeSelector(selectorText, prefix = '.mes_text ') {
    return splitSelectorList(String(selectorText))
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => prefix + rewriteClasses(s))
        .join(', ');
}

// ───────────────────────────── 前端卡 / srcdoc（纯函数） ─────────────────────────────

/** 酒馆助手 util/is_frontend.ts */
export function isFrontend(text) {
    return ['html>', '<head>', '<body'].some((tag) => String(text).includes(tag));
}

/** 酒馆助手 panel/render/iframe.ts replaceVhInContent：把 min-height 的 vh 换成 --TH-viewport-height（防止自动高度死循环）。 */
export function replaceVhInContent(content) {
    const hasCssMinVh = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/gi.test(content);
    const hasInlineStyleVh = /style\s*=\s*(["'])[\s\S]*?min-height\s*:\s*[^;]*?\d+(?:\.\d+)?vh[\s\S]*?\1/gi.test(content);
    const hasJsVh = /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?vh)(\2)/gi.test(content) ||
        /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?vh)(\3\s*\))/gi.test(content);
    if (!hasCssMinVh && !hasInlineStyleVh && !hasJsVh) return content;

    const convert = (value) => value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num) => {
        const parsed = parseFloat(num);
        if (!isFinite(parsed)) return match;
        const v = 'var(--TH-viewport-height)';
        return parsed === 100 ? v : `calc(${v} * ${parsed / 100})`;
    });
    content = content.replace(/(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi, (_m, p, v) => p + convert(v));
    content = content.replace(/(style\s*=\s*(["']))([^"'"]*?)(\2)/gi, (match, prefix, _q, styleContent, suffix) => {
        if (!/min-height\s*:\s*[^;]*vh/i.test(styleContent)) return match;
        return prefix + styleContent.replace(/(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi, (_m, a, b) => a + convert(b)) + suffix;
    });
    content = content.replace(/(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi, (match, prefix, _q, val, suffix) =>
        /\b\d+(?:\.\d+)?vh\b/i.test(val) ? prefix + convert(val) + suffix : match);
    content = content.replace(/(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3\s*\))/gi,
        (match, prefix, _q1, _q2, val, suffix) => (/\b\d+(?:\.\d+)?vh\b/i.test(val) ? prefix + convert(val) + suffix : match));
    return content;
}

/**
 * iframe 里预载的便利库（对应酒馆助手 third_party_message.html 的子集），版本固定。集成方可以删减。
 * `when: 'always'` 总是加载；否则是一个正则，卡的代码匹配才加载。
 * 没带：jquery-ui / jquery-ui-touch-punch / vue-router（酒馆助手有）；
 * 多带：lodash —— 酒馆助手的 predefine.js 把父页面的 `_` 给了每个 iframe，很多卡（尤其 MVU 类）直接用 `_`；
 *       我们拿不到父页面的 `_`，只在卡看起来用到 `_.` / `_(` 时从 CDN 加载。
 * Tailwind 用酒馆助手 lib/tailwindcss.min.js 同版本的 @tailwindcss/browser。
 *
 * 库文件都在本地 vendor/ 下（不依赖 CDN，离线可用，来源见 vendor/README.md）。
 * path 是相对于【宿主页面】的地址（不以 / 开头）：网页版可能挂在子路径下（https://用户名.github.io/仓库名/），
 * 以 / 开头的地址会落到站点根上、找不到。生成 srcdoc 时（buildSrcdoc 的 assetBase）把它按宿主页面的地址算成绝对地址再写进去。
 * 为什么不直接写相对地址：srcdoc 文档（about:srcdoc）的相对地址本来也是按父页面的 base URL 解析的，但卡自己的完整文档里
 * 可能带 <base href>，那样相对地址就会跟着卡走；写成绝对地址就不受影响。
 * sandbox 没有 allow-same-origin 只影响 iframe 的 origin（null），不影响它去加载资源。
 * 字体（@font-face）按跨源规则加载，请求会带 Origin: null。server.mjs 的 Origin 校验为此开了一个很窄的例外
 * （只放 GET/HEAD、本机 Host、vendor/ 下真实存在的 .woff2/.woff/.ttf），并给这些响应加 Access-Control-Allow-Origin: *，
 * 所以 Font Awesome 图标能正常显示。其它任何请求（/api/*、页面源码、别的库）对 Origin: null 仍然 403。见 server.mjs 的 isVendorFont。
 * 网页版没有 server.mjs：靠托管平台的响应头（scripts/pack-web.mjs 生成的 _headers）给 vendor/ 下的文件加同样的头。
 */
export const FRAME_LIBS = Object.freeze([
    { name: 'fontawesome', when: 'always', kind: 'css', path: 'vendor/font-awesome/6.7.2/css/all.min.css' },
    { name: 'jquery', when: 'always', kind: 'js', path: 'vendor/jquery/3.7.1/jquery.min.js' },
    { name: 'tailwind', when: 'always', kind: 'js', path: 'vendor/tailwindcss-browser/4.1.12/index.global.js' },
    { name: 'vue', when: 'always', kind: 'js', path: 'vendor/vue/3.5.13/vue.global.prod.min.js' },
    { name: 'lodash', when: /(^|[^\w$.])_\s*[.(]/, kind: 'js', path: 'vendor/lodash/4.17.21/lodash.min.js' },
]);

/** 默认的 assetBase：浏览器里是宿主页面的 base URL；Node 里（单元测试）没有页面，返回 '' = 保留相对地址 */
const defaultAssetBase = () => globalThis.document?.baseURI ?? '';

/** 一个库 → 它的 <link> / <script> 标签。地址按 assetBase 算成绝对地址（算不出来就保留相对地址），并转义成属性值 */
export function frameLibTag(lib, assetBase = defaultAssetBase()) {
    let url = lib.path;
    if (assetBase) { try { url = new URL(lib.path, assetBase).href; } catch { /* 保留相对地址 */ } }
    const attr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return lib.kind === 'css' ? `<link rel="stylesheet" href="${attr}">` : `<script src="${attr}"></script>`;
}

/** 前端卡 iframe 的 sandbox。没有 allow-same-origin（见文件头），也没有 allow-top-navigation / allow-popups-to-escape-sandbox。 */
export const FRAME_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals';

/**
 * iframe 里提供的 API 一览（集成方要实现 bridged 那一组的宿主侧）。
 *   bridged: 调用 → postMessage → host.call(name, args, messageId) → 结果回传。args 形状见每项。
 *   local:   iframe 内自己实现，不经过宿主。
 *   unimplemented: 存在但调用时只记 unimplemented 日志并 resolve(undefined)；TavernHelper 上读任何其他名字也一样。
 *   host:    由 mountMessage 自己发起的 host.call（不是卡调用的）。
 */
export const FRAME_API = Object.freeze({
    bridged: BRIDGED_API,
    local: LOCAL_API,
    unimplemented: UNIMPLEMENTED_API,
    host: Object.freeze([
        { name: 'getContextSnapshot', args: '[]', returns: '可 JSON 化的对象，iframe 里 SillyTavern.getContext() 原样返回它的浅拷贝（挂载时取一次，之后不更新）。建议含 name1, name2, characterId, chatId, chat 等。返回 undefined / 抛错则为 {}' },
    ]),
});

const BRIDGED_NAMES = new Set(BRIDGED_API.map((x) => x.name));

/**
 * 把对象安全地嵌进 <script> 里的 JS 表达式：JSON 之后把 < > & U+2028 U+2029 写成 \uXXXX，
 * 这样任何字符串内容（包括 `</script>`、`<!--`）都无法提前结束脚本元素。
 */
export function embedJson(value) {
    let json;
    try {
        json = JSON.stringify(value);
    } catch {
        json = 'null';
    }
    if (json === undefined) json = 'null';
    return json.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const RESET_STYLE = '<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}</style>';
export const STUB_MARKER = 'data-smalltalk-stub';

/**
 * 酒馆主题变量的别名（定义在 style.css 的「酒馆主题变量的别名」那一组）。
 * iframe 是独立文档，读不到主页面 :root 上的变量，而卡的整页 HTML 里常写 var(--SmartThemeEmColor)。
 * 生成 srcdoc 时把这些变量在主页面上的**当前计算值**抄成一段 :root 规则放进去（只读的外观信息，没有敏感内容）。
 * 放在卡自己的内容之前，所以卡如果自己在 :root 里定义了同名变量，仍以卡的为准。已渲染的 iframe 不会随换主题实时更新。
 */
export const THEME_ALIAS_VARS = [
    '--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeUnderlineColor', '--SmartThemeQuoteColor',
    '--SmartThemeBlurTintColor', '--SmartThemeChatTintColor', '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor',
    '--SmartThemeBorderColor', '--SmartThemeShadowColor', '--SmartThemeBlurStrength',
    '--SmartThemeCheckboxBgColorR', '--SmartThemeCheckboxBgColorG', '--SmartThemeCheckboxBgColorB', '--SmartThemeCheckboxBgColorA',
    '--SmartThemeCheckboxTickColorValue', '--SmartThemeCheckboxTickColor',
    '--mainFontFamily', '--monoFontFamily', '--mainFontSize', '--fontScale', '--blurStrength', '--shadowWidth',
    '--transparent', '--black30a', '--black50a', '--black60a', '--black70a', '--black90a', '--black100',
    '--white20a', '--white30a', '--white50a', '--white60a', '--white70a', '--white100',
    '--grey10', '--grey30', '--grey50', '--grey5020a', '--grey5050a', '--grey70', '--grey75', '--grey30a', '--grey7070a',
    '--fullred', '--crimson70a', '--okGreen70a', '--cobalt30a', '--greyCAIbg', '--ivory', '--golden', '--warning', '--active', '--preferred',
];

/** 读主页面上的别名变量当前值，拼成 `<style>:root{…}</style>`；取不到（没有 DOM）就是空串。 */
export function themeVarsStyle(win = globalThis.window) {
    try {
        const cs = win.getComputedStyle(win.document.documentElement);
        const decls = THEME_ALIAS_VARS.map((n) => [n, cs.getPropertyValue(n).trim()]).filter(([, v]) => v)
            // 值来自我们自己的样式表，不会含 `<`；保险起见仍把 `</` 打断，免得提前结束 <style>
            .map(([n, v]) => `${n}:${v.replace(/<\//g, '<\\/')};`);
        return decls.length ? `<style>:root{${decls.join('')}}</style>` : '';
    } catch { return ''; }
}

/**
 * 生成 iframe 的 srcdoc。对应酒馆助手 createSrcContent，有一处改动：
 * 酒馆助手无论如何都把卡代码塞进自己外壳的 <body>（完整文档会被 HTML 解析器「压平」，卡的 <head> 内容落到 body 里）；
 * 我们对完整文档（<!doctype / <html）改为把 meta + 重置样式 + 桩 + 库注入到卡自己的 <head> 开头（没有 <head> 就放在 <html> 之后），
 * 保留卡的文档结构和 <html lang> 等属性。片段则包进我们自己的完整文档。
 * @param {string} code  卡代码（<pre> 的文本）
 * @param {{messageId: number, frameId: string, frameIndex?: number, context?: any, viewportHeight?: number, maxHeight?: number, assetBase?: string, themeStyle?: string}} opts
 *        assetBase：把 FRAME_LIBS 的相对地址算成绝对地址用的基准，默认是宿主页面的 document.baseURI（见 FRAME_LIBS 的注释）
 */
export function buildSrcdoc(code, { messageId, frameId, frameIndex = 0, context = null, viewportHeight = 0, maxHeight = options.maxFrameHeight, assetBase = defaultAssetBase(), themeStyle = '' }) {
    code = replaceVhInContent(String(code));
    const boot = {
        frameId: String(frameId),
        messageId: Number(messageId),
        frameIndex: Number(frameIndex) || 0,
        context,
        viewportHeight: Number(viewportHeight) || 0,
        maxHeight: Number(maxHeight) || 4000,
        bridged: [...BRIDGED_NAMES],
        unimplemented: [...UNIMPLEMENTED_API],
    };
    const stub = `<script ${STUB_MARKER}>(${frameStubMain.toString()})(${embedJson(boot)});</script>`;
    const libs = FRAME_LIBS.filter((l) => l.when === 'always' || l.when.test(code)).map((l) => frameLibTag(l, assetBase)).join('\n');
    const head = `<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n${themeStyle ? themeStyle + '\n' : ''}${RESET_STYLE}\n${stub}\n${libs}\n`;

    if (isFullDocument(code)) {
        const headTag = /<head(?:\s[^>]*)?>/i.exec(code);
        if (headTag) return insertAt(code, headTag.index + headTag[0].length, '\n' + head);
        const htmlTag = /<html(?:\s[^>]*)?>/i.exec(code);
        if (htmlTag) return insertAt(code, htmlTag.index + htmlTag[0].length, '\n<head>\n' + head + '</head>\n');
        const doctype = /<!doctype[^>]*>/i.exec(code);
        if (doctype) return insertAt(code, doctype.index + doctype[0].length, '\n<head>\n' + head + '</head>\n');
    }
    return `<!DOCTYPE html>\n<html>\n<head>\n${head}</head>\n<body>\n${code}\n</body>\n</html>\n`;
}

function isFullDocument(code) {
    return /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\b/i.test(code) || /<html[\s>]/i.test(code);
}

function insertAt(s, index, text) {
    return s.slice(0, index) + text + s.slice(index);
}

// ───────────────────────────── mountMessage（DOM） ─────────────────────────────

/** frameId → 帧记录；用于事件转发、视口推送、清理 */
const frames = new Map();
/** container → 该容器里所有帧的 dispose 函数 */
const containerFrames = new WeakMap();
let liveMessageListeners = 0;
let resizeListenerInstalled = false;
let resizeScheduled = false;

const LOG_LEVELS = new Set(['call', 'unimplemented', 'error', 'console']);
const HOST_LOG_LIMIT = 500;

function randomToken() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function shortText(value, max = 300) {
    let s;
    try {
        s = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    if (s === undefined) s = String(value);
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function postToFrame(rec, msg) {
    const win = rec.iframe.contentWindow;
    if (!win) return;
    // 目标 origin 只能是 '*'：沙箱 iframe 的 origin 是 opaque 的（序列化为 "null"），没有可以填的值。
    // 这里可以接受：我们发出去的只有这个 iframe 自己请求的结果、它订阅的事件和视口高度——
    // 就算 iframe 已经被卡导航到别的页面，对方拿到的也只是本来就要给这张卡的数据。
    try {
        win.postMessage({ smalltalk: true, frameId: rec.frameId, ...msg }, '*');
    } catch (e) {
        // 结果不能结构化克隆
        if (msg.kind === 'result') {
            win.postMessage({ smalltalk: true, frameId: rec.frameId, kind: 'result', id: msg.id, ok: false,
                error: '宿主返回值无法传进 iframe（不能结构化克隆）：' + String(e && e.message) }, '*');
        }
    }
}

function pruneDisconnected() {
    for (const rec of [...frames.values()]) {
        if (!rec.iframe.isConnected) rec.dispose();
    }
}

function installResizeListener() {
    if (resizeListenerInstalled) return;
    resizeListenerInstalled = true;
    globalThis.window.addEventListener('resize', () => {
        if (resizeScheduled) return;
        resizeScheduled = true;
        globalThis.window.requestAnimationFrame(() => {
            resizeScheduled = false;
            pruneDisconnected();
            const height = globalThis.window.innerHeight;
            for (const rec of frames.values()) postToFrame(rec, { kind: 'viewport', height });
        });
    });
}

/**
 * 宿主 → iframe 推送事件。只发给 eventOn 订阅了这个事件名的 iframe。
 * @param {string} name
 * @param {any[]} [args]  必须可结构化克隆
 * @param {{messageId?: number}} [filter]  只发给某一楼的 iframe
 */
export function emitFrameEvent(name, args = [], filter = {}) {
    pruneDisconnected();
    for (const rec of frames.values()) {
        if (filter.messageId !== undefined && rec.messageId !== filter.messageId) continue;
        if (rec.events.has(name)) postToFrame(rec, { kind: 'event', name, args });
    }
}

/** 调试 / 测试用：当前活着的 iframe 数和 message 监听器数（应当相等）。 */
export function getFrameStats() {
    return { frames: frames.size, listeners: liveMessageListeners };
}

/** 释放容器里所有 iframe 的监听器（mountMessage 再次调用时会自动做）。 */
export function unmountMessage(container) {
    const list = containerFrames.get(container);
    if (list) {
        list.forEach((dispose) => dispose());
        containerFrames.delete(container);
    }
}

/**
 * @param {HTMLElement} container
 * @param {string} html  formatMessage 的输出
 * @param {{messageId: number, host: import('./types.js').FrameHost}} opts
 */
export function mountMessage(container, html, { messageId, host }) {
    unmountMessage(container);
    pruneDisconnected();
    container.innerHTML = html;
    // 偏差（酒馆没有）：让容器成为 position:fixed 后代的包含块并裁剪它们，
    // 卡的 CSS 就没法用 fixed 全屏遮罩盖住整个界面；isolation 把 z-index 限制在容器内。
    if (!container.style.contain) container.style.contain = 'paint';
    if (!container.style.isolation) container.style.isolation = 'isolate';

    const disposers = [];
    let index = 0;
    for (const pre of Array.from(container.querySelectorAll('pre'))) {
        if (pre.closest('.smalltalk-frontend')) continue; // 已被外层前端卡收进「查看源码」
        const code = pre.textContent || '';
        if (!isFrontend(code)) continue;
        disposers.push(upgradePre(pre, code, { messageId, host, frameIndex: index++ }));
    }
    containerFrames.set(container, disposers);
}

function upgradePre(pre, code, { messageId, host, frameIndex }) {
    const doc = pre.ownerDocument;
    const win = doc.defaultView;
    const frameId = randomToken();

    const wrapper = doc.createElement('div');
    wrapper.className = 'smalltalk-frontend';
    const iframe = doc.createElement('iframe');
    iframe.setAttribute('sandbox', FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', '前端卡');
    iframe.className = 'smalltalk-frontend-frame';
    iframe.style.cssText = 'display:block;width:100%;border:0;height:150px;';
    const details = doc.createElement('details');
    details.className = 'smalltalk-frontend-source';
    const summary = doc.createElement('summary');
    summary.textContent = '查看源码';
    details.append(summary);
    pre.replaceWith(wrapper);
    details.append(pre);
    wrapper.append(iframe, details);

    let logCount = 0;
    const log = (level, text) => {
        if (logCount > HOST_LOG_LIMIT) return;
        logCount++;
        if (logCount > HOST_LOG_LIMIT) text = '这个 iframe 的日志太多，后续日志已省略';
        try {
            host.log({ messageId, level, text: String(text).slice(0, 2000) });
        } catch { /* 宿主日志自己出错就算了 */ }
    };

    const ac = new AbortController();
    const rec = {
        frameId, messageId, iframe, events: new Set(), disposed: false,
        dispose() {
            if (rec.disposed) return;
            rec.disposed = true;
            ac.abort();
            liveMessageListeners--;
            frames.delete(frameId);
        },
    };

    const onMessage = (event) => {
        // 两道校验：来源必须是这个 iframe 的窗口（不是它打开的弹窗、不是它里面嵌的 iframe、不是别的卡），
        // 且带着只有这个 iframe 的 srcdoc 里才有的随机 frameId。
        if (event.source !== iframe.contentWindow) return;
        const d = event.data;
        if (!d || typeof d !== 'object' || d.smalltalk !== true || d.frameId !== frameId) return;
        switch (d.kind) {
            case 'call':
                handleCall(rec, d, { host, messageId, log });
                break;
            case 'height': {
                const h = Number(d.height);
                if (Number.isFinite(h) && h > 0) iframe.style.height = Math.min(Math.ceil(h), options.maxFrameHeight) + 'px';
                break;
            }
            case 'log':
                if (LOG_LEVELS.has(d.level)) log(d.level, String(d.text));
                break;
            case 'subscribe':
                if (typeof d.name === 'string') rec.events.add(d.name);
                break;
            case 'unsubscribe':
                if (typeof d.name === 'string') rec.events.delete(d.name);
                break;
        }
    };
    win.addEventListener('message', onMessage, { signal: ac.signal });
    liveMessageListeners++;
    frames.set(frameId, rec);
    installResizeListener();

    // 先拿上下文快照（host.call 可以是同步也可以是异步），再设置 srcdoc。监听器已经先装好，不会漏掉早到的消息。
    Promise.resolve()
        .then(() => host.call('getContextSnapshot', [], messageId))
        .catch(() => null)
        .then((context) => {
            if (rec.disposed) return;
            iframe.srcdoc = buildSrcdoc(code, {
                messageId, frameId, frameIndex, context: context ?? null,
                viewportHeight: win.innerHeight, maxHeight: options.maxFrameHeight,
                themeStyle: themeVarsStyle(win),
            });
        });

    return rec.dispose;
}

async function handleCall(rec, d, { host, messageId, log }) {
    const id = d.id;
    const method = String(d.method);
    const args = Array.isArray(d.args) ? d.args : [];
    const reply = (ok, valueOrError) => {
        if (rec.disposed) return;
        postToFrame(rec, ok ? { kind: 'result', id, ok: true, value: valueOrError }
            : { kind: 'result', id, ok: false, error: valueOrError });
    };
    // 白名单：卡可以发任意方法名，但只有 BRIDGED_API 里的才会到达 host.call。
    if (!BRIDGED_NAMES.has(method)) {
        log('unimplemented', `${method}（不在桥接白名单里）`);
        reply(false, `SmallTalk 不支持 ${method}`);
        return;
    }
    log('call', `${method}(${args.map((a) => shortText(a, 120)).join(', ')})`);

    if (method === 'eventEmit') {
        // 转发给其他订阅了这个事件的 iframe（发送者自己已经在 iframe 里本地分发过了）
        const [name, ...rest] = args;
        for (const other of frames.values()) {
            if (other !== rec && other.events.has(name) && other.iframe.isConnected) {
                postToFrame(other, { kind: 'event', name, args: rest });
            }
        }
        try {
            reply(true, await host.call(method, args, messageId));
        } catch {
            reply(true, undefined);
        }
        return;
    }

    try {
        const value = await host.call(method, args, messageId);
        reply(true, value);
    } catch (err) {
        const text = String((err && err.message) || err);
        log('error', `${method} 失败：${text}`);
        reply(false, text);
    }
}
