// BOSS Sniffer - events.js (S1b)
// 漏斗事件流 helper：写入 events store + 简单查询。
//
// 调用方只关心业务字段（stage / candidateId / scenario / jobId / payload），
// 底层时间戳 ts、toolState 留接口字段由本模块自动填充。
//
// 公开 API：self.BossEvents.{ logEvent, getEventsByCandidate, getRecentEvents }
//
// 字段约定见 background.js:17-26（与本文件常量必须保持一致；改 schema 时两处同改）

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
    'resume_received'     // L4 简历回收（v1 推荐页拿不到，预留）
  ];
  const VALID_SCENARIOS = ['recommend', 'chat'];

  // 复用 background.js 的 openDB（schema 创建逻辑唯一来源），避免 onupgradeneeded 漂移
  function openDb() {
    if (typeof self.BOSS_OPEN_DB !== 'function') {
      return Promise.reject(new Error('events.js: self.BOSS_OPEN_DB 未注册（background.js 未加载完？）'));
    }
    return self.BOSS_OPEN_DB();
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
    if (typeof self.BOSS_ENQUEUE_FSA_WRITE === 'function' && typeof self.BOSS_TS_TO_MONTH === 'function') {
      try {
        await self.BOSS_ENQUEUE_FSA_WRITE(self.BOSS_TS_TO_MONTH(event.ts));
      } catch (err) {
        console.warn('[BossEvents] enqueue FSA write failed:', err && err.message);
      }
    }
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
    derivePassReason: derivePassReason,
    VALID_STAGES: VALID_STAGES,
    VALID_SCENARIOS: VALID_SCENARIOS
  };
})(self);
