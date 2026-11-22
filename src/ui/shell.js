// 页面骨架的渲染：顶栏、检查器（按当前标签分发到各页）、renderAll。

import { $, h } from './dom.js';
import { state, ui, card, save } from './state.js';
import { refreshPreview } from './pipeline.js';
import { renderChat } from './chat.js';
import { renderPromptTab } from './tab-prompt.js';
import { renderWorldTab } from './tab-world.js';
import { renderArchiveTab } from './tab-archive.js';
import { renderPresetTab } from './tab-preset.js';
import { renderRegexTab } from './tab-regex.js';
import { renderScriptsTab } from './tab-scripts.js';
import { renderMemoryTab } from './memory.js';
import { renderMiscTab } from './tab-misc.js';
import { renderPersonaTab } from './tab-persona.js';
import { renderProviderTab, refreshHealth, paintChatWarn } from './tab-provider.js';
import { renderModelPicker } from './model-picker.js';
import { reconcileScripts } from './script-host.js';

// ───────────────────────────── 顶栏与总渲染 ─────────────────────────────

export function renderTopbar() {
    const c = card();
    // 卡名放进单独的 span：顶栏窄的时候只截断名字，头像和小三角（::after）不受影响
    $('#card-chip').replaceChildren(
        ...[state.avatar ? h('img', { src: state.avatar, alt: '' }) : null,
            h('span', { class: state.card ? 'chip-name' : 'chip-name dim' }, state.card ? c.name : '未导入角色卡')].filter(Boolean));
    // 「我叫」输入框在「人设」页、「手动模式」勾选框在「杂项」页（index.html 里都是常驻的，不随页签重画）；这里只负责把值同步进去。
    // 正在输入时不覆盖：后台触发的 renderAll 会把用户打到一半的名字冲掉
    const nameInput = $('#persona-name');
    if (document.activeElement !== nameInput) nameInput.value = state.persona.name;
    $('#manual-mode').checked = state.manual;
    paintManualBadge();
    // 聊天用的「接口 + 模型」选择器现在在「接口」页顶部（#chat-model 仍是同一个元素，常驻 DOM）。
    // value 没变时重复调用什么也不做，不会打断正在输入的模型名
    renderModelPicker($('#chat-model'), { value: state.chatModel,
        onChange: ref => {
            state.chatModel = ref; save(); refreshHealth(); renderInspector();
            // 接口页下面各模型行的「聊天中」高亮要跟着变（renderInspector 在焦点停在本页文本框里时会跳过，所以直接通知）
            $('#provider-panel').dispatchEvent(new Event('st-chatmodel'));
        } });
    paintChatWarn();   // 顶栏上那个只在有问题时出现的小告警
    const greetings = [c.firstMes, ...c.alternateGreetings].filter(Boolean);
    const sel = $('#greeting-select');
    sel.hidden = greetings.length < 2;
    const keep = sel.value;   // 重建选项后保持刚才选中的开场白
    sel.replaceChildren(...greetings.map((g, i) => h('option', { value: i }, `开场白 ${i + 1}`)));
    if (keep && Number(keep) < greetings.length) sel.value = keep;
}

/** 顶栏里的「手动」徽标：手动模式开着才显示，免得用户忘了自己开过 */
export function paintManualBadge() {
    $('#manual-badge').hidden = !state.manual;
}

/** @param {boolean} [force]  只对「接口」页有意义：它平时不跟着后台重画走（见 tab-provider.js），force 才重建 */
export function renderInspector(force = false) {
    const active = $('#tabs button.active')?.dataset.tab ?? 'archive';
    // 正在这一页的文本框里打字时不要整页重画：重画会把文本框换成新的，光标就丢了。
    // 只更新变量显示；等焦点离开文本框后（见 bind 里的 focusout）再补一次完整重画。
    const focused = document.activeElement;
    if (focused?.matches?.('textarea, input:not([type]), input[type="text"]') && $(`#tab-${active}`)?.contains(focused)) {
        const vars = $('#vars-view');
        if (vars) vars.textContent = JSON.stringify(ui.preview?.variables ?? state.variables, null, 2);
        return;
    }
    ({ prompt: renderPromptTab, world: renderWorldTab, persona: renderPersonaTab, archive: renderArchiveTab, preset: renderPresetTab, regex: f => { renderRegexTab(f); renderScriptsTab(f); },   // 脚本区并在「正则」页下面（各画各的容器）
         memory: renderMemoryTab, provider: renderProviderTab, misc: renderMiscTab })[active](force === true);
}

export function renderAll() {
    renderTopbar();
    renderChat();
    if (ui.previewIsSent && ui.preview) renderInspector();
    else refreshPreview();
    // 酒馆助手脚本的沙箱：换了卡就重建、换了存档就推新聊天 + CHAT_CHANGED、别的改动推副本（只比引用，便宜；规则见 script-host.js 文件头）
    reconcileScripts();
}
