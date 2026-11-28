// 导入：角色卡 PNG / JSON、预设、世界书、正则、酒馆的人设备份、酒馆聊天记录 .jsonl（importFiles / setCard），以及通用的 JSON 文件选择框 pickJson。
// 酒馆的整体备份 .zip 只在这里分发，导入本身在 tavern-ui.js。

import { readCardFromPng } from '../png.js';
import { parseCard, parseWorldbook, detectJsonKind } from '../card.js';
import { h, toast, uid } from './dom.js';
import { state, ui, save, addPreset, persist, STOPPED_TEXT } from './state.js';
import { cleanPresetBody, cleanRegexList, uniquePresetName } from '../migrate.js';
import { sanitizeNotice } from '../preset-sanitize.js';
import { replaceBookEntries, cardBookNameOf } from '../books.js';
import { parseCardScripts, flattenScripts } from '../scripts.js';
import { addCard } from './archive.js';
import { renderAll } from './shell.js';
import { importPersonasJson } from './tab-persona.js';   // 循环依赖：只在函数体里调用
import { importTavernZip } from './tavern-ui.js';         // 同上：只在函数体里调用
import { importChatFiles } from './import-chats.js';   // 同上：只在函数体里调用
import { restoreActive } from './backup.js';            // 同上：只在函数体里调用

// ───────────────────────────── 导入 ─────────────────────────────

/**
 * 现在能不能导入文件；能返回 null，不能返回给人看的原因。拖放（app.js）、#file-input、「预设」页的导入都走 importFiles，统一在这里挡：
 *   - 正在从备份恢复 / 写入（遮罩盖着、保存暂停）：这期间改的 state 会在恢复结束时被存储里的值盖掉，导入的东西悄悄丢了；
 *   - 停止保存之后：什么都不会写，不能再提示「已导入」；
 *   - 只读标签页：同上。
 * 以前每个分支各管各的（卡、.jsonl 靠 archive.js 的 op，预设靠 presetBlocked），世界书和正则两个分支什么都不查，直接改 state 并提示成功。
 */
export function importBlockedReason() {
    if (restoreActive()) return '正在恢复，请稍等';
    if (persist.stopped) return STOPPED_TEXT;
    if (persist.readOnly) return '存储处于只读状态（见页面顶上的说明），不能导入';
    return null;
}

