// BOSS Sniffer · lib/handlers/diag-handlers.js (v1.1.22)
// 诊断包导出 handler (2 个)

(function (global) {
  'use strict';

  function create(deps) {
    return {
      EXPORT_DIAG_BUNDLE: function (msg, sender, sendResponse) {
        deps.buildDiagBundle()
          .then(function (bundle) { sendResponse({ ok: true, bundle: bundle }); })
          .catch(function (err) { sendResponse({ ok: false, error: err && err.message }); });
        return true;
      },

      // v0.22.5 · Phase 3·3c 前置:HR 在 IDB schema 升级前可选导出全库 JSON
      EXPORT_IDB_BUNDLE: function (msg, sender, sendResponse) {
        deps.buildIdbBackupBundle()
          .then(function (bundle) { sendResponse({ ok: true, bundle: bundle }); })
          .catch(function (err) { sendResponse({ ok: false, error: err && err.message }); });
        return true;
      }
    };
  }

  global.BossDiagHandlers = { create: create };
})(self);
