// 检查器「接口」页：接口列表面板（provider-panel.js），以及「聊天模型指向的接口现在能不能用」的健康灯。
// 接口列表的共享缓存（ui.endpoints）和选择器在 model-picker.js。

import { checkHealth, setWriteGuard } from '../llm.js';
import { renderProviderPanel } from './provider-panel.js';
import { $ } from './dom.js';
import { state, persist, save, STOPPED_TEXT } from './state.js';
import { renderInspector, renderTopbar } from './shell.js';   // 与 shell.js 循环依赖：只在函数体里用，顶层不调用
import { loadEndpoints, setEndpoints, endpointById, endpointsUnavailable, refProblem, refUnpicked } from './model-picker.js';

// 网页版（direct 后端）的接口列表存在浏览器里，和存档一样受「同一时间只有一个标签页写」的约束：
// 只读标签页、清空数据之后都不许增删改接口。setWriteGuard 是 llm.js 的函数（不是兄弟 ui 模块的），顶层调用是安全的；
// persist 只在回调被调用时才读（那时 state.js 早已加载完），不违反「顶层不调用兄弟 ui 模块的函数」。
setWriteGuard(() => persist.readOnly ? '这个标签页是只读的（见页面顶上的说明），不能修改接口。请到正在写数据的那个标签页里改'
    : persist.stopped ? STOPPED_TEXT : null);

/** 聊天模型所在接口的类型：'claude-code' | 'codex-cli' | 'openai' | null（接口已被删 / 未知 / 网页版里还没选） */
export const chatEndpointType = () => endpointById(state.chatModel?.endpoint)?.type ?? null;

/**
 * 顶栏上的小告警：聊天用的模型有问题（没选模型 / 接口没就绪 / 接口被删）时才出现，点它去「接口」页；没问题就整个隐藏。
 * 判断用的是和模型选择器同一个 refProblem，所以两处的说法一致。
 */
export function paintChatWarn() {
    const btn = $('#chat-warn');
    if (!btn) return;
    const problem = refProblem(state.chatModel);
    btn.hidden = !problem;
    if (!problem) return;
    // 接口名可能很长，顶栏上只写「接口未就绪」；完整的原因放在 title 里
    btn.textContent = /未就绪$/.test(problem) ? '⚠ 接口未就绪' : `⚠ ${problem}`;
    btn.title = `${problem}：点这里去「接口」页处理`;
}

/** 重读接口列表（启动时调一次），更新所有选择器和健康灯 */
export async function refreshEndpoints() {
    await loadEndpoints();
    await refreshHealth();
}

/** 健康灯跟着「聊天模型的接口」走：就绪 = 绿；否则红，提示缺什么 */
export async function refreshHealth() {
    paintChatWarn();   // 同步先画（后面有 await）；refreshHealth 本来就是「聊天模型或接口列表变了」时必调的那个入口
    const el = $('#health');
    const ref = state.chatModel;
    const ep = endpointById(ref?.endpoint);
    const set = (ok, title) => { el.className = `health ${ok ? 'ok' : 'bad'}`; el.title = title; };
    if (!ep && refUnpicked(ref)) return set(false, '还没选聊天用的接口（到「接口」页添加一个接口，再在页面顶部选它）');
    if (!ep) return set(false, '聊天模型指向的接口已被删除（到「接口」页检查，再在「接口」页顶部重新选择聊天模型）');
    if (ep.type === 'codex-cli') return set(ep.ready, ep.ready ? `Codex：${ep.detail}（只检查了可执行文件，没有检查登录状态）` : `Codex 不可用：${ep.detail}`);
    if (ep.type === 'claude-code') {
        if (endpointsUnavailable()) { // 读不到接口列表（旧服务）：照老办法问 /api/health
            const res = await checkHealth();
            return set(res.ok, res.ok ? `模型桥正常：${res.claudePath}` : `模型桥不可用：${res.error ?? '未知原因'}（可以用手动模式）`);
        }
        return set(ep.ready, ep.ready ? `模型桥正常：${ep.detail}` : `模型桥不可用：${ep.detail}（可以用手动模式）`);
    }
    if (!ep.ready) return set(false, `接口「${ep.name}」还缺：${(ep.detail || '').replace(/^缺少/, '')}（在「接口」页补全）`);
    if (!ref.model) return set(false, `接口「${ep.name}」已就绪，但还没选模型（在「接口」页顶部选择）`);
    set(true, `接口「${ep.name}」已配置：${ref.model}（只检查配置，没有联网测试）`);
}

// 面板每次渲染都会向服务端取列表并清掉没保存的输入，所以只在「打开这一页」时画一次；
// 之后后台触发的 renderInspector（预览刷新、记忆压缩完成……）一律不动它，除非 force。
let built = false;

export function renderProviderTab(force = false) {
    if (built && !force) {
        // 面板不重画，但聊天模型可能在别处被改过：通知各行重新高亮「聊天中」
        $('#provider-panel').dispatchEvent(new Event('st-chatmodel'));
        return;
    }
    built = true;
    // 面板画进自己的容器 #provider-panel：renderProviderPanel 会清空它的容器，而页面顶部的「聊天用的模型」选择器（#chat-model）要常驻
    renderProviderPanel($('#provider-panel'), {
        onChange: (list) => { setEndpoints(list); refreshHealth(); },
        // 「用它聊天」：和页面顶部选择器的 onChange（shell.js）同一套动作，再多一步 renderTopbar 让那个选择器显示新值
        chat: {
            current: () => state.chatModel,
            use: (ref) => { state.chatModel = ref; save(); refreshHealth(); renderTopbar(); renderInspector();
                // renderInspector 在焦点还停在本页某个文本框里时会整个跳过，所以这里直接通知各行重新高亮
                $('#provider-panel').dispatchEvent(new Event('st-chatmodel')); },
        },
    });
}
