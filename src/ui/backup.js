// 「杂项」页的「整体备份」：备份全部数据 / 从备份恢复。读存储、落盘、弹框、提示。
// 要写哪些记录由 src/backup.js 的纯函数算；加密 / 解密在 src/backup-crypto.js。
//
// 用途：换设备（电脑 ↔ 手机、换浏览器、从本地版搬到网页版）。整体备份就是全部，没有勾选：
// 所有卡和存档、所有预设、全局设置、接口列表（网页版连 key 一起）。单张卡 / 世界书 / 存档按酒馆格式导出在别处。
//
// ── 导出（exportAll）──
//   1. 先落盘（只读标签页不落盘，导出存储里已经保存的内容），一个事务里读出 global / card:* / chat:* / preset:*（同一时刻的快照）
//   2. 问接口层要接口列表：exportEndpointsForBackup()（llm.js，key 离开接口层的唯一通道），以及两个模型引用指向的接口地址
//   3. 弹导出对话框：小计、密码（含 key 时必填且至少 8 位）、各种提醒。确认后在对话框里显示「正在加密…」
//   4. 含 key 或设了密码 → 整个备份 JSON 用密码加密（encryptBackup）→ 下载；否则下载明文 JSON
//
// ── 恢复（importBackupFile）── 任何一步取消都是什么都不写；所有弹框都在拿锁、暂停保存之前问完
//   1. 读文件、校验整体形状（parseBackup）。加密的：弹密码框（可重试），解密后再 parseBackup 一次
//   2. 判断是不是「空的浏览器」（isEmptyForRestore）：是 → 换新设备，内容和三样设置按备份原样恢复，不问；
//      当前在用的选择（当前预设、人设、接口和模型……）用默认值（规则见 backup.js「全局记录的三类字段」）
//      否则 → 备份里有可应用的设置（settingsInBackup：外置记忆设置、上下文上限、世界书扫描设置）时弹框只问一句
//      「是否应用备份中的……」（是 / 否 / 取消）。内容两种回答下都取并集；当前选择两种回答下都保持本机的
//   3. 盖上「正在恢复…」的遮罩（withRestoreOverlay：整页点不动、键盘也挡住，结束后一定撤掉），
//      拿存档层的锁（archive.js 的 op：生成中 / 只读 / 正在切换时拒绝），先落盘，然后暂停保存（persist.paused）
//   4. 一个事务里读出所有已有的卡 / 存档 / 预设，算出导入计划（planBackupImport，纯函数）；空浏览器的判断在这里再核对一次
//   5. 一个事务里写入全部新记录 + 新卡的目录 + （并进已有卡的）目录补条目 + 并进本机已有存档的划线（只改那条记录的 highlights）+ 新的 global（内容并集 + 设置；什么都没变时不写），详见 doImport 的注释
//   6. 逐条读回比较；不一致就把这次新建的键删掉、把改过的目录 / 存档记录（并划线的）/ global 还原
//   7. 内存跟上：预设列表、当前卡的目录、（写了 global 时）重读全局层；恢复保存，补一次保存，刷新界面
//   8. 接口：逐个新建 / 补 key（失败只影响接口这一项）。聊天 / 记忆用的模型【不】自动指到新建的接口上（当前选择不从备份拿）
//   9. 原来一张卡都没有：切到备份里原来的当前卡 / 存档
//
// ── API key 的路径（这一节是本文件最要紧的约束）──
//   导出：exportEndpointsForBackup() 的返回值 → endpointsForExport() 清洗 → 只放进局部变量 full.endpoints（和 secrets，用来最后自检）
//         → JSON.stringify(full) 得到局部变量 text → encryptBackup(text, 密码) → 只有密文进入要下载的文本 → 下载后这些变量全部置空。
//         含 key 时不可能走到「不加密」那条路（对话框不放行，下载前还有一道自检 exportSelfCheck：加密的必须是只有已知头部 + 密文的容器，
//         明文的必须不含 key、任何一层都没有 apiKey 键；另在非密文部分搜一遍 key）。
//   恢复：加密文件 → decryptBackup → 局部变量 plain → parseBackup(plain, {fromEncrypted: true})（只有这时才保留 apiKey）
//         → parsed.backup.endpoints → importEndpoints 里交给 createEndpoint / updateEndpoint（接口层的正常写入路径）→ 置空。
//   key 和备份明文从不写进 state、不进 DOM、不进 console、不进 toast / 报错文字（报错只用我们自己写的中文句子和接口层已抹 key 的文字）。

import { store } from '../store.js';
import { cardKey, chatKey, indexKey, presetKey, indexEntry } from '../migrate.js';
import { buildBackup, backupFileName, parseBackup, planBackupImport, mergeIndex, mergeChatHighlights, summaryText, countBackup, isEmptyForRestore,
    endpointsForExport, planEndpointImport, endpointSummaryText, settingsInBackup, exportSelfCheck, apiKeyFieldPlace, presetSensitivePlace, endpointHost } from '../backup.js';
import { encryptBackup, decryptBackup, cryptoAvailable, BackupCryptoError } from '../backup-crypto.js';
import { listEndpoints, createEndpoint, updateEndpoint, exportEndpointsForBackup, backendKind } from '../llm.js';
import { h, toast, uid, download } from './dom.js';
import { ui, persist, presets, flushNow, presetBlocked, reloadGlobalFromStore, reloadCardVars, stopSaving, STOPPED_TEXT, adoptRestoredHighlights } from './state.js';
import { runArchiveOp, openChat, showStoreError } from './archive.js';
import { renderAll } from './shell.js';
import { stopScripts, reconcileScripts } from './script-host.js';   // 循环依赖：只在函数体里调用
import { CARDVARS_PREFIX, cardVarsKey, unionCardVars } from '../cardvars.js';
import { invalidateArchiveTab } from './tab-archive.js';
import { refreshEndpoints } from './tab-provider.js';   // 循环依赖：只在函数体里调用

let exporting = false;
let importing = false;

// cardvars:<cardId>（脚本变量、角色卡变量，cardvars.js）跟着卡进备份（buildBackup 把它挂在卡那一项的 vars 上）
const isBackupKey = k => k === 'global' || k.startsWith('card:') || k.startsWith('chat:') || k.startsWith('preset:') || k.startsWith(CARDVARS_PREFIX);
const isLegacyKey = k => k === 'state' || k.startsWith('state.v1.bak');
const MIN_PW_WITH_KEYS = 8;

/**
 * 一个事务里读出这些键的值（同一时刻的快照：读的途中别的写入插不进来）。
 * 借用 store.transact（读-改-写）：返回空的写列表，就是一次只读。
 */
