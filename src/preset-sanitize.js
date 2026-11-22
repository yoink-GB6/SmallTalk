// 酒馆预设里的「连接信息」：反代地址、反代密码、自定义接口地址、附加请求头 / 请求体……
// 纯函数，不碰 DOM / IndexedDB，Node 里可测。
//
// 为什么要有这个文件：
//   酒馆保存对话补全预设时（public/scripts/openai.js getChatCompletionPreset，约 4582 行），是把 settingsToUpdate（约 305 行）
//   里列出的【每一个】设置原样写进预设文件——其中不只是采样参数和提示词条目，还有一批「连接」性质的设置（第四列 is_connection 为 true），
//   包括反代密码 proxy_password、可能带着 Authorization 的 custom_include_headers。所以用户分享 / 备份的预设文件里经常夹带着这些东西。
//   酒馆自己在导入、导出预设时会按 sensitiveFields（约 287 行）弹窗提醒「要不要去掉」。
//   SmallTalk 完全不用这些字段（接口在「接口」页单独配置，见 openai-shared.js），留着只有坏处：
//   它们会进 IndexedDB，再以明文出现在「预设」页的导出、不加密的整体备份、导出成酒馆目录的 zip 里。
//   所以所有预设【进入系统的入口】都过一遍 sanitizePreset，【所有导出出口】再过一遍兜底（存储里可能还有以前导入时留下的）。
//
// 只看预设的【顶层】字段，不往下钻：酒馆写这些字段时就在顶层；prompts / prompt_order / extensions 里是用户的内容，不能按名字乱删。

/**
 * 敏感字段的清单：字段名 → 类别（给人看的提示只说类别，不说字段的值）。
 * 依据（逐个对过酒馆 1.19.0 public/scripts/openai.js）：
 *   一、酒馆自己的 sensitiveFields（约 287 行，导入 / 导出预设时它会提醒的那 11 个）：
 *     reverse_proxy                反代地址（settingsToUpdate 里 is_connection）
 *     proxy_password               反代的访问密码（#openai_proxy_access_key；生成时作为 proxy_password 发给服务端）
 *     custom_url                   「自定义（OpenAI 兼容）」接口的地址
 *     custom_include_body          附加到请求体里的 JSON / YAML（常用来塞 key 或账户参数）
 *     custom_exclude_body          要从请求体里去掉的字段（和上一项成对，属于请求体附加项）
 *     custom_include_headers       附加请求头（最常见的用法就是 Authorization: Bearer …）
 *     vertexai_region              Vertex AI 的区域（和项目 ID 一起定位到用户自己的 GCP 资源；酒馆把它算作敏感）
 *     vertexai_express_project_id  Vertex AI 的项目 ID（账户标识）
 *     azure_base_url               Azure OpenAI 资源的地址（带着用户的资源名）
 *     azure_deployment_name        Azure 部署名（账户标识）
 *     workers_ai_account_id        Cloudflare Workers AI 的账户 ID
 *   二、我们自己通读 settingsToUpdate 后加的：
 *     api_url_scale                旧版酒馆（Scale 接口）写进预设的地址。1.19 的 settingsToUpdate 里已经没有它，但旧预设文件里可能还在
 *   逐个看过、判定【不是】敏感、不删的连接类字段（is_connection 为 true，但只是选项 / 模型名，不含地址或凭据）：
 *     chat_completion_source、各家的 *_model、sort_models / group_models、openrouter_* 的偏好、
 *     siliconflow_endpoint / minimax_endpoint / zai_endpoint / pollinations_endpoint（是 'global' / 'cn' 这类枚举，不是地址）、
 *     nanogpt_provider / nanogpt_payg_override、custom_prompt_post_processing、vertexai_auth_mode（只是模式名）、
 *     azure_api_version（API 版本号）、azure_openai_model、show_external_models、bypass_status_check。
 *     它们留着无害（我们不用），删了反而让导出回酒馆的预设少东西。
 */
export const SENSITIVE_PRESET_FIELDS = Object.freeze({
    reverse_proxy: '反代地址',
    proxy_password: '反代密码',
    custom_url: '自定义接口地址',
    custom_include_body: '附加请求体',
    custom_exclude_body: '附加请求体',
    custom_include_headers: '附加请求头',
    vertexai_region: '账户信息',
    vertexai_express_project_id: '账户信息',
    azure_base_url: '自定义接口地址',
    azure_deployment_name: '账户信息',
    workers_ai_account_id: '账户信息',
    api_url_scale: '自定义接口地址',
});

