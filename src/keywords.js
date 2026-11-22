// 世界书关键词输入框的拆分规则。纯函数，不碰 DOM，Node 里可测。
//
// 出处：酒馆 public/scripts/world-info.js 的 customTokenizer（~L2826）+ isValidRegex / parseRegexFromString（~L2889-2925）。
// 酒馆的关键词框是 select2 标签输入，按逗号切成一个个标签；但 `/正则/flags` 里允许有逗号
// （比如 /a{1,3}/），所以不能无脑 split(',')：
//   1. 扫描时遇到没转义的 `/`：第一个表示正则开始，第二个表示正则结束；
//   2. 遇到逗号时，如果处在「已开始还没结束」的正则里，这个逗号不算分隔符，继续往后读；
//   3. 逗号真正分隔时，取到的片段如果是合法的 /正则/flags 就整段留着；
//      如果以 `/` 开头却不是合法正则，说明那个 `/` 只是普通字符，退回到按逗号再切开；
//   4. 空片段丢掉，每段去首尾空白；最后剩下没遇到逗号的尾巴也算一个关键词。
// 和酒馆的差别有两处：
//   (a) 酒馆对最后那段没遇到逗号的尾巴原样当一个标签；这里同样套用第 3 条（否则整个框里只有一个没闭合的 / 时，后面的逗号全被吞掉）。
//   (b) 酒馆在切出一个片段后把下标重置成 0，随后 for 的 i++ 会让新片段的第一个字符
// 跳过 `/` 检测（粘贴一整串时 "a,/x,y/" 会被切坏；一个字一个字敲的话不会碰上）。这里重置成 -1，按它「本来想做的」处理。

/** 对应 parseRegexFromString：是不是一个能跑的 /pattern/flags（pattern 里的 / 必须转义）。 */
export function isValidRegexKeyword(input) {
    const match = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return false;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return false;
    pattern = pattern.replace('\\/', '/');
    try { new RegExp(pattern, flags); return true; } catch { return false; }
}

/** 文本框里的一串字 → 关键词数组（规则见文件头）。 */
export function splitKeywords(text) {
    const out = [];
    // 一个候选片段：合法正则整段保留；以 / 开头却不合法就退回按逗号再切；空的丢掉
    const push = raw => {
        const token = raw.trim();
        if (!token) return;
        if (token.startsWith('/') && !isValidRegexKeyword(token)) {
            for (const x of token.split(',').map(t => t.trim())) if (x) out.push(x);
        } else out.push(token);
    };
    let current = String(text ?? '');
    let insideRegex = false, regexClosed = false;
    for (let i = 0; i < current.length; i++) {
        const char = current[i];
        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }
        if (char !== ',') continue;
        if (insideRegex && !regexClosed) continue;   // 还在正则里面，逗号是正则的一部分
        push(current.slice(0, i));
        current = current.slice(i + 1);
        insideRegex = false; regexClosed = false;
        i = -1;
    }
    push(current);   // 没遇到逗号的尾巴
    return out;
}