async function readSnapshot(keys) {
    let values = [];
    await store.transact(keys, v => { values = v; return []; });
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

const pwLen = s => [...s].length;   // 按字符数（emoji、汉字都算一个），不按 UTF-16 码元

// ───────────────────────────── 页内弹框 ─────────────────────────────
//
// 都是 JS 动态建的页内弹层（bk-overlay / bk-panel 样式），Esc、点遮罩外面 = 取消。不用 confirm / prompt。

/**
 * 只有几个按钮的对话框，返回用户点的按钮的 value；Esc / 点遮罩外面 / 点取消（value 为 null）返回 null。
 * getValue：点非取消按钮时再算一次要返回的东西（模型弹框要带上单选框的选择）
 */
function askDialog({ label, fk, lead, body = [], buttons, getValue }) {
    return new Promise(resolve => {
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        const close = result => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
        const btns = buttons.map(b => h('button', { type: 'button', class: b.primary ? 'primary' : '', 'data-fk': b.fk,
            onclick: () => close(b.value === null ? null : (getValue ? getValue(b.value) : b.value)) }, b.text));
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': fk, onmousedown: e => { if (e.target === overlay) close(null); } },
            h('div', { class: 'bk-panel imp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
                h('div', { class: 'bk-head' }, h('b', null, label)),
                h('div', { class: 'bk-body imp-body' }, h('p', { class: 'imp-lead' }, lead), ...body),
                h('div', { class: 'bk-foot' }, ...btns)));
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        (btns[buttons.findIndex(b => b.primary)] ?? btns[0]).focus();
    });
}

/**
 * 带输入框、确认后要「干一会儿活」的对话框（导出时加密、恢复时解密）。
 *   validate()：点确认时先检查输入，返回给人看的原因就不继续
 *   run()：真正干活，期间显示 busyText、禁用所有按钮和输入框、Esc / 点遮罩不响应；
 *          返回 {error} = 失败，留在对话框里显示原因（可以改了再试）；返回 {value} = 成功，对话框关闭并把 value 交出去
 * 关闭时清空所有输入框（密码不留在 DOM 里）。取消返回 null。
 */
function workDialog({ label, fk, body, okText, okFk, cancelFk, validate, run, busyText, focusEl }) {
    return new Promise(resolve => {
        let busy = false, closed = false;
        const errEl = h('p', { class: 'bkx-error', 'data-fk': `${fk}-error`, role: 'alert', hidden: true });
        const busyEl = h('p', { class: 'bkx-busy', 'data-fk': `${fk}-busy`, 'aria-live': 'polite', hidden: true }, busyText);
        const showErr = t => { errEl.textContent = t || ''; errEl.hidden = !t; };
        const okBtn = h('button', { type: 'button', class: 'primary', 'data-fk': okFk }, okText);
        const cancelBtn = h('button', { type: 'button', 'data-fk': cancelFk }, '取消');
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': fk, onmousedown: e => { if (e.target === overlay && !busy) close(null); } },
            h('div', { class: 'bk-panel imp-panel bkx-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
                h('div', { class: 'bk-head' }, h('b', null, label)),
                h('div', { class: 'bk-body imp-body' }, ...body, errEl, busyEl),
                h('div', { class: 'bk-foot' }, cancelBtn, okBtn)));
        const setBusy = on => {
            busy = on;
            busyEl.hidden = !on;
            overlay.setAttribute('aria-busy', String(on));
            for (const el of overlay.querySelectorAll('button, input')) el.disabled = on;
        };
        const close = result => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            for (const i of overlay.querySelectorAll('input')) i.value = '';
            overlay.remove();
            resolve(result);
        };
        const submit = async () => {
            if (busy || closed) return;
            const why = validate ? validate() : null;
            if (why) { showErr(why); return; }
            showErr('');
            setBusy(true);
            // 让「正在加密…」先画出来再开始算（PBKDF2 在手机上要一两秒）
            await new Promise(r => setTimeout(r, 30));
            let r;
            try { r = await run(); } catch (e) { r = { error: e instanceof BackupCryptoError ? e.message : `出错了：${e?.message ?? e}` }; }
            if (closed) return;
            setBusy(false);
            if (r && r.error) { showErr(r.error); return; }
            close(r ? r.value : true);
        };
        const onKey = e => {
            if (busy) { if (e.key === 'Escape') e.stopPropagation(); return; }
            if (e.key === 'Escape') { e.stopPropagation(); close(null); }
            else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && overlay.contains(e.target)) { e.preventDefault(); submit(); }
        };
        okBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => { if (!busy) close(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        (focusEl ?? okBtn).focus();
    });
}

/** 密码框 + 「显示密码」开关。返回 {inputs, toggle}；toggle 切换这些输入框的 type */
function passwordInputs(specs) {
    const inputs = specs.map(s => h('input', { type: 'password', class: 'bkx-pw', autocomplete: s.autocomplete, 'data-fk': s.fk, 'aria-label': s.label,
        autocapitalize: 'off' }));
    const box = h('input', { type: 'checkbox', 'data-fk': 'bkx-show' });
    box.addEventListener('change', () => { for (const i of inputs) i.type = box.checked ? 'text' : 'password'; });
    const toggle = h('label', { class: 'bkx-show' }, box, h('span', null, '显示密码'));
    return { inputs, toggle };
}

// ───────────────────────────── 导出 ─────────────────────────────

/** 「备份全部数据」 */
export async function exportAll() {
    if (exporting) return;
    exporting = true;
    // 这几个变量里会有明文的备份和 key：只在这个函数里、只活到下载完成
    let full = null, secrets = [];
    try {
        const ro = persist.readOnly || persist.stopped;
        if (!ro && !await flushNow()) { toast('当前内容没能保存，已取消备份（不然备份的不是最新的）', 'error'); return; }
        const keys = await store.keys('');
        const entries = await readSnapshot(keys.filter(isBackupKey));
        // 旧版本的数据只看在不在，不读（可能很大），也不导出
        for (const k of keys.filter(isLegacyKey)) entries[k] = null;
        const now = new Date();
        const built = buildBackup(entries, { now });
        full = built.backup;
        const kind = await backendKind();

        // 接口列表不在存储的 global 里（本地服务版在服务端文件，网页版在单独的 'endpoints' 键），要问接口层要。
        // 读不到就不带接口，但要在对话框里说清楚（网页版里这意味着 key 没进备份）
        let epError = '';
        try {
            // 不再记 refEndpoints（「聊天 / 记忆用的模型指向哪个接口地址」）：接口和模型是当前在用的选择，不进备份
            const eps = endpointsForExport(await exportEndpointsForBackup());
            if (eps.length) full.endpoints = eps;
        } catch (e) {
            epError = `读不到接口列表（${e?.message ?? e}），这次备份不含接口`;
            delete full.endpoints;
        }
        secrets = (full.endpoints ?? []).map(e => e.apiKey).filter(k => typeof k === 'string' && k);
        const n = countBackup(full);
        const hasKeys = secrets.length > 0;
        const canEncrypt = cryptoAvailable();
        if (hasKeys && !canEncrypt) {
            toast('这个浏览器现在不能加密（需要用 https:// 或 localhost / 127.0.0.1 打开页面）。备份里有 API key，不加密不能导出，所以没有导出。', 'error');
            return;
        }

        const result = await askExport({ n, hasKeys, server: kind === 'server', epError, canEncrypt, readOnly: persist.readOnly, run: async password => {
            // 没设密码 = 明文文件：只有不含 key 时才允许走到这里（对话框已经拦过，这里再拦一次）
            if (!password && hasKeys) return { error: '这个备份里有 API key，必须设密码' };
            if (!password && full.endpoints) full.endpoints = full.endpoints.map(({ apiKey: _k, ...rest }) => rest);
            let text = JSON.stringify(full);
            let out;
            if (password) {
                const file = await encryptBackup(text, password, { hasKeys, now });
                out = JSON.stringify(file);
            } else {
                out = text;
            }
            text = null;
            // 最后一道检查（规则见 backup.js exportSelfCheck：结构断言为主，只在非密文部分搜 key）。
            // 控制台只记原因代号，不记 key、不记文件内容
            const why = exportSelfCheck(out, { encrypted: !!password, hasKeys, secrets, plain: full });
            if (why) {
                console.error('备份下载前自检没通过：', why);
                // 明文备份里有名为 apiKey 的字段：多半是用户的内容里恰好有这么个字段（比如一个叫 apiKey 的全局变量，
                // 或导入的卡 / 世界书里带着），不是接口的 key 漏了出来。说清楚是哪一类内容、怎么办；自检本身不放宽
                if (why === 'apikey-field') {
                    const place = apiKeyFieldPlace(full) ?? '备份的内容';
                    return { error: `为了安全没有下载：${place}里有一个名叫 apiKey 的字段，看起来像 API key，不能放进不加密的文件。`
                        + `可以设一个密码加密导出；或者到对应的地方把它改个名字（或删掉）再导出。` };
                }
                // 预设里还带着酒馆的连接信息（buildBackup 已经去掉了，走到这里说明哪条路漏了）：只说预设名和类别，不说值
                if (why === 'preset-sensitive') {
                    const p = presetSensitivePlace(full);
                    return { error: `为了安全没有下载：预设${p ? `「${p.name}」` : ''}里还带着酒馆的连接信息（${p ? p.categories.join('、') : '反代地址 / 密码等'}），不应该出现在备份里。这是程序的问题，请反馈` };
                }
                return { error: '为了安全没有下载：检查发现要下载的内容里可能带有未加密的 key。这是程序的问题，请反馈' };
            }
            download(backupFileName(now, { hasKeys, encrypted: !!password }), out);
            return { value: { encrypted: !!password } };
        } });
        if (!result) return;   // 取消：什么都不下载

        const bits = [`已备份 ${n.cards} 张卡、${n.chats} 个存档、${n.presets} 个预设${n.global ? '、全局设置' : ''}${n.endpoints ? `、${n.endpoints} 个接口${hasKeys ? `（${n.keys} 个带 API key）` : kind === 'server' ? '（不含 API key）' : ''}` : ''}`
            + (result.encrypted ? '，文件已用你的密码加密' : '，文件没有加密')];
        if (built.legacyKeys.length) bits.push('旧版本的备份数据没有包含在内');
        if (built.orphanChats) bits.push(`${built.orphanChats} 个存档找不到所属的角色卡（界面上也看不到），没有备份`);
        if (epError) bits.push(epError);
        if (persist.readOnly) bits.push('这个标签页是只读的：备份的是存储里已经保存的内容，这个页面上没保存的改动不在里面');
        toast(bits.join('；'), 'ok');
    } catch (e) {
        console.error('备份失败', e?.message ?? e);
        toast(`备份失败：${e instanceof BackupCryptoError ? e.message : (e?.message ?? e)}`, 'error');
    } finally {
        full = null; secrets = [];
        exporting = false;
    }
}

/**
 * 导出对话框。返回 run 的 value（成功下载），取消返回 null。
 * @param {{n: ReturnType<typeof countBackup>, hasKeys: boolean, server: boolean, epError: string, canEncrypt: boolean, readOnly: boolean,
 *          run: (password: string) => Promise<{error?: string, value?: any}>}} o
 */
function askExport({ n, hasKeys, server, epError, canEncrypt, readOnly, run }) {
    const { inputs: [pw1, pw2], toggle } = passwordInputs([
        { fk: 'bkx-pw1', label: '密码', autocomplete: 'new-password' },
        { fk: 'bkx-pw2', label: '再输一遍密码', autocomplete: 'new-password' },
    ]);
    const sum = `将备份：${n.cards} 张卡、${n.chats} 个存档、${n.presets} 个预设、${n.global ? '全局设置' : '（还没有保存过全局设置）'}、${n.endpoints} 个接口${n.endpoints ? `（其中 ${n.keys} 个带 API key）` : ''}`;
    const body = [
        h('p', { class: 'imp-sum', 'data-fk': 'bkx-sum' }, sum),
        h('p', { class: 'dim imp-note' }, '用来换设备（电脑 ↔ 手机、换浏览器、从本地版搬到网页版）。文件只保存在你自己的设备上，SmallTalk 不会上传到任何地方。'),
    ];
    if (readOnly) body.push(h('p', { class: 'dim imp-note' }, '这个标签页是只读的：备份的是存储里已经保存的内容。'));
    if (epError) body.push(h('p', { class: 'bkx-warn' }, epError));
    if (hasKeys) {
        body.push(h('p', { class: 'bkx-warn', 'data-fk': 'bkx-keys-warn' },
            `这个备份里有 ${n.keys} 个接口的 API key，所以必须设密码：整个文件（卡、聊天、预设、设置、接口和 key）都会用这个密码加密。密码至少 ${MIN_PW_WITH_KEYS} 位。`));
    } else if (server) {
        body.push(h('p', { class: 'bkx-note', 'data-fk': 'bkx-server-note' },
            '这个版本（本地服务版）的 API key 保存在本机程序里，不会进备份；换设备后需要到「接口」页重新填。备份里的接口只有名字、地址和模型名单。'));
    } else if (n.endpoints) {
        body.push(h('p', { class: 'dim imp-note' }, '这些接口都没有填 API key，备份里只有名字、地址和模型名单。'));
    }
    if (canEncrypt) {
        body.push(
            h('div', { class: 'bkx-pwrow' }, h('label', null, h('span', null, '密码'), pw1), h('label', null, h('span', null, '再输一遍'), pw2), toggle),
            hasKeys ? null : h('p', { class: 'dim imp-note' }, '密码可以留空：留空就是不加密的普通 JSON 文件，任何拿到它的人都能直接看到里面的聊天记录。'),
            h('p', { class: 'bkx-warn', 'data-fk': 'bkx-forget' },
                '忘了密码，这个备份就打不开，没有任何找回办法。密码不会保存在任何地方（这个页面、浏览器、文件里都没有）。'
                + (hasKeys ? '含 API key 的文件即使加密了，也不要发给别人。' : '')));
    } else {
        // 不含 key 才会走到这里（含 key 又不能加密时 exportAll 已经拒绝了）
        body.push(h('p', { class: 'bkx-note' }, '这个浏览器现在不能加密（页面不是用 https:// 或 localhost / 127.0.0.1 打开的），只能导出不加密的普通 JSON 文件。'));
    }
    return workDialog({
        label: '备份全部数据', fk: 'bkx-export-dialog', body, okText: '备份并下载', okFk: 'bkx-confirm', cancelFk: 'bkx-cancel',
        busyText: '正在加密…（手机上可能要一两秒）',
        focusEl: canEncrypt ? pw1 : null,
        validate: () => {
            if (!canEncrypt) return null;
            const a = pw1.value, b = pw2.value;
            if (hasKeys && !a) return '这个备份里有 API key，必须设密码';
            if (a !== b) return '两次输入的密码不一样';
            if (hasKeys && pwLen(a) < MIN_PW_WITH_KEYS) return `密码太短：含 API key 的备份，密码至少 ${MIN_PW_WITH_KEYS} 位`;
            return null;
        },
        run: () => run(canEncrypt ? pw1.value : ''),
    });
}

// ───────────────────────────── 恢复 ─────────────────────────────

/** 现在能不能恢复：和存档操作、预设操作的拒绝条件一致 */
function importBlocked() {
    if (persist.stopped) return STOPPED_TEXT;
    if (persist.readOnly) return '存储处于只读状态（见页面顶上的说明），不能恢复';
    if (ui.busy) return '正在生成回复，等它结束（或点「停止」）再恢复';
    if (ui.switching) return '正在切换存档，稍等一下';
    return presetBlocked();   // 预设存储正在升级 / 读取、上一个预设操作没做完……
}

/** 「空浏览器」判定里和接口有关的两项：是不是网页版、网页版里有几个用户自己加的接口。第一次判定和拿锁后的再核对都用它 */
async function endpointFacts() {
    const direct = await backendKind() === 'direct';
    let userEndpoints = 0;
    if (direct) userEndpoints = (await listEndpoints()).filter(e => e.type === 'openai').length;
    return { direct, userEndpoints };
}

/** 这个浏览器是不是「空的」（换新设备）。只读不写 */
async function isFreshBrowser() {
    const keys = await store.keys('');
    return isEmptyForRestore({
        cardKeys: keys.filter(k => k.startsWith('card:')).length, presetKeys: keys.filter(k => k.startsWith('preset:')).length,
        liveCard: !!persist.cardId, global: await store.get('global'), ...await endpointFacts(),
    });
}

/** 三样设置在弹框里的叫法（顺序和 backup.js SETTING_KEYS 一致） */
const SETTING_TEXT = { memory: '外置记忆设置', contextLimit: '上下文上限', wi: '世界书扫描设置' };

/**
 * 弹框：恢复到已有数据的浏览器、备份里有可应用的设置时，只问一句「是否应用备份中的……」。
 * 返回 'yes' | 'no' | null（取消 / Esc / 点外面 = 什么都不导入）。
 * 内容（卡、存档、预设、人设、世界书、正则、便签、接口）两种回答下都是只加不删；当前在用的预设、模型、人设两种回答下都不变。
 * @param {Object} backup
 * @param {string[]} keys  settingsInBackup 的结果（备份里实际有的那几样，只问这几样）
 */
function askSettings(backup, keys) {
    const n = countBackup(backup);
    const sum = `这次将导入：${n.cards} 张卡、${n.chats} 个存档、${n.presets} 个预设${n.endpoints ? `、${n.endpoints} 个接口${n.keys ? `（其中 ${n.keys} 个带 API key）` : '（没有 key，需要之后到「接口」页填）'}` : ''}，以及备份里的人设、世界书、正则、便签、全局变量。`;
    const what = keys.map(k => SETTING_TEXT[k]).join('、');
    return askDialog({
        label: '是否应用备份中的设置', fk: 'imp-settings-dialog',
        lead: '这个浏览器里已经有数据了。角色卡、存档、预设、人设、世界书、正则、便签、接口都是只加不删：备份里有而这里没有的加进来，这里原有的不删不改。'
            + '你当前用的预设、模型、人设不会变。',
        body: [
            h('p', { class: 'imp-sum', 'data-fk': 'imp-sum' }, sum),
            h('p', { class: 'imp-question', 'data-fk': 'imp-settings-question' }, `是否应用备份中的${what}？`),
        ],
        // 默认按钮（主按钮样式、初始焦点）是「否」：手滑按了回车，保留的是本机的设置，不会被备份里的悄悄换掉。
        // 「是」是普通按钮样式，文字写清楚两个按钮各是什么意思
        buttons: [
            { text: '取消', value: null, fk: 'imp-cancel' },
            { text: '否（保留这里的设置）', value: 'no', fk: 'imp-settings-no', primary: true },
            { text: '是（用备份里的）', value: 'yes', fk: 'imp-settings-yes' },
        ],
    });
}

// ───────────────────────────── 「正在恢复…」遮罩 ─────────────────────────────
//
// 为什么要它（独立复核查出的问题）：恢复期间保存是暂停的（persist.paused），结束时 reloadGlobalFromStore 用存储里的值覆盖内存。
// 这期间用户在页面上改的东西（人设描述、世界书 / 正则的开关、记忆设置……）都会被悄悄丢掉，人设描述框还会「屏幕上是新字、内存里是旧值」。
// 所以恢复（以及酒馆 zip 导入的写入阶段）进行中，整个页面盖一层不可操作的遮罩：
//   - 页面上其它所有元素设成 inert（点不到、Tab 走不进去、读屏也跳过），焦点挪到遮罩上；
//   - 再在捕获阶段吞掉所有键盘事件：inert 挡不住挂在 document 上的快捷键（焦点在 body 上时它们照样收得到）；
//   - 先盖遮罩、再拿锁落盘：焦点离开输入框时触发的 change（有的输入框是 change 时才写 state）发生在落盘之前，会被一起保存。
// 结束（成功或失败）一定撤掉：withRestoreOverlay 用 finally。

let overlays = 0;   // 现在盖着几层「正在恢复…」遮罩（restoreActive 用）

/**
 * 现在是不是正在恢复 / 写入（遮罩盖着、恢复流程在跑、或者保存暂停着）。
 * 遮罩用 inert 挡住了点击和键盘，却挡不住【拖文件进页面】（drop 监听挂在 window 上）和别处触发的文件选择框：
 * 那时导入的世界书 / 正则会直接改 state、提示「已导入」，随后被恢复结束时的 reloadGlobalFromStore 盖掉——东西悄悄丢了。
 * 所以 app.js 的拖放和 importer.js 的 importFiles 都先问它，是就拒绝（复核查出的问题）。
 */
export const restoreActive = () => overlays > 0 || importing || persist.paused;

/** 盖上遮罩，返回撤掉它的函数（可以重复调用） */
function showRestoreOverlay(text) {
    overlays++;
    const panel = h('div', { class: 'bk-panel imp-panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-busy': 'true', 'aria-label': text, tabindex: '-1' },
        h('div', { class: 'bk-body imp-body' }, h('p', { class: 'bkx-busy', 'aria-live': 'polite' }, text)));
    const overlay = h('div', { class: 'bk-overlay imp-overlay restore-overlay', 'data-fk': 'restore-overlay' }, panel);
    // 已经是 inert 的元素（比如别的弹框正开着时它们设的）不动，撤掉时也不动它们
    const made = [...document.body.children].filter(el => !el.inert);
    for (const el of made) el.inert = true;
    const swallow = e => { e.preventDefault(); e.stopImmediatePropagation(); };
    for (const t of ['keydown', 'keypress', 'keyup']) window.addEventListener(t, swallow, true);
    document.body.append(overlay);
    panel.focus();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        overlays--;
        for (const t of ['keydown', 'keypress', 'keyup']) window.removeEventListener(t, swallow, true);
        overlay.remove();
        for (const el of made) el.inert = false;
    };
}

