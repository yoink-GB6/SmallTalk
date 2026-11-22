// 「接口 + 模型」选择器：两个联动的控件（先选接口，再选该接口的模型），「接口」页顶部（聊天）和「记忆」页（压缩）各用一个。
// 接口列表来自一份共享的运行期缓存 ui.endpoints（启动时读、「接口」页每次改动后更新），
// 所以接口页增删 / 重新获取模型后，所有还挂在页面上的选择器会跟着更新。
// 引用指向的接口被删了 / 没就绪：不悄悄换成别的，而是在选择器上标红，发送时由服务端报错并指向「接口」页。
//
// 模型控件：Claude Code 是固定的几个别名，用原生 <select>；OpenAI 类接口的模型可能有几百个、还可能为空（中转站没有 /models），
// 用自己做的下拉面板（按钮 + 浮层，见 openModelPop）。曾经用 <input list=datalist>，但浏览器在框里已有字时只显示「包含这些字」的候选，
// 点开几乎是空的，用户以为坏了——所以换成「永远显示完整列表、筛选框另放」的面板。
//
// 命令行类内置接口（claude-code、codex-cli，见 types.js「命令行类内置接口」）：模型可以留空（= 跟随命令行自己的默认），所以不报「还没选模型」。
// Claude Code 用原生 <select>（固定几个别名）；Codex 用和 OpenAI 类一样的下拉面板（固定名单 + 可手填，订阅里的模型会变）。
// 网页版（direct）的接口列表里没有内置接口，而已保存引用的默认值就是 claude-code：这种「指向内置接口、但列表里没有它」的引用
// 当作【还没选接口】来呈现（不说「已删除」，也不提 Claude Code），引用本身不改写——同一份数据拿回本地版照常可用。
import { listEndpoints } from '../llm.js';
import { isBuiltinId, CLI_TYPES } from '../openai-shared.js';
import { h } from './dom.js';
import { ui } from './state.js';

