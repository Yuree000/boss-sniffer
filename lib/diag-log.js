// BOSS Sniffer - diag-log.js (observability v1)
// 诊断日志环形 buffer,落 IDB store `diag_logs`,最多 500 条。
//
// ⚠ 与 lib/events.js 区别(容易混淆):
//   - 本 lib (diag-log.js) = 【技术调试日志】:代码执行轨迹(评估开始/失败/重试/超时等),环形 500 条,
//     诊断包导出时收集。level/tag/msg 自由,不限枚举。
//   - lib/events.js         = 【业务漏斗事件】:7 个 stage 白名单(候选人池/标 pass/已发招呼/已回复...),
//     永久保留,看板渲染来源。stage 乱写抛错。
//   两者都写 IDB 但表不同(diag_logs vs events),且 API 风格不同。新业务事件去 events.js,新调试日志在这。
//
// 设计原则:
//   - 可观测性模块自身不能拖垮主链路。所有 IDB 操作 try/catch 兜底,失败只 console.warn,不抛错。
//   - 不做内存 buffer。SW 重启即丢的话相当于没记。直接写 IDB,SW 复活后历史仍在。
//   - 环形:每次写后查 count,超过 MAX_ENTRIES 删 id 最小的若干条。
//
// 公开 API:
//   self.BossDiag.log(level, tag, msg, payload?)
//   self.BossDiag.recent(limit?)              → Promise<Entry[]>,按 ts 降序(最新在前)
//   self.BossDiag.clearAll()                  → Promise<void>
//
// Entry schema:
//   { id: auto, ts: number, level: 'info'|'warn'|'error', tag: string, msg: string, payload: object|null }
//
// 依赖(由 background.js 提供):
//   self.BOSS_OPEN_DB         → 返回 IDBDatabase Promise
//   self.BOSS_STORE_DIAG_LOGS → store name 字符串

(function (global) {
  'use strict';

  const MAX_ENTRIES = 500;
  const VALID_LEVELS = ['info', 'warn', 'error'];

  function openDb() {
    if (typeof self.BOSS_OPEN_DB !== 'function') {
      return Promise.reject(new Error('BOSS_OPEN_DB 未注册(background.js 未加载完?)'));
    }
    return self.BOSS_OPEN_DB();
  }

  function storeName() {
    return self.BOSS_STORE_DIAG_LOGS || 'diag_logs';
  }

  /**
   * 核心写入入口:落 IDB + 桥接 console.{info|warn|error}(开发态看 DevTools 即得实时日志)
   * 所有错误都吞掉只 console.warn,不污染主链路
   *
   * 参数:
   *   - level: 'info' | 'warn' | 'error'(非法值降级 info)
   *   - tag: 模块/场景标签(如 'judge.retry' / 'sayhi.consume')
   *   - msg: 一句话日志正文
   *   - payload: 可选,结构化附加数据
   *
   * 返回: Promise(无返回值;失败只 console.warn)
   */
  async function log(level, tag, msg, payload) {
    const lvl = VALID_LEVELS.indexOf(level) !== -1 ? level : 'info';
    try {
      const consoleFn = lvl === 'error' ? console.error
                       : lvl === 'warn' ? console.warn
                       : console.info;
      const prefix = '[diag][' + (tag || '?') + ']';
      if (payload && typeof payload === 'object') consoleFn(prefix, msg, payload);
      else consoleFn(prefix, msg);
    } catch (_e) { /* console 失败也吞 */ }
    try {
      const entry = {
        ts: Date.now(),
        level: lvl,
        tag: String(tag || ''),
        msg: String(msg || ''),
        payload: (payload && typeof payload === 'object') ? payload : null
      };
      const db = await openDb();
      await new Promise(function (resolve) {
        const tx = db.transaction(storeName(), 'readwrite');
        const store = tx.objectStore(storeName());
        store.add(entry);
        tx.oncomplete = resolve;
        tx.onerror = function () { resolve(); };  // 写失败不抛
        tx.onabort = function () { resolve(); };
      });
      // 不阻塞:清理放后台 fire-and-forget
      maybeTrim().catch(function () {});
    } catch (e) {
      console.warn('[BossDiag] log failed:', e && e.message);
    }
  }

  /**
   * 环形 buffer 维护:count > MAX_ENTRIES 时删最早(id 最小)的若干条
   * 每次 log 后 fire-and-forget 调用,不阻塞写入
   *
   * 返回: Promise(无返回值;失败只 console.warn)
   */
  async function maybeTrim() {
    try {
      const db = await openDb();
      const count = await new Promise(function (resolve) {
        const tx = db.transaction(storeName(), 'readonly');
        const req = tx.objectStore(storeName()).count();
        req.onsuccess = function () { resolve(req.result || 0); };
        req.onerror = function () { resolve(0); };
      });
      if (count <= MAX_ENTRIES) return;
      const toDelete = count - MAX_ENTRIES;
      await new Promise(function (resolve) {
        const tx = db.transaction(storeName(), 'readwrite');
        const store = tx.objectStore(storeName());
        const cur = store.openCursor();
        let deleted = 0;
        cur.onsuccess = function (ev) {
          const cursor = ev.target.result;
          if (!cursor || deleted >= toDelete) { resolve(); return; }
          cursor.delete();
          deleted++;
          cursor.continue();
        };
        cur.onerror = function () { resolve(); };
      });
    } catch (e) {
      console.warn('[BossDiag] trim failed:', e && e.message);
    }
  }

  /**
   * 拉最近 N 条诊断日志,按 ts 降序(最新在前)
   * admin 诊断包导出 / 调试面板用
   *
   * 参数:
   *   - limit: 最多返回多少条;默认 / 超界返回 MAX_ENTRIES(500)
   *
   * 返回: Promise<Entry[]> Entry = { id, ts, level, tag, msg, payload }
   */
  async function recent(limit) {
    try {
      const max = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || MAX_ENTRIES));
      const db = await openDb();
      const all = await new Promise(function (resolve) {
        const tx = db.transaction(storeName(), 'readonly');
        const req = tx.objectStore(storeName()).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      });
      all.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return all.slice(0, max);
    } catch (e) {
      console.warn('[BossDiag] recent failed:', e && e.message);
      return [];
    }
  }

  /**
   * 清空 diag_logs 表所有日志(admin 手动重置诊断状态用)
   *
   * 返回: Promise(无返回值;失败只 console.warn)
   */
  async function clearAll() {
    try {
      const db = await openDb();
      await new Promise(function (resolve) {
        const tx = db.transaction(storeName(), 'readwrite');
        tx.objectStore(storeName()).clear();
        tx.oncomplete = resolve;
        tx.onerror = function () { resolve(); };
      });
    } catch (e) {
      console.warn('[BossDiag] clearAll failed:', e && e.message);
    }
  }

  global.BossDiag = {
    log: log,
    recent: recent,
    clearAll: clearAll,
    MAX_ENTRIES: MAX_ENTRIES
  };
})(self);
