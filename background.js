// BOSS Sniffer - background.js
// service worker：
//   1. 用 IndexedDB 暂存所有原始捕获数据（captures store）
//   2. 候选人接口 → 抽取 → LLM 评估（Claude）→ evaluations store
//   3. 评估"符合"的候选人入 sayHi 队列 → chrome.debugger 模拟点击"打招呼"
//   4. 提供配置读写、评估查询/导出/清空、LLM 连接测试
// v0.4.0：mock-judge → 真 LLM 评估（judge.js + llm-client.js）
// v0.6.0：加 sayHi 自动打招呼链路

// v0.15.5：city-codes 必须在 extractor 之前加载（extractor.lookupRegionCode 间接依赖）
// v0.17.0：captures-cleaner 负责 captures 7 天 TTL；storage-sync 必须在 jd-templates 之前加载
// v0.21.0 · Phase 1·1c：jd-router 不依赖其他 lib，位置不敏感，放在 jd-templates 之后保持语义近邻
importScripts('lib/city-codes.js', 'lib/extractor.js', 'lib/llm-client.js', 'lib/judge.js', 'lib/sayHi.js', 'lib/events.js', 'lib/storage-sync.js', 'lib/jd-templates.js', 'lib/jd-router.js', 'lib/greet-templates.js', 'lib/prompt-builder.js', 'lib/scheduler.js', 'lib/captures-cleaner.js', 'lib/diag-log.js');

const DB_NAME = 'boss-sniffer-db';
const DB_VERSION = 8;  // v8 (v0.24.4): 删 dismissed_candidates store（30s 撤销窗口设计回退，pass 立即点不合适）
const STORE_CAPTURES = 'captures';
const STORE_EVALUATIONS = 'evaluations';
const STORE_EVENTS = 'events';
const STORE_SAYHI_POOL = 'sayhi_pool';  // v0.13.0：沟通页 DOM 扫描的候选人池（独立于推荐页 evaluations）
const STORE_DISMISSED_CANDIDATES = 'dismissed_candidates';  // v0.22.5 · Phase 3·3c 创建；v0.24.4 已删除（保留常量供 onupgradeneeded 升级用）
const STORE_FSA_STATE = 'fsa_state';
const STORE_PENDING_FSA_WRITES = 'pending_fsa_writes';
const STORE_DIAG_LOGS = 'diag_logs';    // observability v1：诊断日志环形 buffer

// v0.13.0 沟通页 TTL
const SAYHI_POOL_TTL_MS = 24 * 60 * 60 * 1000;       // 池子保留 24h
const SAYHI_EVAL_STALE_MS = 30 * 60 * 1000;          // 评估超过 30 分钟视为陈旧，重评时重跑
// events store 字段约定（S1a 仅建表，埋点见 S1c-e）：
//   id          autoIncrement 主键
//   ts          number    事件时间戳（indexed）
//   stage       string    漏斗阶段：candidate_pool | pass_marked | match_marked
//                                    | sayhi_sent | engaged | resume_received（indexed）
//   candidateId string    候选人 ID，trace_id 用（indexed）
//   scenario    string    'recommend' | 'chat'
//   jobId       string    HR 当前选中的 JD ID（按岗位切片用）
//   toolState   string    'on' | ''（业务逻辑 §2.7 留接口，v1 不实采）
//   payload     object    灵活字段：passReason / decision / 失败原因等

// 内存中的运行态
// v0.15.0：screeningEnabled 退化为内部派生状态，与 LOOP 生命周期绑死
// （START_LOOP → true / STOP_LOOP / 自然终止 → false）。控制 HTTP 类 capture 是否入库
// （WS 类沟通页 capture 绕开）。不持久化，SW 重启 → 默认 false。
let screeningEnabled = false;
// v0.16.0：当前本轮 LOOP 跑的 tab（'recommend' / 'latest'）。跟 LOOP 生命周期绑死。
// 用于 CAPTURE 闸按接口路径过滤，避免推荐/最新两个 tab 的接口残余互相污染评估。
let currentTab = null;
let inMemoryStats = { total: 0, byPath: {} };
let lastBossTabId = null;  // sayHi 时模拟点击需要 tabId（每次 capture 时刷新）

function getLoopStatus() {
  if (!self.BossScheduler || typeof self.BossScheduler.getState !== 'function') return 'IDLE';
  const state = self.BossScheduler.getState() || {};
  return state.status || 'IDLE';
}

function isAutomationActive() {
  const status = getLoopStatus();
  return status === 'RUNNING' || status === 'RESTING';
}

async function countSayHiSentSince(since) {
  if (!self.BossEvents || !since) return 0;
  const events = await self.BossEvents.getRecentEvents(1000);
  const sinceTs = Number(since) || 0;
  return events.filter(function (e) {
    return e.stage === 'sayhi_sent' && e.ts >= sinceTs;
  }).length;
}

async function getRemainingSayHiSlots() {
  if (!self.BossScheduler || typeof self.BossScheduler.getState !== 'function') return Infinity;
  const state = self.BossScheduler.getState() || {};
  if (!(typeof state.goalN === 'number' && state.goalN > 0)) return Infinity;
  const sent = await countSayHiSentSince(state.loopStartedAt);
  const status = self.BossSayHi && typeof self.BossSayHi.getStatus === 'function'
    ? self.BossSayHi.getStatus()
    : { queueLength: 0 };
  const queued = Number(status.queueLength || 0);
  return Math.max(0, state.goalN - sent - queued);
}

// ===== 给 sayHi.js 用的 getters =====
self.BOSS_SAYHI_CONFIG_GETTER = function () { return appConfig.sayHi; };
self.BOSS_LAST_TAB_GETTER = function () { return lastBossTabId; };
self.BOSS_EVAL_GREETING_PATCHER = async function (candidateId, greeting) {
  // 在 evaluations store 上 patch greeting 字段（不动 evaluation 本体）
  const db = await openDB();
  await new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const req = store.get(candidateId);
    req.onsuccess = function () {
      const r = req.result;
      if (!r) { resolve(); return; }
      r.greeting = greeting;
      store.put(r);
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  // L2 漏斗埋点：sayhi_sent / sayhi_failed（独立 try/catch，不影响 evaluations patch 结果）
  await logSayHiOutcomeEvent(candidateId, greeting);
};

// 配置（从 chrome.storage.sync 加载；v0.17.0 起跨设备同步）
let appConfig = {
  llm: {
    currentId: 'default-anthropic',
    configs: [{
      id: 'default-anthropic',
      name: 'Anthropic · Claude',
      providerName: 'Anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      authType: 'x-api-key',
      apiKey: '',
      model: 'claude-opus-4-7',
      concurrency: 5
    }]
  },
  jd: { activeJdId: 'qa-engineer-2026' },
  sayHi: {
    enabled: false,
    delayMin: 1500,
    delayMax: 5000,
    restAfter: 30,
    restMinutes: [5, 10]
  },
  // v0.17.0.10 POC A7 阶段 b：沟通页 DOM 详情面板扫描配置
  // 默认值按"一个人上测、跑通再拓展"基调设保守值，HR 可在 admin 调
  sayHiDom: {
    scanMaxPerRun: 1,        // 单批 DOM 扫描上限（默认 1 = 轮 1 安全；轮 2-3 可调 5、15）
    cooldownMinMs: 5000,     // 候选人间冷却下限（拟人节奏，HR 看简历通常 5-10s）
    cooldownMaxMs: 8000,     // 上限
    proactiveFetchEnabled: false  // v0.13.3 主动 fetch chat/geek/info 是否启用
                                  // 默认 false：DOM 扫描点击会让 BOSS 自调 chat/geek/info（HR 真实行为），
                                  // 不需要额外主动 fetch；开启后会双倍流量，风控嫌疑更大
  },
  // v0.17.1.0/.3：评估「符合」→ 自动输入话术 + 求简历
  // 默认全关。HR 在 admin 显式打开后才生效；试跑模式作为安全网，跑通才能正式启用。
  // v0.17.1.3：产品边界澄清——「单评 = HR 看个体看仔细，永不自动」；「批量 = 自动入口」
  //   旧版 key（单评启用）直接忽略（语义已变，不迁移），HR 重新去 admin 勾选 enabledBatchEval
  autoAction: {
    enabledBatchEval: false,     // 批量评估启用 自动「话术+求简历」（单评永不自动求简历，HR 评后手动点 🎯）
                                 // 别名语义：等同于 "autoGreet"。v0.22.2 · Phase 2·2c 起 sidepanel 也能控制此 flag。
    autoMarkUnsuitable: false,   // v0.22.2 · Phase 2·2c 新增：批量评估「pass」时自动点不合适。
                                 // ⚠ Phase 2 阶段仅存配置，evalSayhiCore 不读取（防止 P3 撤销窗口落地前触发不可逆操作）。
                                 // Phase 3·3c 加 30s 撤销窗口后才接入实际执行。
    dryRun: false,               // 试跑模式：执行链路走完所有定位 + log，但不点最后的发送/确定
    actionCooldownMinMs: 2000,   // 自动操作模式专属冷却下限（chain 自身已耗 13-25s，不叠加 5-8s 否则太慢）
    actionCooldownMaxMs: 4000    // 上限
  },
  // v0.22.3 · Phase 2·2d：沟通页批次阈值（spec §3.2.3）
  //   K（maxBrowseK）= 本批最多评估几人，截断 todo（null = 留空 = 全部未读）
  // v0.25.0：删招呼数 cap 字段（概念彻底废弃）
  sayhiBatch: {
    maxBrowseK: null
  }
};

function getCurrentLlmConfig() {
  if (!self.BossLLM || typeof self.BossLLM.getCurrentLlmConfig !== 'function') return null;
  return self.BossLLM.getCurrentLlmConfig(appConfig.llm);
}

function isCurrentLlmConfigured() {
  const cfg = getCurrentLlmConfig();
  return !!(cfg && cfg.apiKey && cfg.model);
}

function sanitizeLlmForLog(llm) {
  if (!llm || typeof llm !== 'object') return llm;
  const copy = Object.assign({}, llm);
  if (copy.apiKey) copy.apiKey = '***(已覆盖)';
  if (Array.isArray(copy.configs)) {
    copy.configs = copy.configs.map(function (cfg) {
      const safe = Object.assign({}, cfg);
      if (safe.apiKey) safe.apiKey = '***(已覆盖)';
      return safe;
    });
  }
  return copy;
}

// ===== IndexedDB 工具 =====
function openDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
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
      // v4 (v0.13.0)：沟通页候选人池
      if (!db.objectStoreNames.contains(STORE_SAYHI_POOL)) {
        const poolStore = db.createObjectStore(STORE_SAYHI_POOL, {
          keyPath: 'candidateId'
        });
        poolStore.createIndex('capturedAt', 'capturedAt', { unique: false });
      }
      // v5 (v0.17.0)：FSA 备份状态 + 待写月份队列
      if (!db.objectStoreNames.contains('fsa_state')) {
        db.createObjectStore('fsa_state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('pending_fsa_writes')) {
        const s = db.createObjectStore('pending_fsa_writes', { keyPath: 'month' });
        s.createIndex('enqueuedAt', 'enqueuedAt', { unique: false });
      }
      // v6 (observability v1)：诊断日志环形 buffer
      if (!db.objectStoreNames.contains(STORE_DIAG_LOGS)) {
        const dlStore = db.createObjectStore(STORE_DIAG_LOGS, {
          keyPath: 'id',
          autoIncrement: true
        });
        dlStore.createIndex('ts', 'ts', { unique: false });
      }
      // v8 (v0.24.4)：删 dismissed_candidates store（30s 撤销窗口设计回退）
      //   v7 时创建过此 store；v8 升级时如存在则删除，回收空间
      //   未来如果重新启用撤销窗口，需要升 v9 并重建 store
      if (db.objectStoreNames.contains(STORE_DISMISSED_CANDIDATES)) {
        db.deleteObjectStore(STORE_DISMISSED_CANDIDATES);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

// 暴露给 lib/events.js 等模块复用，schema 创建逻辑保持单一来源
self.BOSS_OPEN_DB = openDB;
self.BOSS_STORE_EVENTS = STORE_EVENTS;
self.BOSS_STORE_EVALUATIONS = STORE_EVALUATIONS;
self.BOSS_STORE_DIAG_LOGS = STORE_DIAG_LOGS;

// v0.17.0：FSA 备份按月分片，sidepanel 消费
// 这里只入队 month 标记，sidepanel 上下文里有 user gesture 才能 FSA 写入
async function enqueuePendingFsaWrite(month) {
  const db = await openDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_PENDING_FSA_WRITES, 'readwrite');
    const store = tx.objectStore(STORE_PENDING_FSA_WRITES);
    // keyPath: month，put 自动去重
    store.put({ month: month, enqueuedAt: Date.now() });
    tx.oncomplete = function () {
      // broadcast 给 sidepanel；侧栏没开时 sendMessage 会报错，忽略
      chrome.runtime.sendMessage({ type: 'PENDING_FSA_WRITE', month: month }, function () {
        if (chrome.runtime.lastError) {/* 侧栏没开，正常 */}
      });
      resolve();
    };
    tx.onerror = function () { reject(tx.error); };
  });
}

function tsToMonth(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// 暴露给 events.js 等模块用
self.BOSS_ENQUEUE_FSA_WRITE = enqueuePendingFsaWrite;
self.BOSS_TS_TO_MONTH = tsToMonth;

function urlToPath(url) {
  try {
    const u = new URL(url, 'https://www.zhipin.com');
    return u.pathname;
  } catch (e) {
    return String(url || '(unknown)');
  }
}

async function saveCapture(payload, tabId) {
  if (tabId) lastBossTabId = tabId;  // 缓存最近的 BOSS tab

  // v0.12.10：识别 via 字段区分 fetch / xhr / ws
  // - fetch/xhr：走现有 URL 路径解析 + 评估流水线
  // - ws：业务 WS 消息（沟通页新招呼，Step A 仅落库），不进评估流水线，不污染推荐页 stats
  const isWs = payload.via === 'ws';
  const apiPath = isWs ? ('ws:' + (payload.url || '')) : urlToPath(payload.url);

  // dev-mode 已彻底移除（S3.5）；请求体/请求头一律不入库
  let trimmed = payload;
  if (payload.requestBody !== undefined || payload.requestHeaders !== undefined) {
    trimmed = Object.assign({}, payload);
    delete trimmed.requestBody;
    delete trimmed.requestHeaders;
  }
  const record = Object.assign({}, trimmed, {
    apiPath: apiPath,
    kind: isWs ? 'ws' : (payload.via || 'fetch')  // 显式标记类型，便于 v0.13.x ws-parser 检索
  });
  const db = await openDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_CAPTURES, 'readwrite');
    tx.objectStore(STORE_CAPTURES).add(record);
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });

  // WS 类隔离：不计入 HTTP 统计、不进评估流水线
  if (!isWs) {
    inMemoryStats.total += 1;
    inMemoryStats.byPath[apiPath] = (inMemoryStats.byPath[apiPath] || 0) + 1;
    evaluateIfCandidate(apiPath, payload).catch(function (err) {
      console.error('[BOSS-Sniffer] evaluate failed:', err);
    });
  }
}

// ===== 评估流水线 =====
//
// 两阶段写入：
// 阶段 1 — 抽取出候选人立即写"pending"状态，sidepanel 能马上看到 "评估中"
// 阶段 2 — 限并发调 LLM，返回后逐个 update（成功写 evaluation，失败写 status: 'failed'）
//
// 设计取舍：
// - 不阻塞 capture 落盘（已经异步了）
// - 限并发 5：避免 15 个请求同时打代理网关导致超时；同时让 prompt cache
//   有机会被前几个请求"暖起来"（首发写缓存，后续命中只收 10% 输入价格）
// - judge.js 内部带重试，所以这里 worker 不再额外兜底
// - 没有 LLM 配置时直接写 failed 状态，不卡链路
const DEFAULT_LLM_CONCURRENCY = 5;  // 用户未配置或非法时的兜底值

// 简易 worker 池：N 个 worker 共享 cursor 轮询消费 items
// fn 自己处理错误（不会让 Promise.all reject）
async function runWithConcurrency(items, concurrency, fn) {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < limit; i++) workers.push(worker());
  await Promise.all(workers);
}

