// BOSS Sniffer - sidepanel.js (v0.12.4)
// LLM 评估三态展示 + 必要/可选条件展开 + pending/failed 状态 + 配置入口（跳转 admin）

const $ = function (id) { return document.getElementById(id); };

// 卡片展开状态外挂（v0.12.2 fix）：setInterval(refresh, 1500) 全量重渲会销毁 DOM 的
// display state，把"哪些卡片展开"记到模块作用域 Set，渲染时回写
// v0.19.1：原 expandedBreakdownIds 已废弃 —— 条件列表现在常驻展开（无折叠），不再需要状态外挂
const expandedCardIds = new Set();

// ===== v0.12.5：点候选人名字 → 让 BOSS 页面滚动并高亮 =====
function locateCandidateInPage(candidateId, encryptUid) {
  try {
    chrome.runtime.sendMessage({
      type: BossMessageTypes.LOCATE_CANDIDATE,
      candidateId: candidateId,
      encryptUid: encryptUid
    }, function (resp) {
      if (chrome.runtime.lastError) {
        showToast('定位失败：' + chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!resp || !resp.ok) {
        const hint = (resp && (resp.hint || resp.error)) || '未知错误';
        showToast('未在页面找到候选人 — ' + hint, 'error');
      }
      // 成功：页面已滚动 + 高亮，sidepanel 无需提示
    });
  } catch (e) {
    showToast('定位失败：' + e.message, 'error');
  }
}

// 简易 toast：右下角浮窗 2.5s 后自动消失
let _toastEl = null;
let _toastTimer = null;
function showToast(text, kind) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.style.cssText = 'position:fixed; bottom:12px; left:12px; right:12px; padding:8px 12px; border-radius:6px; font-size:12px; line-height:1.4; z-index:9999; box-shadow:0 2px 8px rgba(0,0,0,0.15); display:none;';
    document.body.appendChild(_toastEl);
  }
  if (kind === 'error') {
    _toastEl.style.background = '#fbebeb';
    _toastEl.style.color = '#a33';
    _toastEl.style.border = '1px solid #e9b3b3';
  } else {
    _toastEl.style.background = '#e8f5ec';
    _toastEl.style.color = '#2a6f49';
    _toastEl.style.border = '1px solid #a4d4ba';
  }
  _toastEl.textContent = text;
  _toastEl.style.display = 'block';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { if (_toastEl) _toastEl.style.display = 'none'; }, 2500);
}

// ===== 工具 =====
function fmtPath(p) {
  if (!p) return '(unknown)';
  if (p.length > 48) return '...' + p.slice(-45);
  return p;
}

// 决策值 → CSS 类（业务逻辑 §3 二态：符合 / pass；以及 v0.20.9 三态：queued / pending / failed）
// v0.21.0 · Phase 1·1d：加 'unrouted' 状态（沟通职位未识别 → 跳过 LLM）
function decisionClass(decision, status) {
  if (status === 'unrouted') return 'unrouted'; // v0.21.0 未路由命中
  if (status === 'queued') return 'queued';   // v0.20.9 待评估（在 LLM 队列里等）
  if (status === 'pending') return 'pending'; // 评估中（worker 已进入，LLM 真正在跑）
  if (status === 'failed') return 'failed';
  if (decision === '符合') return 'match';
  if (decision === 'pass') return 'pass';
  return 'pending'; // fallback（不应出现，judge.js validateOutput 拦下）
}

function decisionLabel(decision, status) {
  if (status === 'unrouted') return '🟡 未识别岗位';  // v0.21.0
  if (status === 'queued') return '⏳ 待评估';
  if (status === 'pending') return '🔄 评估中';
  if (status === 'failed') return '评估失败';
  return decision || '?';
}

// v0.21.0 · Phase 1·1d：候选人卡片头部的"沟通职位 → 路由到 JD"小字行
// 三种情况：
//   - unrouted: 🟡 黄底，提示已跳过评估
//   - 已路由（routedJdName 存在）：灰色 "沟通职位『xxx』→ JD: yyy"
//   - 仅有 jobAligned（idle/queued/pending，未跑完路由）：灰色 "沟通职位『xxx』"
//   - 都没有：返回 null（不渲染）
function makeRoutingHeader(record) {
  const e = (record && record.evaluation) || {};
  const c = (record && record.candidate) || {};
  const jobAligned = (c.expectation && c.expectation.jobAligned) || e.jobAligned || null;

  if (e.status === 'unrouted') {
    const div = document.createElement('div');
    div.className = 'routing-header unrouted';
    if (e.unrouteReason === 'no_jobAligned' || !jobAligned) {
      div.textContent = '🟡 沟通职位缺失 · 已跳过评估';
    } else {
      div.textContent = '🟡 沟通职位「' + jobAligned + '」未识别 · 已跳过评估（admin 加该别名后重评）';
    }
    return div;
  }

  if (e.routedJdName) {
    const div = document.createElement('div');
    div.className = 'routing-header matched';
    const ja = document.createElement('span');
    ja.textContent = '沟通职位「' + (jobAligned || '?') + '」';
    div.appendChild(ja);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = ' → ';
    div.appendChild(arrow);
    const jd = document.createElement('span');
    jd.className = 'jd-routed';
    jd.textContent = 'JD: ' + e.routedJdName;
    div.appendChild(jd);
    return div;
  }

  if (jobAligned) {
    const div = document.createElement('div');
    div.className = 'routing-header';
    div.textContent = '沟通职位「' + jobAligned + '」';
    return div;
  }

  return null;
}

// 将条件 value 翻译成 HR 友好的状态文本
function dimStatusText(value) {
  if (value === true) return '✓ 通过';
  if (value === false) return '✗ 不通过';
  if (value === 'unknown') return '? 信息不确定';
  return String(value);
}

// 状态徽章 CSS class（与 .condition-status.{true,false,unknown} 对应）
function dimValueClass(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === 'unknown') return 'unknown';
  return '';
}

