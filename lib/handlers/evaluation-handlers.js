// BOSS Sniffer · lib/handlers/evaluation-handlers.js (v1.1.22)
// 评估查询 / 清理 / HR 反馈类 handler (10 个)

(function (global) {
  'use strict';

  function create(deps) {
    return {
      STATS: function (msg, sender, sendResponse) {
        sendResponse({
          enabled: deps.getScreeningEnabled(),
          screeningEnabled: deps.getScreeningEnabled(),
          stats: deps.getInMemoryStats()
        });
        return false;
      },

      GET_ENABLED: function (msg, sender, sendResponse) {
        const enabled = deps.getScreeningEnabled();
        sendResponse({ enabled: enabled, screeningEnabled: enabled });
        return false;
      },

      EXPORT: function (msg, sender, sendResponse) {
        deps.exportAll().then(function (records) {
          sendResponse({ records: records });
        });
        return true;
      },

      CLEAR: function (msg, sender, sendResponse) {
        deps.clearAll().then(function () { sendResponse({ ok: true }); });
        return true;
      },

      GET_EVALUATIONS: function (msg, sender, sendResponse) {
        (async function () {
          const records = await deps.getEvaluations();
          const jd = await deps.getCurrentJdTemplate().catch(function () { return null; });
          const loopState = (self.BossScheduler && typeof self.BossScheduler.getState === 'function')
            ? self.BossScheduler.getState()
            : null;
          const llm = deps.getCurrentLlmConfig();
          sendResponse({
            records: records,
            jdTitle: (jd && jd.name) || null,
            jdId: (jd && jd.jdId) || '',
            modelId: (llm && llm.model) || '',
            llmConfigured: deps.isCurrentLlmConfigured(),
            loopStartedAt: (loopState && loopState.loopStartedAt) || 0,
            loopStatus: (loopState && loopState.status) || 'IDLE'
          });
        })();
        return true;
      },

      CLEAR_EVALUATIONS: function (msg, sender, sendResponse) {
        deps.clearEvaluations().then(function () { sendResponse({ ok: true }); });
        return true;
      },

      RETRY_EVALUATION: function (msg, sender, sendResponse) {
        deps.retryEvaluation(msg.candidateId).then(function (r) { sendResponse(r); });
        return true;
      },

      // v1.1.7: HR 反馈通道 — 标 / 取消 LLM 判错
      MARK_LLM_WRONG: function (msg, sender, sendResponse) {
        deps.markLlmJudgmentWrong(msg.candidateId).then(function (r) { sendResponse(r); });
        return true;
      },

      UNMARK_LLM_WRONG: function (msg, sender, sendResponse) {
        deps.unmarkLlmJudgmentWrong(msg.candidateId).then(function (r) { sendResponse(r); });
        return true;
      },

      CHECK_RECENT_EVENTS: function (msg, sender, sendResponse) {
        // S6 fix: sidepanel 启动 reload 后 5 秒调用,判断是否抓到首批
        deps.checkRecentCandidatePoolEvents().then(function (count) {
          sendResponse({ recentCount: count });
        });
        return true;
      }
    };
  }

  global.BossEvaluationHandlers = { create: create };
})(self);