/** 在遮罩下面跑 fn；不管成功、失败还是抛错，遮罩都会被撤掉 */
export async function withRestoreOverlay(text, fn) {
    const hide = showRestoreOverlay(text);
    try { return await fn(); } finally { hide(); }
}

/**
 * 密码框（加密的备份）。解密在对话框里做（显示「正在解密…」）；密码不对留在框里重试。
 * 返回解出来的明文 JSON 文本；取消返回 null。
 */
function askPassword(file, fileName) {
    const { inputs: [pw], toggle } = passwordInputs([{ fk: 'bkx-pass', label: '密码', autocomplete: 'off' }]);
    return workDialog({
        label: '这个备份是加密的', fk: 'bkx-pass-dialog', okText: '解密并恢复', okFk: 'bkx-pass-ok', cancelFk: 'bkx-pass-cancel',
        body: [
            h('p', { class: 'imp-lead' }, `「${fileName}」是加密的备份，请输入导出时设的密码。`),
            file.hasKeys ? h('p', { class: 'dim imp-note' }, '文件头上标着：这个备份里带着 API key。') : null,
            h('div', { class: 'bkx-pwrow' }, h('label', null, h('span', null, '密码'), pw), toggle),
        ],
        busyText: '正在解密…（手机上可能要一两秒）',
        focusEl: pw,
        validate: () => (pw.value ? null : '请输入密码'),
        run: async () => {
            try { return { value: await decryptBackup(file, pw.value) }; } catch (e) {
                if (e instanceof BackupCryptoError && e.code === 'wrong-password') { pw.select?.(); return { error: `${e.message}。可以再试一次。` }; }
                throw e;
            }
        },
    });
}

