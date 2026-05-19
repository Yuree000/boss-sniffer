// BOSS Sniffer - dashboard.js (v2 / v0.20.3)
// 看板 v2 最终态：4 视图（B 漏斗 / C JD 分析 / D 趋势 / E 候选人记录）
//
// v0.20.3 调整：
// - 删 4.A 顶部今日数据卡整段
// - 4.B 漏斗移到最顶 + 内嵌 [推荐页][沟通页] tab + 时间窗化 + 删触达率 + 「符合」→「符合数」
// - 顶部恢复 [日][周][月] 三态按钮，切片所有下方视图
// - 4.C JD 分析按时间窗切片（不再固定今日）
// - 4.D 趋势粒度跟时间窗对应：日 → 7 天 / 周 → 8 周 / 月 → 6 月
// - 4.E 候选人记录默认展示，超出 28 条加待续提示

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

  // v0.20.3：候选人记录默认展示条数 + 截断后给待续提示
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

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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

  // ============ 4.B 漏斗卡（顶部，含 推荐页/沟通页 tab） ============

  function renderViewFunnel() {
    // 标题随时间窗变
    const titleEl = $('funnel-title');
    if (titleEl) titleEl.textContent = '📊 ' + currentScopeShort() + '数据';

    const content = $('view-funnel-content');
    if (!content) return;

    if (isChatScenario()) {
      // v0.20.3 沟通页占位（与 4.C/D/E 统一）
      content.innerHTML = CHAT_PLACEHOLDER_HTML;
      return;
    }

    // 推荐页 tab：实数据
    const bounds = currentBounds();
    const opts = { scenario: currentScenario(), jobId: currentJobId, timeStart: bounds.start, timeEnd: bounds.end };
    const pool = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'candidate_pool' })).length;
    const matched = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'match_marked' })).length;
    const sayhi = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'sayhi_sent' })).length;

    if (pool === 0 && matched === 0 && sayhi === 0) {
      content.innerHTML =
        '<div class="funnel-placeholder">' +
          currentScopeLabel() + '推荐页未跑' +
          '<div class="placeholder-hint">切到 BOSS 推荐页点 sidepanel「开始本轮」</div>' +
        '</div>';
      return;
    }

    const matchRate = safePercent(matched, pool);
    // v0.20.3：删触达率（符合 → 自动招呼）级间转化

    content.innerHTML =
      '<div class="funnel">' +
        funnelRow('已判断候选人数', pool, 100) +
        funnelRate('↓ 符合率 ' + matchRate + '%') +
        funnelRow('符合数', matched, pool ? safePercent(matched, pool) : 0, 'match') +
        funnelRow('自动招呼发出', sayhi, pool ? safePercent(sayhi, pool) : 0, 'sayhi') +
      '</div>';

    // 数字点击 → 滚到 4.E 候选人记录 + 临时 filter
    const matchNum = content.querySelector('.funnel-num[data-stage="match"]');
    if (matchNum) {
      matchNum.addEventListener('click', function () {
        applyDrawerFilter({ decision: '符合' });
      });
    }
    const sayhiNum = content.querySelector('.funnel-num[data-stage="sayhi"]');
    if (sayhiNum) {
      sayhiNum.addEventListener('click', function () {
        applyDrawerFilter({ action: 'sayhi' });
      });
    }
  }

  function funnelRow(label, num, widthPct, stageKey) {
    const dataAttr = stageKey ? ' data-stage="' + stageKey + '"' : '';
    return '<div class="funnel-row">' +
      '<div class="funnel-label">' + escapeHtml(label) + '</div>' +
      '<div class="funnel-bar"><div class="funnel-fill" style="width:' + widthPct + '%"></div></div>' +
      '<div class="funnel-num"' + dataAttr + '>' + num + '</div>' +
    '</div>';
  }

  function funnelRate(text) {
    return '<div class="funnel-rate">' + escapeHtml(text) + '</div>';
  }

  // ============ 4.C JD 分析卡（M_i pass 主因 + O_i 命中率） ============
  // v0.20.3：按 currentBounds() 切片（不再固定今日）

  function renderViewJD() {
    // v0.20.4：沟通页主链路未完工 → 整卡占位（与 4.B 沟通页 tab 行为一致）
    if (isChatScenario()) {
      $('view-jd-content').innerHTML = CHAT_PLACEHOLDER_HTML;
      return;
    }

    const bounds = currentBounds();
    const opts = { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId };

    if (!currentJobId) {
      $('view-jd-content').innerHTML =
        '<p class="empty-hint">请在顶部 JD 下拉里选择具体岗位查看 JD 分析<br><span style="font-size:11px;color:#aaa;">（跨 JD 不同条件文本无法合并）</span></p>';
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

    const pool = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'candidate_pool' })).length;
    const passEvents = filterEvents(allEventsCache, Object.assign({}, opts, { stage: 'pass_marked' }));
    const reasonCounts = {};
    passEvents.forEach(function (e) {
      const r = (e.payload && e.payload.passReason) || '其他';
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    });

    const matched = filterEvaluations(allEvaluationsCache, Object.assign({}, opts, { decision: '符合', statusDone: true }));
    const matchedTotal = matched.length;

    const jdNameSafe = escapeHtml((sampleSnap && sampleSnap.name) || currentJobId);
    let html = '<div class="reason-total">' + jdNameSafe + ' · ' + currentScopeShort() + '范围 · 判断人数 <strong>' + pool +
               '</strong> · 符合 <strong>' + matchedTotal + '</strong></div>';

    // ===== 上段：必要条件 M_i =====
    if (mustConditions.length === 0) {
      html += '<div class="jd-section-title">必要条件</div>' +
              '<p class="empty-hint" style="padding:12px;">该 JD 未配置必要条件</p>';
    } else {
      html += '<div class="jd-section-title">必要条件 M_i ── pass 主因占比 / 信息缺占比（分母 = ' + currentScopeShort() + '范围候选人池 ' + pool + '）</div>';
      mustConditions.forEach(function (c, i) {
        const key = 'M' + (i + 1);
        const passMainCount = reasonCounts[c.text] || 0;
        const missCount = reasonCounts[c.text + '(信息缺)'] || 0;
        const passPct = safePercent(passMainCount, pool);
        const missPct = safePercent(missCount, pool);
        html += '<div class="jd-condition-block">' +
          '<div class="reason-row">' +
            '<div class="reason-label">' + key + '. ' + escapeHtml(c.text) + '</div>' +
            '<div class="reason-bar"><div class="reason-fill" style="width:' + passPct + '%"></div></div>' +
            '<div class="reason-num">' + passMainCount + '</div>' +
            '<div class="reason-pct">(' + passPct + '%)</div>' +
          '</div>' +
          '<div class="reason-row sub-row">' +
            '<div class="reason-label sub-label">　 信息缺</div>' +
            '<div class="reason-bar"><div class="reason-fill miss-fill" style="width:' + missPct + '%"></div></div>' +
            '<div class="reason-num">' + missCount + '</div>' +
            '<div class="reason-pct">(' + missPct + '%)</div>' +
          '</div>' +
          '<div class="jd-action-row">' +
            '<a class="btn-admin-jump" href="' + adminJumpUrl(currentJobId, key) + '" target="_blank" rel="noopener">去 admin 改 ' + key + ' ▸</a>' +
          '</div>' +
        '</div>';
      });
    }

    // 分隔
    html += '<div class="jd-section-divider"></div>';

    // ===== 下段：可选条件 O_i =====
    if (optConditions.length === 0) {
      html += '<div class="jd-section-title">可选条件</div>' +
              '<p class="empty-hint" style="padding:12px;">该 JD 未配置可选条件</p>';
    } else if (matchedTotal === 0) {
      html += '<div class="jd-section-title">可选条件 O_i ── 在符合人群中的命中率</div>' +
              '<p class="empty-hint" style="padding:12px;">该范围内暂无符合候选人 — 跑一批符合候选人后看 O_i 命中率</p>';
    } else {
      const hits = optConditions.map(function (c, i) {
        const k = 'O' + (i + 1);
        let count = 0;
        matched.forEach(function (r) {
          const b = r.evaluation && r.evaluation.optionalBreakdown;
          if (b && b[k] && b[k].value === true) count++;
        });
        return { key: k, index: i, text: c.text, count: count };
      });
      hits.sort(function (a, b) { return b.count - a.count; });

      html += '<div class="jd-section-title">可选条件 O_i ── 在符合人群（' + matchedTotal + ' 人）中的命中率</div>';
      hits.forEach(function (item) {
        const pct = safePercent(item.count, matchedTotal);
        html += '<div class="jd-condition-block">' +
          '<div class="reason-row">' +
            '<div class="reason-label">' + item.key + '. ' + escapeHtml(item.text) + '</div>' +
            '<div class="reason-bar"><div class="reason-fill match-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="reason-num">' + item.count + '</div>' +
            '<div class="reason-pct">(' + pct + '%)</div>' +
          '</div>' +
          '<div class="jd-action-row">' +
            '<a class="btn-admin-jump" href="' + adminJumpUrl(currentJobId, item.key) + '" target="_blank" rel="noopener">去 admin 改 ' + item.key + ' ▸</a>' +
          '</div>' +
        '</div>';
      });
    }

    $('view-jd-content').innerHTML = html;
  }

  function adminJumpUrl(jdId, conditionKey) {
    const params = 'jdId=' + encodeURIComponent(jdId || '') + '&scrollTo=' + encodeURIComponent(conditionKey);
    return chrome.runtime.getURL('admin/admin.html') + '?' + params;
  }

  // ============ 4.D 趋势卡 ============
  // v0.20.3：粒度跟时间窗对应 — 日 → 7 天 / 周 → 8 周 / 月 → 6 月

  function renderViewTrend() {
    const titleEl = $('trend-title');
    let bucketCount, bucketMs, fmtLabel, titleText;
    if (currentTimeMode === 'week') {
      bucketCount = 8;
      bucketMs = 7 * 86400000;
      fmtLabel = function (start) { return formatMd(start); };
      titleText = '📈 8 周趋势';
    } else if (currentTimeMode === 'month') {
      bucketCount = 6;
      bucketMs = null;
      fmtLabel = formatYm;
      titleText = '📈 6 月趋势';
    } else {
      bucketCount = 7;
      bucketMs = 86400000;
      fmtLabel = formatMd;
      titleText = '📈 7 天趋势';
    }
    if (titleEl) titleEl.textContent = titleText;

    // v0.20.4：沟通页主链路未完工 → 整卡占位
    if (isChatScenario()) {
      $('view-trend-content').innerHTML = CHAT_PLACEHOLDER_HTML;
      return;
    }

    const buckets = buildTrendBuckets(bucketCount, bucketMs);

    // v0.20.4：三指标对齐 4.B 漏斗（判断候选人数 / 符合数 / 自动招呼发出数）
    const poolSeries = [];
    const matchSeries = [];
    const sayhiSeries = [];
    const opts = { scenario: currentScenario(), jobId: currentJobId };

    buckets.forEach(function (b) {
      const pool = filterEvents(allEventsCache, Object.assign({}, opts, {
        timeStart: b.start, timeEnd: b.end, stage: 'candidate_pool'
      })).length;
      const matched = filterEvents(allEventsCache, Object.assign({}, opts, {
        timeStart: b.start, timeEnd: b.end, stage: 'match_marked'
      })).length;
      const sayhi = filterEvents(allEventsCache, Object.assign({}, opts, {
        timeStart: b.start, timeEnd: b.end, stage: 'sayhi_sent'
      })).length;

      poolSeries.push(pool);
      matchSeries.push(matched);
      sayhiSeries.push(sayhi);
    });

    const xLabels = buckets.map(function (b) { return fmtLabel(b.start); });

    let html = trendRow('判断候选人数', poolSeries, function (v) { return v; }, xLabels) +
               trendRow('符合数', matchSeries, function (v) { return v; }, xLabels) +
               trendRow('自动招呼发出数', sayhiSeries, function (v) { return v; }, xLabels);
    $('view-trend-content').innerHTML = html;
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

  function trendRow(label, series, valueFmt, xLabels) {
    if (!series || series.length === 0) {
      return '<div class="trend-row"><div class="trend-label">' + escapeHtml(label) + '</div><div class="trend-svg">—</div></div>';
    }
    const today = series[series.length - 1];
    const svg = renderSparkSvg(series);
    return '<div class="trend-row">' +
      '<div class="trend-label">' + escapeHtml(label) + '</div>' +
      svg +
      '<div class="trend-current">今 ' + escapeHtml(String(valueFmt(today))) + '</div>' +
    '</div>' +
    '<div class="trend-x-axis">' + xLabels.map(function (l) { return '<span>' + escapeHtml(l) + '</span>'; }).join('') + '</div>';
  }

  function renderSparkSvg(series) {
    const width = 100;
    const height = 30;
    const max = Math.max.apply(null, series.concat([1]));
    const min = 0;
    const stepX = series.length > 1 ? width / (series.length - 1) : 0;
    const points = series.map(function (v, i) {
      const x = i * stepX;
      const y = height - ((v - min) / (max - min || 1)) * (height - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const polyline = '<polyline points="' + points.join(' ') + '" fill="none" stroke="#2467f0" stroke-width="1.5" />';
    const dots = series.map(function (v, i) {
      const x = i * stepX;
      const y = height - ((v - min) / (max - min || 1)) * (height - 4) - 2;
      const isLast = i === series.length - 1;
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (isLast ? 2.5 : 1.5) + '" fill="' + (isLast ? '#2467f0' : '#6e9eff') + '" />';
    }).join('');
    return '<svg class="trend-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
      polyline + dots +
    '</svg>';
  }

  // ============ 4.E 候选人记录（默认展示） ============
  // v0.20.3：默认渲染 + 超出 DRAWER_TOP_N 加待续提示

  function applyDrawerFilter(filter) {
    currentDrawerFilter = filter;
    renderViewDrawer();
    const card = $('view-drawer-card');
    if (card && card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function clearDrawerFilter() {
    currentDrawerFilter = null;
    renderViewDrawer();
  }

  function renderViewDrawer() {
    const meta = $('drawer-meta');

    // v0.20.5：同步 filter-tab active 状态（每次重渲都对齐）
    const filterTabs = $('drawer-filter-tabs');
    if (filterTabs) {
      const activeFilter = (currentDrawerFilter && currentDrawerFilter.decision === '符合') ? 'match' : 'all';
      filterTabs.querySelectorAll('.drawer-filter-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-filter') === activeFilter);
      });
    }

    // v0.20.4：沟通页主链路未完工 → 整卡占位
    if (isChatScenario()) {
      if (meta) { meta.textContent = '沟通页·待主链路完工'; meta.style.cursor = 'default'; meta.onclick = null; }
      $('view-drawer-content').innerHTML = CHAT_PLACEHOLDER_HTML;
      return;
    }

    const bounds = currentBounds();
    const opts = { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId, statusDone: true };

    // 应用 drawer filter（4.B 点击数字时设的临时 filter）
    let evals = filterEvaluations(allEvaluationsCache, opts);
    let filterLabel = '';

    if (currentDrawerFilter) {
      if (currentDrawerFilter.decision) {
        evals = evals.filter(function (r) { return r.evaluation && r.evaluation.decision === currentDrawerFilter.decision; });
        filterLabel = ' · 决策=' + currentDrawerFilter.decision;
      } else if (currentDrawerFilter.action === 'sayhi') {
        // 自动招呼：join events sayhi_sent 的 candidateId
        const sayhiEvents = filterEvents(allEventsCache, { timeStart: bounds.start, timeEnd: bounds.end, scenario: currentScenario(), jobId: currentJobId, stage: 'sayhi_sent' });
        const ids = {};
        sayhiEvents.forEach(function (e) { if (e.candidateId) ids[e.candidateId] = true; });
        evals = evals.filter(function (r) { return ids[r.candidateId]; });
        filterLabel = ' · 已自动招呼';
      }
    }

    const total = evals.length;
    const jdName = currentJobId
      ? ((evals[0] && evals[0].evaluation && evals[0].evaluation.jdSnapshot && evals[0].evaluation.jdSnapshot.name) || currentJobId)
      : '全部 JD';

    if (meta) {
      // v0.20.5：decision filter（符合）有顶部 tab 切换，不再显示 meta 上的取消链接；
      // action filter（如 sayhi，从漏斗点出来）保留 meta 上的取消链接
      const isActionFilter = currentDrawerFilter && currentDrawerFilter.action;
      meta.textContent = jdName + ' · ' + currentScopeShort() + '范围' + filterLabel +
        '（共 ' + total + ' 人）' +
        (isActionFilter ? ' [点这里取消筛选]' : '');
      meta.style.cursor = isActionFilter ? 'pointer' : 'default';
      meta.onclick = isActionFilter ? function () { clearDrawerFilter(); } : null;
    }

    if (total === 0) {
      $('view-drawer-content').innerHTML = '<p class="empty-hint">该范围内暂无候选人 — 跑一批后回来看</p>';
      return;
    }

    // 倒序排
    evals.sort(function (a, b) {
      return ((b.evaluation && b.evaluation.judgedAt) || 0) - ((a.evaluation && a.evaluation.judgedAt) || 0);
    });

    const shown = evals.slice(0, DRAWER_TOP_N);
    const trs = shown.map(function (r) {
      const c = r.candidate || {};
      const basic = c.basic || {};
      const e = r.evaluation || {};
      const dec = e.decision === '符合' ? 'match' : (e.decision === 'pass' ? 'pass' : '');
      const decLabel = e.decision === '符合' ? '✅ 符合' : (e.decision === 'pass' ? '⛔ pass' : (e.status || '?'));
      const reason = e.reason || '';
      const name = basic.name || '(无名)';
      const age = basic.age ? ' (' + basic.age + ')' : '';

      return '<tr>' +
        '<td class="col-time">' + formatHm(e.judgedAt || e.startedAt || r.capturedAt) + '</td>' +
        '<td class="col-name">' + escapeHtml(name) + escapeHtml(age) + '</td>' +
        '<td class="col-decision ' + dec + '">' + escapeHtml(decLabel) + '</td>' +
        '<td class="col-reason">' + escapeHtml(reason) + '</td>' +
      '</tr>';
    }).join('');

    let html = '<table class="drawer-table">' +
      '<thead><tr><th>时间</th><th>候选人</th><th>决策</th><th>关键 reason</th></tr></thead>' +
      '<tbody>' + trs + '</tbody>' +
    '</table>';

    // 待续提示：超出 DRAWER_TOP_N 时
    const overflow = total - shown.length;
    if (overflow > 0) {
      html += '<div class="drawer-overflow-hint">⋯ 下方还有 <span class="overflow-count">' + overflow + '</span> 条候选人，' +
              '<a class="btn-export-inline" id="btn-overflow-csv" href="#">导出 CSV ▸</a> 查看全部</div>';
    } else {
      html += '<div class="drawer-actions">' +
              '<button id="drawer-export-csv">导出 CSV ▸</button>' +
              '</div>';
    }
    $('view-drawer-content').innerHTML = html;

    // 导出 CSV 按钮（两种位置共享逻辑）
    const btnCsv = $('drawer-export-csv') || $('btn-overflow-csv');
    if (btnCsv) {
      btnCsv.addEventListener('click', function (ev) {
        ev.preventDefault();
        exportDrawerCsv(evals);  // 导出全部（不只 shown）
      });
    }
  }

  function exportDrawerCsv(rows) {
    const header = ['time', 'name', 'age', 'decision', 'reason'];
    const lines = [header.join(',')];
    rows.forEach(function (r) {
      const c = r.candidate || {};
      const basic = c.basic || {};
      const e = r.evaluation || {};
      const cells = [
        new Date(e.judgedAt || e.startedAt || r.capturedAt || 0).toISOString(),
        (basic.name || '').replace(/,/g, ' '),
        basic.age || '',
        e.decision || '',
        (e.reason || '').replace(/[",\n]/g, ' ')
      ];
      lines.push(cells.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(','));
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
  let currentFunnelTab = 'recommend'; // v0.20.3：推荐页 / 沟通页
  let currentJobId = '';
  let currentDrawerFilter = null;     // v0.20.3：4.B 点击数字时的临时筛选
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
      ['view-funnel-content', 'view-jd-content', 'view-trend-content', 'view-drawer-content'].forEach(function (id) {
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
    renderViewFunnel();
    renderViewJD();
    renderViewTrend();
    renderViewDrawer();
    renderDiagnostics();
  }

  function bindControls() {
    // 时间窗按钮（v0.20.3）
    document.querySelectorAll('.time-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTimeMode = btn.getAttribute('data-time') || 'day';
        document.querySelectorAll('.time-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        // 切时间窗时清掉 drawer 临时 filter
        currentDrawerFilter = null;
        renderAll();
      });
    });

    // 漏斗 tab 切换（v0.20.3）；v0.20.4 起整盘联动（4.C/D/E 也按 scenario 切片）
    document.querySelectorAll('.funnel-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentFunnelTab = btn.getAttribute('data-scenario') || 'recommend';
        document.querySelectorAll('.funnel-tab').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        // 切 scenario 时清掉 drawer 临时 filter
        currentDrawerFilter = null;
        renderAll();
      });
    });

    // v0.20.5：候选人记录顶部筛选 tab（显示全部 / 仅符合）
    document.querySelectorAll('.drawer-filter-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const filter = btn.getAttribute('data-filter');
        if (filter === 'match') {
          currentDrawerFilter = { decision: '符合' };
        } else {
          currentDrawerFilter = null;
        }
        renderViewDrawer();
      });
    });

    $('jd-filter').addEventListener('change', function (ev) {
      currentJobId = ev.target.value || '';
      currentDrawerFilter = null;  // 切 JD 也清 filter
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
    if (chrome.runtime && chrome.runtime.getManifest) {
      const tag = document.getElementById('version-tag');
      if (tag) tag.textContent = 'v' + chrome.runtime.getManifest().version;
    }
    bindControls();
    await loadJdOptions();
    await syncDefaultJd();
    await reloadAll();
    setInterval(reloadAll, 5000);
  });
})();
