// FSA 备份：sidepanel 上下文消费 pending_fsa_writes 队列，按月全量重写 JSON
// 必须在有 user gesture 的页面里调用（sidepanel 或 admin），不能在 SW
(function (global) {
  'use strict';
  const DB_NAME = 'boss-sniffer-db';
  const DB_VERSION = 5;

  function openDB() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // 防御性 onupgradeneeded：正常情况由 background.js 在 SW 启动时建好
      // 但 sidepanel 比 SW 早开 IDB 时这里要兜底，避免 NotFoundError
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('fsa_state')) {
          db.createObjectStore('fsa_state', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('pending_fsa_writes')) {
          const s = db.createObjectStore('pending_fsa_writes', { keyPath: 'month' });
          s.createIndex('enqueuedAt', 'enqueuedAt', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 模块作用域句柄缓存。
  // 关键：Chrome 的 FSA requestPermission 需要 transient user activation；
  // 点击事件后链路里只要走 await openDB → await IDB get → handle.requestPermission，
  // 中间多次 microtask 会让 user gesture 丢，requestPermission 静默失败（不弹框）。
  // 缓存让 click handler 能同步拿到 handle，绕过 IDB 异步读。
  let _cachedHandle = null;

  // 句柄读写：fsa_state store
  async function saveDirHandle(handle) {
    _cachedHandle = handle;  // 缓存同步更新，避免 pick 后再读 IDB
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('fsa_state', 'readwrite');
      tx.objectStore('fsa_state').put({ key: 'backup-dir', handle: handle });
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }
  async function loadDirHandle() {
    if (_cachedHandle) return _cachedHandle;
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('fsa_state', 'readonly');
      const req = tx.objectStore('fsa_state').get('backup-dir');
      req.onsuccess = function () {
        _cachedHandle = req.result && req.result.handle;
        resolve(_cachedHandle);
      };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function clearDirHandle() {
    _cachedHandle = null;
    const db = await openDB();
    return new Promise(function (resolve) {
      const tx = db.transaction('fsa_state', 'readwrite');
      tx.objectStore('fsa_state').delete('backup-dir');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  // 状态枚举：UI 据此渲染 banner
  // 'no-handle'   → 黄条「未配置备份目录」
  // 'prompt'      → 红条「需要恢复备份权限」
  // 'granted'     → 隐藏 banner，静默消费
  // 'denied'      → 红条「权限被拒，点这里重选目录」
  // 'unsupported' → 红条「浏览器不支持 FSA」
  async function getStatus() {
    if (!window.showDirectoryPicker) return 'unsupported';
    const handle = await loadDirHandle();
    if (!handle) return 'no-handle';
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return perm;  // 'granted' | 'prompt' | 'denied'
  }

  // 用户手势触发：选目录
  async function pickDir() {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'boss-sniffer-backup' });
    await saveDirHandle(handle);
    return handle;
  }

  // 用户手势触发：请求权限
  // 必须在 click handler 同步链路上调用：cached handle 让我们跳过 await IDB，
  // 保住 transient user activation 给 handle.requestPermission 用。
  async function requestPermission() {
    if (!_cachedHandle) {
      // 缓存丢了（异常分支），临时从 IDB 拿一次——可能会丢 gesture，但比无所适从好
      _cachedHandle = await loadDirHandle();
    }
    if (!_cachedHandle) throw new Error('no handle');
    return await _cachedHandle.requestPermission({ mode: 'readwrite' });
  }

  // 全量读某月数据 → 写成单文件
  async function writeMonthFile(month) {
    const handle = await loadDirHandle();
    if (!handle) throw new Error('no handle');
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('permission not granted');

    const parts = month.split('-').map(Number);
    const year = parts[0];
    const mon = parts[1];
    const startTs = new Date(year, mon - 1, 1).getTime();
    const endTs = new Date(year, mon, 1).getTime();

    const db = await openDB();
    const evaluations = await readByRange(db, 'evaluations', 'judgedAt', startTs, endTs);
    const events = await readByRange(db, 'events', 'ts', startTs, endTs);

    const payload = {
      month: month,
      generatedAt: Date.now(),
      evaluations: evaluations,
      events: events
    };

    const fileHandle = await handle.getFileHandle(month + '.json', { create: true });
    const writer = await fileHandle.createWritable();
    await writer.write(JSON.stringify(payload, null, 2));
    await writer.close();
    return { evaluations: evaluations.length, events: events.length };
  }

  function readByRange(db, storeName, indexName, lo, hi) {
    return new Promise(function (resolve, reject) {
      let tx;
      try { tx = db.transaction(storeName, 'readonly'); }
      catch (e) { reject(e); return; }
      const store = tx.objectStore(storeName);
      let idx;
      try { idx = store.index(indexName); }
      catch (e) { reject(e); return; }
      const range = IDBKeyRange.bound(lo, hi, false, true);
      const out = [];
      const req = idx.openCursor(range);
      req.onsuccess = function (e) {
        const cur = e.target.result;
        if (cur) { out.push(cur.value); cur.continue(); }
        else resolve(out);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 消费 pending 队列：取出所有 month，逐个 writeMonthFile，成功后删队列项
  async function consumePending() {
    const db = await openDB();
    const pending = await new Promise(function (resolve, reject) {
      const tx = db.transaction('pending_fsa_writes', 'readonly');
      const req = tx.objectStore('pending_fsa_writes').getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });

    const results = [];
    for (let i = 0; i < pending.length; i++) {
      const month = pending[i].month;
      try {
        const r = await writeMonthFile(month);
        results.push(Object.assign({ month: month, ok: true }, r));
        await deletePendingItem(month);
      } catch (err) {
        results.push({ month: month, ok: false, error: err.message });
      }
    }
    return results;
  }

  async function deletePendingItem(month) {
    const db = await openDB();
    return new Promise(function (resolve) {
      const tx = db.transaction('pending_fsa_writes', 'readwrite');
      tx.objectStore('pending_fsa_writes').delete(month);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  global.BossFsaBackup = {
    getStatus: getStatus,
    pickDir: pickDir,
    requestPermission: requestPermission,
    consumePending: consumePending,
    writeMonthFile: writeMonthFile,
    clearDirHandle: clearDirHandle
  };
})(self);