/** 选中了一个备份文件 */
export async function importBackupFile(file) {
    if (importing) return;
    const why = importBlocked();
    if (why) return void toast(why, 'error');
    importing = true;
    // parsed.backup 里可能有从加密容器解出来的 key：只活在这个函数里
    let parsed = null;
    try {
        let text;
        try { text = await file.text(); } catch (e) { return void toast(`读不了「${file.name}」：${e?.message ?? e}`, 'error'); }
        parsed = parseBackup(text);
        text = null;
        if (parsed.encrypted) {
            let plain;
            try { plain = await askPassword(parsed.file, file.name); } catch (e) {
                return void toast(`没有恢复「${file.name}」：${e instanceof BackupCryptoError ? e.message : (e?.message ?? e)}。什么都没有写入。`, 'error');
            }
            if (plain === null) { parsed = null; return; }   // 取消：什么都不做
            parsed = parseBackup(plain, { fromEncrypted: true });
            plain = null;
        }
        if (!parsed.ok) return void toast(`没有恢复「${file.name}」：${parsed.error}。什么都没有写入。`, 'error');
        const { backup } = parsed;

        // 「空的浏览器」= 换新设备：不问，全部恢复（含全局设置）。先落盘：页面上没保存的改动也算「已有数据」
        if (!await flushNow()) return void toast('当前内容没能保存，已取消恢复', 'error');
        const fresh = await isFreshBrowser();

        // 先把问题问完，再进入「拿锁 → 写入」。弹框期间不持有锁、不暂停保存；点了取消就整个不导入。
        // 空浏览器不问（三样设置直接用备份里的）；已有数据时，备份里一样可应用的设置都没有也不问（没有可应用的）
        let applySettings = false;
        if (!fresh) {
            const keys = settingsInBackup(backup.global);
            if (keys.length) {
                const choice = await askSettings(backup, keys);
                if (!choice) return;
                applySettings = choice === 'yes';
            }
        }

        let result = null;
        await withRestoreOverlay('正在恢复…（请稍等，期间页面不能操作）', async () => {
            await runArchiveOp(async () => { result = await doImport(backup, { applySettings, fresh }); });
        });
        invalidateArchiveTab();
        if (!result) return;
        const { plan, switchTo } = result;
        // 接口：和卡 / 存档的写入互不相干，放在它们成功之后；失败只影响接口这一项。
        // 聊天 / 记忆用的模型不会因此改指到新建的接口上（当前选择不从备份拿）
        const ep = backup.endpoints ? await importEndpoints(backup.endpoints) : null;
        delete backup.endpoints;   // 里面可能有 key：用完就丢
        // 选择器、顶栏告警用的是接口列表的缓存（model-picker.js）：新建了接口要重读一次，不然要刷新页面才选得到它们，
        // 顶栏还会说「还没添加接口」——而恢复后聊天用的接口和模型正是要用户自己去选的
        if (ep) { try { await refreshEndpoints(); } catch (e) { console.warn('重读接口列表失败', e?.message ?? e); } }
        plan.summary.notes.push(...parsed.notes);
        if (fresh) plan.summary.notes.push('当前用的预设、人设、接口和模型没有从备份里带过来：预设用的是恢复进来的第一个（没有就是内置默认），人设是列表里第一个；'
            + '聊天用的接口和模型请在页面顶部选一下（外置记忆压缩用的在「记忆」页选）');
        if (plan.summary.skipped.length || plan.summary.renamed.length) console.warn('从备份恢复：', { 跳过: plan.summary.skipped, 改名: plan.summary.renamed });
        const head = fresh ? '恢复完成（这个浏览器原来是空的，已按备份恢复了全部内容）' : '从备份导入完成';
        toast(`${head}：${summaryText(plan.summary)}${ep ? '；' + ep.text : ''}`, plan.summary.skipped.length || ep?.failed ? 'error' : 'ok');
        // 原来一张卡都没有（全新的浏览器）：切到备份里原来的当前卡 / 存档，而不是停在空白页
        if (switchTo) await openChat(switchTo.cardId, switchTo.chatId);
    } catch (e) {
        console.error('从备份恢复失败', e?.message ?? e);
        toast(`从备份恢复失败：${e?.message ?? e}`, 'error');
    } finally {
        parsed = null;
        importing = false;
        reconcileScripts();   // 恢复期间脚本是停着的（doImport 开头 stopScripts）：现在按当前卡重新跑
    }
}

