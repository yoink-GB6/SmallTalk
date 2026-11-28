// 导入聊天记录时，认出这份 .jsonl 属于哪张角色卡（纯函数，不碰页面；界面在 src/ui/import-chats.js）。
//
// 能用的线索只有名字：
//   - 酒馆 1.19.0 自己保存的聊天文件，头里的 character_name / user_name 是写死的字符串 'unused'（public/script.js saveChat），
//     chat_metadata 里也没有指向角色卡的字段；酒馆是靠「聊天文件放在以卡的文件名命名的目录里」来对应的，单个文件离开了目录就没有这条线索。
//   - 所以文件头里的名字只有老版本酒馆 / 别的工具导出的文件才是真名；是 'unused' 或没有时，退到消息里非用户一方的 name（出现最多的）。
//     这两步 chatfile.js 的 parseChatFile 已经做了（结果在它返回的 characterName 里），这里只管拿这个名字去比卡名。
//
// 比法：去首尾空白后先精确比；精确一张都没有，再不分大小写比。名字是空的 = 认不出，不会去匹配名字也是空的卡。

const norm = s => (typeof s === 'string' ? s.trim() : '');

/**
 * @param {string} characterName  聊天文件里的角色名（chatfile.js parseChatFile 的 characterName）
 * @param {{id: string, name: string}[]} cards  现有的卡
 * @returns {{name: string, ids: string[], how: 'exact'|'loose'|'none'}}
 *   ids：匹配到的卡 id（保持传入顺序）；how：怎么匹配上的。ids 恰好一个 = 可以直接导；多个 = 同名卡，要问；没有 = 要问
 */
export function matchChatToCards(characterName, cards) {
    const name = norm(characterName);
    const list = Array.isArray(cards) ? cards.filter(c => c && typeof c.id === 'string') : [];
    if (!name) return { name, ids: [], how: 'none' };
    const exact = list.filter(c => norm(c.name) === name);
    if (exact.length) return { name, ids: exact.map(c => c.id), how: 'exact' };
    const low = name.toLowerCase();
    const loose = list.filter(c => norm(c.name).toLowerCase() === low);
    if (loose.length) return { name, ids: loose.map(c => c.id), how: 'loose' };
    return { name, ids: [], how: 'none' };
}

/**
 * 一批文件处理完后的汇总文字。
 * @param {{imported: Map<string, {name: string, n: number}>, skipped: number, failed: {file: string, why: string}[]}} r
 *   imported：卡 id → {卡名, 导进了几个存档}
 * @returns {{text: string, ok: boolean}}  ok = 没有失败（跳过是用户自己选的，不算失败）
 */
export function summarizeChatImport(r) {
    const bits = [];
    const total = [...r.imported.values()].reduce((n, x) => n + x.n, 0);
    if (total) bits.push(`导入了 ${total} 个聊天记录：` + [...r.imported.values()].map(x => `「${x.name}」${x.n} 个`).join('、'));
    if (r.skipped) bits.push(`跳过 ${r.skipped} 个`);
    if (r.failed.length) bits.push(`失败 ${r.failed.length} 个（` + r.failed.map(f => `「${f.file}」${f.why}`).join('；') + '）');
    if (!bits.length) bits.push('没有导入任何聊天记录');
    return { text: bits.join('；'), ok: !r.failed.length };
}
