// 「杂项」页的「和酒馆整体互通」：从酒馆的整体备份 zip 导入、把我们的数据导出成酒馆的目录结构（zip）。
// 转换是 src/tavern-convert.js 的纯函数；zip 读写在 src/zip.js；目录规则在 src/tavern-backup.js。这里只管弹框、进度、落盘的时机。
//
// ── 导入（importTavernZip）── 一共只有一次写入，在最后：
//   1. openZip：只读 zip 末尾的目录（File 按需取片段，几百 MB 的备份也不会整个读进内存）
//   2. analyzeTavernZip：分类、读 settings.json（只取人设和全局正则），算预览的数字。不读卡和聊天
//   3. 预览弹框：每类一个勾选框、被跳过的内容和大小、孤儿聊天、编码不确定的文件名。取消 = 什么都不做
//   4. 逐个读取、转换（convertTavernZip，一次只解一个文件），显示「第几个 / 共几个」，可以取消。
//      到这一步为止【什么都没写】：取消、某个文件坏了、关掉页面，存储都和导入前一模一样
//   5. 转成的备份对象交给 ui/backup.js 的 importBackupObject（= 整体备份恢复的同一套 doImport）：
//      拿存档锁 → 先落盘 → 暂停保存 → 【一个写入事务】写下全部新记录和合并后的 global → 读回校验 → 不一致就撤销。
//      IndexedDB 的事务要么全成要么全不成：写到一半失败 / 关页面 = 一条都没写进去；提交之后关页面 = 完整的导入结果，不会是半份。
//      细节见 ui/backup.js doImport 的注释。写入期间整页盖着「正在写入…」的遮罩（ui/backup.js withRestoreOverlay），页面点不动。
//      设置一律不应用、当前选择一律不动，所以只有卡、存档、预设、人设、世界书、正则会多出来。
//   6. 结果弹框：每类新增几个、跳过几个重复的、几个失败及原因
//
// ── 导出（exportTavernZip）── 只读，不写存储：
//   先落盘（只读标签页不落盘，导出存储里已经保存的内容）→ 一个事务里读出 global / card:* / chat:* / preset:* 的快照 →
//   勾选弹框 → 逐个生成文件（卡用「导出卡」同一个 cardToFile；存档用单个导出同一个 serializeChatFile）→ buildTavernLayout 摆路径 → buildZip → 下载。
//   不带：API key、接口列表、settings.json、人设、全局正则、便签（这几样在 tavern-convert.js buildTavernExport 里根本不读）。

import { store } from '../store.js';
import { openZip, buildZip, ZipError } from '../zip.js';
import { buildTavernLayout } from '../tavern-backup.js';
import { analyzeTavernZip, selectionStats, convertTavernZip, buildTavernExport, tavernExportFileName, ALL_SELECTED, EXPORT_ALL, normalizeSelection, TAVERN_LIMITS } from '../tavern-convert.js';
import { buildBackup, booksRenamedText, worldReenabledText } from '../backup.js';
import { h, toast } from './dom.js';
import { state, persist, flushNow } from './state.js';
import { restoreBlocked, importBackupObject } from './backup.js';   // 循环依赖：只在函数体里调用
import { cardToFile, downloadBlob } from './export-st.js';

let busy = false;   // 一次只做一件：导入或导出

