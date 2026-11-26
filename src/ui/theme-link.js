// 「允许直接操作页面」（直通模式，ui/script-host.js）的颜色联动：美化脚本改了酒馆的主题变量（--SmartTheme* 等），聊天这一侧跟着变。
//
// 为什么要做：酒馆整个界面都用 --SmartTheme* 画，美化靠改这些变量换配色（比如把背景弄成黑的）。我们的界面用的是自己的变量
//   （--text / --panel / --bot-bg …），style.css 的 :root 里只有单向别名「酒馆变量 = 我们的变量」，脚本改了酒馆变量，我们的界面不会动，
//   于是黑底上留着两块白气泡。反过来写成「我们的变量 = 酒馆变量」会和别名成环，所以用 JS：读计算值，和「我们自己的主题本来给的值」比，
//   脚本改过的那几个，把对应的我们的变量【内联写在聊天一侧的容器上】（#top-bar 顶栏、#sheld 聊天区）。写在容器上而不是 :root，
//   右侧面板（#inspector，不在这两个容器里）天然不受影响——用户定的：右侧面板是我们自己的样式，不跟。
//
// 「脚本改过没有」的判据（每个变量单独判）：
//   - 有别名的那些（别名就是 var(--我们的变量)）：在 <body> 上读酒馆变量的计算值和对应的我们的变量的计算值，不相等 = 被改过。
//     不和「脚本运行前拍下的值」比，是因为我们自己切主题（<html data-theme>、系统深浅）时这两个会一起变：和我们的变量比，
//     切主题永远不会被误判成「脚本改了」；脚本设过的值在切主题后照样和新主题的值不同，照样算改过。
//     在 <body> 上读：<html> 的内联样式、:root / html / body 上的规则（脚本往 <head> 塞的 CSS、给 <html> 加 class 换的配色）都已经算进去；
//     我们写的内联值在 #top-bar / #sheld 上，读不到，所以不会自己和自己比出环来。
//   - --mainFontSize（别名是 calc(var(--fontScale) * 15px)，没有对应的我们的变量）：和开始运行时拍下的值比。我们的主题都不改它，
//     所以切主题不影响这个比较。
//   - 「动了样子」（styled）= 上面任一个【颜色】变量被改过。只改字体 / 字号不算。只有 styled 时才把没设的两种气泡变成透明（用户要的：
//     「让它们透明，或者美化原本有的就用美化自己的」）；没动样子的直通卡（比如只往输入框边挂一个按钮）一样也不写，外观和平时完全一样。
//     只往 <head> 加了样式、给 <html> 加了 class 但没改任何变量的，不算动了样子（挂按钮的脚本也常带一段按钮的 CSS）——
//     这两种变化只是「重新算一遍」的时机：配色可能就是靠 class 切换的 :root 规则换的。
//
// 什么时候重算（防抖，一批变化只算一次）：<html> / <body> 的 class / style / data-theme 变了、<head> 里有增删或 <style> 的文字变了、
//   <body> 的直接子节点有增删（有的脚本把 <style> 挂在 body 下）、外链样式表加载完（load 事件在捕获阶段收）、系统深浅切换。
//   美化自己的设置菜单里换配色，走的也是这几条路，所以会跟着变。我们自己写的只在 #top-bar / #sheld 上，不在被盯的范围里，不会自激。
//
// 撤销：stop() 把写过的内联属性逐个删掉、摘掉 data-theme-linked，页面回到我们自己主题的样子（拆脚本时 script-host 调）。
//
// 映射表在下面 LINKS。没有一一对应、不跟的：--SmartThemeShadowColor / --shadowWidth（酒馆拿它画文字阴影，我们没有文字阴影）、
//   --SmartThemeBlurStrength / --blurStrength（我们没有毛玻璃）、勾选框那几个（我们用浏览器自带的勾选框）、--monoFontFamily（代码字体不随美化变）。
// 这个文件不导入任何兄弟 ui 模块。