export const CLAUDE_ID = 'claude-code';
const CLAUDE_MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_LABEL = { '': '默认（跟随 Claude Code）', fable: 'Fable（最强）', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku（最快）' };
const CODEX_LABEL = { '': '默认（跟随 Codex）' };
/** 命令行类内置接口：模型可以留空 */
const isCli = (ep) => !!ep && CLI_TYPES.includes(ep.type);
/** 需要用户自己挑模型的接口（OpenAI 类）：切过去时打开模型面板、记住上次选的模型 */
const needsModel = (ep) => !!ep && !isCli(ep);
// 读不到接口列表时（服务没起来 / 是不带接口功能的旧服务）退回成「只有 Claude Code」，别的功能照常
const FALLBACK = [{ id: CLAUDE_ID, name: 'Claude Code', type: 'claude-code', baseUrl: '', hasKey: false, models: CLAUDE_MODELS, modelsFetchedAt: null, ready: true, detail: '' }];

let version = 0;          // 缓存每变一次 +1：选择器据此判断要不要重画
let loadFailed = false;
const pickers = new Map(); // 容器 → 最近一次的 options，缓存变了就用它重画

export const endpointList = () => ui.endpoints ?? FALLBACK;
export const endpointById = (id) => endpointList().find((e) => e.id === id) ?? null;
/** 最近一次读列表失败了（此时 endpointList() 是只有 Claude Code 的退路） */
export const endpointsUnavailable = () => ui.endpoints == null && loadFailed;
/** 接口列表还在读（页面刚打开，请求没回来）：这时 endpointList() 只是退路，不能据此断言「接口已删除」 */
export const endpointsLoading = () => ui.endpoints == null && !loadFailed;

// 接口列表变了（读回来 / 读失败 / 增删改）时要通知的回调。外置记忆靠它：页面刚打开时列表还没读回来、先「等」，
// 读回来之后再补压；本模块不 import memory.js（那会成环），所以用回调反过来挂。
const changeHooks = [];
export const onEndpointsChange = (fn) => { changeHooks.push(fn); };

/** 换上新的接口列表，并让还在页面上的选择器重画 */
export function setEndpoints(list) {
    ui.endpoints = list; loadFailed = false; version++;
    notify();
}
function notify() {
    for (const [c, opts] of pickers) {
        if (!c.isConnected) pickers.delete(c);
        else renderModelPicker(c, opts);   // 签名变了才真重画；重画会顺手关掉指向旧数据的浮层
    }
    for (const fn of changeHooks) { try { fn(); } catch (e) { console.error(e); } }
}
/** 从服务端读一次。失败不抛错：保留旧缓存（没有旧缓存就用退路）。 */
export async function loadEndpoints() {
    try { setEndpoints(await listEndpoints()); }
    catch { loadFailed = true; version++; notify(); }
}

/**
 * 引用指向内置接口，但列表里没有它（网页版：根本不列内置接口）→ 当作「还没选接口」。
 * 列表还在读的时候不下结论（返回 false）。
 */
export const refUnpicked = (ref) => isBuiltinId(ref?.endpoint) && !endpointById(ref.endpoint) && !endpointsLoading();
/** 列表里有没有用户自己加的接口（没有 → 说「还没添加接口」） */
const hasUserEndpoints = () => endpointList().some((e) => !isBuiltinId(e.id));

/** 这个引用现在能不能用？返回 null = 没问题，否则一句简短的原因 */
export function refProblem(ref) {
    const ep = endpointById(ref?.endpoint);
    // 刚刷新页面时接口列表是异步读回来的，退路里只有 Claude Code：指向别的接口的引用此刻查不到不代表被删了。
    // 读完（setEndpoints）会 version++ 重画；在那之前不报错，免得用户看到一闪而过的红色「接口已删除」。
    if (!ep) return endpointsLoading() ? null : refUnpicked(ref) ? (hasUserEndpoints() ? '还没选接口' : '还没添加接口') : '接口已删除';
    if (!ep.ready) return `「${ep.name}」未就绪`;
    if (needsModel(ep) && !ref.model) return '还没选模型';
    return null;
}

// ── 模型浮层 ──
// 同一时间最多开一个。挂在 document.body 上、position: fixed：顶栏和检查器都有 overflow，挂在原位会被裁掉。
let openPop = null;   // { container, anchor, close }
const closePop = () => openPop?.close();

/**
 * 在 anchor（那个显示当前模型名的按钮）下面打开浮层。
 * 筛选框里打的字：列表里没有这个名字时，列表末尾多一项「使用「xxx」」（没有 /models 的中转站靠它手填）。
 * 回车选中「高亮项」：有匹配时默认高亮第一个匹配，没有匹配时高亮「使用 xxx」；想用打出来的名字而不是匹配项，按下箭头移到最后一项。
 */
function openModelPop({ container, anchor, models, current, onPick, labels = {} }) {   // labels：模型名 → 显示文字（Codex 的 '' 显示成「默认」）
    closePop();
    let q = '';
    let items = [];   // { model, custom? }，和 list.children 一一对应
    let active = 0;

    const input = h('input', { type: 'text', class: 'mp-filter', placeholder: '筛选，或直接输入模型名…', autocomplete: 'off', 'aria-label': '筛选模型' });
    input.spellcheck = false;
    const hint = h('div', { class: 'mp-hint dim' });
    const list = h('div', { class: 'mp-list', role: 'listbox' });
    const pop = h('div', { class: 'mp-pop', role: 'dialog', 'aria-label': '选择模型' }, input, hint, list);

    const choose = (it) => { close(); onPick(it.model); };
    function paintActive(scroll) {
        [...list.children].forEach((n, i) => {
            n.classList.toggle('active', i === active);
            if (i === active && scroll) n.scrollIntoView({ block: 'nearest' });
        });
    }
    function draw() {
        const typed = q.trim();
        const ql = typed.toLowerCase();
        items = (ql ? models.filter((m) => (labels[m] ?? m).toLowerCase().includes(ql)) : models).map((m) => ({ model: m }));
        if (typed && !models.includes(typed)) items.push({ model: typed, custom: true });
        active = Math.min(active, Math.max(items.length - 1, 0));
        hint.textContent = !models.length && !typed ? '这个接口还没有模型列表：直接输入模型名，回车确认。'
            : ql && !items.some((i) => !i.custom) ? '列表里没有匹配的模型。' : '';
        hint.hidden = !hint.textContent;
        list.replaceChildren(...items.map((it, i) => h('div', {
            class: 'mp-item' + (it.custom ? ' custom' : '') + (!it.custom && it.model === current ? ' selected' : ''),
            role: 'option', title: labels[it.model] ?? it.model, onclick: () => choose(it),
        }, it.custom ? `使用「${it.model}」` : labels[it.model] ?? it.model)));
        paintActive(true);
    }

    function place() {   // 放在按钮正下方；下面放不下就翻到上面；水平方向不超出视口
        const r = anchor.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const width = Math.min(360, vw - 16);
        const below = vh - r.bottom - 12, above = r.top - 12;
        const up = below < 220 && above > below;
        const room = Math.max(120, (up ? above : below) - 52);   // 52 = 筛选框和提示占的高度
        list.style.maxHeight = Math.min(320, room) + 'px';
        pop.style.width = width + 'px';
        pop.style.left = Math.max(8, Math.min(r.left, vw - width - 8)) + 'px';
        if (up) { pop.style.top = ''; pop.style.bottom = (vh - r.top + 4) + 'px'; }
        else { pop.style.bottom = ''; pop.style.top = (r.bottom + 4) + 'px'; }
    }

    const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); } };
    const onScroll = (e) => { if (!pop.contains(e.target)) close(); };   // 页面在别处滚动：位置对不上了，直接关
    function close() {
        if (openPop?.close !== close) return;
        openPop = null;
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close);
        window.removeEventListener('scroll', onScroll, true);
        pop.remove();
        anchor.setAttribute('aria-expanded', 'false');
    }

    input.addEventListener('input', () => { q = input.value; active = 0; draw(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paintActive(true); }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (items[active]) choose(items[active]);
        }
    });

    openPop = { container, anchor, close };
    anchor.setAttribute('aria-expanded', 'true');
    document.body.append(pop);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    active = Math.max(0, models.indexOf(current));   // 打开时高亮并滚到当前选中的那个
    place();   // 先定位再画：画的时候会 scrollIntoView，浮层还没 fixed 到位的话可能带着整页滚动
    draw();
    input.focus({ preventScroll: true });
}