// v0.17.0.10 → v0.17.1.0：原 createLlmSemaphore（LLM 评估并发 pipeline）已删
// 理由：v0.17.1.0 评估「符合」自动求简历必须 per-候选人 串行（操作目标候选人需要面板 active），
//      pipeline 异步会"操作错人"。评估循环已改为单线 await 跑 LLM，semaphore 不再需要。

// 漏斗 §3 场景实例化：从 apiPath 推断 scenario（4 值物理 scenario）
// - rec/geek/list                         → 'recommend'  推荐 tab
// - zprelation/interaction/bossGetGeek    → 'latest'     最新 tab（v0.20.7 单独识别）
// - chat/geek/info / 其他 /zprelation/*   → 'chat'       沟通页
// v0.20.7：4 值物理 scenario（跟 lib/extractor.js 对齐）
// 看板做业务归一化（recordScenario 内），把 'recommend' + 'latest' 合并到推荐流 tab
// 之前 'latest' 被错归到 'chat'，导致 HR 跑「最新候选人」tab 时看板推荐 tab 0 数据
function deriveScenario(apiPath) {
  if (!apiPath) return 'recommend';
  if (apiPath.indexOf('/rec/') !== -1) return 'recommend';
  if (apiPath.indexOf('/zprelation/interaction/bossGetGeek') !== -1) return 'latest';
  if (apiPath.indexOf('/chat/') !== -1 || apiPath.indexOf('/zprelation/') !== -1) return 'chat';
  return 'recommend';  // 兜底：未知路径默认 recommend，不污染漏斗
}

// 漏斗 L2 招呼发出埋点
// 由 BOSS_EVAL_GREETING_PATCHER 调用（sayHi.js 所有结果路径都经过该 hook）
// scenario / jobId 反查 events 表的 candidate_pool 记录继承
async function logSayHiOutcomeEvent(candidateId, greeting) {
  if (!self.BossEvents || !candidateId || !greeting) return;
  const status = greeting.status;
  if (status !== 'sent' && status !== 'failed') return;  // 未知状态不埋

  try {
    // 反查 candidate_pool 拿 scenario / jobId（S1c 已确保 candidate_pool 在前）
    const events = await self.BossEvents.getEventsByCandidate(candidateId);
    const poolEvt = events.find(function (e) { return e.stage === 'candidate_pool'; });
    const scenario = (poolEvt && poolEvt.scenario) || 'recommend';
    const jobId = (poolEvt && poolEvt.jobId) || '';

    if (status === 'sent') {
      await self.BossEvents.logEvent({
        stage: 'sayhi_sent',
        candidateId: candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: {
          sentAt: greeting.sentAt || Date.now(),
          buttonText: greeting.buttonText || ''
        }
      });
    } else {
      await self.BossEvents.logEvent({
        stage: 'sayhi_failed',
        candidateId: candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: {
          failedAt: greeting.failedAt || Date.now(),
          error: greeting.error || ''
        }
      });
    }
  } catch (err) {
    if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.outcome', 'sayhi outcome 埋点失败', { candidateId: candidateId, error: err && err.message });
    else console.warn('[BOSS-Sniffer] sayhi outcome 埋点失败 candidateId=' + candidateId + ':', err && err.message);
  }
}

// 漏斗 Pass 终止分支 + match_marked 埋点（业务逻辑 §3 二态决策）
// - decision === 'pass'    → pass_marked，passReason 优先取 LLM 自报，否则 derivePassReason 兜底
// - decision === '符合'    → match_marked
// - status === 'failed'    → pass_marked，主因 '信息不足'（业务逻辑 §11.1 异常分支 A）
//
// S3.6 删除"不确定"决策——LLM 任何不确定的 case 都归 pass，主因走"信息不足"。
// 失败 catch 后只 warn，不影响主链路（评估 + sayHi）。
async function logFunnelOutcomeEvent(candidate, evaluation, apiPath) {
  if (!self.BossEvents || !candidate || !candidate.candidateId || !evaluation) return;
  const scenario = deriveScenario(apiPath);
  const jobId = (appConfig.jd && appConfig.jd.activeJdId) || '';

  try {
    if (evaluation.status === 'failed') {
      await self.BossEvents.logEvent({
        stage: 'pass_marked',
        candidateId: candidate.candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: {
          passReason: '信息不足',
          llmReason: '评估失败: ' + (evaluation.error || ''),
          failedAt: evaluation.judgedAt || Date.now()
        }
      });
      return;
    }

    if (evaluation.decision === 'pass') {
      const passReason = (evaluation.passReason && typeof evaluation.passReason === 'string')
        ? evaluation.passReason  // LLM 自报（v1 prompt 暂未输出，留接口）
        : self.BossEvents.derivePassReason(
            evaluation.mustBreakdown,
            evaluation.optionalBreakdown,
            evaluation.jdSnapshot
          );
      await self.BossEvents.logEvent({
        stage: 'pass_marked',
        candidateId: candidate.candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: {
          passReason: passReason,
          llmReason: evaluation.reason || '',
          llmMustBreakdown: evaluation.mustBreakdown || null,
          llmOptionalBreakdown: evaluation.optionalBreakdown || null
        }
      });
    } else if (evaluation.decision === '符合') {
      await self.BossEvents.logEvent({
        stage: 'match_marked',
        candidateId: candidate.candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: { llmReason: evaluation.reason || '' }
      });
    }
    // 其他非法决策走 catch（被 judge.js validateOutput 拦下）
  } catch (err) {
    if (self.BossDiag) self.BossDiag.log('warn', 'funnel.outcome', 'funnel outcome 埋点失败', { candidateId: candidate.candidateId, error: err && err.message });
    else console.warn('[BOSS-Sniffer] funnel outcome 埋点失败 candidate=' + candidate.candidateId + ':', err && err.message);
  }
}

// L1 漏斗埋点：候选人入池
// 按 candidateId 去重（漏斗 §1.1 "同候选人多入口只计 1 次"）
// 失败 catch 后只 warn，不影响主链路评估
async function logCandidatePoolEvents(candidates, apiPath) {
  if (!self.BossEvents || !candidates || !candidates.length) return;
  const scenario = deriveScenario(apiPath);
  const jobId = (appConfig.jd && appConfig.jd.activeJdId) || '';
  const batchAt = Date.now();
  for (const c of candidates) {
    if (!c || !c.candidateId) continue;
    try {
      const existing = await self.BossEvents.getEventsByCandidate(c.candidateId);
      const alreadyInPool = existing.some(function (e) { return e.stage === 'candidate_pool'; });
      if (alreadyInPool) continue;
      await self.BossEvents.logEvent({
        stage: 'candidate_pool',
        candidateId: c.candidateId,
        scenario: scenario,
        jobId: jobId,
        payload: { apiPath: apiPath, batchAt: batchAt }
      });
    } catch (err) {
      if (self.BossDiag) self.BossDiag.log('warn', 'funnel.pool', 'candidate_pool 埋点失败', { candidateId: c.candidateId, error: err && err.message });
      else console.warn('[BOSS-Sniffer] candidate_pool 埋点失败 candidate=' + c.candidateId + ':', err && err.message);
    }
  }
}

// v0.12.0：从 BossJD 取当前模板；找不到则 fallback 到 SEED_QA_ENGINEER
// 同步并把 jobId 写回 appConfig.jd.activeJdId，让 funnel 埋点的 jobId 跟随
async function getCurrentJdTemplate() {
  if (!self.BossJD) {
    console.error('[BOSS-Sniffer] BossJD 未加载，无 JD 可用');
    return null;
  }
  try {
    await self.BossJD.ensureSeeded();  // 幂等：首启 / 旧 schema 写入双 SEED
    const curId = await self.BossJD.getCurrentJdId();
    let tpl = curId ? await self.BossJD.getTemplate(curId) : null;
    if (!tpl) {
      // 取 list 第一条作为 fallback；都没有则直接用 SEED 常量
      const list = await self.BossJD.listTemplates();
      tpl = (list && list[0]) || self.BossJD.SEED_QA_ENGINEER;
      console.warn('[BOSS-Sniffer] 未选中 JD 或当前 JD 已删，fallback 到：' + (tpl && tpl.name));
    }
    // 同步 funnel 埋点用的 jobId
    if (tpl && tpl.jdId) appConfig.jd.activeJdId = tpl.jdId;
    return tpl;
  } catch (e) {
    console.error('[BOSS-Sniffer] 取当前 JD 失败：', e);
    return self.BossJD.SEED_QA_ENGINEER;
  }
}

// v0.17.1.0：取当前话术模板（评估「符合」→ 自动求简历时拿话术正文）
// v0.25.2 重构：话术从独立模板 → JD 内嵌（greetTemplates 数组 + defaultGreetTemplateId）
//   新签名 getJdDefaultGreetTemplate(jd) — 接收 JD 对象，返回它的默认话术
//   JD 没配话术 / 默认话术 ID 无效 → 返回 null（autoGreet 走 no-greet-template 跳过）
function getJdDefaultGreetTemplate(jd) {
  if (!jd || !Array.isArray(jd.greetTemplates) || !jd.greetTemplates.length) {
    return null;
  }
  // 优先用 defaultGreetTemplateId 指定的话术
  if (jd.defaultGreetTemplateId) {
    const defaultTpl = jd.greetTemplates.find(function (g) {
      return g && g.id === jd.defaultGreetTemplateId;
    });
    if (defaultTpl && defaultTpl.text) return defaultTpl;
  }
  // fallback：取第一个有效话术
  for (let i = 0; i < jd.greetTemplates.length; i++) {
    const g = jd.greetTemplates[i];
    if (g && g.text) return g;
  }
  return null;
}

// v0.17.1.0 → v0.25.2 deprecated：getCurrentGreetTemplate 仍保留兼容（手动点 🎯 路径用）
// 后续可能彻底删（手动按钮已 v0.25.1 隐藏）。当前仍有 sendMessage handler / 手动路径残留调用。
async function getCurrentGreetTemplate() {
  if (!self.BossGreetTemplates) return null;
  try {
    await self.BossGreetTemplates.ensureSeeded();
    const curId = await self.BossGreetTemplates.getCurrentGreetId();
    let tpl = curId ? await self.BossGreetTemplates.getTemplate(curId) : null;
    if (!tpl) {
      const list = await self.BossGreetTemplates.listTemplates();
      tpl = (list && list[0]) || self.BossGreetTemplates.SEED_GENERIC;
    }
    return tpl;
  } catch (e) {
    return self.BossGreetTemplates && self.BossGreetTemplates.SEED_GENERIC;
  }
}

async function evaluateIfCandidate(apiPath, payload) {
  if (!self.BossExtractor || !self.BossJudge) return;
  if (configReady) await configReady; // SW 重启后等首次配置加载完

  // v0.15.1：historyMsg 不走候选人评估流，单独合并 chatHistory 到已知 candidate
  // 业务文档 5.7 §11.5 "信息源优先级 chat > 简历 > bossSignals" 之前一直未生效——
  // prompt-builder + judge.js 早就预留了 chatHistory 字段消费，但 extractor 从来没填过
  if (apiPath.indexOf('/zpchat/boss/historyMsg') !== -1) {
    await mergeChatHistoryFromHistoryMsg(payload).catch(function (err) {
      console.warn('[BOSS-Sniffer chatHistory] merge failed:', err && err.message);
    });
    return;
  }

  const candidates = self.BossExtractor.extractFromCapture(apiPath, payload.data);
  if (!candidates || !candidates.length) return;

  // v0.13.3：chat/geek/info 响应里的 uid 若已在沟通页池子，合并字段不进推荐页评估流。
  // 触发场景：① 沟通页"一键评估"主动 fetch 补字段；② HR 在 BOSS 沟通页点开候选人 BOSS 自调
  // 两条路径都自动让 sayhi_pool 字段更完整。
  if (apiPath.indexOf('/chat/geek/info') !== -1) {
    const sayhiSide = [];
    const otherSide = [];
    for (let i = 0; i < candidates.length; i++) {
      const inPool = await isInSayhiPool(candidates[i].candidateId);
      (inPool ? sayhiSide : otherSide).push(candidates[i]);
    }
    if (sayhiSide.length) {
      const n = await mergeCandidatesIntoSayhiPool(sayhiSide);
      console.info('[BOSS-Sniffer sayhi] 合并 ' + n + ' 人完整字段到沟通页池子');
    }
    if (!otherSide.length) return;
    // 替换 candidates 为不在 sayhi 池子的部分，继续走推荐页评估流
    candidates.length = 0;
    for (let i = 0; i < otherSide.length; i++) candidates.push(otherSide[i]);
  }

  // L1 漏斗埋点：候选人入池（在 LLM 评估前，确保即使评估失败也埋上）
  await logCandidatePoolEvents(candidates, apiPath);

  // v0.20.9：阶段 1 写 queued（待评估）占位 — 此刻进 LLM 队列等待，并非真正开始 fetch
  // 阶段 2 worker 真正调 LLM 前再 upsert 一次 status='pending'（评估中）+ startedAt=now
  // 让 HR 在 sidepanel 看到 queued（灰）/ pending（蓝）/ done|failed（结果）三态视觉
  await upsertEvaluations(candidates.map(function (c) {
    return {
      candidateId: c.candidateId,
      candidate: c,
      evaluation: { status: 'queued', queuedAt: Date.now() },
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    };
  }));

  // 阶段 2：限并发调 LLM（并发数从配置读，admin 可调）
  const llmCfg = getCurrentLlmConfig();
  const jd = await getCurrentJdTemplate();
  const concurrency = (llmCfg && llmCfg.concurrency > 0)
    ? llmCfg.concurrency
    : DEFAULT_LLM_CONCURRENCY;

  if (self.BossDiag) {
    self.BossDiag.log('info', 'evaluate.batch', '评估批次启动', {
      apiPath: apiPath,
      candidates: candidates.length,
      jd: jd && jd.name,
      jdId: jd && jd.jdId,
      concurrency: concurrency,
      model: llmCfg && llmCfg.model,
      provider: llmCfg && (llmCfg.providerName || llmCfg.protocol)
    });
  }

  await runWithConcurrency(candidates, concurrency, async function (c) {
    // v0.20.9：进入 worker = 离开并发 queue 占到执行槽。立刻 upsert pending（评估中）+ startedAt=now
    // 让 HR 看到「这个真的在跑」，计时也从这一刻起算（之前是占位时刻，计时虚高）
    await upsertEvaluation({
      candidateId: c.candidateId,
      candidate: c,
      evaluation: { status: 'pending', startedAt: Date.now() },
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    });
    let evaluation;
    try {
      const result = await self.BossJudge.judgeCandidate(c, jd, llmCfg);
      evaluation = Object.assign({ status: 'done' }, result);
    } catch (err) {
      if (self.BossDiag) {
        self.BossDiag.log('error', 'evaluate.judgeFail', 'LLM judge failed', {
          candidateId: c.candidateId,
          errName: err && err.name,
          errMsg: err && err.message,
          attempts: err && err.attempts,
          totalLatencyMs: err && err.totalLatencyMs
        });
      } else {
        console.error('[BOSS-Sniffer] LLM judge failed for', c.candidateId, err);
      }
      evaluation = {
        status: 'failed',
        error: err.name + ': ' + err.message,
        judgedAt: Date.now(),
        latencyMs: err.totalLatencyMs || null,
        attempts: err.attempts || null,
        perAttempt: Array.isArray(err.perAttempt) ? err.perAttempt : [],
        jdTitle: (jd && jd.name) || '?',
        jdId: (jd && jd.jdId) || '',
        provider: (llmCfg && (llmCfg.providerName || llmCfg.protocol)) || '',
        modelId: (llmCfg && llmCfg.model) || ''
      };
    }
    // v0.15.0：LLM 返回后再次检查本轮是否还在跑——用户在 LLM 跑的几秒里点了停止本轮 →
    // 丢弃迟到的评估结果，避免写回 evaluations store 让侧栏"刷新后又冒出候选人"
    if (!screeningEnabled) {
      if (self.BossDiag) self.BossDiag.log('info', 'evaluate.lateDiscard', '本轮已停止,丢弃迟到 LLM 评估', { candidateId: c.candidateId });
      else console.info('[BOSS-Sniffer] 本轮已停止，丢弃 ' + c.candidateId + ' 的迟到 LLM 评估结果');
      return;
    }
    // 漏斗埋点：pass_marked / match_marked / 失败转 pass_marked（主因信息不足）
    await logFunnelOutcomeEvent(c, evaluation, apiPath);

    await upsertEvaluation({
      candidateId: c.candidateId,
      candidate: c,
      evaluation: evaluation,
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    });

    // 评估"符合"且 sayHi 启用 → 入队
    await maybeEnqueueSayHi(c, evaluation);
  });
}

