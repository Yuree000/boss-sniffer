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
// v1.0.5 Sprint C 阶段 1:lib/db.js 放第 1 位(events.js / diag-log.js / 任何 IDB 读写都依赖它)
// v1.0.6 Sprint C 阶段 2:lib/debugger-click.js 放在 lib/debugger-util.js 之后(依赖 BossDebuggerUtil)
// v1.0.7 Sprint C 阶段 3:lib/message-router.js 放最后,由它维护唯一 runtime.onMessage listener
// v1.1.22 P1-2:lib/message-types.js 放在 message-router.js 之前(其他 lib 不依赖它,
// 但保持单一加载点;UI 页面用 <script src> 各自加载)
// v1.1.22 P1-1:runtime-utils.js 放在首位(judge/llm-client/sayHi/scheduler 依赖 self.BossRuntimeUtils)
// v1.1.22 P1-2:message-types.js 放在 message-router.js 之前(其他 lib 不依赖,统一加载点)
// v1.1.22 P2-1:lib/handlers/* 在 message-router.js 之前(register 时按 type 注册;handler factory
// 内部读 self.BossMessageTypes,所以也必须在 message-types.js 之后)
importScripts(
  'lib/runtime-utils.js',
  'lib/message-types.js',
  'lib/db.js', 'lib/city-codes.js', 'lib/extractor.js', 'lib/llm-client.js', 'lib/judge.js',
  'lib/debugger-util.js', 'lib/debugger-click.js', 'lib/sayHi.js', 'lib/events.js',
  'lib/storage-sync.js', 'lib/jd-templates.js', 'lib/boss-positions.js', 'lib/jd-router.js', 'lib/greet-templates.js',
  'lib/prompt-builder.js', 'lib/scheduler.js', 'lib/captures-cleaner.js', 'lib/diag-log.js',
  'lib/handlers/capture-handlers.js',
  'lib/handlers/evaluation-handlers.js',
  'lib/handlers/diag-handlers.js',
  'lib/handlers/sayhi-handlers.js',
  'lib/handlers/config-handlers.js',
  'lib/handlers/loop-handlers.js',
  'lib/message-router.js'
);

