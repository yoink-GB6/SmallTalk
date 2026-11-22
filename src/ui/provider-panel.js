// 「接口」页的面板：存好几个接口（不同厂商）并列出各自的可用模型。这里【没有】「当前用哪个」的开关——
// 聊天用哪个模型在本页顶部的「聊天用的模型」选，记忆压缩用哪个在「记忆」页选（见 model-picker.js）。
// 唯一的例外是每个模型旁的「用它聊天」快捷按钮：它不自己改 state，而是调用外面传进来的 chat.use（见 tab-provider.js），
// 所以这个文件仍然只依赖 ../llm.js（外加 ../openai-shared.js 里的常量）；DOM 全部用 createElement + textContent 构建（不拼 innerHTML，避免把服务端/上游返回的文字当 HTML）。
// API key 只会「从浏览器交给后端」（本地服务，或网页版里浏览器自己的存储），永远不会读回来：输入框渲染时恒为空、提交后清空，
// 只显示后端告知的 hasKey。两种后端（server / direct）的区别见 llm.js 文件头；这里只在说明文字上区分。
//
// 结构：每个接口一行（<details>），行里分几块各自更新——摘要、编辑表单、模型列表、测试。
// 对某个接口的操作只更新【那一行】的对应部分，不会重画别的行，也不会动编辑表单里没保存的输入。
import { listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, fetchEndpointModels, complete, backendKind } from '../llm.js';
import { CLI_TYPES as BUILTIN_TYPES } from '../openai-shared.js';   // 内置的命令行类接口的类型（纯常量，不是界面模块）

/** 小工具：建元素。props 里 text → textContent，其余当属性/事件处理。 */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'className') n.className = v;
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
}

const errText = (e) => String((e && e.message) || e);
const trimUrl = (s) => s.trim().replace(/\/+$/, '');
const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString(); };
const MANY = 12; // 模型多于这个数就显示筛选框

/**
 * 把「接口」面板渲染进 container（会清空它原有内容）。
 * @param {HTMLElement} container
 * @param {{onChange?: (endpoints: import('../types.js').PublicEndpoint[]) => void}} [options]
 *        读到列表、以及任何一次增删改之后都会调用，参数是最新的完整列表（本地服务版：claude-code、codex 排在最前；网页版没有它们）
 * @param {{current: () => import('../types.js').ModelRef, use: (ref: import('../types.js').ModelRef) => void}} [options.chat]
 *        「用它聊天」：current() 读现在聊天用的模型（用来高亮「聊天中」），use(ref) 把聊天模型改成 ref（保存、刷新顶栏都由外面做）。
 *        聊天模型在别处变了，外面往 container 上派发 'st-chatmodel' 事件，各行据此重新高亮。
 */
