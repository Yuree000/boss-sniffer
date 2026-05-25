// captures TTL 清理：超过 maxAgeMs 的 captures 记录在 SW 启动 + 每 6 小时 alarm 时清掉
(function (global) {
  'use strict';
  const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const STORE = 'captures';

  /**
   * 删掉 captures 表里超过 maxAgeMs 的旧 BOSS 抓包记录(默认 7 天)
   * SW 启动 + 每 6 小时 alarm 自动调一次,防止 IDB 持续膨胀
   *
   * 参数:
   *   - maxAgeMs: 最大保留毫秒数;不传走默认 7 天
   *
   * 返回: Promise<{ deleted: 删除的条目数 }>
   */
  async function cleanExpiredCaptures(maxAgeMs) {
    const cutoff = Date.now() - (maxAgeMs || DEFAULT_MAX_AGE_MS);
    if (typeof self.BOSS_OPEN_DB !== 'function') return { deleted: 0 };
    const db = await self.BOSS_OPEN_DB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const idx = store.index('capturedAt');
      const range = IDBKeyRange.upperBound(cutoff, true);
      let deleted = 0;
      const req = idx.openCursor(range);
      req.onsuccess = function (e) {
        const cur = e.target.result;
        if (cur) {
          cur.delete();
          deleted++;
          cur.continue();
        }
      };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { resolve({ deleted: deleted }); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  global.BossCapturesCleaner = {
    cleanExpiredCaptures: cleanExpiredCaptures,
    DEFAULT_MAX_AGE_MS: DEFAULT_MAX_AGE_MS
  };
})(self);