/**
 * 酒馆变量 → 我们的变量。
 *   st：酒馆变量；ours：比较用的我们的变量（style.css 里的别名就是 st = var(ours)）；null = 和开始时拍下的值比
 *   set：被改过时内联写上的我们的变量（值 = 酒馆变量的计算值）；prop：另外直接写的 CSS 属性（见下面「为什么还要写属性」）
 *   derived：从 set[0] 派生、在 :root 上就已经算死了的变量——只有在 :root 上它和 set[0] 相等（当前主题就是这么派生的）时才一起写
 *   color：算不算「颜色」（决定 styled）；where：只写在哪个容器上（默认两个都写）
 * 为什么还要写属性：body 上的 color / font 是在 body 上算好再继承下来的，只在容器上改 --text 不会让继承下来的字色变，
 *   所以容器本身的 color / font-family / font-size 要直接写。同理 --control-bg 在 :root 上写成 var(--panel)，已经在 :root 算成了值，
 *   容器上改 --panel 它不跟，所以按 derived 一起写。
 */
export const LINKS = [
    { st: '--SmartThemeBodyColor', ours: '--text', set: ['--text'], prop: 'color', color: true },               // 正文
    { st: '--SmartThemeEmColor', ours: '--dim', set: ['--chat-em'], color: true },                               // 斜体（.mes_text i / em）
    { st: '--SmartThemeUnderlineColor', ours: '--text', set: ['--chat-underline'], color: true },                // 下划线（.mes_text u）
    { st: '--SmartThemeQuoteColor', ours: '--accent', set: ['--chat-quote'], color: true },                      // 引号里的话（.mes_text q）
    { st: '--SmartThemeBlurTintColor', ours: '--panel', set: ['--panel'], derived: ['--control-bg'], color: true },   // 界面底：顶栏、输入区、按钮排
    { st: '--SmartThemeChatTintColor', ours: '--bg', set: ['--bg-chat'], where: ['sheld'], color: true },       // 聊天区底（#chat）
    { st: '--SmartThemeUserMesBlurTintColor', ours: '--user-bg', set: ['--user-bg'], color: true, bubble: true },   // 用户气泡
    { st: '--SmartThemeBotMesBlurTintColor', ours: '--bot-bg', set: ['--bot-bg'], color: true, bubble: true },      // 角色气泡
    { st: '--SmartThemeBorderColor', ours: '--line', set: ['--line'], derived: ['--control-line'], color: true },     // 边框 / 分隔线
    { st: '--mainFontFamily', ours: '--font-chat', set: ['--font-chat', '--font-ui'], prop: 'font-family' },     // 正文字体
    { st: '--mainFontSize', ours: null, set: ['--font-size-base', '--pr-font-size-chat'], prop: 'font-size' },  // 正文字号
];

/** 写在哪些容器上（聊天这一侧）。键是 where 里用的名字 */
const CONTAINERS = { 'top-bar': '#top-bar', sheld: '#sheld' };

let cur = null;

const read = (cs, name) => cs.getPropertyValue(name).trim();

/** 现在应该写成什么：{styled, changed: [酒馆变量名], want: {容器名: Map(属性 → 值)}} */
function compute(base) {
    const body = document.body, root = document.documentElement;
    if (!body) return { styled: false, changed: [], want: {} };
    const cs = getComputedStyle(body), rcs = getComputedStyle(root);
    const changed = new Set();
    const vals = {};
    for (const l of LINKS) {
        const v = read(cs, l.st);
        vals[l.st] = v;
        const ref = l.ours ? read(cs, l.ours) : base[l.st];
        if (v && v !== ref) changed.add(l.st);
    }
    const styled = LINKS.some(l => l.color && changed.has(l.st));
    const want = {};
    for (const k of Object.keys(CONTAINERS)) want[k] = new Map();
    for (const l of LINKS) {
        let v = null;
        if (changed.has(l.st)) v = vals[l.st];
        else if (l.bubble && styled) v = 'transparent';   // 动了样子、却没设这种气泡：透明（见文件头）
        if (v === null) continue;
        const props = [...l.set];
        // 派生变量：当前主题在 :root 上就是从 set[0] 派生的才一起写（默认主题 --control-bg = --panel；Princesse 是透明，不动它）
        for (const d of l.derived ?? []) if (read(rcs, d) === read(rcs, l.set[0])) props.push(d);
        if (l.prop) props.push(l.prop);
        for (const k of l.where ?? Object.keys(CONTAINERS)) for (const p of props) want[k].set(p, v);
    }
    return { styled, changed: [...changed], want };
}