/** 现在能不能恢复 / 导入：正在恢复备份也算不能。tavern-ui.js 在弹预览之前、写入之前各问一次 */
export const restoreBlocked = () => (importing ? '正在恢复备份，等它结束再导入' : importBlocked());

/**
 * 别处在内存里转好的备份对象（tavern-ui.js：从酒馆的整体备份 zip 转来的）走同一套恢复流程（doImport）：
 * 不弹任何框、不应用设置（只合并内容）、不当作空浏览器、不处理接口（这种备份对象里没有 endpoints）。
 * 拒绝条件、「正在恢复…」遮罩、存档锁、一个写入事务、读回校验、失败撤销都和「从备份恢复」一样。原来一张卡都没有时，同样切到导入的卡。
 * @returns {Promise<Object|null>} doImport 的结果（{plan, ...}）；被拒绝 / 失败（都已经提示过）返回 null
 */
export async function importBackupObject(backup) {
    const why = restoreBlocked();
    if (why) { toast(why, 'error'); return null; }
    importing = true;
    try {
        let result = null;
        await withRestoreOverlay('正在写入…（请稍等，期间页面不能操作）', async () => {
            await runArchiveOp(async () => { result = await doImport(backup, { applySettings: false, fresh: false }); });
        });
        invalidateArchiveTab();
        if (result?.switchTo) await openChat(result.switchTo.cardId, result.switchTo.chatId);
        return result;
    } finally {
        importing = false;
        reconcileScripts();   // 同 importBackupFile
    }
}