// v0.19.1：条件展开列表（纵向堆叠，常驻展开）
// 每个 M_i / O_i 一个 .condition-item 块：
//   header: M{n}. <条件文本>   <状态徽章>
//   reason: LLM 给该条件的具体理由（在条件文本下方一行展示）
function buildConditionsList(evalRecord, mustConditions, optionalConditions) {
  const mList = mustConditions || [];
  const oList = optionalConditions || [];
  if (mList.length === 0 && oList.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'conditions-list';

  function appendItems(conditions, breakdown, prefix) {
    conditions.forEach(function (c, i) {
      const key = prefix + (i + 1);
      const r = (breakdown && breakdown[key]) || {};

      const item = document.createElement('div');
      item.className = 'condition-item';

      const header = document.createElement('div');
      header.className = 'condition-header';

      const keySpan = document.createElement('span');
      keySpan.className = 'condition-key';
      keySpan.textContent = key + '.';
      header.appendChild(keySpan);

      const textSpan = document.createElement('span');
      textSpan.className = 'condition-text';
      textSpan.textContent = c.text || '';
      header.appendChild(textSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'condition-status ' + dimValueClass(r.value);
      statusSpan.textContent = dimStatusText(r.value);
      header.appendChild(statusSpan);

      item.appendChild(header);

      const reasonDiv = document.createElement('div');
      if (r.reason) {
        reasonDiv.className = 'condition-reason';
        reasonDiv.textContent = r.reason;
      } else {
        reasonDiv.className = 'condition-reason empty';
        reasonDiv.textContent = '（LLM 未给出理由）';
      }
      item.appendChild(reasonDiv);

      wrap.appendChild(item);
    });
  }

  appendItems(mList, evalRecord.mustBreakdown, 'M');
  appendItems(oList, evalRecord.optionalBreakdown, 'O');

  return wrap;
}

const escapeHtml = window.BossUiUtils.escapeHtml; // v1.1.22 提到 lib/ui-utils.js

// ===== 评估卡渲染 =====
// 紧凑卡片渲染（S3.6）：每张卡只显示「姓名 · 场景 · 决策 · sayHi 标」
// 符合：v0.19.0 起加 ▶ 展开，显示 必要全过 + 命中可选 + 每条 M_i / O_i 的 reason
// pass：右侧加 ▶ 箭头，点击展开主因（必要不达 / 信息缺 / 可选不足）+ LLM 说明
// 评估失败：同 pass 处理，展开有错误描述 + 重试按钮
// 评估中：极简，无展开
// v1.1.23 P3 后:推荐页/沟通页主路径已切到 renderMultiEvalCard(多模板渲染)。
// 本函数保留作为「单评估展开 / 重试 / hr-mark-wrong」的细节模板供后续按需调用,
// 主流程不再直接 dispatch 它。
function renderEvaluation(record) {
  const c = record.candidate || {};
  const e = record.evaluation || {};
  const status = e.status || 'pending';
  const cls = decisionClass(e.decision, status);
  const basic = c.basic || {};
  const source = c.source || {};

  const scenarioLabel = source.scenario === 'recommend' ? '推荐页'
                       : source.scenario === 'latest' ? '最新页'
                       : source.scenario === 'chat' ? '沟通页'
                       : source.scenario === 'sayhi-tab' ? '新招呼'   // v0.13.0
                       : '';

  // pass / 符合 / failed 状态需要展开
  // v0.19.0：符合也加入展开支持（显示 必要全过 + 命中可选 + 每条 reason）
  const expandable = (status === 'done' && (e.decision === 'pass' || e.decision === '符合')) || status === 'failed';
  // v0.12.2 fix：展开状态外挂，抗 1500ms 全量重渲销毁 DOM display state
  const initiallyOpen = expandable && expandedCardIds.has(record.candidateId);

  const card = document.createElement('div');
  card.className = 'eval-card ' + cls;

  // —— 主行：姓名 [场景]   决策 + sayHi + 箭头 ——
  const row = document.createElement('div');
  row.className = 'eval-row1';

  const left = document.createElement('span');
  left.className = 'name';
  left.textContent = basic.name || '(无名)';
  // v0.12.5：名字可点 → 在 BOSS 页面定位候选人卡片
  left.style.cursor = 'pointer';
  left.title = '点击在页面定位此候选人';
  left.addEventListener('click', function (ev) {
    ev.stopPropagation();  // 不触发 row 展开
    locateCandidateInPage(record.candidateId, c.encryptUid || '');
  });
  if (scenarioLabel) {
    const tag = document.createElement('span');
    tag.className = 'scenario-tag';
    tag.textContent = scenarioLabel;
    left.appendChild(tag);
  }
  row.appendChild(left);

  const right = document.createElement('span');
  right.className = 'decision-block';

  const decisionTag = document.createElement('span');
  decisionTag.className = 'decision ' + cls;
  decisionTag.textContent = decisionLabel(e.decision, status);
  right.appendChild(decisionTag);

  // v1.1.7: HR 反馈通道 — 标 LLM 错判(仅评估已出结果时显示)
  // v1.1.16: tooltip 文案从"LLM 判错"统一为"LLM 错判"(跟看板列名一致)
  // 默认无 hrFeedback = LLM 对; 点一下标错,再点取消
  if (status === 'done' && (e.decision === '符合' || e.decision === 'pass')) {
    const markBtn = document.createElement('span');
    markBtn.className = 'hr-mark-wrong-btn';
    const initiallyMarked = !!(record.hrFeedback && record.hrFeedback.markedWrong);
    if (initiallyMarked) markBtn.classList.add('marked');
    markBtn.textContent = initiallyMarked ? '⚠已标错' : '标错';
    markBtn.title = initiallyMarked ? '已标记 LLM 错判 · 点击取消' : '标记 LLM 错判';
    markBtn.addEventListener('click', async function (ev) {
      ev.stopPropagation();
      if (markBtn.dataset.busy === '1') return;
      const willMark = !markBtn.classList.contains('marked');
      markBtn.dataset.busy = '1';
      markBtn.style.opacity = '0.5';
      try {
        const type = willMark ? BossMessageTypes.MARK_LLM_WRONG : BossMessageTypes.UNMARK_LLM_WRONG;
        const resp = await chrome.runtime.sendMessage({ type: type, candidateId: record.candidateId });
        if (resp && resp.ok) {
          markBtn.classList.toggle('marked', willMark);
          markBtn.textContent = willMark ? '⚠已标错' : '标错';
          markBtn.title = willMark ? '已标记 LLM 错判 · 点击取消' : '标记 LLM 错判';
        } else {
          console.warn('[hr-mark-wrong] failed:', resp && resp.error);
        }
      } catch (err) {
        console.warn('[hr-mark-wrong] exception:', err);
      } finally {
        markBtn.dataset.busy = '';
        markBtn.style.opacity = '';
      }
    });
    right.appendChild(markBtn);
  }

  // pending 已等待秒数(依赖 1500ms 全量刷新,无需另起 timer)
  // 30s 内灰色提示,≥ 30s 加红色样式让 HR 注意到「慢评估」
  if (status === 'pending' && e.startedAt) {
    const elapsed = Math.floor((Date.now() - e.startedAt) / 1000);
    if (elapsed >= 1) {
      const wait = document.createElement('span');
      wait.className = 'pending-elapsed' + (elapsed >= 30 ? ' stale' : '');
      wait.textContent = '⏱ 已 ' + elapsed + 's';
      wait.title = elapsed >= 30 ? '评估超过 30s,可能在重试中(LLM 最多重试 3 次)' : '';
      right.appendChild(wait);
    }
  }

  // sayHi 内联标
  const greeting = record.greeting;
  if (greeting && greeting.status) {
    const g = document.createElement('span');
    g.className = 'greet-inline ' + greeting.status;
    if (greeting.status === 'queued') g.textContent = '⌛ 待招呼';
    else if (greeting.status === 'sent') g.textContent = '✓ 已招呼';
    else if (greeting.status === 'failed') g.textContent = '⚠ 招呼失败';
    else if (greeting.status === 'over_quota') {
      // v0.12.6：本轮 N 名额已满，符合 候选人不进队，但要让 HR 看到为什么
      g.textContent = '⊘ 已超 N';
      g.title = '本轮招呼名额 (N) 已满，本候选人未进入打招呼队列';
    }
    if (greeting.error) g.title = greeting.error;
    right.appendChild(g);
  }

  // 展开箭头（仅 pass / failed）
  let arrow = null;
  if (expandable) {
    arrow = document.createElement('span');
    arrow.className = 'pass-arrow';
    arrow.textContent = initiallyOpen ? '▼' : '▶';
    right.appendChild(arrow);
  }

  row.appendChild(right);
  card.appendChild(row);

  // —— 展开区（按 expandedCardIds 决定初始 display）——
  if (expandable) {
    const expand = document.createElement('div');
    expand.className = 'pass-expand';
    expand.style.display = initiallyOpen ? 'block' : 'none';

    if (status === 'failed') {
      // 评估失败：错误描述 + (Commit 1 起)perAttempt 轨迹 + 重试按钮
      const reasonDiv = document.createElement('div');
      reasonDiv.className = 'pass-reason';
      reasonDiv.innerHTML = '⚠ ' + escapeHtml(e.error || '评估失败');
      expand.appendChild(reasonDiv);

      // perAttempt 轨迹:每次尝试一行 details,点击展开看 errorBody / rawLlmText
      if (Array.isArray(e.perAttempt) && e.perAttempt.length) {
        const traceWrap = document.createElement('div');
        traceWrap.className = 'attempt-trace';
        const summaryLine = document.createElement('div');
        summaryLine.className = 'attempt-summary';
        summaryLine.textContent = '尝试 ' + e.perAttempt.length + ' 次,总耗时 ' +
          (e.latencyMs ? (e.latencyMs / 1000).toFixed(1) + 's' : '?');
        traceWrap.appendChild(summaryLine);

        e.perAttempt.forEach(function (a, i) {
          const item = document.createElement('details');
          item.className = 'attempt-item';
          const sum = document.createElement('summary');
          const sec = ((a.latencyMs || 0) / 1000).toFixed(1);
          const httpPart = a.httpStatus ? (' · HTTP ' + a.httpStatus) : '';
          sum.textContent = '第 ' + (i + 1) + ' 次 · ' + sec + 's · ' +
            (a.errorName || 'OK') + httpPart;
          item.appendChild(sum);

          if (a.error) {
            const msg = document.createElement('div');
            msg.className = 'attempt-msg';
            msg.textContent = a.error;
            item.appendChild(msg);
          }
          if (a.errorBody) {
            const pre = document.createElement('pre');
            pre.className = 'attempt-body';
            pre.textContent = 'HTTP body:\n' + a.errorBody;
            item.appendChild(pre);
          }
          if (a.rawLlmText) {
            const pre = document.createElement('pre');
            pre.className = 'attempt-body';
            pre.textContent = 'LLM raw:\n' + a.rawLlmText;
            item.appendChild(pre);
          }
          traceWrap.appendChild(item);
        });
        expand.appendChild(traceWrap);
      }

      const btn = document.createElement('button');
      btn.textContent = '重试';
      btn.style.marginTop = '4px';
      btn.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        btn.disabled = true;
        btn.textContent = '评估中...';
        await chrome.runtime.sendMessage({
          type: BossMessageTypes.RETRY_EVALUATION,
          candidateId: record.candidateId
        });
        refresh();
      });
      expand.appendChild(btn);
    } else {
      // v0.19.1：pass / 符合 共用 — 直接铺纵向条件列表，每条 M_i / O_i 下面挂自己的 reason
      // 去掉了 v0.19.0 的顶部一句话总结（pass-reason / pass-detail）—— HR 反馈"上面一句话信息分散到下面去"
      // jdSnapshot 是 judge.js 在评估时存的 JD 快照，HR 切 JD 后历史卡片仍能正确展示
      const snap = e.jdSnapshot || {};
      const mustConditions = Array.isArray(snap.mustConditions) ? snap.mustConditions : [];
      const optionalConditions = Array.isArray(snap.optionalConditions) ? snap.optionalConditions : [];

      const list = buildConditionsList(e, mustConditions, optionalConditions);
      if (list) expand.appendChild(list);
    }

    card.appendChild(expand);

    // 点主行切展开 / 收起（状态同步到 expandedCardIds 抗重渲）
    row.style.cursor = 'pointer';
    row.addEventListener('click', function () {
      const isOpen = expand.style.display !== 'none';
      expand.style.display = isOpen ? 'none' : 'block';
      if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
      if (isOpen) expandedCardIds.delete(record.candidateId);
      else expandedCardIds.add(record.candidateId);
    });
  }

  return card;
}

// ===== v1.1.23 P3：多模板候选人卡片渲染 =====
// 一个候选人 × N 个模板 = N 个子评估（每个 template 一行）
// 输入 record 兼容两种 shape:
//   1) 新格式 (P3 background 输出): { candidateId, candidate, position, evaluations: [{templateId, templateName, decision/verdict, judgedAt, jdContentHash, status, ...}] }
//   2) 老格式 (P2 单评估,做向前兼容): { candidateId, candidate, evaluation: {...} } → 包成 [evaluation] 渲染

// 把 record 上的 evaluations 数组规范化(同时兼容老格式)
function extractEvaluations(record) {
  if (Array.isArray(record.evaluations) && record.evaluations.length > 0) {
    return record.evaluations.slice();
  }
  // 兼容老 schema：record.evaluation 单条
  const e = record.evaluation;
  if (e && typeof e === 'object') {
    // 老 evaluation 没有 templateId / templateName，回退用 jdId / jdTitle / jdSnapshot.name
    const tid = e.jdId || e.templateId || '';
    const tname = (e.jdSnapshot && e.jdSnapshot.name) || e.jdTitle || e.templateName || (templatesById[tid] && templatesById[tid].name) || '(默认模板)';
    return [Object.assign({}, e, {
      templateId: tid,
      templateName: tname
    })];
  }
  return [];
}

// 子评估 verdict 文本(兼容 verdict / decision 字段名)
function subVerdictText(subEval) {
  const status = subEval.status || (subEval.decision || subEval.verdict ? 'done' : 'idle');
  const verdict = subEval.verdict || subEval.decision || '';
  if (status === 'unrouted') return '未识别岗位';
  if (status === 'queued') return '待评估';
  if (status === 'pending') return '评估中';
  if (status === 'failed') return '评估失败';
  if (status === 'idle') return '未评估';
  // done 状态:看 verdict
  if (verdict === '符合') return '符合';
  if (verdict === 'pass') return '不符合';
  if (verdict === 'unknown' || verdict === '信息不足') return '信息不足';
  return verdict || '?';
}

function subVerdictClass(subEval) {
  const status = subEval.status || (subEval.decision || subEval.verdict ? 'done' : 'idle');
  if (status === 'unrouted') return 'unrouted';
  if (status === 'queued' || status === 'pending' || status === 'idle') return 'pending';
  if (status === 'failed') return 'failed';
  const verdict = subEval.verdict || subEval.decision || '';
  if (verdict === '符合') return 'match';
  if (verdict === 'pass') return 'pass';
  if (verdict === 'unknown' || verdict === '信息不足') return 'unknown';
  return 'pending';
}

// v1.1.23 P3：子评估 jdContentHash !== templatesById[templateId].contentHash → [条件已变]
// 仅当 templatesById 里有该模板 + 两边 hash 均存在 + 不相等时返回 true
function isStale(subEval) {
  const tid = subEval.templateId;
  if (!tid) return false;
  const t = templatesById[tid];
  if (!t || !t.contentHash) return false;
  const evalHash = subEval.jdContentHash || '';
  if (!evalHash) return false;
  return t.contentHash !== evalHash;
}

// 时间格式化:今天 14:32 / 昨天 14:32 / 5-23 14:32
function fmtSubTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hh + ':' + mm;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (d.toDateString() === yesterday.toDateString()) return '昨 ' + hh + ':' + mm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hh + ':' + mm;
}

// 卡片头部"整体决策" CSS class
function multiCardClass(subEvals) {
  if (!subEvals.length) return 'pending';
  let matchCount = 0, passCount = 0, doneCount = 0;
  let allUnrouted = true;
  for (let i = 0; i < subEvals.length; i++) {
    const s = subEvals[i];
    const cls = subVerdictClass(s);
    if (cls !== 'unrouted') allUnrouted = false;
    if (cls === 'match') { matchCount++; doneCount++; }
    else if (cls === 'pass') { passCount++; doneCount++; }
    else if (cls === 'unknown') { doneCount++; }
  }
  if (allUnrouted) return 'unrouted';
  if (doneCount === 0) return 'pending';
  if (doneCount === subEvals.length) {
    if (matchCount === subEvals.length) return 'all-match';
    if (passCount === subEvals.length) return 'all-pass';
    return 'mixed';
  }
  return 'pending';
}

