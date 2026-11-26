// 输入框上方的一排脚本按钮（酒馆助手第 4 期，方案 §3.4）。
// 酒馆助手把运行中的脚本的按钮画在输入区上方的快速回复栏（#qr--bar）里，点一下 = eventSource.emit(按钮事件名)，不带参数。
// 这里：#script-buttons（index.html，#manual-panel 和 #send_form 之间），只在当前卡的沙箱在跑、且有启用的、看得见的按钮时才出现；
// 没有就 hidden，输入区和以前一模一样。一行、不换行，放不下横向滚动（窄屏同样）；按脚本分组，组间一条细竖线，按钮 title = 脚本名。
// 样式只用现有的 button.ghost（两个主题都照顾到了）和变量，见 style.css 末尾。
//
// 可用性：生成中、任何时候都能点——点了只是给脚本发一个事件；脚本接着要改聊天 / 触发生成，由宿主现有的拒绝条件管（生成中改聊天被拒、
// 弹原因）。只读标签页不运行脚本，所以这里本来就不出现。
// UI 模块之间有循环依赖：这个文件顶层不调用任何从兄弟 ui 模块导入的函数。

import { $, h } from './dom.js';
import { buttonEventName } from '../scripts.js';
import { runningButtons, clickScriptButton } from './script-host.js';   // 循环依赖：只在函数体里调用

let lastSig = null;

/** 按现在运行中的脚本重画按钮排（script-host.js 在建 / 拆沙箱、按钮变了、reconcile 时调；没变就不动） */
export function renderScriptButtons() {
    const bar = $('#script-buttons');
    if (!bar) return;
    const groups = runningButtons();
    const sig = JSON.stringify(groups);
    if (sig === lastSig) return;
    lastSig = sig;
    bar.hidden = groups.length === 0;
    const kids = [];
    groups.forEach((g, gi) => {
        if (gi) kids.push(h('span', { class: 'sb-sep', 'aria-hidden': 'true' }));
        for (const name of g.buttons) {
            kids.push(h('button', { type: 'button', class: 'ghost sb-btn', 'data-fk': 'script-button', 'data-script': g.id, title: `脚本「${g.name}」的按钮`,
                onclick: () => clickScriptButton(g.id, buttonEventName(g.id, name)) }, name || '(没有名字)'));
        }
    });
    bar.replaceChildren(...kids);
}
