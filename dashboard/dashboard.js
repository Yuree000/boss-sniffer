// BOSS Sniffer - dashboard.js (v1.1.0 看板大改)
//
// v1.1.0 commit 1（foundation）：
// - CSS variables + 暗色模式（localStorage 'boss-dashboard-theme' 持久化 auto/light/dark）
// - 顶部 KPI 数字带 4 卡（跟时间窗联动 + vs 上一段对比 ↑↓→）
// - scenario tab 升到顶层 nav（取代原漏斗卡内嵌 tab）— 整盘联动语义显式
// - 主区双栏 grid（≥1280px 双栏 / <1280px 单栏 / <768px KPI 2x2 / <480px 单列）
// - sticky header + sticky scenario-bar + scroll-margin-top
// - Loading skeleton（刷新时占位条）
//
// v1.1.0 commit 2（视图升级，下一个 commit）：
// - 「漏斗」→「评估流转」+ 风格 A 横向阶梯卡
// - 趋势 sparkline → 220px 折线 + Y 轴 + tooltip + 3 线叠加
// - JD 分析未选 JD 时横向对比所有 JD（aggregate）
// - 候选人记录搜索 + 翻页 + 行点击展开 LLM 完整 reason
//
// v0.20.3 旧版状态（commit 2 之前临时兼容）：
// - 4 视图（B 漏斗 / C JD 分析 / D 趋势 / E 候选人记录）
// - 时间窗 [日|周|月] 切片所有视图
// - 候选人记录默认 28 条 + 超出待续提示