// 从 evaluations store 取 candidate.encryptUid（sayHi 找 DOM 时用）
async function getEncryptUid(candidateId) {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readonly');
    const req = tx.objectStore(STORE_EVALUATIONS).get(String(candidateId));
    req.onsuccess = function () {
      const r = req.result;
      resolve((r && r.candidate && r.candidate.encryptUid) || '');
    };
    req.onerror = function () { resolve(''); };
  });
}

// 决定是否把候选人推入 sayHi 队列
async function maybeEnqueueSayHi(candidate, evaluation) {
  const sh = appConfig.sayHi;
  if (!isAutomationActive()) return;
  if (!sh || !sh.enabled) return;
  if (!evaluation || evaluation.status !== 'done') return;
  if (!candidate || !candidate.candidateId) return;

  // v0.12 二态决策后 LLM 只输出「符合 / pass」，仅「符合」候选人入队 sayHi
  if (evaluation.decision !== '符合') return;

  const remainingSlots = await getRemainingSayHiSlots();
  if (remainingSlots <= 0) {
    // v0.12.6：本轮 N 已满 — 把 符合 候选人标 over_quota，让 sidepanel 显示"⊘ 已超 N"
    // 否则 HR 看到 5 个 符合 但只有 1 个有 ⌛ 待招呼 徽章，剩 4 个无任何招呼角标，会困惑
    await self.BOSS_EVAL_GREETING_PATCHER(candidate.candidateId, {
      status: 'over_quota',
      markedAt: Date.now()
    });
    return;
  }

  await self.BossSayHi.enqueue({
    candidateId: candidate.candidateId,
    encryptUid: candidate.encryptUid || '',
    tabId: lastBossTabId
  });
  await self.BOSS_EVAL_GREETING_PATCHER(candidate.candidateId, {
    status: 'queued',
    queuedAt: Date.now()
  });
}

async function upsertEvaluations(records) {
  if (!records || !records.length) return;
  const db = await openDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    records.forEach(function (r) { store.put(r); });
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });
}

async function upsertEvaluation(record) {
  await upsertEvaluations([record]);
  try {
    await enqueuePendingFsaWrite(tsToMonth(
      (record.evaluation && (record.evaluation.judgedAt || record.evaluation.startedAt)) || Date.now()
    ));
  } catch (err) {
    console.warn('[BOSS-Sniffer] enqueue FSA write failed:', err && err.message);
  }
}

// 重判：从 evaluations 取出原 candidate，重跑 LLM
async function retryEvaluation(candidateId) {
  const db = await openDB();
  const existing = await new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readonly');
    const req = tx.objectStore(STORE_EVALUATIONS).get(candidateId);
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
  });
  if (!existing || !existing.candidate) {
    return { ok: false, error: '候选人不存在' };
  }
  // 标 pending 给即时反馈
  await upsertEvaluation(Object.assign({}, existing, {
    evaluation: { status: 'pending', startedAt: Date.now() }
  }));
  // S4b：用当前选中的 JD（不是创建时的）
  // TODO v0.21.x：retry 路径未接入沟通页 JD 路由（Phase 1·1c 仅改了 evalSayhiCore）。
  // 沟通页 sayhi-tab 候选人按 retry 仍会用 currentJD，与 1c 路由不一致。
  // 待 Phase 1 整体上线后单独追加补丁：检测 existing.candidate.source.scenario === 'sayhi-tab'
  // 则调用 BossJDRouter.route 找路由命中的 JD。
  const jd = await getCurrentJdTemplate();
  const llmCfg = getCurrentLlmConfig();
  let evaluation;
  try {
    const result = await self.BossJudge.judgeCandidate(existing.candidate, jd, llmCfg);
    evaluation = Object.assign({ status: 'done' }, result);
  } catch (err) {
    evaluation = {
      status: 'failed',
      error: err.name + ': ' + err.message,
      judgedAt: Date.now(),
      latencyMs: err.totalLatencyMs || null,
      attempts: err.attempts || null,
      perAttempt: Array.isArray(err.perAttempt) ? err.perAttempt : [],
      jdTitle: (jd && jd.name) || '?',
      jdId: (jd && jd.jdId) || '',
      provider: (llmCfg && (llmCfg.providerName || llmCfg.protocol)) || '',
      modelId: (llmCfg && llmCfg.model) || ''
    };
  }
  await upsertEvaluation(Object.assign({}, existing, { evaluation: evaluation }));
  return { ok: evaluation.status === 'done', evaluation: evaluation };
}

async function getEvaluations() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readonly');
    const req = tx.objectStore(STORE_EVALUATIONS).getAll();
    req.onsuccess = function () {
      const records = req.result || [];
      // 倒序排：评估时间晚的在前；pending/failed 的用 startedAt
      records.sort(function (a, b) {
        const ax = (a.evaluation && (a.evaluation.judgedAt || a.evaluation.startedAt)) || 0;
        const bx = (b.evaluation && (b.evaluation.judgedAt || b.evaluation.startedAt)) || 0;
        return bx - ax;
      });
      resolve(records);
    };
    req.onerror = function () { resolve([]); };
  });
}

// observability v1：拼出可下载的诊断包
// - llmConfig 用 sanitizeLlmForLog 脱敏(apiKey → ***)
// - 评估按 failed 优先 + 时间倒序,只取最近 50 条避免包体过大
// - diagLogs 取最近 500 条(BossDiag 上限即 500)
async function buildDiagBundle() {
  const all = await getEvaluations();
  // failed 优先排前,然后按 judgedAt/startedAt 倒序
  const sorted = all.slice().sort(function (a, b) {
    const aFailed = a.evaluation && a.evaluation.status === 'failed' ? 1 : 0;
    const bFailed = b.evaluation && b.evaluation.status === 'failed' ? 1 : 0;
    if (aFailed !== bFailed) return bFailed - aFailed;
    const ax = (a.evaluation && (a.evaluation.judgedAt || a.evaluation.startedAt)) || 0;
    const bx = (b.evaluation && (b.evaluation.judgedAt || b.evaluation.startedAt)) || 0;
    return bx - ax;
  });
  const recentEvaluations = sorted.slice(0, 50);
  const diagLogs = self.BossDiag ? await self.BossDiag.recent(500) : [];
  const jd = await getCurrentJdTemplate().catch(function () { return null; });
  const cfg = getCurrentLlmConfig();
  return {
    exportedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    llmConfig: sanitizeLlmForLog(cfg) || null,
    currentJd: jd ? { jdId: jd.jdId, name: jd.name } : null,
    loopStatus: getLoopStatus(),
    counts: {
      totalEvaluations: all.length,
      failedEvaluations: all.filter(function (r) { return r.evaluation && r.evaluation.status === 'failed'; }).length,
      pendingEvaluations: all.filter(function (r) { return r.evaluation && r.evaluation.status === 'pending'; }).length,
      diagLogs: diagLogs.length
    },
    recentEvaluations: recentEvaluations,
    diagLogs: diagLogs
  };
}

// v0.22.5 · Phase 3·3c 前置：全 store IDB 备份（HR 在 schema 升级前可选导出 JSON 作回滚兜底）
//   设计：纯读快照，不修改 IDB；输出大对象由 admin 端 Blob 下载（与 diag bundle 同模式）
//   字段：exportedAt / extensionVersion / dbVersion / stores: { name: [...rows] }
async function buildIdbBackupBundle() {
  const STORES_TO_BACKUP = [
    STORE_CAPTURES,
    STORE_EVALUATIONS,
    STORE_EVENTS,
    STORE_SAYHI_POOL,
    STORE_DIAG_LOGS,
    // v0.24.4：dismissed_candidates store v8 起已删（30s 撤销窗口设计回退）
    'fsa_state',
    'pending_fsa_writes'
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
        // store 不存在或 tx 失败 → 写空数组，不阻断备份
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

async function clearEvaluations() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    tx.objectStore(STORE_EVALUATIONS).clear();
    tx.oncomplete = resolve;
  });
}

// v0.15.0：仅清掉 status='pending' 的评估卡，保留 'done'/'failed'/'over_quota' 历史
// 用于 STOP_LOOP 手动停止时立即清掉"评估中"卡片，让侧栏立即干净
// v0.20.9：同时清 status='queued'（待评估），HR 停止本轮时所有排队的也应该停
async function clearPendingEvaluations() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const req = store.openCursor();
    req.onsuccess = function (e) {
      const cursor = e.target.result;
      if (cursor) {
        const r = cursor.value;
        const st = r && r.evaluation && r.evaluation.status;
        if (st === 'pending' || st === 'queued') {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = function () { resolve(); };
  });
}

// ============ v0.13.0：沟通页候选人池 CRUD ============

async function upsertSayhiCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return 0;
  const db = await openDB();
  let n = 0;
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c || !c.candidateId) continue;
      const rec = Object.assign({}, c, { capturedAt: Date.now() });
      store.put(rec);
      n++;
    }
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
  return n;
}

async function getSayhiPool() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readonly');
    const req = tx.objectStore(STORE_SAYHI_POOL).getAll();
    req.onsuccess = function () {
      const cutoff = Date.now() - SAYHI_POOL_TTL_MS;
      const fresh = (req.result || []).filter(function (r) {
        return (r.capturedAt || 0) >= cutoff;
      });
      // 按 source.indexInBatch 升序（与 BOSS 列表顺序一致）
      fresh.sort(function (a, b) {
        const ai = (a.source && typeof a.source.indexInBatch === 'number') ? a.source.indexInBatch : 999;
        const bi = (b.source && typeof b.source.indexInBatch === 'number') ? b.source.indexInBatch : 999;
        if (ai !== bi) return ai - bi;
        return (b.capturedAt || 0) - (a.capturedAt || 0);
      });
      resolve(fresh);
    };
    req.onerror = function () { resolve([]); };
  });
}

async function clearSayhiPool() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    tx.objectStore(STORE_SAYHI_POOL).clear();
    tx.oncomplete = resolve;
  });
}

// v0.24.4：删 v0.23.0 · Phase 3·3c「自动标不合适 30s 撤销窗口 CRUD」整段
//   设计回退：pass 候选人立即点不合适（HR 勾 checkbox 表达意图 = 信任 LLM，不需二次确认）
//   保留 STORE_DISMISSED_CANDIDATES 常量供 onupgradeneeded 升级使用（v7→v8 删 store）
//   未来如重新启用撤销窗口，从 git history 恢复 5 个 helpers + alarms + handler

// v0.17.0.10 POC A7 回灌：把 DOM 详情面板扫描结果合并到沟通页池子记录
// 只更新 bossSignals.domDetail 字段，不动其他字段（与 v0.13.3 mergeCandidatesIntoSayhiPool 互补）
async function mergeDomDetailIntoSayhiPool(candidateId, domDetail) {
  if (!candidateId || !domDetail) return false;
  if (!self.BossExtractor || typeof self.BossExtractor.extractFromDetailPanel !== 'function') return false;
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    const getReq = store.get(String(candidateId));
    getReq.onsuccess = function () {
      const existing = getReq.result;
      if (!existing) {
        // 不在池子里 — 候选人没在当前 LOOP 范围内，跳过（不创建新记录避免污染）
        resolve(false);
        return;
      }
      const updated = Object.assign({}, existing, {
        bossSignals: Object.assign({}, existing.bossSignals || {}, {
          domDetail: domDetail
        }),
        domEnrichedAt: Date.now()
      });
      const putReq = store.put(updated);
      putReq.onsuccess = function () { resolve(true); };
      putReq.onerror = function () { resolve(false); };
    };
    getReq.onerror = function () { resolve(false); };
  });
}

// v0.13.3：检查 candidateId 是否已在沟通页池子里
async function isInSayhiPool(candidateId) {
  if (!candidateId) return false;
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readonly');
    const req = tx.objectStore(STORE_SAYHI_POOL).get(String(candidateId));
    req.onsuccess = function () { resolve(!!req.result); };
    req.onerror = function () { resolve(false); };
  });
}

// v0.13.3：把 chat/geek/info 提到的完整字段合并到沟通页池子记录
// 保留：DOM 扫描时的 source.scenario='sayhi-tab'、greeting 招呼文本、capturedAt 入池时间
// 覆盖：basic / expectation / workHistory / education / bossSignals（用 chat/geek/info 完整字段）
async function mergeCandidatesIntoSayhiPool(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return 0;
  const db = await openDB();
  let merged = 0;
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    let remaining = candidates.length;
    if (remaining === 0) { resolve(); return; }
    candidates.forEach(function (c) {
      const getReq = store.get(c.candidateId);
      getReq.onsuccess = function () {
        const existing = getReq.result;
        if (!existing) {
          // 不在池子里，不合并
          if (--remaining === 0) resolve();
          return;
        }
        // 字段合并：chat/geek/info 完整字段覆盖 DOM 扫描的稀疏字段
        // 但保留 sayhi 特有元信息
        const mergedRec = Object.assign({}, c, {
          candidateId: existing.candidateId,
          source: existing.source,               // 保留 sayhi-tab 标记 + securityId/encryptJobId
          greeting: existing.greeting,           // 保留候选人主动招呼文本
          capturedAt: existing.capturedAt,       // 保留入池时间
          enrichedAt: Date.now(),                // 新增：字段补全时间戳
          // 合并后的 candidate.basic 用 c 的（chat/geek/info 完整）
          // 但若 c.basic.desc 为 null 且 existing.basic.desc 有值（DOM 扫描的招呼），保留 existing
          basic: Object.assign({}, c.basic || {}, {
            desc: (c.basic && c.basic.desc) || (existing.basic && existing.basic.desc) || null
          })
        });
        store.put(mergedRec);
        merged++;
        if (--remaining === 0) resolve();
      };
      getReq.onerror = function () {
        if (--remaining === 0) resolve();
      };
    });
    tx.onerror = function () { reject(tx.error); };
  });
  return merged;
}

