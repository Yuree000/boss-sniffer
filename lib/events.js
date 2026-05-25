// BOSS Sniffer - events.js (S1b)
// 漏斗事件流 helper：写入 events store + 简单查询。
//
// 调用方只关心业务字段（stage / candidateId / scenario / jobId / payload），
// 底层时间戳 ts、toolState 留接口字段由本模块自动填充。
//
// 公开 API：self.BossEvents.{ logEvent, getEventsByCandidate, getRecentEvents }
//
// 字段约定见 background.js:17-26（与本文件常量必须保持一致；改 schema 时两处同改）
//
// ⚠ 与 lib/diag-log.js 区别（容易混淆）：
//   - 本 lib（events.js）= 【业务漏斗事件】：候选人池/标 pass/标符合/已发招呼/已回复/已收简历 等 7 个 stage，
//     永久保留，看板和漏斗图渲染来源。stage 是白名单枚举，乱写会抛错。
//   - lib/diag-log.js  = 【技术调试日志】：代码执行轨迹（500 条环形 buffer），用于排查 bug，
//     诊断包导出时收集。**不要在这里写技术日志，也不要在 diag-log 写业务事件**。

(function (global) {
  'use strict';

  // 合法 stage 枚举（白名单校验，防止打字错误）
  const VALID_STAGES = [
    'candidate_pool',     // L1 候选人入池（rec/geek/list 抓到，或沟通页 chat/geek/info）
    'pass_marked',        // Pass 终止分支：LLM 判 pass，含 passReason
    'match_marked',       // 判别符合（不直接放在漏斗主路径，便于调试）
    'sayhi_sent',         // L2 招呼发出（chrome.debugger 模拟点击成功）
    'sayhi_failed',       // 招呼失败（接口/DOM 异常，主路径不计入）
    'engaged',            // L3 持续沟通（候选人首次有效回复，v1 推荐页拿不到，预留）
    'resume_received',    // L4 简历回收（v1 推荐页拿不到，预留）
    // v1.1.17:批次级事件,记录"批次内吞吐率"用。跟候选人无关 → candidateId 用 batchId 占位
    'loop_start',         // 批次启动(推荐页 START_LOOP / 沟通页 evalSayhiCore 入口)
    'loop_end'            // 批次结束(完成 / aborted / fail_streak / error)
  ];
  // v1.1.17:批次级事件不绑定候选人(candidateId 用 batchId 占位)
  const BATCH_LEVEL_STAGES = ['loop_start', 'loop_end'];
  // 4 种物理 scenario,跟 extractor.js / deriveScenario 对齐
  // 看板 dashboard.js recordScenario 做业务归一化:
  //   recommend + latest → 推荐流;  chat + sayhi-tab → 沟通流
  // v0.20.7 起 dashboard 已支持 4 种归一化,但本白名单一直停在 2 种 →
  //   logEvent({scenario:'sayhi-tab'|'latest'}) 被拒绝 throw,沟通页主链路 events 完全写不进。
  // v1.0.8 修:扩展为 4 种,沟通页 candidate_pool / outcome / sayhi_sent 才能流入 events 表。
  const VALID_SCENARIOS = ['recommend', 'latest', 'chat', 'sayhi-tab'];

  // 复用 background.js 的 openDB（schema 创建逻辑唯一来源），避免 onupgradeneeded 漂移
  // v1.1.18:加 fallback 链 — 防 chrome SW lazy load quirk(self.BOSS_OPEN_DB 偶尔 undefined):
  //   ① 优先用 self.BOSS_OPEN_DB(主路径,带 schema 升级保护)
  //   ② fallback 到 self.BossDB.openDB(同源代码,只是引用方式不同)
  //   ③ 最后兜底 indexedDB.open('boss-sniffer-db')(无 schema 创建,只能读已有 store)
  //   ④ 都没有才 reject — 这种情况说明 SW 极度异常,无法挽救
  function openDb() {
    if (typeof self.BOSS_OPEN_DB === 'function') {
      return self.BOSS_OPEN_DB();
    }
    if (self.BossDB && typeof self.BossDB.openDB === 'function') {
      return self.BossDB.openDB();
    }
    // 最后兜底:hardcode DB 名直开(只能读;新装用户首次走不通,但 SW 启动至少跑过一次主路径)
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function') {
      return new Promise(function (resolve, reject) {
        const req = indexedDB.open('boss-sniffer-db');
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return Promise.reject(new Error('events.js: 无可用 openDB 入口(SW 异常)'));
  }
  function storeName() {
    return self.BOSS_STORE_EVENTS || 'events';
  }

  function makeErr(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  // Pass 主因派生 — v0.12.0 动态：按 HR 写的 must 文本作为分类（Q6）
  //
  // 入参：
  //   mustBreakdown: { M1: {value, reason}, M2: ... }
  //   optionalBreakdown: { O1: {value, reason}, ... }
  //   jd: 评估时的 JD 快照（含 mustConditions / optionalConditions / optionalThreshold）
  //
  // 派生规则（优先级与 sidepanel findFailedMust/findUnknownMust 一致）：
  //   1) 第一个 false 的 must → 该 must.text
  //   2) 第一个 unknown 的 must → 该 must.text + '(信息缺)'
  //   3) 否则可选不足 → '可选不足'
  //   4) 数据缺失兜底 → '其他'
  //
  // 看板按 must.text 分组：同一 JD 内文本稳定；跨 JD 切换会变样（UI 已加说明）
  function derivePassReason(mustBreakdown, optionalBreakdown, jd) {
    if (!jd || !Array.isArray(jd.mustConditions)) {
      // jd 缺失（不应发生），保底返回'其他'
      return '其他';
    }
    const must = jd.mustConditions;

    // 1) 第一个 false 的 must
    for (let i = 0; i < must.length; i++) {
      const r = mustBreakdown && mustBreakdown['M' + (i + 1)];
      if (r && r.value === false) return must[i].text || '其他';
    }
    // 2) 第一个 unknown 的 must
    for (let i = 0; i < must.length; i++) {
      const r = mustBreakdown && mustBreakdown['M' + (i + 1)];
      if (r && r.value === 'unknown') return (must[i].text || '其他') + '(信息缺)';
    }
    // 3) 都过 → 可选不足
    return '可选不足';
  }

  // v1.1.3：multi-pass-reasons —— 收集所有失败 M_i 作为 pass 原因数组
  // 用于 background.js logFunnelOutcomeEvent 每个失败 M_i 都 emit 一条 pass_marked event。
  //
  // 规则:
  //   1) 所有 value === false 的 must → 返回该 must.text 数组（多元素）
  //   2) 否则 第一个 unknown → 返回 [text + '(信息缺)']（单元素，跟 derivePassReason 一致）
  //   3) 否则 都过但 pass → 返回 ['可选不足']（单元素）
  //   4) jd 缺失兜底 → ['其他']
  //
  // 设计意图（HR 视角）:
  //   候选人 M1 + M2 都不满足时,看板「Top pass 主因」应该真实反映 M1 + M2 各卡了多少人,
  //   而不是 derivePassReason 老逻辑「只算第一个 false M_i」。
  //
  // 影响 distinct 计数:
  //   dashboard.js countJudgedCandidates 用 distinctCandidateCount (按 candidateId Set 去重),
  //   不被 multi-emit 影响。Top pass 主因 reasonCounts 用事件计数 — 这正好变成真实占比。
  function collectPassReasons(mustBreakdown, optionalBreakdown, jd) {
    if (!jd || !Array.isArray(jd.mustConditions)) {
      return ['其他'];
    }
    const must = jd.mustConditions;

    // 1) 收集所有 false 的 must（multi）
    const failed = [];
    for (let i = 0; i < must.length; i++) {
      const r = mustBreakdown && mustBreakdown['M' + (i + 1)];
      if (r && r.value === false) failed.push(must[i].text || '其他');
    }
    if (failed.length > 0) return failed;

    // 2) 没 false 但有 unknown → 单 emit 信息缺（保持跟 derivePassReason 第 2 步一致）
    for (let i = 0; i < must.length; i++) {
      const r = mustBreakdown && mustBreakdown['M' + (i + 1)];
      if (r && r.value === 'unknown') return [(must[i].text || '其他') + '(信息缺)'];
    }
    // 3) 都过 → 可选不足
    return ['可选不足'];
  }

  // 主入口：写一条漏斗事件
  // 必填：stage / candidateId / scenario
  // 可选：jobId（默认 ''）、payload（默认 {}）
  // 返回：Promise<number> — events store 自增主键
  async function logEvent(input) {
    if (!input || typeof input !== 'object') {
      throw makeErr('EventInputError', 'logEvent 入参必须是对象');
    }
    const stage = input.stage;
    const candidateId = input.candidateId;
    const scenario = input.scenario;
    if (VALID_STAGES.indexOf(stage) === -1) {
      throw makeErr('EventInputError', 'stage 非法：' + stage);
    }
    if (!candidateId) {
      throw makeErr('EventInputError', 'candidateId 必填');
    }
    if (VALID_SCENARIOS.indexOf(scenario) === -1) {
      throw makeErr('EventInputError', 'scenario 非法：' + scenario);
    }

    const event = {
      ts: Date.now(),
      stage: stage,
      candidateId: String(candidateId),
      scenario: scenario,
      jobId: input.jobId || '',
      toolState: '',  // 业务逻辑 §2.7 留接口，v1 不实采
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {}
    };

    const db = await openDb();
    const id = await new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName(), 'readwrite');
      const store = tx.objectStore(storeName());
      const req = store.add(event);
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () { reject(req.error); };
    });
    // v1.0.3：FSA 入队链路移除（设计搁浅；真灾备走 admin「📦 导出 IDB 备份 JSON」）
    return id;
  }

  // 查询：单候选人全链事件（按 ts 升序，便于看完整时间线）
  async function getEventsByCandidate(candidateId) {
    if (!candidateId) return [];
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName(), 'readonly');
      const store = tx.objectStore(storeName());
      const idx = store.index('candidateId');
      const req = idx.getAll(String(candidateId));
      req.onsuccess = function () {
        const list = req.result || [];
        list.sort(function (a, b) { return a.ts - b.ts; });
        resolve(list);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  // v0.23.0 · Phase 3·3d：查某候选人在 withinMs 时间窗内是否已有 stage 事件
  //   防 engaged / resume_received 对同一候选人重复 emit（HR 翻 history msg 多次会触发多次 merge）
  //   简化实现：复用 candidateId index 拿全集再过滤（候选人单人事件量级小，可接受）
  async function hasRecentEvent(candidateId, stage, withinMs) {
    if (!candidateId || !stage) return false;
    const cap = (typeof withinMs === 'number' && withinMs > 0) ? withinMs : (30 * 24 * 60 * 60 * 1000);
    const cutoff = Date.now() - cap;
    const events = await getEventsByCandidate(candidateId);
    return events.some(function (e) {
      return e && e.stage === stage && (e.ts || 0) >= cutoff;
    });
  }

  // 查询：最近 N 条事件，按 ts 倒序（看板调试 + 调用诊断用）
  async function getRecentEvents(limit) {
    const cap = typeof limit === 'number' && limit > 0 ? limit : 100;
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName(), 'readonly');
      const store = tx.objectStore(storeName());
      const idx = store.index('ts');
      const results = [];
      const req = idx.openCursor(null, 'prev');  // ts 倒序游标
      req.onsuccess = function (e) {
        const cursor = e.target.result;
        if (cursor && results.length < cap) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  global.BossEvents = {
    logEvent: logEvent,
    getEventsByCandidate: getEventsByCandidate,
    getRecentEvents: getRecentEvents,
    hasRecentEvent: hasRecentEvent,
    derivePassReason: derivePassReason,
    collectPassReasons: collectPassReasons,
    VALID_STAGES: VALID_STAGES,
    VALID_SCENARIOS: VALID_SCENARIOS
  };
})(self);
