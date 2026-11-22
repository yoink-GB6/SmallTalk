// 字数 → token 的粗估。
//
// 照酒馆在「没有分词器可用」时的做法（public/scripts/tokenizers.js 的 guesstimate）：
//   token ≈ ceil(UTF-8 字节数 / 3.35)
// 3.35 是酒馆的 BYTES_PER_TOKEN。
//
// 准不准：对英文还行（1 token 约 4 个字节，这里偏保守一点）。中文一个字 3 字节，
// 于是约等于 0.9 token / 字；真实分词器里中文常见是 0.6–1.5 token / 字，随模型差得多，
// 所以中文内容误差可达三四成。只能拿来比大小、估量级，不能当计费依据。
// 想精确要用各家的分词器或接口返回的 usage，本项目没有。

export const BYTES_PER_TOKEN = 3.35;

const encoder = new TextEncoder();

/** @param {string} text @returns {number} 估算的 token 数（向上取整）；空串为 0 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(encoder.encode(String(text)).length / BYTES_PER_TOKEN);
}