// ===== v0.15.1：聊天历史合并 =====
// historyMsg 抓到后，extractor 给一个 { uids, messages, lastMessageAt } 结构；
// 因 historyMsg 不知道谁是 HR 谁是候选人，要在 evaluations / sayhi_pool 里查匹配 uid，
// 找到则给消息加 role:'candidate'|'hr'，合并到 candidate.chatHistory（按 mid 去重 + time 排序）。
//
// 业务价值：业务文档 5.7 §11.5 "信息源优先级 chat > 简历 > bossSignals" 这条至此首次生效——
// 在此之前 prompt-builder 第 67 行虽然写了"chatHistory 最高优先级"，但 candidate 对象里根本
// 没这个字段。修复后 LLM 能看到候选人主动陈述（"我是印尼留学生"等）。
async function mergeChatHistoryFromHistoryMsg(payload) {
  if (!self.BossExtractor || typeof self.BossExtractor.extractFromHistoryMsg !== 'function') return;
  const parsed = self.BossExtractor.extractFromHistoryMsg(payload && payload.data);
  if (!parsed) return;

  // v0.17.0.9 POC A6 回灌:简历卡片字段(applyStatus / content1 / content2 / bottomText /
  // experiences / position 等)合到 candidate.bossSignals.resumeCard。
  // 这条独立路径,与 chatHistory 合并并行,不互相影响。
  if (Array.isArray(parsed.resumeCards) && parsed.resumeCards.length) {
    await mergeResumeCardsToStore(parsed.resumeCards);
  }

  if (!parsed.uids.length || !parsed.messages.length) return;

  // 先查 evaluations，再查 sayhi_pool（两条流水线都可能有匹配 candidate）
  const evMatch = await findCandidateInStore(parsed.uids, STORE_EVALUATIONS);
  const poolMatch = evMatch ? null : await findCandidateInStore(parsed.uids, STORE_SAYHI_POOL);
  const matched = evMatch || poolMatch;

  if (!matched) {
    console.debug('[BOSS-Sniffer chatHistory] uids 不在任何已知 candidate 池：' + JSON.stringify(parsed.uids));
    return;
  }

  // 给消息加 role 字段（candidate vs hr），judge.js line 164 直接消费
  const enriched = parsed.messages.map(function (m) {
    return Object.assign({}, m, {
      role: m.from && m.from.uid === matched.uid ? 'candidate' : 'hr'
    });
  });

  // 按 store 形态写回（evaluations 是 wrapper，sayhi_pool 是铺平的 candidate）
  if (evMatch) {
    await appendChatHistoryToEvaluation(matched.uid, enriched, parsed.lastMessageAt);
    console.info('[BOSS-Sniffer chatHistory] 合并 ' + enriched.length + ' 条消息到 evaluations[' + matched.uid + ']');
  } else {
    await appendChatHistoryToSayhiPool(matched.uid, enriched, parsed.lastMessageAt);
    console.info('[BOSS-Sniffer chatHistory] 合并 ' + enriched.length + ' 条消息到 sayhi_pool[' + matched.uid + ']');
  }

  // v0.23.0 · Phase 3·3d：L3 engaged 事件埋点（候选人首次回复 HR）
  //   触发条件：enriched 中有 role==='candidate' 消息；防重复 emit 用 hasRecentEvent
  //   payload 含首条候选人消息时间戳便于后续看板做"首次回复延迟"分析
  try {
    const candidateMsg = enriched.find(function (m) { return m && m.role === 'candidate'; });
    if (candidateMsg && self.BossEvents && typeof self.BossEvents.hasRecentEvent === 'function') {
      const already = await self.BossEvents.hasRecentEvent(matched.uid, 'engaged', 30 * 24 * 60 * 60 * 1000);
      if (!already) {
        const jobId = (evMatch && evMatch.record && evMatch.record.evaluation && evMatch.record.evaluation.jdId)
                    || (poolMatch && poolMatch.record && poolMatch.record.source && poolMatch.record.source.jobId)
                    || '';
        await self.BossEvents.logEvent({
          stage: 'engaged',
          candidateId: matched.uid,
          scenario: 'chat',
          jobId: jobId,
          payload: {
            engagedAt: Date.now(),
            firstReplyAt: candidateMsg.time || candidateMsg.ts || Date.now()
          }
        });
        if (self.BossDiag) self.BossDiag.log('info', 'funnel.engaged', '候选人首次回复', { candidateId: matched.uid });
      }
    }
  } catch (err) {
    if (self.BossDiag) self.BossDiag.log('warn', 'funnel.engaged', 'engaged emit 失败', { error: err && err.message });
  }
}

// v0.17.0.9 POC A6 回灌:把 BOSS 推的简历卡片(historyMsg messages[].body.resume)
// 结构化字段合到 candidate.bossSignals.resumeCard 上。
// 不覆盖现有 candidate.basic / candidate.expectation(chat/geek/info 已抽过的字段更权威)。
// 字段优先级:judge.serializeCandidate 读 bossSignals.resumeCard 时自己决定渲染位置。
async function mergeResumeCardsToStore(cards) {
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card || !card.candidateId) continue;
    // 先 evaluations,后 sayhi_pool(两条流水线优先级一致,evaluations 是主)
    const evMatch = await findCandidateInStore([card.candidateId], STORE_EVALUATIONS);
    const poolMatch = evMatch ? null : await findCandidateInStore([card.candidateId], STORE_SAYHI_POOL);
    const matched = evMatch || poolMatch;
    if (!matched) continue;
    if (evMatch) {
      await appendResumeCardToEvaluation(card.candidateId, card);
    } else {
      await appendResumeCardToSayhiPool(card.candidateId, card);
    }

    // v0.23.0 · Phase 3·3d：L4 resume_received 事件埋点（首次拿到候选人简历）
    //   防重复：hasRecentEvent（同候选人 30 天内不重复 emit）
    try {
      if (self.BossEvents && typeof self.BossEvents.hasRecentEvent === 'function') {
        const already = await self.BossEvents.hasRecentEvent(card.candidateId, 'resume_received', 30 * 24 * 60 * 60 * 1000);
        if (!already) {
          const jobId = (evMatch && evMatch.record && evMatch.record.evaluation && evMatch.record.evaluation.jdId)
                      || (poolMatch && poolMatch.record && poolMatch.record.source && poolMatch.record.source.jobId)
                      || '';
          await self.BossEvents.logEvent({
            stage: 'resume_received',
            candidateId: card.candidateId,
            scenario: 'chat',
            jobId: jobId,
            payload: {
              resumeReceivedAt: Date.now(),
              applyStatus: card.applyStatus || '',
              position: card.position || ''
            }
          });
          if (self.BossDiag) self.BossDiag.log('info', 'funnel.resume_received', '首次拿到简历', { candidateId: card.candidateId });
        }
      }
    } catch (err) {
      if (self.BossDiag) self.BossDiag.log('warn', 'funnel.resume_received', 'resume_received emit 失败', { error: err && err.message });
    }
  }
}

async function appendResumeCardToEvaluation(candidateId, card) {
  const db = await openDB();
  await new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const req = store.get(String(candidateId));
    req.onsuccess = function () {
      const r = req.result;
      if (!r || !r.candidate) { resolve(); return; }
      r.candidate.bossSignals = r.candidate.bossSignals || {};
      r.candidate.bossSignals.resumeCard = card;
      store.put(r);
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function appendResumeCardToSayhiPool(candidateId, card) {
  const db = await openDB();
  await new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    const req = store.get(String(candidateId));
    req.onsuccess = function () {
      const r = req.result;
      if (!r) { resolve(); return; }
      r.bossSignals = r.bossSignals || {};
      r.bossSignals.resumeCard = card;
      store.put(r);
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

// 在指定 store 中按 uid 数组并发查找 candidate;返回第一个命中的 { uid, record }
async function findCandidateInStore(uids, storeName) {
  if (!Array.isArray(uids) || !uids.length) return null;
  const db = await openDB();
  return new Promise(function (resolve) {
    let tx;
    try {
      tx = db.transaction(storeName, 'readonly');
    } catch (e) {
      resolve(null);
      return;
    }
    const store = tx.objectStore(storeName);
    let found = null;
    let remaining = uids.length;
    uids.forEach(function (uid) {
      const req = store.get(String(uid));
      req.onsuccess = function () {
        if (req.result && !found) found = { uid: String(uid), record: req.result };
        if (--remaining === 0) resolve(found);
      };
      req.onerror = function () {
        if (--remaining === 0) resolve(found);
      };
    });
  });
}

function mergeMessagesUnique(existing, incoming) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = {};
  out.forEach(function (m) { if (m && m.mid) seen[m.mid] = true; });
  incoming.forEach(function (m) {
    if (!m) return;
    if (m.mid && seen[m.mid]) return;
    out.push(m);
    if (m.mid) seen[m.mid] = true;
  });
  out.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
  return out;
}

// evaluations 存的是 wrapper：{ candidateId, candidate, evaluation, ... }
async function appendChatHistoryToEvaluation(candidateId, newMessages, lastMessageAt) {
  const db = await openDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const req = store.get(String(candidateId));
    req.onsuccess = function () {
      const r = req.result;
      if (!r || !r.candidate) { resolve(); return; }
      r.candidate.chatHistory = mergeMessagesUnique(r.candidate.chatHistory, newMessages);
      r.candidate.chatLastMessageAt = lastMessageAt;
      store.put(r);
    };
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });
}

// sayhi_pool 直接铺平 candidate
async function appendChatHistoryToSayhiPool(candidateId, newMessages, lastMessageAt) {
  const db = await openDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    const req = store.get(String(candidateId));
    req.onsuccess = function () {
      const r = req.result;
      if (!r) { resolve(); return; }
      r.chatHistory = mergeMessagesUnique(r.chatHistory, newMessages);
      r.chatLastMessageAt = lastMessageAt;
      store.put(r);
    };
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });
}

// 向 BOSS tab 发起一次 DOM 扫描请求（content.js → inject.js → 回传）
async function scanSayhiTabOnce() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
      if (!tabs || !tabs.length) {
        resolve({ ok: false, error: '未找到打开的 BOSS 直聘标签页', candidates: [] });
        return;
      }
      // 优先含 /chat/ URL 的（沟通页 / 推荐页都在 /chat/ 下）
      const target = tabs.find(function (t) { return /\/chat\//.test(t.url || ''); }) || tabs[0];
      try {
        chrome.tabs.sendMessage(target.id, { type: 'SCAN_SAYHI_TAB' }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, candidates: [] });
            return;
          }
          if (!resp) {
            resolve({ ok: false, error: 'no-response', candidates: [] });
            return;
          }
          resolve({
            ok: !!resp.ok,
            candidates: resp.candidates || [],
            stats: resp.stats || null,                 // v0.13.2 诊断透传
            error: resp.error || null,
            tabId: target.id,
            tabUrl: target.url || ''
          });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e), candidates: [] });
      }
    });
  });
}

// 沟通页批量评估状态机（内存，不持久化 — SW 重启后回到 idle）
let sayhiEvalRun = {
  running: false,
  total: 0,
  done: 0,
  abortRequested: false,
  startedAt: 0
};

// v0.13.3：触发 BOSS 页面主动 fetch chat/geek/info × N 补全字段
async function triggerFetchGeekInfoBatch(items) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
      if (!tabs || !tabs.length) {
        resolve({ ok: false, error: '未找到 BOSS 直聘标签页', results: [] });
        return;
      }
      const target = tabs.find(function (t) { return /\/chat\//.test(t.url || ''); }) || tabs[0];
      try {
        chrome.tabs.sendMessage(target.id, {
          type: 'TRIGGER_FETCH_GEEK_INFO_BATCH',
          items: items
        }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, results: [] });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response', results: [] });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e), results: [] });
      }
    });
  });
}

