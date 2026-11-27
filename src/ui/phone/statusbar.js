// 手机壳的假状态栏：时间、信号、电量。三样都只读浏览器当下的真实状态，不存任何东西。
//
// · 时间：真的，24 小时制 HH:MM，对齐到整分钟更新（不是每秒轮询）。锁屏上的大时间和日期也由这里一起更新。
// · 电量：navigator.getBattery() 只有 Chromium 系浏览器有（Firefox / Safari 没有）。有就画真实百分比并监听变化；
//   没有（或被拒绝、抛错）就只画一个静态的电池、不写百分比——不能编一个数字出来。
// · 信号：没有任何浏览器能给信号强度，所以只有两种样子：在线 = 满格；navigator.onLine 为 false = 压暗的格子 + 一道斜线。
//   监听 window 的 online / offline 事件。注意 onLine 为 true 只表示"有网卡连着"，不保证真能上网，这里也只做到这一步。
//
// 本模块不导入别的 ui 模块，不涉及循环依赖。

import { SIGNAL_SVG, BATTERY_SVG } from './icons.js';

const pad = n => String(n).padStart(2, '0');
export const formatClock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', weekday: 'long' });

/**
 * 建状态栏并开始盯着时间 / 信号 / 电量。
 * @param {{lockTime?: Element, lockDate?: Element}} extra 锁屏上跟着一起更新的大时间和日期元素
 * @returns {HTMLElement} 状态栏根元素（调用方挂进手机里；它一直活着，不随手机收起销毁——手机根本不会销毁）
 */
export function createStatusBar(extra = {}) {
    const root = document.createElement('div');
    root.className = 'ph-statusbar';
    root.innerHTML = `<span class="ph-time"></span><span class="ph-spacer"></span><span class="ph-sig" data-online="1" role="img" aria-label="信号：满格">${SIGNAL_SVG}</span><span class="ph-bat" data-level="unknown" role="img" aria-label="电池">${BATTERY_SVG}<span class="ph-bat-pct"></span></span>`;   // 全是常量，没有外来内容
    const time = root.querySelector('.ph-time');
    const sig = root.querySelector('.ph-sig');
    const bat = root.querySelector('.ph-bat');
    const pct = root.querySelector('.ph-bat-pct');
    const lvl = root.querySelector('.lvl');

    // ── 时间 ──
    let timer = 0;
    const tick = () => {
        const now = new Date();
        const t = formatClock(now);
        time.textContent = t;
        if (extra.lockTime) extra.lockTime.textContent = t;
        if (extra.lockDate) extra.lockDate.textContent = dateFmt.format(now);
        clearTimeout(timer);
        timer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);   // 下一个整分钟（多留 50ms 免得早到前一分钟）
    };
    tick();

    // ── 信号 ──
    const paintSignal = () => {
        const on = navigator.onLine !== false;
        sig.dataset.online = on ? '1' : '0';
        sig.setAttribute('aria-label', on ? '信号：满格' : '信号：无网络');
    };
    paintSignal();
    addEventListener('online', paintSignal);
    addEventListener('offline', paintSignal);

    // ── 电量 ──
    const paintBattery = b => {
        const p = Math.round(b.level * 100);
        bat.dataset.level = 'known';
        bat.dataset.charging = b.charging ? '1' : '0';
        lvl.setAttribute('width', String(Math.max(0.8, 18.2 * b.level)));
        pct.textContent = `${p}%`;
        bat.setAttribute('aria-label', `电量 ${p}%${b.charging ? '，充电中' : ''}`);
    };
    lvl.setAttribute('width', '14');   // 拿不到真实电量时的静态样子：画个大半格，不写数字
    try {
        const p = navigator.getBattery?.();
        p?.then(b => {
            paintBattery(b);
            for (const ev of ['levelchange', 'chargingchange']) b.addEventListener(ev, () => paintBattery(b));
        }, () => { /* 被拒绝：保持静态电池 */ });
    } catch { /* 同上 */ }

    return root;
}