function apply() {
    if (!cur) return;
    cur.timer = null;
    const { styled, changed, want } = compute(cur.base);
    for (const [k, sel] of Object.entries(CONTAINERS)) {
        const el = document.querySelector(sel);
        const had = cur.applied[k] ?? new Map();
        if (!el) { cur.applied[k] = new Map(); continue; }
        const w = want[k];
        for (const p of had.keys()) if (!w.has(p)) el.style.removeProperty(p);
        for (const [p, v] of w) if (had.get(p) !== v) el.style.setProperty(p, v);
        if (!el.style.length) el.removeAttribute('style');
        cur.applied[k] = w;
        // 宽屏下顶栏和右侧页签栏连成一条：顶栏换了底色后，在接缝处画一条竖线（style.css #top-bar[data-theme-linked]）
        el.toggleAttribute('data-theme-linked', styled);
    }
    cur.styled = styled;
    cur.changed = changed;
}

function schedule() {
    if (!cur || cur.timer) return;
    cur.timer = setTimeout(apply, 16);
}

/**
 * 开始联动（script-host 建直通 iframe 时、脚本代码跑起来之前调）。已经在联动就先停掉旧的。
 * 返回 stop；也可以直接调导出的 stopThemeLink()
 */
export function startThemeLink() {
    stopThemeLink();
    const body = document.body;
    const cs = body ? getComputedStyle(body) : null;
    const base = {};
    for (const l of LINKS) if (!l.ours) base[l.st] = cs ? read(cs, l.st) : '';
    const ac = new AbortController();
    const mo = new MutationObserver(schedule);
    const root = document.documentElement;
    mo.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    if (document.head) mo.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    if (body) mo.observe(body, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    // 外链样式表（<link rel=stylesheet>）要加载完才生效：load 不冒泡，在捕获阶段收
    document.addEventListener('load', e => { if (e.target?.tagName === 'LINK' || e.target?.tagName === 'STYLE') schedule(); }, { capture: true, signal: ac.signal });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule, { signal: ac.signal }); } catch { /* ignore */ }
    cur = { base, mo, ac, timer: null, applied: {}, styled: false, changed: [] };
    apply();
    return stopThemeLink;
}

/** 停止联动并撤销写过的一切（见文件头「撤销」） */
export function stopThemeLink() {
    if (!cur) return;
    const c = cur;
    cur = null;
    c.mo.disconnect();
    c.ac.abort();
    if (c.timer) clearTimeout(c.timer);
    for (const [k, sel] of Object.entries(CONTAINERS)) {
        const el = document.querySelector(sel);
        if (!el) continue;
        for (const p of (c.applied[k] ?? new Map()).keys()) el.style.removeProperty(p);
        if (!el.style.length) el.removeAttribute('style');
        el.removeAttribute('data-theme-linked');
    }
}

/** 给测试 / 调试看（scriptSandboxInfo().themeLink） */
export function themeLinkInfo() {
    if (!cur) return { active: false, styled: false, changed: [] };
    const applied = {};
    for (const [k, m] of Object.entries(cur.applied)) applied[k] = Object.fromEntries(m);
    return { active: true, styled: cur.styled, changed: [...cur.changed], applied };
}