// 每个选择器容器各自记着「在每个接口上最后选的模型」，只活在本次页面生命周期内（不进 state，不落盘）：
// 切到别的接口再切回来时恢复它；从没选过的接口一律是空，逼用户自己选（以前自动取列表第一个，碰到已下线的模型就 404）。
const lastModels = new WeakMap();   // 容器 → Map(接口 id → 模型名)
const memoOf = (c) => { let m = lastModels.get(c); if (!m) lastModels.set(c, m = new Map()); return m; };

/**
 * 把选择器画进 container。value 是 ModelRef；onChange(ref) 在用户改了接口或模型后调用。
 * 重复调用是廉价的：value 和接口缓存都没变就什么也不做（所以可以放心在 renderTopbar 里每次都调，不会打断浮层）。
 */
export function renderModelPicker(container, { value, onChange, compact = false }) {
    const opts = { value, onChange, compact };
    pickers.set(container, opts);
    const sig = `${version}|${value.endpoint}|${value.model}|${compact}`;
    if (container.__sig === sig && container.childNodes.length) return;
    container.__sig = sig;
    // 数据变了：开着的浮层（可能指向旧列表 / 旧选中值）直接关掉；它的按钮已经不在页面上了也一并收掉
    if (openPop && (openPop.container === container || !openPop.anchor.isConnected)) closePop();

    const ep = endpointById(value.endpoint);
    if (needsModel(ep) && value.model) memoOf(container).set(ep.id, value.model);
    const problem = refProblem(value);
    const set = (next, openAfter) => {
        onChange?.(next);
        renderModelPicker(container, { ...opts, value: next }); // 重画一遍：告警文字（「还没选模型」等）要跟着新值变
        if (openAfter) container.querySelector('.mp-model-btn')?.click();
    };

    const epSel = h('select', { title: '接口', 'aria-label': '接口',
        onchange: (e) => {
            const to = endpointById(e.target.value);
            const openai = needsModel(to);
            const model = openai ? (memoOf(container).get(to.id) ?? '') : '';
            // 切到还没选过模型的 OpenAI 类接口：model 留空（出现「还没选模型」告警），并直接把模型面板打开让用户选
            set({ endpoint: e.target.value, model }, openai && !model);
        } },
        endpointList().map((e) => h('option', { value: e.id, selected: e.id === value.endpoint }, e.name + (e.ready ? '' : '（未就绪）'))),
        // 引用指向的接口不在列表里：占一个位显示原因。网页版里指向内置接口的引用 = 还没选（这一项不可再选，选了别的就换掉它）
        ep ? null : h('option', { value: value.endpoint, selected: true, disabled: refUnpicked(value) },
            endpointsLoading() ? '加载中…' : refUnpicked(value) ? (hasUserEndpoints() ? '选择接口…' : '还没有接口') : '（已删除的接口）'));

    let modelCtl;
    if (!ep && refUnpicked(value)) {
        modelCtl = null;   // 还没选接口：没有模型可选，只留接口下拉和告警
    } else if (ep?.type === CLAUDE_ID) {
        const names = ep.models.includes(value.model) ? ep.models : [...ep.models, value.model];
        modelCtl = h('select', { title: '模型', 'aria-label': '模型', onchange: (e) => set({ endpoint: value.endpoint, model: e.target.value }) },
            names.map((m) => h('option', { value: m, selected: m === value.model }, CLAUDE_LABEL[m] ?? m)));
    } else {
        // openai 类 / Codex：按钮显示当前模型（长名字截断，title 给全名；一律 textContent），点开浮层选 / 筛选 / 手填。
        // Codex 的 '' 是「默认（跟随 Codex）」，不算没选
        const labels = ep?.type === 'codex-cli' ? CODEX_LABEL : {};
        const shown = value.model || labels[''] || '';
        const btn = h('button', { type: 'button', class: 'mp-model-btn' + (shown ? '' : ' empty'), disabled: !ep, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
            title: shown ? `模型：${shown}` : '还没选模型：点这里选择', 'aria-label': '模型' }, shown || '选择模型…');
        btn.addEventListener('click', () => {
            if (openPop?.anchor === btn) return closePop();   // 再点一次 = 收起
            openModelPop({ container, anchor: btn, models: ep.models, current: value.model, labels,
                onPick: (model) => set({ endpoint: value.endpoint, model }) });
        });
        modelCtl = btn;
    }

    const warn = problem && h('button', { type: 'button', class: 'mp-warn', title: `${problem}：点这里去「接口」页处理`,
        onclick: () => document.querySelector('#tabs button[data-tab="provider"]')?.click() },
        compact ? `⚠ ${problem}` : `⚠ ${problem}，请到「接口」页处理`);
    container.classList.toggle('compact', compact);
    container.classList.toggle('bad', !!problem);
    // 「接口」页顶上那个（#chat-model，带 data-sentence）嵌在一句话里：「使用 [接口] 的 [模型]」，所以两个控件之间补一个「的」
    const joiner = modelCtl && container.hasAttribute('data-sentence') ? [document.createTextNode(' 的 ')] : [];
    container.replaceChildren(epSel, ...joiner, ...(modelCtl ? [modelCtl] : []), ...(warn ? [warn] : []));
}
