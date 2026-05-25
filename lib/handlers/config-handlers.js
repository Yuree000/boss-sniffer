// BOSS Sniffer · lib/handlers/config-handlers.js (v1.1.22)
// 配置 CRUD 类 handler (3 个)

(function (global) {
  'use strict';

  function create(deps) {
    return {
      GET_CONFIG: function (msg, sender, sendResponse) {
        sendResponse({
          config: deps.getAppConfig(),
          enabled: deps.getScreeningEnabled(),
          screeningEnabled: deps.getScreeningEnabled()
        });
        return false;
      },

      SET_CONFIG_SECTION: function (msg, sender, sendResponse) {
        deps.saveConfigSection(msg.section, msg.patch).then(function () {
          if (msg.section === 'sayHi') deps.reconcileSayHiConsumer();
          sendResponse({ ok: true, config: deps.getAppConfig() });
        });
        return true;
      },

      TEST_LLM_CONFIG: function (msg, sender, sendResponse) {
        (async function () {
          try {
            const r = await self.BossLLM.testLlmConnection(msg.llm || {});
            sendResponse({ ok: true, text: r.text, usage: r.usage });
          } catch (e) {
            sendResponse({ ok: false, error: e.name + ': ' + e.message });
          }
        })();
        return true;
      }
    };
  }

  global.BossConfigHandlers = { create: create };
})(self);