// v0.17.0.10 POC A7 阶段 b：BG 触发"点击候选人 + 扫详情面板"
// 流程：BG → content (CLICK_AND_SCAN_DETAIL) → inject (click + waitFor + scanDetailPanelDom) → response
// 返回：{ ok, uid, scan: rawScan, error, waitedMs }
async function triggerClickAndScanDetail(candidateId, timeoutMs) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
      if (!tabs || !tabs.length) {
        resolve({ ok: false, error: '未找到 BOSS 直聘标签页' });
        return;
      }
      const target = tabs.find(function (t) { return /\/chat\//.test(t.url || ''); }) || tabs[0];
      try {
        chrome.tabs.sendMessage(target.id, {
          type: 'CLICK_AND_SCAN_DETAIL',
          uid: String(candidateId),
          timeoutMs: timeoutMs || 3000
        }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  });
}

// v0.13.3：核心评估函数（被批量 / 单人评估共用）
// 1) 拉池子拿待评估候选人
// 2) 触发主动 fetch chat/geek/info 补全字段（fetch 响应被 hook 自动 capture → mergeCandidatesIntoSayhiPool）
// 3) 重新拉池子拿补全后的 candidate
// 4) 跑 LLM 评估
// opts: { force?:boolean, executeAction?:boolean }
//   - force=true：单评强制重跑，绕过 30min 新鲜度门
//   - executeAction=true：v0.17.1.0+ 评估「符合」后自动输入话术 + 求简历（Phase 3 接管，Phase 0 仅占位）
async function evalSayhiCore(targetCandidateIds, opts) {
  const force = !!(opts && opts.force);
  const executeAction = !!(opts && opts.executeAction);
  const allPool = await getSayhiPool();
  let pool = allPool;
  if (Array.isArray(targetCandidateIds) && targetCandidateIds.length) {
    const set = new Set(targetCandidateIds.map(String));
    pool = allPool.filter(function (c) { return set.has(String(c.candidateId)); });
  }
  if (!pool.length) return { ok: false, error: '候选人池为空或目标候选人不在池中' };

  // 筛选未评估 / 失败 / 陈旧（force=true 时绕过新鲜度门，用户主动单评就是想重跑）
  const allEvals = await getEvaluations();
  const evalMap = {};
  for (let i = 0; i < allEvals.length; i++) evalMap[allEvals[i].candidateId] = allEvals[i];

  const staleCutoff = Date.now() - SAYHI_EVAL_STALE_MS;
  let todo = pool.filter(function (c) {
    if (force) return true;
    const e = evalMap[c.candidateId];
    if (!e || !e.evaluation) return true;
    if (e.evaluation.status === 'failed') return true;
    const judgedAt = e.evaluation.judgedAt || 0;
    if (judgedAt < staleCutoff) return true;
    return false;
  });

  // v0.22.3 · Phase 2·2d：批次阈值 K = 本批最多评估几人（spec §3.2.3）
  // force=true 是单评（target 已指定 1 人），不应被 K 截断 → 仅批量评估时生效
  const batchCfg = appConfig.sayhiBatch || {};
  const maxBrowseK = parseInt(batchCfg.maxBrowseK, 10);
  if (!force && Number.isFinite(maxBrowseK) && maxBrowseK > 0 && todo.length > maxBrowseK) {
    if (self.BossDiag) {
      self.BossDiag.log('info', 'sayhi.k_truncate', '浏览数 K 截断本批 todo', {
        original: todo.length, K: maxBrowseK
      });
    }
    todo = todo.slice(0, maxBrowseK);
  }

  if (!todo.length) {
    return { ok: true, total: 0, message: '已评估且未陈旧，无需重评' };
  }

  sayhiEvalRun = {
    running: true,
    total: todo.length,
    done: 0,
    abortRequested: false,
    startedAt: Date.now()
  };

  (async function () {
    try {
      // 1) 主动 fetch 补全字段：仅对 enrichedAt 缺失或陈旧（超过 30min）的候选人补
      const fetchTargets = todo
        .filter(function (c) {
          const enrichedAt = c.enrichedAt || 0;
          return enrichedAt < staleCutoff;
        })
        .map(function (c) {
          return {
            uid: c.candidateId,
            securityId: (c.source && c.source.securityId) || '',
            geekSource: 0
          };
        })
        .filter(function (it) { return it.securityId; });

      // v0.17.0.10 风控考量：默认关闭 v0.13.3 主动 fetch（appConfig.sayHiDom.proactiveFetchEnabled=false）
      // 因为 DOM 扫描的模拟点击会让 BOSS 自调 chat/geek/info（HR 真实行为），不需要额外并发批量 fetch
      if (appConfig.sayHiDom.proactiveFetchEnabled && fetchTargets.length) {
        console.info('[BOSS-Sniffer sayhi] 主动 fetch 补全字段 ' + fetchTargets.length + ' 人');
        const r = await triggerFetchGeekInfoBatch(fetchTargets);
        if (!r.ok) {
          console.warn('[BOSS-Sniffer sayhi] fetch 补全失败：' + r.error + '，回退到 DOM 字段评估');
        } else {
          console.info('[BOSS-Sniffer sayhi] 补全完成，成功 ' +
            (r.results || []).filter(function (x) { return x.ok; }).length + '/' + fetchTargets.length);
        }
      }

      // v0.17.1.0：彻底退出 pipeline，回到 per-候选人 串行
      // 架构变更：
      //   - pipeline (semaphore 并发 LLM) 在 executeAction=true 时会"操作错人"
      //     —— A 的 LLM 还在跑，面板已切到 B，A 的「符合」结果导致求简历发到 B 头上
      //   - 全部走串行：扫 DOM → await LLM → upsert → (可选) 自动操作 → 冷却 → 下一人
      //   - 单评 = 批量 = 同一条循环，唯一区别是 todo.length 和是否启用自动操作
      const llmCfg = getCurrentLlmConfig();

      // v0.21.0 · Phase 1·1c：多岗位 JD 路由
      // 批量预算路由结果（避免循环里反复 listTemplates；HR 中途改 JD 别名不影响当前批次的一致性）
      const allTemplates = await self.BossJD.listTemplates();
      const routeResults = todo.map(function (c) {
        const ja = c && c.expectation && c.expectation.jobAligned;
        return self.BossJDRouter.routeWithDiagnosis(ja, allTemplates);
      });
      const routedCount = routeResults.filter(function (r) { return r.reason === 'matched'; }).length;
      const unroutedCount = todo.length - routedCount;
      if (self.BossDiag) {
        self.BossDiag.log('info', 'sayhi.route', '沟通页路由完成', {
          total: todo.length,
          routed: routedCount,
          unrouted: unroutedCount,
          unrouteReasons: routeResults.filter(function (r) { return r.reason !== 'matched'; })
            .reduce(function (acc, r) { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {})
        });
      }

      // v0.20.9：先 upsert queued 全部（sidepanel 立即看到"待评估"卡片，串行循环里轮到谁再转 pending）
      // v0.21.0 · 1c：未路由命中的候选人直接 upsert 为 'unrouted'，跳过 LLM 调用
      await upsertEvaluations(todo.map(function (c, idx) {
        const r = routeResults[idx];
        if (r.reason !== 'matched') {
          return {
            candidateId: c.candidateId,
            candidate: c,
            evaluation: {
              status: 'unrouted',
              unrouteReason: r.reason,  // 'no_jobAligned' | 'no_match' | 'no_templates'
              jobAligned: (c.expectation && c.expectation.jobAligned) || null,
              judgedAt: Date.now()
            },
            capturedAt: c.capturedAt || Date.now(),
            capturedUrl: 'sayhi-tab'
          };
        }
        return {
          candidateId: c.candidateId,
          candidate: c,
          evaluation: { status: 'queued', queuedAt: Date.now() },
          capturedAt: c.capturedAt || Date.now(),
          capturedUrl: 'sayhi-tab'
        };
      }));

      // v0.17.1.3：自动操作判断（仅批量评估启用，单评永不自动）
      // executeAction:true 来自 evalSayhiBatch，:false 来自 evalSayhiSingle
      // v0.24.3 BUG fix：autoActionOn / autoMarkOn 拆为独立变量
      //   起因：v0.22.2 两个 checkbox 设计为联动，pass 分支 gate 用 autoActionOn（绑 enabledBatchEval）。
      //   v0.24.1 把 UI checkbox 联动放宽（两个独立），但 background gate 没拆 → HR 只勾「自动标不合适」
      //   不勾「自动话术+求简历」时 autoActionOn=false，pass 候选人不入队 dismissed_candidates，
      //   30s 撤销窗口永不生成。Fix：autoMarkOn 独立读 autoMarkUnsuitable。
      const autoActionOn = executeAction && !!(appConfig.autoAction && appConfig.autoAction.enabledBatchEval);
      const autoMarkOn = executeAction && !!(appConfig.autoAction && appConfig.autoAction.autoMarkUnsuitable);
      const dryRun = !!(appConfig.autoAction && appConfig.autoAction.dryRun);

      if (self.BossDiag) {
        self.BossDiag.log('info', 'sayhi.serial_start', 'sayhi 串行评估启动', {
          todoCount: todo.length,
          routedCount: routedCount,
          unroutedCount: unroutedCount,
          executeAction: executeAction,
          autoActionOn: autoActionOn,
          autoMarkOn: autoMarkOn,
          dryRun: dryRun,
          sayHiDomConfig: appConfig.sayHiDom || null,
          autoActionConfig: appConfig.autoAction || null,
          model: llmCfg && llmCfg.model
        });
      }

      // 冷却参数：执行操作时用 autoAction.actionCooldownMin/Max（2-4s），否则用 sayHiDom.cooldownMin/Max（5-8s）
      const scanMaxPerRun = Math.max(0, parseInt(appConfig.sayHiDom.scanMaxPerRun, 10) || 0);
      const domCooldownMin = Math.max(0, parseInt(appConfig.sayHiDom.cooldownMinMs, 10) || 5000);
      const domCooldownMax = Math.max(domCooldownMin, parseInt(appConfig.sayHiDom.cooldownMaxMs, 10) || 8000);
      const actCooldownMin = Math.max(0, parseInt(appConfig.autoAction && appConfig.autoAction.actionCooldownMinMs, 10) || 2000);
      const actCooldownMax = Math.max(actCooldownMin, parseInt(appConfig.autoAction && appConfig.autoAction.actionCooldownMaxMs, 10) || 4000);

      const DOM_SCAN_FAIL_STOP = 3;
      let domScanFailStreak = 0, domScanSuccess = 0, domScanAttempts = 0;
      // v0.24.5 BUG fix：拆分 streak 为两个独立计数器（autoGreet / autoMark 各自统计）
      //   起因：HR 反馈勾了 autoMark 但 pass 候选人没标。共用 actionFailStreak 时，
      //   autoGreet 连环失败 3 次会**连带**锁 autoMark，让所有后续 pass 候选人 skip。
      //   v0.22.4 引入 streak 的设计是"该方向连环失败 → 该方向停"，应当分别计数。
      let actionGreetFailStreak = 0, actionMarkFailStreak = 0, actionSuccess = 0;
      const ACTION_FAIL_STOP = 3;  // 连续 3 次（同一方向）失败 → 怀疑 BOSS 改 UI / 风控触发 → 停该方向

      // v0.22.4 · Phase 3·3b：失败 step 分类策略（spec §3.3·3）
      //   inject.js 各 fail return 带 result.failedStep 枚举字段，bg 这里按 step 走差异化策略
      //   未匹配（policy=undef）→ 走老 actionFailStreak 兜底（保留作为分类表覆盖不到的偶发模式）
      const STEP_POLICY = {
        // 偶发：inject.js 内已 retry 1 次仍失败 → 跳过该候选人，不计 actionFailStreak
        'editor-input': 'skip-candidate',
        // BOSS UI 改名信号 → 立即停整批（避免连环失败）
        'find-request-btn': 'stop-batch',
        'find-unsuitable-btn': 'stop-batch',
        // 已发出动作的后半失败 → partial 标记 + 继续（不消耗 fail streak）
        'click-confirm': 'partial-continue',
        'wait-card-gone': 'partial-continue',
        'wait-message-sent': 'partial-continue',
        'click-request-btn': 'partial-continue',
        'wait-confirm-dialog': 'partial-continue'
      };

      // v0.22.3 · Phase 2·2d：招呼数 N — 本批最多发几条话术（spec §3.2.3）
      // v0.25.0：删 N 招呼数 cap（概念彻底废弃）

      for (let i = 0; i < todo.length; i++) {
        if (sayhiEvalRun.abortRequested) break;
        // v0.24.4：删 sweepExpiredDismissals 调用（30s 撤销窗口设计回退，pass 立即点不合适不需 sweep）
        // v0.25.0：删 N 招呼数 cap 检查（概念彻底废弃）
        const c = todo[i];

        // v0.21.0 · 1c：unrouted 候选人在批量预算阶段已经写入 IDB（status='unrouted'）
        // 这里直接跳过 — 不做 DOM 扫描、不调 LLM、不走自动操作、不消耗冷却预算
        // sayhiEvalRun.done 也 ++，让 sidepanel 进度条照常推进
        const route = routeResults[i];
        if (route.reason !== 'matched') {
          sayhiEvalRun.done++;
          if (self.BossDiag) {
            self.BossDiag.log('info', 'sayhi.unrouted_skip', 'unrouted 候选人跳过 LLM', {
              candidateId: c.candidateId,
              jobAligned: (c.expectation && c.expectation.jobAligned) || null,
              reason: route.reason
            });
          }
          continue;
        }
        // v0.21.0 · 1c：本候选人评估用的 JD（按沟通职位别名路由命中）
        const jd = route.jd;

        // 1) DOM 扫描（仅在 domDetail 缺失/陈旧 且 没超 scanMaxPerRun 预算 且 没连失败 3 次时尝试）
        const dd = c.bossSignals && c.bossSignals.domDetail;
        const domStale = !dd || (Date.now() - (dd.scannedAt || 0) > SAYHI_EVAL_STALE_MS);
        const budgetLeft = scanMaxPerRun === 0 || domScanAttempts < scanMaxPerRun;
        const streakOk = domScanFailStreak < DOM_SCAN_FAIL_STOP;
        if (domStale && budgetLeft && streakOk) {
          domScanAttempts++;
          const scanResp = await triggerClickAndScanDetail(c.candidateId, 3000);
          if (scanResp && scanResp.ok && scanResp.scan) {
            const domDetail = (self.BossExtractor && self.BossExtractor.extractFromDetailPanel)
              ? self.BossExtractor.extractFromDetailPanel(scanResp.scan) : null;
            if (domDetail) {
              await mergeDomDetailIntoSayhiPool(c.candidateId, domDetail);
              domScanSuccess++;
              domScanFailStreak = 0;
            } else {
              domScanFailStreak++;
            }
          } else {
            domScanFailStreak++;
            console.warn('[BOSS-Sniffer sayhi] DOM 扫描失败 uid=' + c.candidateId + ' err=' + (scanResp && scanResp.error));
          }
        }

        // 2) 拉最新 sayhi_pool 拿含 domDetail 的版本
        const freshPool = await getSayhiPool();
        const fresh = freshPool.find(function (p) { return String(p.candidateId) === String(c.candidateId); }) || c;

        // 3) 跑 LLM（await，不进 semaphore）
        if (sayhiEvalRun.abortRequested) break;
        // v0.20.9：LLM await 前一刻翻转 queued → pending（评估中），startedAt 用真正调用时刻
        await upsertEvaluation({
          candidateId: c.candidateId,
          candidate: fresh,
          evaluation: { status: 'pending', startedAt: Date.now() },
          capturedAt: c.capturedAt || Date.now(),
          capturedUrl: 'sayhi-tab'
        });
        let evaluation;
        try {
          const result = await self.BossJudge.judgeCandidate(fresh, jd, llmCfg);
          evaluation = Object.assign({ status: 'done' }, result);
        } catch (err) {
          console.error('[BOSS-Sniffer sayhi] judge failed for', c.candidateId, err);
          evaluation = {
            status: 'failed',
            error: err.name + ': ' + err.message,
            judgedAt: Date.now(),
            latencyMs: err.totalLatencyMs || null,
            attempts: err.attempts || null,
            perAttempt: Array.isArray(err.perAttempt) ? err.perAttempt : [],
            jdTitle: (jd && jd.name) || '?',
            jdId: (jd && jd.jdId) || '',
            provider: (llmCfg && (llmCfg.providerName || llmCfg.protocol)) || '',
            modelId: (llmCfg && llmCfg.model) || ''
          };
        }
        // v0.21.0 · 1c：在 evaluation 上记录路由信息，sidepanel (1d) 据此显示"沟通职位→JD"
        evaluation.routedJdId = jd.jdId;
        evaluation.routedJdName = jd.name;
        evaluation.routedByJobName = route.byJobName;
        await upsertEvaluation({
          candidateId: c.candidateId,
          candidate: fresh,
          evaluation: evaluation,
          capturedAt: c.capturedAt || Date.now(),
          capturedUrl: 'sayhi-tab'
        });
        sayhiEvalRun.done++;

        // 4) 自动操作分支：仅 executeAction=true + autoActionOn + decision='符合' 时触发
        if (autoActionOn && evaluation.decision === '符合' && !sayhiEvalRun.abortRequested) {
          if (actionGreetFailStreak >= ACTION_FAIL_STOP) {
            console.warn('[BOSS-Sniffer sayhi] autoGreet 连续 ' + ACTION_FAIL_STOP + ' 次失败，停止该批后续 autoGreet');
            if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_action_auto_stop',
              'autoGreet 连续失败自动停（autoMark 独立不受影响）', { reason: 'greet-fail-streak' });
          } else {
            // 4.1) 幂等：最近 30min 内已被 greet-then-resume 成功过 → 跳过避免打扰
            const lastAction = fresh.lastAction;
            const recentSuccess = lastAction
              && lastAction.action === 'greet-then-resume'
              && lastAction.ok === true
              && (Date.now() - (lastAction.attemptedAt || 0)) < SAYHI_EVAL_STALE_MS;
            if (recentSuccess) {
              console.info('[BOSS-Sniffer sayhi] 跳过自动操作 uid=' + c.candidateId + ' reason=already-greeted');
              if (self.BossDiag) self.BossDiag.log('info', 'sayhi.auto_action_skip',
                '幂等跳过', { candidateId: c.candidateId, reason: 'already-greeted', lastAt: lastAction.attemptedAt });
            } else {
              // v0.25.2：话术改为从该候选人路由命中的 JD 内嵌话术取（默认话术）
              const greetTpl = getJdDefaultGreetTemplate(jd);
              if (!greetTpl || !greetTpl.text) {
                console.warn('[BOSS-Sniffer sayhi] 跳过自动操作 uid=' + c.candidateId + ' reason=no-greet-template-in-jd');
                if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_action_skip',
                  '无话术模板跳过', { candidateId: c.candidateId, reason: 'no-greet-template' });
              } else {
                console.info('[BOSS-Sniffer sayhi] 执行自动操作 uid=' + c.candidateId + ' greet=' + greetTpl.name + (dryRun ? ' [DRY-RUN]' : ''));
                const actionResp = await triggerGreetThenResume(c.candidateId, greetTpl.text, dryRun);
                await recordSayhiActionResult(c.candidateId, 'greet-then-resume', actionResp.result);

                // v0.22.4 · 3b：按 STEP_POLICY 分流（spec §3.3·3）
                const failedStep = actionResp.result && actionResp.result.failedStep;
                const policy = failedStep ? STEP_POLICY[failedStep] : null;

                if (actionResp.ok && (actionResp.result && actionResp.result.ok)) {
                  // 完全成功 / 半成功（result.ok=true + partial=true，如 wait-card-gone / click-confirm 3b 后）
                  actionSuccess++;
                  actionGreetFailStreak = 0;
                  // v0.25.0：删招呼数计数（cap 已废弃）
                } else if (policy === 'stop-batch') {
                  // v0.22.4 · 3b：BOSS UI 改名信号 → 立即停整批（避免连环失败）
                  console.warn('[BOSS-Sniffer sayhi] 按 step 停整批 uid=' + c.candidateId + ' failedStep=' + failedStep);
                  if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.stop_batch_by_step',
                    '按 step 停整批', { candidateId: c.candidateId, failedStep: failedStep });
                  sayhiEvalRun.abortRequested = true;
                  // 下次循环开头 abortRequested 检查会 break
                } else if (policy === 'skip-candidate') {
                  // v0.22.4 · 3b：inject.js 已重试 1 次仍 fail → 跳过本候选人，不计 actionFailStreak
                  console.info('[BOSS-Sniffer sayhi] 按 step 跳过候选人 uid=' + c.candidateId + ' failedStep=' + failedStep);
                  if (self.BossDiag) self.BossDiag.log('info', 'sayhi.skip_by_step',
                    '按 step 跳过候选人', { candidateId: c.candidateId, failedStep: failedStep });
                } else if (policy === 'partial-continue') {
                  // v0.22.4 · 3b：已发出动作的后半失败 → partial 标记继续，不消耗 fail streak
                  console.info('[BOSS-Sniffer sayhi] partial 继续 uid=' + c.candidateId + ' failedStep=' + failedStep);
                  if (self.BossDiag) self.BossDiag.log('info', 'sayhi.partial_continue',
                    'partial 继续不消耗 streak', { candidateId: c.candidateId, failedStep: failedStep });
                  actionGreetFailStreak = 0;  // 半成功 → 链路通，重置 greet streak
                } else {
                  // 未分类失败 → 走老 actionGreetFailStreak 兜底（防 STEP_POLICY 表未覆盖的偶发模式）
                  actionGreetFailStreak++;
                  console.warn('[BOSS-Sniffer sayhi] autoGreet 失败 uid=' + c.candidateId +
                    ' failedStep=' + (failedStep || 'unclassified') +
                    ' err=' + ((actionResp.result && actionResp.result.error) || actionResp.error));
                }
              }
            }
          }
        }

        // v0.24.4：pass 决策 + autoMarkOn → 立刻点不合适（删 v0.23.0 30s 撤销窗口设计）
        //   HR 勾 checkbox 已表达"信任 LLM"意图，不再二次确认；失败按 STEP_POLICY 处理
        // v0.24.5 BUG fix：① 用 actionMarkFailStreak 独立计数（不再被 autoGreet streak 锁）
        //                  ② decision='pass' 但 gate 不通过时输出 gate-blocked 诊断 log
        if (evaluation.decision === 'pass') {
          if (!autoMarkOn || sayhiEvalRun.abortRequested || actionMarkFailStreak >= ACTION_FAIL_STOP) {
            // gate 不通过 — 输出诊断 log（v0.24.5 起每个被拒原因都可观察）
            if (self.BossDiag) self.BossDiag.log('info', 'sayhi.auto_mark_gate_blocked',
              'pass 候选人但 autoMark gate 不通过', {
                candidateId: c.candidateId,
                autoMarkOn: autoMarkOn,
                abortRequested: sayhiEvalRun.abortRequested,
                actionMarkFailStreak: actionMarkFailStreak,
                streakLimit: ACTION_FAIL_STOP
              });
          } else {
            const markResp = await triggerSayhiAction(c.candidateId, 'mark-unsuitable');
            await recordSayhiActionResult(c.candidateId, 'mark-unsuitable', markResp.result);
            const markFailedStep = markResp.result && markResp.result.failedStep;
            const markPolicy = markFailedStep ? STEP_POLICY[markFailedStep] : null;
            const markOk = markResp && markResp.ok && markResp.result && markResp.result.ok;
            if (markOk) {
              actionMarkFailStreak = 0;
              actionSuccess++;
              if (self.BossDiag) self.BossDiag.log('info', 'sayhi.auto_mark_done',
                '已立即标不合适', { candidateId: c.candidateId });
            } else if (markPolicy === 'stop-batch') {
              // find-unsuitable-btn 找不到 → BOSS UI 改名信号，立刻停整批
              if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_mark_stop_batch',
                'STEP_POLICY=stop-batch 立即停整批', { candidateId: c.candidateId, failedStep: markFailedStep });
              sayhiEvalRun.abortRequested = true;
            } else if (markPolicy === 'partial-continue') {
              // 已点了但 wait-card-gone / click 后半失败 → partial 标记继续不计 streak
              if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_mark_partial',
                'partial-continue 继续不计 streak', { candidateId: c.candidateId, failedStep: markFailedStep });
            } else {
              // 未分类失败 → 计入 actionMarkFailStreak，3 次累积停 autoMark（不影响 autoGreet）
              actionMarkFailStreak++;
              if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_mark_fail',
                '自动标不合适失败', { candidateId: c.candidateId, streak: actionMarkFailStreak,
                  failedStep: markFailedStep || 'unclassified',
                  err: (markResp.result && markResp.result.error) || markResp.error });
            }
          }
        }

        // 5) 冷却（自动操作模式用 2-4s，纯评估模式用 5-8s；DOM 扫已含 ~10s 操作链含 ~15s）
        if (i < todo.length - 1 && !sayhiEvalRun.abortRequested) {
          const cdMin = autoActionOn ? actCooldownMin : domCooldownMin;
          const cdMax = autoActionOn ? actCooldownMax : domCooldownMax;
          const cd = cdMin + Math.random() * (cdMax - cdMin);
          await new Promise(function (r) { setTimeout(r, cd); });
        }
      }

      if (self.BossDiag) {
        self.BossDiag.log('info', 'sayhi.serial_done', 'sayhi 串行评估完成', {
          done: sayhiEvalRun.done,
          total: sayhiEvalRun.total,
          domScanSuccess: domScanSuccess,
          domScanAttempts: domScanAttempts,
          actionSuccess: actionSuccess,
          autoActionOn: autoActionOn
        });
      }
    } catch (e) {
      console.error('[BOSS-Sniffer sayhi] core eval error:', e);
    } finally {
      sayhiEvalRun.running = false;
      console.info('[BOSS-Sniffer sayhi] 评估完成，已评 ' + sayhiEvalRun.done + '/' + sayhiEvalRun.total);
    }
  })();

  return { ok: true, total: todo.length };
}