/**
 * 把备份里的接口恢复到本机。只走 llm.js 的 createEndpoint / updateEndpoint（两种后端同一个签名，都是「页面把 key 交出去」的正常路径）。
 * 规则见 planEndpointImport：没有同地址的新建（带 key）；同地址的不动名字和名单，本机没 key 而备份有就补上。
 * 每个接口各自 try/catch：一个失败不影响下一个。日志里只记接口名字和接口层的报错文字（接口层的报错已抹 key），不记 key。
 * 返回 {text, failed}
 */
async function importEndpoints(items) {
    let existing = [];
    try { existing = await listEndpoints(); } catch (e) { return { text: `接口：读不到本机的接口列表（${e?.message ?? e}），没有恢复接口`, failed: items.length }; }
    const { create, fill, skipped } = planEndpointImport(items, existing);
    let added = 0, addedNoKey = 0, filled = 0, failed = 0, modelsFailed = 0, renamed = 0;
    const hosts = [];   // 新建成功的接口指向哪个主机、带没带 key（提示里逐个列出；只有主机名，不含 key）
    for (const c of create) {
        let ep;
        try { ep = await createEndpoint({ name: c.name, baseUrl: c.baseUrl, ...(c.apiKey ? { apiKey: c.apiKey } : {}) }); } catch (e) { console.warn('恢复接口失败', c.name, e?.message ?? e); failed++; continue; }
        added++;
        hosts.push({ host: endpointHost(c.baseUrl), hasKey: !!c.apiKey });
        if (c.renamed) renamed++;
        if (!c.apiKey) addedNoKey++;
        if (c.models.length) { try { await updateEndpoint(ep.id, { models: c.models }); } catch (e) { console.warn('写入接口的模型名单失败', c.name, e?.message ?? e); modelsFailed++; } }
    }
    for (const f of fill) {
        try { await updateEndpoint(f.id, { apiKey: f.apiKey }); filled++; } catch (e) { console.warn('给接口补 key 失败', f.name, e?.message ?? e); failed++; }
    }
    return { text: endpointSummaryText({ added, addedNoKey, filled, skipped, failed, modelsFailed, hosts, renamed }), failed };
}

/**
 * 在 archive.js 的 op 里执行（op 已经落过盘）。返回 null = 失败（已经提示过）。
 *
 * 落盘时机（每一步写了什么、中途失败 / 关页面会留下什么）：
 *   0. 进来之前：op 先 flushNow，页面上所有改动都已经在存储里；之后 persist.paused = true，普通的保存一律不写
 *      （关页面时的那次保存也不写），免得一次带着旧 global 的保存排在导入后面把它盖掉。
 *   1. 读快照、算计划：只读不写。这里失败 / 关页面 = 什么都没写。
 *   2. 【一个事务】写下全部新记录：新卡、新存档、新预设、新卡的目录、并进已有卡的目录补条目、
 *      并进本机已有存档的划线（备份里的存档和它除划线外相同：现读那条记录，只换 highlights，见 backup.js mergeChatHighlights），以及新的 'global'
 *      （内容类——人设、世界书、正则、便签、全局变量——的并集，加上本机的或备份的设置）。IndexedDB 的事务要么全成要么全不成：
 *      写到一半失败 / 关页面 = 事务中止，一条都没写进去。事务里还会核对 'global' 和第 1 步读到的一样，不一样（这期间别处改了）就中止。
 *   3. 逐条读回比较（global 也比）。不一致：删掉这次新建的键、把目录、并过划线的存档记录和 global 还原成写之前的值（又是一个事务）。
 *      在第 2 步提交之后、第 3 步还原之前关掉页面：存储里留下的是【完整的】导入结果（事务是整体提交的），不会是半份。
 *   4. 内存跟上：预设列表、当前卡的目录；写了 global 就 reloadGlobalFromStore 重读全局层（内容并集和设置一起进 state；
 *      当前选择本来就是本机的，重读后不变。空浏览器时当前预设是恢复进来的第一个，也在这里装进来）。
 *      这一步只改内存。在 2 之后、4 之前关页面也没关系：paused 还开着，关页面时不会拿旧的 state 去覆盖刚写的 global；下次打开读到的就是导入后的。
 *   5. finally：paused 关掉，补一次 flushNow（state 和存储一样，一般什么都不写）。
 * 内容类都在第 2 步的事务里，和卡、存档同成同败、一起读回校验。「失败时什么都不应用、再恢复一次能补齐且不重复」照样成立：
 * 内容的并集按内容去重，重复的跳过。
 * 第 3 步读回不一致、撤销【也】失败（极少见：存储出了问题）：存储里可能是合并后的 global，而内存还是旧的。这时再让页面照常保存，
 * 下一次保存就会拿旧内存把合并进来的内容悄悄盖掉、提示文字也和实际对不上——所以停止保存（stopSaving），
 * 页面顶上明确告诉用户「恢复没有完整完成，请刷新页面」，刷新后从存储重新读，看到的就是存储里真实的样子。
 * @param {Object} backup
 * @param {{applySettings: boolean, fresh: boolean}} o   applySettings：弹框答了「是」；fresh：空浏览器
 */