/**
 * 兜底规则：字段名按「词」切开（下划线、连字符、点、空白，以及驼峰的大小写交界），任何一个词是下面这些之一就算凭据：
 *   password / passwd / secret / token / cookie / authorization / apikey，或者相邻两个词是 api + key（api_key、apiKey、x-api-key）。
 * 为什么按「词」而不是按「子串」：子串会误伤预设里的正常字段——openai_max_tokens 含 token、max_context_unlocked 含 tok…
 * 按词切开后 tokens ≠ token、tokenizer ≠ token，就不会误伤。故意【不】收 auth（会误伤 vertexai_auth_mode）和 key（会误伤各种 *_key 选项）。
 * 用酒馆自带的 Default 预设和 test/fixtures 里的预设跑过：兜底规则一个字段都没命中（见 test/preset-sanitize.test.mjs）。
 */
const CRED_WORDS = new Set(['password', 'passwd', 'secret', 'token', 'cookie', 'authorization', 'apikey']);

/** 字段名 → 小写的词列表 */
function words(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase → camel Case
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // APIKey → API Key
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** 这个字段名是不是按兜底规则算凭据 */
export function looksLikeCredentialName(name) {
    const w = words(name);
    for (let i = 0; i < w.length; i++) {
        if (CRED_WORDS.has(w[i])) return true;
        if (w[i] === 'api' && w[i + 1] === 'key') return true;
    }
    return false;
}

/** 这个顶层字段名要不要去掉（清单 + 兜底） */
export function isSensitivePresetField(name) {
    return Object.hasOwn(SENSITIVE_PRESET_FIELDS, name) || looksLikeCredentialName(name);
}

/** 字段名 → 类别（清单里的用登记的类别；兜底命中的统一叫「凭据」） */
export function sensitiveCategory(name) {
    return Object.hasOwn(SENSITIVE_PRESET_FIELDS, name) ? SENSITIVE_PRESET_FIELDS[name] : '凭据';
}

/** 一组字段名 → 去重后的类别列表（给提示文字用） */
export function sensitiveCategories(names) {
    return [...new Set((names ?? []).map(sensitiveCategory))];
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 值算不算「有内容」：酒馆的预设里这些字段默认都是 ''，空的去掉了也不必提醒用户 */
const filled = v => !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length));

/**
 * 去掉预设顶层的敏感字段。不改输入，返回副本（顶层浅拷贝：prompts 等嵌套内容和输入共用引用，调用方要改它们得自己深拷贝）。
 *   removed：去掉的字段名（不含值）。包括值是空串的——酒馆的预设里这些字段总是在的（默认 ''），一律去掉，存储形状才干净；
 *   filled：removed 里值不为空的那些。只有它非空时才值得提示用户「已去掉」（和酒馆一样：它也只对有值的字段弹提醒）。
 * 输入不是对象：原样返回、两个列表都是空的（调用方自己判断形状）。
 * @param {any} preset
 * @returns {{preset: any, removed: string[], filled: string[]}}
 */
export function sanitizePreset(preset) {
    if (!isObj(preset)) return { preset, removed: [], filled: [] };
    const out = {};
    const removed = [], full = [];
    for (const k of Object.keys(preset)) {
        if (isSensitivePresetField(k)) {
            removed.push(k);
            if (filled(preset[k])) full.push(k);
            continue;
        }
        out[k] = preset[k];
    }
    return { preset: removed.length ? out : preset, removed, filled: full };
}

/** 预设顶层有没有敏感字段（自检、测试用；不看值） */
export function presetHasSensitive(preset) {
    return isObj(preset) && Object.keys(preset).some(isSensitivePresetField);
}

/**
 * 导入时给用户的一句话（只说类别，不出现字段的值，也不出现字段名以外的任何内容）。没去掉有内容的字段时返回 ''。
 * @param {string[]} filledNames  sanitizePreset 的 filled
 * @param {string} [what]  「这个预设」「预设「xxx」」之类的主语
 */
export function sanitizeNotice(filledNames, what = '这个预设') {
    if (!filledNames?.length) return '';
    return `${what}里带着酒馆的连接信息（${sensitiveCategories(filledNames).join('、')}），SmallTalk 用不到，已去掉`;
}