export function renderProviderPanel(container, { onChange, chat } = {}) {
  container.replaceChildren();
  let list = [];                       // 最新的 PublicEndpoint[]
  const status = el('div', { className: 'log-line dim', text: '正在读取接口列表…' });
  const claudeBox = el('div');
  const listBox = el('div', { className: 'ep-list' });
  const emptyNote = el('div', { className: 'dim' });
  let kind = 'server';                 // 'server' | 'direct'：探测完之前先按本地服务版写说明文字
  const modeBox = el('div', { className: 'ep-mode' });
  // 顶部一句话：数据存在哪。emptyNote 按形态区分：网页版里根本不列内置的命令行类接口（Claude Code、Codex），所以文字里也不提它们
  function paintMode() {
    emptyNote.textContent = kind === 'direct'
      ? '还没有添加接口。在下面添加一个 OpenAI 兼容的接口（DeepSeek、各种中转站……），再在本页最上面选它，就可以聊天了。'
      : '还没有添加接口。下面可以添加 OpenAI 兼容的接口（DeepSeek、各种中转站……），也可以只用上面内置的 Claude Code 或 Codex。';
    // 两种形态现在只留这一句（接口地址的写法提示挪进了地址输入框的 placeholder）。key 的存放位置没变：
    // 网页版在浏览器自己的存储里，本地版在本机服务端，页面都读不回来
    modeBox.className = 'ep-mode ' + kind;
    modeBox.replaceChildren(el('div', { className: 'dim', text: '模型和API Key仅保存在本设备' }));
  }
  paintMode();
  const say = (text, isError) => { status.className = 'log-line' + (isError ? ' error' : ' dim'); status.textContent = text; };
  const notify = () => { if (onChange) onChange(list.slice()); };
  const repaints = new Set();          // 每个接口行的 renderModels：聊天模型变了要让它们重新高亮
  container.addEventListener('st-chatmodel', () => repaints.forEach((f) => f()));
  const upsert = (ep) => { const i = list.findIndex((e) => e.id === ep.id); if (i < 0) list.push(ep); else list[i] = ep; notify(); };

  container.append(
    el('div', { className: 'section-title', text: '模型接口' }),
    modeBox, claudeBox, listBox, emptyNote, buildAddForm(), status);

  listEndpoints().then(async (eps) => {
    kind = await backendKind(); paintMode();
    list = eps; say('');
    // 内置的命令行类接口（只有本地服务版才有；网页版的列表里没有它们，这里就什么也不画）
    claudeBox.replaceChildren(...eps.filter((e) => BUILTIN_TYPES.includes(e.type)).map(builtinRow));
    for (const ep of eps) if (!BUILTIN_TYPES.includes(ep.type)) listBox.append(buildRow(ep, false));
    emptyNote.hidden = listBox.children.length > 0;
    notify();
  }, async (e) => {
    kind = await backendKind().catch(() => kind); paintMode();
    say('读取接口列表失败：' + errText(e) + (kind === 'direct' ? '（浏览器存储读不出来：可能是隐私模式或存储被禁用了）' : '（请确认本地服务 node server.mjs 正在运行，且是新版本）'), true);
    emptyNote.hidden = true;
  });

  // ── 内置的命令行类接口（Claude Code、Codex）：只读 ──
  function builtinRow(ep) {
    return el('div', { className: 'card ep' + (ep.type === 'codex-cli' ? ' ep-codex' : '') },
      el('div', { className: 'summary' },
        el('b', { text: ep.name }), ep.ready ? null : el('span', { className: 'badge bad', text: '未找到' }),   // 「可用」不显示，异常才标
        el('span', { className: 'dim', text: '内置，不可修改' })),
      el('div', { className: 'dim mono', text: ep.detail || '' }));
  }

  // ── 添加接口 ──
  function buildAddForm() {
    const nameI = el('input', { type: 'text', placeholder: '给它起个名字，如 DeepSeek', autocomplete: 'off' });
    const urlI = el('input', { type: 'text', placeholder: 'https://api.example.com/v1（不要带 /chat/completions）', autocomplete: 'off', spellcheck: 'false' });
    const keyI = el('input', { type: 'password', placeholder: 'API Key', autocomplete: 'new-password' });
    const addBtn = el('button', { type: 'button', className: 'primary', text: '添加接口', onclick: add });
    async function add() {
      addBtn.disabled = true;
      try {
        const body = { name: nameI.value, baseUrl: urlI.value };
        if (keyI.value.trim()) body.apiKey = keyI.value;
        const ep = await createEndpoint(body);
        nameI.value = ''; urlI.value = ''; keyI.value = '';
        listBox.append(buildRow(ep, true)); emptyNote.hidden = true;
        upsert(ep);
        say(`已添加「${ep.name}」。接下来可以点「获取模型列表」。`);
      } catch (e) { say('添加失败：' + errText(e), true); }
      finally { addBtn.disabled = false; keyI.value = ''; }   // 成功失败都清空密码框：key 不在 DOM 里多留
    }
    return el('div', { className: 'card ep ep-add' },
      el('div', { className: 'section-title', text: '添加接口' }),
      el('div', { className: 'kv' },
        el('label', { text: '备注' }), nameI, el('label', { text: '接口地址' }), urlI, el('label', { text: 'API Key' }), keyI),
      el('div', { className: 'row' }, addBtn));
  }

  // ── 一个接口一行 ──
  function buildRow(ep0, open) {
    let ep = ep0;
    const rowMsg = el('div', { className: 'log-line dim' });
    const rsay = (text, isError) => { rowMsg.className = 'log-line' + (isError ? ' error' : ' dim'); rowMsg.textContent = text; };
    const summary = el('summary');
    const dlId = 'ep-models-' + ep.id;

    // 编辑表单：key 栏永远是空的
    const nameI = el('input', { type: 'text', autocomplete: 'off' });
    const urlI = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://api.example.com/v1（不要带 /chat/completions）' });
    const keyI = el('input', { type: 'password', placeholder: '留空 = 不修改', autocomplete: 'new-password' });
    const keyBadge = el('span', { className: 'badge' });
    const clearBtn = el('button', { type: 'button', text: '清除', title: '删除已保存的 API Key', onclick: () => run(clearKey) });
    const saveBtn = el('button', { type: 'button', className: 'primary', text: '保存', onclick: () => run(save) });

    // 模型列表
    const modelsInfo = el('div', { className: 'dim' });
    const filterI = el('input', { type: 'text', placeholder: '筛选模型名单…', autocomplete: 'off', oninput: () => renderModels() });
    const modelList = el('div', { className: 'ep-models' });
    const addModelI = el('input', { type: 'text', placeholder: '手动添加模型名', autocomplete: 'off', spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); run(addModel); } } });
    const fetchBtn = el('button', { type: 'button', text: '获取模型列表', onclick: () => run(fetchModels) });
    const addModelBtn = el('button', { type: 'button', text: '添加', onclick: () => run(addModel) });

    // 测试
    const testI = el('input', { type: 'text', list: dlId, placeholder: '用哪个模型测试', autocomplete: 'off', spellcheck: 'false' });
    const dl = el('datalist', { id: dlId });
    const testBtn = el('button', { type: 'button', text: '测试连接', onclick: () => run(test) });
    const delBtn = el('button', { type: 'button', text: '删除接口', onclick: () => run(remove) });

    const buttons = [saveBtn, clearBtn, fetchBtn, addModelBtn, testBtn, delBtn];
    async function run(fn) { // 一次只跑一个动作：按钮都灰掉，免得连点
      buttons.forEach((b) => { b.disabled = true; });
      try { await fn(); } catch (e) { rsay(errText(e), true); }
      finally { buttons.forEach((b) => { b.disabled = false; }); clearBtn.disabled = !ep.hasKey; }
    }

    const dirty = () => nameI.value.trim() !== ep.name || trimUrl(urlI.value) !== ep.baseUrl || keyI.value.trim() !== '';

    /** 把服务端返回的最新状态画到这一行；resetForm = 同时把表单重置成已保存的值 */
    function apply(e, resetForm) {
      ep = e;
      // replaceChildren 会把 null 当成文字「null」画出来，所以要先滤掉
      summary.replaceChildren(...[
        el('b', { text: ep.name }), el('span', { className: 'dim mono', text: ep.baseUrl || '（没填地址）' }),
        // 「已保存」「可用」这两个正面状态不显示；没设 key / 未就绪这类异常照旧标出来
        ep.hasKey ? null : el('span', { className: 'badge', text: '未设置' }),
        ep.ready ? null : el('span', { className: 'badge bad', text: '未就绪', title: ep.detail || '' }),
        el('span', { className: 'badge', text: `${ep.models.length} 个模型` })].filter(Boolean));
      keyBadge.className = 'badge ' + (ep.hasKey ? 'on' : '');
      keyBadge.textContent = ep.hasKey ? '已保存' : '未设置';
      clearBtn.disabled = !ep.hasKey;
      dl.replaceChildren(...ep.models.map((m) => el('option', { value: m })));
      if (!testI.value) testI.value = ep.models[0] || '';
      if (resetForm) { nameI.value = ep.name; urlI.value = ep.baseUrl; keyI.value = ''; }
      renderModels();
    }

    function renderModels() {
      const q = filterI.value.trim().toLowerCase();
      const shown = q ? ep.models.filter((m) => m.toLowerCase().includes(q)) : ep.models;
      modelsInfo.textContent = ep.models.length
        ? `${ep.models.length} 个模型${ep.modelsFetchedAt ? ' · 获取于 ' + fmtTime(ep.modelsFetchedAt) : ' · 手动维护 / 未联网获取'}${q ? `；筛选出 ${shown.length} 个` : ''}`
        : '还没有模型：点「获取模型列表」，或在下面手动填一个模型名（有的中转站没有 /models）。';
      filterI.hidden = ep.models.length <= MANY;
      modelList.hidden = ep.models.length === 0;
      const cur = chat?.current();
      modelList.replaceChildren(...shown.map((m) => {
        const using = !!cur && cur.endpoint === ep.id && cur.model === m;
        // 用它聊天：接口没就绪（没 key 等）时灰掉并说明原因；已经是聊天模型的那行改成「聊天中」标记
        const useBtn = !chat ? null : using ? el('span', { className: 'badge on', text: '聊天中' })
          : el('button', { type: 'button', className: 'ep-use', text: '用它聊天', disabled: !ep.ready,
            title: ep.ready ? '把聊天用的模型设成这个（本页最上面的选择器会跟着变）' : '接口未就绪，不能用：' + (ep.detail || '请先补全地址和 Key'),
            onclick: () => chat.use({ endpoint: ep.id, model: m }) });
        return el('div', { className: 'ep-model' + (using ? ' using' : '') },
        el('span', { className: 'mono', text: m }), useBtn,
        el('button', { type: 'button', className: 'ghost', title: '从列表里移除这个模型名', text: '✕', onclick: () => run(() => removeModel(m)) }));
      }));
    }
    repaints.add(renderModels);

    // 保存：key 栏为空时【不带】apiKey 键 = 后端保持不变（清除要点「清除」按钮）
    async function save() {
      const patch = { name: nameI.value, baseUrl: urlI.value };
      if (keyI.value.trim()) patch.apiKey = keyI.value;
      keyI.value = '';   // 提交后马上清空密码框（失败了要重新填）：key 不在 DOM 里多留
      const hadKey = ep.hasKey;
      const e = await updateEndpoint(ep.id, patch);
      apply(e, true); upsert(e);
      // 后端在「地址换了站点又没给新 key」时会清掉旧 key：看返回的 hasKey 就知道，要明说，免得以为 key 还在
      rsay(hadKey && !e.hasKey && !patch.apiKey ? '接口地址换了站点，已清除旧密钥（旧站点的模型列表也清空了），请重新填写。' : '已保存。');
    }
    async function clearKey() {
      const e = await updateEndpoint(ep.id, { apiKey: '' });
      apply(e, false); upsert(e); keyI.value = '';
      rsay('已清除 API Key。');
    }
    // 获取 / 测试用的是已保存的地址和 key，所以有没保存的修改就先保存
    const saveIfDirty = async () => { if (dirty()) await save(); };
    async function fetchModels() {
      await saveIfDirty();
      rsay('正在获取模型列表…');
      const e = await fetchEndpointModels(ep.id);
      apply(e, false); upsert(e);
      rsay(`获取到 ${e.models.length} 个模型。`);
    }
    async function setModels(models) {
      const e = await updateEndpoint(ep.id, { models });
      apply(e, false); upsert(e);
    }
    async function addModel() {
      const v = addModelI.value.trim();
      if (!v) return;
      await setModels([...ep.models, v]);
      addModelI.value = '';
    }
    const removeModel = (m) => setModels(ep.models.filter((x) => x !== m));
    async function test() {
      await saveIfDirty();
      const model = testI.value.trim() || ep.models[0];
      if (!model) throw new Error('请先在「用哪个模型测试」里填一个模型名');
      rsay(`正在用 ${model} 测试…`);
      const t0 = Date.now();
      const reply = await complete('Reply with exactly: OK', 'ping', { endpoint: ep.id, model, params: { max_tokens: 64 } });
      rsay(`连接正常（${Date.now() - t0} ms），回复：${reply.trim().slice(0, 200) || '（空）'}`);
    }
    async function remove() {
      if (!confirm(`删除接口「${ep.name}」？它保存的 Key 和模型列表都会一起删掉。聊天用的模型 / 记忆页如果还在用它，会提示重新选择。`)) return;
      await deleteEndpoint(ep.id);
      row.remove(); repaints.delete(renderModels);
      list = list.filter((x) => x.id !== ep.id);
      emptyNote.hidden = listBox.children.length > 0;
      notify();
      say(`已删除「${ep.name}」。`);
    }

    const row = el('details', { className: 'card ep', ...(open ? { open: true } : {}) }, summary,
      el('div', { className: 'ep-body' },
        el('div', { className: 'kv' },
          el('label', { text: '备注' }), nameI, el('label', { text: '接口地址' }), urlI,
          el('label', { text: 'API Key' }), el('div', { className: 'row' }, keyI, keyBadge, clearBtn)),
        el('div', { className: 'row' }, saveBtn, delBtn),
        el('div', { className: 'section-title', text: '模型' }),
        modelsInfo, filterI, modelList,
        el('div', { className: 'row' }, fetchBtn, addModelI, addModelBtn),
        el('div', { className: 'section-title', text: '测试' }),
        el('div', { className: 'row' }, testI, dl, testBtn),
        rowMsg));
    apply(ep, true);
    return row;
  }
}