async function doImport(backup, { applySettings, fresh }) {
    persist.paused = true;
    stopScripts();   // 恢复期间不运行任何脚本（它们的变量写、改聊天都会被拒，但定时器还在跑没意义）；结束后 reconcileScripts 按当前卡重建
    let wroteGlobal = false;
    let outcome = '没有写入任何东西，原有数据没有动';   // 失败时提示里说清楚停在哪一步
    try {
        await flushNow();   // 暂停期间它不再排新的写，只是等已经在路上的那次写完
        const keys = await store.keys('');
        const snapshot = await readSnapshot(keys.filter(isBackupKey));
        const { backup: mine } = buildBackup(snapshot, { now: new Date() });
        // 全局记录要用存储里的【原样】：buildBackup 写出的 global 去掉了「当前在用的选择」（那是导出用的），
        // 拿它当本机这一边的话，当前预设、模型等会被当成「没有」，事务里的「global 在别处被改了」核对也会对不上
        const storedGlobal = snapshot.global ?? null;
        // global 用存储里的（op 刚落过盘，和内存里的一样）：内容类取并集的「本机这一边」，不替换设置时也是新 global 的底子。
        // 空浏览器有意传 null：出厂默认 global 里那个「User」人设不是用户的内容，按「和空集取并集」= 备份原样恢复
        const existing = { cards: mine.cards.map(c => c.card), chats: mine.cards.flatMap(c => c.chats), presets: mine.presets, global: fresh ? null : storedGlobal };
        const hadCards = existing.cards.length > 0 || !!persist.cardId;
        // 弹框之前判定是空浏览器（所以没问就要替换全局设置）：拿到锁之后再核对一次，免得这中间有了数据被悄悄覆盖。
        // 输入和第一次判定一样（含网页版里的接口：这期间在别处加了接口，也算有了数据）
        if (fresh && !isEmptyForRestore({ cardKeys: keys.filter(k => k.startsWith('card:')).length, presetKeys: keys.filter(k => k.startsWith('preset:')).length,
            liveCard: !!persist.cardId, global: storedGlobal ?? undefined, ...await endpointFacts() })) {
            throw new Error('就在刚才，这个浏览器里有了新的数据。为了不覆盖它，没有恢复，请重新选择备份文件');
        }
        const plan = planBackupImport(backup, existing, { newId: uid, now: new Date(), fresh, applySettings });

        const sets = [
            ...plan.presets.map(p => ({ set: presetKey(p.id), value: p })),
            ...plan.cards.map(c => ({ set: cardKey(c.id), value: c })),
            ...plan.chats.map(c => ({ set: chatKey(c.cardId, c.id), value: c })),
            ...plan.indexes.map(i => ({ set: indexKey(i.cardId), value: i })),
            // 新建的卡带过来的脚本变量 / 角色卡变量（cardvars:<新卡 id>）
            ...plan.cardvars.map(c => ({ set: cardVarsKey(c.cardId), value: c.value })),
        ];
        // 新 id 都是刚生成的随机 uuid，理论上不会和已有的键撞；真撞了宁可不导入，也不覆盖
        const taken = new Set(keys);
        const clash = sets.find(s => taken.has(s.set));
        if (clash) throw new Error(`新记录的键已经存在（${clash.set}），为了不覆盖已有数据，没有导入`);
        if (!sets.length && !plan.global && !plan.cardvarsMerges.length && !plan.highlightMerges.length) return { plan, switchTo: null };

        // 写：一个事务。并进已有卡的目录、并进已有卡的 cardvars、要并进划线的本机已有存档、旧 global 都在同一个事务里现读。
        // 目录：并进了新存档的卡、并进了划线的存档所在的卡，每张卡一个键（两种都有的卡只读写一次）
        const indexCards = [...new Set([...plan.merges.map(m => m.cardId), ...plan.highlightMerges.map(m => m.cardId)])];
        const mergeKeys = indexCards.map(indexKey);
        const cvKeys = plan.cardvarsMerges.map(m => cardVarsKey(m.cardId));
        const hlKeys = plan.highlightMerges.map(m => chatKey(m.cardId, m.chatId));
        const readKeys = [...mergeKeys, ...cvKeys, ...hlKeys, 'global'];
        const cvMerged = new Map();   // cardvars 键 → 合并后的值（读回校验、撤销用）
        const hlMerged = new Map();   // 并进了划线的本机存档的键 → {cardId, chatId, rec（写进去的整条记录）, before（写之前读到的整条记录）}
        let hlAdded = 0, hlFilled = 0;
        let before = [];
        const merged = new Map();   // 目录键 → 补好的目录
        const planned = JSON.stringify(storedGlobal);
        await store.transact(readKeys, values => {
            // 新 global 是拿第 1 步读到的 global 算出来的（内容并集的本机那一边）。这期间按理没人能写它（保存暂停、存档锁在手），
            // 万一变了，用旧的算出来的结果会盖掉新的改动：宁可不导入（抛错 = 中止事务，一条都不写）
            if (plan.global && JSON.stringify(values.at(-1) ?? null) !== planned) throw new Error('就在刚才，全局设置在别处被改了。为了不覆盖它，没有导入，请重新选择备份文件');
            before = values;
            // transact 可能重跑这个回调（同一份 values）：每次从头算
            hlMerged.clear(); merged.clear(); cvMerged.clear(); hlAdded = 0; hlFilled = 0;
            const ops = [...sets];
            // 划线并进本机已有的存档：按事务里现读的记录重算（backup.js mergeChatHighlights，只改 highlights，updatedAt 等一律不动）；
            // 记录不在了 / 没有新东西可并就不写
            plan.highlightMerges.forEach((m, i) => {
                const old = values[mergeKeys.length + cvKeys.length + i];
                const r = mergeChatHighlights(old, m.copies);
                if (!r.rec) return;
                ops.push({ set: hlKeys[i], value: r.rec });
                hlMerged.set(hlKeys[i], { cardId: m.cardId, chatId: m.chatId, rec: r.rec, before: old });
                hlAdded += r.added; hlFilled += r.filled;
            });
            indexCards.forEach((cardId, i) => {
                const newChats = plan.merges.find(m => m.cardId === cardId)?.chats ?? [];
                const touched = [...hlMerged.values()].filter(x => x.cardId === cardId).map(x => x.rec);
                if (!newChats.length && !touched.length) return;
                // 目录条目跟着重算（hl 计数）；目录不存在 / 不是这张卡的不写，archive.js loadIndex 会从存档重建
                const next = mergeIndex(values[i], cardId, [...newChats, ...touched]);
                if (next) { ops.push({ set: mergeKeys[i], value: next }); merged.set(mergeKeys[i], next); }
            });
            // 并进本机已有的卡：按键取并集，本机已有的键保留本机的值（cardvars.js unionCardVars）；没有新东西就不写
            plan.cardvarsMerges.forEach((m, i) => {
                const mine = values[mergeKeys.length + i];
                const u = unionCardVars(mine, m.value);
                if (u.added && u.value) { ops.push({ set: cvKeys[i], value: u.value }); cvMerged.set(cvKeys[i], u.value); }
            });
            if (plan.global) ops.push({ set: 'global', value: plan.global });
            return ops;
        });
        wroteGlobal = !!plan.global;
        // 提示里的数按实际写进去的算（计划之后、事务之前存档要是被改过，两者可能不同）
        Object.assign(plan.summary, { highlightsMerged: hlAdded, highlightNotesFilled: hlFilled, highlightChats: hlMerged.size });

        // 读回：新记录逐字比较；补过的目录只看新存档是不是都在（这期间后台的记忆摘要可能改了别的条目，正常）；并进了划线的存档逐字比较
        try {
            for (const s of sets) {
                if (JSON.stringify(await store.get(s.set)) !== JSON.stringify(s.value)) throw new Error(`读回校验不一致：${s.set}`);
            }
            for (const m of plan.merges) {
                const ik = indexKey(m.cardId);
                if (!merged.has(ik)) continue;
                const idx = await store.get(ik);
                if (!m.chats.every(c => idx?.chats?.[c.id])) throw new Error(`读回校验不一致：${ik}`);
            }
            for (const [k, x] of hlMerged) if (JSON.stringify(await store.get(k)) !== JSON.stringify(x.rec)) throw new Error(`读回校验不一致：${k}`);
            for (const [k, v] of cvMerged) if (JSON.stringify(await store.get(k)) !== JSON.stringify(v)) throw new Error(`读回校验不一致：${k}`);
            if (plan.global && JSON.stringify(await store.get('global')) !== JSON.stringify(plan.global)) throw new Error('读回校验不一致：global');
        } catch (e) {
            // 撤掉：删的只有这次新生成 id 的键（不可能是已有的数据），目录、cardvars、并进了划线的存档和 global 还原成写之前读到的
            const undo = sets.map(s => ({ del: s.set }));
            mergeKeys.forEach((k, i) => { if (merged.has(k) && before[i] !== undefined) undo.push({ set: k, value: before[i] }); });
            cvKeys.forEach((k, i) => {
                if (!cvMerged.has(k)) return;
                const old = before[mergeKeys.length + i];
                undo.push(old === undefined ? { del: k } : { set: k, value: old });
            });
            // 被改写的本机存档（只动过 highlights）：整条换回写之前事务里读到的那份（写的前提就是它存在，所以不会是 undefined）
            for (const [k, x] of hlMerged) undo.push({ set: k, value: x.before });
            if (wroteGlobal) undo.push(before.at(-1) === undefined ? { del: 'global' } : { set: 'global', value: before.at(-1) });
            try {
                await store.batch(undo);
                outcome = '刚写进去的已经撤掉，原有数据没有动';
            } catch (err) {
                console.error('撤销导入失败', err?.message ?? err);
                // 存储和内存对不上了：停止保存，免得旧内存把存储里合并进来的内容盖掉（见函数头的说明）。
                // stopSaving 之后 finally 里的 flushNow 什么都不写；关页面时的那次保存也不写
                stopSaving();
                showStoreError('从备份恢复没有完整完成：写进去的内容没能读回核对，撤销也失败了。为了不让这个页面里的旧数据盖掉存储里的内容，'
                    + '已经停止保存（之后在这个页面上的改动都不会保存）。请刷新页面，刷新后看到的就是存储里实际的样子；需要的话可以再恢复一次（重复的会自动跳过）。');
                outcome = '撤销刚写进去的记录也失败了（详见控制台），已停止保存：请刷新页面。可能多出了一部分导入的卡 / 存档 / 预设和合并进来的人设、世界书、正则、便签、全局变量、划线，原有的内容没有被删掉';
            }
            throw e;
        }

        // 内存跟上存储
        for (const p of plan.presets) presets.catalog.set(p.id, { id: p.id, name: p.name, createdAt: p.createdAt ?? '', updatedAt: p.updatedAt ?? '' });
        // 并进的正是当前卡：内存里那份目录是之后保存的依据，也要补上，不然下次保存会用旧目录把补好的盖回去
        for (const m of plan.merges) {
            if (persist.index?.cardId === m.cardId) for (const c of m.chats) persist.index.chats[c.id] = indexEntry(c);
        }
        // 并进了划线的本机存档：当前卡的目录条目跟着换（hl 计数）；正好是当前存档的，内存里的 persist.chatMeta.highlights 换成存储里的
        // （不换的话，下一次保存会拿内存里的旧列表把并进来的划线盖掉）。界面在 finally 的 renderAll 里重画，高亮跟着 renderChat 重建
        for (const x of hlMerged.values()) {
            if (persist.index?.cardId === x.cardId && persist.index.chats[x.chatId]) persist.index.chats[x.chatId] = indexEntry(x.rec);
            adoptRestoredHighlights(x.cardId, x.chatId, x.rec.highlights);
        }
        // 写了 global（内容有新增，或应用了备份里的设置）：重读全局层，人设 / 世界书 / 正则 / 便签 / 全局变量和设置一起进 state。
        // 预设引用是本机原来的（或空浏览器时刚恢复进来的第一个），找不到也不是这次恢复改的，不另外报
        if (plan.global) await reloadGlobalFromStore();
        // 并进的正是当前卡的 cardvars：内存里那份是恢复前的，重读（不然下次保存会拿它把合并进来的键盖掉）
        if (plan.cardvarsMerges.some(m => m.cardId === persist.cardId && cvMerged.has(cardVarsKey(m.cardId)))) await reloadCardVars();
        const target = plan.target;
        return { plan, switchTo: !hadCards && target ? target : null };
    } catch (e) {
        console.error('从备份导入失败', e?.message ?? e);
        // RangeError（爆栈）：数据嵌套太深。parseBackup / tavern-convert.js 已经先挡过，这里是兜底，提示说人话
        const msg = e instanceof RangeError ? '备份里有嵌套得极深的数据（文件可能损坏了或被改过），没法处理' : (e?.message ?? e);
        toast(`从备份导入失败：${msg}。${outcome}。`, 'error');
        return null;
    } finally {
        persist.paused = false;
        await flushNow();     // 暂停期间页面上的改动（如果有）现在写下去
        ui.rendered.clear();
        renderAll();
    }
}

