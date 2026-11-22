// 「导入」按钮用的多文件选择框：选好的文件原样交给 importer.js 的 importFiles，由它按内容认出是预设 / 正则 / ……
// （预设仍然走 cleanPresetBody / sanitizePreset，正则走 cleanRegexList，都在 importFiles 里，这里不另写）。
// pickJson（importer.js）一次只能选一个文件，所以多选另写；本文件不 import 别的 ui 模块之外的东西，避免加深循环依赖。

import { h } from './dom.js';
import { importFiles } from './importer.js';

/** 弹出文件选择框（可多选 .json），选完交给 importFiles。 */
export function pickAndImportFiles() {
    const input = h('input', { type: 'file', accept: '.json,application/json', multiple: true });
    input.addEventListener('change', () => {
        const files = [...input.files];
        if (files.length) importFiles(files);   // importFiles 自己会先检查「正在恢复 / 只读 / 停止保存」并给提示
    });
    input.click();
}