// 展开状态外挂(防 1500ms 全量重渲销毁 DOM display state)
const expandedMultiCardIds = new Set();
// v1.1.24:子评估行展开状态(每个 sub-row 的 reason + 条件 breakdown 二级 accordion)
// key = candidateId + '::' + templateId
const expandedSubRowIds = new Set();
function subRowKey(candidateId, templateId) {
  return String(candidateId) + '::' + String(templateId || '');
}

function renderMultiEvalCard(record) {
  const c = record.candidate || {};
  const basic = c.basic || {};
  const source = c.source || {};
  const subEvals = extractEvaluations(record);

  const cls = multiCardClass(subEvals);
  const initiallyOpen = expandedMultiCardIds.has(record.candidateId);

  const card = document.createElement('div');
  card.className = 'multi-eval-card ' + cls;

  // ── 头部 ──
  const header = document.createElement('div');
  header.className = 'multi-eval-header';

  const summary = document.createElement('div');
  summary.className = 'multi-eval-summary';

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = basic.name || '(无名)';
  nameEl.title = '点击在 BOSS 页面定位';
  nameEl.style.cursor = 'pointer';
  nameEl.addEventListener('click', function (ev) {
    ev.stopPropagation();
    locateCandidateInPage(record.candidateId, c.encryptUid || '');
  });
  summary.appendChild(nameEl);

  const scenarioLabel = source.scenario === 'recommend' ? '推荐页'
                       : source.scenario === 'latest' ? '最新页'
                       : source.scenario === 'chat' ? '沟通页'
                       : source.scenario === 'sayhi-tab' ? '新招呼'
                       : '';
  if (scenarioLabel) {
    const tag = document.createElement('span');
    tag.className = 'scenario-tag';
    tag.textContent = scenarioLabel;
    summary.appendChild(tag);
  }

  // 汇总 "符合 X / 总 Y"
  let matchCnt = 0, passCnt = 0, unknownCnt = 0, pendingCnt = 0;
  subEvals.forEach(function (s) {
    const k = subVerdictClass(s);
    if (k === 'match') matchCnt++;
    else if (k === 'pass') passCnt++;
    else if (k === 'unknown') unknownCnt++;
    else pendingCnt++;
  });
  const total = subEvals.length;
  const counts = document.createElement('span');
  counts.className = 'multi-eval-counts';
  counts.innerHTML = '<span class="c-match">符合 ' + matchCnt + '</span>' +
                     ' / ' + total + ' 模板' +
                     (passCnt > 0 ? ' · <span class="c-pass">' + passCnt + ' 不符</span>' : '') +
                     (unknownCnt > 0 ? ' · <span class="c-unknown">' + unknownCnt + ' 信息不足</span>' : '') +
                     (pendingCnt > 0 ? ' · ' + pendingCnt + ' 待评' : '');
  summary.appendChild(counts);
  header.appendChild(summary);

  const arrow = document.createElement('span');
  arrow.className = 'multi-eval-arrow';
  arrow.textContent = initiallyOpen ? '▼' : '▶';
  header.appendChild(arrow);

  card.appendChild(header);

  // 路由 header (沿用旧逻辑;把第一个子评估的 routedJdName / jobAligned 透出来,沟通页用)
  const firstEval = subEvals[0] || {};
  const routingRecord = {
    candidate: c,
    evaluation: firstEval
  };
  const routingHeader = makeRoutingHeader(routingRecord);
  if (routingHeader) {
    routingHeader.style.marginTop = '4px';
    card.appendChild(routingHeader);
  }

  // ── 展开:子评估列表 ──
  const sublist = document.createElement('div');
  sublist.className = 'multi-eval-sublist';
  sublist.style.display = initiallyOpen ? 'block' : 'none';

  if (subEvals.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'multi-eval-sub-row';
    empty.textContent = '尚无评估结果';
    sublist.appendChild(empty);
  } else {
    subEvals.forEach(function (s) {
      // v1.1.24:每个 sub-row 升级为 accordion — 点击展开看 LLM 理由 + 条件 breakdown(done)
      //   / 错误轨迹(failed)。v1.1.23 P3 重构时漏掉这个二级展开,HR 看不到 LLM 给出的具体判断依据。
      const status = s.status || (s.decision || s.verdict ? 'done' : 'idle');
      const expandable = (status === 'done') || (status === 'failed');

      const wrap = document.createElement('div');
      wrap.className = 'multi-eval-sub-wrap';

      const row = document.createElement('div');
      row.className = 'multi-eval-sub-row';
      if (expandable) row.classList.add('expandable');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'sub-template-name';
      nameSpan.textContent = s.templateName || (templatesById[s.templateId] && templatesById[s.templateId].name) || '(未命名模板)';
      nameSpan.title = nameSpan.textContent;
      row.appendChild(nameSpan);

      const verdict = document.createElement('span');
      verdict.className = 'sub-verdict ' + subVerdictClass(s);
      verdict.textContent = subVerdictText(s);
      row.appendChild(verdict);

      const ts = s.judgedAt || s.evaluatedAt || s.startedAt || 0;
      if (ts) {
        const tEl = document.createElement('span');
        tEl.className = 'sub-time';
        tEl.textContent = fmtSubTime(ts);
        tEl.title = new Date(ts).toLocaleString();
        row.appendChild(tEl);
      }

      // [条件已变] 红字（HR 决策:不做立即重评按钮，只是标记）
      if (isStale(s)) {
        const stale = document.createElement('span');
        stale.className = 'sub-stale';
        stale.textContent = '[条件已变]';
        stale.title = '此评估基于旧版模板，模板内容已被修改。下轮评估会按新模板重算。';
        row.appendChild(stale);
      }

      // 展开箭头(仅 done / failed 才显示)
      let subArrow = null;
      const rowKey = subRowKey(record.candidateId, s.templateId);
      const subInitiallyOpen = expandable && expandedSubRowIds.has(rowKey);
      if (expandable) {
        subArrow = document.createElement('span');
        subArrow.className = 'sub-arrow';
        subArrow.textContent = subInitiallyOpen ? '▼' : '▶';
        row.appendChild(subArrow);
      }

      wrap.appendChild(row);

      // 二级展开面板
      if (expandable) {
        const subExpand = document.createElement('div');
        subExpand.className = 'multi-eval-sub-expand';
        subExpand.style.display = subInitiallyOpen ? 'block' : 'none';

        if (status === 'failed') {
          // failed:错误信息 + perAttempt 轨迹(沿用旧 renderEvaluation 的失败分支风格)
          const errDiv = document.createElement('div');
          errDiv.className = 'sub-error';
          errDiv.textContent = '⚠ ' + (s.error || '评估失败');
          subExpand.appendChild(errDiv);

          if (Array.isArray(s.perAttempt) && s.perAttempt.length) {
            const traceWrap = document.createElement('div');
            traceWrap.className = 'attempt-trace';
            const summaryLine = document.createElement('div');
            summaryLine.className = 'attempt-summary';
            summaryLine.textContent = '尝试 ' + s.perAttempt.length + ' 次,总耗时 ' +
              (s.latencyMs ? (s.latencyMs / 1000).toFixed(1) + 's' : '?');
            traceWrap.appendChild(summaryLine);
            s.perAttempt.forEach(function (a, ai) {
              const it = document.createElement('details');
              it.className = 'attempt-item';
              const sm = document.createElement('summary');
              const sec = ((a.latencyMs || 0) / 1000).toFixed(1);
              const httpPart = a.httpStatus ? (' · HTTP ' + a.httpStatus) : '';
              sm.textContent = '第 ' + (ai + 1) + ' 次 · ' + sec + 's · ' + (a.errorName || 'OK') + httpPart;
              it.appendChild(sm);
              if (a.error) {
                const m = document.createElement('div');
                m.className = 'attempt-msg';
                m.textContent = a.error;
                it.appendChild(m);
              }
              if (a.rawLlmText) {
                const pre = document.createElement('pre');
                pre.className = 'attempt-body';
                pre.textContent = 'LLM raw:\n' + a.rawLlmText;
                it.appendChild(pre);
              }
              traceWrap.appendChild(it);
            });
            subExpand.appendChild(traceWrap);
          }
        } else {
          // done:LLM reason(一句话总结)+ 条件逐项 breakdown
          if (s.reason) {
            const reasonDiv = document.createElement('div');
            reasonDiv.className = 'sub-reason';
            reasonDiv.textContent = '📋 ' + s.reason;
            subExpand.appendChild(reasonDiv);
          }
          const snap = s.jdSnapshot || {};
          const mustConditions = Array.isArray(snap.mustConditions) ? snap.mustConditions : [];
          const optionalConditions = Array.isArray(snap.optionalConditions) ? snap.optionalConditions : [];
          const list = buildConditionsList(s, mustConditions, optionalConditions);
          if (list) subExpand.appendChild(list);
          if (!s.reason && !list) {
            const empty = document.createElement('div');
            empty.className = 'sub-reason empty';
            empty.textContent = '（评估完成但未保留理由 / 条件快照 — 可能是历史老数据）';
            subExpand.appendChild(empty);
          }
        }

        wrap.appendChild(subExpand);

        // 点击行切换二级展开;stopPropagation 防止冒泡到外层 header
        row.style.cursor = 'pointer';
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          const isOpen = subExpand.style.display !== 'none';
          subExpand.style.display = isOpen ? 'none' : 'block';
          if (subArrow) subArrow.textContent = isOpen ? '▶' : '▼';
          if (isOpen) expandedSubRowIds.delete(rowKey);
          else expandedSubRowIds.add(rowKey);
        });
      }

      sublist.appendChild(wrap);
    });
  }

  card.appendChild(sublist);

  header.addEventListener('click', function () {
    const isOpen = sublist.style.display !== 'none';
    sublist.style.display = isOpen ? 'none' : 'block';
    arrow.textContent = isOpen ? '▶' : '▼';
    if (isOpen) expandedMultiCardIds.delete(record.candidateId);
    else expandedMultiCardIds.add(record.candidateId);
  });

  return card;
}

// ===== 排序 =====
// 维持 v0.3 的"批次时间正序 + 批次内 indexInBatch 正序"，让侧栏与 BOSS 视觉顺序一致
function batchKey(record) {
  const src = (record.candidate && record.candidate.source) || {};
  // v1.1.23 P3：兼容多模板 record.evaluations[]（取最早 judgedAt 作为代表）
  const e = record.evaluation || {};
  const subEvals = Array.isArray(record.evaluations) ? record.evaluations : [];
  let fallbackTs = e.judgedAt || e.startedAt || 0;
  if (!fallbackTs && subEvals.length > 0) {
    for (let i = 0; i < subEvals.length; i++) {
      const ts = subEvals[i].judgedAt || subEvals[i].evaluatedAt || subEvals[i].startedAt || 0;
      if (ts && (!fallbackTs || ts > fallbackTs)) fallbackTs = ts;
    }
  }
  return src.batchAt || fallbackTs || 0;
}
function indexKey(record) {
  const src = (record.candidate && record.candidate.source) || {};
  return typeof src.indexInBatch === 'number' ? src.indexInBatch : 0;
}
function sortByBatchAndIndex(records) {
  return records.slice().sort(function (a, b) {
    const ab = batchKey(a);
    const bb = batchKey(b);
    if (ab !== bb) return ab - bb;
    return indexKey(a) - indexKey(b);
  });
}