export async function importFiles(files) {
    const why = importBlockedReason();
    if (why) return void toast(why, 'error');
    const chatFiles = [];   // .jsonl 聊天记录：其余文件处理完后一起交给 importChatFiles（按角色名对到卡，同名 / 对不上时弹选择框）
    for (const file of files) {
        try {
            // 酒馆的整体备份 .zip：交给手机 Settings 的同一条导入路线（预览、勾选、一个事务写入，见 tavern-ui.js）
            if (/\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
                await importTavernZip(file);
                continue;
            }
            // 酒馆聊天记录：按角色名自动对到卡，变成那张卡的新存档（按扩展名判断，内容是一行一个 JSON，整体不是合法 JSON）
            if (/\.jsonl$/i.test(file.name)) {
                chatFiles.push(file);
                continue;
            }
            if (/\.png$/i.test(file.name) || file.type === 'image/png') {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const avatar = await new Promise((res, rej) => {
                    const r = new FileReader();
                    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
                    r.readAsDataURL(file);
                });
                await setCard(parseCard(readCardFromPng(bytes)), avatar);
                continue;
            }
            const json = JSON.parse(await file.text());
            const name = file.name.replace(/\.json$/i, '');
            const kind = detectJsonKind(json);
            if (kind === 'card') {
                await setCard(parseCard(json), '');
            } else if (kind === 'preset') {
                // 先清洗（migrate.js cleanPresetBody）：去掉酒馆写进预设的连接信息（反代地址 / 密码、附加请求头……，SmallTalk 不用），
                // 校正预设自带正则的字段类型。去掉了有内容的连接信息时提示一句——只说类别，不出现值
                const c = cleanPresetBody(json);
                // 新增一个预设并切过去，不替换已有的（同名时 addPreset 会在名字后加序号）。
                // 生成中 / 只读 / 预设存储没升级时会被拒绝（已经弹了提示）
                const used = await addPreset(c.preset, name);
                if (used === false) continue;
                const n = c.preset.extensions?.regex_scripts?.length ?? 0;
                const bits = [`已导入预设「${used}」：${c.preset.prompts.length} 个条目${n ? `，自带 ${n} 条正则` : ''}`];
                if (c.badRegex) bits.push(`${c.badRegex} 条自带正则格式不对，没有导入`);
                const note = sanitizeNotice(c.filled);
                if (note) bits.push(note);
                toast(bits.join('；'), 'ok');
            } else if (kind === 'worldbook') {
                // 和当前卡自带的那本世界书同名：额外世界书不能叫这个名字（「世界书」页按「书名 + uid」对触发结果，重名时两本的条目会串；
                // 改名时同样拒绝，见 tab-world.js renameBook）。导入时不拒绝，自动加「 (2)」之类，提示一句
                const own = cardBookNameOf(state.card);
                const bookName = own !== null && name === own
                    ? uniquePresetName(name, [own, ...state.books.map(b => b?.name).filter(n => typeof n === 'string')]) : name;
                const entries = parseWorldbook(json, bookName);
                // 全新的书：启用、对所有聊天生效（不写 enabled / scope / cards），排在最后。
                // 和已有的书同名：只换条目，开关 / 范围 / 绑定和它在列表里的位置都保留（books.js replaceBookEntries 里写了为什么）
                const r = replaceBookEntries(state.books, bookName, entries);
                state.books = r.list;
                const renamedNote = bookName !== name ? `（当前角色卡自带的世界书也叫「${name}」，为了区分，导入的这本改名为「${bookName}」）` : '';
                toast(r.replaced
                    ? `已更新「${bookName}」的内容（${entries.length} 个条目），开关和生效范围保持原样`
                    : `已导入世界书「${bookName}」${renamedNote}：${entries.length} 个条目。默认对所有聊天生效，可以到「世界书」页改成只对某张卡生效或关掉`, 'ok');
            } else if (kind === 'regex') {
                // 字段类型校正、丢掉没法用的（migrate.js cleanRegexList，规则见 regex.js sanitizeRegexScript）
                const c = cleanRegexList([].concat(json));
                const list = c.list.map(s => ({ ...s, id: s.id ?? uid() }));
                const ids = new Set(list.map(s => s.id));
                state.globalRegex = state.globalRegex.filter(s => !ids.has(s.id)).concat(list);
                toast(`已导入 ${list.length} 条正则（全局）${c.bad ? `，${c.bad} 条格式不对没有导入` : ''}`, list.length ? 'ok' : 'error');
            } else if (kind === 'personas') {
                importPersonasJson(json);   // 酒馆「人设管理」的备份文件：合并进人设列表（提示和拒绝条件都在里面）
            } else {
                toast(`认不出「${file.name}」是什么：不是角色卡、预设、世界书、正则或人设备份`, 'error');
            }
        } catch (e) {
            console.error(e);
            toast(`导入「${file.name}」失败：${e.message}`, 'error');
        }
    }
    ui.rendered.clear();
    save();
    renderAll();
    if (chatFiles.length) await importChatFiles(chatFiles);
}

/** 导入角色卡：新增一张卡并切过去（同名时 archive.addCard 会问是更新还是另存），不会覆盖别的卡和存档 */
export async function setCard(parsed, avatar) {
    if (!await addCard(parsed, avatar)) return;
    const bits = [];
    if (parsed.worldEntries.length) bits.push(`世界书 ${parsed.worldEntries.length} 条`);
    if (parsed.regexScripts.length) bits.push(`正则 ${parsed.regexScripts.length} 条`);
    // 酒馆助手脚本：新键 / 旧键、对象 / [[k,v]] 数组都认（scripts.js parseCardScripts）。第 1 期只能在「脚本」页看和改，不运行
    const nScripts = flattenScripts(parseCardScripts(parsed.raw)).length;
    if (nScripts) bits.push(`脚本 ${nScripts} 个（暂不运行）`);
    toast(`已导入角色卡「${parsed.name}」${bits.length ? '：' + bits.join('，') : ''}`, 'ok');
}

/** 弹出文件选择框读一个 JSON，交给 handler(json, 不带扩展名的文件名) */
export function pickJson(handler) {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        // 文件选择框是在恢复开始之前打开、恢复期间才选好的：一样拒绝（理由见 importBlockedReason）。
        // 只读 / 停止保存由各个 handler 自己的检查管（人设、条目导入都有），这里只补「正在恢复」这一条
        if (restoreActive()) return void toast('正在恢复，请稍等', 'error');
        try {
            await handler(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ''));
        } catch (e) {
            console.error(e);
            toast(`导入「${file.name}」失败：${e.message}`, 'error');
        }
    });
    input.click();
}
