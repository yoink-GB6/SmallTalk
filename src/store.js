// IndexedDB 上的极简键值封装。数据库 smalltalk，对象仓库 kv，键为字符串（out-of-line）。
// 值使用结构化克隆，所以对象、Blob 都可以直接存。
// 只在函数内部访问 indexedDB，所以在 Node 里 import 不会报错。

const DB_NAME = 'smalltalk';
const STORE = 'kv';

let dbPromise = null;

/** 懒打开数据库，只打开一次，之后复用同一个 Promise。 */
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                dbPromise = null; // 失败后允许下次重试
                reject(req.error);
            };
        });
    }
    return dbPromise;
}

/**
 * 在一个事务里执行一次操作，事务完成后返回请求的 result。
 * @param {IDBTransactionMode} mode
 * @param {(os: IDBObjectStore) => IDBRequest} fn
 */
async function run(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
    });
}

export const store = {
    /** @returns {Promise<any>} 不存在返回 undefined */
    get: (key) => run('readonly', (os) => os.get(key)),
    /** @returns {Promise<void>} */
    set: async (key, value) => {
        await run('readwrite', (os) => os.put(value, key));
    },
    /** @returns {Promise<void>} */
    del: async (key) => {
        await run('readwrite', (os) => os.delete(key));
    },
    /**
     * 在【同一个事务】里执行多个写 / 删：要么全部生效，要么（任何一步出错）全部不生效。
     * 存档层用它保证「卡、存档、全局、meta」不会只写进去一半。
     * @param {Array<{set: string, value: any} | {del: string}>} ops
     * @returns {Promise<void>}
     */
    batch: async (ops) => {
        if (!ops.length) return;
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
            try {
                for (const op of ops) {
                    if ('set' in op) os.put(op.value, op.set);
                    else os.delete(op.del);
                }
            } catch (e) {
                // put 同步抛错（比如值不能结构化克隆）：中止整个事务，前面已经排进去的写也一起作废
                try { tx.abort(); } catch { /* 已经中止 */ }
                reject(e);
            }
        });
    },
    /**
     * 读-改-写放在同一个事务里：先读出 keys 的当前值，交给 fn，fn 返回要执行的写 / 删（同 batch 的格式）。
     * 读和写之间别的事务插不进来。用于「给某个不在内存里的存档补一条记忆」：
     * 存档已经被删掉时 fn 读到 undefined，返回 []，就不会把它写回来。
     * @param {string[]} keys
     * @param {(values: any[]) => Array<{set: string, value: any} | {del: string}>} fn
     * @returns {Promise<boolean>} 是否写了东西
     */
    transact: async (keys, fn) => {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            let wrote = false;
            tx.oncomplete = () => resolve(wrote);
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
            const values = new Array(keys.length);
            let left = keys.length;
            const done = () => {
                try {
                    const ops = fn(values) ?? [];
                    for (const op of ops) ('set' in op ? os.put(op.value, op.set) : os.delete(op.del));
                    wrote = ops.length > 0;
                } catch (e) {
                    try { tx.abort(); } catch { /* 已经中止 */ }
                    reject(e);
                }
            };
            if (!left) return done();
            keys.forEach((k, i) => { os.get(k).onsuccess = (e) => { values[i] = e.target.result; if (--left === 0) done(); }; });
        });
    },
    /** @returns {Promise<string[]>} 以 prefix 开头的所有键 */
    keys: async (prefix = '') => {
        const all = await run('readonly', (os) => os.getAllKeys());
        return all.filter((k) => String(k).startsWith(prefix));
    },
};