(function () {
  'use strict';

  const DB_NAME = 'boss-sniffer-db';
  // schema 由 background.js 唯一管理，看板不传 version 自动跟随
  const STORE_CAPTURES = 'captures';
  const STORE_EVALUATIONS = 'evaluations';
  const STORE_EVENTS = 'events';

  // v0.20.0 范围限定常量（v0.20.4 变可变 — 跟 4.B funnel tab 联动）
  const SCENARIO_PRIMARY = 'recommend';
  function currentScenario() { return currentFunnelTab; }
  function isChatScenario() { return currentFunnelTab === 'chat'; }
  // v0.20.4：沟通页主链路待完工时，下方所有视图共享的占位文案
  const CHAT_PLACEHOLDER_HTML =
    '<div class="funnel-placeholder">' +
      '沟通页统计待主链路完工' +
      '<div class="placeholder-hint">v0.17.1.x 已落地但数据未流入 events，下一版本上线</div>' +
    '</div>';

  // v1.1.1：候选人记录改翻页 10/页，DRAWER_TOP_N 28 截断方式废弃
  // 常量保留作 v0.20.x 测试兼容（未在 v1.1.1 渲染逻辑中使用）
  const DRAWER_TOP_N = 28;

  function $(id) { return document.getElementById(id); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function loadAllEvents() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_EVENTS, 'readonly');
        const store = tx.objectStore(STORE_EVENTS);
        const idx = store.index('ts');
        const results = [];
        const req = idx.openCursor(null, 'prev');
        req.onsuccess = function (e) {
          const cursor = e.target.result;
          if (cursor && results.length < 5000) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function loadStoreAll(storeName) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        if (!db.objectStoreNames.contains(storeName)) { resolve([]); return; }
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ============ Utils ============

  function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function formatHm(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  function formatMd(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatYm(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '月';
  }

  function p50(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  function sum(arr) {
    return (arr || []).reduce(function (a, b) { return a + b; }, 0);
  }

  function formatLatency(ms) {
    if (!ms || ms <= 0) return '0s';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'min';
  }

  function safePercent(num, den) {
    if (!den || den <= 0) return 0;
    return Math.round((num / den) * 1000) / 10;
  }

  const escapeHtml = window.BossUiUtils.escapeHtml; // v1.1.22 提到 lib/ui-utils.js

  // v0.20.7：物理 scenario → 业务 scenario 归一化
  // extractor.js 写入 4 种物理 scenario：'recommend' | 'latest' | 'chat' | 'sayhi-tab'
  // 看板只暴露 2 种业务 scenario tab（推荐流 / 沟通流）：
  //   推荐流（业务 'recommend'）= 物理 'recommend' + 'latest'  ← HR 主动筛人主动招呼
  //   沟通流（业务 'chat'）      = 物理 'chat' + 'sayhi-tab'    ← 被动收招呼后评估
  function recordScenario(r) {
    if (!r) return null;
    const raw = r.scenario || (r.candidate && r.candidate.source && r.candidate.source.scenario);
    if (raw === 'recommend' || raw === 'latest') return 'recommend';
    if (raw === 'chat' || raw === 'sayhi-tab') return 'chat';
    return raw;
  }

  // ============ 时间窗 dispatcher ============

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  }

  function todayBounds() {
    const start = startOfDay(new Date());
    return { start: start, end: Date.now() };
  }

  // v0.20.3 新增：本周一 0 点（中国习惯，周日算上周末）
  function weekBounds() {
    const now = new Date();
    const day = now.getDay();
    const offset = day === 0 ? 6 : (day - 1);
    now.setDate(now.getDate() - offset);
    now.setHours(0, 0, 0, 0);
    return { start: now.getTime(), end: Date.now() };
  }

  // v0.20.3 新增：本月 1 号 0 点
  function monthBounds() {
    const now = new Date();
    now.setDate(1);
    now.setHours(0, 0, 0, 0);
    return { start: now.getTime(), end: Date.now() };
  }

  function currentBounds() {
    if (currentTimeMode === 'week') return weekBounds();
    if (currentTimeMode === 'month') return monthBounds();
    return todayBounds();
  }

  // v1.1.0：上一段时间窗 bounds（KPI 数字带 vs 对比用）
  // 日 → 昨天 0:00 - 23:59
  // 周 → 上周一 0:00 - 上周日 23:59
  // 月 → 上月 1 号 - 上月最后一天
  function previousBounds() {
    if (currentTimeMode === 'week') {
      const now = new Date();
      const day = now.getDay();
      const offset = day === 0 ? 6 : (day - 1);
      now.setDate(now.getDate() - offset - 7);
      now.setHours(0, 0, 0, 0);
      const start = now.getTime();
      return { start: start, end: start + 7 * 86400000 };
    }
    if (currentTimeMode === 'month') {
      const now = new Date();
      const dStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const dEnd = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { start: dStart.getTime(), end: dEnd.getTime() };
    }
    // 日：昨天
    const y = new Date();
    y.setDate(y.getDate() - 1);
    y.setHours(0, 0, 0, 0);
    return { start: y.getTime(), end: y.getTime() + 86400000 };
  }

  function previousScopeShort() {
    if (currentTimeMode === 'week') return '上周';
    if (currentTimeMode === 'month') return '上月';
    return '昨天';
  }

  function currentScopeLabel() {
    if (currentTimeMode === 'week') return '本周';
    if (currentTimeMode === 'month') return '本月';
    return '今日';
  }

  function currentScopeShort() {
    if (currentTimeMode === 'week') return '周';
    if (currentTimeMode === 'month') return '月';
    return '日';
  }

  // ============ 过滤器 ============

  function filterEvents(events, opts) {
    const tStart = opts.timeStart != null ? opts.timeStart : 0;
    const tEnd = opts.timeEnd != null ? opts.timeEnd : Infinity;
    return events.filter(function (e) {
      if (e.ts < tStart || e.ts >= tEnd) return false;
      if (opts.jobId && e.jobId !== opts.jobId) return false;
      if (opts.scenario && recordScenario(e) !== opts.scenario) return false;
      if (opts.stage && e.stage !== opts.stage) return false;
      return true;
    });
  }

  // v1.0.9：按 candidateId 用 Set 去重计数(用于 distinct 候选人数语义)
  //   v1.0.9 时给 candidate_pool 用,v1.0.10 起被 countJudgedCandidates 复用
  function distinctCandidateCount(events) {
    const seen = new Set();
    for (const e of events) {
      if (e && e.candidateId) seen.add(e.candidateId);
    }
    return seen.size;
  }

  // v1.1.17:从 events 表 loop_start/loop_end 配对算"批次内吞吐率"
  //   返回 { totalProcessed, totalDurationMs, avgSecPerCandidate, batchCount }
  //   - 配对方式:同 batchId 的 loop_start + loop_end(从 payload.batchId 关联)
  //   - 只算"已完成的批次"(有 loop_end);未结束批次不算(避免在跑中速率失真)
  //   - 不过滤 endReason(aborted/error/completed 全算,只要批次内确实跑了候选人)
  // v1.1.21:内部 normalize opts 强制排除 jobId 过滤 —
  //   沟通页 batch emit 时 jobId=""(多 JD 路由),按 jobId 过滤会让沟通页所有 batch 被踢掉,
  //   导致 HR 选具体 JD 时沟通页 KPI 速率显示「—」(已修复)。
  //   时间窗 + scenario 仍正常过滤,只是 jobId 这一维不参与。
  function computeProcessingRate(events, opts) {
    const safeOpts = {
      timeStart: opts && opts.timeStart,
      timeEnd: opts && opts.timeEnd,
      scenario: opts && opts.scenario
      // 故意不传 jobId — 见上方注释
    };
    const filtered = filterEvents(events, safeOpts);
    const starts = filtered.filter(function (e) { return e.stage === 'loop_start'; });
    const ends = filtered.filter(function (e) { return e.stage === 'loop_end'; });
    // 索引 ends by batchId
    const endByBatchId = {};
    ends.forEach(function (e) {
      const bid = e.payload && e.payload.batchId;
      if (bid) endByBatchId[bid] = e;
    });
    let totalProcessed = 0;
    let totalDurationMs = 0;
    let batchCount = 0;
    starts.forEach(function (s) {
      const bid = s.payload && s.payload.batchId;
      const end = bid ? endByBatchId[bid] : null;
      if (!end || !end.payload) return;
      const processed = end.payload.processed || 0;
      const duration = end.payload.durationMs || 0;
      if (processed > 0 && duration > 0) {
        totalProcessed += processed;
        totalDurationMs += duration;
        batchCount++;
      }
    });
    const avgSec = totalProcessed > 0 ? (totalDurationMs / totalProcessed / 1000) : 0;
    return {
      totalProcessed: totalProcessed,
      totalDurationMs: totalDurationMs,
      avgSecPerCandidate: avgSec,
      batchCount: batchCount
    };
  }

  // v1.1.17:节省时长换算(分钟)— 按 HR 手工 60 秒/人 vs 工具 avgSec/人
  //   公式:totalProcessed × (60 - avgSec) / 60 分钟
  //   若 avgSec >= 60(工具反而慢)→ 0(不展示负节省)
  function computeSavedMinutes(rate) {
    if (!rate || rate.totalProcessed === 0) return 0;
    const HR_MANUAL_SEC_PER_CANDIDATE = 60;
    if (rate.avgSecPerCandidate >= HR_MANUAL_SEC_PER_CANDIDATE) return 0;
    const savedSec = rate.totalProcessed * (HR_MANUAL_SEC_PER_CANDIDATE - rate.avgSecPerCandidate);
    return Math.round(savedSec / 60);
  }

  // v1.0.10：「已判断」= LLM 真跑完的人数（不是入池数）
  //   语义来源 background.js logFunnelOutcomeEvent：
  //     成功 + decision='符合' → emit match_marked
  //     成功 + decision='pass' → emit pass_marked
  //     失败              → emit pass_marked（passReason='信息不足'，兜底归类）
  //   所以"已判断" = stage in {match_marked, pass_marked} 的事件 distinct candidateId
  //   旧版用 candidate_pool（入池数）会包含被 K 截断 / unrouted 跳过的人,
  //     语义跟 HR 直觉「今天跑了几个」不符（HR 反馈：扫到 30 实际 LLM 跑 18 → 看板显示 30 误导）
  function countJudgedCandidates(events, opts) {
    const matchEvents = filterEvents(events, Object.assign({}, opts, { stage: 'match_marked' }));
    const passEvents = filterEvents(events, Object.assign({}, opts, { stage: 'pass_marked' }));
    return distinctCandidateCount(matchEvents.concat(passEvents));
  }

  function filterEvaluations(records, opts) {
    const tStart = opts.timeStart != null ? opts.timeStart : 0;
    const tEnd = opts.timeEnd != null ? opts.timeEnd : Infinity;
    return records.filter(function (r) {
      const e = r.evaluation || {};
      const ts = e.judgedAt || e.startedAt || r.capturedAt || 0;
      if (ts < tStart || ts >= tEnd) return false;
      if (opts.jobId && e.jdId !== opts.jobId) return false;
      if (opts.scenario && recordScenario(r) !== opts.scenario) return false;
      if (opts.decision && e.decision !== opts.decision) return false;
      if (opts.statusDone && e.status !== 'done') return false;
      return true;
    });
  }

  // ============ v1.1.0 · KPI 数字带 ============
  // 4 卡：已判断 / 符合 / 自动招呼 / 符合率
  // 跟时间窗联动；每卡显示「vs 上一段（昨天/上周/上月）」↑↓→ 对比

  function renderViewKpi() {
    const bounds = currentBounds();
    const prevBounds = previousBounds();
    const opts = { scenario: currentScenario(), jobId: currentJobId };
    const curOpts = Object.assign({}, opts, { timeStart: bounds.start, timeEnd: bounds.end });
    const prevOpts = Object.assign({}, opts, { timeStart: prevBounds.start, timeEnd: prevBounds.end });

    const curJudged = countJudgedCandidates(allEventsCache, curOpts);
    const curMatch = filterEvents(allEventsCache, Object.assign({}, curOpts, { stage: 'match_marked' })).length;
    const curSayhi = filterEvents(allEventsCache, Object.assign({}, curOpts, { stage: 'sayhi_sent' })).length;
    const curRate = safePercent(curMatch, curJudged);

    const prevJudged = countJudgedCandidates(allEventsCache, prevOpts);
    const prevMatch = filterEvents(allEventsCache, Object.assign({}, prevOpts, { stage: 'match_marked' })).length;
    const prevSayhi = filterEvents(allEventsCache, Object.assign({}, prevOpts, { stage: 'sayhi_sent' })).length;
    const prevRate = safePercent(prevMatch, prevJudged);

    const labelScope = currentScopeLabel();
    const labelPrev = previousScopeShort();

    // v1.1.3：沟通页第 3 卡 label 切「自动求简历」(数据源还是 sayhi_sent,因为沟通页
    //   greet-then-resume 成功时 emit sayhi_sent with buttonText='greet-then-resume')
    //   推荐页保留「自动招呼」
    //   注:沟通页「自动不合适」当前 background.js 只 BossDiag log 不 emit events,
    //     看板暂时看不到该数字。后期可加新 stage 'auto_mark_executed' 让 HR 看见。
    const isChat = isChatScenario();
    const sayhiLabel = isChat ? '自动求简历' : '自动招呼';

    // v1.1.17:平均速率(从 events loop_start/loop_end 配对算)
    // v1.1.21:删 KPI 卡下方"节省约 X 分钟"副指标 — HR 反馈这行小字干扰阅读,
    //   computeSavedMinutes 函数仍保留作未来扩展用(比如复盘报告导出)
    const curRate2 = computeProcessingRate(allEventsCache, curOpts);

    setKpiLabel('judged', labelScope + '已判断');
    setKpiLabel('match', labelScope + '符合');
    setKpiLabel('sayhi', labelScope + sayhiLabel);
    setKpiLabel('rate', labelScope + '符合率');
    setKpiLabel('speed', labelScope + '平均速率');

    setKpiValue('judged', curJudged, '人', deltaText(curJudged - prevJudged, labelPrev));
    setKpiValue('match', curMatch, '人', deltaText(curMatch - prevMatch, labelPrev));
    setKpiValue('sayhi', curSayhi, '次', deltaText(curSayhi - prevSayhi, labelPrev));
    setKpiValue('rate', curRate, '%', deltaText(
      Math.round((curRate - prevRate) * 10) / 10,
      labelPrev,
      true
    ));
    // v1.1.17:平均速率卡 — 主指标"X.X 秒/人"
    //   batchCount=0(还没批次完成时)显示 "—" 占位,避免误导
    // v1.1.21:删副指标小字(原"节省约 N 分钟"),deltaHtml 传空字符串
    if (curRate2.batchCount === 0) {
      setKpiValue('speed', '—', '', '');
    } else {
      const avgText = curRate2.avgSecPerCandidate.toFixed(1);
      setKpiValue('speed', avgText, ' 秒/人', '');
    }
  }

  function setKpiLabel(key, text) {
    const el = $('kpi-' + key + '-label');
    if (el) el.textContent = text;
  }

  function setKpiValue(key, value, unit, deltaHtml) {
    const card = $('kpi-' + key);
    if (!card) return;
    const valEl = card.querySelector('.kpi-value');
    if (valEl) valEl.innerHTML = escapeHtml(String(value)) + '<span class="kpi-unit">' + escapeHtml(unit) + '</span>';
    // 清旧 delta（如果有）
    const oldDelta = card.querySelector('.kpi-delta');
    if (oldDelta) oldDelta.parentNode.removeChild(oldDelta);
    if (deltaHtml) {
      const div = document.createElement('div');
      div.innerHTML = deltaHtml;
      card.appendChild(div.firstChild);
    }
  }

  function deltaText(diff, prevLabel, isPct) {
    const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
    const arrow = diff > 0 ? '↑' : (diff < 0 ? '↓' : '→');
    const num = isPct ? (Math.abs(diff).toFixed(1) + '%') : Math.abs(diff);
    return '<div class="kpi-delta ' + cls + '">' + arrow + ' ' + num + ' · vs ' + escapeHtml(prevLabel) + '</div>';
  }

  // ============ v1.1.0 · 主题切换（auto / light / dark） ============
  // localStorage['boss-dashboard-theme'] = 'auto' | 'light' | 'dark'
  // 'auto' = 跟随 prefers-color-scheme（不设 data-theme）
  // 'light' / 'dark' = 强制（设 data-theme attribute on documentElement）

  const THEME_KEY = 'boss-dashboard-theme';
  const THEME_CYCLE = ['auto', 'light', 'dark'];

  function getTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark' || v === 'auto') return v;
    } catch (e) { /* ignore */ }
    return 'auto';
  }

  function applyTheme(theme) {
    if (theme === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    const btn = $('btn-theme');
    if (btn) {
      const icons = { auto: '🌓', light: '☀️', dark: '🌙' };
      const labels = { auto: '自动（跟随系统）', light: '明亮模式', dark: '暗色模式' };
      btn.textContent = icons[theme] || '🌓';
      btn.title = '主题：' + (labels[theme] || theme) + '（点击切换）';
    }
  }

  function cycleTheme() {
    const cur = getTheme();
    const idx = THEME_CYCLE.indexOf(cur);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
  }

  // v1.1.2：评估流转卡删除（与顶部 KPI 数字带的 3 个核心数字重复）
  // 原 renderViewFunnel / flowStage / flowArrow 已删。
  // 进入候选人记录筛选的入口保留：drawer-filter-tab「仅符合」 +
  // applyDrawerFilter / clearDrawerFilter 仍可被 KPI 卡片点击复用（待 v1.1.3 加）。

  // ============ 4.C JD 分析卡（M_i pass 主因 + O_i 命中率） ============
  // v0.20.3：按 currentBounds() 切片（不再固定今日）

  function renderViewJD() {
    // v0.23.0 · 3d：占位移除，沟通页 events 流入后 4.C 自动按 scenario 过滤渲染
    if (false) {
      $('view-jd-content').innerHTML = CHAT_PLACEHOLDER_HTML;
      return;
    }

    const bounds = currentBounds();
    const opts = { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId };

    // v1.1.1：未选 JD 时显示所有 JD 横向对比（aggregate 视图）
    if (!currentJobId) {
      renderJdAggregate(bounds);
      return;
    }

    // jdSnapshot：先看当前范围内评估，没有就 fallback 任意时间评估
    let allJdEvals = filterEvaluations(allEvaluationsCache, { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId });
    if (allJdEvals.length === 0) {
      allJdEvals = filterEvaluations(allEvaluationsCache, { scenario: currentScenario(), jobId: currentJobId });
    }
    if (allJdEvals.length === 0) {
      $('view-jd-content').innerHTML = '<p class="empty-hint">该 JD 暂无评估样本 — 跑一批后回来看</p>';
      return;
    }
    const sampleSnap = allJdEvals[0].evaluation && allJdEvals[0].evaluation.jdSnapshot;
    const mustConditions = (sampleSnap && Array.isArray(sampleSnap.mustConditions)) ? sampleSnap.mustConditions : [];
    const optConditions = (sampleSnap && Array.isArray(sampleSnap.optionalConditions)) ? sampleSnap.optionalConditions : [];

    const judged = countJudgedCandidates(allEventsCache, opts);
    const passEvents = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'pass_marked' }));
    // v1.1.4 BUG fix:reasonCounts 改 distinct candidate 计数(不再事件累加)
    //
    // 老逻辑事件累加 BUG:events 是事件流(autoIncrement),同一候选人:
    //   ① 重评一次 → 多 1 条 pass_marked event
    //   ② v1.1.3 multi-emit:单次评估 M1+M2 都失败 → 多条 event(各 1 个 passReason)
    // 老 reasonCounts[r]++ 把这两类都累加,导致 M_i 失败人数 > 已判断 distinct 数(不合理)
    //
    // 新逻辑:每个 reason 维护一个 Set<candidateId>,size 就是该 reason 失败的 distinct 人数
    //   保持「M_i 失败占比 = M_i 失败的人 / 已判断的人」语义一致
    //   同一候选人单次评估 M1+M2 都失败 → M1 +1, M2 +1(不同 reason 各自 distinct)
    //   同一候选人重评 M1 失败 → M1 仍 +1(同 reason 同 candidate 去重)
    const reasonCandidateSets = {};
    passEvents.forEach(function (e) {
      const r = (e.payload && e.payload.passReason) || '其他';
      if (!reasonCandidateSets[r]) reasonCandidateSets[r] = new Set();
      if (e.candidateId) reasonCandidateSets[r].add(e.candidateId);
    });
    const reasonCounts = {};
    Object.keys(reasonCandidateSets).forEach(function (r) {
      reasonCounts[r] = reasonCandidateSets[r].size;
    });

    const matched = filterEvaluations(allEvaluationsCache, Object.assign({}, opts, { decision: '符合', statusDone: true }));
    const matchedTotal = matched.length;
    const passRate = safePercent(matchedTotal, judged);

    const jdNameSafe = escapeHtml((sampleSnap && sampleSnap.name) || currentJobId);
    let html = '<div class="reason-total">' + jdNameSafe + ' · ' + currentScopeShort() +
      '范围 · 判断 <strong>' + judged + '</strong> 人 · 符合 <strong>' + matchedTotal + '</strong> 人 · 符合率 <strong>' + passRate + '%</strong></div>';

    // ===== 主信息: M_i 失败占比（卡人最多的条件，排序 + 阈值高亮）=====
    // v1.1.3: 文案从「Top pass 主因」改为「M_i 失败占比」
    //   一个候选人 M1+M2 都失败时,2 条都计入(v1.1.3 起 logFunnelOutcomeEvent multi-emit)
    //   分母 = 已判断人数 → "M1 失败 73%" 即"M1 失败的人占已判断 73%"
    if (mustConditions.length === 0) {
      html += '<div class="jd-section-title">⛔ M_i 失败占比</div>' +
              '<p class="empty-hint" style="padding:12px;">该 JD 未配置必要条件</p>';
    } else {
      const mustStats = mustConditions.map(function (c, i) {
        const key = 'M' + (i + 1);
        const passMain = reasonCounts[c.text] || 0;
        const missCount = reasonCounts[c.text + '(信息缺)'] || 0;
        return {
          key: key,
          text: c.text,
          passMain: passMain,
          missCount: missCount,
          total: passMain + missCount,
          passPct: safePercent(passMain, judged),
          missPct: safePercent(missCount, judged)
        };
      });
      const triggered = mustStats.filter(function (s) { return s.total > 0; });
      const untriggered = mustStats.filter(function (s) { return s.total === 0; });
      triggered.sort(function (a, b) { return b.total - a.total; });

      html += '<div class="jd-section-title">⛔ M_i 失败占比（分母 = ' + judged +
        ' 人 · 同一候选人多 M_i 失败时每条都计 · 按失败人次排序）</div>';

      if (triggered.length === 0) {
        html += '<p class="empty-hint" style="padding:12px;">该范围内无 M_i 条件失败 — JD 卡人少 / 候选人池偏匹配</p>';
      } else {
        triggered.forEach(function (s) {
          // 阈值高亮：>50% 红色加粗 / >30% 红色（dim）/ 否则默认
          const passLevel = s.passPct > 50 ? ' level-critical' : (s.passPct > 30 ? ' level-warn' : '');
          html += '<div class="jd-condition-block">' +
            '<div class="reason-row' + passLevel + '">' +
              '<div class="reason-label">' + s.key + '. ' + escapeHtml(s.text) + '</div>' +
              '<div class="reason-bar"><div class="reason-fill" style="width:' + s.passPct + '%"></div></div>' +
              '<div class="reason-num">' + s.passMain + '</div>' +
              '<div class="reason-pct">(' + s.passPct + '%)</div>' +
            '</div>';
          // 只在信息缺 > 0 时显示子行
          if (s.missCount > 0) {
            html += '<div class="reason-row sub-row">' +
              '<div class="reason-label sub-label">　 信息缺</div>' +
              '<div class="reason-bar"><div class="reason-fill miss-fill" style="width:' + s.missPct + '%"></div></div>' +
              '<div class="reason-num">' + s.missCount + '</div>' +
              '<div class="reason-pct">(' + s.missPct + '%)</div>' +
            '</div>';
          }
          html += '</div>';
        });
        if (untriggered.length > 0) {
          html += '<div class="jd-untriggered-hint">其他 ' + untriggered.length + ' 条 M_i 未失败（' +
            untriggered.map(function (s) { return s.key; }).join(' · ') + '）</div>';
        }
      }
    }

    // ===== 次要信息: O_i 命中率（默认折叠）=====
    if (optConditions.length > 0) {
      html += '<details class="jd-opt-details">';
      if (matchedTotal === 0) {
        html += '<summary>🔍 符合候选人特征（O_i 命中率） · 暂无符合人</summary>' +
                '<p class="empty-hint" style="padding:12px;">该范围内暂无符合候选人 — 跑一批符合候选人后回来看</p>';
      } else {
        const hits = optConditions.map(function (c, i) {
          const k = 'O' + (i + 1);
          let count = 0;
          matched.forEach(function (r) {
            const b = r.evaluation && r.evaluation.optionalBreakdown;
            if (b && b[k] && b[k].value === true) count++;
          });
          return { key: k, text: c.text, count: count, pct: safePercent(count, matchedTotal) };
        });
        hits.sort(function (a, b) { return b.count - a.count; });

        html += '<summary>🔍 符合候选人特征（O_i 命中率 · ' + matchedTotal + ' 位符合人中）</summary>';
        hits.forEach(function (item) {
          // 阈值高亮：>70% 绿色加粗（强共同点）
          const hitLevel = item.pct > 70 ? ' level-strong' : '';
          html += '<div class="reason-row' + hitLevel + '">' +
            '<div class="reason-label">' + item.key + '. ' + escapeHtml(item.text) + '</div>' +
            '<div class="reason-bar"><div class="reason-fill match-fill" style="width:' + item.pct + '%"></div></div>' +
            '<div class="reason-num">' + item.count + '</div>' +
            '<div class="reason-pct">(' + item.pct + '%)</div>' +
          '</div>';
        });
      }
      html += '</details>';
    }

    $('view-jd-content').innerHTML = html;
  }

  // v1.1.2：adminJumpUrl helper 已删除（「去 admin 改」跳转按钮整体移除）

  // v1.1.2 简化：未选 JD 时只显示各 JD 符合率横向对比（入口视图）
  // 跨 JD Top pass 原因 aggregate v1.1.2 删除（核心 pass 信息留在单 JD 详细视图）
  function renderJdAggregate(bounds) {
    const opts = { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario() };

    const evals = filterEvaluations(allEvaluationsCache, opts);
    if (evals.length === 0) {
      $('view-jd-content').innerHTML =
        '<p class="empty-hint">该范围内暂无评估样本 — 跑一批后回来看' +
        '<br><span style="font-size:11px;color:var(--text-hint);">（选具体 JD 可看 Top pass 主因 + 符合人特征详细分析）</span></p>';
      return;
    }

    const byJd = {};
    evals.forEach(function (r) {
      const jdId = r.evaluation && r.evaluation.jdId;
      if (!jdId) return;
      if (!byJd[jdId]) {
        byJd[jdId] = {
          jdId: jdId,
          name: (r.evaluation.jdSnapshot && r.evaluation.jdSnapshot.name) || jdId,
          total: 0,
          match: 0
        };
      }
      const stats = byJd[jdId];
      stats.total++;
      if (r.evaluation.decision === '符合') stats.match++;
    });

    const jdList = Object.keys(byJd).map(function (k) { return byJd[k]; });
    jdList.sort(function (a, b) {
      const aRate = a.total > 0 ? a.match / a.total : 0;
      const bRate = b.total > 0 ? b.match / b.total : 0;
      return bRate - aRate;
    });

    let html = '<div class="reason-total">' + currentScopeShort() +
      '范围 · 共 <strong>' + jdList.length + '</strong> 个 JD · 评估 <strong>' + evals.length + '</strong> 人</div>';

    html += '<div class="jd-section-title">📊 各 JD 符合率 ── 点击 JD 名下钻到该 JD 详细分析</div>';
    jdList.forEach(function (s) {
      const rate = safePercent(s.match, s.total);
      html += '<div class="jd-cmp-row" data-jdid="' + escapeHtml(s.jdId) + '">' +
        '<div class="jd-cmp-name" title="点击下钻到该 JD">' + escapeHtml(s.name) + '</div>' +
        '<div class="jd-cmp-stat">' + s.match + '/' + s.total + ' (' + rate + '%)</div>' +
        '<div class="jd-cmp-bar"><div class="fill" style="width:' + rate + '%"></div></div>' +
      '</div>';
    });

    const content = $('view-jd-content');
    content.innerHTML = html;

    content.querySelectorAll('.jd-cmp-name').forEach(function (el) {
      el.addEventListener('click', function () {
        const jdid = el.parentNode.getAttribute('data-jdid');
        const sel = $('jd-filter');
        if (sel) {
          sel.value = jdid;
          currentJobId = jdid;
          resetDrawerState();
          renderAll();
        }
      });
    });
  }

  // ============ 4.D 趋势卡 · v1.1.1 升级 ============
  // 220px 大折线图 + 3 线叠加（判断/符合/招呼）+ Y 轴标尺 + X 轴日期 + hover tooltip
  // 粒度跟时间窗对应 — 日 → 7 天 / 周 → 8 周 / 月 → 6 月

  function renderViewTrend() {
    const titleEl = $('trend-title');
    let bucketCount, bucketMs, fmtLabel, titleText;
    // v1.1.3: 标题简化「7 天趋势 / 8 周趋势 / 6 月趋势」→「天趋势 / 周趋势 / 月趋势」
    if (currentTimeMode === 'week') {
      bucketCount = 8;
      bucketMs = 7 * 86400000;
      fmtLabel = function (start) { return formatMd(start); };
      titleText = '📈 周趋势';
    } else if (currentTimeMode === 'month') {
      bucketCount = 6;
      bucketMs = null;
      fmtLabel = formatYm;
      titleText = '📈 月趋势';
    } else {
      bucketCount = 7;
      bucketMs = 86400000;
      fmtLabel = formatMd;
      titleText = '📈 天趋势';
    }
    if (titleEl) titleEl.textContent = titleText;

    const buckets = buildTrendBuckets(bucketCount, bucketMs);
    const judgedSeries = [];
    const matchSeries = [];
    const sayhiSeries = [];
    const opts = { scenario: currentScenario(), jobId: currentJobId };

    buckets.forEach(function (b) {
      const bucketOpts = Object.assign({}, opts, { timeStart: b.start, timeEnd: b.end });
      const judged = countJudgedCandidates(allEventsCache, bucketOpts);
      const matched = filterEvents(allEventsCache, Object.assign({}, bucketOpts, { stage: 'match_marked' })).length;
      const sayhi = filterEvents(allEventsCache, Object.assign({}, bucketOpts, { stage: 'sayhi_sent' })).length;
      judgedSeries.push(judged);
      matchSeries.push(matched);
      sayhiSeries.push(sayhi);
    });

    const xLabels = buckets.map(function (b) { return fmtLabel(b.start); });

    const content = $('view-trend-content');
    if (!content) return;
    content.innerHTML = renderTrendChart(
      [
        { key: 'judged', label: '判断候选人数', series: judgedSeries, color: '#7c3aed' },
        { key: 'match',  label: '符合数',       series: matchSeries,  color: '#10b981' },
        { key: 'sayhi',  label: '自动招呼',     series: sayhiSeries,  color: '#f59e0b' }
      ],
      xLabels
    );
    attachTrendTooltip(content, xLabels, [judgedSeries, matchSeries, sayhiSeries]);
  }

  function renderTrendChart(serieses, xLabels) {
    const W = 600, H = 180;
    const padL = 36, padR = 16, padT = 12, padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = xLabels.length;

    // Y 轴最大值（向上取整到合适刻度）
    let maxVal = 1;
    serieses.forEach(function (s) {
      s.series.forEach(function (v) { if (v > maxVal) maxVal = v; });
    });
    // 取整到 5 / 10 / 20 / 50 的整倍数（让 Y 轴 label 好看）
    function niceTop(v) {
      const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
      for (let i = 0; i < steps.length; i++) {
        if (v <= steps[i]) return steps[i];
      }
      return Math.ceil(v / 1000) * 1000;
    }
    const yTop = niceTop(maxVal);

    const stepX = n > 1 ? innerW / (n - 1) : innerW;
    function xAt(i) { return padL + i * stepX; }
    function yAt(v) { return padT + innerH - (v / yTop) * innerH; }

    // 4 条 Y 轴网格 + label（0 / 25% / 50% / 75% / 100%）
    let gridHtml = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (ratio) {
      const y = padT + innerH * (1 - ratio);
      const v = Math.round(yTop * ratio);
      gridHtml += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" />';
      gridHtml += '<text class="axis-text" x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
    });

    // X 轴日期 label
    let xAxisHtml = '';
    xLabels.forEach(function (label, i) {
      xAxisHtml += '<text class="axis-text" x="' + xAt(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + escapeHtml(label) + '</text>';
    });

    // 3 系列折线 + 数据点
    let seriesHtml = '';
    serieses.forEach(function (s) {
      const pts = s.series.map(function (v, i) { return xAt(i) + ',' + yAt(v); }).join(' ');
      seriesHtml += '<polyline class="series-line ' + s.key + '" points="' + pts + '" />';
      s.series.forEach(function (v, i) {
        const r = i === s.series.length - 1 ? 4 : 3;
        seriesHtml += '<circle class="series-dot ' + s.key + '" cx="' + xAt(i) + '" cy="' + yAt(v) + '" r="' + r + '" />';
      });
    });

    // hover 元素（默认隐藏，mousemove 时显示）
    const hoverHtml = '<line class="hover-line" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + innerH) + '" style="display:none;" />';

    const legendHtml =
      '<div class="trend-legend">' +
        serieses.map(function (s) {
          return '<div class="trend-legend-item">' +
            '<span class="dot" style="background:' + s.color + ';"></span>' +
            escapeHtml(s.label) +
          '</div>';
        }).join('') +
      '</div>';

    return '<div class="trend-chart">' +
      legendHtml +
      '<svg class="trend-svg-large" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
        'data-pad-l="' + padL + '" data-pad-r="' + padR + '" data-inner-w="' + innerW + '" data-n="' + n + '">' +
        gridHtml + seriesHtml + xAxisHtml + hoverHtml +
      '</svg>' +
      '<div class="trend-tooltip hidden" id="trend-tooltip"></div>' +
    '</div>';
  }

  function attachTrendTooltip(container, xLabels, serieses) {
    const svg = container.querySelector('.trend-svg-large');
    const tooltip = container.querySelector('.trend-tooltip');
    const hoverLine = svg && svg.querySelector('.hover-line');
    if (!svg || !tooltip || !hoverLine) return;

    const n = xLabels.length;
    const padL = parseFloat(svg.getAttribute('data-pad-l')) || 36;
    const innerW = parseFloat(svg.getAttribute('data-inner-w')) || 548;
    const seriesMeta = [
      { color: '#7c3aed', label: '判断' },
      { color: '#10b981', label: '符合' },
      { color: '#f59e0b', label: '招呼' }
    ];

    svg.addEventListener('mousemove', function (ev) {
      const rect = svg.getBoundingClientRect();
      // viewBox 是 600 x 180，但 SVG 自适应 width；用 viewBox 比例换算
      const ratioX = 600 / rect.width;
      const xInSvg = (ev.clientX - rect.left) * ratioX;
      const innerX = xInSvg - padL;
      if (n <= 1 || innerX < 0 || innerX > innerW) {
        tooltip.classList.add('hidden');
        hoverLine.style.display = 'none';
        return;
      }
      const idx = Math.round((innerX / innerW) * (n - 1));
      const snapX = padL + idx * (innerW / (n - 1));
      hoverLine.setAttribute('x1', snapX);
      hoverLine.setAttribute('x2', snapX);
      hoverLine.style.display = 'block';

      let html = '<div class="tt-date">' + escapeHtml(xLabels[idx] || '') + '</div>';
      serieses.forEach(function (s, i) {
        html += '<div class="tt-row">' +
          '<span class="dot" style="background:' + seriesMeta[i].color + ';"></span>' +
          '<span class="tt-label">' + escapeHtml(seriesMeta[i].label) + '</span>' +
          '<span class="tt-value">' + (s[idx] || 0) + '</span>' +
        '</div>';
      });
      tooltip.innerHTML = html;
      tooltip.classList.remove('hidden');
      // 定位 tooltip（避免超出容器右边）
      const tipRect = tooltip.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const snapPx = (snapX / 600) * rect.width;
      let leftPx = snapPx + 12;
      if (leftPx + tipRect.width > rect.width) leftPx = snapPx - tipRect.width - 12;
      tooltip.style.left = leftPx + 'px';
      tooltip.style.top = (rect.top - containerRect.top + 8) + 'px';
    });

    svg.addEventListener('mouseleave', function () {
      tooltip.classList.add('hidden');
      hoverLine.style.display = 'none';
    });
  }

  function buildTrendBuckets(count, bucketMs) {
    const buckets = [];
    if (bucketMs) {
      // 日 / 周 用固定 ms 长度
      const today = startOfDay(new Date());
      if (bucketMs === 86400000) {
        // 日粒度：今天向前 count-1 天
        for (let i = count - 1; i >= 0; i--) {
          const start = today - i * bucketMs;
          buckets.push({ start: start, end: start + bucketMs });
        }
      } else {
        // 周粒度：本周一起向前 count-1 周
        const wb = weekBounds();
        for (let i = count - 1; i >= 0; i--) {
          const start = wb.start - i * bucketMs;
          buckets.push({ start: start, end: start + bucketMs });
        }
      }
    } else {
      // 月粒度：当月起向前 count-1 月
      const now = new Date();
      const cy = now.getFullYear();
      const cm = now.getMonth();
      for (let i = count - 1; i >= 0; i--) {
        const dStart = new Date(cy, cm - i, 1, 0, 0, 0, 0);
        const dEnd = new Date(cy, cm - i + 1, 1, 0, 0, 0, 0);
        buckets.push({ start: dStart.getTime(), end: dEnd.getTime() });
      }
    }
    return buckets;
  }

  // v1.1.1：原 trendRow / renderSparkSvg 已废弃，由 renderTrendChart + attachTrendTooltip 取代

  // ============ 4.E 候选人记录 · v1.1.1 改造 ============
  // 顶部 toolbar：搜索（姓名/reason）+ 决策筛选 + 顶部 tab 切换；翻页 10/页；
  // 行点击展开 row showing M/O breakdown + LLM 完整 reason + 下游动作。
  // CSV 导出仍导全部（不只当前页）

  // ============ v1.1.17 · 批次效率(4.F) ============
  // 数据源:events 表 loop_start/loop_end 配对(payload.batchId 关联)
  // v1.1.20 范围调整:跟看板顶部 scenario tab 联动(推荐流 / 沟通流分开显示),
  //   去掉表内场景列(scenario 由 tab 决定,行内冗余)
  //   仍然**不**按 jobId 过滤 — 沟通页 batch 是多 JD 路由,emit 时 jobId=''
  //   表示"混合 JD",按 jobId 过滤会让沟通页所有批次消失
  function renderViewBatch() {
    const bounds = currentBounds();
    // v1.1.20:加 scenario 过滤跟 tab 联动;jobId 仍不过滤(沟通页多 JD)
    const opts = {
      timeStart: bounds.start,
      timeEnd: bounds.end,
      scenario: currentScenario()
    };
    const filtered = filterEvents(allEventsCache, opts);
    const starts = filtered.filter(function (e) { return e.stage === 'loop_start'; });
    const ends = filtered.filter(function (e) { return e.stage === 'loop_end'; });
    const endByBatchId = {};
    ends.forEach(function (e) {
      const bid = e.payload && e.payload.batchId;
      if (bid) endByBatchId[bid] = e;
    });

    // 配对:同 batchId 的 start + end;只展示已结束批次(end 存在)
    //   未结束批次(running)在 sidepanel 实时速率条已经展示,看板只看完成态
    const batches = [];
    starts.forEach(function (s) {
      const bid = s.payload && s.payload.batchId;
      const end = bid ? endByBatchId[bid] : null;
      if (!end || !end.payload) return;
      batches.push({
        batchId: bid,
        startedAt: s.ts,
        endedAt: end.ts,
        scenario: s.scenario,
        durationMs: end.payload.durationMs || 0,
        processed: end.payload.processed || 0,
        matched: end.payload.matched || 0,
        passed: end.payload.passed || 0,
        endReason: end.payload.endReason || 'completed'
      });
    });
    // 倒序:最新批次在最上
    batches.sort(function (a, b) { return b.startedAt - a.startedAt; });

    const container = $('view-batch-content');
    if (!batches.length) {
      container.innerHTML = '<p class="empty-hint">该范围内暂无完成的批次 — v1.1.17 起新批次会被自动记录,跑一批后回来看</p>';
      return;
    }

    // v1.1.19:文案调整(「开始时间」「处理人数」)+ 删「结束」列 + 删底部汇总
    // v1.1.20:删「场景」列(由顶部 scenario tab 决定,行内冗余)
    //   scenarioBadge 函数保留作未来扩展用
    const rows = batches.map(function (b) {
      const startStr = formatHm(b.startedAt);
      const durStr = formatDuration(b.durationMs);
      const rateStr = b.processed > 0 && b.durationMs > 0
        ? (b.durationMs / b.processed / 1000).toFixed(1) + ' 秒/人'
        : '—';
      const matchPct = b.processed > 0 ? Math.round(b.matched * 100 / b.processed) : 0;
      return '<tr>' +
        '<td>' + escapeHtml(startStr) + '</td>' +
        '<td>' + escapeHtml(durStr) + '</td>' +
        '<td><b>' + b.processed + '</b></td>' +
        '<td>' + b.matched + '</td>' +
        '<td>' + escapeHtml(rateStr) + '</td>' +
        '<td>' + matchPct + '%</td>' +
      '</tr>';
    }).join('');

    container.innerHTML = '<table class="batch-table">' +
      '<thead><tr>' +
        '<th>开始时间</th><th>时长</th><th>处理人数</th>' +
        '<th>符合</th><th>平均速率</th><th>符合率</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
  }

  // 时长格式化:5234ms → "5.2 秒" / 75000ms → "1 分 15 秒" / 3725000ms → "1 小时 2 分"
  function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' 秒';
    const min = Math.floor(sec / 60);
    const secRem = sec % 60;
    if (min < 60) return min + ' 分 ' + secRem + ' 秒';
    const hr = Math.floor(min / 60);
    const minRem = min % 60;
    return hr + ' 小时 ' + minRem + ' 分';
  }

  // 场景 badge:recommend/latest/sayhi-tab → 中文 + 颜色
  function scenarioBadge(scenario) {
    if (scenario === 'recommend') return '<span class="batch-scenario badge-rec">推荐页</span>';
    if (scenario === 'latest') return '<span class="batch-scenario badge-rec">最新池</span>';
    if (scenario === 'sayhi-tab' || scenario === 'chat') return '<span class="batch-scenario badge-chat">沟通页</span>';
    return '<span class="batch-scenario">?</span>';
  }

  // 结束原因 badge
  function endReasonBadge(reason) {
    if (reason === 'completed') return '<span class="batch-reason badge-ok">✓ 完成</span>';
    if (reason === 'aborted') return '<span class="batch-reason badge-warn">⏹ HR 停止</span>';
    if (reason === 'fail_streak') return '<span class="batch-reason badge-err">⚠ 连续失败</span>';
    if (reason === 'error') return '<span class="batch-reason badge-err">✗ 异常</span>';
    return '<span class="batch-reason">' + escapeHtml(String(reason)) + '</span>';
  }

  // ============ v1.1.0 · 候选人记录(4.E) ============
  const DRAWER_PAGE_SIZE = 10;

  function applyDrawerFilter(filter) {
    currentDrawerFilter = filter;
    currentDrawerPage = 0;
    renderViewDrawer();
    const card = $('view-drawer-card');
    if (card && card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function clearDrawerFilter() {
    currentDrawerFilter = null;
    currentDrawerPage = 0;
    renderViewDrawer();
  }

  function renderViewDrawer() {
    const meta = $('drawer-meta');

    // 同步顶部 filter tab active 状态（显示全部 / 仅符合 / 仅 LLM 错判）
    // v1.1.8: 加第三态 marked-wrong;v1.1.16:文案"HR 标错"→"LLM 错判"
    const filterTabs = $('drawer-filter-tabs');
    if (filterTabs) {
      let activeFilter = 'all';
      if (currentDrawerFilter && currentDrawerFilter.decision === '符合') activeFilter = 'match';
      else if (currentDrawerFilter && currentDrawerFilter.markedWrong) activeFilter = 'marked-wrong';
      filterTabs.querySelectorAll('.drawer-filter-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-filter') === activeFilter);
      });
    }

    const bounds = currentBounds();
    const opts = { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId, statusDone: true };

    // 1) 应用 decision / action filter（4.B 点击数字 / drawer-filter-tab）
    let evals = filterEvaluations(allEvaluationsCache, opts);
    let filterLabel = '';
    if (currentDrawerFilter) {
      if (currentDrawerFilter.decision) {
        evals = evals.filter(function (r) { return r.evaluation && r.evaluation.decision === currentDrawerFilter.decision; });
        filterLabel = ' · 决策=' + currentDrawerFilter.decision;
      } else if (currentDrawerFilter.action === 'sayhi') {
        const sayhiEvents = filterEvents(allEventsCache, { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId, stage: 'sayhi_sent' });
        const ids = {};
        sayhiEvents.forEach(function (e) { if (e.candidateId) ids[e.candidateId] = true; });
        evals = evals.filter(function (r) { return ids[r.candidateId]; });
        filterLabel = ' · 已自动招呼';
      } else if (currentDrawerFilter.markedWrong) {
        // v1.1.8: HR 反馈通道筛选 — 只看 HR 标 LLM 错判的(v1.1.16 文案统一)
        evals = evals.filter(function (r) { return r.hrFeedback && r.hrFeedback.markedWrong; });
        filterLabel = ' · 🚩 LLM 错判';
      }
    }

    // 2) 应用 search filter（姓名 / reason 关键字匹配）
    const search = (currentDrawerSearch || '').trim().toLowerCase();
    if (search) {
      evals = evals.filter(function (r) {
        const c = r.candidate || {};
        const basic = c.basic || {};
        const e = r.evaluation || {};
        const name = String(basic.name || '').toLowerCase();
        const reason = String(e.reason || '').toLowerCase();
        return name.indexOf(search) !== -1 || reason.indexOf(search) !== -1;
      });
      filterLabel += ' · 搜「' + currentDrawerSearch + '」';
    }

    const total = evals.length;
    const jdName = currentJobId
      ? ((evals[0] && evals[0].evaluation && evals[0].evaluation.jdSnapshot && evals[0].evaluation.jdSnapshot.name) || currentJobId)
      : '全部 JD';

    if (meta) {
      const isActionFilter = currentDrawerFilter && currentDrawerFilter.action;
      meta.textContent = jdName + ' · ' + currentScopeShort() + '范围' + filterLabel +
        '（共 ' + total + ' 人）' +
        (isActionFilter ? ' [点这里取消筛选]' : '');
      meta.style.cursor = isActionFilter ? 'pointer' : 'default';
      meta.onclick = isActionFilter ? function () { clearDrawerFilter(); } : null;
    }

    // 倒序排
    evals.sort(function (a, b) {
      return ((b.evaluation && b.evaluation.judgedAt) || 0) - ((a.evaluation && a.evaluation.judgedAt) || 0);
    });

    // 3) Toolbar HTML
    const toolbarHtml =
      '<div class="drawer-toolbar">' +
        '<div class="drawer-search">' +
          '<input id="drawer-search-input" type="text" placeholder="搜索候选人姓名 / reason 关键字" value="' + escapeHtml(currentDrawerSearch || '') + '" />' +
        '</div>' +
        '<button id="drawer-export-csv" class="drawer-select">📥 导出 CSV (' + total + ')</button>' +
      '</div>';

    if (total === 0) {
      $('view-drawer-content').innerHTML = toolbarHtml + '<p class="empty-hint">该范围内暂无候选人 — 跑一批后回来看</p>';
      bindDrawerToolbar(evals);
      return;
    }

    // 4) 翻页
    const totalPages = Math.max(1, Math.ceil(total / DRAWER_PAGE_SIZE));
    if (currentDrawerPage >= totalPages) currentDrawerPage = totalPages - 1;
    if (currentDrawerPage < 0) currentDrawerPage = 0;
    const pageStart = currentDrawerPage * DRAWER_PAGE_SIZE;
    const pageEnd = Math.min(pageStart + DRAWER_PAGE_SIZE, total);
    const shown = evals.slice(pageStart, pageEnd);

    // 5) 表格 HTML（每行可点击展开）
    // v1.1.8: 加「LLM 错判」列 + 标错的 row 整行红色高亮(v1.1.16 文案统一,原 "HR 标错")
    // v1.1.16: col-hr-flag 单元格升级为可点击按钮(HR 在看板复盘时直接标错/取消,不用回 sidepanel)
    const trs = shown.map(function (r, i) {
      const c = r.candidate || {};
      const basic = c.basic || {};
      const e = r.evaluation || {};
      const dec = e.decision === '符合' ? 'match' : (e.decision === 'pass' ? 'pass' : '');
      const decLabel = e.decision === '符合' ? '✅ 符合' : (e.decision === 'pass' ? '⛔ pass' : (e.status || '?'));
      const reason = e.reason || '';
      const name = basic.name || '(无名)';
      const age = basic.age ? ' (' + basic.age + ')' : '';
      const jd = (e.jdSnapshot && e.jdSnapshot.name) || e.jdId || '-';
      const rowId = 'drawer-row-' + (pageStart + i);
      const expandRow = renderRowExpand(r);
      const markedWrong = !!(r.hrFeedback && r.hrFeedback.markedWrong);
      const rowCls = markedWrong ? 'drawer-row hr-marked-wrong' : 'drawer-row';
      // v1.1.16:col-hr-flag 单元格升级为可点击按钮,HR 在看板复盘时直接 toggle 标错状态(不用回 sidepanel)
      //   未标错 → 「标错」普通按钮;已标错 → 「🚩 ⚠已标错」红色按钮 + 点击取消
      //   data-candidate-id 给事件委托用(避免给每行单独绑 listener)
      const markerCell = markedWrong
        ? '<td class="col-hr-flag"><button class="drawer-mark-wrong-btn marked" ' +
            'data-candidate-id="' + escapeHtml(String(r.candidateId)) + '" ' +
            'title="LLM 错判（HR 已标记）· 点击取消">🚩 ⚠已标错</button></td>'
        : '<td class="col-hr-flag"><button class="drawer-mark-wrong-btn" ' +
            'data-candidate-id="' + escapeHtml(String(r.candidateId)) + '" ' +
            'title="标记 LLM 错判">标错</button></td>';

      return '<tr class="' + rowCls + '" data-row-id="' + rowId + '">' +
        '<td class="col-time">' + formatHm(e.judgedAt || e.startedAt || r.capturedAt) + '</td>' +
        '<td class="col-name"><b>' + escapeHtml(name) + '</b>' + escapeHtml(age) + '</td>' +
        '<td>' + escapeHtml(jd) + '</td>' +
        '<td class="col-decision ' + dec + '"><span class="dec-tag ' + dec + '">' + escapeHtml(decLabel) + '</span></td>' +
        markerCell +
        '<td class="col-reason">' + escapeHtml(reason.length > 60 ? reason.slice(0, 60) + '…' : reason) + ' ▾</td>' +
      '</tr>' +
      '<tr class="drawer-row-expand hidden" data-row-id="' + rowId + '" style="display:none;">' +
        '<td colspan="6" class="row-expand-cell">' + expandRow + '</td>' +
      '</tr>';
    }).join('');

    const tableHtml = '<table class="drawer-table">' +
      '<thead><tr><th>时间</th><th>候选人</th><th>JD</th><th>决策</th><th class="col-hr-flag">LLM 错判</th><th>关键 reason（点行展开）</th></tr></thead>' +
      '<tbody>' + trs + '</tbody>' +
    '</table>';

    // 6) Pager
    const pagerHtml = renderPager(currentDrawerPage, totalPages, pageStart + 1, pageEnd, total);

    $('view-drawer-content').innerHTML = toolbarHtml + tableHtml + pagerHtml;
    bindDrawerToolbar(evals);
    bindDrawerRows();
    bindDrawerPager(totalPages);
  }

  function renderRowExpand(r) {
    const c = r.candidate || {};
    const e = r.evaluation || {};
    const must = e.mustBreakdown || {};
    const opt = e.optionalBreakdown || {};

    let mustHtml = '';
    Object.keys(must).forEach(function (k) {
      const item = must[k];
      const ok = item && item.value === true;
      mustHtml += '<span class="breakdown-item ' + (ok ? 'match' : 'miss') + '">' +
        escapeHtml(k) + ' ' + (ok ? '✓' : '✗') +
      '</span>';
    });
    if (!mustHtml) mustHtml = '<span class="reason-text" style="color:var(--text-hint);">（无 mustBreakdown 数据）</span>';

    let optHtml = '';
    Object.keys(opt).forEach(function (k) {
      const item = opt[k];
      const ok = item && item.value === true;
      optHtml += '<span class="breakdown-item ' + (ok ? 'match' : 'miss') + '">' +
        escapeHtml(k) + ' ' + (ok ? '✓' : '✗') +
      '</span>';
    });
    if (!optHtml) optHtml = '<span class="reason-text" style="color:var(--text-hint);">（无 optionalBreakdown 数据）</span>';

    const reasonText = e.reason || '（无 LLM reason）';
    const cidAttr = escapeHtml(r.candidateId || '');

    return '<div class="row-expand">' +
      '<div class="row-expand-section"><span class="label">必要条件 M</span>' + mustHtml + '</div>' +
      '<div class="row-expand-section"><span class="label">可选条件 O</span>' + optHtml + '</div>' +
      '<div class="row-expand-section"><span class="label">LLM reason</span><span class="reason-text">' + escapeHtml(reasonText) + '</span></div>' +
      '<div class="row-expand-section">' +
        '<button class="btn-view-detail" data-candidate-id="' + cidAttr + '">📋 查看完整资料</button>' +
      '</div>' +
    '</div>';
  }

  // ============ v1.1.5：候选人详情 modal ============
  // 行展开「📋 查看完整资料」按钮触发,显示 IDB 里该候选人完整字段
  // 3 个 Tab:基础资料(basic+expectation+bossSignals) / 履历(workHistory+education) / LLM 评估(完整 breakdown+jdSnapshot+元数据)

  let currentDetailRecord = null;     // 当前 modal 显示的 record
  let currentDetailTab = 'profile';   // 'profile' | 'resume' | 'eval'

  function openDetailModal(candidateId) {
    const record = allEvaluationsCache.find(function (r) { return r.candidateId === candidateId; });
    if (!record) {
      console.warn('[Dashboard] detail modal: record not found for', candidateId);
      return;
    }
    currentDetailRecord = record;
    currentDetailTab = 'profile';
    const modal = $('detail-modal');
    if (modal) modal.classList.remove('hidden');
    const titleEl = $('detail-modal-title');
    const basic = (record.candidate && record.candidate.basic) || {};
    if (titleEl) titleEl.textContent = '候选人完整资料 · ' + (basic.name || '(无名)');
    document.querySelectorAll('.detail-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === currentDetailTab);
    });
    renderDetailModalBody();
  }

  function closeDetailModal() {
    const modal = $('detail-modal');
    if (modal) modal.classList.add('hidden');
    currentDetailRecord = null;
  }

  function renderDetailModalBody() {
    const body = $('detail-modal-body');
    if (!body || !currentDetailRecord) return;
    if (currentDetailTab === 'profile') {
      body.innerHTML = renderDetailProfile(currentDetailRecord);
    } else if (currentDetailTab === 'resume') {
      body.innerHTML = renderDetailResume(currentDetailRecord);
    } else if (currentDetailTab === 'eval') {
      body.innerHTML = renderDetailEval(currentDetailRecord);
    }
  }

  // Tab 1: 基础资料(候选人 basic + greeting + expectation + bossSignals + source 元数据)
  // v1.1.6: 补全 extractor.js 全部抓取字段
  function renderDetailProfile(r) {
    const c = r.candidate || {};
    const basic = c.basic || {};
    const exp = c.expectation || {};
    const signals = c.bossSignals || {};
    const greeting = c.greeting || null;
    const source = c.source || {};

    // 头像(如有)
    const avatarHtml = basic.avatar
      ? '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
          '<img src="' + escapeHtml(basic.avatar) + '" alt="avatar" style="width:48px;height:48px;border-radius:50%;border:1px solid var(--border);">' +
          '<div><strong>' + escapeHtml(basic.name || '(无名)') + '</strong>' +
            (basic.age ? ' · ' + escapeHtml(basic.age) : '') +
            (basic.gender ? ' · ' + escapeHtml(String(basic.gender)) : '') +
          '</div>' +
        '</div>'
      : '';

    // 候选人自我介绍 / 沟通页招呼(basic.desc) — 长文本独立段
    const descHtml = basic.desc
      ? '<div class="detail-section">' +
          '<div class="detail-section-title">候选人自述 / 招呼正文</div>' +
          '<p style="font-size:13px;line-height:1.6;white-space:pre-wrap;background:var(--bg);padding:10px 14px;border-radius:6px;border-left:3px solid var(--brand);">' +
            escapeHtml(basic.desc) +
          '</p>' +
        '</div>'
      : '';

    // 沟通页招呼(独立 greeting 对象,与 basic.desc 可能重叠或互补)
    const greetingHtml = (greeting && greeting.content)
      ? '<div class="detail-section">' +
          '<div class="detail-section-title">沟通页主动招呼</div>' +
          '<p style="font-size:13px;line-height:1.6;white-space:pre-wrap;background:var(--bg);padding:10px 14px;border-radius:6px;border-left:3px solid var(--warn);">' +
            escapeHtml(greeting.content) +
          '</p>' +
          (greeting.sentAt
            ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">发送时间:' + escapeHtml(new Date(greeting.sentAt).toLocaleString()) + '</div>'
            : '') +
        '</div>'
      : '';

    return avatarHtml +
      '<div class="detail-section">' +
        '<div class="detail-section-title">基础信息</div>' +
        '<div class="detail-field-grid">' +
          kvField('姓名', basic.name) +
          kvField('年龄', basic.age) +
          kvField('性别', basic.gender) +
          kvField('学历', basic.education) +
          kvField('工作年限', basic.yearsOfExperience) +
          kvField('当前城市', basic.city) +
          kvField('活跃状态', basic.activeStatus) +
          kvField('应届毕业', basic.freshGraduate) +
          kvField('候选人 ID', r.candidateId) +
        '</div>' +
      '</div>' +
      descHtml +
      greetingHtml +
      '<div class="detail-section">' +
        '<div class="detail-section-title">期望</div>' +
        '<div class="detail-field-grid">' +
          kvField('候选人自报职位', exp.candidateOwn) +
          kvField('招呼对齐职位', exp.jobAligned) +
          kvField('期望薪资', exp.salaryDesc) +
          kvField('薪资下限', exp.salaryLow) +
          kvField('薪资上限', exp.salaryHigh) +
          kvField('期望城市', exp.cityName) +
          kvField('求职意向类型', exp.expectType) +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<div class="detail-section-title">BOSS 信号</div>' +
        '<div class="detail-field-grid">' +
          kvField('求职状态', signals.applyStatus) +
          kvField('上次活跃', signals.lastTime) +
          kvField('双向沟通', signals.bothTalked === true ? '是' : (signals.bothTalked === false ? '否' : null)) +
          kvField('已查看', signals.viewed === true ? '是' : (signals.viewed === false ? '否' : null)) +
          kvField('关系类型', signals.relationType) +
          kvField('最近公司', signals.lastCompany) +
          kvField('最近职位', signals.lastPosition) +
          kvField('做过的岗位', Array.isArray(signals.everWorkPositionNameList) ? signals.everWorkPositionNameList.join(' / ') : null) +
        '</div>' +
        // 长文本字段独占行
        (signals.recommendReason
          ? '<div class="detail-field" style="margin-top:6px;">' +
              '<span class="detail-field-label">BOSS 推荐理由</span>' +
              '<span class="detail-field-value">' + escapeHtml(signals.recommendReason) + '</span>' +
            '</div>'
          : '') +
        (signals.highlightWords
          ? '<div class="detail-field">' +
              '<span class="detail-field-label">BOSS 亮点词</span>' +
              '<span class="detail-field-value">' + escapeHtml(formatHighlightWords(signals.highlightWords)) + '</span>' +
            '</div>'
          : '') +
        (signals.markWords
          ? '<div class="detail-field">' +
              '<span class="detail-field-label">BOSS Mark 词</span>' +
              '<span class="detail-field-value">' + escapeHtml(formatHighlightWords(signals.markWords)) + '</span>' +
            '</div>'
          : '') +
      '</div>' +
      // 源元数据(开发用,默认折叠)
      '<details class="detail-section" style="border-top:1px dashed var(--border);padding-top:10px;">' +
        '<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);">📍 数据源元数据(开发用)</summary>' +
        '<div class="detail-field-grid" style="margin-top:8px;">' +
          kvField('scenario', source.scenario) +
          kvField('apiPath', source.apiPath) +
          kvField('batchAt', source.batchAt ? new Date(source.batchAt).toLocaleString() : null) +
          kvField('indexInBatch', source.indexInBatch) +
          kvField('encryptUid', c.encryptUid) +
        '</div>' +
      '</details>';
  }

  // 帮 highlightWords / markWords 渲染:可能是 string / array / null
  function formatHighlightWords(v) {
    if (Array.isArray(v)) return v.join(' · ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v || '');
  }

  // Tab 2: 履历(workHistory + education + BOSS 简历卡 + DOM 扫描资料)
  // v1.1.6: 补全 education.eduDescription / eduType + bossSignals.resumeCard + domDetail
  function renderDetailResume(r) {
    const c = r.candidate || {};
    const works = Array.isArray(c.workHistory) ? c.workHistory : [];
    const edus = Array.isArray(c.education) ? c.education : [];
    const signals = c.bossSignals || {};
    const resumeCard = signals.resumeCard || null;
    const domDetail = signals.domDetail || null;

    let workHtml;
    if (works.length === 0) {
      workHtml = '<p class="empty-hint">（无工作经历数据）</p>';
    } else {
      workHtml = works.map(function (w) {
        const sub = [w.industry, w.workType ? '类型:' + w.workType : null, w.workMonths ? w.workMonths + ' 个月' : null]
          .filter(function (x) { return x; }).join(' · ');
        return '<div class="detail-history-card">' +
          '<div class="hc-head">' +
            '<span class="hc-title">' + escapeHtml(w.company || '(无公司)') + ' · ' + escapeHtml(w.title || '(无职位)') + '</span>' +
            '<span class="hc-time">' + escapeHtml(w.timeDesc || ((w.from || '?') + ' - ' + (w.to || '?'))) + '</span>' +
          '</div>' +
          (sub ? '<div class="hc-sub">' + escapeHtml(sub) + '</div>' : '') +
          (w.description ? '<div class="hc-desc">' + escapeHtml(w.description) + '</div>' : '') +
        '</div>';
      }).join('');
    }

    let eduHtml;
    if (edus.length === 0) {
      eduHtml = '<p class="empty-hint">（无教育经历数据）</p>';
    } else {
      eduHtml = edus.map(function (e) {
        // v1.1.6: sub 行加 eduType(全日制/非全日制)
        const sub = [e.major, e.degree, e.eduType].filter(function (x) { return x; }).join(' · ');
        return '<div class="detail-history-card">' +
          '<div class="hc-head">' +
            '<span class="hc-title">' + escapeHtml(e.school || '(无学校)') + '</span>' +
            '<span class="hc-time">' + escapeHtml((e.from || '?') + ' - ' + (e.to || '?')) + '</span>' +
          '</div>' +
          (sub ? '<div class="hc-sub">' + escapeHtml(sub) + '</div>' : '') +
          // v1.1.6: eduDescription(留学/GPA 等强证据)
          (e.eduDescription ? '<div class="hc-desc">' + escapeHtml(e.eduDescription) + '</div>' : '') +
        '</div>';
      }).join('');
    }

    // v1.1.6: BOSS 推送简历卡(沟通页 chat history type=3 bizType=21050004)
    let resumeCardHtml = '';
    if (resumeCard) {
      const expList = Array.isArray(resumeCard.experiences) ? resumeCard.experiences : [];
      const expCardsHtml = expList.length > 0
        ? expList.map(function (x) {
            const sub = [x.startDate, x.endDate].filter(function (v) { return v; }).join(' - ');
            return '<div class="detail-history-card">' +
              '<div class="hc-head">' +
                '<span class="hc-title">' + escapeHtml(x.organization || '(无组织)') + ' · ' + escapeHtml(x.occupation || '(无职位)') + '</span>' +
                (sub ? '<span class="hc-time">' + escapeHtml(sub) + '</span>' : '') +
              '</div>' +
              (x.type ? '<div class="hc-sub">类型:' + escapeHtml(String(x.type)) + '</div>' : '') +
            '</div>';
          }).join('')
        : '<p class="empty-hint">（无 experiences 数据）</p>';

      resumeCardHtml = '<details class="detail-section" style="border-top:1px dashed var(--border);padding-top:10px;" open>' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--brand);">📇 BOSS 推送简历卡（沟通页 IM 消息）</summary>' +
        '<div class="detail-field-grid" style="margin-top:10px;">' +
          kvField('姓名', resumeCard.name) +
          kvField('年龄', resumeCard.age) +
          kvField('性别', resumeCard.gender) +
          kvField('学历', resumeCard.education) +
          kvField('工作年限', resumeCard.workYear) +
          kvField('当前城市', resumeCard.city) +
          kvField('期望薪资', resumeCard.salary) +
          kvField('期望职位', resumeCard.position) +
          kvField('职位类目', resumeCard.positionCategory) +
          kvField('求职状态', resumeCard.applyStatus) +
        '</div>' +
        (resumeCard.content1 ? '<div class="detail-field" style="margin-top:6px;"><span class="detail-field-label">摘要 1</span><span class="detail-field-value">' + escapeHtml(resumeCard.content1) + '</span></div>' : '') +
        (resumeCard.content2 ? '<div class="detail-field"><span class="detail-field-label">摘要 2</span><span class="detail-field-value">' + escapeHtml(resumeCard.content2) + '</span></div>' : '') +
        (resumeCard.content3 ? '<div class="detail-field"><span class="detail-field-label">摘要 3</span><span class="detail-field-value">' + escapeHtml(resumeCard.content3) + '</span></div>' : '') +
        (resumeCard.bottomText ? '<div class="detail-field"><span class="detail-field-label">底部文案</span><span class="detail-field-value">' + escapeHtml(resumeCard.bottomText) + '</span></div>' : '') +
        '<div class="detail-section-title" style="margin-top:14px;">简历卡内 experiences 数组</div>' +
        expCardsHtml +
      '</details>';
    }

    // v1.1.6: DOM 扫描资料(沟通页 POC A7 详情面板扫描)
    // v1.1.13 UI fix:① 标题去掉「POC A7 回灌」开发用词 ② 不再折叠,默认展开
    //   HR 反馈: POC A7 是开发记号 HR 不需要看; 默认折叠会让 HR 多点一次
    let domDetailHtml = '';
    if (domDetail) {
      domDetailHtml = '<div class="detail-section" style="border-top:1px dashed var(--border);padding-top:10px;">' +
        '<div class="detail-section-title">🔍 沟通页 DOM 扫描资料</div>' +
        '<div class="detail-field-grid" style="margin-top:10px;">' +
          kvField('扫描时间', domDetail.scannedAt ? new Date(domDetail.scannedAt).toLocaleString() : null) +
          kvField('候选人名', domDetail.candidateName) +
          kvField('基础信息', domDetail.baseStats) +
        '</div>' +
        (domDetail.expect
          ? '<div class="detail-field" style="margin-top:6px;"><span class="detail-field-label">期望原文</span><span class="detail-field-value">' +
              escapeHtml(JSON.stringify(domDetail.expect)) +
            '</span></div>'
          : '') +
        (domDetail.workEduText
          ? '<div class="detail-field"><span class="detail-field-label">工作教育文本</span><span class="detail-field-value" style="white-space:pre-wrap;">' + escapeHtml(domDetail.workEduText) + '</span></div>'
          : '') +
        (domDetail.resumeCardText
          ? '<div class="detail-field"><span class="detail-field-label">简历卡文本</span><span class="detail-field-value" style="white-space:pre-wrap;">' + escapeHtml(domDetail.resumeCardText) + '</span></div>'
          : '') +
        (domDetail.resumeFullText
          ? '<div class="detail-section-title" style="margin-top:14px;">在线简历完整文本（iframe.textContent）</div>' +
            '<p style="font-size:12px;line-height:1.6;white-space:pre-wrap;background:var(--bg);padding:10px 14px;border-radius:6px;max-height:300px;overflow-y:auto;">' +
              escapeHtml(domDetail.resumeFullText) +
            '</p>'
          : (domDetail.resumeScanError
              ? '<div class="detail-field" style="margin-top:8px;"><span class="detail-field-label">简历扫描错误</span><span class="detail-field-value" style="color:var(--pass);">' + escapeHtml(domDetail.resumeScanError) + '</span></div>'
              : '')) +
      '</div>';
    }

    return '<div class="detail-section">' +
      '<div class="detail-section-title">工作经历（' + works.length + ' 条）</div>' +
      workHtml +
    '</div>' +
    '<div class="detail-section">' +
      '<div class="detail-section-title">教育经历（' + edus.length + ' 条）</div>' +
      eduHtml +
    '</div>' +
    resumeCardHtml +
    domDetailHtml;
  }

  // Tab 3: LLM 评估(完整 mustBreakdown + optionalBreakdown + jdSnapshot + 元数据)
  function renderDetailEval(r) {
    const e = r.evaluation || {};
    const must = e.mustBreakdown || {};
    const opt = e.optionalBreakdown || {};
    const snap = e.jdSnapshot || {};
    const mustConds = Array.isArray(snap.mustConditions) ? snap.mustConditions : [];
    const optConds = Array.isArray(snap.optionalConditions) ? snap.optionalConditions : [];

    function breakdownLevel(item) {
      if (!item) return 'unknown';
      if (item.value === true) return 'match';
      if (item.value === false) return 'miss';
      return 'unknown';
    }
    function breakdownValueLabel(item) {
      if (!item) return '?';
      if (item.value === true) return '✓ 通过';
      if (item.value === false) return '✗ 不通过';
      return '? 信息缺';
    }
    function renderBreakdown(conditions, breakdown, prefix) {
      if (conditions.length === 0) {
        return '<p class="empty-hint">（该 JD 未配置' + (prefix === 'M' ? '必要' : '可选') + '条件）</p>';
      }
      return conditions.map(function (cond, i) {
        const key = prefix + (i + 1);
        const item = breakdown[key];
        const level = breakdownLevel(item);
        const valLabel = breakdownValueLabel(item);
        const llmReason = (item && item.reason) || '（无 LLM 子推理）';
        return '<div class="detail-breakdown-item ' + level + '">' +
          '<div class="bk-head">' +
            '<span class="bk-key">' + key + ' · ' + escapeHtml(cond.text || '(无条件文本)') + '</span>' +
            '<span class="bk-value">' + valLabel + '</span>' +
          '</div>' +
          '<div class="bk-reason">' + escapeHtml(llmReason) + '</div>' +
        '</div>';
      }).join('');
    }

    const usage = e.usage || {};
    const latencyText = e.latencyMs ? (e.latencyMs / 1000).toFixed(2) + 's' : '-';
    const usageText = (usage.promptTokens || usage.completionTokens)
      ? 'prompt=' + (usage.promptTokens || '?') + ' / completion=' + (usage.completionTokens || '?')
      : '-';

    return '<div class="detail-section">' +
      '<div class="detail-section-title">决策摘要</div>' +
      '<div class="detail-field-grid">' +
        kvField('决策', e.decision === '符合' ? '✅ 符合' : (e.decision === 'pass' ? '⛔ pass' : (e.status || '?'))) +
        kvField('JD', snap.name || e.jdId || '-') +
        kvField('LLM 模型', e.modelId || '-') +
        kvField('Provider', e.provider || '-') +
        kvField('评估耗时', latencyText) +
        kvField('Token 用量', usageText) +
        kvField('重试次数', e.attempts) +
        kvField('评估完成时间', e.judgedAt ? new Date(e.judgedAt).toLocaleString() : '-') +
      '</div>' +
    '</div>' +
    '<div class="detail-section">' +
      '<div class="detail-section-title">LLM 最终理由</div>' +
      '<p style="font-size:13px;line-height:1.6;white-space:pre-wrap;">' + escapeHtml(e.reason || '（无 LLM reason）') + '</p>' +
    '</div>' +
    '<div class="detail-section">' +
      '<div class="detail-section-title">必要条件 M_i 详细（含 LLM 子推理）</div>' +
      renderBreakdown(mustConds, must, 'M') +
    '</div>' +
    '<div class="detail-section">' +
      '<div class="detail-section-title">可选条件 O_i 详细（含 LLM 子推理）</div>' +
      renderBreakdown(optConds, opt, 'O') +
    '</div>';
  }

  function kvField(label, value) {
    const empty = (value === null || value === undefined || value === '' || value === '-');
    const v = empty ? '—' : String(value);
    return '<div class="detail-field">' +
      '<span class="detail-field-label">' + escapeHtml(label) + '</span>' +
      '<span class="detail-field-value' + (empty ? ' empty' : '') + '">' + escapeHtml(v) + '</span>' +
    '</div>';
  }

  function bindDetailModalGlobal() {
    // 关闭按钮
    const closeBtn = $('detail-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDetailModal);
    // overlay 点击关闭
    const overlay = $('detail-modal-overlay');
    if (overlay) overlay.addEventListener('click', closeDetailModal);
    // ESC 关闭
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeDetailModal();
    });
    // Tab 切换
    document.querySelectorAll('.detail-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentDetailTab = btn.getAttribute('data-tab') || 'profile';
        document.querySelectorAll('.detail-tab').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        renderDetailModalBody();
      });
    });
  }

  function renderPager(curPage, totalPages, fromIdx, toIdx, total) {
    if (totalPages <= 1) {
      return '<div class="drawer-pager"><span class="pager-info">共 ' + total + ' 人（' + fromIdx + '-' + toIdx + '）</span></div>';
    }
    // 显示 ≤ 7 页码（首尾 + 当前页前后 2 页）
    const pages = [];
    const showWindow = 2;
    let added = new Set();
    function add(p) { if (p >= 0 && p < totalPages && !added.has(p)) { added.add(p); pages.push(p); } }
    add(0);
    for (let i = curPage - showWindow; i <= curPage + showWindow; i++) add(i);
    add(totalPages - 1);
    pages.sort(function (a, b) { return a - b; });

    let html = '<div class="drawer-pager">';
    html += '<button data-page="prev"' + (curPage === 0 ? ' disabled' : '') + '>«</button>';
    let prev = -1;
    pages.forEach(function (p) {
      if (prev !== -1 && p - prev > 1) html += '<span class="pager-info">…</span>';
      html += '<button data-page="' + p + '"' + (p === curPage ? ' class="active"' : '') + '>' + (p + 1) + '</button>';
      prev = p;
    });
    html += '<button data-page="next"' + (curPage === totalPages - 1 ? ' disabled' : '') + '>»</button>';
    html += '<span class="pager-info">' + fromIdx + '-' + toIdx + ' / ' + total + '</span>';
    html += '</div>';
    return html;
  }

  function bindDrawerToolbar(evals) {
    const input = $('drawer-search-input');
    if (input) {
      // debounce 300ms
      let timer = null;
      input.addEventListener('input', function (ev) {
        clearTimeout(timer);
        const val = ev.target.value;
        timer = setTimeout(function () {
          currentDrawerSearch = val;
          currentDrawerPage = 0;
          renderViewDrawer();
          // 重渲后 input 失焦,需要恢复光标
          const newInput = $('drawer-search-input');
          if (newInput) { newInput.focus(); newInput.setSelectionRange(val.length, val.length); }
        }, 300);
      });
    }
    const btnCsv = $('drawer-export-csv');
    if (btnCsv) {
      btnCsv.addEventListener('click', function (ev) {
        ev.preventDefault();
        exportDrawerCsv(evals);
      });
    }
  }

  function bindDrawerRows() {
    document.querySelectorAll('tr.drawer-row').forEach(function (row) {
      row.addEventListener('click', function () {
        const rowId = row.getAttribute('data-row-id');
        const expandRow = document.querySelector('tr.drawer-row-expand[data-row-id="' + rowId + '"]');
        if (!expandRow) return;
        const isOpen = !expandRow.classList.contains('hidden');
        if (isOpen) {
          expandRow.classList.add('hidden');
          expandRow.style.display = 'none';
          row.classList.remove('expanded');
        } else {
          expandRow.classList.remove('hidden');
          expandRow.style.display = '';
          row.classList.add('expanded');
        }
      });
    });

    // v1.1.5: 行展开内「📋 查看完整资料」按钮(阻止冒泡避免触发 row toggle)
    document.querySelectorAll('.btn-view-detail').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const cid = btn.getAttribute('data-candidate-id');
        if (cid) openDetailModal(cid);
      });
    });

    // v1.1.16: 看板「标错 / ⚠已标错」按钮 — 复用 sidepanel 同款 MARK_LLM_WRONG/UNMARK 协议
    //   阻止冒泡(避免触发 row 展开)。请求成功后局部更新该行 UI + patch allEvaluationsCache,
    //   不重渲整表(避免筛选状态下错位)。失败回滚 UI 状态 + console.warn。
    document.querySelectorAll('.drawer-mark-wrong-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        if (btn.dataset.busy === '1') return;
        const cid = btn.getAttribute('data-candidate-id');
        if (!cid) return;
        const wasMarked = btn.classList.contains('marked');
        const willMark = !wasMarked;
        btn.dataset.busy = '1';
        btn.style.opacity = '0.5';
        try {
          const type = willMark ? BossMessageTypes.MARK_LLM_WRONG : BossMessageTypes.UNMARK_LLM_WRONG;
          const resp = await chrome.runtime.sendMessage({ type: type, candidateId: cid });
          if (resp && resp.ok) {
            // 局部更新 UI:按钮态 + 所在 row 红底
            btn.classList.toggle('marked', willMark);
            btn.textContent = willMark ? '🚩 ⚠已标错' : '标错';
            btn.title = willMark ? 'LLM 错判（HR 已标记）· 点击取消' : '标记 LLM 错判';
            const row = btn.closest('tr.drawer-row');
            if (row) row.classList.toggle('hr-marked-wrong', willMark);
            // 同步 patch cache,下次重渲(分页/筛选切换)读到新状态
            const rec = allEvaluationsCache.find(function (r) {
              return String(r.candidateId) === String(cid);
            });
            if (rec) {
              if (willMark) {
                rec.hrFeedback = { markedWrong: true, submittedAt: Date.now() };
              } else {
                delete rec.hrFeedback;
              }
            }
          } else {
            console.warn('[dashboard mark-wrong] failed:', resp && resp.error);
          }
        } catch (err) {
          console.warn('[dashboard mark-wrong] exception:', err);
        } finally {
          btn.dataset.busy = '';
          btn.style.opacity = '';
        }
      });
    });
  }

  function bindDrawerPager(totalPages) {
    document.querySelectorAll('.drawer-pager button[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const v = btn.getAttribute('data-page');
        if (v === 'prev') currentDrawerPage--;
        else if (v === 'next') currentDrawerPage++;
        else currentDrawerPage = parseInt(v, 10);
        if (currentDrawerPage < 0) currentDrawerPage = 0;
        if (currentDrawerPage >= totalPages) currentDrawerPage = totalPages - 1;
        renderViewDrawer();
      });
    });
  }

  // v1.1.5: CSV 扩展业务级字段 5 列 → 11 列
  //   保持 Excel 友好,workHistory / education 数组不放 CSV(在详情 modal 看)
  function exportDrawerCsv(rows) {
    const header = [
      'time', 'name', 'age', 'gender', 'education', 'yearsOfExperience',
      'city', 'expectedSalary', 'expectedPosition', 'jdName', 'decision', 'reason'
    ];
    const lines = [header.join(',')];
    rows.forEach(function (r) {
      const c = r.candidate || {};
      const basic = c.basic || {};
      const exp = c.expectation || {};
      const e = r.evaluation || {};
      const snap = e.jdSnapshot || {};
      const cells = [
        new Date(e.judgedAt || e.startedAt || r.capturedAt || 0).toISOString(),
        basic.name || '',
        basic.age || '',
        basic.gender || '',
        basic.education || '',
        basic.yearsOfExperience || '',
        basic.city || '',
        exp.salaryDesc || '',
        exp.candidateOwn || exp.jobAligned || '',
        snap.name || e.jdId || '',
        e.decision || '',
        e.reason || ''
      ];
      // CSV 严格转义:每个 cell 用双引号包,内部 " → ""
      lines.push(cells.map(function (x) {
        return '"' + String(x).replace(/"/g, '""').replace(/[\r\n]/g, ' ') + '"';
      }).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'boss-sniffer-candidates-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ============ 诊断 ============

  async function loadDiagnostics(events) {
    const stores = await Promise.all([loadStoreAll(STORE_CAPTURES), loadStoreAll(STORE_EVALUATIONS)]);
    const captures = stores[0];
    const evaluations = stores[1];
    function latestTs(list, pickTs) {
      let max = 0;
      (list || []).forEach(function (item) { const ts = pickTs(item) || 0; if (ts > max) max = ts; });
      return max;
    }
    function countBy(items, pickKey) {
      const out = {};
      (items || []).forEach(function (item) { const key = pickKey(item) || '(空)'; out[key] = (out[key] || 0) + 1; });
      return out;
    }
    return {
      capturesTotal: captures.length,
      evaluationsTotal: evaluations.length,
      eventsTotal: events.length,
      latestCaptureAt: latestTs(captures, function (r) { return r.capturedAt; }),
      latestEvaluationAt: latestTs(evaluations, function (r) {
        const e = r.evaluation || {};
        return e.judgedAt || e.startedAt || r.capturedAt;
      }),
      latestEventAt: latestTs(events, function (e) { return e.ts; }),
      eventsByStage: countBy(events, function (e) { return e.stage; }),
      eventsByScenario: countBy(events, function (e) { return e.scenario; }),
      evaluationsByStatus: countBy(evaluations, function (r) { return r.evaluation && r.evaluation.status; })
    };
  }

  function renderDiagnostics() {
    const debug = $('dashboard-debug');
    if (!debug) return;
    if (!currentDiagnostics) {
      debug.className = 'dashboard-debug';
      debug.textContent = '数据源：等待刷新...';
      return;
    }
    const d = currentDiagnostics;
    const status = d.evaluationsByStatus || {};
    const stages = d.eventsByStage || {};
    const scenarios = d.eventsByScenario || {};
    const parts = [
      '使用 IndexedDB 缓存（schema 由 background 管理）',
      '抓包 ' + d.capturesTotal + '（最近 ' + formatTime(d.latestCaptureAt) + '）',
      '评估 ' + d.evaluationsTotal + '（done ' + (status.done || 0) +
        ' / pending ' + (status.pending || 0) + ' / failed ' + (status.failed || 0) + '）',
      '事件 ' + d.eventsTotal + '（最近 ' + formatTime(d.latestEventAt) + '）',
      'stage: pool ' + (stages.candidate_pool || 0) +
        ' / match ' + (stages.match_marked || 0) +
        ' / pass ' + (stages.pass_marked || 0) +
        ' / sayHi ' + (stages.sayhi_sent || 0),
      'scenario: recommend ' + (scenarios.recommend || 0) + ' / chat ' + (scenarios.chat || 0)
    ];
    debug.className = 'dashboard-debug';
    debug.textContent = parts.join('；\n');
  }

  // ============ 状态 + 主刷新 ============

  let currentTimeMode = 'day';       // v0.20.3：日 / 周 / 月
  let currentFunnelTab = 'recommend'; // v0.20.3：推荐页 / 沟通页（v1.1.0 升到顶层 nav）
  let currentJobId = '';
  let currentDrawerFilter = null;     // v0.20.3：4.B 点击数字时的临时筛选
  let currentDrawerPage = 0;          // v1.1.1：候选人记录翻页（10/页）
  let currentDrawerSearch = '';       // v1.1.1：候选人搜索关键字
  let allEventsCache = [];
  let allEvaluationsCache = [];
  let currentDiagnostics = null;
  let refreshResetTimer = null;

  function setRefreshButtonState(state) {
    const btn = $('btn-refresh');
    if (!btn) return;
    if (refreshResetTimer) { clearTimeout(refreshResetTimer); refreshResetTimer = null; }
    if (state === 'loading') { btn.disabled = true; btn.textContent = '刷新中...'; return; }
    btn.disabled = false;
    if (state === 'success') {
      btn.textContent = '已刷新';
      refreshResetTimer = setTimeout(function () { btn.textContent = '↻ 刷新'; refreshResetTimer = null; }, 1200);
      return;
    }
    if (state === 'error') {
      btn.textContent = '刷新失败';
      refreshResetTimer = setTimeout(function () { btn.textContent = '↻ 刷新'; refreshResetTimer = null; }, 1800);
      return;
    }
    btn.textContent = '↻ 刷新';
  }

  async function reloadAll(options) {
    const manual = !!(options && options.manual);
    if (manual) setRefreshButtonState('loading');
    try {
      allEventsCache = await loadAllEvents();
      allEvaluationsCache = await loadStoreAll(STORE_EVALUATIONS);
      currentDiagnostics = await loadDiagnostics(allEventsCache);
      renderAll();
      if (manual) setRefreshButtonState('success');
    } catch (err) {
      console.error('[Dashboard] 启动失败:', err);
      ['view-jd-content', 'view-trend-content', 'view-drawer-content'].forEach(function (id) {
        const el = $(id);
        if (el) el.innerHTML = '<p class="error">⚠ 无法读取本地数据（' + (err.name || 'Error') + ': ' + (err.message || '') + '）</p>';
      });
      const debug = $('dashboard-debug');
      if (debug) {
        debug.className = 'dashboard-debug error';
        debug.textContent = '数据源：读取失败 ' + (err.name || 'Error') + ': ' + (err.message || '');
      }
      if (manual) setRefreshButtonState('error');
    }
  }

  function renderAll() {
    renderViewKpi();
    renderViewJD();
    renderViewTrend();
    renderViewBatch();  // v1.1.17 新增 — 批次效率
    renderViewDrawer();
    renderDiagnostics();
  }

  // v1.1.1：切时间窗 / scenario / JD 时统一 reset drawer 临时状态
  function resetDrawerState() {
    currentDrawerFilter = null;
    currentDrawerPage = 0;
    currentDrawerSearch = '';
  }

  function bindControls() {
    // 时间窗按钮
    document.querySelectorAll('.time-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTimeMode = btn.getAttribute('data-time') || 'day';
        document.querySelectorAll('.time-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        resetDrawerState();
        renderAll();
      });
    });

    // v1.1.0：scenario tab 升到顶层 nav；class .scenario-tab 取代 .funnel-tab
    document.querySelectorAll('.scenario-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentFunnelTab = btn.getAttribute('data-scenario') || 'recommend';
        document.querySelectorAll('.scenario-tab').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        resetDrawerState();
        renderAll();
      });
    });

    // v1.1.0：theme toggle（auto / light / dark 循环）
    const btnTheme = $('btn-theme');
    if (btnTheme) {
      btnTheme.addEventListener('click', cycleTheme);
    }

    // v0.20.5：候选人记录顶部筛选 tab（显示全部 / 仅符合 / 仅 LLM 错判）
    // v1.1.8: 加 marked-wrong tab；v1.1.16:文案"HR 标错"→"LLM 错判"
    document.querySelectorAll('.drawer-filter-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const filter = btn.getAttribute('data-filter');
        if (filter === 'match') {
          currentDrawerFilter = { decision: '符合' };
        } else if (filter === 'marked-wrong') {
          currentDrawerFilter = { markedWrong: true };
        } else {
          currentDrawerFilter = null;
        }
        currentDrawerPage = 0;
        renderViewDrawer();
      });
    });

    $('jd-filter').addEventListener('change', function (ev) {
      currentJobId = ev.target.value || '';
      resetDrawerState();
      renderAll();
    });
    $('btn-refresh').addEventListener('click', function () { reloadAll({ manual: true }); });
  }

  async function loadJdOptions() {
    if (typeof self.BossJD === 'undefined') {
      console.warn('[Dashboard] BossJD 未加载，JD 下拉仅含「全部」');
      return;
    }
    try {
      const list = await self.BossJD.listTemplates();
      const sel = $('jd-filter');
      list.forEach(function (t) {
        const opt = document.createElement('option');
        opt.value = t.jdId;
        opt.textContent = t.name;
        sel.appendChild(opt);
      });
    } catch (e) {
      console.warn('[Dashboard] 加载 JD 列表失败:', e);
    }
  }

  async function syncDefaultJd() {
    if (typeof self.BossJD === 'undefined') return;
    try {
      const currentJd = await self.BossJD.getCurrentJdId();
      if (currentJd) {
        const sel = $('jd-filter');
        if (sel) {
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === currentJd) {
              sel.value = currentJd;
              currentJobId = currentJd;
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Dashboard] 同步默认 JD 失败:', e);
    }
  }

  window.__dashboard = { openDb: openDb, loadAllEvents: loadAllEvents, reloadAll: reloadAll };

  document.addEventListener('DOMContentLoaded', async function () {
    // v1.1.0：主题初始化（早于 bindControls 防 FOUC）
    applyTheme(getTheme());
    if (chrome.runtime && chrome.runtime.getManifest) {
      const tag = document.getElementById('version-tag');
      if (tag) tag.textContent = 'v' + chrome.runtime.getManifest().version;
    }
    bindControls();
    bindDetailModalGlobal();   // v1.1.5: modal 关闭 / Tab 切换 / ESC 等全局监听
    await loadJdOptions();
    await syncDefaultJd();
    await reloadAll();
    setInterval(reloadAll, 5000);
  });
})();