// ───────────────────────────── 界面 ─────────────────────────────

let picker = null;
/** 备份文件的选择框（第一次用到时才建；放在「杂项」页的整体备份一节里，测试脚本用 #backup-file-input 找它） */
function backupPicker() {
    if (!picker) {
        picker = h('input', { type: 'file', id: 'backup-file-input', accept: '.json,application/json', hidden: true });
        picker.addEventListener('change', () => {
            const file = picker.files[0];
            picker.value = '';
            if (file) importBackupFile(file);
        });
    }
    return picker;
}

/** 「杂项」页的「整体备份」一节（tab-misc.js 每次重画时调用） */
export function backupSection() {
    const ro = persist.readOnly;
    const roTip = '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能恢复';
    return h('div', { class: 'bkx-section', 'data-fk': 'backup-section' },
        h('div', { class: 'section-title' }, '整体备份'),
        h('div', { class: 'dim bkx-desc' },
            // 说明只留一句「包含什么」（2026-11-23 用户定）；恢复的规矩在恢复时的确认框和结果里说，README 有全文
            h('div', null, '打包内容包含：角色卡和存档、预设、人设、额外世界书、全局正则、便签、全局变量、接口列表（网页版连 API key 一起，须设密码加密），'
                + '以及外置记忆设置、上下文上限、世界书扫描深度。不含当前选用的预设、人设和模型。')),
        h('div', { class: 'row' },
            h('button', { 'data-fk': 'backup-export', title: '把全部数据备份成一个 .json 文件' + (ro ? '。这个标签页是只读的：备份的是存储里已经保存的内容' : ''),
                onclick: () => exportAll() }, '备份全部数据'),
            h('button', { 'data-fk': 'backup-import', disabled: ro, title: ro ? roTip : '从「备份全部数据」得到的文件恢复（加密的会先问密码）',
                onclick: () => backupPicker().click() }, '从备份恢复'),
            backupPicker()));
}
