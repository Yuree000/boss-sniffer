// BOSS Sniffer · lib/db.js (v1.0.5)
// IndexedDB schema 单一来源 + openDB + 通用导出 bundle
//
// 提取自 background.js Sprint C 阶段 1(v1.0.4 → v1.0.5)。
// 见 相关文档/specs/2026-05-21-background拆分-design.md §1
//
// 公开 API(挂在 self.BossDB):
//   DB_NAME                    string  数据库名
//   DB_VERSION                 number  当前 schema 版本
//   STORE_CAPTURES             string  抓包表
//   STORE_EVALUATIONS          string  评估结果表
//   STORE_EVENTS               string  漏斗事件流表
//   STORE_SAYHI_POOL           string  沟通页候选人池表
//   STORE_DISMISSED_CANDIDATES string  v8 起 store 已删,常量保留供 onupgradeneeded 升级用
//   STORE_DIAG_LOGS            string  诊断日志环形 buffer 表
//   openDB()                   Promise<IDBDatabase>     打开数据库,含 onupgradeneeded
//   buildIdbBackupBundle()     Promise<object>          读所有 store → 备份 JSON
//
// 兼容暴露(给 events.js / diag-log.js / 其它老调用方):
//   self.BOSS_OPEN_DB / BOSS_STORE_EVENTS / BOSS_STORE_EVALUATIONS / BOSS_STORE_DIAG_LOGS

