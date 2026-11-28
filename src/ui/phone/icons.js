// 手机壳里用的线条图标（内联 SVG，描边用 currentColor，所以颜色跟着主题的文字色走）。
// 全是自己画的通用图形：不用任何真实应用的图标 / 品牌形状，也不引图标库、不用 emoji。
// 这里的字符串都是写死的常量，不含任何外来内容，所以可以安全地用 innerHTML 放进页面（见 icon()）。

const wrap = (body, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

const ICONS = {
    // 顶栏的手机图标
    phone: wrap('<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M10.6 18.6h2.8"/>'),
    // 六个应用（Clippings 在下面单独一项）：Settings 三根滑杆、Chat 对话气泡、Music 音符、Reading 翻开的书、Meetup 两个并排的人
    settings: wrap('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    chat: wrap('<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.2v-3.2H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z"/><path d="M8 10h8M8 13h5"/>'),
    music: wrap('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
    reading: wrap('<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z"/><path d="M12 6.5v13"/>'),
    meetup: wrap('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.4-3 2.6-5 5.5-5s5.1 2 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.5 14.2c2.4 0 3.8 1.7 4 4.3"/>'),
    // Clippings：一支荧光笔压在一道划线上
    clippings: wrap('<path d="M14.5 4.5l5 5-8 8H6.5v-5z"/><path d="M12.5 6.5l5 5"/><path d="M4 21h16"/>'),
    // 锁屏的假指纹：几圈不闭合的弧
    fingerprint: wrap('<path d="M6.5 9.5a6 6 0 0 1 11 0"/><path d="M5 13a7 7 0 0 1 .3-2.2M19 13c0 3-.6 5.2-1.6 7"/><path d="M8.5 20c.6-1.3 1-3 1-5a2.5 2.5 0 0 1 5 0c0 2.4-.4 4.4-1.2 6"/><path d="M12 13v.5c0 2-.3 3.6-.9 5.2"/><path d="M8.5 11.5A4 4 0 0 1 15.5 11"/>'),
    back: wrap('<path d="M15 5l-7 7 7 7"/>'),
    // Settings 菜单行右边的小箭头
    chevron: wrap('<path d="M9 5l7 7-7 7"/>'),
};

/** 取一个图标，返回装着它的 <span class="ph-ico">（调用方再往里 / 往外挂） */
export function icon(name) {
    const span = document.createElement('span');
    span.className = 'ph-ico';
    span.innerHTML = ICONS[name] ?? '';   // 常量字符串，见文件头
    return span;
}

/** 状态栏的信号：四格，四格都亮 = 在线；没信号时 CSS 把格子压暗、显示斜线（由 .ph-sig 上的 data-online 控制） */
export const SIGNAL_SVG = `<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true" focusable="false"><g fill="currentColor"><rect class="b" x="0" y="8" width="3" height="4" rx=".6"/><rect class="b" x="5" y="5.5" width="3" height="6.5" rx=".6"/><rect class="b" x="10" y="3" width="3" height="9" rx=".6"/><rect class="b" x="15" y="0" width="3" height="12" rx=".6"/></g><path class="slash" d="M1 11.5 17 .5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

/** 状态栏的电池：外框 + 电量块（宽度由 CSS 变量 --lvl 控制）+ 正极小头 */
export const BATTERY_SVG = `<svg viewBox="0 0 26 12" width="26" height="12" aria-hidden="true" focusable="false"><rect x=".7" y=".7" width="21.6" height="10.6" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><rect class="lvl" x="2.4" y="2.4" height="7.2" rx="1.2" fill="currentColor"/><rect x="23.6" y="3.8" width="1.8" height="4.4" rx=".8" fill="currentColor"/></svg>`;
