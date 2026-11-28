// 手机 Settings 的「接口」页（原来右侧检查器的「接口」页）：接口列表面板（provider-panel.js），以及「聊天模型指向的接口现在能不能用」的健康灯和红点。
// 接口列表的共享缓存（ui.endpoints）和选择器在 model-picker.js。

import { checkHealth, setWriteGuard } from '../llm.js';
import { renderProviderPanel } from './provider-panel.js';
import { $ } from './dom.js';
import { setSettingsBadge } from './phone/phone.js';
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
 * 聊天用的模型有问题（没选模型 / 接口没就绪 / 接口被删）时，在手机上挂红点：顶栏手机图标 → 桌面 Settings 图标 → Settings 菜单里的「接口」一项，
 * 三处一路红到那一页；没问题（或接口列表还没读回来）就三处一起灭。以前这里是顶栏上的一条文字告警（#chat-warn），已经去掉了。
 * 判断用的是和模型选择器同一个 refProblem（它处理了「接口列表还没读回来」时不误报），所以和「接口」页里选择器上标红的是同一个条件。
 * 函数名沿用 paintChatWarn：renderTopbar 和 refreshHealth 都已经在适当的时机调它。
 */
export function paintChatWarn() {
    setSettingsBadge('provider', !!refProblem(state.chatModel) || channelDown);
}

/**
 * 聊天用的那条通道（健康灯 #health 的 bad）现在是不是用不了：refreshHealth 查完后记下，红点和 refProblem 是「或」的关系。
 * 只在聊天模型【指向的接口存在】时才可能为 true，所以聊天用的是别的接口、Claude Code 那条通道坏了，和用户无关，不亮；
 * 网页版没有命令行类的接口，也不会亮。接口还没读回来 / 接口不存在这类情况灯虽然也是 bad，但那是 refProblem 的活
 * （它处理了「还没读回来」不误报），这里不重复。每次 refreshHealth 一开始先清成 false（还没查出结果 = 不报），查完再画。
 * 目前 refProblem 看不到、只有健康灯看得到的情况：读不到接口列表的旧服务，退路里的 Claude Code 显示就绪，但 /api/health 说它不可用。
 */
let channelDown = false;
let healthSeq = 0;   // 连着调两次时，先发的那次晚回来不能盖掉后发的结果

/** 重读接口列表（启动时调一次），更新所有选择器和健康灯 */
export async function refreshEndpoints() {
    await loadEndpoints();
    await refreshHealth();
}

/** 健康灯跟着「聊天模型的接口」走：就绪 = 绿；否则红，提示缺什么 */
export async function refreshHealth() {
    const seq = ++healthSeq;
    channelDown = false;
    { const n = $('#chat-channel-note'); if (n) n.hidden = true; }
    paintChatWarn();   // 同步先画（后面有 await）；refreshHealth 本来就是「聊天模型或接口列表变了」时必调的那个入口
    const el = $('#health');
    const ref = state.chatModel;
    const ep = endpointById(ref?.endpoint);
    const set = (ok, title) => {
        if (seq !== healthSeq) return;   // 已经有更新的一次在查了
        el.className = `health ${ok ? 'ok' : 'bad'}`; el.title = title;
        channelDown = !ok && !!ep;   // 接口不存在的 bad 归 refProblem 管（见 channelDown 的说明）
        const note = $('#chat-channel-note');
        if (note) { note.hidden = !channelDown; note.textContent = channelDown ? '聊天通道现在用不了：' + title : ''; }
        paintChatWarn();
    };
    if (!ep && refUnpicked(ref)) return set(false, '还没选聊天用的接口（到手机 Settings 的「接口」页添加一个接口，再在页面顶部选它）');
    if (!ep) return set(false, '聊天模型指向的接口已被删除（到手机 Settings 的「接口」页检查，再在「接口」页顶部重新选择聊天模型）');
    if (ep.type === 'codex-cli') return set(ep.ready, ep.ready ? `Codex：${ep.detail}（只检查了可执行文件，没有检查登录状态）` : `Codex 不可用：${ep.detail}`);
    if (ep.type === 'claude-code') {
        if (endpointsUnavailable()) { // 读不到接口列表（旧服务）：照老办法问 /api/health
            const res = await checkHealth();
            return set(res.ok, res.ok ? `模型桥正常：${res.claudePath}` : `模型桥不可用：${res.error ?? '未知原因'}（可以用手动模式）`);
        }
        return set(ep.ready, ep.ready ? `模型桥正常：${ep.detail}` : `模型桥不可用：${ep.detail}（可以用手动模式）`);
    }
    if (!ep.ready) return set(false, `接口「${ep.name}」还缺：${(ep.detail || '').replace(/^缺少/, '')}（在手机 Settings 的「接口」页补全）`);
    if (!ref.model) return set(false, `接口「${ep.name}」已就绪，但还没选模型（在手机 Settings 的「接口」页顶部选择）`);
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
