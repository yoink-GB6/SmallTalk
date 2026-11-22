// 窄屏下的检查器抽屉：只负责给 <body> 加 / 去 `drawer-open` 这个 class，其余全是 CSS（style.css 末尾）。
// 检查器的 DOM 和宽屏是同一套，没有复制、没有重画。宽屏下 CSS 忽略这个 class，所以不用在变宽时清掉它。
// 开合的按钮就是左上角的标题 #drawer-toggle（一个普通 div）：宽屏下它只是标题，不可点；窄屏下才变成按钮
// （加 role / tabindex / aria-expanded，可键盘聚焦、回车或空格开合；☰ 图标和手型光标在 CSS 里按屏宽加）。
// 本模块不导入任何兄弟 ui 模块，不涉及循环依赖。

const NARROW = '(max-width: 900px)';   // 必须和 style.css 里抽屉块的断点一致

export function initDrawer() {
    const body = document.body;
    const toggle = document.querySelector('#drawer-toggle');
    const mask = document.querySelector('#drawer-mask');
    const mq = matchMedia(NARROW);

    /** 标题按钮的可访问性属性：只在窄屏有；宽屏下它不是按钮，不能带 role / tabindex / aria-expanded */
    const syncToggleAttrs = () => {
        if (mq.matches) {
            toggle.setAttribute('role', 'button');
            toggle.tabIndex = 0;
            toggle.title = '打开 / 收起右侧面板（拼装、世界书、存档…）';
            toggle.setAttribute('aria-expanded', String(body.classList.contains('drawer-open')));
        } else {
            toggle.removeAttribute('role');
            toggle.removeAttribute('tabindex');
            toggle.removeAttribute('title');
            toggle.removeAttribute('aria-expanded');
        }
    };
    const setOpen = on => {
        body.classList.toggle('drawer-open', on);
        syncToggleAttrs();
    };
    // 抽屉和遮罩从顶栏下沿开始（顶栏高度随屏宽变），所以把实际高度量出来交给 CSS
    const measure = () => document.documentElement.style.setProperty('--topbar-h', document.querySelector('#topbar').offsetHeight + 'px');
    measure();
    syncToggleAttrs();
    addEventListener('resize', measure);
    new ResizeObserver(measure).observe(document.querySelector('#topbar'));

    const flip = () => { measure(); setOpen(!body.classList.contains('drawer-open')); };
    toggle.addEventListener('click', () => { if (mq.matches) flip(); });   // 宽屏下点标题什么也不发生
    toggle.addEventListener('keydown', e => {
        if (!mq.matches || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();   // 空格默认会滚动页面
        flip();
    });
    mask.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && body.classList.contains('drawer-open')) setOpen(false); });
    // 项目里有好几处「用代码点页签」（模型选择器的告警、点卡名跳存档页…），统一在这里兜住：
    // 窄屏下点任何页签都保证抽屉是开的。用捕获阶段，不依赖 app.js 里那个处理器的先后。
    document.querySelector('#tabs').addEventListener('click', e => {
        if (mq.matches && e.target.closest('button[data-tab]')) { measure(); setOpen(true); }
    }, true);
    // 宽 ↔ 窄：宽 → 窄时补上按钮属性；窄 → 宽时顺手把开合状态清掉，免得再变窄时抽屉自己弹出来
    mq.addEventListener('change', e => { if (!e.matches) setOpen(false); else syncToggleAttrs(); });
}