const MB = 1024 * 1024;
const size = n => (n >= MB ? `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isBackupKey = k => k === 'global' || k.startsWith('card:') || k.startsWith('chat:') || k.startsWith('preset:');

// ───────────────────────────── 弹框 ─────────────────────────────
//
// 和整体备份一样是页内弹层（bk-overlay / bk-panel 样式），Esc / 点遮罩外面 = 取消。不用 confirm。

/**
 * 通用对话框。buttons: [{text, value, fk, primary?}]；value 为 null 的是「取消」。
 * getValue(value)：点了非取消按钮时再算一次返回值（预览框要带上勾选）。返回点的按钮的值，取消返回 null。
 * onOpen(api)：对话框建好后调用，api.setDisabled(fk, bool) 可以禁用某个按钮。
 */
function dialog({ label, fk, body, buttons, getValue, onOpen }) {
    return new Promise(resolve => {
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        const close = result => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
        const btns = buttons.map(b => h('button', { type: 'button', class: b.primary ? 'primary' : '', 'data-fk': b.fk,
            onclick: () => close(b.value === null ? null : (getValue ? getValue(b.value) : b.value)) }, b.text));
        const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': fk, onmousedown: e => { if (e.target === overlay) close(null); } },
            h('div', { class: 'bk-panel imp-panel tv-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
                h('div', { class: 'bk-head' }, h('b', null, label)),
                h('div', { class: 'bk-body imp-body' }, ...body),
                h('div', { class: 'bk-foot' }, ...btns)));
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        (btns[buttons.findIndex(b => b.primary)] ?? btns[0]).focus();
        onOpen?.({ setDisabled: (f, on) => { const b = btns[buttons.findIndex(x => x.fk === f)]; if (b) b.disabled = on; } });
    });
}

/**
 * 进度框：一行文字 + 进度条 + 「取消」。cancellable 为假时没有取消按钮（写入阶段不能取消）。
 * 返回 {set(done, total, text), lock(text), close(), cancelled()}。Esc 等于点取消。
 */
function progressDialog(label, fk) {
    let cancelled = false;
    const text = h('p', { class: 'tv-progress-text', 'data-fk': `${fk}-text`, 'aria-live': 'polite' }, '准备中…');
    const bar = h('progress', { class: 'tv-progress', max: 1, value: 0 });
    const cancelBtn = h('button', { type: 'button', 'data-fk': `${fk}-cancel` }, '取消');
    const cancel = () => { if (cancelBtn.disabled) return; cancelled = true; cancelBtn.disabled = true; text.textContent = '正在取消…'; };
    cancelBtn.addEventListener('click', cancel);
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    const overlay = h('div', { class: 'bk-overlay imp-overlay', 'data-fk': fk },
        h('div', { class: 'bk-panel imp-panel tv-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, 'aria-busy': 'true' },
            h('div', { class: 'bk-head' }, h('b', null, label)),
            h('div', { class: 'bk-body imp-body' }, text, bar),
            h('div', { class: 'bk-foot' }, cancelBtn)));
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    cancelBtn.focus();
    return {
        set(done, total, t) {
            if (cancelled) return;
            bar.max = Math.max(1, total); bar.value = done;
            text.textContent = t ? `第 ${Math.min(done + 1, total)} 个 / 共 ${total} 个：${t}` : `已处理 ${done} 个 / 共 ${total} 个`;
        },
        /** 进入不能取消的阶段（写入、压缩） */
        lock(t) { cancelBtn.disabled = true; text.textContent = t; bar.removeAttribute('value'); },
        cancelled: () => cancelled,
        close() { document.removeEventListener('keydown', onKey, true); overlay.remove(); },
    };
}

/** 一个勾选行：<label><input type=checkbox data-tv=key> 文字</label> */
const checkRow = (key, text, { checked, disabled }) => h('label', { class: 'imp-opt tv-cat' },
    h('input', { type: 'checkbox', 'data-tv': key, checked, disabled }), h('span', null, text));

/** 一个可以折叠的长列表（文件名可能很多）。items 为空时不画 */
function listBlock(fk, title, items, cls = 'dim imp-note') {
    if (!items.length) return null;
    return h('div', { class: cls, 'data-fk': fk },
        h('div', null, title),
        h('ul', { class: 'tv-list' }, ...items.slice(0, 50).map(x => h('li', null, x)), items.length > 50 ? h('li', null, `……还有 ${items.length - 50} 个`) : null));
}

// ───────────────────────────── 导入 ─────────────────────────────

/** openZip 的错误 → 人话（区分「不是 zip」「太大 / 文件太多」「分卷」「坏了」） */
function openErrorText(e) {
    const code = e instanceof ZipError ? e.code : '';
    if (code === 'empty') return '文件是空的';
    if (code === 'not-zip' || code === 'bad-input') return '这不是一个 zip 压缩包（可能只是扩展名叫 .zip，或者文件没下载完整）';
    if (code === 'zip64' || code === 'too-many') return '这个压缩包太大（超过 4 GB）或文件太多，暂不支持。可以在酒馆的数据文件夹里只挑 characters、chats、worlds、OpenAI Settings 和 settings.json 重新打包';
    if (code === 'multi-volume') return e.message;
    if (code) return `压缩包已损坏：${e.message}`;
    return `读不了这个文件：${e?.message ?? e}`;
}

/** 酒馆用户目录里常见的、不导入的文件夹 → 给人看的说法（不认识的直接显示文件夹名） */
const IGNORED_LABEL = {
    backups: '聊天自动备份', thumbnails: '缩略图', extensions: '扩展（插件）文件', 'User Avatars': '人设头像', 'group chats': '群聊记录', groups: '群组',
    vectors: '向量数据库', backgrounds: '背景图', assets: '素材', files: '附件', images: '图片', 'user': '用户文件', themes: '界面主题',
    'QuickReplies': '快速回复', 'NovelAI Settings': 'NovelAI 预设', 'KoboldAI Settings': 'KoboldAI 预设', 'TextGen Settings': '文本补全预设',
    instruct: '指令模板', context: '上下文模板', sysprompt: '系统提示词模板', reasoning: '推理模板', 'movingUI': '界面布局', '(根目录文件)': '根目录里的其它文件',
    '(名字不安全)': '名字不安全的文件',
};

/** 预览弹框。返回勾选（{cards, chats, worlds, presets, personas, regex}），取消返回 null */
function askImport(a, fileName) {
    const counts = { cards: a.cards.length, chats: a.cards.reduce((n, c) => n + c.chats.length, 0), worlds: a.worlds.length, presets: a.presets.length,
        personas: a.personas.length, regex: a.regexScripts.length };
    const g = a.globalWorldCount ?? 0;
    const label = { cards: `角色卡 ${counts.cards} 张`, chats: `聊天记录 ${counts.chats} 个（挂在各自的角色卡下面）`,
        worlds: `世界书 ${counts.worlds} 本（作为额外世界书${g ? `；其中 ${g} 本在酒馆里是全局启用的` : ''}）`,
        presets: `预设 ${counts.presets} 个（新增到预设列表，不会切换当前预设）`, personas: `人设 ${counts.personas} 个（新增到人设列表，不会切换当前人设）`,
        regex: `全局正则 ${counts.regex} 条` };
    // 有东西的类别都默认勾上。世界书以前默认不勾（那时额外世界书一律对所有聊天生效）；现在按酒馆里的关系决定开不开、对谁生效
    // （tavern-convert.js applyWorldRules），导进来不会乱生效，所以和别的类别一样默认勾上
    const rows = Object.keys(ALL_SELECTED).map(k => checkRow(k, label[k], { checked: counts[k] > 0, disabled: counts[k] === 0 }));
    const box = k => rows[Object.keys(ALL_SELECTED).indexOf(k)].querySelector('input');
    const read = () => normalizeSelection(Object.fromEntries(Object.keys(ALL_SELECTED).map(k => [k, box(k).checked && !box(k).disabled])));
    const statEl = h('p', { class: 'imp-sum', 'data-fk': 'tv-stat' });
    const tooBigEl = h('p', { class: 'bkx-warn', 'data-fk': 'tv-toobig', hidden: true });

    const ig = a.ignored.byTop.map(x => `${IGNORED_LABEL[x.name] ? `${IGNORED_LABEL[x.name]}（${x.name}）` : x.name} ${size(x.bytes)}（${x.count} 个文件）`);
    const body = [
        h('p', { class: 'imp-lead' }, `「${fileName}」里找到了：${a.strippedPrefix ? `（外面多包了一层文件夹「${a.strippedPrefix}」，已自动跳过）` : ''}`),
        h('div', { class: 'tv-cats', 'data-fk': 'tv-cats' }, ...rows),
        statEl, tooBigEl,
        a.settingsError ? h('p', { class: 'bkx-warn', 'data-fk': 'tv-settings-error' }, a.settingsError) : null,
        !a.hasSettings ? h('p', { class: 'dim imp-note' }, '压缩包里没有 settings.json，所以没有人设和全局正则。') : null,
        h('p', { class: 'bkx-note', 'data-fk': 'tv-merge-note' },
            '只会新增，不会改动或删除你现有的任何东西；和已有的完全相同的会跳过（同一个备份导入两遍不会多出东西）。'
            + '酒馆的界面主题、插件（扩展）设置、API 连接、群聊、背景图等不会导入。'),
        // 世界书按酒馆里的用法决定导入后开不开（规则在 tavern-convert.js applyWorldRules）。
        // 「被卡绑定」要读完卡才知道（预览阶段不读卡的内容），所以这里只给得出全局启用的本数，其余两类的数目在结果框里列
        counts.worlds ? h('p', { class: 'dim imp-note', 'data-fk': 'tv-worlds-note' },
            `世界书按酒馆里的用法导入：酒馆里全局启用的${g ? `（${g} 本）` : ''} → 启用，对所有聊天生效；被某张一起导入的角色卡绑定的 → 启用，只对那张卡生效`
            + '（酒馆里实际用的是这本文件，那张卡自己带着的内嵌世界书只是拷贝，会被关掉，免得发两遍）；其余的导入为关闭。'
            + '哪几本绑定到卡、哪几本关着，要读完角色卡才知道，导入完成后会列出来。之后都可以在「世界书」页打开、关闭或改绑定。') : null,
        listBlock('tv-shadowed', `这些 .json 卡有同名的 .png，只导入 .png：`, a.shadowed),
        // 同名而且同类（两个 .png 或两个 .json）：和上面那种不是一回事，单独说
        listBlock('tv-duplicates', '这些角色卡和前面的某张同名（去掉扩展名后一样），只导入前面那张：', a.duplicates ?? []),
        listBlock('tv-orphans', '这些聊天记录找不到对应的角色卡，会跳过：', a.orphans.map(o => `chats/${o.dir}/（${o.count} 个，${size(o.bytes)}）`)),
        ig.length ? h('div', { class: 'dim imp-note', 'data-fk': 'tv-ignored' }, `这些不会导入（共 ${size(a.ignored.total.bytes)}）：${ig.join('、')}`) : null,
        listBlock('tv-uncertain', '这些文件名的编码不确定（压缩时没标明用的是什么编码），显示的名字可能是乱码，导入后的存档名 / 世界书名也会是这个样子：', a.uncertain, 'bkx-warn'),
    ];
    let api = null;
    const refresh = () => {
        // 聊天依附于卡：不导入卡就没有地方挂聊天
        const chats = box('chats');
        if (counts.chats) { chats.disabled = !box('cards').checked; if (chats.disabled) chats.checked = false; }
        const sel = read();
        const st = selectionStats(a, sel);
        const any = Object.values(sel).some(Boolean);
        statEl.textContent = any ? `将读取 ${st.files} 个文件，共 ${size(st.bytes)}` : '什么都没有勾选';
        tooBigEl.hidden = !st.tooBig;
        tooBigEl.textContent = st.tooBig ? `勾选的内容加起来有 ${size(st.bytes)}，超过了一次导入的上限 ${size(st.limit)}（太大容易把浏览器撑爆，手机上尤其）。请少勾几类，分几次导入（已经导入过的下次会自动跳过）。` : '';
        api?.setDisabled('tv-import-ok', st.tooBig || !any);
    };
    for (const r of rows) r.querySelector('input').addEventListener('change', refresh);
    return dialog({
        label: '从酒馆的整体备份导入', fk: 'tv-import-dialog', body,
        buttons: [{ text: '取消', value: null, fk: 'tv-import-cancel' }, { text: '导入', value: true, fk: 'tv-import-ok', primary: true }],
        getValue: () => read(),
        onOpen: x => { api = x; refresh(); },
    });
}

/** 结果弹框：每类新增 / 跳过，失败和问题的明细 */
function showImportResult(summary, conv, a, sel) {
    const s = summary;
    const line = (name, unit, added, dup, dupText = '和已有的完全相同，跳过') => `${name}：新增 ${added} ${unit}${dup ? `，${dup} ${unit}${dupText}` : ''}`;
    const lines = [];
    if (sel.cards) lines.push(line('角色卡', '张', s.cardsAdded, s.cardsMerged, '和已有的完全相同，没有新建（新的聊天记录并进了已有的那张卡）'));
    if (sel.chats) lines.push(line('聊天记录', '个', s.chatsAdded, s.chatsDup));
    if (sel.worlds) {
        lines.push(line('世界书', '本', s.booksAdded, s.booksDup));
        // 每一本按什么规则导入（数的是 zip 里读出来的书；和已有的相同而跳过的，保留的是这里原来那本的开关）
        const w = conv.worldRules;
        if (w && w.global + w.bound + w.off) lines.push(`世界书的开关：${w.global} 本启用（酒馆里全局启用的，对所有聊天生效）、${w.bound} 本启用并绑定到角色卡（只对那张卡生效）、${w.off} 本导入为关闭${s.booksDup ? `（数的是压缩包里的书；和这里已有的相同而跳过的 ${s.booksDup} 本，保留这里原来的开关）` : ''}`);
    }
    const cardWorld = cardWorldNotes(conv.worldRules, s);
    if (sel.presets) lines.push(line('预设', '个', s.presetsAdded, s.presetsDup));
    if (sel.personas) lines.push(line('人设', '个', s.personasAdded, s.personasDup));
    if (sel.regex) lines.push(line('全局正则', '条', s.regexAdded, s.regexDup));
    const failures = [...conv.failures.map(f => `${f.what}：${f.reason}`), ...s.skipped.map(x => `${x}：格式不对`)];
    const orphanCount = sel.chats ? a.orphans.reduce((n, o) => n + o.count, 0) : 0;
    const body = [
        h('ul', { class: 'tv-result', 'data-fk': 'tv-result-lines' }, ...lines.map(l => h('li', null, l))),
        orphanCount ? h('p', { class: 'dim imp-note' }, `${orphanCount} 个聊天记录找不到对应的角色卡，跳过了。`) : null,
        listBlock('tv-renamed', '这些和已有的重名，名字后面加了序号：', s.renamed),
        s.booksRenamed ? h('p', { class: 'bkx-warn', 'data-fk': 'tv-books-renamed' }, `${booksRenamedText(s.booksRenamed)}。`) : null,
        listBlock('tv-cards-world-off', '这些角色卡自带的世界书关掉了（酒馆里实际用的是它绑定的那本世界书文件，内嵌的只是拷贝；两份都开着会把同样的条目发两遍）：', cardWorld.off),
        listBlock('tv-cards-world-kept', '这些角色卡已经在这里了，没有改动它们：', cardWorld.kept, 'bkx-warn'),
        listBlock('tv-cards-world-reenabled', '这些角色卡绑定的世界书和这里已有的一本相同（保留了这里那本和它的开关），所以没有关掉卡自带的世界书，需要的话到「世界书」页调整：', cardWorld.reenabled, 'bkx-warn'),
        listBlock('tv-failures', `这 ${failures.length} 个没能导入：`, failures, 'bkx-warn'),
        listBlock('tv-warnings', '这些导入了，但有小问题：', conv.warnings),
        h('p', { class: 'dim imp-note' }, '设置（外置记忆、上下文上限、世界书扫描设置）和当前用的预设、人设、接口、模型都没有动。'),
    ];
    return dialog({ label: '从酒馆导入完成', fk: 'tv-result-dialog', body, buttons: [{ text: '好', value: true, fk: 'tv-result-ok', primary: true }] });
}

/**
 * 卡自带世界书被关掉的说明（tavern-convert.js applyWorldRules 的 cardsOff，对照恢复时的判重结果 summary.worldKept）：
 *   off：新导入的卡，自带的世界书关掉了——「卡名」：酒馆里实际用的是「书名」这本文件；
 *   kept：和本机已有的卡相同而没新建的卡。本机那张的开关不改（只新增、不改现有的），所以它开着的自带世界书和新导入的书可能重复。
 * 没勾世界书 / 角色卡时 cardsOff 本来就是空的。
 */
function cardWorldNotes(w, s) {
    const kept = new Set((s.worldKept ?? []).map(x => x.srcId));
    // 绑定的书和这里已有的一本相同而被判重、这里那本又没对它生效：恢复时把卡自带的书留着开（backup.js keepEmbeddedWorlds），不算「关掉了」
    const reenabled = new Set((s.worldReenabled ?? []).map(x => x.srcId));
    const off = [], keptLines = [];
    for (const c of w?.cardsOff ?? []) {
        if (kept.has(c.cardId)) keptLines.push(`「${c.card}」已经在这里了，它自带的世界书和新导入的「${c.book}」可能重复，请到「世界书」页检查`);
        else if (!reenabled.has(c.cardId)) off.push(`「${c.card}」：酒馆里实际用的是「${c.book}」这本文件`);
    }
    return { off, kept: keptLines, reenabled: (s.worldReenabled ?? []).map(worldReenabledText) };
}

/** 一句话的摘要（提示条） */
function resultToast(s, conv) {
    const added = s.cardsAdded + s.chatsAdded + s.booksAdded + s.presetsAdded + s.personasAdded + s.regexAdded;
    const dup = s.cardsMerged + s.chatsDup + s.booksDup + s.presetsDup + s.personasDup + s.regexDup;
    const fail = conv.failures.length + s.skipped.length;
    const head = added ? `从酒馆导入完成：新增 ${s.cardsAdded} 张卡、${s.chatsAdded} 个聊天、${s.booksAdded} 本世界书、${s.presetsAdded} 个预设、${s.personasAdded} 个人设、${s.regexAdded} 条正则`
        : dup ? '从酒馆导入完成：没有新增任何东西，这些内容这里都已经有了' : '从酒馆导入完成：没有新增任何东西';
    return `${head}${dup && added ? `；跳过 ${dup} 个重复的` : ''}${fail ? `；${fail} 个没能导入` : ''}${s.booksRenamed ? `；${booksRenamedText(s.booksRenamed)}` : ''}`;
}

const EMPTY_SUMMARY = { cardsAdded: 0, cardsMerged: 0, chatsAdded: 0, chatsDup: 0, presetsAdded: 0, presetsDup: 0, personasAdded: 0, personasDup: 0,
    booksAdded: 0, booksDup: 0, booksRenamed: 0, booksRebound: 0, regexAdded: 0, regexDup: 0, settingsApplied: [], renamed: [], skipped: [], notes: [], worldKept: [], worldReenabled: [] };

/** 选了一个 .zip（「杂项」页的按钮，或者拖进页面） */
export async function importTavernZip(file) {
    if (busy) return void toast('上一个酒馆导入 / 导出还没做完', 'error');
    const why = restoreBlocked();
    if (why) return void toast(why, 'error');
    busy = true;
    let prog = null;
    try {
        let zip;
        try { zip = await openZip(file); } catch (e) { return void toast(`没有导入「${file.name}」：${openErrorText(e)}。什么都没有写入。`, 'error'); }
        const a = await analyzeTavernZip(zip);
        if (!a.ok) return void toast(`没有导入「${file.name}」：${a.error}。什么都没有写入。`, 'error');

        const sel = await askImport(a, file.name);
        if (!sel) return;   // 取消：什么都不做

        // 逐个读取、转换。这一步只在内存里，不写存储
        prog = progressDialog('正在读取酒馆的备份', 'tv-progress');
        const conv = await convertTavernZip(zip, a, sel, { onProgress: p => prog.set(p.done, p.total, p.label), isCancelled: prog.cancelled });
        if (conv.cancelled) { prog.close(); prog = null; return void toast('已取消导入，什么都没有写入', 'ok'); }

        // 写入：和「从备份恢复」同一套流程（一个事务、读回校验、失败撤销）；拒绝条件在里面再查一次
        prog.lock('正在写入…');
        const b = conv.backup;
        const hasAny = b.cards.length || b.presets.length || b.global;
        const result = hasAny ? await importBackupObject(b) : { plan: { summary: EMPTY_SUMMARY } };
        prog.close(); prog = null;
        if (!result) return;   // 被拒绝或写入失败：已经提示过（失败时什么都没留下）
        const s = result.plan.summary;
        if (s.skipped.length || conv.failures.length || conv.warnings.length) console.warn('从酒馆导入：', { 没能导入: conv.failures, 格式不对: s.skipped, 小问题: conv.warnings });
        toast(resultToast(s, conv), conv.failures.length || s.skipped.length ? 'error' : 'ok');
        await showImportResult(s, conv, a, sel);
    } catch (e) {
        console.error('从酒馆导入失败', e?.message ?? e);
        toast(`从酒馆导入失败：${e?.message ?? e}`, 'error');
    } finally {
        prog?.close();
        busy = false;
    }
}

// ───────────────────────────── 导出 ─────────────────────────────

/** 一个事务里读出这些键（同一时刻的快照）。和 ui/backup.js 的 readSnapshot 同一个办法：transact 返回空的写列表 = 只读 */
async function readSnapshot(keys) {
    let values = [];
    await store.transact(keys, v => { values = v; return []; });
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/** 导出的勾选弹框。返回勾选，取消返回 null */
function askExport(n, readOnly) {
    const label = { cards: `角色卡 ${n.cards} 张（有头像的是 PNG，没有的是 JSON）`, chats: `聊天记录 ${n.chats} 个（每个存档一个 .jsonl）`,
        worlds: `额外世界书 ${n.worlds} 本`, presets: `预设 ${n.presets} 个` };
    const keys = Object.keys(EXPORT_ALL);
    const rows = keys.map(k => checkRow(k, label[k], { checked: n[k] > 0, disabled: n[k] === 0 }));
    const box = k => rows[keys.indexOf(k)].querySelector('input');
    const read = () => Object.fromEntries(keys.map(k => [k, box(k).checked && !box(k).disabled]));
    let api = null;
    const refresh = () => {
        if (n.chats) { box('chats').disabled = !box('cards').checked; if (box('chats').disabled) box('chats').checked = false; }
        api?.setDisabled('tv-export-ok', !Object.values(read()).some(Boolean));
    };
    for (const r of rows) r.querySelector('input').addEventListener('change', refresh);
    const body = [
        h('p', { class: 'imp-lead' }, '按酒馆的目录结构（characters/、chats/、worlds/、OpenAI Settings/）打成一个 zip：'),
        h('div', { class: 'tv-cats', 'data-fk': 'tv-export-cats' }, ...rows),
        h('p', { class: 'bkx-note', 'data-fk': 'tv-export-howto' },
            '用法：把 zip 解压到酒馆的 data/default-user/ 文件夹里（合并进去，不要替换或删掉整个文件夹），然后重启酒馆。同名的文件会被覆盖，解压前可以先看一眼。'),
        h('p', { class: 'dim imp-note', 'data-fk': 'tv-export-nokey' },
            '这个 zip 里没有任何 API key，也没有接口列表和酒馆的 settings.json（不会冲掉酒馆的设置）；预设里酒馆的反代地址、密码、附加请求头等连接信息也不会带上。'
                + '人设和全局正则请用「人设」页、「正则」页各自的导出。'),
        readOnly ? h('p', { class: 'dim imp-note' }, '这个标签页是只读的：导出的是存储里已经保存的内容。') : null,
    ];
    return dialog({
        label: '导出成酒馆的目录结构', fk: 'tv-export-dialog', body,
        buttons: [{ text: '取消', value: null, fk: 'tv-export-cancel' }, { text: '导出并下载', value: true, fk: 'tv-export-ok', primary: true }],
        getValue: () => read(),
        onOpen: x => { api = x; refresh(); },
    });
}

/** 「导出成酒馆的目录结构（zip）…」。只读标签页也能用 */
export async function exportTavernZip() {
    if (busy) return void toast('上一个酒馆导入 / 导出还没做完', 'error');
    busy = true;
    let prog = null;
    try {
        const ro = persist.readOnly || persist.stopped;
        if (!ro && !await flushNow()) return void toast('当前内容没能保存，已取消导出（不然导出的不是最新的）', 'error');
        const keys = await store.keys('');
        const { backup } = buildBackup(await readSnapshot(keys.filter(isBackupKey)), { now: new Date() });
        const n = { cards: backup.cards.length, chats: backup.cards.reduce((t, c) => t + c.chats.length, 0),
            worlds: Array.isArray(backup.global?.books) ? backup.global.books.length : 0, presets: backup.presets.length };
        if (!n.cards && !n.worlds && !n.presets) return void toast('还没有可以导出的东西（没有角色卡、额外世界书和保存过的预设）', 'error');
        const sel = await askExport(n, persist.readOnly);
        if (!sel) return;

        prog = progressDialog('正在导出成酒馆格式', 'tv-export-progress');
        const built = await buildTavernExport(backup, sel, {
            // 和「存档」页的「导出卡」同一个函数（有头像出 PNG、JPEG 头像先画成 PNG、头像坏了退回 JSON）
            cardToFile: async (card, avatar) => {
                const f = await cardToFile(card, avatar);
                return { data: new Uint8Array(await f.blob.arrayBuffer()), fileName: f.filename, note: f.note };
            },
            userName: state.persona?.name || 'User',
            onProgress: p => prog.set(p.done, p.total, p.label),
            isCancelled: prog.cancelled,
        });
        if (built.cancelled) { prog.close(); prog = null; return void toast('已取消导出', 'ok'); }
        const files = buildTavernLayout(built.input);
        // zip 模块不支持 ZIP64：条目数 < 65535、总大小 < 4 GB。先算一遍，超了给明确的提示，不去压了一半才失败
        const bytes = files.reduce((t, f) => t + f.data.length, 0);
        if (files.length >= 0xFFFF) { prog.close(); prog = null; return void toast(`要导出 ${files.length} 个文件，超过了 zip 的上限（65535 个）。请少勾几类，分几次导出。`, 'error'); }
        if (bytes >= 0xFFFFFFFF - 64 * MB) { prog.close(); prog = null; return void toast(`要导出的内容有 ${size(bytes)}，超过了 zip 的上限（4 GB）。请少勾几类，分几次导出。`, 'error'); }
        prog.lock(`正在打包 ${files.length} 个文件（${size(bytes)}）…`);
        let blob;
        try { blob = await buildZip(files); } catch (e) {
            if (e instanceof ZipError && e.code === 'zip64') return void toast('要导出的内容超过了 zip 的上限（4 GB / 65535 个文件）。请少勾几类，分几次导出。', 'error');
            throw e;
        }
        prog.close(); prog = null;
        downloadBlob(tavernExportFileName(new Date()), blob);
        const c = built.counts;
        const bits = [`已导出 ${c.cards} 张卡、${c.chats} 个聊天记录、${c.worlds} 本世界书、${c.presets} 个预设（${size(blob.size)}）`];
        if (built.notes.length) bits.push(built.notes.slice(0, 3).join('；') + (built.notes.length > 3 ? ' 等' : ''));
        if (persist.readOnly) bits.push('这个标签页是只读的：导出的是存储里已经保存的内容');
        toast(bits.join('；'), 'ok');
    } catch (e) {
        console.error('导出成酒馆格式失败', e?.message ?? e);
        toast(`导出成酒馆格式失败：${e?.message ?? e}`, 'error');
    } finally {
        prog?.close();
        busy = false;
    }
}

// ───────────────────────────── 界面 ─────────────────────────────

let picker = null;
/** zip 的选择框（第一次用到时才建；测试脚本用 #tavern-file-input 找它） */
function tavernPicker() {
    if (!picker) {
        picker = h('input', { type: 'file', id: 'tavern-file-input', accept: '.zip,application/zip,application/x-zip-compressed', hidden: true });
        picker.addEventListener('change', () => {
            const file = picker.files[0];
            picker.value = '';
            if (file) importTavernZip(file);
        });
    }
    return picker;
}

/** 「杂项」页的「和酒馆整体互通」一节（tab-misc.js 每次重画时调用，放在「整体备份」后面） */
export function tavernSection() {
    const ro = persist.readOnly;
    return h('div', { class: 'bkx-section', 'data-fk': 'tavern-section' },
        h('div', { class: 'section-title' }, '和酒馆整体互通'),
        h('div', { class: 'dim bkx-desc' },
            h('div', null, '从酒馆的「备份」（把整个用户文件夹打成的 zip）里导入角色卡、聊天记录、世界书、预设、人设和全局正则。只新增，不改不删这里已有的东西；把 .zip 拖进页面也行。'),
            h('div', null, '也能反过来：把这里的角色卡、聊天记录、世界书、预设按酒馆的目录结构打成 zip，解压进酒馆的 data/default-user/ 就能用。不含 API key。'),
            h('div', null, `单个文件的上限：角色卡 ${size(TAVERN_LIMITS.card)}、聊天记录 ${size(TAVERN_LIMITS.chat)}；一次导入合计 ${size(TAVERN_LIMITS.total)}。`)),
        h('div', { class: 'row' },
            h('button', { 'data-fk': 'tavern-import', disabled: ro, title: ro ? '存储处于只读状态（另一个标签页正在写，见页面顶上的说明），不能导入' : '选择酒馆整体备份的 .zip 文件',
                onclick: () => tavernPicker().click() }, '从酒馆的整体备份导入…'),
            h('button', { 'data-fk': 'tavern-export', title: '把角色卡、聊天记录、世界书、预设导出成酒馆目录结构的 .zip' + (ro ? '。这个标签页是只读的：导出的是存储里已经保存的内容' : ''),
                onclick: () => exportTavernZip() }, '导出成酒馆的目录结构（zip）…'),
            tavernPicker()));
}
