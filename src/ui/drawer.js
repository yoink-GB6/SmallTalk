// 右侧面板（检查器）的开合，标题 #drawer-toggle 是唯一的开合按钮，两种屏宽两套状态，互不串：
//   · 窄屏（≤900px）：面板是抽屉，状态是 <body> 上的 `drawer-open` class，不记忆，刷新后总是收起。
//   · 宽屏：面板和页面等高地站在右边，状态是 <body> 上的 `panel-collapsed` class（收起时聊天区占满整个宽度）。
//     这是「这台设备的界面偏好」，记在 localStorage（读写都包 try/catch，用不了就当没记），不进我们的存储和备份。
// 两个 class 的外观全在 style.css；检查器的 DOM 和两种屏宽是同一套，没有复制、没有重画。
// 标题在两种屏宽下都是按钮（role / tabindex / aria-expanded，可键盘聚焦、回车或空格开合；☰ 图标和手型光标在 CSS 里）。
// 本模块不导入任何兄弟 ui 模块，不涉及循环依赖。

const NARROW = '(max-width: 900px)';   // 必须和 style.css 里抽屉块的断点一致
const COLLAPSE_KEY = 'smalltalk.panelCollapsed';

const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };
const writeCollapsed = on => { try { if (on) localStorage.setItem(COLLAPSE_KEY, '1'); else localStorage.removeItem(COLLAPSE_KEY); } catch { /* 无痕窗口等：不记就是了 */ } };

let closeDrawerImpl = () => {};
/** 窄屏下收起抽屉（别的模块在「要让聊天区露出来」时用，比如点搜索）；宽屏下什么也不做 */
export function closeDrawer() { closeDrawerImpl(); }

export function initDrawer() {
    const body = document.body;
    const toggle = document.querySelector('#drawer-toggle');
    const mask = document.querySelector('#drawer-mask');
    const mq = matchMedia(NARROW);

    body.classList.toggle('panel-collapsed', readCollapsed());   // 窄屏下这个 class 没有任何样式效果

    /** 标题按钮的可访问性属性和提示：aria-expanded 表示「面板现在是不是展开的」，窄屏看抽屉、宽屏看收起状态 */
    const syncToggleAttrs = () => {
        toggle.setAttribute('role', 'button');
        toggle.tabIndex = 0;
        toggle.title = mq.matches ? '打开 / 收起右侧面板（拼装、世界书、正则…）' : '展开 / 收起右侧面板（拼装、世界书、正则…）';
        toggle.setAttribute('aria-label', toggle.title);   // 顶栏上只剩一个 ☰ 图标（没有文字），读屏靠这句
        const expanded = mq.matches ? body.classList.contains('drawer-open') : !body.classList.contains('panel-collapsed');
        toggle.setAttribute('aria-expanded', String(expanded));
    };
    const setOpen = on => {
        body.classList.toggle('drawer-open', on);
        syncToggleAttrs();
    };
    const setCollapsed = on => {
        body.classList.toggle('panel-collapsed', on);
        writeCollapsed(on);
        syncToggleAttrs();
    };
    closeDrawerImpl = () => { if (mq.matches) setOpen(false); };
    // 抽屉和遮罩从顶栏下沿开始（顶栏高度随屏宽变），所以把实际高度量出来交给 CSS
    const measure = () => document.documentElement.style.setProperty('--topbar-h', document.querySelector('#top-bar').offsetHeight + 'px');
    measure();
    syncToggleAttrs();
    addEventListener('resize', measure);
    new ResizeObserver(measure).observe(document.querySelector('#top-bar'));

    const flip = () => {
        if (mq.matches) { measure(); setOpen(!body.classList.contains('drawer-open')); }
        else setCollapsed(!body.classList.contains('panel-collapsed'));
    };
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();   // 空格默认会滚动页面
        flip();
    });
    mask.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && body.classList.contains('drawer-open')) setOpen(false); });
    // 项目里有好几处「用代码点页签」（模型选择器的告警、点卡名跳存档页…），统一在这里兜住：
    // 窄屏下点任何页签都保证抽屉是开的；宽屏下面板收起着就先展开。用捕获阶段，不依赖 app.js 里那个处理器的先后。
    document.querySelector('#tabs').addEventListener('click', e => {
        if (!e.target.closest('button[data-tab]')) return;
        if (mq.matches) { measure(); setOpen(true); }
        else if (body.classList.contains('panel-collapsed')) setCollapsed(false);
    }, true);
    // 宽 ↔ 窄：宽 → 窄时抽屉总是收起的；窄 → 宽时顺手把抽屉状态清掉，免得再变窄时抽屉自己弹出来。两边都要按新屏宽刷新按钮属性
    mq.addEventListener('change', e => { if (!e.matches) setOpen(false); else syncToggleAttrs(); });
}
