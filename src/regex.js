// 正则脚本引擎，对照酒馆 public/scripts/extensions/regex/engine.js 与 utils.js。
// 纯字符串变换，不依赖 Node / 浏览器专有 API。

/** 对应 engine.js regex_placement（MD_DISPLAY=0 和 4 已废弃，不收） */
export const REGEX_PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };

/**
 * 对应 utils.js regexFromString，逻辑逐行照抄。
 * - "/body/flags"：取 body 和 flags；
 * - 裸字符串（没有前导 "/"）：第一个捕获组为空，整串当 body，flags 为空；
 * - flags 重复或含非法字母：把整个输入当 body：RegExp(input)；
 * - 编译失败（或输入不是字符串 / 空串）：返回 undefined。
 * @param {string} input
 * @returns {RegExp|undefined}
 */
export function regexFromString(input) {
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    // 非法 flags（重复或不在白名单里）
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return RegExp(input);
    }
    return new RegExp(m[2], m[3]);
  } catch {
    return undefined;
  }
}

// 对应 engine.js RegexProvider：按字符串缓存编译结果（酒馆上限 1000，LRU）
const cache = new Map();
const CACHE_MAX = 1000;
// 编译失败的脚本 id，只警告一次
const warned = new Set();

function getRegex(str) {
  let re = cache.get(str);
  if (re) {
    cache.delete(str); // LRU：重新插入到末尾
  } else {
    re = regexFromString(str);
    if (!re) return null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(str, re);
  if (re.global || re.sticky) re.lastIndex = 0; // 复用对象要重置
  return re;
}

// 对应 engine.js sanitizeRegexMacro：mode 2 下把宏的值转义成正则字面量
function sanitizeRegexMacro(x) {
  return x && typeof x === 'string'
    ? x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
        switch (s) {
          case '\n': return '\\n';
          case '\r': return '\\r';
          case '\t': return '\\t';
          case '\v': return '\\v';
          case '\f': return '\\f';
          case '\0': return '\\0';
          default: return '\\' + s;
        }
      })
    : x;
}

// 对应 engine.js filterString：从捕获内容里删掉 trimStrings（trim 串本身也过宏）
function filterString(raw, trimStrings, substitute) {
  let s = raw;
  (trimStrings || []).forEach((t) => {
    s = s.replaceAll(substitute(t), '');
  });
  return s;
}

/**
 * 对应 engine.js runRegexScript。返回新文本（脚本不适用 / 正则无效则原样返回）。
 */
function runOne(script, raw, substitute) {
  if (!script || script.disabled || !script.findRegex || !raw) return raw;

  // 对应 getRegexString：先对查找串做宏替换
  let regexString;
  switch (Number(script.substituteRegex)) {
    case 1:
      regexString = substitute(script.findRegex);
      break;
    case 2:
      // 酒馆是 substituteParamsExtended(find, {}, sanitizeRegexMacro)：每个宏的「值」单独转义，
      // 查找串里的字面正则不动。这里没有 postprocess 回调，只能先逐个找到 {{...}} 再单独替换并转义，
      // 效果等价于常见宏；嵌套宏（如 {{getvar::{{x}}}}）会按最外层的非贪婪匹配切分，可能与酒馆不同。
      regexString = script.findRegex.replace(/\{\{[\s\S]*?\}\}/g, (m) => sanitizeRegexMacro(substitute(m)));
      break;
    default:
      regexString = script.findRegex;
  }
  const findRegex = getRegex(regexString);
  if (!findRegex) {
    if (!warned.has(script.id)) {
      warned.add(script.id);
      console.warn(`regex: 脚本 ${script.scriptName ?? script.id} 的 findRegex 无法编译，已跳过`);
    }
    return raw;
  }

  return raw.replace(findRegex, function (match) {
    const args = [...arguments];
    // {{match}} → $0（整段匹配）
    const replaceString = (script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    // $1.. / $<name>：手动展开，并对捕获内容做 trimStrings
    const withGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
      let m;
      if (num) {
        m = args[Number(num)];
      } else if (groupName) {
        const groups = args[args.length - 1];
        m = groups && typeof groups === 'object' && groups[groupName];
      }
      if (!m) return ''; // 没有这个组 → 空串
      return filterString(m, script.trimStrings, substitute);
    });
    // 最后再对整个替换结果做一次宏替换
    return substitute(withGroups);
  });
}

