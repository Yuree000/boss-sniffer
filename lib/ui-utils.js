// BOSS Sniffer · lib/ui-utils.js (v1.1.22)
// 共享 UI 工具函数 - 由 dashboard / sidepanel / admin 三个页面引用
//
// 提取自 v1.1.22 P1-1 重构。之前 escapeHtml × 4 重复定义
// (dashboard.js:140 / sidepanel.js:210 / sidepanel.js:1208 嵌套 / admin.js:704)。
//
// 加载方式: <script src="../lib/ui-utils.js"></script> 必须放在主 JS 之前
//
// 公开 API (挂在 window.BossUiUtils):
//   escapeHtml(s)   把 & < > " ' 转 HTML 实体; null/undefined 返回 ''

(function (global) {
  'use strict';

  const HTML_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ENTITY[c]; });
  }

  global.BossUiUtils = {
    escapeHtml: escapeHtml
  };
})(typeof window !== 'undefined' ? window : self);
