// BOSS Sniffer - lib/jd-router.js
//
// 沟通页多岗位 JD 路由器：
//   根据候选人的"沟通职位"（candidate.expectation.jobAligned，来自 BOSS Vue jobName / toPosition）
//   在所有 JD 模板里找出 name 与该名称严格相等的 JD。
//
// v0.21.0 · Phase 1·1c 引入此模块，原用 bossJobNames 别名数组路由。
// v0.25.1 重构：HR 反馈别名机制冗余，改为直接用 JD.name 严格相等匹配。
//   HR 约定 JD.name 与 BOSS 端「沟通职位」名称完全一致（admin 表单加 hint 提醒）。
//
// 匹配策略：严格相等（trim 后），HR 自己维护变体。
//   命中多个 JD（同名同时存在 2 个 JD）→ 取列表首个 + diagnosis.conflicts 列出其他匹配项
//   候选人 jobAligned 为空 → reason='no_jobAligned'，不算 unrouted bug，只是数据不全
//   候选人 jobAligned 在所有 JD 名称里都没匹配 → reason='no_match'
//   完全没有 JD 模板 → reason='no_templates'
//
// 公开 API：self.BossJDRouter
//   - route(jobAligned, jdTemplates) → { jd, byJobName } | null
//   - routeWithDiagnosis(jobAligned, jdTemplates) → { jd, byJobName, conflicts, reason }

(function (global) {
  'use strict';

  function _normalize(s) {
    if (typeof s !== 'string') return '';
    return s.trim();
  }

  // 返回带诊断的完整路由结果，便于 sidepanel 显示 unrouted reason、background 写埋点
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
      // v0.25.1：用 JD.name 严格相等代替 bossJobNames 别名数组
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

  // 简化形式：命中返回 {jd, byJobName}，未命中 → null
  function route(jobAligned, jdTemplates) {
    const r = routeWithDiagnosis(jobAligned, jdTemplates);
    if (r.reason !== 'matched') return null;
    return { jd: r.jd, byJobName: r.byJobName };
  }

  global.BossJDRouter = {
    route: route,
    routeWithDiagnosis: routeWithDiagnosis
  };
})(typeof self !== 'undefined' ? self : window);
