// 外置记忆的请求队列（纯调度，不碰页面、不碰 state，Node 里可以直接单元测试）。ui/memory.js 用它发逐轮压缩和合并请求。
//
// 为什么要排队（2026-11-23 用户定）：以前 ensureMemories 一次循环里把所有待压的轮、所有能合并的组连着发完——
// 导入一个几百轮的聊天记录、或第一次给长存档设「再次压缩」，会瞬间连发上百个请求。现在的规矩：
//   - 所有记忆请求（逐轮压缩 + 合并）统一排队：一次只发一个，前一个结束后隔 gapMs（默认 MEMORY_REQUEST_GAP_MS = 2 秒）再发下一个。
//     「隔 2 秒」按上一个请求真正结束的时刻算，跨运行也算（队列空了、几百毫秒后又来一条新回复，也要等够 2 秒）。
//     不发请求的活（回复很短，直接拿原文当摘要）不用等、也不算「上一个请求」。
//   - 每发一个之前、每次等完都重新问 allowed()：关掉外置记忆、切存档、只读、停止保存、恢复备份中 → 停下，不再发新的
//     （在途的那个照常回来，写不写由调用方的迟到核对决定）。下次 kick（新回复、「补全 / 重试」……）时接着来：要做什么每次现挑，本来就幂等。
//   - 手动触发的那一条（「记忆」页某一行的「重压」）用 prioritize 排到最前。
//   - 连续失败 maxFails 次（默认 3）就整体停下（halted，带最后一次的原因），不再把后面几百个都打一遍失败；resume() 清掉后继续。
//     发出去并且成功回来的请求把计数清零。
//   - 页面关了就停（这里没有任何持久状态）。
//
// 工作项（job）由调用方给：{key, sends, ...}。key 用来认「手动优先的那一条」；sends = 这件活会不会真的发请求（决定要不要等间隔）。
// 结果：exec(job) 返回 {sent, outcome: 'ok' | 'fail' | 'stop', error?}。sent = 真的发了请求；stop = 这一次运行到此为止（不算失败）。

/** 两个记忆请求之间至少隔这么久（毫秒）。测试里改 ui/memory.js 的 memoryTuning.gapMs */
export const MEMORY_REQUEST_GAP_MS = 2000;
/** 连续失败这么多次，队列整体停下 */
export const MEMORY_MAX_FAILS = 3;

/**
 * @param {object} d
 * @param {() => void} [d.begin]                一次运行开始时调（ui/memory.js 记下这次运行属于哪个存档）
 * @param {() => void} [d.end]                  一次运行结束时调（不管怎么结束的）
 * @param {() => boolean} d.allowed             现在能不能接着发。每挑一件活之前、每次等完间隔都问
 * @param {(key: any) => object|null} d.jobFor  手动优先的那一条现在还要不要做：要就返回 job，不要（已经做完 / 不存在了）返回 null
 * @param {() => object|null} d.nextJob         按正常顺序的下一件活；没有返回 null
 * @param {(job: object) => Promise<{sent: boolean, outcome: 'ok'|'fail'|'stop', error?: string}>} d.exec
 * @param {() => number} [d.gapMs]
 * @param {() => number} [d.maxFails]
 * @param {() => number} [d.now]
 * @param {(ms: number) => Promise<void>} [d.sleep]
 * @param {() => void} [d.onChange]             状态变了（开始 / 结束 / 一件活做完 / 停下）：给界面重画状态行
 */
export function createMemoryQueue(d) {
    const gap = () => Math.max(0, Number(d.gapMs?.() ?? MEMORY_REQUEST_GAP_MS) || 0);
    const maxFails = () => Math.max(1, Number(d.maxFails?.() ?? MEMORY_MAX_FAILS) || MEMORY_MAX_FAILS);
    const now = d.now ?? (() => Date.now());
    const sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    const changed = () => { try { d.onChange?.(); } catch (e) { console.error(e); } };

    /** running：有一次运行在进行（含等间隔）；inFlight：正在等回来的请求数（永远 ≤ 1）；halted：连续失败停下了 {reason, count} */
    const q = { running: false, inFlight: 0, halted: null, fails: 0, lastEnd: -Infinity };
    let priority = [];      // 手动优先的 key，最新点的在最前
    let rerun = false;      // 运行期间又被 kick 过：这次结束后再跑一次（比如换了存档后来的新回复）
    let current = null;     // 当前这次运行的 promise

    async function run() {
        d.begin?.();
        let lastKey = null;
        try {
            for (;;) {
                if (q.halted || !d.allowed()) return;
                let job = null;
                while (priority.length && !(job = d.jobFor(priority[0]))) priority.shift();
                job ??= d.nextJob();
                if (!job) return;
                if (job.sends) {
                    const wait = q.lastEnd + gap() - now();
                    // 没到时间：等够了再从头挑（等的这段时间里可能关了开关、切了存档、点了别的「重压」）
                    if (wait > 0) { await sleep(wait); continue; }
                }
                let r;
                q.inFlight++;
                try { r = await d.exec(job); }
                catch (e) { r = { sent: Boolean(job.sends), outcome: 'fail', error: String(e?.message ?? e) }; }
                finally { q.inFlight--; }
                r ??= { sent: false, outcome: 'ok' };
                if (r.sent) q.lastEnd = now();
                // 兜底：不发请求的活（短回复直接用原文）做完后这件活应该就没了；同一件连着挑中又不发请求，说明调用方没写进去——停下，免得空转
                if (!r.sent && job.key === lastKey) { console.error('记忆队列：同一件活连续被挑中，停下', job.key); return; }
                lastKey = r.sent ? null : job.key;
                if (priority[0] === job.key) priority.shift();
                if (r.outcome === 'fail') {
                    q.fails++;
                    if (q.fails >= maxFails()) { q.halted = { reason: String(r.error ?? ''), count: q.fails }; changed(); return; }
                } else if (r.sent) q.fails = 0;
                changed();
                if (r.outcome === 'stop') return;
            }
        } finally {
            try { d.end?.(); } catch (e) { console.error(e); }
        }
    }

    /** 有活就开始（已经在跑就只记一笔「结束后再看一眼」）。停下（halted）时什么都不做。返回这次运行的 promise */
    function kick() {
        if (q.running) { rerun = true; return current; }
        if (q.halted) return Promise.resolve();
        q.running = true;
        rerun = false;
        changed();
        current = run().catch(e => console.error('记忆队列出错', e)).finally(() => {
            q.running = false;
            current = null;
            changed();
            if (rerun) { rerun = false; kick(); }
        });
        return current;
    }

    return {
        state: q,
        kick,
        /** 手动触发的那一条排到最前，并开始 */
        prioritize(key) {
            priority = [key, ...priority.filter(k => k !== key)];
            return kick();
        },
        /** 连续失败停下之后：清掉停下的状态和计数，接着来（「补全 / 重试」） */
        resume() {
            q.halted = null;
            q.fails = 0;
            return kick();
        },
        /** 现在这次运行结束（测试用）。没在跑就立刻好 */
        idle: () => current ?? Promise.resolve(),
    };
}
