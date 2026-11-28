// UI 胶水：把各个纯函数模块接起来。这里不放任何「拼装算法」，只负责
//   导入文件 → 存状态 → 调 scanWorldInfo / assemble / runRegexScripts / formatMessage → 画出来。
// 想看一次生成到底发生了什么，从 computePrompt() 读起。

import { $ } from './ui/dom.js';
import { state, ui, card, save } from './ui/state.js';
import { permanentRegex, refreshPreview } from './ui/pipeline.js';
import { ensureMemories } from './ui/memory.js';
import { scrollChatToEnd, send, fitInput, swipedTurn } from './ui/chat.js';
import { appendSwipe } from './chatfile.js';
import { importFiles } from './ui/importer.js';
import { restoreActive } from './ui/backup.js';
import { renderInspector, renderAll, paintManualBadge } from './ui/shell.js';
import { refreshEndpoints } from './ui/tab-provider.js';
import { initArchive, bindArchive, newChat } from './ui/archive.js';
import { initDrawer } from './ui/drawer.js';
import { initTheme } from './ui/theme.js';
import { initPhone, openSettings, onPhoneView } from './ui/phone/phone.js';
import { renderMiscTab } from './ui/tab-misc.js';
import { bindPersonaTab } from './ui/tab-persona.js';
import { initPwaUi } from './ui/pwa-ui.js';
import { bindChatSearch } from './ui/chat-search.js';
import { bindHighlights } from './ui/highlight-ui.js';
import { emitTavernEvent } from './ui/script-host.js';

// ───────────────────────────── 事件绑定 ─────────────────────────────