async function evalSayhiBatch() {
  if (sayhiEvalRun.running) {
    return { ok: false, error: '评估已在进行中，请等待完成或停止' };
  }
  // v0.17.1.3：批量评估启用自动操作（受 admin enabledBatchEval 控制）
  return await evalSayhiCore(null, { executeAction: true });
}

async function evalSayhiSingle(candidateId) {
  if (sayhiEvalRun.running) {
    return { ok: false, error: '评估已在进行中，请等待完成或停止' };
  }
  if (!candidateId) return { ok: false, error: '缺少 candidateId' };
  // v0.17.0.10：单人评估强制重跑（绕过 30min 新鲜度门），跑完整 DOM 扫 + LLM
  // v0.17.1.3：单评永不自动求简历（executeAction=false）。HR 看完结果手动点 🎯 决定。
  //   产品边界：单评 = HR 看个体看仔细的入口，自动化只属于批量场景。
  return await evalSayhiCore([String(candidateId)], { force: true, executeAction: false });
}

function getSayhiEvalStatus() {
  return {
    running: sayhiEvalRun.running,
    total: sayhiEvalRun.total,
    done: sayhiEvalRun.done,
    abortRequested: sayhiEvalRun.abortRequested
  };
}

function abortSayhiEval() {
  if (!sayhiEvalRun.running) {
    return { ok: false, error: '没有进行中的评估' };
  }
  sayhiEvalRun.abortRequested = true;
  return { ok: true };
}

// ===== v0.14.0-pre：沟通页一键操作（求简历 / 标不合适）=====
// 业务约束：
//   - 评估 decision="符合" → 求简历（两步）
//   - 评估 decision="pass" → 不合适（一步，跳过原因弹窗）
//   - 未评估 / failed → 拒绝执行
// 操作结果写回 sayhi_pool 的 lastAction 字段，sidepanel 显示日志方便调试
// 风险：BOSS UI 变化 / isTrusted 校验 / 频率风控；先用 el.click() 探路，黄条策略由后续版本决定

async function triggerSayhiAction(candidateId, action) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
      if (!tabs || !tabs.length) {
        resolve({ ok: false, error: '未找到 BOSS 直聘标签页', result: { ok: false, logs: [] } });
        return;
      }
      const target = tabs.find(function (t) { return /\/chat\//.test(t.url || ''); }) || tabs[0];
      try {
        chrome.tabs.sendMessage(target.id, {
          type: 'EXECUTE_SAYHI_ACTION',
          uid: String(candidateId),
          action: action
        }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, result: { ok: false, logs: [] } });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response', result: { ok: false, logs: [] } });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e), result: { ok: false, logs: [] } });
      }
    });
  });
}

// v0.24.7：chrome.debugger 真用户点击（isTrusted=true）
//   起因：HR 反馈 btn.click() 合成事件 BOSS 拒绝（"不合适" click 后 BOSS 端没标）；
//        HR 确认真用户 click 直接生效，无需二级菜单。
//   方案：用 chrome.debugger Input.dispatchMouseEvent 模拟真用户鼠标，
//        event.isTrusted=true，BOSS 业务接受。
//   代价：会出现"正在调试此浏览器"黄条（每次 attach/detach）。
//   注意：每次 mark 单独 attach + detach 避免长期占用 debugger（与 lib/sayHi.js 复用同一 tab 时不冲突，串行执行）。
async function realClickAtCoords(tabId, x, y) {
  const target = { tabId: tabId };
  function attachOnce() {
    return new Promise(function (resolve, reject) {
      chrome.debugger.attach(target, '1.3', function () {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'attach failed'));
          return;
        }
        resolve();
      });
    });
  }
  function detach() {
    return new Promise(function (resolve) {
      chrome.debugger.detach(target, function () { resolve(); });
    });
  }
  // v0.24.9 fix：自愈 attach（与 lib/sayHi.js attachDebugger 对齐）
  //   起因：v0.24.8 HR 反馈第一个候选人 work + 后续失败。根因：上次 detach 调了但 chrome
  //         内部状态没干净，下次 attach 报 "Another debugger already attached"；v0.24.7/.8
  //         误判为"别人占用"piggyback 跳过 attach，导致命令发到错误 debugger 状态。
  //   方案：检测到 "already attached" → 先 detach 再重 attach（清掉残留状态）
  async function attach() {
    try {
      await attachOnce();
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/already attached|Another debugger/i.test(msg)) {
        try { await detach(); } catch (_e) {}
        await attachOnce();  // 自愈失败则抛错给外层 catch
      } else {
        throw e;
      }
    }
  }
  function dispatch(params) {
    return new Promise(function (resolve, reject) {
      chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve();
      });
    });
  }
  let attached = false;
  try {
    await attach();
    attached = true;
    // v0.24.10 fix：mouseMoved 后**立即** mousePressed（不留 sleep）
    //   起因：v0.24.8/.9 沿用 sayHi.js clickAt 的 30-110ms sleep 节奏。但 HR 说沟通页「不合适」
    //   按钮**有 hover 二级菜单**（鼠标移上去会弹）—— mouseMoved 触发 hover 后 sleep 给 BOSS
    //   足够时间弹出二级菜单覆盖原按钮，mousePressed 落到二级菜单上（click 触发的不是原按钮业务）。
    //   推荐页打招呼按钮无 hover 菜单所以 sayHi.js work，这里必须去掉 mouseMoved → mousePressed
    //   的 sleep（mouseMoved 后立即 press 不给 BOSS UI 处理 hover-popup 的时间窗）。
    //   保留 mousePressed → mouseReleased 之间的 sleep（这是 click 内部 hold 时间，不触发 UI 变化）。
    await dispatch({ type: 'mouseMoved', x: x, y: y, button: 'none' });
    // 不 sleep：mouseMoved 后立即 press，避免 hover 二级菜单弹出覆盖按钮
    await dispatch({ type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await new Promise(function (r2) { setTimeout(r2, 30 + Math.random() * 30); });  // 30-60ms click hold
    await dispatch({ type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    // v0.24.9：始终 detach（不再判 alreadyAttached）—— 自愈策略下永远是自己 attach 的，detach 是干净退出
    if (attached) await detach();
  }
}

// v0.17.1.0：触发"输入话术 + 求简历"链路
// BG → content (EXECUTE_GREET_THEN_RESUME) → inject (executeGreetThenRequestResume) → 回传
async function triggerGreetThenResume(candidateId, greetText, dryRun) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
      if (!tabs || !tabs.length) {
        resolve({ ok: false, error: '未找到 BOSS 直聘标签页', result: { ok: false, logs: [] } });
        return;
      }
      const target = tabs.find(function (t) { return /\/chat\//.test(t.url || ''); }) || tabs[0];
      try {
        chrome.tabs.sendMessage(target.id, {
          type: 'EXECUTE_GREET_THEN_RESUME',
          uid: String(candidateId),
          greetText: String(greetText || ''),
          dryRun: !!dryRun
        }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, result: { ok: false, logs: [] } });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response', result: { ok: false, logs: [] } });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e), result: { ok: false, logs: [] } });
      }
    });
  });
}

// 把操作结果写回 sayhi_pool 记录的 lastAction 字段
async function recordSayhiActionResult(candidateId, action, runResult) {
  const db = await openDB();
  const cid = String(candidateId);
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_SAYHI_POOL, 'readwrite');
    const store = tx.objectStore(STORE_SAYHI_POOL);
    const req = store.get(cid);
    req.onsuccess = function () {
      const existing = req.result;
      if (!existing) { resolve(false); return; }
      existing.lastAction = {
        action: action,
        attemptedAt: Date.now(),
        ok: !!(runResult && runResult.ok),
        partial: !!(runResult && runResult.partial),
        error: (runResult && runResult.error) || null,
        logs: (runResult && Array.isArray(runResult.logs)) ? runResult.logs : []
      };
      store.put(existing);
    };
    tx.oncomplete = function () { resolve(true); };
    tx.onerror = function () { resolve(false); };
  });
}

async function executeSayhiActionForCandidate(candidateId) {
  if (!candidateId) return { ok: false, error: '缺少 candidateId' };
  const cid = String(candidateId);

  // v0.17.1.0：互斥保护——评估循环进行中 HR 不能手动点 🎯（会切走面板焦点错操作）
  if (sayhiEvalRun && sayhiEvalRun.running) {
    return { ok: false, error: '评估循环进行中，请等完成再手动操作' };
  }

  // 1) 查 sayhi_pool
  const pool = await getSayhiPool();
  const item = pool.find(function (c) { return String(c.candidateId) === cid; });
  if (!item) return { ok: false, error: '候选人不在 sayhi_pool 中' };

  // 2) 查评估结果决定 action
  const allEvals = await getEvaluations();
  const ev = allEvals.find(function (e) { return String(e.candidateId) === cid; });
  if (!ev || !ev.evaluation) {
    return { ok: false, error: '候选人尚未评估，请先评估再执行操作' };
  }
  const e = ev.evaluation;
  if (e.status === 'failed') {
    return { ok: false, error: '评估失败状态，无法执行操作（' + (e.error || '') + '）' };
  }
  const decision = e.decision;
  let action;
  if (decision === '符合') action = 'request-resume';
  else if (decision === 'pass') action = 'mark-unsuitable';
  else return { ok: false, error: '评估未完成或决策缺失：' + (decision || 'undefined') };

  // 3) 触发 BOSS 页面执行
  // v0.17.1.1：决策「符合」改走话术 + 求简历（与 evalSayhiCore 内的自动路径一致）
  //   - 拿当前话术模板：getCurrentGreetTemplate()，缺失则提示 HR 先去 admin 选
  //   - 手动点击 = HR 明确意图，**始终真实执行**（dryRun 写死 false，忽略 admin 开关）
  //   - lastAction.action 写 'greet-then-resume' 而非 'request-resume'，便于 sidepanel 区分徽章
  if (action === 'request-resume') {
    const greet = await getCurrentGreetTemplate();
    if (!greet || !String(greet.text || '').trim()) {
      return {
        ok: false,
        action: 'greet-then-resume',
        error: '请先选择当前话术模板（admin → 话术模板管理）',
        logs: []
      };
    }
    const runResp = await triggerGreetThenResume(cid, greet.text, false);  // dryRun=false（手动始终真发）
    const runResult = (runResp && runResp.result) || { ok: !!(runResp && runResp.ok), logs: [], error: runResp && runResp.error };
    await recordSayhiActionResult(cid, 'greet-then-resume', runResult);
    return {
      ok: !!runResult.ok,
      action: 'greet-then-resume',
      partial: !!runResult.partial,
      error: runResult.error || (runResp && !runResp.ok ? runResp.error : null),
      logs: runResult.logs || []
    };
  }

  // 'mark-unsuitable' 走 v0.14 旧路径不变（pass 决策不需要发话术）
  const runResp = await triggerSayhiAction(cid, action);
  const runResult = (runResp && runResp.result) || { ok: !!(runResp && runResp.ok), logs: [], error: runResp && runResp.error };
  await recordSayhiActionResult(cid, action, runResult);

  return {
    ok: !!runResult.ok,
    action: action,
    partial: !!runResult.partial,
    error: runResult.error || (runResp && !runResp.ok ? runResp.error : null),
    logs: runResult.logs || []
  };
}

// ===== captures CRUD =====
async function rebuildStatsFromDB() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_CAPTURES, 'readonly');
    const store = tx.objectStore(STORE_CAPTURES);
    const stats = { total: 0, byPath: {} };
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = function (e) {
      const c = e.target.result;
      if (c) {
        stats.total += 1;
        const p = c.value.apiPath || '(unknown)';
        stats.byPath[p] = (stats.byPath[p] || 0) + 1;
        c.continue();
      } else {
        inMemoryStats = stats;
        resolve(stats);
      }
    };
    cursorReq.onerror = function () { resolve(inMemoryStats); };
  });
}

async function exportAll() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_CAPTURES, 'readonly');
    const req = tx.objectStore(STORE_CAPTURES).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { resolve([]); };
  });
}

async function clearAll() {
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(
      [STORE_CAPTURES, STORE_EVALUATIONS, STORE_EVENTS],
      'readwrite'
    );
    tx.objectStore(STORE_CAPTURES).clear();
    tx.objectStore(STORE_EVALUATIONS).clear();
    tx.objectStore(STORE_EVENTS).clear();
    tx.oncomplete = function () {
      inMemoryStats = { total: 0, byPath: {} };
      resolve();
    };
  });
}

// ===== 配置 =====
function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  Object.keys(patch).forEach(function (k) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
      target[k] = target[k] || {};
      deepMerge(target[k], patch[k]);
    } else {
      target[k] = patch[k];
    }
  });
  return target;
}