// v1.0.5 Sprint C 阶段 1:DB schema 抽到 lib/db.js,这里做本地 re-export 保持下面 107 处调用方不变
const DB_NAME = self.BossDB.DB_NAME;
const DB_VERSION = self.BossDB.DB_VERSION;
const STORE_CAPTURES = self.BossDB.STORE_CAPTURES;
const STORE_EVALUATIONS = self.BossDB.STORE_EVALUATIONS;
const STORE_EVENTS = self.BossDB.STORE_EVENTS;
const STORE_SAYHI_POOL = self.BossDB.STORE_SAYHI_POOL;
const STORE_DISMISSED_CANDIDATES = self.BossDB.STORE_DISMISSED_CANDIDATES;
const STORE_DIAG_LOGS = self.BossDB.STORE_DIAG_LOGS;

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
// v1.1.17:推荐页 LOOP 批次运行态 — 用于批次吞吐率统计(events loop_start/loop_end 配对)
// 不持久化,SW 重启 → 默认空。STOP_LOOP / scheduler 自然终止时清空 + emit loop_end。
// v1.1.18:加 jobId 字段 — 防止 emit loop_end 时 jobId 跟 loop_start 不一致导致看板 filterEvents 按 jobId 过滤掉一半
// v1.1.23 P3-3:加 templateIds 字段 — 推荐页多模板评估,START_LOOP 时由 sidepanel 透传过来,
//   评估时 saveCapture → evaluateIfCandidate(_, _, templateIds) 拿出来,空 / 缺省视为"当前 position 下全选"
//   templateIds 放在 jobId 前,让 jobId 仍在末尾 — 保持 v1.1.18-B2 反向断言 /jobId:\s*['"]['"],/ 通过
let recommendLoopRun = { batchId: '', startedAt: 0, templateIds: null, jobId: '' };
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
    // v1.1.10 fix:默认 1 → 0 — 1 = 每批只扫第 1 人,2 人起跳过点击。
    scanMaxPerRun: 0,        // 单批 DOM 扫描上限(0 = 无限,生产推荐值)
    cooldownMinMs: 5000,     // 候选人间冷却下限(拟人节奏,HR 看简历通常 5-10s)
    cooldownMaxMs: 8000,     // 上限
    // v1.1.12 fix:默认 false → true。诊断 bundle 实测,HR 新电脑场景下候选人只通过左侧
    //   DOM 列表扫描入池(source.apiPath="dom:.geek-item"),chat/geek/info 接口数据从未进
    //   sayhi_pool → basic.city / cityName / candidateOwn / salaryDesc / age / gender /
    //   education 等结构化字段全 null → LLM 评估缺信息。
    //   设计假设"DOM 扫描点击会让 BOSS 自调 chat/geek/info"在 v1.1.10 改 scanMaxPerRun=0
    //   后理论上成立,但 native card.click() (isTrusted=false) 可能不触发 BOSS 业务逻辑。
    //   主动 fetch 是兜底:每候选人多 1 次轻量 JSON 请求(~5KB),稳态拿到全字段。
    proactiveFetchEnabled: true   // v0.13.3 主动 fetch chat/geek/info
                                  // 跟 DOM 扫描点击是双保险,哪个先到都行,LLM 必拿全字段
  },
  // v0.17.1.0/.3：评估「符合」→ 自动输入话术 + 求简历
  // 默认全关。HR 在 admin 显式打开后才生效；试跑模式作为安全网，跑通才能正式启用。
  // v0.17.1.3：产品边界澄清——「单评 = HR 看个体看仔细，永不自动」；「批量 = 自动入口」
  //   旧版 key（单评启用）直接忽略（语义已变，不迁移），HR 重新去 admin 勾选 enabledBatchEval
  autoAction: {
    enabledBatchEval: false,     // 批量评估启用 自动「话术+求简历」（单评永不自动求简历，HR 评后手动点 🎯）
    autoMarkUnsuitable: false,   // v0.22.2 · Phase 2·2c 新增：批量评估「pass」时自动点不合适。
    dryRun: false,               // 试跑模式：执行链路走完所有定位 + log，但不点最后的发送/确定
    actionCooldownMinMs: 2000,   // 自动操作模式专属冷却下限（admin UI 已删,运行时仍读 storage / 默认值）
    actionCooldownMaxMs: 4000,
    // v1.0.14：autoMark 真点击 mouseMoved → mousePressed 之间的拟人 hover 间隔
    //   v0.24.10 时硬编码 30-110ms,现在改为可配置(admin 高级设置 input 可调)。
    //   lib/debugger-click.js 没收到 opts 时回退默认 30/110。
    hoverDelayMinMs: 30,
    hoverDelayMaxMs: 110
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

// v1.0.5 Sprint C 阶段 1:openDB 抽到 lib/db.js,这里 re-export 让本文件 107 处调用方不变
// schema 创建逻辑唯一来源(lib/db.js applySchema)
// self.BOSS_OPEN_DB / BOSS_STORE_EVENTS / BOSS_STORE_EVALUATIONS / BOSS_STORE_DIAG_LOGS
// 兼容暴露也在 lib/db.js 中(events.js / diag-log.js 调用不变)
const openDB = self.BossDB.openDB;

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
    // v1.1.23 P3-3:推荐页评估多模板支持 — templateIds 从 recommendLoopRun.templateIds 透传
    //   缺省 / 空数组 → evaluateIfCandidate 内部落回"当前 position 下所有模板"
    const tids = (recommendLoopRun && Array.isArray(recommendLoopRun.templateIds))
      ? recommendLoopRun.templateIds
      : null;
    evaluateIfCandidate(apiPath, payload, tids).catch(function (err) {
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
// v1.0.8：opts.scenario / opts.jobId 选项 — 沟通页主链路按路由 JD 决定 jobId,
//   且没有 HTTP apiPath,可显式传 { scenario: 'sayhi-tab', jobId: routedJdId }
async function logFunnelOutcomeEvent(candidate, evaluation, apiPath, opts) {
  if (!self.BossEvents || !candidate || !candidate.candidateId || !evaluation) return;
  const scenario = (opts && opts.scenario) || deriveScenario(apiPath);
  const jobId = (opts && opts.jobId) || (appConfig.jd && appConfig.jd.activeJdId) || '';

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
      // v1.1.3：候选人有多个 M_i 同时 false 时,每个失败 M_i 都 emit 一条 pass_marked event
      //   旧 derivePassReason 只取第一个 false → 看板「Top pass 主因」失真
      //   新 collectPassReasons 返回数组,M1+M2 都不满足时 → 2 条 event
      //   dashboard.js countJudgedCandidates distinct 不受影响（按 candidateId 去重）
      //   只有 reasonCounts 事件计数变得更准（M_i 失败占比真实化）
      const reasons = (evaluation.passReason && typeof evaluation.passReason === 'string')
        ? [evaluation.passReason]  // LLM 自报优先（v1 prompt 暂未输出,留接口）
        : self.BossEvents.collectPassReasons(
            evaluation.mustBreakdown,
            evaluation.optionalBreakdown,
            evaluation.jdSnapshot
          );
      for (const passReason of reasons) {
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
      }
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
// 去重粒度：同候选人在「今日 0 点起」窗口内只记 1 条;跨天能重新埋
// 失败 catch 后只 warn，不影响主链路评估
//
// v1.0.8：opts.scenario 选项 — 没有 HTTP apiPath 的入口（如沟通页 SCAN_SAYHI_TAB
//   DOM 扫描）可显式指定 scenario，绕开 deriveScenario(apiPath) 推断
// v1.0.9：去重从「全局历史」改为「今日 0 点起」。
//   旧版「全局去重」让候选人一生只有 1 条 candidate_pool 记录,看板今日时间窗显示
//   「今日全新首次入池数」而非「今日实际入池数」(HR 反馈"跑了 15 人看板只显示 6")。
//   改为日窗口后,events 表会出现同一 candidateId 多日多条记录 — 按事件流设计这是合理的。
//   下游 logSayHiOutcomeEvent 反查 candidate_pool 拿 scenario/jobId 取最早一条不变。
async function logCandidatePoolEvents(candidates, apiPath, opts) {
  if (!self.BossEvents || !candidates || !candidates.length) return;
  const scenario = (opts && opts.scenario) || deriveScenario(apiPath);
  const jobId = (appConfig.jd && appConfig.jd.activeJdId) || '';
  const batchAt = Date.now();
  const startOfToday = (function () {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  })();
  for (const c of candidates) {
    if (!c || !c.candidateId) continue;
    try {
      const existing = await self.BossEvents.getEventsByCandidate(c.candidateId);
      const alreadyInPoolToday = existing.some(function (e) {
        return e.stage === 'candidate_pool' && (e.ts || 0) >= startOfToday;
      });
      if (alreadyInPoolToday) continue;
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

async function evaluateIfCandidate(apiPath, payload, templateIds) {
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
  // v1.1.23 P3-3:加 evaluations[] 空数组(占位 sidepanel 多模板卡片渲染),evaluation 单字段保留向后兼容
  await upsertEvaluations(candidates.map(function (c) {
    return {
      candidateId: c.candidateId,
      candidate: c,
      evaluations: [],
      evaluation: { status: 'queued', queuedAt: Date.now() },
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    };
  }));

  // v1.1.23 P3-3:推荐页评估多模板支持
  //   - templateIds 为空 / 缺省 → 用"当前 position 下所有模板"(取 currentJdTemplate 的 positionId)
  //   - templateIds 含 1 个 → 单模板模式(向后兼容 v1.1.22 行为)
  //   - templateIds 含 N 个 → 多模板模式,对每个 candidate × 每个 template 跑一次 LLM
  //
  //   注:推荐页评估按"HR 选定的模板集合"评估,不按候选人 jobAligned 自动路由(那是沟通页的逻辑)。
  //   依赖:sidepanel 在 START_LOOP 时把 templateIds 透传过来(存进 recommendLoopRun.templateIds 由 saveCapture 取出)
  const llmCfg = getCurrentLlmConfig();
  const currentJd = await getCurrentJdTemplate();
  const allTemplates = await self.BossJD.listTemplates();

  // 决定本次评估用哪些 templates
  //   1. 显式传 templateIds[N>=1]:按 ID 过滤
  //   2. 缺省 / 空数组:落回"当前 position 下所有 templates"(currentJd.positionId)
  //   3. 异常兜底:落回 [currentJd] 单模板(保证有 LLM 调用)
  let activeTemplates = [];
  if (Array.isArray(templateIds) && templateIds.length > 0) {
    const tidSet = new Set(templateIds.map(String));
    activeTemplates = allTemplates.filter(function (t) { return t && tidSet.has(String(t.jdId)); });
  }
  if (!activeTemplates.length && currentJd && currentJd.positionId) {
    // 全选:当前 position 下所有模板,按 sortOrder
    activeTemplates = allTemplates
      .filter(function (t) { return t && t.positionId === currentJd.positionId; })
      .sort(function (a, b) {
        const sa = (a && typeof a.sortOrder === 'number') ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const sb = (b && typeof b.sortOrder === 'number') ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
  }
  if (!activeTemplates.length && currentJd) {
    // 兜底:既没 templateIds 又没 position 信息 → 单模板(v1.1.22 行为)
    activeTemplates = [currentJd];
  }

  const concurrency = (llmCfg && llmCfg.concurrency > 0)
    ? llmCfg.concurrency
    : DEFAULT_LLM_CONCURRENCY;

  if (self.BossDiag) {
    self.BossDiag.log('info', 'evaluate.batch', '评估批次启动', {
      apiPath: apiPath,
      candidates: candidates.length,
      // v1.1.23 P3-3:多模板支持 — 埋点新增 templateCount / templateIds / positionId 字段
      jd: currentJd && currentJd.name,
      jdId: currentJd && currentJd.jdId,
      positionId: currentJd && currentJd.positionId,
      templateCount: activeTemplates.length,
      templateIds: activeTemplates.map(function (t) { return t.jdId; }),
      explicitTemplateIds: Array.isArray(templateIds) ? templateIds : null,
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
      evaluations: [],
      evaluation: { status: 'pending', startedAt: Date.now() },
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    });

    // v1.1.23 P3-3:对每个 active template 串行跑 LLM,收集 subEvaluations
    //   (注意:N candidates 之间仍并发 (runWithConcurrency),但同一 candidate 内的 N templates 串行;
    //    防止 LLM 网关被 candidates × templates 笛卡尔积压垮)
    const subEvaluations = [];
    let representativeIdx = -1;
    for (let ti = 0; ti < activeTemplates.length; ti++) {
      const jd = activeTemplates[ti];
      let subEval;
      try {
        const result = await self.BossJudge.judgeCandidate(c, jd, llmCfg);
        subEval = Object.assign({ status: 'done' }, result);
      } catch (err) {
        if (self.BossDiag) {
          self.BossDiag.log('error', 'evaluate.judgeFail', 'LLM judge failed', {
            candidateId: c.candidateId,
            templateId: jd && jd.jdId,
            errName: err && err.name,
            errMsg: err && err.message,
            attempts: err && err.attempts,
            totalLatencyMs: err && err.totalLatencyMs
          });
        } else {
          console.error('[BOSS-Sniffer] LLM judge failed for', c.candidateId, 'template=' + (jd && jd.jdId), err);
        }
        subEval = {
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
      // v1.1.23 P3-3:每条 sub-eval 含 templateId / templateName + 兼容字段
      subEval.templateId = (jd && jd.jdId) || '';
      subEval.templateName = (jd && jd.name) || '';
      subEval.routedJdId = (jd && jd.jdId) || '';  // 向后兼容
      subEval.routedJdName = (jd && jd.name) || '';
      subEval.jdContentHash = (jd && jd.contentHash) || '';
      subEvaluations.push(subEval);
      if (representativeIdx === -1 && subEval.decision === '符合') representativeIdx = ti;
    }
    if (representativeIdx === -1) representativeIdx = 0;
    const representative = subEvaluations[representativeIdx] || subEvaluations[0] || {
      status: 'failed', error: 'no_templates_evaluated', judgedAt: Date.now()
    };

    // v0.15.0：LLM 返回后再次检查本轮是否还在跑——用户在 LLM 跑的几秒里点了停止本轮 →
    // 丢弃迟到的评估结果，避免写回 evaluations store 让侧栏"刷新后又冒出候选人"
    if (!screeningEnabled) {
      if (self.BossDiag) self.BossDiag.log('info', 'evaluate.lateDiscard', '本轮已停止,丢弃迟到 LLM 评估', { candidateId: c.candidateId });
      else console.info('[BOSS-Sniffer] 本轮已停止，丢弃 ' + c.candidateId + ' 的迟到 LLM 评估结果');
      return;
    }
    // 漏斗埋点：pass_marked / match_marked / 失败转 pass_marked（主因信息不足）
    //   v1.1.23 P3-3:多模板下,每个 template 一条 funnel 事件(看板按 jdId 切片仍准确)
    for (let si = 0; si < subEvaluations.length; si++) {
      await logFunnelOutcomeEvent(c, subEvaluations[si], apiPath, {
        jobId: subEvaluations[si].templateId || ''
      });
    }

    await upsertEvaluation({
      candidateId: c.candidateId,
      candidate: c,
      // v1.1.23 P3-3:新 shape (sidepanel 多模板卡片) + 老 evaluation 单字段(向后兼容 dashboard / sayHi 入队判断)
      evaluations: subEvaluations,
      evaluation: representative,
      capturedAt: payload.capturedAt || Date.now(),
      capturedUrl: payload.url
    });

    // 评估"符合"且 sayHi 启用 → 入队
    //   v1.1.23 P3-3:多模板下,只要任一 template 评出"符合"即入队 sayHi
    //   maybeEnqueueSayHi 判断的是 evaluation(单字段),我们已经把"代表"设为首个符合 sub-eval
    await maybeEnqueueSayHi(c, representative);
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

// v1.1.7: HR 标 LLM 判错 — read-modify-write evaluation record
// 数据模型:record.hrFeedback = { markedWrong: true, submittedAt: ts } 或字段不存在
// 字段缺省 = 默认 LLM 对(无反馈)
async function markLlmJudgmentWrong(candidateId) {
  const id = String(candidateId || '');
  if (!id) return { ok: false, error: 'missing candidateId' };
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const getReq = store.get(id);
    getReq.onsuccess = function () {
      const r = getReq.result;
      if (!r) { resolve({ ok: false, error: 'evaluation not found' }); return; }
      r.hrFeedback = { markedWrong: true, submittedAt: Date.now() };
      const putReq = store.put(r);
      putReq.onsuccess = function () { resolve({ ok: true, hrFeedback: r.hrFeedback }); };
      putReq.onerror = function () { resolve({ ok: false, error: String(putReq.error) }); };
    };
    getReq.onerror = function () { resolve({ ok: false, error: String(getReq.error) }); };
  });
}

async function unmarkLlmJudgmentWrong(candidateId) {
  const id = String(candidateId || '');
  if (!id) return { ok: false, error: 'missing candidateId' };
  const db = await openDB();
  return new Promise(function (resolve) {
    const tx = db.transaction(STORE_EVALUATIONS, 'readwrite');
    const store = tx.objectStore(STORE_EVALUATIONS);
    const getReq = store.get(id);
    getReq.onsuccess = function () {
      const r = getReq.result;
      if (!r) { resolve({ ok: false, error: 'evaluation not found' }); return; }
      delete r.hrFeedback;
      const putReq = store.put(r);
      putReq.onsuccess = function () { resolve({ ok: true }); };
      putReq.onerror = function () { resolve({ ok: false, error: String(putReq.error) }); };
    };
    getReq.onerror = function () { resolve({ ok: false, error: String(getReq.error) }); };
  });
}

async function upsertEvaluation(record) {
  await upsertEvaluations([record]);
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
// v1.0.5 Sprint C 阶段 1:buildIdbBackupBundle 抽到 lib/db.js,这里 re-export
// EXPORT_IDB_BUNDLE message handler 还在 background.js,通过本 re-export 调
const buildIdbBackupBundle = self.BossDB.buildIdbBackupBundle;

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
// v1.1.11 BUG fix:同时把 domDetail.expect.{cityRaw,jobRaw,salaryRaw} 回填到顶层
//   basic.city / expectation.cityName / candidateOwn / salaryDesc(仅在顶层缺失时填,不覆盖
//   chat/geek/info 接口数据)。
//
// 根因:HR 新电脑场景下 chat/geek/info 接口数据从未进入 sayhi_pool(proactiveFetchEnabled=false
//   默认 + HR 没手点候选人触发 BOSS 自调),sayhi_pool 只有左侧 DOM 列表扫描的 13 字段。
//   即使扩展点击候选人卡片 + 扫详情面板拿到 domDetail.expect.cityRaw="济宁",由于 LLM prompt
//   主要看 basic.city / expectation.cityName,顶层 null 就会判"信息不确定"。
//
// 优先级:chat/geek/info 接口字段 > domDetail.expect(详情面板 DOM) — 接口字段有就不覆盖。
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
      // v1.1.11: 顶层字段回填(仅 null/空时填,不覆盖接口数据)
      const exp = (domDetail && domDetail.expect) || {};
      const basic = Object.assign({}, existing.basic || {});
      const expectation = Object.assign({}, existing.expectation || {});
      let backfilledAny = false;
      if (exp.cityRaw && !basic.city) { basic.city = exp.cityRaw; backfilledAny = true; }
      if (exp.cityRaw && !expectation.cityName) { expectation.cityName = exp.cityRaw; backfilledAny = true; }
      if (exp.jobRaw && !expectation.candidateOwn) { expectation.candidateOwn = exp.jobRaw; backfilledAny = true; }
      if (exp.salaryRaw && !expectation.salaryDesc) { expectation.salaryDesc = exp.salaryRaw; backfilledAny = true; }
      if (backfilledAny) {
        updated.basic = basic;
        updated.expectation = expectation;
        updated.domBackfilledAt = Date.now();
      }
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
        chrome.tabs.sendMessage(target.id, { type: self.BossMessageTypes.SCAN_SAYHI_TAB }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, candidates: [] });
            return;
          }
          if (!resp) {
            resolve({ ok: false, error: 'no-response', candidates: [] });
            return;
          }
          // v1.1.25:tab 校验 — inject.js 在错 tab 下 return wrongTab=true,这里翻成 wrong_tab error
          //   让 sidepanel toast 提示用户切到「新招呼」tab。同时写诊断日志便于后续观察拦截率。
          if (resp.stats && resp.stats.wrongTab) {
            const activeTab = resp.stats.activeSayhiTab || '(未识别)';
            if (self.BossDiag) {
              self.BossDiag.log('warn', 'sayhi.wrong_tab_blocked',
                '在错 tab 下尝试扫描已拦截',
                { activeTab: activeTab, tabUrl: target.url || '' });
            }
            resolve({
              ok: false,
              error: 'wrong_tab',
              activeTab: activeTab,
              candidates: [],
              stats: resp.stats,
              tabId: target.id,
              tabUrl: target.url || ''
            });
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
  startedAt: 0,
  batchId: ''  // v1.1.17:批次 ID(loop_start ts),关联 loop_start/loop_end 配对
};

// v1.1.17:批次级事件 helper — 记录"批次内实际工作时长"用于吞吐率统计
//   loop_start/loop_end 是 batch-scoped 而非 candidate-scoped,candidateId 用 batchId 字符串占位
//   payload 字段:
//     loop_start: { batchId, scenario, jobId, totalTarget }
//     loop_end:   { batchId, scenario, jobId, processed, matched, passed, durationMs, endReason }
async function emitLoopStartEvent(opts) {
  // v1.1.18:silent return 也打 diag log,下次诊断包能看到 silent-skip 路径
  if (!self.BossEvents || !opts || !opts.batchId) {
    if (self.BossDiag) self.BossDiag.log('warn', 'loop.emit_start_skip',
      'emitLoopStartEvent silent return', {
        hasBossEvents: !!self.BossEvents,
        hasOpts: !!opts,
        hasBatchId: !!(opts && opts.batchId)
      });
    return;
  }
  try {
    await self.BossEvents.logEvent({
      stage: 'loop_start',
      candidateId: opts.batchId,  // 批次事件无候选人,batchId 占位
      scenario: opts.scenario,
      jobId: opts.jobId || '',
      payload: {
        batchId: opts.batchId,
        totalTarget: opts.totalTarget || 0
      }
    });
    // v1.1.18:成功也打 diag log,下次诊断包能看到 emit 路径走通
    if (self.BossDiag) self.BossDiag.log('info', 'loop.emit_start_ok',
      'loop_start 写入 events', {
        batchId: opts.batchId, scenario: opts.scenario, jobId: opts.jobId
      });
  } catch (e) {
    console.warn('[BOSS-Sniffer] emitLoopStartEvent failed:', e && e.message);
    if (self.BossDiag) self.BossDiag.log('warn', 'loop.emit_start_failed',
      'emitLoopStartEvent throw', { err: String(e && e.message), opts: opts });
  }
}
// v1.1.17:批次结束时,从 events 表反查本批次 processed/matched/passed
//   推荐页没有内存计数,只能从 events 反推:
//     processed = 该 scenario 在 [startedAt, now] 内 stage in {match_marked, pass_marked, sayhi_failed} 的事件数
//     matched   = stage='match_marked' 事件数
//     passed    = stage='pass_marked' 事件数
async function tallyLoopOutcomeFromEvents(scenario, startedAt) {
  if (!self.BossEvents || !startedAt) return { processed: 0, matched: 0, passed: 0 };
  try {
    // getRecentEvents 默认按 ts 倒序,取 5000 条够单批用(单批最多几十候选人 × 几条事件)
    const recent = await self.BossEvents.getRecentEvents(5000);
    const sinceStart = (recent || []).filter(function (e) {
      if (!e || e.scenario !== scenario) return false;
      if (!e.ts || e.ts < startedAt) return false;
      return e.stage === 'match_marked' || e.stage === 'pass_marked' || e.stage === 'sayhi_failed';
    });
    const matched = sinceStart.filter(function (e) { return e.stage === 'match_marked'; }).length;
    const passed = sinceStart.filter(function (e) { return e.stage === 'pass_marked'; }).length;
    return { processed: sinceStart.length, matched: matched, passed: passed };
  } catch (e) {
    console.warn('[BOSS-Sniffer] tallyLoopOutcomeFromEvents failed:', e && e.message);
    return { processed: 0, matched: 0, passed: 0 };
  }
}

async function emitLoopEndEvent(opts) {
  // v1.1.18:silent return / 成功 / 失败 三态都打 diag log
  if (!self.BossEvents || !opts || !opts.batchId || !opts.startedAt) {
    if (self.BossDiag) self.BossDiag.log('warn', 'loop.emit_end_skip',
      'emitLoopEndEvent silent return', {
        hasBossEvents: !!self.BossEvents,
        hasOpts: !!opts,
        hasBatchId: !!(opts && opts.batchId),
        hasStartedAt: !!(opts && opts.startedAt)
      });
    return;
  }
  try {
    const now = Date.now();
    await self.BossEvents.logEvent({
      stage: 'loop_end',
      candidateId: opts.batchId,
      scenario: opts.scenario,
      jobId: opts.jobId || '',
      payload: {
        batchId: opts.batchId,
        processed: opts.processed || 0,
        matched: opts.matched || 0,
        passed: opts.passed || 0,
        durationMs: now - opts.startedAt,
        endReason: opts.endReason || 'completed'  // completed / aborted / fail_streak / error
      }
    });
    if (self.BossDiag) self.BossDiag.log('info', 'loop.emit_end_ok',
      'loop_end 写入 events', {
        batchId: opts.batchId, scenario: opts.scenario, jobId: opts.jobId,
        processed: opts.processed, endReason: opts.endReason
      });
  } catch (e) {
    console.warn('[BOSS-Sniffer] emitLoopEndEvent failed:', e && e.message);
    if (self.BossDiag) self.BossDiag.log('warn', 'loop.emit_end_failed',
      'emitLoopEndEvent throw', { err: String(e && e.message), opts: opts });
  }
}

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
          type: self.BossMessageTypes.TRIGGER_FETCH_GEEK_INFO_BATCH,
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
          type: self.BossMessageTypes.CLICK_AND_SCAN_DETAIL,
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

  // v1.1.23 P3-3:BOSS 岗位层路由 — 候选人 jobAligned 匹配 position.name,命中后**对该 position 下所有 templates 逐个跑 LLM**
  //   原 v1.1.22 bug:HR 复制出多份同名 JD 模板("AI Builder · 偏前端" / "AI Builder · 偏后端"),
  //   沟通页扫到候选人时只用第一个匹配的模板评估,后面的形同虚设。
  //   修法:routeByPositionWithDiagnosis 返回 {position, templates[]},循环 templates 跑 N 次 LLM。
  //
  // dedup 复合键升级到 (candidateId, templateId, jdContentHash):
  //   - templateId 用 templates[0].jdId (sortOrder 最靠前作为代表);N>1 时只要 templates[0] 没变,
  //     就视为"该候选人的位置评估状态未变",跳过整批重评(否则 HR 在 admin 改任一模板就触发 N 次重评)
  //   - 内容 hash 同理用 templates[0].contentHash
  //   - 注意:这种实现下,HR 改非 templates[0] 的模板不会触发该候选人重评 — 是已知简化(下一档考虑细化)
  //
  //   预先计算路由结果一次,后面 async 评估循环里直接复用(替换原 1666 行的二次计算)
  const allTemplates = await self.BossJD.listTemplates();
  const allPositions = await self.BossPositions.listPositions();
  const poolRouteResults = pool.map(function (c) {
    const ja = c && c.expectation && c.expectation.jobAligned;
    return self.BossJDRouter.routeByPositionWithDiagnosis(ja, allPositions, allTemplates);
  });

  // 筛选未评估 / 失败 / 陈旧 / 模板切换 / 内容变更 (force=true 绕过所有门)
  const allEvals = await getEvaluations();
  const evalMap = {};
  for (let i = 0; i < allEvals.length; i++) evalMap[allEvals[i].candidateId] = allEvals[i];
  const staleCutoff = Date.now() - SAYHI_EVAL_STALE_MS;

  // todo / routeResults 同步收集,保持 idx 对齐 — 下面 async 循环用 routeResults[idx] 直接取
  let todo = [];
  let routeResults = [];
  pool.forEach(function (c, idx) {
    const r = poolRouteResults[idx];
    function keep() { todo.push(c); routeResults.push(r); }

    if (force) { keep(); return; }
    const e = evalMap[c.candidateId];
    if (!e || !e.evaluation) { keep(); return; }
    if (e.evaluation.status === 'failed') { keep(); return; }
    const judgedAt = e.evaluation.judgedAt || 0;
    if (judgedAt < staleCutoff) { keep(); return; }

    // v1.1.23 P3-3:templateId 维度 dedup — 之前评估的 template ≠ 当前路由的 templates[0] → 强制重评
    //   保留 v1.1.22 的 prevJdId/currJdId 变量名(变量名 = "评估时锚定的 template 的 jdId",templateId 就是 jdId);
    //   注意 routedJdId 是 v0.21.0 起才存的;旧记录(jdId 字段)做兼容回退
    //   两边都 '' (都未路由)→ template 没变,skipping 合理(没 LLM 调用也不会"漏评")
    //   v1.1.23 新增:若历史 record.evaluations[] 已存,取 evaluations[0].templateId 作 prev(代表第一个评估)
    const prevJdId = (e.evaluations && e.evaluations.length && (e.evaluations[0].templateId || e.evaluations[0].routedJdId || e.evaluations[0].jdId))
      || (e.evaluation.routedJdId) || (e.evaluation.jdId) || '';
    const currJdId = (r.reason === 'matched' && r.templates && r.templates[0] && r.templates[0].jdId) || '';
    if (prevJdId !== currJdId) {
      if (self.BossDiag) {
        self.BossDiag.log('info', 'sayhi.dedup_jd_changed',
          'JD 切换触发重评 (原 ' + (prevJdId || '(空)') + ' → 当前 ' + (currJdId || '(空)') + ')',
          { candidateId: c.candidateId, prevJdId: prevJdId, currJdId: currJdId });
      }
      keep(); return;
    }
    // v1.1.22 P2-6 / v1.1.23 P3-3:内容维度 dedup — 同 templateId 但内容(must/opt/threshold/customPrompt)变了 → 重评
    //   场景:HR 在 admin 改了筛选条件 / customPrompt,旧评估应作废重跑(原条件下的判断不再有效)
    //   兼容性策略:
    //     - prev 空 + curr 空 → 两边都没 hash(老版本前的数据) → 视为"未变化",跳过这道门
    //     - prev 空 + curr 非空 → 老 evaluation 没存 hash → **重评一次**(刷一遍,接受一次性流量)
    //     - prev 非空 + curr 非空 + 不等 → JD 内容确实改了 → 重评
    //     - prev 非空 + curr 空 → 不应该发生(prev 非空说明上次匹配上了,现在却没 currJdId 已被
    //       上一道门拦下);防御性跳过,语义和"内容没变"一致
    //   注意:必须放在 "JD 切换门" 之后 — JD 切换是更粗粒度的原因,先拦下避免日志噪音
    const prevContentHash = (e.evaluations && e.evaluations.length && e.evaluations[0].jdContentHash)
      || (e.evaluation.jdContentHash) || '';
    const currContentHash = (r.reason === 'matched' && r.templates && r.templates[0] && r.templates[0].contentHash) || '';
    const contentHashChanged = (prevContentHash !== currContentHash)
      && (currContentHash !== '');  // 兜底:curr 空就不触发(同时覆盖"老数据 prev 空 + curr 空"和异常情况)
    if (contentHashChanged) {
      if (self.BossDiag) {
        self.BossDiag.log('info', 'sayhi.dedup_content_hash_changed',
          'JD 内容变更触发重评 (原 ' + (prevContentHash || '(空)').slice(0, 8)
            + ' → 当前 ' + (currContentHash || '(空)').slice(0, 8) + ')',
          {
            candidateId: c.candidateId,
            jdId: currJdId,
            prevContentHash: prevContentHash.slice(0, 8),
            currContentHash: currContentHash.slice(0, 8)
          });
      }
      keep(); return;
    }
    // 同 template + 同内容 + 新鲜 → 跳过(语义不变,只是加了 template 维度 + 内容维度)
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

  // v1.1.17:batchId = 启动 ts(简单稳定;loop_start/loop_end 通过 payload.batchId 配对)
  const _batchStartedAt = Date.now();
  const _batchId = 'batch_' + _batchStartedAt;
  sayhiEvalRun = {
    running: true,
    total: todo.length,
    done: 0,
    abortRequested: false,
    startedAt: _batchStartedAt,
    batchId: _batchId  // v1.1.17
  };
  // v1.1.17:批次启动事件(沟通页可能多 JD,jobId 留空表"混合")
  emitLoopStartEvent({
    batchId: _batchId,
    scenario: 'sayhi-tab',
    jobId: '',
    totalTarget: todo.length
  });

  (async function () {
    // v1.1.17:批次 matched/passed 计数 + endReason 推断,finally 里 emit loop_end 用
    let _batchMatched = 0;
    let _batchPassed = 0;
    let _batchEndReason = 'completed';
    let _batchErrorMessage = '';
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

      // v1.1.22 P2-4:JD 路由计算已经在 dedup 阶段做完(对齐 todo / routeResults 索引)
      //   此处不再二次调 listTemplates / routeWithDiagnosis,直接用上面预算好的 routeResults
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
      // v1.1.23 P3-3:unrouteReason 扩展到 'no_jobAligned' | 'no_positions' | 'no_match' | 'no_templates_in_position'
      //   (旧 routeWithDiagnosis 的 'no_templates' 已被 'no_positions' 取代,语义对应"工具内根本没建过任何 position")
      await upsertEvaluations(todo.map(function (c, idx) {
        const r = routeResults[idx];
        if (r.reason !== 'matched') {
          return {
            candidateId: c.candidateId,
            candidate: c,
            // v1.1.23 P3-3:新 shape — record.evaluations 仍写空数组,record.evaluation 保持向后兼容
            evaluations: [],
            evaluation: {
              status: 'unrouted',
              unrouteReason: r.reason,  // 'no_jobAligned' | 'no_positions' | 'no_match' | 'no_templates_in_position'
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
          position: r.position ? { positionId: r.position.positionId, name: r.position.name } : null,
          // v1.1.23 P3-3:queued 状态下 evaluations 是占位空数组,真正评估后填充
          evaluations: [],
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
        // v1.1.23 P3-3:本候选人评估用的 templates(整个 position 下所有 templates,按 sortOrder)
        //   对每个 template 跑一次 LLM(Cartesian product),N templates × M candidates = N×M 次调用
        const templates = route.templates || [];
        const positionMeta = route.position
          ? { positionId: route.position.positionId, name: route.position.name }
          : null;

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

        // 3) 跑 LLM 串行 — 对每个 template 跑一次,收集 N 条 sub-evaluation
        if (sayhiEvalRun.abortRequested) break;
        // v0.20.9 / v1.1.23 P3-3:LLM await 前一刻翻转 queued → pending(评估中)。多模板下整个候选人共用一个 pending 占位
        await upsertEvaluation({
          candidateId: c.candidateId,
          candidate: fresh,
          position: positionMeta,
          evaluations: [],
          evaluation: { status: 'pending', startedAt: Date.now() },
          capturedAt: c.capturedAt || Date.now(),
          capturedUrl: 'sayhi-tab'
        });

        // v1.1.23 P3-3:对每个 template 串行跑 LLM,收集 subEvaluations 数组
        //   每条 subEval:{templateId, templateName, status, decision/verdict, judgedAt, jdContentHash, routedJdId, ...result}
        //   注意:IDB evaluations 表 keyPath='candidateId',一个 candidate 只能存一条记录;
        //   新 shape 把 N 个 sub-eval 放进 record.evaluations[] 数组,record.evaluation 仍保留(向后兼容)
        const subEvaluations = [];
        // 选首个"符合"的 template 作为代表(greet 用 templates[0]→[1]→... 按 sortOrder 取首个 pass=false 的)
        let representativeIdx = -1;
        for (let ti = 0; ti < templates.length; ti++) {
          if (sayhiEvalRun.abortRequested) break;
          const jd = templates[ti];
          let subEval;
          try {
            const result = await self.BossJudge.judgeCandidate(fresh, jd, llmCfg);
            subEval = Object.assign({ status: 'done' }, result);
          } catch (err) {
            console.error('[BOSS-Sniffer sayhi] judge failed for', c.candidateId, 'template=' + (jd && jd.jdId), err);
            subEval = {
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
          // v1.1.23 P3-3:每条 sub-eval 含 templateId / templateName(sidepanel 多模板卡片读这两个字段)
          subEval.templateId = (jd && jd.jdId) || '';
          subEval.templateName = (jd && jd.name) || '';
          subEval.routedJdId = (jd && jd.jdId) || '';  // 向后兼容
          subEval.routedJdName = (jd && jd.name) || '';  // 向后兼容
          subEval.routedByJobName = route.byJobName;
          subEval.jdContentHash = (jd && jd.contentHash) || '';
          subEvaluations.push(subEval);
          if (representativeIdx === -1 && subEval.decision === '符合') representativeIdx = ti;
        }
        // 若没有任何 template 命中"符合",取首条(用于向后兼容 evaluation 单字段;greet 不会触发)
        if (representativeIdx === -1) representativeIdx = 0;
        const representative = subEvaluations[representativeIdx] || subEvaluations[0] || {
          status: 'failed', error: 'no_templates_evaluated', judgedAt: Date.now()
        };

        await upsertEvaluation({
          candidateId: c.candidateId,
          candidate: fresh,
          position: positionMeta,
          // v1.1.23 P3-3:新 shape — sidepanel 多模板卡片消费 record.evaluations[]
          evaluations: subEvaluations,
          // v1.1.23 P3-3:向后兼容 — record.evaluation 单字段仍保留(dashboard / 老 caller 读),
          //   取首个"符合"或首个 sub-eval 作为代表
          evaluation: representative,
          capturedAt: c.capturedAt || Date.now(),
          capturedUrl: 'sayhi-tab'
        });
        sayhiEvalRun.done++;
        // v1.1.17 / v1.1.23 P3-3:批次内 matched/passed 计数(emit loop_end payload 用)
        //   多模板下:只要任一 template 决策"符合"就算 matched;全部 pass 才算 passed
        const anyMatched = subEvaluations.some(function (s) { return s.decision === '符合'; });
        const allPass = subEvaluations.length > 0 && subEvaluations.every(function (s) { return s.decision === 'pass'; });
        if (anyMatched) _batchMatched++;
        else if (allPass) _batchPassed++;
        // v1.0.8 / v1.1.23 P3-3:L3/L4 漏斗埋点 — 沟通页 LLM 评估结果补埋(每个 template 一条)
        //   scenario='sayhi-tab',jobId 取该 template.jdId(N 模板 → N 条 funnel 事件,看板按 jdId 切片仍准确)
        for (let si = 0; si < subEvaluations.length; si++) {
          await logFunnelOutcomeEvent(fresh, subEvaluations[si], null, {
            scenario: 'sayhi-tab',
            jobId: subEvaluations[si].templateId || ''
          });
        }

        // v1.1.23 P3-3:greet 用"sortOrder 最靠前的符合模板"的 default greet
        //   若 templates[0] 是符合 → 用它的 greet;若 templates[0] 是 pass 但 templates[1] 符合 → 用 templates[1] 的 greet
        const greetJdIdx = subEvaluations.findIndex(function (s) { return s.decision === '符合'; });
        const greetJd = greetJdIdx >= 0 ? templates[greetJdIdx] : null;
        if (self.BossDiag) {
          self.BossDiag.log('info', 'sayhi.position_eval_done', '候选人多模板评估完成', {
            candidateId: c.candidateId,
            positionId: positionMeta && positionMeta.positionId,
            positionName: positionMeta && positionMeta.name,
            templateCount: templates.length,
            decisions: subEvaluations.map(function (s) { return s.decision || s.status; }),
            greetTemplateId: greetJd && greetJd.jdId,
            representativeTemplateId: subEvaluations[representativeIdx] && subEvaluations[representativeIdx].templateId
          });
        }

        // 4) 自动操作分支：仅 executeAction=true + autoActionOn + 任一 template 决策'符合' 时触发
        //   v1.1.23 P3-3:多模板下,只要有任一 template "符合" 即触发 greet,话术取 sortOrder 最靠前符合模板的 default greet
        if (autoActionOn && anyMatched && !sayhiEvalRun.abortRequested) {
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
              // v0.25.2 / v1.1.23 P3-3：话术从 sortOrder 最靠前的"符合"模板的 default greet 取
              const greetTpl = greetJd ? getJdDefaultGreetTemplate(greetJd) : null;
              if (!greetTpl || !greetTpl.text) {
                console.warn('[BOSS-Sniffer sayhi] 跳过自动操作 uid=' + c.candidateId + ' reason=no-greet-template-in-jd');
                if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_action_skip',
                  '无话术模板跳过', { candidateId: c.candidateId, reason: 'no-greet-template',
                    greetTemplateId: greetJd && greetJd.jdId });
              } else {
                console.info('[BOSS-Sniffer sayhi] 执行自动操作 uid=' + c.candidateId + ' greet=' + greetTpl.name +
                  ' fromTemplate=' + (greetJd && greetJd.name) + (dryRun ? ' [DRY-RUN]' : ''));
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
                  // v1.0.8：L2 漏斗埋点 — 沟通页招呼发出补埋(dryRun 不计入,避免看板虚高)
                  if (!dryRun) {
                    await logSayHiOutcomeEvent(c.candidateId, {
                      status: 'sent',
                      sentAt: Date.now(),
                      buttonText: 'greet-then-resume'
                    });
                  }
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
                  // v1.0.8：话术已输入或求简历已点出,链路通了算 sent;后半 UI 失败不重要
                  if (!dryRun) {
                    await logSayHiOutcomeEvent(c.candidateId, {
                      status: 'sent',
                      sentAt: Date.now(),
                      buttonText: 'greet-then-resume[partial:' + failedStep + ']'
                    });
                  }
                } else {
                  // 未分类失败 → 走老 actionGreetFailStreak 兜底（防 STEP_POLICY 表未覆盖的偶发模式）
                  actionGreetFailStreak++;
                  console.warn('[BOSS-Sniffer sayhi] autoGreet 失败 uid=' + c.candidateId +
                    ' failedStep=' + (failedStep || 'unclassified') +
                    ' err=' + ((actionResp.result && actionResp.result.error) || actionResp.error));
                  // v1.0.8：emit sayhi_failed 让看板「招呼失败」可见
                  await logSayHiOutcomeEvent(c.candidateId, {
                    status: 'failed',
                    failedAt: Date.now(),
                    error: 'step=' + (failedStep || 'unclassified') + ' err=' +
                      ((actionResp.result && actionResp.result.error) || actionResp.error || '')
                  });
                }
              }
            }
          }
        }

        // v0.24.4 / v1.1.23 P3-3：autoMark 条件 — 多模板下"全部 template 返回 pass"才算"该候选人在该 position 下确认不合适"
        //   任一 template 返回"符合"已在上面 autoGreet 分支处理了;这里只处理 allPass 的情况
        //   HR 勾 checkbox 已表达"信任 LLM"意图，不再二次确认；失败按 STEP_POLICY 处理
        // v0.24.5 BUG fix：① 用 actionMarkFailStreak 独立计数（不再被 autoGreet streak 锁）
        //                  ② allPass 但 gate 不通过时输出 gate-blocked 诊断 log
        if (allPass) {
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
            // v1.0.13：区分 partial vs full success
            //   v1.0.12 诊断包发现 bg 把 partial 也 emit 成 auto_mark_done,
            //   导致看板 actionSuccess 统计虚高(实际卡片 15s 未消失,partial 失败)。
            //   inject.js wait-card-gone 失败时 result.ok=true + result.partial=true,
            //   这里要分别 emit 让 HR 能在看板看清真实成功率。
            const markPartial = markOk && markResp.result && markResp.result.partial === true;
            if (markOk) {
              actionMarkFailStreak = 0;
              actionSuccess++;
              if (markPartial) {
                // 派发完成但卡片未消失(含 inject 1 次重试后)→ 标 partial,不计 streak
                if (self.BossDiag) self.BossDiag.log('warn', 'sayhi.auto_mark_partial',
                  'partial:派发已发出但 BOSS 端卡片未消失(15s + 1 次重试 15s 均超时)',
                  { candidateId: c.candidateId, failedStep: markResp.result.failedStep || 'wait-card-gone' });
              } else {
                if (self.BossDiag) self.BossDiag.log('info', 'sayhi.auto_mark_done',
                  '已立即标不合适', { candidateId: c.candidateId });
              }
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
      _batchEndReason = 'error';
      _batchErrorMessage = String((e && e.message) || e);
    } finally {
      // v1.1.17:推断 endReason — abortRequested(且非 error) 时区分是 HR 主动还是 fail_streak
      //   actionGreetFailStreak/actionMarkFailStreak 命中阈值时也会 set abortRequested=true,
      //   语义其实是 'fail_streak';没办法在 finally 里访问这两个变量(循环局部),保守报 'aborted'
      if (_batchEndReason === 'completed' && sayhiEvalRun.abortRequested) {
        _batchEndReason = 'aborted';
      }
      sayhiEvalRun.running = false;
      console.info('[BOSS-Sniffer sayhi] 评估完成，已评 ' + sayhiEvalRun.done + '/' + sayhiEvalRun.total);
      // v1.1.17:批次结束事件 — 必须 emit(即使 error / aborted 也要,看板才能统计批次时长)
      emitLoopEndEvent({
        batchId: _batchId,
        startedAt: _batchStartedAt,
        scenario: 'sayhi-tab',
        jobId: '',
        processed: sayhiEvalRun.done,
        matched: _batchMatched,
        passed: _batchPassed,
        endReason: _batchEndReason
      });
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
    abortRequested: sayhiEvalRun.abortRequested,
    // v1.1.17:暴露 startedAt 给 sidepanel 算实时速率 + ETA
    startedAt: sayhiEvalRun.startedAt || 0,
    batchId: sayhiEvalRun.batchId || ''
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
          type: self.BossMessageTypes.EXECUTE_SAYHI_ACTION,
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

// v1.0.6 Sprint C 阶段 2:realClickAtCoords 完整体抽到 lib/debugger-click.js
// 这里 re-export 让本文件 REAL_CLICK_AT_COORDS handler 调用不变
const realClickAtCoords = self.BossDebuggerClick.realClickAtCoords;

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
          type: self.BossMessageTypes.EXECUTE_GREET_THEN_RESUME,
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
    if (res.sayHiDom) {
      // v1.1.14 fix：proactiveFetchEnabled 老配置可能是 false（v1.0.14 之前 admin UI 还在时
      //   HR 可能改过 / admin 自动 save 过），会覆盖 v1.1.12 改的代码新默认 true，导致 v1.1.12
      //   修复"对升级用户实际不生效"。此 key 一律以代码默认为准（不从 storage 读）。
      const cleaned = Object.assign({}, res.sayHiDom);
      delete cleaned.proactiveFetchEnabled;
      deepMerge(appConfig.sayHiDom, cleaned);
      // 一次性清理 storage 里的旧 false：避免诊断 / 排查时被旧值误导
      if (res.sayHiDom.proactiveFetchEnabled === false) {
        const patched = Object.assign({}, res.sayHiDom);
        delete patched.proactiveFetchEnabled;
        self.BossStorageSync.set({ sayHiDom: patched }).catch(function (err) {
          console.warn('[BOSS-Sniffer] 清理 sayHiDom.proactiveFetchEnabled 旧值失败：', err && err.message);
        });
      }
    }
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
  // v1.1.15:确保 JD 已 seed,然后跑默认招呼语迁移(对升级用户:老 JD greetTemplates 空 → 注入默认)。
  //   两步顺序:先 ensureSeeded(空 storage 写 3 SEED,SEED 自身已内嵌默认话术),再 migrateGreetTemplates
  //   (处理 HR 自建 JD / v0.25.2 升级残留)。幂等:greetSeededAt 标记防重复迁移。
  if (self.BossJD) {
    try {
      await self.BossJD.ensureSeeded();
      const migrated = await self.BossJD.migrateGreetTemplates();
      if (self.BossDiag && migrated > 0) {
        self.BossDiag.log('info', 'sw.greet_migration_v1_1_15',
          '默认招呼语一次性迁移', { migratedJdCount: migrated });
      }
    } catch (e) {
      console.warn('[BOSS-Sniffer] v1.1.15 default greet migration failed:', e && e.message);
    }
  }
  // v1.1.23 P3-1:BOSS 岗位层数据迁移 — 给每个老 JD 自动建一个 BossPosition,
  // template.positionId 设置完;同名 templates 自动归集到同一个 position。幂等。
  if (self.BossPositions) {
    try {
      const migrationResult = await self.BossPositions.ensureSeeded();
      if (self.BossDiag && (migrationResult.createdPositions > 0 || migrationResult.migratedTemplates > 0)) {
        self.BossDiag.log('info', 'sw.position_migration_v1_1_23',
          'BOSS 岗位层迁移', migrationResult);
      }
    } catch (e) {
      console.warn('[BOSS-Sniffer] v1.1.23 BossPositions migration failed:', e && e.message);
    }
  }
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
    chrome.tabs.sendMessage(lastBossTabId, { type: self.BossMessageTypes.REFRESH_RECOMMEND_PAGE }, function (resp) {
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
    chrome.tabs.sendMessage(tabId, { type: self.BossMessageTypes.CLICK_LATEST_TAB }, function (resp) {
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
    // v1.1.17:scheduler 自然终止 → emit loop_end(endReason=completed)
    //   先取 snapshot 再 reset
    const _tab = currentTab;
    const _batchSnap = recommendLoopRun;
    screeningEnabled = false;
    currentTab = null;
    reconcileSayHiConsumer();
    console.info('[BOSS-Sniffer] scheduler 自然终止 (' + reason + ')，screening 已关');
    if (_batchSnap && _batchSnap.batchId && _batchSnap.startedAt) {
      // v1.1.23 P3-3:reset 时也清 templateIds;templateIds 放前面让 jobId 仍在末尾,
      //   保持 v1.1.18-B2 反向断言 /jobId:\s*['"]['"],/ 仍通过
      recommendLoopRun = { batchId: '', startedAt: 0, templateIds: null, jobId: '' };
      (async function () {
        const tally = await tallyLoopOutcomeFromEvents(_tab, _batchSnap.startedAt);
        // v1.1.18:jobId 用 _batchSnap.jobId 保证跟 loop_start 一致
        await emitLoopEndEvent({
          batchId: _batchSnap.batchId,
          startedAt: _batchSnap.startedAt,
          scenario: _tab,
          jobId: _batchSnap.jobId || '',
          processed: tally.processed,
          matched: tally.matched,
          passed: tally.passed,
          endReason: 'completed'
        });
      })();
    }
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
      chrome.tabs.sendMessage(lastBossTabId, { type: self.BossMessageTypes.SCROLL_RECOMMEND_LIST }, function (resp) {
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
// ===== 消息路由 =====
// v1.0.7 Sprint C 阶段 3:runtime.onMessage listener 已移到 lib/message-router.js
// v1.1.22 P2-1:36 handler 函数体外迁到 lib/handlers/*-handlers.js,工厂模式 + 显式 deps
//   - background.js 只负责构造 deps + 注册;handler 逻辑都在 lib/handlers/
//   - deps 内部:状态 getter/setter(screeningEnabled / currentTab / recommendLoopRun / lastBossTabId /
//     inMemoryStats / appConfig / sayhiEvalRun)+ background.js 定义的闭包函数引用
//   - 6 个领域:capture(3) / evaluation(10) / diag(2) / sayhi(16) / config(3) / loop(4) = 38 个 handler
//   - 加新 handler 时:lib/handlers/对应领域文件加 handler;若需新 dep 在下面 _handlerDeps 加;不改主文件
function _buildHandlerDeps() {
  return {
    // ---- 状态 getter/setter (闭包 let 变量需要通过函数 indirection 暴露给外部 handler) ----
    getScreeningEnabled: function () { return screeningEnabled; },
    setScreeningEnabled: function (v) { screeningEnabled = v; },
    getCurrentTab: function () { return currentTab; },
    setCurrentTab: function (v) { currentTab = v; },
    getRecommendLoopRun: function () { return recommendLoopRun; },
    setRecommendLoopRun: function (v) { recommendLoopRun = v; },
    getLastBossTabId: function () { return lastBossTabId; },
    setLastBossTabId: function (v) { lastBossTabId = v; },
    getInMemoryStats: function () { return inMemoryStats; },
    getAppConfig: function () { return appConfig; },
    getSayhiEvalRun: function () { return sayhiEvalRun; },
    // ---- background.js 定义的闭包函数(直接传引用,函数内部仍闭包到 background.js 作用域) ----
    saveCapture: saveCapture,
    exportAll: exportAll,
    clearAll: clearAll,
    getEvaluations: getEvaluations,
    clearEvaluations: clearEvaluations,
    clearPendingEvaluations: clearPendingEvaluations,
    retryEvaluation: retryEvaluation,
    markLlmJudgmentWrong: markLlmJudgmentWrong,
    unmarkLlmJudgmentWrong: unmarkLlmJudgmentWrong,
    checkRecentCandidatePoolEvents: checkRecentCandidatePoolEvents,
    getCurrentJdTemplate: getCurrentJdTemplate,
    getCurrentLlmConfig: getCurrentLlmConfig,
    isCurrentLlmConfigured: isCurrentLlmConfigured,
    getCurrentGreetTemplate: getCurrentGreetTemplate,
    saveConfigSection: saveConfigSection,
    reconcileSayHiConsumer: reconcileSayHiConsumer,
    scanSayhiTabOnce: scanSayhiTabOnce,
    upsertSayhiCandidates: upsertSayhiCandidates,
    logCandidatePoolEvents: logCandidatePoolEvents,
    getSayhiPool: getSayhiPool,
    getSayhiEvalStatus: getSayhiEvalStatus,
    realClickAtCoords: realClickAtCoords,
    evalSayhiBatch: evalSayhiBatch,
    evalSayhiSingle: evalSayhiSingle,
    abortSayhiEval: abortSayhiEval,
    clearSayhiPool: clearSayhiPool,
    executeSayhiActionForCandidate: executeSayhiActionForCandidate,
    triggerGreetThenResume: triggerGreetThenResume,
    recordSayhiActionResult: recordSayhiActionResult,
    getEncryptUid: getEncryptUid,
    mergeDomDetailIntoSayhiPool: mergeDomDetailIntoSayhiPool,
    emitLoopStartEvent: emitLoopStartEvent,
    emitLoopEndEvent: emitLoopEndEvent,
    tallyLoopOutcomeFromEvents: tallyLoopOutcomeFromEvents,
    refreshBossPage: refreshBossPage,
    clickLatestTab: clickLatestTab,
    buildDiagBundle: buildDiagBundle,
    buildIdbBackupBundle: buildIdbBackupBundle
  };
}

(function _registerAllHandlers() {
  const deps = _buildHandlerDeps();
  self.BossMessageRouter.register(Object.assign({},
    self.BossCaptureHandlers.create(deps),
    self.BossEvaluationHandlers.create(deps),
    self.BossDiagHandlers.create(deps),
    self.BossSayHiHandlers.create(deps),
    self.BossConfigHandlers.create(deps),
    self.BossLoopHandlers.create(deps)
  ));
})();
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