(function (global) {
  'use strict';

  const DB_NAME = 'boss-sniffer-db';
  const DB_VERSION = 8;  // v8 (v0.24.4): 删 dismissed_candidates store
  const STORE_CAPTURES = 'captures';
  const STORE_EVALUATIONS = 'evaluations';
  const STORE_EVENTS = 'events';
  const STORE_SAYHI_POOL = 'sayhi_pool';            // v0.13.0:沟通页候选人池
  const STORE_DISMISSED_CANDIDATES = 'dismissed_candidates';  // v0.22.5 创建 / v0.24.4 删 / 常量保留供升级用
  const STORE_DIAG_LOGS = 'diag_logs';              // observability v1:诊断日志环形 buffer

  // ===== schema:onupgradeneeded =====
  // 守卫式创建 store(if !contains),新装用户从空 DB 升到 v8,
  // 老用户每次 schema 升级时只补差量
  function applySchema(db) {
    if (!db.objectStoreNames.contains(STORE_CAPTURES)) {
      const store = db.createObjectStore(STORE_CAPTURES, {
        keyPath: 'id',
        autoIncrement: true
      });
      store.createIndex('apiPath', 'apiPath', { unique: false });
      store.createIndex('capturedAt', 'capturedAt', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_EVALUATIONS)) {
      const evStore = db.createObjectStore(STORE_EVALUATIONS, {
        keyPath: 'candidateId'
      });
      evStore.createIndex('judgedAt', 'evaluation.judgedAt', { unique: false });
      evStore.createIndex('score', 'evaluation.score', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_EVENTS)) {
      const evtStore = db.createObjectStore(STORE_EVENTS, {
        keyPath: 'id',
        autoIncrement: true
      });
      evtStore.createIndex('ts', 'ts', { unique: false });
      evtStore.createIndex('stage', 'stage', { unique: false });
      evtStore.createIndex('candidateId', 'candidateId', { unique: false });
      evtStore.createIndex('scenarioTs', ['scenario', 'ts'], { unique: false });
    }
    // v4 (v0.13.0):沟通页候选人池
    if (!db.objectStoreNames.contains(STORE_SAYHI_POOL)) {
      const poolStore = db.createObjectStore(STORE_SAYHI_POOL, {
        keyPath: 'candidateId'
      });
      poolStore.createIndex('capturedAt', 'capturedAt', { unique: false });
    }
    // v5 (v0.17.0):FSA 备份相关 store 已在 v1.0.3 移除(设计搁浅 + 真灾备走 admin「📦 导出 IDB 备份 JSON」)
    // 老用户 IDB 中 fsa_state / pending_fsa_writes 表保留不读不写,等下次 schema 升级再 deleteObjectStore
    // v6 (observability v1):诊断日志环形 buffer
    if (!db.objectStoreNames.contains(STORE_DIAG_LOGS)) {
      const dlStore = db.createObjectStore(STORE_DIAG_LOGS, {
        keyPath: 'id',
        autoIncrement: true
      });
      dlStore.createIndex('ts', 'ts', { unique: false });
    }
    // v8 (v0.24.4):删 dismissed_candidates store(30s 撤销窗口设计回退)
    //   v7 时创建过此 store;v8 升级时如存在则删除,回收空间
    //   未来如果重新启用撤销窗口,需要升 v9 并重建 store
    if (db.objectStoreNames.contains(STORE_DISMISSED_CANDIDATES)) {
      db.deleteObjectStore(STORE_DISMISSED_CANDIDATES);
    }
  }

  // ===== 打开数据库 =====
  /**
   * 打开扩展的 IndexedDB(boss-sniffer-db),onupgradeneeded 自动跑 schema 升级
   * 全 lib 唯一打开 IDB 的入口,events.js/diag-log.js 通过 BOSS_OPEN_DB 兼容引用
   *
   * 返回: Promise<IDBDatabase>
   */
  function openDB() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        applySchema(e.target.result);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // ===== 通用全 store 导出 bundle =====
  // 设计:纯读快照,不修改 IDB;输出大对象由 admin 端 Blob 下载(与 diag bundle 同模式)
  // 字段:exportedAt / extensionVersion / dbName / dbVersion / stores / counts
  async function buildIdbBackupBundle() {
    const STORES_TO_BACKUP = [
      STORE_CAPTURES,
      STORE_EVALUATIONS,
      STORE_EVENTS,
      STORE_SAYHI_POOL,
      STORE_DIAG_LOGS
      // v0.24.4:dismissed_candidates store v8 起已删(30s 撤销窗口设计回退)
      // v1.0.3:fsa_state / pending_fsa_writes 入队链路已移除,不再纳入导出
    ];
    const db = await openDB();
    const stores = {};
    await Promise.all(STORES_TO_BACKUP.map(function (name) {
      return new Promise(function (resolve) {
        try {
          if (!db.objectStoreNames.contains(name)) {
            stores[name] = [];
            resolve();
            return;
          }
          const tx = db.transaction(name, 'readonly');
          const req = tx.objectStore(name).getAll();
          req.onsuccess = function () { stores[name] = req.result || []; resolve(); };
          req.onerror = function () { stores[name] = []; resolve(); };
        } catch (e) {
          // store 不存在或 tx 失败 → 写空数组,不阻断备份
          stores[name] = [];
          resolve();
        }
      });
    }));
    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      stores: stores,
      counts: Object.keys(stores).reduce(function (acc, k) { acc[k] = stores[k].length; return acc; }, {})
    };
  }

  // ===== 主暴露 =====
  global.BossDB = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_CAPTURES: STORE_CAPTURES,
    STORE_EVALUATIONS: STORE_EVALUATIONS,
    STORE_EVENTS: STORE_EVENTS,
    STORE_SAYHI_POOL: STORE_SAYHI_POOL,
    STORE_DISMISSED_CANDIDATES: STORE_DISMISSED_CANDIDATES,
    STORE_DIAG_LOGS: STORE_DIAG_LOGS,
    openDB: openDB,
    buildIdbBackupBundle: buildIdbBackupBundle
  };

  // ===== 兼容暴露(给 events.js / diag-log.js 用,签名稳定不变)=====
  global.BOSS_OPEN_DB = openDB;
  global.BOSS_STORE_EVENTS = STORE_EVENTS;
  global.BOSS_STORE_EVALUATIONS = STORE_EVALUATIONS;
  global.BOSS_STORE_DIAG_LOGS = STORE_DIAG_LOGS;
})(self);