// configReady 在 service worker 启动时立即创建，所有依赖配置的代码 await 它
// 防止 SW 休眠重启后首批评估读到空配置
let configReady = null;
function loadConfig() {
  // screeningEnabled 不从持久化恢复——每次 SW 重启 / 浏览器重启都默认暂停筛选，
  // HR 主动开启后才监听 BOSS 列表，避免重启后默默工作。
  // 注意：'jd' key 不再走 loadConfig，由 lib/jd-templates.js 通过 BossStorageSync 自己管理。
  // v0.17.1.0：加 autoAction 走 sync（评估「符合」自动输入话术 + 求简历的开关）
  // v0.22.3 · Phase 2·2d：加 sayhiBatch（沟通页 K/N 阈值，HR 在 sidepanel 改完跨设备同步）
  configReady = self.BossStorageSync.migrateFromLocal(['llm', 'sayHi', 'sayHiDom', 'autoAction', 'sayhiBatch']).then(function () {
    return self.BossStorageSync.get(['llm', 'sayHi', 'sayHiDom', 'autoAction', 'sayhiBatch']);
  }).then(function (res) {
    if (self.BossLLM && typeof self.BossLLM.normalizeLlmSettings === 'function') {
      appConfig.llm = self.BossLLM.normalizeLlmSettings(res.llm || appConfig.llm);
      if (res.llm && !Array.isArray(res.llm.configs)) {
        self.BossStorageSync.set({ llm: appConfig.llm }).catch(function (err) {
          console.warn('[BOSS-Sniffer] 写入默认 llm 配置失败：', err && err.message);
        });
      }
    } else if (res.llm) {
      deepMerge(appConfig.llm, res.llm);
    }
    if (res.sayHi) deepMerge(appConfig.sayHi, res.sayHi);
    if (res.sayHiDom) deepMerge(appConfig.sayHiDom, res.sayHiDom);
    if (res.autoAction) deepMerge(appConfig.autoAction, res.autoAction);
    if (res.sayhiBatch) deepMerge(appConfig.sayhiBatch, res.sayhiBatch);
  });
  return configReady;
}

async function saveConfigSection(section, patch) {
  if (!appConfig[section]) return;
  if (section === 'llm' && self.BossLLM && typeof self.BossLLM.normalizeLlmSettings === 'function') {
    appConfig.llm = self.BossLLM.normalizeLlmSettings(patch);
  } else {
    deepMerge(appConfig[section], patch);
  }
  // 脱敏 apiKey 后打 log，方便诊断热更新是否生效
  const safePatch = section === 'llm' ? sanitizeLlmForLog(patch) : Object.assign({}, patch);
  if (safePatch && safePatch.apiKey) safePatch.apiKey = '***(已覆盖)';
  console.info('[BOSS-Sniffer] 配置已热更新 section=' + section, safePatch);
  const obj = {};
  obj[section] = appConfig[section];
  return self.BossStorageSync.set(obj);
}

// ===== 启动 =====
// captures TTL 清理：启动跑一次
self.BossCapturesCleaner.cleanExpiredCaptures().then(function (r) {
  if (r.deleted > 0) console.info('[BOSS-Sniffer] captures TTL 清理：' + r.deleted + ' 条');
}).catch(function (err) {
  console.warn('[BOSS-Sniffer] captures TTL 清理失败：', err && err.message);
});
loadConfig(); // 立即返回 Promise → 后续 evaluateIfCandidate 会 await configReady
configReady.then(async function () {
  rebuildStatsFromDB().catch(function () {});
  // 恢复 sayHi 队列状态；是否消费由本轮自动化状态 + sayHi 配置共同决定。
  await self.BossSayHi.init();
  reconcileSayHiConsumer();
  if (self.BossDiag) {
    const cfg = getCurrentLlmConfig();
    self.BossDiag.log('info', 'sw.boot', 'SW 启动 + 配置加载完成', {
      provider: cfg && cfg.providerName,
      model: cfg && cfg.model,
      concurrency: cfg && cfg.concurrency,
      activeJdId: appConfig.jd && appConfig.jd.activeJdId
    });
  }
});

// 触发 BOSS 推荐页 location.reload() 让 inject 在筛选开启状态下抓首批
// 让 page 自身 reload 等价于 F5（chrome.tabs.reload 实测在某些场景不灵）
async function refreshBossPage() {
  // 找 BOSS tab
  if (!lastBossTabId) {
    const tabs = await new Promise(function (r) {
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
    });
    const target = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
    if (target) lastBossTabId = target.id;
  }
  if (!lastBossTabId) {
    console.warn('[BOSS-Sniffer] refreshBossPage: 没有打开的 BOSS tab');
    return false;
  }
  console.info('[BOSS-Sniffer] 让 BOSS tab=' + lastBossTabId + ' 自己 location.reload()');
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(lastBossTabId, { type: 'REFRESH_RECOMMEND_PAGE' }, function (resp) {
      if (chrome.runtime.lastError) {
        console.warn('[BOSS-Sniffer] refreshBossPage err:', chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(!!(resp && resp.ok));
    });
  });
}

// v0.16.0：触发 BOSS iframe 内「最新」tab 的程序化点击
// reload 后 BOSS 默认落推荐 tab；要跑最新就得在 reload+inject ready 之后再点一次「最新」
async function clickLatestTab(tabId) {
  if (!tabId) {
    const tabs = await new Promise(function (r) {
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
    });
    const target = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
    if (target) tabId = target.id;
  }
  if (!tabId) throw new Error('clickLatestTab: 没有打开的 BOSS tab');
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, { type: 'CLICK_LATEST_TAB' }, function (resp) {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      if (resp && resp.ok) { resolve(resp); return; }
      reject(new Error((resp && resp.error) || 'clickLatestTab: unknown error'));
    });
  });
}

// S6 fix: sidepanel 5 秒后调用，用于判断 reload 是否生效
async function checkRecentCandidatePoolEvents() {
  if (!self.BossEvents) return 0;
  const recent = await self.BossEvents.getRecentEvents(50);
  const tenSecAgo = Date.now() - 10000;
  return recent.filter(function (e) {
    return e.ts > tenSecAgo && e.stage === 'candidate_pool';
  }).length;
}

// scheduler 自然终止（达 N 或 K）时仅停止本轮自动化。
if (self.BossScheduler && typeof self.BossScheduler.setOnStopped === 'function') {
  self.BossScheduler.setOnStopped(function (reason) {
    screeningEnabled = false;
    currentTab = null;
    reconcileSayHiConsumer();
    console.info('[BOSS-Sniffer] scheduler 自然终止 (' + reason + ')，screening 已关');
  });
}

// S6: 给 scheduler 装真 scrollFn —— 通过 lastBossTabId 发 SCROLL_RECOMMEND_LIST
if (self.BossScheduler && typeof self.BossScheduler.setScrollFn === 'function') {
  self.BossScheduler.setScrollFn(async function () {
    if (!lastBossTabId) {
      // 兜底：找一个活动的 zhipin tab
      const tabs = await new Promise(function (r) {
        chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
      });
      const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
      if (active) lastBossTabId = active.id;
    }
    if (!lastBossTabId) {
      throw new Error('scrollFn: 没有可用的 BOSS tab');
    }
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(lastBossTabId, { type: 'SCROLL_RECOMMEND_LIST' }, function (resp) {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[BOSS-Sniffer] scrollFn sendMessage err:', err.message);
          reject(new Error(err.message));
          return;
        }
        // 诊断日志：HR 看不到 BOSS page console（反调试），SW console 能看到
        console.info('[BOSS-Sniffer] scrollFn 返回:', JSON.stringify(resp));
        resolve(resp);
      });
    });
  });
  console.info('[BOSS-Sniffer] scheduler scrollFn 已接 chrome.tabs.sendMessage');
}

