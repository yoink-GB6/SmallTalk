// 「正则」页编辑器用的纯函数：不碰页面、不碰 state，方便单元测试。
// 对照酒馆 public/scripts/extensions/regex/index.js（onRegexEditorOpenClick / saveRegexScript）。

import { regexFromString, runRegexScripts, REGEX_PLACEMENT } from './regex.js';
import { safeFileName } from './card-export.js';

/** 编辑器里「作用于哪些内容」的勾选项：值就是引擎认的 placement 数字（MD_DISPLAY=0 和 4 酒馆已废弃，不收） */
export const PLACEMENT_CHOICES = [
    { value: REGEX_PLACEMENT.USER_INPUT, label: '用户输入', title: '你发出去的消息' },
    { value: REGEX_PLACEMENT.AI_OUTPUT, label: 'AI 输出', title: '模型回的消息' },
    { value: REGEX_PLACEMENT.SLASH_COMMAND, label: '斜杠命令', title: '斜杠命令发出的消息（我们还没有斜杠命令，写着备用，导出给酒馆时有用）' },
    { value: REGEX_PLACEMENT.WORLD_INFO, label: '世界书', title: '世界书条目的内容；酒馆要求同时选「仅发送」才有效' },
    { value: REGEX_PLACEMENT.REASONING, label: '推理', title: '思维链内容' },
];

/** 宏替换方式 substituteRegex（engine.js substitute_find_regex）：0 不替换 / 1 原样替换 / 2 替换后转义 */
export const SUBSTITUTE_CHOICES = [
    { value: 0, label: '不替换宏' },
    { value: 1, label: '替换宏（原样）' },
    { value: 2, label: '替换宏（转义）' },
];

/**
 * 范围：markdownOnly / promptOnly 两个布尔的四种组合。
 * 都不勾 = 永久改写（直接改存下来的聊天原文）；酒馆允许两个同时勾（显示和发送都改，但不改原文）。
 */
export const SCOPE_CHOICES = [
    { value: 'permanent', label: '永久改写', title: '直接改存下来的聊天原文，之后显示和发送都是改过的' },
    { value: 'display', label: '仅显示', title: '只改聊天区看到的样子，存的原文和发给模型的都不变' },
    { value: 'prompt', label: '仅发送', title: '只改发给模型的内容，聊天区和存的原文都不变' },
    { value: 'both', label: '显示 + 发送', title: '显示和发送都改，存的原文不变' },
];

export function scopeOf(s) {
    return s.markdownOnly && s.promptOnly ? 'both' : s.markdownOnly ? 'display' : s.promptOnly ? 'prompt' : 'permanent';
}

/** 把 scopeOf 的结果写回两个布尔（只动这两个字段） */
export function applyScope(s, scope) {
    s.markdownOnly = scope === 'display' || scope === 'both';
    s.promptOnly = scope === 'prompt' || scope === 'both';
    return s;
}

/**
 * 新建脚本的默认值，照酒馆「新建」时编辑器的初始状态：
 * 勾上「仅格式显示」（markdownOnly）、「编辑时也运行」（runOnEdit）和「用户输入」（placement [1]），其它全空 / 关；
 * 脚本启用（disabled:false）。字段顺序也照酒馆保存时的顺序。
 * @param {string} id
 * @param {string} [name]
 */
export function newRegexScript(id, name = '新正则') {
    return {
        id, scriptName: name, findRegex: '', replaceString: '', trimStrings: [], placement: [REGEX_PLACEMENT.USER_INPUT],
        disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    };
}

/** 深度输入框的文字 → 整数或 null（空 / 不是数字 = 不限，和酒馆 parseInt 后 NaN 存成 null 一致） */
export function parseDepth(text) {
    const n = parseInt(String(text ?? '').trim(), 10);
    return Number.isFinite(n) ? n : null;
}

/** 「修剪掉的字符串」文本框 → 数组：一行一个，空行不要（和酒馆 split('\n').filter 一致） */
export function parseTrimStrings(text) {
    return String(text ?? '').split('\n').filter(l => l.length !== 0);
}

/**
 * 校验「查找的正则」。解析规则和引擎一样（直接用 regex.js 的 regexFromString），所以编辑器说「没问题」的，引擎一定能编译。
 * 查找串里带 {{宏}} 且开了宏替换时，真正的正则要运行时才知道，这里没法验，只提示。
 * @param {string} find
 * @param {number|string} [substituteRegex]
 * @returns {{ok: boolean, message: string, note?: string}}
 */
export function checkFindRegex(find, substituteRegex = 0) {
    if (typeof find !== 'string' || find === '') return { ok: false, message: '还没写查找的正则，这条不会起作用' };
    if (Number(substituteRegex) && /\{\{[\s\S]*?\}\}/.test(find)) {
        return { ok: true, message: '', note: '里面有宏，要到运行时替换后才能确定正则对不对，这里不检查' };
    }
    if (regexFromString(find)) return { ok: true, message: '' };
    // 引擎只会返回 undefined；想给出具体原因，就再按同样的步骤编译一次把错误捕出来
    let why = '写法不对';
    try {
        const m = find.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!m) why = '空的';
        else if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) RegExp(find);
        else new RegExp(m[2], m[3]);
    } catch (e) { why = String(e?.message ?? e).replace(/^Invalid regular expression:\s*/, ''); }
    return { ok: false, message: `这个正则编译不过，这条会被跳过：${why}` };
}

/**
 * 「试一试」：只把这一条脚本套在一段文字上。和酒馆编辑器里的测试一样，不看启用开关、作用范围、深度，只看查找 / 替换 / 修剪 / 宏。
 * @param {Object} script
 * @param {string} text
 * @param {(t: string) => string} [substitute]  宏替换（页面传 macros.js 的 substitute）
 */
export function tryScript(script, text, substitute) {
    const probe = {
        ...script, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true,
        minDepth: null, maxDepth: null, placement: [REGEX_PLACEMENT.USER_INPUT],
    };
    return runRegexScripts(text, [probe], { placement: REGEX_PLACEMENT.USER_INPUT, substitute });
}

/** 导出成酒馆的正则 JSON：去掉我们运行时打的 origin 标签，其余字段（含不认识的）原样，缩进 4 空格和酒馆一样 */
export function serializeRegexScript(script) {
    const { origin, ...rest } = script ?? {};
    return JSON.stringify(rest, null, 4);
}

/** 酒馆导出的文件名：regex-<脚本名>.json */
export function regexFileName(script) {
    return safeFileName(script?.scriptName ? `regex-${script.scriptName}` : 'regex', 'json', 'regex');
}
