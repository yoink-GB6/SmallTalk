// 斜杠命令串的切分（纯函数，Node 里可测）。执行在 ui/frame-host.js runSlash。
// 照酒馆 STscript 的写法学的（只学规则，实现自己写）：
//   - 命令之间用 | 隔开；`\|` 是字面的竖线；参数值用英文双引号 "…" 括起来时，里面的 | 不算分隔（引号只在一个参数值的开头才算：
//     前面是开头、空白或 =）。中文引号「」“”就是普通字符。
//   - 每条命令：/名字 [键=值 …] 其余文字。键=值 只认开头连续的那几个（值可以加引号），后面的全是「无名参数」原样保留（中间的空格、括号都不动）。
//   - 无名参数整个被一对英文双引号括起来时去掉引号。

/**
 * @param {string} input
 * @returns {{name: string, named: Record<string, string>, text: string, raw: string}[]}  不以 / 开头的段落丢掉
 */
export function parseSlash(input) {
    const parts = [];
    let cur = '', inQuote = false;
    const s = String(input ?? '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (c === '\\' && s[i + 1] === '"' && inQuote) { cur += '\\"'; i++; continue; }
        if (c === '"') {
            const prev = cur.length ? cur[cur.length - 1] : '';
            if (inQuote) inQuote = false;
            else if (prev === '' || /\s|=/.test(prev)) inQuote = true;
            cur += c; continue;
        }
        if (c === '|' && !inQuote) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    parts.push(cur);
    const out = [];
    for (const p of parts) {
        const t = p.trim();
        const m = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
        if (!m) continue;
        let rest = m[2];
        const named = {};
        for (;;) {
            const nm = /^([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S*)\s*/.exec(rest);
            if (!nm) break;
            let v = nm[2];
            if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
            named[nm[1].toLowerCase()] = v;
            rest = rest.slice(nm[0].length);
        }
        let text = rest.trim();
        if (text.length >= 2 && text.startsWith('"') && text.endsWith('"') && !text.slice(1, -1).includes('"')) text = text.slice(1, -1);
        out.push({ name: m[1].toLowerCase(), named, text, raw: t });
    }
    return out;
}