// ───────────────────────────── 字段类型的校正 ─────────────────────────────
//
// 上面的 runOne / runRegexScripts（以及「正则」页 ui/tab-regex.js）会直接在脚本字段上调方法：
//   trimStrings.forEach、replaceString.replace、placement.includes、findRegex.replace（substituteRegex 为 2 时）。
// 字段类型不对（手改的文件、别的工具写的、坏掉的备份）就会抛错，整条消息发不出去（复核实测：trimStrings: "x" → forEach is not a function；
// replaceString: 5 → .replace is not a function；placement: {} → includes is not a function）。
// 所以所有正则进入系统的地方（migrate.js cleanRegexList 是唯一的入口，各处都调它）先过这里：
//   - 缺 findRegex、或者它不是字符串：这条脚本没法用，整条丢掉（返回 null，调用方计入「跳过」）；
//   - 字段【存在但类型不对】才动它，缺的字段保持缺着（运行时都有默认值：replaceString ?? ''、trimStrings || []、placement?.includes）；
//   - 合法脚本（字段类型都对）原样返回【同一个对象】，一个字段都不改——「正则」页切开关是直接改这个对象的。
// 默认值按酒馆：trimStrings / placement 是空数组，minDepth / maxDepth 是 null（不限）。

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrim = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const BOOL_FIELDS = ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit'];

/**
 * 校正一条正则脚本的字段类型。
 * @param {any} s
 * @returns {Object|null}  null = 没法用（不是对象 / 没有字符串的 findRegex）；字段都对时返回 s 本身
 */
export function sanitizeRegexScript(s) {
  if (!isPlainObj(s) || typeof s.findRegex !== 'string') return null;
  let out = s;
  const set = (k, v) => { if (out === s) out = { ...s }; out[k] = v; };
  const has = k => Object.hasOwn(s, k) && s[k] !== undefined;

  // 字符串字段：null 照旧（运行时 ?? '' 会兜住）；数字 / 布尔转成字符串；对象 / 数组没法转，当空串
  for (const k of ['replaceString', 'scriptName']) {
    if (!has(k) || s[k] === null || typeof s[k] === 'string') continue;
    set(k, isPrim(s[k]) ? String(s[k]) : '');
  }
  // trimStrings：要是字符串数组（每一项还要过宏替换，宏替换对非字符串会抛错）。null 照旧（运行时 || [] 兜住）
  if (has('trimStrings') && s.trimStrings !== null) {
    if (!Array.isArray(s.trimStrings)) set('trimStrings', []);
    else if (!s.trimStrings.every(t => typeof t === 'string')) {
      set('trimStrings', s.trimStrings.filter(t => typeof t === 'string' || typeof t === 'number').map(String));
    }
  }
  // placement：数字数组（1 用户输入、2 AI 输出……）。单个数字当成只有它的数组；数字样的字符串转成数字；别的丢掉
  if (has('placement') && s.placement !== null) {
    const toNum = p => (typeof p === 'number' ? p : typeof p === 'string' && p.trim() !== '' && Number.isFinite(Number(p)) ? Number(p) : null);
    if (Array.isArray(s.placement)) {
      if (!s.placement.every(p => typeof p === 'number')) set('placement', s.placement.map(toNum).filter(p => p !== null));
    } else {
      const n = toNum(s.placement);
      set('placement', n === null ? [] : [n]);
    }
  }
  // 深度：数字或 null（不限）。数字样的字符串转成数字，别的当 null
  for (const k of ['minDepth', 'maxDepth']) {
    if (!has(k) || s[k] === null || typeof s[k] === 'number') continue;
    const n = typeof s[k] === 'string' && s[k].trim() !== '' ? Number(s[k]) : NaN;
    set(k, Number.isFinite(n) ? n : null);
  }
  // 开关：运行时只看真假，转成布尔不改变行为（"false" 这种字符串本来就被当成「真」）
  for (const k of BOOL_FIELDS) {
    if (has(k) && s[k] !== null && typeof s[k] !== 'boolean') set(k, Boolean(s[k]));
  }
  return out;
}

/**
 * 对应 engine.js getRegexedString：按顺序跑一组脚本。
 * @param {string} text
 * @param {import('./types.js').RegexScript[]} scripts
 * @param {import('./types.js').RegexRunOptions} options
 * @returns {string}
 */
export function runRegexScripts(text, scripts, options) {
  if (typeof text !== 'string') return '';
  const { placement, isMarkdown, isPrompt, isEdit, depth, onApply } = options || {};
  const substitute = options?.substitute ?? ((t) => t);
  if (!text || placement === undefined) return text;

  let final = text;
  for (const script of scripts || []) {
    // 标志位过滤：markdownOnly/promptOnly/都不勾（且调用也不是显示/prompt）
    const gate =
      (script.markdownOnly && isMarkdown) ||
      (script.promptOnly && isPrompt) ||
      (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
    if (!gate) continue;
    if (isEdit && !script.runOnEdit) continue;

    // 深度过滤：minDepth 仅当 >= -1 生效，maxDepth 仅当 >= 0 生效（null / NaN 视为不限）
    if (typeof depth === 'number') {
      if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) continue;
      if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
    }

    if (!script.placement?.includes(placement)) continue;
    const after = runOne(script, final, substitute);
    if (after !== final) onApply?.({ script, before: final, after });
    final = after;
  }
  return final;
}