let lastSeenChatBatchAt = 0;

// ===== 主刷新 =====
async function refreshEvaluations() {
  try {
    const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.GET_EVALUATIONS });
    if (!res) return;

    // v1.1.23 P3：jd-title 改为「岗位：{positionName} · {selectedCount} 模板」综合标
    //   原 res.jdTitle 是单 JD 名，现在按用户选择的 position + 勾选的 templates 数渲染
    const titleEl = $('jd-title');
    if (titleEl) {
      if (selectedPositionId && self.BossPositions) {
        try {
          const pos = await self.BossPositions.getPosition(selectedPositionId);
          const modelHint = res.modelId ? ' · ' + res.modelId : '';
          const tCount = selectedTemplateIds.size;
          titleEl.textContent = '岗位：' + ((pos && pos.name) || '?') + ' · ' + tCount + ' 模板' + modelHint;
        } catch (e) {
          titleEl.textContent = '岗位：— 未选 —';
        }
      } else {
        titleEl.textContent = '岗位：— 未选 —';
      }
    }

    // LLM 配置横幅
    const banner = $('llm-banner');
    if (!res.llmConfigured) {
      banner.className = 'llm-banner warn';
      banner.style.display = 'block';
      banner.innerHTML = '<strong>未配置 LLM</strong> — 评估无法进行，<a href="#" id="banner-open-options" style="color:inherit; text-decoration:underline;">点此打开设置页</a> 填入 API Key。';
      // innerHTML 重写后链接元素是新的，重新绑事件
      const link = $('banner-open-options');
      if (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          openOptions();
        });
      }
    } else {
      banner.style.display = 'none';
    }

    const list = $('evaluations');
    // v0.24.2 fix：推荐页 pane 只显示 recommend / latest scenario 候选人
    //   原 v0.20.6 注释假设 evaluations 表只有本轮数据，但沟通页评估也写同一张表
    //   导致单评沟通页候选人后他出现在推荐页列表（HR 反馈 BUG：李常发出现在推荐页）
    //   沟通页（chat / sayhi-tab）有独立的 #sayhi-evaluations 列表渲染，不应再混进 #evaluations
    const allRecords = sortByBatchAndIndex(res.records || []);
    const records = allRecords.filter(function (r) {
      const sc = r.candidate && r.candidate.source && r.candidate.source.scenario;
      // 推荐页 tab 收 recommend + latest；兜底兼容旧记录 scenario 缺失情况
      return sc === 'recommend' || sc === 'latest' || !sc;
    });
    $('eval-count').textContent = '(' + records.length + ')';

    list.innerHTML = '';
    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '尚未评估到候选人 — 选岗位 + 勾模板 + 点「开始本轮」后会自动评估';
      list.appendChild(empty);
    } else {
      // v1.1.23 P3：多模板渲染 — 一个候选人 × N 模板 = N 子评估,主卡折叠
      records.forEach(function (r) {
        list.appendChild(renderMultiEvalCard(r));
      });
    }

    // 沟通页新评估到达 → 滚到底
    let maxChatBatchAt = 0;
    for (let i = 0; i < records.length; i++) {
      const sc = records[i].candidate && records[i].candidate.source && records[i].candidate.source.scenario;
      if (sc === 'chat') {
        const b = batchKey(records[i]);
        if (b > maxChatBatchAt) maxChatBatchAt = b;
      }
    }
    if (lastSeenChatBatchAt !== 0 && maxChatBatchAt > lastSeenChatBatchAt) {
      list.scrollTop = list.scrollHeight;
    }
    if (maxChatBatchAt > lastSeenChatBatchAt) lastSeenChatBatchAt = maxChatBatchAt;
  } catch (e) {
    console.error('[BOSS-Sniffer panel] eval refresh failed:', e);
  }
}

async function refreshSayHiBar() {
  try {
    const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.GET_SAYHI_STATUS });
    if (!res) return;
    const bar = $('sayhi-bar');
    const cfgEnabled = res.sayHiConfig && res.sayHiConfig.enabled;
    if (!cfgEnabled) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const s = res.status;
    if (!s.consumerOn) {
      bar.className = 'sayhi-bar idle';
      $('sayhi-bar-text').textContent = '自动打招呼已启用，等待开始本轮';
    } else if (s.isResting) {
      bar.className = 'sayhi-bar resting';
      const mins = Math.ceil(s.restRemainingMs / 60000);
      $('sayhi-bar-text').textContent = '🛌 sayHi 休息中（剩 ~' + mins + ' 分钟）';
    } else if (s.queueLength > 0) {
      bar.className = 'sayhi-bar running';
      $('sayhi-bar-text').textContent = '▶ sayHi 消费中';
    } else {
      bar.className = 'sayhi-bar idle';
      $('sayhi-bar-text').textContent = '✓ sayHi 待命（无候选人在队）';
    }
    const counts = [];
    if (s.queueLength > 0) counts.push('待打 ' + s.queueLength);
    counts.push('本批次累计 ' + s.processedSinceRest);
    $('sayhi-bar-count').textContent = counts.join(' · ');
  } catch (e) {
    console.error('[BOSS-Sniffer panel] sayHi status failed:', e);
  }
}

// 顶部控制栏：基础筛选 / 推荐列表自动化 / N+K 输入 / 进度行 / sayHi 开关
async function refreshControlBar() {
  try {
    const [cfg, loopRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: BossMessageTypes.GET_CONFIG }),
      chrome.runtime.sendMessage({ type: BossMessageTypes.GET_LOOP_STATE })
    ]);
    if (!cfg) return;
    const sayHiEnabled = !!(cfg.config && cfg.config.sayHi && cfg.config.sayHi.enabled);
    const loop = (loopRes && loopRes.state) || { status: 'IDLE' };

    // v0.15.0：单入口架构，状态徽章只看 loop.status
    const pill = $('status-pill');
    if (loop.status === 'RUNNING') {
      pill.textContent = '本轮运行中';
      pill.className = 'status-pill running';
    } else if (loop.status === 'RESTING') {
      pill.textContent = '休息中';
      pill.className = 'status-pill resting';
    } else if (loop.status === 'PAUSED') {
      pill.textContent = '已暂停';
      pill.className = 'status-pill paused';
    } else if (loop.status === 'STOPPED') {
      pill.textContent = '已停止';
      pill.className = 'status-pill idle';
    } else {
      pill.textContent = '未开始';
      pill.className = 'status-pill idle';
    }

    // 启停按钮
    const looping = loop.status === 'RUNNING' || loop.status === 'RESTING';
    $('btn-start').disabled = looping || loop.status === 'PAUSED';
    $('btn-stop').disabled = !looping && loop.status !== 'PAUSED';
    $('btn-resume').style.display = loop.status === 'PAUSED' ? 'inline-block' : 'none';

    // N / K 输入框只有 IDLE / STOPPED 时可改
    const goalEditable = !looping && loop.status !== 'PAUSED';
    $('loop-goal-n').disabled = !goalEditable;
    $('loop-goal-k').disabled = !goalEditable;
    $('loop-target-tab').disabled = !goalEditable;

    // sayHi toggle 同步（避免连续点击时与 background 状态漂移）
    $('sayhi-toggle').checked = sayHiEnabled;

    // 进度行
    renderLoopProgress(loop);
  } catch (e) {
    console.error('[BOSS-Sniffer panel] control bar refresh failed:', e);
  }
}

function renderLoopProgress(loop) {
  const div = $('loop-progress');
  if (!loop || loop.status === 'IDLE') {
    div.style.display = 'none';
    return;
  }
  div.style.display = 'block';
  div.className = 'loop-progress' +
    (loop.status === 'PAUSED' ? ' paused' : '') +
    (loop.status === 'STOPPED' ? ' stopped' : '');

  const goalNStr = loop.goalN !== null ? loop.goalN : '∞';
  // v0.12.8：进度展示从"已翻 X/Y 轮"改成"已浏览 X*15/Y*15 人"，与下拉的人数语义对齐
  const peopleSeen = (loop.roundCount || 0) * 15;
  const peopleGoalStr = loop.goalK !== null ? (loop.goalK * 15) : '∞';

  if (loop.status === 'RUNNING') {
    const hint = loop.hint ? ' · ' + loop.hint : '';
    div.textContent = '进度：已招呼 ' + loop.sayhiCount + '/' + goalNStr +
      ' · 已浏览 ' + peopleSeen + '/' + peopleGoalStr + hint;
  } else if (loop.status === 'RESTING') {
    const remaining = Math.max(0, loop.restEndsAt - Date.now());
    const mm = Math.floor(remaining / 60000);
    const ss = Math.floor((remaining % 60000) / 1000);
    div.textContent = '休息中 ' + mm + ':' + (ss < 10 ? '0' : '') + ss +
      ' · 已招呼 ' + loop.sayhiCount + '/' + goalNStr;
  } else if (loop.status === 'PAUSED') {
    div.textContent = '⚠ ' + (loop.hint || '翻页失败');
  } else if (loop.status === 'STOPPED') {
    div.textContent = '已停止，共招呼 ' + loop.sayhiCount + ' 人 · 翻 ' + loop.roundCount + ' 轮' +
      (loop.hint ? ' · ' + loop.hint : '');
  }
}

async function refresh() {
  await Promise.all([refreshEvaluations(), refreshSayHiBar(), refreshControlBar()]);
}

// ===== 事件 =====

// v0.12.8：自动招呼 section 帮助 ⓘ 切换展开/收起
(function () {
  const toggle = $('auto-greet-help-toggle');
  const panel = $('auto-greet-help');
  if (!toggle || !panel) return;
  toggle.addEventListener('click', function () {
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    toggle.classList.toggle('open', !isOpen);
  });
})();

// 推荐列表自动化：仅控制本轮自动刷新/翻页/循环；开始本轮会确保基础筛选开启。
$('btn-start').addEventListener('click', async function () {
  // v1.1.23 P3：必须先选 BOSS 岗位 + 至少 1 个模板
  if (!selectedPositionId) {
    alert('请先在上方选择 BOSS 岗位');
    return;
  }
  if (selectedTemplateIds.size === 0) {
    alert('请至少勾选 1 个模板（chip 列表里）');
    return;
  }
  // 读 招呼数 / 浏览人数（v0.12.8）
  // 浏览人数 UI 是 15 的倍数（下拉 15/30/45/...），scheduler 内部用"轮"计数（每轮 = 1 页 ≈ 15 人），
  // 这里除 15 转成 scheduler 的 goalK 语义
  const nVal = parseInt($('loop-goal-n').value, 10);
  const kPeopleVal = parseInt($('loop-goal-k').value, 10);
  const goalN = (Number.isFinite(nVal) && nVal > 0) ? nVal : null;
  const goalK = (Number.isFinite(kPeopleVal) && kPeopleVal > 0) ? Math.ceil(kPeopleVal / 15) : null;

  if (goalN === null && goalK === null) {
    alert('请先填写本轮目标：招呼数 或 浏览人数（至少一个）');
    return;
  }

  const targetTab = $('loop-target-tab').value === 'latest' ? 'latest' : 'recommend';

  // 设了目标 → 启动 LOOP（START_LOOP 内部会确保基础筛选开启并触发 reload）
  // v1.1.23 P3：透传 positionId + templateIds 多选给 background
  const r = await chrome.runtime.sendMessage({
    type: BossMessageTypes.START_LOOP,
    goalN: goalN,
    goalK: goalK,
    tab: targetTab,
    positionId: selectedPositionId,
    templateIds: Array.from(selectedTemplateIds)
  });
  if (!r || !r.ok) {
    alert('启动失败：' + (r && r.error || '未知错误'));
    return;
  }
  showRefreshHint();
  refresh();
});

