// BOSS Sniffer - lib/jd-router.js (v1.1.23)
//
// 沟通页多岗位路由器 — 支持两种路由模式:
//
// === 模式 1 (v0.25.1 ~ v1.1.22):单 JD 模板匹配 ===
//   按 JD.name 严格相等匹配单个模板。HR 复制出多个同名 JD 时只取第一个,conflicts 列出其他。
//   API: route(jobAligned, jdTemplates) / routeWithDiagnosis(jobAligned, jdTemplates)
//   保留:v1.1.22 已有调用方 + 现存测试断言
//
// === 模式 2 (v1.1.23 P3-2):按 BOSS 岗位路由 + 该岗位下所有模板 ===
//   候选人 jobAligned 匹配 BossPosition.name,命中后返回 position + 该 position 下所有 templates。
//   上层(evalSayhiCore)拿到 templates 数组后对每个 candidate × 每个 template 跑 LLM。
//   API: routeByPosition(jobAligned, positions, allTemplates)
//        routeByPositionWithDiagnosis(jobAligned, positions, allTemplates)
//   适用:v1.1.23 起的新评估链路
//
// === v1.1.23 P3-2 改造背景 ===
// v0.25.1~v1.1.22:HR 复制出多个同名 JD 时只取第一个,第二第三个形同虚设。
// v1.1.23:引入 BOSS 岗位层。一个 BOSS 岗位下挂 N 个筛选模板,沟通页路由命中 position 后,
//         上层(evalSayhiCore)对该 position 下**所有** templates 逐个评估,候选人不漏。

(function (global) {
  'use strict';

  function _normalize(s) {
    if (typeof s !== 'string') return '';
    return s.trim();
  }

  // ============================================================
  // 模式 1:旧单 JD 模板路由(v0.25.1 引入,保留供 v1.1.22 现存调用方)
  // ============================================================

  /**
   * 返回带诊断信息的完整路由结果(便于 sidepanel 显示 unrouted reason、background 写埋点)
   * 匹配策略:候选人 jobAligned 与 JD.name 严格相等(trim 后)
   *
   * 参数:
   *   - jobAligned: 候选人在 BOSS 端的"沟通职位"名称
   *   - jdTemplates: 所有 JD 模板数组
   *
   * 返回: { jd, byJobName, conflicts, reason } — reason 为 matched/no_jobAligned/no_templates/no_match
   */
  function routeWithDiagnosis(jobAligned, jdTemplates) {
    const ja = _normalize(jobAligned);
    if (!ja) {
      return { jd: null, byJobName: null, conflicts: [], reason: 'no_jobAligned' };
    }
    if (!Array.isArray(jdTemplates) || !jdTemplates.length) {
      return { jd: null, byJobName: null, conflicts: [], reason: 'no_templates' };
    }
    const matches = [];
    for (let i = 0; i < jdTemplates.length; i++) {
      const tpl = jdTemplates[i];
      if (!tpl || !tpl.name) continue;
      const jdName = _normalize(tpl.name);
      if (jdName && jdName === ja) {
        matches.push({ jd: tpl, byJobName: jdName });
      }
    }
    if (!matches.length) {
      return { jd: null, byJobName: null, conflicts: [], reason: 'no_match' };
    }
    return {
      jd: matches[0].jd,
      byJobName: matches[0].byJobName,
      conflicts: matches.slice(1).map(function (m) { return m.jd; }),
      reason: 'matched'
    };
  }

  /**
   * 简化路由:命中返回 {jd, byJobName},未命中返回 null
   */
  function route(jobAligned, jdTemplates) {
    const r = routeWithDiagnosis(jobAligned, jdTemplates);
    if (r.reason !== 'matched') return null;
    return { jd: r.jd, byJobName: r.byJobName };
  }

  // ============================================================
  // 模式 2:v1.1.23 P3-2 — 按 BOSS 岗位路由 + 返回该岗位下所有模板
  // ============================================================

  /**
   * v1.1.23 新签名:按 BOSS 岗位路由,返回该岗位下所有筛选模板
   *
   * 参数:
   *   - jobAligned: 候选人沟通职位名(BOSS 端返回)
   *   - positions: BossPosition[](BossPositions.listPositions())
   *   - allTemplates: Template[](BossJD.listTemplates(),内部按 positionId 过滤)
   *
   * 返回:
   *   {
   *     position: BossPosition | null,
   *     templates: Template[],   // 该 position 下所有模板,按 sortOrder
   *     byJobName: string | null,
   *     reason: 'matched' | 'no_jobAligned' | 'no_positions' | 'no_match' | 'no_templates_in_position'
   *   }
   */
  function routeByPositionWithDiagnosis(jobAligned, positions, allTemplates) {
    const ja = _normalize(jobAligned);
    if (!ja) {
      return { position: null, templates: [], byJobName: null, reason: 'no_jobAligned' };
    }
    if (!Array.isArray(positions) || !positions.length) {
      return { position: null, templates: [], byJobName: null, reason: 'no_positions' };
    }
    let matchedPos = null;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (!p || !p.name) continue;
      if (_normalize(p.name) === ja) {
        matchedPos = p;
        break;
      }
    }
    if (!matchedPos) {
      return { position: null, templates: [], byJobName: null, reason: 'no_match' };
    }
    const templatesAll = Array.isArray(allTemplates) ? allTemplates : [];
    const positionTemplates = templatesAll
      .filter(function (t) { return t && t.positionId === matchedPos.positionId; })
      .sort(function (a, b) {
        const sa = (a && typeof a.sortOrder === 'number') ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const sb = (b && typeof b.sortOrder === 'number') ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
    if (!positionTemplates.length) {
      return {
        position: matchedPos,
        templates: [],
        byJobName: _normalize(matchedPos.name),
        reason: 'no_templates_in_position'
      };
    }
    return {
      position: matchedPos,
      templates: positionTemplates,
      byJobName: _normalize(matchedPos.name),
      reason: 'matched'
    };
  }

  /**
   * v1.1.23 简化版:命中返回 { position, templates },未命中返回 null
   */
  function routeByPosition(jobAligned, positions, allTemplates) {
    const r = routeByPositionWithDiagnosis(jobAligned, positions, allTemplates);
    if (r.reason !== 'matched') return null;
    return { position: r.position, templates: r.templates };
  }

  global.BossJDRouter = {
    // 旧 API (v0.25.1 ~ v1.1.22,保留)
    route: route,
    routeWithDiagnosis: routeWithDiagnosis,
    routeWithDiagnosisLegacy: routeWithDiagnosis,  // alias,过渡期标识用
    // 新 API (v1.1.23 P3-2 起,推荐使用)
    routeByPosition: routeByPosition,
    routeByPositionWithDiagnosis: routeByPositionWithDiagnosis
  };
})(typeof self !== 'undefined' ? self : window);