function bind() {
    // 导入：顶栏已经没有按钮了，入口是「存档」页顶部的「导入…」（它点的就是这个 #file-input）；拖文件进页面也走 importFiles
    $('#file-input').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

    // 拖文件进页面。正在从备份恢复 / 写入时（遮罩盖着）：不显示「松手导入」的提示，松手了也不导入，只说一句「正在恢复，请稍等」。
    // 遮罩用 inert 挡住了点击和键盘，但挡不住挂在 window 上的拖放监听；那时导入的东西会在恢复结束时被盖掉（ui/backup.js restoreActive）。
    // dragover 照样 preventDefault（也不设 dropEffect = none）：不然浏览器会把文件当成网页打开把页面换掉，或者干脆不触发 drop、用户得不到任何提示
    let dragDepth = 0;
    addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files') && !restoreActive()) { dragDepth++; $('#drop-hint').hidden = false; } });
    addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => {
        e.preventDefault(); dragDepth = 0; $('#drop-hint').hidden = true;
        // 恢复中 / 停止保存 / 只读：importFiles 第一件事就是查这些（importBlockedReason），一个文件都不碰，只提示一句
        if (e.dataTransfer?.files.length) importFiles([...e.dataTransfer.files]);
    });

    $('#send_form').addEventListener('submit', e => { e.preventDefault(); send(); });
    $('#send_textarea').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('#send_textarea').addEventListener('input', () => { fitInput(); ui.previewIsSent = false; refreshPreview(); });
    window.addEventListener('resize', fitInput);   // 窗口变窄变宽后折行变了，高度要重算
    fitInput();
    $('#stop').addEventListener('click', () => ui.abort?.abort());
    // 「重新生成」按钮现在在最后一楼的左下角，由 chat.js 渲染楼层时自己绑定
    // 「新对话」按钮已从聊天区头部去掉（「存档」页里每张卡都有）；开场白下拉框保留：
    // 新对话 = 给当前卡新开一个存档（旧的留着）；当前存档只有开场白时直接原地换开场白，不堆空存档
    $('#greeting-select').addEventListener('change', () => newChat(Number($('#greeting-select').value) || 0));

    bindPersonaTab();   // 「人设」页的名字 / 描述 / 新建 / 删除（原来这里的「我叫」输入框事件挪过去了）
    $('#manual-mode').addEventListener('change', e => { state.manual = e.target.checked; save(); paintManualBadge(); });
    // 几个「点一下去某一页」的小入口（窄屏下 drawer.js 会顺带把抽屉打开）
    const gotoTab = name => () => document.querySelector(`#tabs button[data-tab="${name}"]`).click();
    $('#manual-badge').addEventListener('click', () => openSettings('#misc-manual'));   // 手动模式开关在手机的 Settings 里：打开手机、滚到「手动模式」那一节
    $('#chat-warn').addEventListener('click', gotoTab('provider'));
    $('#chat-empty-archive').addEventListener('click', gotoTab('archive'));

    $('#manual-ok').addEventListener('click', () => {
        if (ui.switching) return;   // 正在切换存档：这条回复不知道该进哪个存档（切换完面板会被收起）
        const text = $('#manual-reply').value;
        if (!text.trim()) return;
        // 手动模式下点了「重新生成」：贴回来的回复加成最后一楼的新候选，旧回复不删（chat.js generateReply 设的 ui.manualTarget）。
        // 只有那一楼还是最后一楼时才认（中间删过楼 / 换过存档就当普通回复，新开一楼）
        const target = ui.manualTarget;
        ui.manualTarget = null;
        if (target && state.chat.at(-1) === target) {
            appendSwipe(target, permanentRegex(text, 'assistant'));   // 顺带作废这一楼旧候选的记忆摘要
            swipedTurn(target);                                        // 它在合并段里的话那一段也作废（chat.js）
            ui.rendered.delete(state.chat.length - 1);
        } else state.chat.push({ role: 'assistant', name: card().name, content: permanentRegex(text, 'assistant') });
        $('#manual-reply').value = '';
        setTimeout(ensureMemories, 0);
        $('#manual-panel').hidden = true;
        save(); renderAll(); scrollChatToEnd();
        // 手动模式贴回来的回复：和生成的回复一样发 MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED（第 3 期，chat.js generateReply）
        const at = state.chat.length - 1;
        emitTavernEvent('message_received', at, target && state.chat[at] === target ? 'swipe' : 'normal');
        emitTavernEvent('character_message_rendered', at, target && state.chat[at] === target ? 'swipe' : 'normal');
    });
    $('#manual-cancel').addEventListener('click', () => { ui.manualTarget = null; $('#manual-panel').hidden = true; });
    $('#gen-error-close').addEventListener('click', () => { $('#gen-error').hidden = true; });

    // 焦点离开检查器里的文本框后，把打字期间跳过的重画补上
    $('#inspector').addEventListener('focusout', e => {
        if (e.target.matches?.('textarea, input:not([type]), input[type="text"]')) setTimeout(renderInspector, 0);
    });

    $('#tabs').addEventListener('click', e => {
        const btn = e.target.closest('button[data-tab]');
        if (!btn) return;
        const wasActive = btn.classList.contains('active');
        for (const b of $('#tabs').children) b.classList.toggle('active', b === btn);
        const reopened = !wasActive;   // 从别的页切进来：「接口」页重画一次（重读服务端配置）；点已经打开的这页不动
        for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
        renderInspector(reopened);
    });
}

await initArchive();
bind();
initDrawer();
initPhone();          // 手机壳（顶栏的手机图标接在这里；Settings 应用里装着原来的「杂项」页）
onPhoneView(v => { if (v === 'settings') renderMiscTab(); });   // 每次进入 Settings 都重画一遍，保证不是旧内容
initTheme();          // Settings 里的主题下拉框（<html data-theme> 的首屏设置在 index.html 的内联脚本里）
bindArchive();
bindChatSearch();     // 聊天区工具栏的「搜索」
bindHighlights();      // 划线：选中文字出按钮、画高亮、点高亮出备注浮层（src/ui/highlight-ui.js）
renderAll();
scrollChatToEnd();
initPwaUi();          // 网页版：注册离线缓存、盯着有没有新版本（不 await，不挡启动；本地版什么都不做）
refreshEndpoints();   // 读接口列表 → 「接口」页顶部 / 记忆页的模型选择器、顶栏的告警和健康灯