// 启动时显示橙色提示，5s 后查 candidate_pool 新事件数；若仍为 0 → 切红色提示手动刷新
function showRefreshHint() {
  const hintDiv = $('refresh-hint');
  if (!hintDiv) return;
  hintDiv.textContent = '⏳ 正在刷新 BOSS 页面以加载候选人...（约 2-3 秒）';
  hintDiv.className = 'refresh-hint loading';
  hintDiv.style.display = 'block';

  setTimeout(async function () {
    try {
      const r = await chrome.runtime.sendMessage({ type: BossMessageTypes.CHECK_RECENT_EVENTS });
      if (r && r.recentCount > 0) {
        // 已抓到首批 → 5 秒后自动隐藏提示
        hintDiv.textContent = '✓ 候选人已加载，正在评估';
        hintDiv.className = 'refresh-hint loading';
        setTimeout(function () { hintDiv.style.display = 'none'; }, 3000);
      } else {
        // 5s 内一个都没抓到 → 提示用户手动刷新
        hintDiv.innerHTML = '⚠ 自动刷新可能未生效，请<strong>手动刷新本页面</strong>';
        hintDiv.className = 'refresh-hint warn';
      }
    } catch (e) {
      console.warn('[BOSS-Sniffer panel] CHECK_RECENT_EVENTS 失败:', e);
    }
  }, 5000);
}

$('btn-stop').addEventListener('click', async function () {
  await chrome.runtime.sendMessage({ type: BossMessageTypes.STOP_LOOP });
  refresh();
});

$('btn-resume').addEventListener('click', async function () {
  const r = await chrome.runtime.sendMessage({ type: BossMessageTypes.RESUME_LOOP });
  if (!r || !r.ok) {
    alert('继续失败：' + (r && r.error || '未知错误'));
    return;
  }
  refresh();
});

// sayHi toggle：只控制自动打招呼能力；实际消费跟随推荐列表本轮状态。
$('sayhi-toggle').addEventListener('change', async function (ev) {
  const want = ev.target.checked;
  if (want) {
    // 启用前弹一次确认（原 admin 那段搬过来）
    const ok = confirm(
      '启用全自动打招呼后：\n\n' +
      '✓ 评估为「符合」的候选人会自动被打招呼\n' +
      '⚠ 浏览器顶部会持续出现"已开始调试此浏览器"的警告条（关闭即消失）\n' +
      '⚠ 期间不要手动开 BOSS 页面的 DevTools，会和扩展抢 debugger 权限\n\n' +
      '继续？'
    );
    if (!ok) {
      ev.target.checked = false;
      return;
    }
  }
  await chrome.runtime.sendMessage({
    type: BossMessageTypes.SET_CONFIG_SECTION,
    section: 'sayHi',
    patch: { enabled: want }
  });
  refresh();
});

// v1.1.23 P3：BOSS 岗位下拉切换 → 重新加载该岗位下的模板 chips
$('position-current').addEventListener('change', async function (ev) {
  selectedPositionId = ev.target.value || '';
  persistRecommendSelection();
  updatePositionWarn();
  // 切岗位 = 切了一整套候选模板,默认全选(forceAll=true)
  await refreshTemplatesForCurrentPosition({ forceAll: true });
});

// v1.1.23 P3：[全选] chip 快捷。v1.1.24 删除「全不选」——空集等价于"该候选人不评估"，无业务意义
const chipAllBtn = $('chip-shortcut-all');
if (chipAllBtn) {
  chipAllBtn.addEventListener('click', async function () {
    if (!selectedPositionId) return;
    const templates = await self.BossPositions.listTemplatesForPosition(selectedPositionId);
    selectedTemplateIds = new Set(templates.map(function (t) { return t.jdId; }));
    persistRecommendSelection();
    renderTemplateChips(templates);
  });
}

// v0.25.0：删「当前话术」下拉 + loadGreetDropdown（话术 v0.25.2 集成 JD 后由 JD 默认话术决定）
//   过渡期沿用 appConfig.currentGreetTemplateId（admin 仍有话术管理；HR 此前选过的话术继续生效）

// v1.0.1：推荐页「清空列表」inline 按钮 handler（跟沟通页 clear-pool-inline 对仗，复用现有 CLEAR_EVALUATIONS message）
//   清的是 evaluations 表（候选人评估列表），看板/事件流的判定结果统计不受影响
const btnClearEvalInline = $('btn-clear-evaluations-inline');
if (btnClearEvalInline) {
  btnClearEvalInline.addEventListener('click', async function () {
    if (!confirm('确定清空推荐页候选人列表吗？\n（已写入看板的判定结果统计不受影响）')) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.CLEAR_EVALUATIONS });
      if (res && res.ok) {
        showToast('✅ 列表已清空');
      } else {
        showToast('清空失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('清空失败：' + e.message, 'error');
    }
    refresh();
  });
}

// v0.17.1.3：检查 appConfig.autoAction.enabledBatchEval（批量自动开关），决定是否亮「批量自动 ON」徽章
//   单评始终手动，不需要徽章（HR 始终自己点 🎯 决定）
async function refreshAutoActionBadge() {
  try {
    const r = await chrome.runtime.sendMessage({ type: BossMessageTypes.GET_CONFIG });
    const on = r && r.config && r.config.autoAction && r.config.autoAction.enabledBatchEval;
    const badge = $('auto-action-badge');
    if (badge) badge.style.display = on ? '' : 'none';
  } catch (e) {
    // GET_CONFIG 失败不影响其他功能
  }
}

// ===== v1.1.23 P3：BOSS 岗位 + 模板 chips 多选 =====
// 选择状态(module-level,跨刷新保留):
//   selectedPositionId: 当前选中的 BOSS 岗位
//   selectedTemplateIds: Set<jdId> 当前选中(打钩)的模板
// chrome.storage.local 持久化 key:
//   sidepanel.recommendPositionId / sidepanel.recommendTemplateIds
const RECOMMEND_POSITION_KEY = 'sidepanel.recommendPositionId';
const RECOMMEND_TEMPLATE_IDS_KEY = 'sidepanel.recommendTemplateIds';
let selectedPositionId = '';
let selectedTemplateIds = new Set();
// templatesById 缓存(供候选人卡渲染时 [条件已变] 比对当前 contentHash 用)
let templatesById = {};

function persistRecommendSelection() {
  try {
    chrome.storage.local.set({
      [RECOMMEND_POSITION_KEY]: selectedPositionId,
      [RECOMMEND_TEMPLATE_IDS_KEY]: Array.from(selectedTemplateIds)
    });
  } catch (e) { /* swallow */ }
}

async function restoreRecommendSelection() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get([RECOMMEND_POSITION_KEY, RECOMMEND_TEMPLATE_IDS_KEY], function (r) {
        if (r && typeof r[RECOMMEND_POSITION_KEY] === 'string') selectedPositionId = r[RECOMMEND_POSITION_KEY];
        if (r && Array.isArray(r[RECOMMEND_TEMPLATE_IDS_KEY])) selectedTemplateIds = new Set(r[RECOMMEND_TEMPLATE_IDS_KEY]);
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

function renderTemplateChips(templates) {
  const wrap = $('template-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!templates || templates.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'template-chips-empty';
    empty.textContent = '该岗位下尚无模板（去 ⚙️ 设置新建）';
    wrap.appendChild(empty);
    return;
  }
  templates.forEach(function (t) {
    const chip = document.createElement('label');
    chip.className = 'template-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = t.jdId;
    cb.checked = selectedTemplateIds.has(t.jdId);
    if (cb.checked) chip.classList.add('checked');
    cb.addEventListener('change', function () {
      if (cb.checked) {
        selectedTemplateIds.add(t.jdId);
        chip.classList.add('checked');
      } else {
        selectedTemplateIds.delete(t.jdId);
        chip.classList.remove('checked');
      }
      persistRecommendSelection();
    });
    chip.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = t.name || '(未命名)';
    chip.appendChild(txt);
    wrap.appendChild(chip);
  });
}

async function refreshTemplatesForCurrentPosition(opts) {
  opts = opts || {};
  if (!self.BossPositions || !selectedPositionId) {
    renderTemplateChips([]);
    return;
  }
  const templates = await self.BossPositions.listTemplatesForPosition(selectedPositionId);
  // 更新 templatesById 缓存(候选人卡 [条件已变] 比对用)
  templates.forEach(function (t) { templatesById[t.jdId] = t; });
  // 默认全选:第一次进入此岗位 / 之前选的 templateIds 集合跟当前模板列表完全无交集 → 重置为全选
  const currentIds = new Set(templates.map(function (t) { return t.jdId; }));
  const hasOverlap = Array.from(selectedTemplateIds).some(function (id) { return currentIds.has(id); });
  if (opts.forceAll || !hasOverlap) {
    selectedTemplateIds = new Set(templates.map(function (t) { return t.jdId; }));
    persistRecommendSelection();
  } else {
    // 清掉不属于当前 position 的残留 id(切岗位场景)
    const cleaned = new Set();
    selectedTemplateIds.forEach(function (id) { if (currentIds.has(id)) cleaned.add(id); });
    if (cleaned.size !== selectedTemplateIds.size) {
      selectedTemplateIds = cleaned;
      persistRecommendSelection();
    }
  }
  renderTemplateChips(templates);
  // 兼容老 background:把第一个选中的模板写到 BossJD.currentJdId,让历史 START_LOOP 路径仍能 fallback
  if (self.BossJD && selectedTemplateIds.size > 0) {
    const firstId = Array.from(selectedTemplateIds)[0];
    self.BossJD.setCurrentJdId(firstId).catch(function () {});
  }
}

function updatePositionWarn() {
  const warn = $('position-warn');
  if (!warn) return;
  warn.style.display = selectedPositionId ? 'none' : 'block';
}

// 启动时填充 BOSS 岗位下拉 + 当前岗位下的模板 chips
async function loadPositionAndTemplates() {
  if (!self.BossJD || !self.BossPositions) {
    console.warn('[panel] BossJD / BossPositions 模块未加载');
    return;
  }
  // ensureSeeded 包揽 JD 模板 + position 自动建表 + 老数据迁移
  await self.BossJD.ensureSeeded();
  await self.BossPositions.ensureSeeded();
  await restoreRecommendSelection();

  const positions = await self.BossPositions.listPositions();
  const sel = $('position-current');
  sel.innerHTML = '';
  if (positions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— 无可选岗位（去 ⚙️ 设置新建）—';
    sel.appendChild(opt);
    selectedPositionId = '';
    updatePositionWarn();
    renderTemplateChips([]);
    return;
  }
  // 默认选第一个岗位（持久化选择优先）
  const validPersisted = positions.find(function (p) { return p.positionId === selectedPositionId; });
  if (!validPersisted) {
    selectedPositionId = positions[0].positionId;
    persistRecommendSelection();
  }
  positions.forEach(function (p) {
    const opt = document.createElement('option');
    opt.value = p.positionId;
    opt.textContent = p.name || '(未命名)';
    if (p.positionId === selectedPositionId) opt.selected = true;
    sel.appendChild(opt);
  });
  updatePositionWarn();
  await refreshTemplatesForCurrentPosition({ forceAll: !validPersisted });
}

// 缓存全量 templates(沟通页渲染时 templatesById 也需要)
async function refreshTemplatesCache() {
  if (!self.BossJD) return;
  try {
    const all = await self.BossJD.listTemplates();
    all.forEach(function (t) { templatesById[t.jdId] = t; });
  } catch (e) { /* swallow */ }
}

// v0.20.6：删除 btn-clear / btn-clear-eval。HR 无业务场景需要主动清；
// START_LOOP 已自动清 evaluations。开发调试用 admin「危险操作」区或 DevTools IndexedDB。

// 打开设置页
function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('admin/admin.html'));
  }
}
$('btn-options').addEventListener('click', openOptions);
const bannerLink = $('banner-open-options');
if (bannerLink) {
  bannerLink.addEventListener('click', function (e) {
    e.preventDefault();
    openOptions();
  });
}