// 配置变更 → 联动消费器
function reconcileSayHiConsumer() {
  const on = isAutomationActive() && appConfig.sayHi && appConfig.sayHi.enabled;
  if (on) {
    self.BossSayHi.startConsumer();
  } else {
    self.BossSayHi.stopConsumer();
  }
}

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(function (err) {
      console.error('[BOSS-Sniffer] setPanelBehavior failed:', err);
    });
}

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'CAPTURE':
      // v0.12.10：WS 业务消息（沟通页新招呼）绕开 screeningEnabled，HR 一进沟通页就抓
      // v0.15.0：HTTP 类（fetch/xhr）只在 LOOP 跑中入库（screeningEnabled 跟 LOOP 生命周期绑死）
      if (msg.payload && (msg.payload.via === 'ws' || screeningEnabled)) {
        // v0.16.0：当 currentTab 已定（LOOP 跑中），只接当前 tab 对应的 list 接口；
        // 防推荐 tab 残余 fetch 污染最新 tab 评估，反之亦然。其他路径不过滤。
        if (msg.payload.via !== 'ws' && currentTab) {
          const _path = String(msg.payload.url || '').split('?')[0];
          if (_path.indexOf('/rec/geek/list') !== -1 && currentTab !== 'recommend') {
            console.debug('[BOSS-Sniffer CAPTURE] 丢弃非当前 tab 接口', _path, 'currentTab=', currentTab);
            return false;
          }
          if (_path.indexOf('/zprelation/interaction/bossGetGeek') !== -1 && currentTab !== 'latest') {
            console.debug('[BOSS-Sniffer CAPTURE] 丢弃非当前 tab 接口', _path, 'currentTab=', currentTab);
            return false;
          }
        }
        const tabId = sender && sender.tab && sender.tab.id;
        saveCapture(msg.payload, tabId).catch(function (err) {
          console.error('[BOSS-Sniffer] save failed:', err);
        });
      }
      return false;

    case 'INJECT_READY':
      console.debug('[BOSS-Sniffer] inject ready @', msg.url);
      return false;

    case 'DETAIL_PANEL_SCAN': {
      // v0.17.0.10 POC A7 回灌：沟通页详情面板 DOM 扫描结果
      // 路径：inject 监听 chat/geek/info 响应 → 500ms 后扫详情面板 → 通过 content 转发到此
      // 只在 candidateId 已经在 sayhi_pool 里时 merge（不创建新记录）
      try {
        if (msg.candidateId && msg.payload &&
            self.BossExtractor &&
            typeof self.BossExtractor.extractFromDetailPanel === 'function') {
          const domDetail = self.BossExtractor.extractFromDetailPanel(msg.payload);
          if (domDetail) {
            mergeDomDetailIntoSayhiPool(msg.candidateId, domDetail)
              .then(function (merged) {
                if (self.BossDiag) {
                  self.BossDiag.log(merged ? 'info' : 'warn', 'sayhi.detail_panel_scan',
                    merged ? 'DOM 详情面板扫描已 merge 到 sayhi_pool' : 'DOM 扫描成功但 sayhi_pool 没这人(可能不在当前 LOOP)',
                    {
                      candidateId: msg.candidateId,
                      merged: merged,
                      fields: {
                        hasExpect: !!(domDetail.expect && domDetail.expect.cityRaw),
                        cityRaw: domDetail.expect && domDetail.expect.cityRaw || null,
                        hasDesc: !!domDetail.desc,
                        hasWorkEdu: !!domDetail.workEduText,
                        skillTagsCount: (domDetail.skillTags || []).length
                      }
                    });
                }
              })
              .catch(function (e) {
                console.warn('[BOSS-Sniffer DETAIL_PANEL_SCAN] merge failed:', e);
              });
          }
        }
      } catch (e) {
        console.warn('[BOSS-Sniffer DETAIL_PANEL_SCAN] handler error:', e);
      }
      return false;
    }

    case 'STATS':
      sendResponse({ enabled: screeningEnabled, screeningEnabled: screeningEnabled, stats: inMemoryStats });
      return false;

    case 'GET_ENABLED':
      sendResponse({ enabled: screeningEnabled, screeningEnabled: screeningEnabled });
      return false;

    case 'EXPORT':
      exportAll().then(function (records) {
        sendResponse({ records: records });
      });
      return true;

    case 'CLEAR':
      clearAll().then(function () { sendResponse({ ok: true }); });
      return true;

    case 'GET_EVALUATIONS':
      (async function () {
        const records = await getEvaluations();
        // S4b：从 BossJD 取当前 JD 名而不是硬编码
        const jd = await getCurrentJdTemplate().catch(function () { return null; });
        // v0.12.4: sidepanel「按本轮过滤」开关需要 loopStartedAt
        const loopState = (self.BossScheduler && typeof self.BossScheduler.getState === 'function')
          ? self.BossScheduler.getState()
          : null;
        sendResponse({
          records: records,
          jdTitle: (jd && jd.name) || null,
          jdId: (jd && jd.jdId) || '',
          modelId: (getCurrentLlmConfig() && getCurrentLlmConfig().model) || '',
          llmConfigured: isCurrentLlmConfigured(),
          loopStartedAt: (loopState && loopState.loopStartedAt) || 0,
          loopStatus: (loopState && loopState.status) || 'IDLE'
        });
      })();
      return true;

    case 'CLEAR_EVALUATIONS':
      clearEvaluations().then(function () { sendResponse({ ok: true }); });
      return true;

    case 'RETRY_EVALUATION':
      retryEvaluation(msg.candidateId).then(function (r) { sendResponse(r); });
      return true;

    case 'EXPORT_DIAG_BUNDLE':
      buildDiagBundle().then(function (bundle) { sendResponse({ ok: true, bundle: bundle }); })
                       .catch(function (err) { sendResponse({ ok: false, error: err && err.message }); });
      return true;

    // v0.22.5 · Phase 3·3c 前置：HR 在 IDB schema 升级前可选导出全库 JSON
    case 'EXPORT_IDB_BUNDLE':
      buildIdbBackupBundle().then(function (bundle) { sendResponse({ ok: true, bundle: bundle }); })
                            .catch(function (err) { sendResponse({ ok: false, error: err && err.message }); });
      return true;

    // ===== v0.13.0 沟通页「新招呼」=====
    case 'SCAN_SAYHI_TAB':
      (async function () {
        const r = await scanSayhiTabOnce();
        if (!r.ok) {
          sendResponse({ ok: false, error: r.error, scanned: 0, upserted: 0, stats: r.stats, tabUrl: r.tabUrl });
          return;
        }
        if (!r.candidates.length) {
          // v0.13.2：扫到 0 时附诊断信息
          const domTotal = (r.stats && r.stats.domTotal) || 0;
          let hint;
          if (domTotal === 0) {
            hint = '页面没有 .geek-item 卡片（请确认在沟通页 /web/chat/index 且列表已加载，URL=' + (r.tabUrl || '?') + '）';
          } else {
            hint = '页面有 ' + domTotal + ' 张 .geek-item 但 Vue 提取全部失败（可能 BOSS 前端结构变了，或同 BOSS tab 多扩展冲突）';
          }
          sendResponse({ ok: true, scanned: 0, upserted: 0, message: hint, stats: r.stats, tabUrl: r.tabUrl });
          return;
        }
        if (!self.BossExtractor || typeof self.BossExtractor.extractFromGeekItems !== 'function') {
          sendResponse({ ok: false, error: 'extractor 未加载', scanned: r.candidates.length, upserted: 0 });
          return;
        }
        const extracted = self.BossExtractor.extractFromGeekItems(r.candidates);
        const n = await upsertSayhiCandidates(extracted);
        sendResponse({ ok: true, scanned: r.candidates.length, upserted: n, stats: r.stats });
      })();
      return true;

    case 'GET_SAYHI_POOL':
      (async function () {
        // v0.24.4：删 sweepExpiredDismissals 调用 + dismissedQueue 字段（30s 撤销窗口设计回退）
        const pool = await getSayhiPool();
        const allEvals = await getEvaluations();
        const evalMap = {};
        for (let i = 0; i < allEvals.length; i++) evalMap[allEvals[i].candidateId] = allEvals[i];
        const jd = await getCurrentJdTemplate().catch(function () { return null; });

        // v0.22.2 · Phase 2·2c：把 autoAction 配置带给 sidepanel，让两个 checkbox 显示真实状态
        // v0.25.1：删 jdBossJobNames 字段（沟通页路由改用 JD.name 严格相等）
        // v0.22.3 · Phase 2·2d：sayhiBatch 阈值（K/N）一起回带，sidepanel 渲染 input value
        sendResponse({
          ok: true,
          pool: pool,
          evaluationsByCandidateId: evalMap,
          evalStatus: getSayhiEvalStatus(),
          jdTitle: (jd && jd.name) || null,
          jdId: (jd && jd.jdId) || '',
          autoAction: {
            enabledBatchEval: !!(appConfig.autoAction && appConfig.autoAction.enabledBatchEval),
            autoMarkUnsuitable: !!(appConfig.autoAction && appConfig.autoAction.autoMarkUnsuitable),
            dryRun: !!(appConfig.autoAction && appConfig.autoAction.dryRun)
          },
          sayhiBatch: {
            // v0.25.0：删招呼数 cap 字段
            maxBrowseK: (appConfig.sayhiBatch && appConfig.sayhiBatch.maxBrowseK) || null
          },
          llmConfigured: isCurrentLlmConfigured()
        });
      })();
      return true;

    // v0.24.4：删 CANCEL_DISMISSED_CANDIDATE handler（30s 撤销窗口设计回退）

    // v0.24.7：chrome.debugger 真点击 — inject.js 找到按钮 + 取坐标 后调
    case 'REAL_CLICK_AT_COORDS':
      (async function () {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'no-tab-id（sender.tab 缺失，可能消息来源不是 content.js）' });
          return;
        }
        const x = parseInt(msg.x, 10);
        const y = parseInt(msg.y, 10);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
          sendResponse({ ok: false, error: 'invalid-coords: x=' + msg.x + ' y=' + msg.y });
          return;
        }
        const r = await realClickAtCoords(tabId, x, y);
        if (self.BossDiag) {
          self.BossDiag.log(r.ok ? 'info' : 'warn', 'sayhi.real_click_' + (r.ok ? 'done' : 'fail'),
            'chrome.debugger 真点击 ' + (r.ok ? '成功' : '失败'),
            { x: x, y: y, error: r.error });
        }
        sendResponse(r);
      })();
      return true;

    case 'EVAL_SAYHI_BATCH':
      evalSayhiBatch().then(function (r) { sendResponse(r); });
      return true;

    // v0.13.3：单人评估（卡片上的 ⚡ 评估 按钮）
    case 'EVAL_SAYHI_SINGLE':
      evalSayhiSingle(msg.candidateId).then(function (r) { sendResponse(r); });
      return true;

    case 'STOP_SAYHI_EVAL':
      sendResponse(abortSayhiEval());
      return false;

    case 'CLEAR_SAYHI_POOL':
      clearSayhiPool().then(function () { sendResponse({ ok: true }); });
      return true;

    // v0.14.0-pre：沟通页一键操作（求简历 / 标不合适）
    case 'EXECUTE_SAYHI_ACTION':
      executeSayhiActionForCandidate(msg.candidateId).then(function (r) { sendResponse(r); });
      return true;

    // v0.17.1.0：评估「符合」→ 输入话术 + 求简历（直接驱动接口，让 sidepanel 测试入口能手动触发）
    // 真自动化路径走 evalSayhiCore 内部，这个 case 给 admin/sidepanel "试执行" 按钮用
    case 'EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE':
      (async function () {
        if (sayhiEvalRun && sayhiEvalRun.running) {
          sendResponse({ ok: false, error: '评估循环进行中，请等完成再手动操作' });
          return;
        }
        const greet = await getCurrentGreetTemplate();
        if (!greet || !greet.text) {
          sendResponse({ ok: false, error: '未选中话术模板' });
          return;
        }
        const r = await triggerGreetThenResume(msg.candidateId, greet.text, !!msg.dryRun);
        await recordSayhiActionResult(msg.candidateId, 'greet-then-resume', r.result);
        sendResponse(r);
      })();
      return true;

    // v0.12.5：sidepanel 点候选人名字 → 让 BOSS 页面滚到对应卡片并高亮
    case 'LOCATE_CANDIDATE': {
      let tabId = lastBossTabId;
      const fallback = function () {
        chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
          const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
          if (!active) { sendResponse({ ok: false, error: '没有打开的 zhipin.com 标签' }); return; }
          lastBossTabId = active.id;
          chrome.tabs.sendMessage(active.id, {
            type: 'SCROLL_TO_CANDIDATE',
            candidateId: msg.candidateId,
            encryptUid: msg.encryptUid
          }, function (resp) {
            if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
            sendResponse(resp || { ok: false, error: '无响应' });
          });
        });
      };
      if (!tabId) { fallback(); return true; }
      chrome.tabs.sendMessage(tabId, {
        type: 'SCROLL_TO_CANDIDATE',
        candidateId: msg.candidateId,
        encryptUid: msg.encryptUid
      }, function (resp) {
        // tab 没了 / content script 没注入 → fallback 再找一个
        if (chrome.runtime.lastError) { fallback(); return; }
        sendResponse(resp || { ok: false, error: '无响应' });
      });
      return true;
    }

    // ----- M2 配置接口 -----
    case 'GET_CONFIG':
      sendResponse({ config: appConfig, enabled: screeningEnabled, screeningEnabled: screeningEnabled });
      return false;

    case 'SET_CONFIG_SECTION':
      saveConfigSection(msg.section, msg.patch).then(function () {
        if (msg.section === 'sayHi') reconcileSayHiConsumer();
        sendResponse({ ok: true, config: appConfig });
      });
      return true;

    // ----- M3 sayHi 接口 -----
    case 'GET_SAYHI_STATUS':
      sendResponse({
        status: self.BossSayHi.getStatus(),
        lastBossTabId: lastBossTabId,
        sayHiConfig: appConfig.sayHi
      });
      return false;

    case 'FIND_BOSS_TAB':
      // 主动找一个活动的 zhipin tab，并把 lastBossTabId 设上
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: '没有打开的 zhipin.com 标签' });
          return;
        }
        // 优先 active tab
        const active = tabs.find(function (t) { return t.active; }) || tabs[0];
        lastBossTabId = active.id;
        sendResponse({ ok: true, tabId: active.id, url: active.url });
      });
      return true;

    case 'TEST_DEBUGGER_ATTACH':
      (async function () {
        try {
          let tabId = msg.tabId || lastBossTabId;
          if (!tabId) {
            // 兜底：自动找一个
            const tabs = await new Promise(function (r) {
              chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
            });
            const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
            if (active) { tabId = active.id; lastBossTabId = active.id; }
          }
          if (!tabId) {
            sendResponse({ ok: false, error: '没有可用的 BOSS tab — 请先打开 zhipin.com' });
            return;
          }
          const r = await self.BossSayHi.testDebuggerAttach(tabId);
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message });
        }
      })();
      return true;

    case 'TEST_SAYHI':
      (async function () {
        try {
          let tabId = msg.tabId || lastBossTabId;
          if (!tabId) {
            sendResponse({ ok: false, error: '没有 BOSS tab — 请先在 zhipin.com 推荐页停留' });
            return;
          }
          if (!msg.candidateId) {
            sendResponse({ ok: false, error: '缺 candidateId' });
            return;
          }
          // 从 IndexedDB 评估记录拿 encryptUid（BOSS DOM 里更可能存的是加密版）
          const encryptUid = await getEncryptUid(msg.candidateId);
          const r = await self.BossSayHi.testSayHi(tabId, msg.candidateId, encryptUid);
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message, hint: e.hint });
        }
      })();
      return true;

    case 'TEST_DIAGNOSE_DOM':
      (async function () {
        try {
          let tabId = msg.tabId || lastBossTabId;
          if (!tabId) {
            const tabs = await new Promise(function (r) {
              chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
            });
            const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
            if (active) { tabId = active.id; lastBossTabId = active.id; }
          }
          if (!tabId) {
            sendResponse({ ok: false, error: '没有 BOSS tab' });
            return;
          }
          const encryptUid = msg.candidateId ? await getEncryptUid(msg.candidateId) : '';
          const r = await self.BossSayHi.testDiagnose(tabId, msg.candidateId, encryptUid);
          sendResponse({ ok: true, diagnosis: r, encryptUid: encryptUid });
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message });
        }
      })();
      return true;

    case 'DEQUEUE_SAYHI':
      self.BossSayHi.dequeue(msg.candidateId).then(function () {
        sendResponse({ ok: true });
      });
      return true;

    case 'TEST_LLM_CONFIG':
      (async function () {
        try {
          const r = await self.BossLLM.testLlmConnection(msg.llm || {});
          sendResponse({ ok: true, text: r.text, usage: r.usage });
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message });
        }
      })();
      return true;

    // ----- S6 LOOP 接口 -----
    case 'START_LOOP':
      (async function () {
        try {
          // v0.15.0：招呼数 / 浏览数 至少一个必填（否则 LOOP 无终止条件）
          const hasN = typeof msg.goalN === 'number' && msg.goalN >= 1;
          const hasK = typeof msg.goalK === 'number' && msg.goalK >= 1;
          if (!hasN && !hasK) {
            sendResponse({ ok: false, error: '招呼数或浏览数至少填写一个' });
            return;
          }
          const tab = msg.tab === 'latest' ? 'latest' : 'recommend';
          // 校验：JD 已选
          const jd = await getCurrentJdTemplate().catch(function () { return null; });
          if (!jd || !jd.jdId) {
            sendResponse({ ok: false, error: '请先在侧边栏选择当前 JD' });
            return;
          }
          // 校验：LLM 已配
          if (!isCurrentLlmConfigured()) {
            sendResponse({ ok: false, error: '请先在 admin 配置 LLM API Key' });
            return;
          }
          // v0.15.0：screeningEnabled 跟 LOOP 生命周期绑死，无条件开
          screeningEnabled = true;
          currentTab = tab;
          self.BossScheduler.start({ goalN: msg.goalN, goalK: msg.goalK });
          reconcileSayHiConsumer();
          sendResponse({ ok: true });

          // v0.12.4: 新一轮开始前清空 evaluations，让 sidepanel 评估卡只显示本轮候选人
          // events store 不动（看板漏斗 + sayhi_sent 历史保留）
          await clearEvaluations();

          // 异步：触发 BOSS 页 reload（page 自身 location.reload，等价 F5）
          // 然后等 ~2.5s 让 inject + content 重注入、首批 fetch 抓到，再启动 tick
          await refreshBossPage();
          await new Promise(function (r) { setTimeout(r, 2500); });
          // v0.16.0：跑最新 tab 时，reload 后 BOSS 默认落推荐，需要主动 click 切到最新
          if (currentTab === 'latest') {
            try {
              await clickLatestTab(lastBossTabId);
              console.info('[BOSS-Sniffer START_LOOP] 已切到最新 tab，等 BOSS fire /bossGetGeek');
              await new Promise(function (r) { setTimeout(r, 1500); });  // 给 BOSS fire 接口 + capture 入库的时间
            } catch (e) {
              console.warn('[BOSS-Sniffer START_LOOP] 切换最新 tab 失败:', e && e.message);
              // 不中断 LOOP，scheduler 第一轮等 8s pending 没出来会进 PAUSED 给 HR 提示
            }
          }
          if (typeof self.BossScheduler.runTick === 'function') {
            self.BossScheduler.runTick();
          }
        } catch (e) {
          console.error('[BOSS-Sniffer START_LOOP] 异步段失败:', e);
        }
      })();
      return true;

    case 'STOP_LOOP':
      try {
        self.BossScheduler.stop();
        screeningEnabled = false;
        currentTab = null;
        // v0.15.0：清掉"评估中"卡片让侧栏立即干净；in-flight LLM 完成后会被 worker 内的
        // screeningEnabled 检查拦下，不会再写回
        clearPendingEvaluations().catch(function (e) {
          console.warn('[BOSS-Sniffer STOP_LOOP] clearPendingEvaluations 失败:', e);
        });
        reconcileSayHiConsumer();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.name + ': ' + e.message });
      }
      return false;

    case 'RESUME_LOOP':
      try {
        self.BossScheduler.resume();
        reconcileSayHiConsumer();
        if (typeof self.BossScheduler.runTick === 'function') {
          self.BossScheduler.runTick();
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.name + ': ' + e.message });
      }
      return false;

    case 'GET_LOOP_STATE':
      sendResponse({ state: self.BossScheduler.getState() });
      return false;

    case 'CHECK_RECENT_EVENTS':
      // S6 fix: sidepanel 启动 reload 后 5 秒调用，判断是否抓到首批
      checkRecentCandidatePoolEvents().then(function (count) {
        sendResponse({ recentCount: count });
      });
      return true;

    default:
      return false;
  }
});

// v0.20.8：删除 v0.12.4 的 onUpdated 自动清 evaluations 监听器。
// 原 v0.12.4 设计：HR 在 BOSS 网页切推荐 ↔ 沟通 tab 时自动清 evaluations，假设 HR 切走 = 旧数据过期。
// 实际 HR 反馈：切沟通页处理新招呼后回推荐页，希望保留刚才筛选的候选人池（"猎豹"）继续看。
// 新口径：evaluations 表只在 HR 主动点 [开始本轮] 时清（background.js:2412 START_LOOP 内），
// 或开发用 admin「危险操作」清表。HR 操作具备完全可预期性。

const CLEANUP_INTERVAL_MINUTES = 6 * 60;
chrome.alarms.get('captures-cleanup', function (existing) {
  if (!existing) chrome.alarms.create('captures-cleanup', { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
});

// observability v1: pending 守护 alarm
// SW 重启 + LLM 请求中断会留下"评估中"状态永远停在那里。每 30s 扫一次,
// 超过 PENDING_STALE_MS 仍 pending 的转 failed,避免僵尸条目。
// 用 alarms.get → create 幂等(规约 §四 v0.17 教训:alarms.create 非幂等)。
const PENDING_WATCHDOG_PERIOD_MIN = 0.5;   // 30s 一扫
const PENDING_STALE_MS = 5 * 60 * 1000;    // 超 5 分钟 pending 视为僵尸
chrome.alarms.get('pending-watchdog', function (existing) {
  if (!existing) chrome.alarms.create('pending-watchdog', { periodInMinutes: PENDING_WATCHDOG_PERIOD_MIN });
});

// v0.24.4：删 v0.23.0 dismissed-sweep / dismissed-cleanup 两个 alarm 注册（30s 撤销窗口设计回退）
//   主动清理 v0.23.0 已注册的 alarms（HR 升级 v0.24.4 后避免老 alarm 继续 fire 没人处理）
chrome.alarms.clear('dismissed-sweep');
chrome.alarms.clear('dismissed-cleanup');

async function sweepStalePending() {
  try {
    const all = await getEvaluations();
    const now = Date.now();
    // v0.20.9：queued 超 5min 也算僵尸（LLM 队列堵 5min 不正常，肯定卡了）
    const stale = all.filter(function (r) {
      const e = r && r.evaluation;
      if (!e) return false;
      if (e.status === 'pending' && e.startedAt && (now - e.startedAt) > PENDING_STALE_MS) return true;
      if (e.status === 'queued' && e.queuedAt && (now - e.queuedAt) > PENDING_STALE_MS) return true;
      return false;
    });
    if (!stale.length) return 0;
    for (const r of stale) {
      // v0.20.9：queued 用 queuedAt，pending 用 startedAt
      const sinceTs = r.evaluation.startedAt || r.evaluation.queuedAt;
      const elapsed = now - sinceTs;
      const wasQueued = r.evaluation.status === 'queued';
      const evaluation = {
        status: 'failed',
        error: 'AutoTimeout: ' + (wasQueued ? 'queued' : 'pending') + ' 超 ' + Math.round(elapsed / 1000) + 's,SW 可能中途重启',
        judgedAt: now,
        latencyMs: elapsed,
        attempts: 0,
        perAttempt: [],
        jdTitle: r.evaluation.jdTitle || '?',
        jdId: r.evaluation.jdId || ''
      };
      await upsertEvaluation(Object.assign({}, r, { evaluation: evaluation }));
    }
    if (self.BossDiag) {
      self.BossDiag.log('warn', 'watchdog.pending', 'pending 守护清扫', { swept: stale.length });
    }
    return stale.length;
  } catch (e) {
    if (self.BossDiag) self.BossDiag.log('error', 'watchdog.pending', '清扫失败', { error: e && e.message });
    return 0;
  }
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'captures-cleanup') {
    self.BossCapturesCleaner.cleanExpiredCaptures().catch(function () {});
  } else if (alarm.name === 'pending-watchdog') {
    sweepStalePending().catch(function () {});
  }
  // v0.24.4：删 dismissed-sweep / dismissed-cleanup alarm 分支（30s 撤销窗口设计回退）
});