// v0.20.2：打开看板（新标签页）
const btnDashboard = $('btn-dashboard');
if (btnDashboard) {
  btnDashboard.addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });
}

// 初始化 + 自动刷新
// 看板入口已迁移到 admin 顶部（v0.12.3）；sidepanel 不再放看板按钮
// v1.1.23 P3：旧 loadJDDropdown 替换为 loadPositionAndTemplates（二级选择器）
loadPositionAndTemplates();
refreshTemplatesCache();  // v1.1.23 P3：缓存全量 templates 供 [条件已变] 判断
// v0.25.0：删 loadGreetDropdown 调用（#greet-current 元素已删）
refreshAutoActionBadge();      // v0.17.1.0
refresh();
setInterval(refresh, 1500);
// 每 5s 刷一次 autoAction 徽章（admin 改了 toggle 后 ≤5s 反映过来）
setInterval(refreshAutoActionBadge, 5000);
// 每 10s 刷一次 templates 缓存（admin 改了模板内容 → 沟通页 [条件已变] 标即时反应）
setInterval(refreshTemplatesCache, 10000);

// observability v1: 版本号三连点导出诊断包
// 600ms 内累计 3 次 click 触发,带宽度刚好避开误触
(function setupDiagExport() {
  const tag = $('version-tag');
  if (!tag) return;
  if (chrome.runtime && chrome.runtime.getManifest) {
    tag.textContent = 'v' + chrome.runtime.getManifest().version;
  }
  let clicks = 0;
  let timer = null;
  tag.style.cursor = 'pointer';
  tag.addEventListener('click', async function () {
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(function () { clicks = 0; }, 600);
    if (clicks < 3) return;
    clicks = 0;
    const prev = tag.textContent;
    tag.textContent = '生成中…';
    try {
      const resp = await chrome.runtime.sendMessage({ type: BossMessageTypes.EXPORT_DIAG_BUNDLE });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '未知错误');
      const bundle = resp.bundle;
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const stamp = now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'boss-sniffer-diag-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      tag.textContent = '✓ 已导出';
    } catch (err) {
      tag.textContent = '✗ 导出失败';
      console.error('[BOSS-Sniffer panel] export diag bundle failed:', err);
    }
    setTimeout(function () { tag.textContent = prev; }, 1500);
  });
})();

// ============ v0.13.0：沟通页「新招呼」一键评估模块 ============
(function initSayhiPane() {
  const PANE_KEY = 'currentPaneTab';
  const tabs = document.querySelectorAll('.page-tab');
  const panes = document.querySelectorAll('[data-page-pane]');
  let currentPane = 'recommend';
  let sayhiTimer = null;
  let evalPollTimer = null;

  function setActivePane(name) {
    currentPane = name;
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.page === name); });
    panes.forEach(function (p) { p.hidden = p.dataset.pagePane !== name; });
    try { chrome.storage.local.set({ [PANE_KEY]: name }); } catch (e) {}
    if (name === 'sayhi') {
      refreshSayhiPane();
      if (!sayhiTimer) sayhiTimer = setInterval(refreshSayhiPane, 1500);
    } else if (sayhiTimer) {
      clearInterval(sayhiTimer);
      sayhiTimer = null;
    }
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { setActivePane(t.dataset.page); });
  });

  // 恢复上次 tab
  try {
    chrome.storage.local.get(PANE_KEY, function (r) {
      if (r && r[PANE_KEY] === 'sayhi') setActivePane('sayhi');
    });
  } catch (e) {}

  // ===== 数据拉取 + 渲染 =====
  // v0.22.1 · Phase 2·2b：开始处理本批 按钮在 click handler 内部跑扫描+评估，
  // 期间 refreshSayhiPane 不能覆盖按钮文字（否则会刷成"评估中"或"开始处理本批"）。
  // 用 sayhiStartInFlight 标志 gate 住，handler 退出后 refresh 接管。
  let sayhiStartInFlight = false;

  async function refreshSayhiPane() {
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.GET_SAYHI_POOL });
      if (!res || !res.ok) return;
      renderPool(res);
    } catch (e) {
      // SW 唤醒失败等
    }
  }

  function renderPool(res) {
    const pool = res.pool || [];
    const evalMap = res.evaluationsByCandidateId || {};
    const evalStatus = res.evalStatus || { running: false, total: 0, done: 0 };

    // 顶部计数（v0.21.0 · 1d：删了 sayhi-jd-title 全局 JD 标，沟通页每候选人各自走自己 JD 路由）
    $('sayhi-pool-count').textContent = '(' + pool.length + ')';
    $('sayhi-pool-count-2').textContent = pool.length;

    // 陈旧提示：池子里最旧 capturedAt > 1 小时
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const oldest = pool.length ? Math.min.apply(null, pool.map(function (c) { return c.capturedAt || 0; })) : Date.now();
    $('sayhi-pool-stale-hint').style.display = (pool.length && oldest < oneHourAgo) ? 'inline' : 'none';

    // 一键评估按钮：可评估人数（未评估 / 评估超过 30min / 失败）
    const staleCutoff = Date.now() - 30 * 60 * 1000;
    const todo = pool.filter(function (c) {
      const e = evalMap[c.candidateId];
      if (!e || !e.evaluation) return true;
      if (e.evaluation.status === 'failed') return true;
      if ((e.evaluation.judgedAt || 0) < staleCutoff) return true;
      return false;
    });
    const evalBtn = $('btn-sayhi-eval');
    evalBtn.disabled = todo.length === 0 || evalStatus.running || !res.llmConfigured;
    if (evalStatus.running) {
      evalBtn.textContent = '⏳ 评估中…';
    } else if (todo.length === 0 && pool.length > 0) {
      evalBtn.textContent = '⚡ 全部已评估';
    } else {
      evalBtn.textContent = '⚡ 一键评估 ' + todo.length + ' 人';
    }

    // v0.22.1 · Phase 2·2b：新统一按钮 #btn-sayhi-start / #btn-sayhi-stop-batch 状态管理
    // click handler 内部期间（sayhiStartInFlight=true）由 handler 直接控制按钮文字，refresh 不干预
    if (!sayhiStartInFlight) {
      const startBtn = $('btn-sayhi-start');
      const stopBatchBtn = $('btn-sayhi-stop-batch');
      if (startBtn && stopBatchBtn) {
        if (evalStatus.running) {
          startBtn.disabled = true;
          startBtn.textContent = '⚡ 评估中 ' + evalStatus.done + ' / ' + evalStatus.total;
          stopBatchBtn.disabled = false;
        } else {
          startBtn.disabled = !res.llmConfigured;
          startBtn.textContent = '▶ 开始处理本批';
          stopBatchBtn.disabled = true;
        }
      }
    }

    // v0.24.1：移除 v0.22.2 的 jdHasAliases 联动约束（设计已过时）
    //   旧设计：当前 JD 没配 bossJobNames → 强制 disabled「防错岗」
    //   过时原因：v0.21.2 multi-JD per-candidate 路由完成后，unrouted 候选人
    //   在 evalSayhiCore 循环开头 continue 跳过 LLM + 跳过自动操作。
    //   即配置态和执行态解耦——checkbox 可点 = 表达 HR 意图；runtime 仍按
    //   候选人路由结果决定是否触发自动操作。
    //   也移除 evalStatus.running 限制（评估中也允许改，下个候选人即生效）。
    const autoCfg = res.autoAction || { enabledBatchEval: false, autoMarkUnsuitable: false };
    const autoGreetEl = $('sayhi-auto-greet-toggle');
    const autoMarkEl = $('sayhi-auto-mark-unsuitable-toggle');
    if (autoGreetEl) {
      autoGreetEl.checked = !!autoCfg.enabledBatchEval;
      autoGreetEl.disabled = false;
      autoGreetEl.title = '评估为「符合」时自动输入话术 + 求简历。仅对路由命中 JD 的候选人生效（未命中候选人 unrouted 跳过）。';
    }
    if (autoMarkEl) {
      autoMarkEl.checked = !!autoCfg.autoMarkUnsuitable;
      autoMarkEl.disabled = false;
      autoMarkEl.title = '评估为「pass」时入队 30s 撤销窗口后自动标不合适。仅对路由命中 JD 的候选人生效（未命中候选人 unrouted 跳过）。';
    }

    // v0.25.0：删 N 招呼数 input（maxGreetN 概念彻底废弃）；仅保留 K 浏览人数 input
    const batchCfg = res.sayhiBatch || { maxBrowseK: null };
    const kInput = $('sayhi-loop-goal-k');
    if (kInput) {
      // 避免 HR 正在输入时被 1.5s 轮询覆盖（focus 状态下不刷 value）
      if (document.activeElement !== kInput) {
        kInput.value = batchCfg.maxBrowseK == null ? '' : String(batchCfg.maxBrowseK);
      }
      kInput.disabled = evalStatus.running;
      kInput.title = evalStatus.running
        ? '评估运行中，停止后再改阈值'
        : '本批最多评估几人，留空 = 处理本批所有未读';
    }

    // 进度条
    const progressEl = $('sayhi-progress');
    const stopBtn = $('btn-sayhi-stop');
    if (evalStatus.running || (evalStatus.total > 0 && evalStatus.done < evalStatus.total)) {
      progressEl.classList.add('active');
      stopBtn.style.display = evalStatus.running ? 'inline-block' : 'none';
      const pct = evalStatus.total ? Math.round(evalStatus.done * 100 / evalStatus.total) : 0;
      // v1.1.17:实时速率 + ETA
      //   平均 X 秒/人 = (now - startedAt) / done(done > 0 时)
      //   还需 Y 分钟 = (total - done) × 平均秒 / 60(done > 0 且 running 时)
      let rateText = '';
      if (evalStatus.startedAt && evalStatus.done > 0) {
        const elapsedMs = Date.now() - evalStatus.startedAt;
        const avgSec = elapsedMs / evalStatus.done / 1000;
        rateText = ' · 平均 ' + avgSec.toFixed(1) + ' 秒/人';
        if (evalStatus.running && evalStatus.done < evalStatus.total) {
          const remainCount = evalStatus.total - evalStatus.done;
          const etaSec = remainCount * avgSec;
          if (etaSec < 60) {
            rateText += ' · 还需 ' + Math.round(etaSec) + ' 秒';
          } else {
            const etaMin = Math.floor(etaSec / 60);
            const etaSecRem = Math.round(etaSec % 60);
            rateText += ' · 还需 ' + etaMin + ' 分' + (etaSecRem > 0 ? etaSecRem + ' 秒' : '');
          }
        }
      }
      $('sayhi-progress-text').textContent =
        (evalStatus.running ? '评估中 ' : (evalStatus.abortRequested ? '已停止 ' : '已完成 ')) +
        evalStatus.done + ' / ' + evalStatus.total + '（' + pct + '%）' + rateText;
      $('sayhi-progress-fill').style.width = pct + '%';
    } else {
      progressEl.classList.remove('active');
      stopBtn.style.display = 'none';
    }

    // 候选人列表渲染
    const listEl = $('sayhi-evaluations');
    if (!pool.length) {
      listEl.innerHTML =
        '<div class="sayhi-empty"><strong>开始评估「新招呼」候选人</strong><br>' +
        '1. 在 BOSS 直聘切到「沟通」→「新招呼」tab<br>' +
        '2. 回这里点 <em>🔍 扫描本页候选人</em>，扫到的人进池<br>' +
        '3. 点 <em>⚡ 一键评估</em>，LLM 跑完后这里出符合 / pass 结果</div>';
      return;
    }

    // 用 evaluations 包装一遍（如有），没评估的也显示
    listEl.innerHTML = '';
    pool.forEach(function (c) {
      const evalRec = evalMap[c.candidateId];
      let record;
      if (evalRec) {
        record = evalRec;
      } else {
        // 未评估：构造 pending-like 占位
        record = {
          candidateId: c.candidateId,
          candidate: c,
          evaluation: { status: 'idle' }  // 占位状态
        };
      }
      listEl.appendChild(renderSayhiCard(record, c));
    });

    // v0.24.4：删 renderDismissedQueue 调用（30s 撤销窗口设计回退）
  }

  // v0.14.0-pre：操作调试日志（内存数组，最近 N 条）
  const debugLogs = [];
  const DEBUG_LOG_MAX = 30;

  function pushDebugLog(entry) {
    debugLogs.unshift(entry);
    if (debugLogs.length > DEBUG_LOG_MAX) debugLogs.length = DEBUG_LOG_MAX;
    renderDebugLog();
  }

  function renderDebugLog() {
    const box = $('sayhi-debug-log');
    const cnt = $('sayhi-debug-count');
    if (!box) return;
    if (cnt) cnt.textContent = '(' + debugLogs.length + ')';
    if (!debugLogs.length) {
      box.innerHTML = '<div style="color:#aaa;">尚无操作记录</div>';
      return;
    }
    const html = debugLogs.map(function (rec) {
      const time = new Date(rec.t).toLocaleTimeString();
      const okMark = rec.ok ? '<span style="color:#0a8">✅</span>' : '<span style="color:#c33">❌</span>';
      const partial = rec.partial ? ' <span style="color:#e90;">(partial)</span>' : '';
      const stepsHtml = (rec.logs || []).map(function (s) {
        const stepOk = s.ok ? '✓' : '✗';
        const detail = s.detail ? ' <span style="color:#999">' + escapeHtml(String(s.detail).slice(0, 100)) + '</span>' : '';
        return '<div style="margin-left:14px;color:' + (s.ok ? '#070' : '#c33') + ';">' + stepOk + ' ' + escapeHtml(s.step) + detail + '</div>';
      }).join('');
      const err = rec.error ? '<div style="margin-left:14px;color:#c33;">⚠ ' + escapeHtml(rec.error) + '</div>' : '';
      return '<div style="margin-bottom:6px;border-bottom:1px dashed #ddd;padding-bottom:4px;">' +
        '<div>' + okMark + ' [' + time + '] <b>' + escapeHtml(rec.name || rec.candidateId) + '</b> · ' + escapeHtml(rec.actionLabel || rec.action || '') + partial + '</div>' +
        stepsHtml + err +
        '</div>';
    }).join('');
    box.innerHTML = html;
  }

  // v1.1.22 删除重复的 escapeHtml 嵌套定义,IIFE 闭包内引用外层 module 级 escapeHtml(line 210)

  // v0.14.0-pre：一键操作按钮工厂（根据评估 decision 显示求简历 / 标不合适）
  // v0.17.1.1：决策「符合」按钮文案改为「话术+求简历」，走新链路（与⚡单评自动后的链路一致）
  function makeActionButton(record, poolItem) {
    const e = (record && record.evaluation) || {};
    if (e.status === 'failed' || !e.decision) return null;
    let action, label, color;
    if (e.decision === '符合') {
      action = 'request-resume';
      label = '🎯 话术+求简历';
      color = '#2467f0';
    } else if (e.decision === 'pass') {
      action = 'mark-unsuitable';
      label = '🎯 标不合适';
      color = '#d33';
    } else {
      return null;
    }
    const btn = document.createElement('button');
    btn.className = 'btn-sayhi-action';
    btn.textContent = label;
    btn.title = e.decision === '符合'
      ? '在 BOSS 沟通页发送当前话术 → 点求简历 → 确定（始终真实执行，忽略 admin 试跑模式）'
      : '在 BOSS 沟通页点不合适（卡片会消失）';
    btn.style.cssText = 'font-size:10px;padding:2px 8px;margin-left:4px;background:#fff;border:1px solid ' + color + ';color:' + color + ';border-radius:4px;cursor:pointer;';
    btn.addEventListener('mouseenter', function () { btn.style.background = color; btn.style.color = '#fff'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = '#fff'; btn.style.color = color; });
    btn.addEventListener('click', async function (ev) {
      ev.stopPropagation();
      const name = (poolItem && poolItem.basic && poolItem.basic.name) || record.candidateId;
      // v0.17.1.1：「符合」决策现在走话术+求简历两步消息，confirm 文案要交代清楚
      const verb = action === 'request-resume' ? '发送当前话术 → 求简历 → 确定' : '标不合适';
      if (!confirm('将在 BOSS 沟通页对 ' + name + ' 执行：' + verb + '。\n\n请确保已切到沟通 tab。继续？')) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '⏳ 执行中…';
      try {
        const res = await chrome.runtime.sendMessage({
          type: BossMessageTypes.EXECUTE_SAYHI_ACTION,
          candidateId: record.candidateId
        });
        pushDebugLog({
          t: Date.now(),
          candidateId: record.candidateId,
          name: name,
          action: action,
          actionLabel: label,
          ok: !!(res && res.ok),
          partial: !!(res && res.partial),
          logs: (res && res.logs) || [],
          error: res && res.error || null
        });
        if (res && res.ok) {
          // v0.17.1.1：partial 含义随 action 变化（greet-then-resume：话术发了但求简历失败；mark-unsuitable：卡片未消失）
          const partialHint = action === 'request-resume' ? '部分步骤失败，请看日志' : '卡片未自动消失';
          showToast((res.partial ? '⚠ 部分成功（' + partialHint + '）：' : '✅ 操作成功：') + name + ' · ' + verb, res.partial ? 'error' : '');
        } else {
          showToast('❌ 操作失败：' + ((res && res.error) || '未知'), 'error');
        }
        // 打开 debug 折叠区让用户看日志
        try { $('sayhi-debug-details').open = true; } catch (e) {}
      } catch (e) {
        pushDebugLog({
          t: Date.now(),
          candidateId: record.candidateId,
          name: name,
          action: action,
          actionLabel: label,
          ok: false,
          logs: [],
          error: e.message
        });
        showToast('操作异常：' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
        refreshSayhiPane();
      }
    });
    return btn;
  }

  // v0.13.3：单人评估按钮工厂（占位卡 + 已评估卡共用）
  function makeSingleEvalButton(candidateId) {
    const btn = document.createElement('button');
    btn.className = 'btn-single-eval';
    btn.textContent = '⚡ 评估';
    btn.title = '单独评估此人（含主动 fetch 补全字段）';
    btn.style.cssText = 'font-size:10px;padding:2px 8px;margin-left:4px;background:#fff;border:1px solid #2467f0;color:#2467f0;border-radius:4px;cursor:pointer;';
    btn.addEventListener('mouseenter', function () { btn.style.background = '#2467f0'; btn.style.color = '#fff'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = '#fff'; btn.style.color = '#2467f0'; });
    btn.addEventListener('click', async function (ev) {
      ev.stopPropagation();
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '⏳ 补字段中…';
      try {
        const res = await chrome.runtime.sendMessage({
          type: BossMessageTypes.EVAL_SAYHI_SINGLE,
          candidateId: candidateId
        });
        if (res && res.ok) {
          if (res.total === 0) {
            showToast(res.message || '已评估，无需重评');
          } else {
            showToast('已启动单人评估');
          }
        } else {
          showToast('单人评估失败：' + ((res && res.error) || '未知'), 'error');
        }
      } catch (e) {
        showToast('单人评估失败：' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
        refreshSayhiPane();
      }
    });
    return btn;
  }

  function renderSayhiCard(record, poolItem) {
    // v1.1.23 P3：沟通页卡片改用 renderMultiEvalCard（与推荐页同款多模板渲染）
    // 输入 record 兼容老/新 schema(extractEvaluations 内部处理):
    //   - 新: record.evaluations = [{templateId, templateName, verdict, ...}, ...]
    //   - 老: record.evaluation = {decision, ...} 单条 → 包成 [evaluation]
    //   - 占位: record.evaluation.status === 'idle' (扫描入池但未评估)
    const e = record.evaluation || {};
    const subEvals = Array.isArray(record.evaluations) ? record.evaluations : [];
    const isIdlePlaceholder = (e.status === 'idle' && subEvals.length === 0);

    // 兜底:占位场景下补一个 idle 子条目,让多模板卡渲染正常;同时确保 candidate 字段有值
    let renderRecord = record;
    if (isIdlePlaceholder) {
      renderRecord = Object.assign({}, record, {
        evaluations: [{ templateId: '', templateName: '(尚未评估)', status: 'idle' }],
        candidate: record.candidate || poolItem
      });
    } else if (!record.candidate && poolItem) {
      renderRecord = Object.assign({}, record, { candidate: poolItem });
    }

    const card = renderMultiEvalCard(renderRecord);

    // 沟通页特殊:lastAction 徽章贴在 multi-eval-counts 后面
    const last = poolItem && poolItem.lastAction;
    if (last) {
      const ok = last.ok && !last.partial;
      let actionLabel;
      if (last.action === 'request-resume') actionLabel = '求简历';
      else if (last.action === 'mark-unsuitable') actionLabel = '标不合适';
      else if (last.action === 'greet-then-resume') actionLabel = '🎯 话术+求简历';
      else actionLabel = last.action || '?';

      const tag = document.createElement('span');
      tag.textContent = last.action === 'greet-then-resume' && ok
        ? '🎯 话术+求简历 ✓'
        : (ok ? '已执行 ✓' : (last.partial ? '部分成功 ⚠' : '执行失败 ✗'));
      tag.title = actionLabel + ' · ' + new Date(last.attemptedAt || 0).toLocaleString() +
                  (last.error ? ' · 错误：' + last.error : '');
      tag.style.cssText = 'margin-left:6px;font-size:10px;padding:1px 6px;border-radius:3px;background:' +
                          (ok ? '#e6f7ec' : (last.partial ? '#fff7e6' : '#fce6e6')) + ';color:' +
                          (ok ? '#0a8' : (last.partial ? '#e90' : '#c33')) + ';';
      const counts = card.querySelector('.multi-eval-counts');
      if (counts) counts.appendChild(tag);
    }
    return card;
  }

  // ===== 按钮事件 =====

  // v0.22.1 · Phase 2·2b：统一"开始处理本批"按钮 — 串行执行扫描 + 评估
  // 旧的 btn-sayhi-scan / -eval 仍可单独点（2d 才迁移到测试模式折叠区）
  $('btn-sayhi-start').addEventListener('click', async function () {
    if (sayhiStartInFlight) return;
    const btn = $('btn-sayhi-start');
    sayhiStartInFlight = true;
    btn.disabled = true;
    btn.textContent = '🔍 扫描中（约 5-10 秒）…';
    try {
      // Phase 1：扫描本页候选人入池
      const scanRes = await chrome.runtime.sendMessage({ type: BossMessageTypes.SCAN_SAYHI_TAB });
      // v1.1.25:错 tab 拦截 — 用户在非「新招呼」一级 tab 下点了开始,inject.js 校验失败
      //   旧版没拦,会把「全部 / 沟通中」等 tab 下的候选人当新招呼跑评估,结果错乱
      if (scanRes && scanRes.error === 'wrong_tab') {
        const activeTab = scanRes.activeTab || '(未识别)';
        showToast('当前在「' + activeTab + '」tab，筛选只能在「新招呼」tab 下进行。请切到「新招呼」tab 后重试', 'error');
        return;
      }
      if (!scanRes || !scanRes.ok) {
        showToast('扫描失败：' + ((scanRes && scanRes.error) || '未知错误'), 'error');
        return;
      }
      if (!scanRes.scanned) {
        const hint = scanRes.message || '未扫到候选人 — 请切到 BOSS「沟通」→「新招呼」tab 后再点';
        showToast(hint, 'error');
        return;
      }
      showToast('✅ 扫到 ' + scanRes.scanned + ' 人，入池 ' + scanRes.upserted + ' 人，开始评估…');

      // Phase 2：触发批量评估（背景串行循环，含 1c 路由层）
      btn.textContent = '⚡ 启动评估…';
      const evalRes = await chrome.runtime.sendMessage({ type: BossMessageTypes.EVAL_SAYHI_BATCH });
      if (!evalRes || !evalRes.ok) {
        showToast('评估启动失败：' + ((evalRes && evalRes.error) || '未知错误'), 'error');
        return;
      }
      if (evalRes.total === 0) {
        showToast(evalRes.message || '池子里所有候选人都已评估且未陈旧');
      }
      // 评估异步进行中 — 后续按钮状态 / 进度条由 refreshSayhiPane 轮询 evalStatus 接管
    } catch (e) {
      showToast('开始处理失败：' + e.message, 'error');
    } finally {
      sayhiStartInFlight = false;
      refreshSayhiPane();  // 让按钮 / 进度立刻对齐 evalStatus
    }
  });

  // v0.22.2 · Phase 2·2c：自动操作 checkbox 写回 appConfig.autoAction
  // sidepanel checkbox toggle → SET_CONFIG_SECTION → background 更新 appConfig + 持久化到 chrome.storage.sync
  // evalSayhiCore 下次跑时读到新 flag（无需重启）
  $('sayhi-auto-greet-toggle').addEventListener('change', async function (ev) {
    const checked = !!ev.target.checked;
    try {
      const res = await chrome.runtime.sendMessage({
        type: BossMessageTypes.SET_CONFIG_SECTION,
        section: 'autoAction',
        patch: { enabledBatchEval: checked }
      });
      if (res && res.ok) {
        showToast(checked ? '✅ 已启用：评估「符合」自动话术 + 求简历' : '⏸ 已关闭自动话术 + 求简历');
      } else {
        showToast('保存配置失败：' + ((res && res.error) || '未知错误'), 'error');
        ev.target.checked = !checked;  // 回滚 UI
      }
    } catch (e) {
      showToast('保存配置失败：' + e.message, 'error');
      ev.target.checked = !checked;
    }
    refreshSayhiPane();
  });

  $('sayhi-auto-mark-unsuitable-toggle').addEventListener('change', async function (ev) {
    const checked = !!ev.target.checked;
    try {
      const res = await chrome.runtime.sendMessage({
        type: BossMessageTypes.SET_CONFIG_SECTION,
        section: 'autoAction',
        patch: { autoMarkUnsuitable: checked }
      });
      if (res && res.ok) {
        // Phase 2 阶段提示 HR 此设置暂不执行（Phase 3 才接入）
        showToast(checked
          ? '⚠ 已记录配置 — Phase 3 加 30s 撤销窗口后才实际执行（当前不会自动点不合适）'
          : '⏸ 已关闭自动标不合适');
      } else {
        showToast('保存配置失败：' + ((res && res.error) || '未知错误'), 'error');
        ev.target.checked = !checked;
      }
    } catch (e) {
      showToast('保存配置失败：' + e.message, 'error');
      ev.target.checked = !checked;
    }
    refreshSayhiPane();
  });

  // v0.22.3 · Phase 2·2d：K/N 阈值 input change handler
  //   空字符串 / NaN / ≤ 0 → 持久化为 null（spec §3.2.3 "留空 = 全部" 语义）
  //   正整数 → 持久化为该整数
  // 注：用 'change' 而非 'input'，避免 HR 边敲边写 chrome.storage.sync 触发频次限制
  function parseThresholdValue(rawStr) {
    const v = parseInt(String(rawStr || '').trim(), 10);
    return (Number.isFinite(v) && v > 0) ? v : null;
  }
  $('sayhi-loop-goal-k').addEventListener('change', async function (ev) {
    const v = parseThresholdValue(ev.target.value);
    try {
      const res = await chrome.runtime.sendMessage({
        type: BossMessageTypes.SET_CONFIG_SECTION,
        section: 'sayhiBatch',
        patch: { maxBrowseK: v }
      });
      if (res && res.ok) {
        showToast(v == null ? '✓ 浏览数：留空 = 全部未读' : ('✓ 本批浏览数 = ' + v));
        // 规范化显示（如 "5.0" → "5"）
        ev.target.value = v == null ? '' : String(v);
      } else {
        showToast('保存阈值失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('保存阈值失败：' + e.message, 'error');
    }
    refreshSayhiPane();
  });
  // v0.25.0：删 #sayhi-loop-goal-n change handler（maxGreetN 概念已废弃）

  // v0.25.0：候选人池卡片内嵌「清空列表」按钮 handler（复用现有 CLEAR_SAYHI_POOL message）
  // v1.0.1：文案从「清空池子」→「清空列表」（跟推荐页保持一致）
  const btnClearInline = $('btn-sayhi-clear-pool-inline');
  if (btnClearInline) {
    btnClearInline.addEventListener('click', async function () {
      if (!confirm('确定清空沟通页候选人列表吗？已有的评估结果不会被删。')) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.CLEAR_SAYHI_POOL });
        if (res && res.ok) {
          showToast('✅ 列表已清空（清掉 ' + (res.cleared || 0) + ' 人）');
        } else {
          showToast('清空失败：' + ((res && res.error) || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('清空失败：' + e.message, 'error');
      }
      refreshSayhiPane();
    });
  }

  // v0.22.1 · Phase 2·2b：新统一停止按钮（与 #btn-sayhi-stop 行为一致）
  $('btn-sayhi-stop-batch').addEventListener('click', async function () {
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.STOP_SAYHI_EVAL });
      if (res && res.ok) {
        showToast('已请求停止（未发起的 LLM 调用会跳过，已发起的让它完成）');
      } else {
        showToast('停止失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('停止失败：' + e.message, 'error');
    }
    refreshSayhiPane();
  });

  $('btn-sayhi-scan').addEventListener('click', async function () {
    const btn = $('btn-sayhi-scan');
    btn.disabled = true;
    // v0.13.1：滚动扫虚拟列表需要 3-10 秒，文案给 HR 明确预期
    btn.textContent = '🔍 滚动扫描中（约 5-10 秒）…';
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.SCAN_SAYHI_TAB });
      if (res && res.ok) {
        if (res.scanned > 0) {
          showToast('✅ 扫到 ' + res.scanned + ' 人，入池 ' + res.upserted + ' 人');
        } else {
          // v0.13.2：扫到 0 时把诊断信息带出来
          const hint = res.message || '未扫到候选人卡片';
          showToast(hint, 'error');
          console.warn('[BOSS-Sniffer sayhi] 扫到 0 人。stats=', res.stats, 'tabUrl=', res.tabUrl);
        }
      } else {
        showToast('扫描失败：' + ((res && res.error) || '未知错误'), 'error');
        console.warn('[BOSS-Sniffer sayhi] 扫描失败。res=', res);
      }
    } catch (e) {
      showToast('扫描失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 扫描本页候选人';
      refreshSayhiPane();
    }
  });

  $('btn-sayhi-eval').addEventListener('click', async function () {
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.EVAL_SAYHI_BATCH });
      if (res && res.ok) {
        if (res.total === 0) {
          showToast(res.message || '无需重评');
        } else {
          showToast('已启动评估 ' + res.total + ' 人');
        }
      } else {
        showToast('启动失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('启动失败：' + e.message, 'error');
    }
    refreshSayhiPane();
  });

  $('btn-sayhi-stop').addEventListener('click', async function () {
    try {
      const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.STOP_SAYHI_EVAL });
      if (res && res.ok) {
        showToast('已请求停止（未发起的 LLM 调用会跳过，已发起的让它完成）');
      } else {
        showToast('停止失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('停止失败：' + e.message, 'error');
    }
    refreshSayhiPane();
  });

  $('btn-sayhi-clear-pool').addEventListener('click', async function () {
    if (!confirm('确定清空沟通页候选人池吗？已有的评估结果不会被删。')) return;
    try {
      await chrome.runtime.sendMessage({ type: BossMessageTypes.CLEAR_SAYHI_POOL });
      showToast('池子已清空');
    } catch (e) {
      showToast('清空失败：' + e.message, 'error');
    }
    refreshSayhiPane();
  });

  // v0.14.0-pre：debug log 清空按钮
  const dbgClearBtn = $('btn-sayhi-debug-clear');
  if (dbgClearBtn) {
    dbgClearBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      debugLogs.length = 0;
      renderDebugLog();
    });
  }
  // 初始渲染（空态文案）
  renderDebugLog();
})();

