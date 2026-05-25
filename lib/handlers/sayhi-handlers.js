// BOSS Sniffer · lib/handlers/sayhi-handlers.js (v1.1.22)
// 沟通页扫描 / 评估 / 操作 / BOSS tab 定位 handler (16 个)

(function (global) {
  'use strict';

  function create(deps) {
    return {
      SCAN_SAYHI_TAB: function (msg, sender, sendResponse) {
        (async function () {
          const r = await deps.scanSayhiTabOnce();
          if (!r.ok) {
            sendResponse({ ok: false, error: r.error, scanned: 0, upserted: 0, stats: r.stats, tabUrl: r.tabUrl });
            return;
          }
          if (!r.candidates.length) {
            // v0.13.2:扫到 0 时附诊断信息
            const domTotal = (r.stats && r.stats.domTotal) || 0;
            let hint;
            if (domTotal === 0) {
              hint = '页面没有 .geek-item 卡片(请确认在沟通页 /web/chat/index 且列表已加载,URL=' + (r.tabUrl || '?') + ')';
            } else {
              hint = '页面有 ' + domTotal + ' 张 .geek-item 但 Vue 提取全部失败(可能 BOSS 前端结构变了,或同 BOSS tab 多扩展冲突)';
            }
            sendResponse({ ok: true, scanned: 0, upserted: 0, message: hint, stats: r.stats, tabUrl: r.tabUrl });
            return;
          }
          if (!self.BossExtractor || typeof self.BossExtractor.extractFromGeekItems !== 'function') {
            sendResponse({ ok: false, error: 'extractor 未加载', scanned: r.candidates.length, upserted: 0 });
            return;
          }
          const extracted = self.BossExtractor.extractFromGeekItems(r.candidates);
          const n = await deps.upsertSayhiCandidates(extracted);
          // v1.0.8:L1 漏斗埋点 — 沟通页 DOM 扫描入池补埋
          await deps.logCandidatePoolEvents(extracted, null, { scenario: 'sayhi-tab' });
          sendResponse({ ok: true, scanned: r.candidates.length, upserted: n, stats: r.stats });
        })();
        return true;
      },

      GET_SAYHI_POOL: function (msg, sender, sendResponse) {
        (async function () {
          const pool = await deps.getSayhiPool();
          const allEvals = await deps.getEvaluations();
          const evalMap = {};
          for (let i = 0; i < allEvals.length; i++) evalMap[allEvals[i].candidateId] = allEvals[i];
          const jd = await deps.getCurrentJdTemplate().catch(function () { return null; });
          const cfg = deps.getAppConfig();

          // v0.22.2 · Phase 2·2c:把 autoAction 配置带给 sidepanel,让两个 checkbox 显示真实状态
          // v0.25.1:删 jdBossJobNames 字段(沟通页路由改用 JD.name 严格相等)
          // v0.22.3 · Phase 2·2d:sayhiBatch 阈值(K/N)一起回带
          sendResponse({
            ok: true,
            pool: pool,
            evaluationsByCandidateId: evalMap,
            evalStatus: deps.getSayhiEvalStatus(),
            jdTitle: (jd && jd.name) || null,
            jdId: (jd && jd.jdId) || '',
            autoAction: {
              enabledBatchEval: !!(cfg.autoAction && cfg.autoAction.enabledBatchEval),
              autoMarkUnsuitable: !!(cfg.autoAction && cfg.autoAction.autoMarkUnsuitable),
              dryRun: !!(cfg.autoAction && cfg.autoAction.dryRun)
            },
            sayhiBatch: {
              maxBrowseK: (cfg.sayhiBatch && cfg.sayhiBatch.maxBrowseK) || null
            },
            llmConfigured: deps.isCurrentLlmConfigured()
          });
        })();
        return true;
      },

      // v0.24.7:chrome.debugger 真点击 — inject.js 找到按钮 + 取坐标 后调
      REAL_CLICK_AT_COORDS: function (msg, sender, sendResponse) {
        (async function () {
          const tabId = sender && sender.tab && sender.tab.id;
          if (!tabId) {
            sendResponse({ ok: false, error: 'no-tab-id(sender.tab 缺失,可能消息来源不是 content.js)' });
            return;
          }
          const x = parseInt(msg.x, 10);
          const y = parseInt(msg.y, 10);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
            sendResponse({ ok: false, error: 'invalid-coords: x=' + msg.x + ' y=' + msg.y });
            return;
          }
          // v1.0.14:把 admin 配置的 hover delay 透传给 realClickAtCoords
          const aa = deps.getAppConfig().autoAction || {};
          const hMinRaw = parseInt(aa.hoverDelayMinMs, 10);
          const hMaxRaw = parseInt(aa.hoverDelayMaxMs, 10);
          const r = await deps.realClickAtCoords(tabId, x, y, {
            hoverDelayMinMs: Number.isFinite(hMinRaw) && hMinRaw >= 0 ? hMinRaw : 30,
            hoverDelayMaxMs: Number.isFinite(hMaxRaw) && hMaxRaw >= 0 ? hMaxRaw : 110
          });
          if (self.BossDiag) {
            self.BossDiag.log(r.ok ? 'info' : 'warn', 'sayhi.real_click_' + (r.ok ? 'done' : 'fail'),
              'chrome.debugger 真点击 ' + (r.ok ? '成功' : '失败'),
              { x: x, y: y, error: r.error });
          }
          sendResponse(r);
        })();
        return true;
      },

      EVAL_SAYHI_BATCH: function (msg, sender, sendResponse) {
        deps.evalSayhiBatch().then(function (r) { sendResponse(r); });
        return true;
      },

      EVAL_SAYHI_SINGLE: function (msg, sender, sendResponse) {
        deps.evalSayhiSingle(msg.candidateId).then(function (r) { sendResponse(r); });
        return true;
      },

      STOP_SAYHI_EVAL: function (msg, sender, sendResponse) {
        sendResponse(deps.abortSayhiEval());
        return false;
      },

      CLEAR_SAYHI_POOL: function (msg, sender, sendResponse) {
        deps.clearSayhiPool().then(function () { sendResponse({ ok: true }); });
        return true;
      },

      EXECUTE_SAYHI_ACTION: function (msg, sender, sendResponse) {
        deps.executeSayhiActionForCandidate(msg.candidateId).then(function (r) { sendResponse(r); });
        return true;
      },

      // v0.17.1.0:评估「符合」→ 输入话术 + 求简历(直接驱动接口,让 sidepanel 测试入口能手动触发)
      // 真自动化路径走 evalSayhiCore 内部,这个 case 给 admin/sidepanel "试执行" 按钮用
      EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE: function (msg, sender, sendResponse) {
        (async function () {
          if (deps.getSayhiEvalRun() && deps.getSayhiEvalRun().running) {
            sendResponse({ ok: false, error: '评估循环进行中,请等完成再手动操作' });
            return;
          }
          const greet = await deps.getCurrentGreetTemplate();
          if (!greet || !greet.text) {
            sendResponse({ ok: false, error: '未选中话术模板' });
            return;
          }
          const r = await deps.triggerGreetThenResume(msg.candidateId, greet.text, !!msg.dryRun);
          await deps.recordSayhiActionResult(msg.candidateId, 'greet-then-resume', r.result);
          sendResponse(r);
        })();
        return true;
      },

      // v0.12.5:sidepanel 点候选人名字 → 让 BOSS 页面滚到对应卡片并高亮
      LOCATE_CANDIDATE: function (msg, sender, sendResponse) {
        let tabId = deps.getLastBossTabId();
        const fallback = function () {
          chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
            const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
            if (!active) { sendResponse({ ok: false, error: '没有打开的 zhipin.com 标签' }); return; }
            deps.setLastBossTabId(active.id);
            chrome.tabs.sendMessage(active.id, {
              type: self.BossMessageTypes.SCROLL_TO_CANDIDATE,
              candidateId: msg.candidateId,
              encryptUid: msg.encryptUid
            }, function (resp) {
              if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
              sendResponse(resp || { ok: false, error: '无响应' });
            });
          });
        };
        if (!tabId) { fallback(); return true; }
        chrome.tabs.sendMessage(tabId, {
          type: self.BossMessageTypes.SCROLL_TO_CANDIDATE,
          candidateId: msg.candidateId,
          encryptUid: msg.encryptUid
        }, function (resp) {
          // tab 没了 / content script 没注入 → fallback 再找一个
          if (chrome.runtime.lastError) { fallback(); return; }
          sendResponse(resp || { ok: false, error: '无响应' });
        });
        return true;
      },

      GET_SAYHI_STATUS: function (msg, sender, sendResponse) {
        sendResponse({
          status: self.BossSayHi.getStatus(),
          lastBossTabId: deps.getLastBossTabId(),
          sayHiConfig: deps.getAppConfig().sayHi
        });
        return false;
      },

      FIND_BOSS_TAB: function (msg, sender, sendResponse) {
        chrome.tabs.query({ url: '*://*.zhipin.com/*' }, function (tabs) {
          if (!tabs || tabs.length === 0) {
            sendResponse({ ok: false, error: '没有打开的 zhipin.com 标签' });
            return;
          }
          // 优先 active tab
          const active = tabs.find(function (t) { return t.active; }) || tabs[0];
          deps.setLastBossTabId(active.id);
          sendResponse({ ok: true, tabId: active.id, url: active.url });
        });
        return true;
      },

      TEST_DEBUGGER_ATTACH: function (msg, sender, sendResponse) {
        (async function () {
          try {
            let tabId = msg.tabId || deps.getLastBossTabId();
            if (!tabId) {
              // 兜底:自动找一个
              const tabs = await new Promise(function (r) {
                chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
              });
              const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
              if (active) { tabId = active.id; deps.setLastBossTabId(active.id); }
            }
            if (!tabId) {
              sendResponse({ ok: false, error: '没有可用的 BOSS tab — 请先打开 zhipin.com' });
              return;
            }
            const r = await self.BossSayHi.testDebuggerAttach(tabId);
            sendResponse(r);
          } catch (e) {
            sendResponse({ ok: false, error: e.name + ': ' + e.message });
          }
        })();
        return true;
      },

      TEST_SAYHI: function (msg, sender, sendResponse) {
        (async function () {
          try {
            let tabId = msg.tabId || deps.getLastBossTabId();
            if (!tabId) {
              sendResponse({ ok: false, error: '没有 BOSS tab — 请先在 zhipin.com 推荐页停留' });
              return;
            }
            if (!msg.candidateId) {
              sendResponse({ ok: false, error: '缺 candidateId' });
              return;
            }
            // 从 IndexedDB 评估记录拿 encryptUid(BOSS DOM 里更可能存的是加密版)
            const encryptUid = await deps.getEncryptUid(msg.candidateId);
            const r = await self.BossSayHi.testSayHi(tabId, msg.candidateId, encryptUid);
            sendResponse(r);
          } catch (e) {
            sendResponse({ ok: false, error: e.name + ': ' + e.message, hint: e.hint });
          }
        })();
        return true;
      },

      TEST_DIAGNOSE_DOM: function (msg, sender, sendResponse) {
        (async function () {
          try {
            let tabId = msg.tabId || deps.getLastBossTabId();
            if (!tabId) {
              const tabs = await new Promise(function (r) {
                chrome.tabs.query({ url: '*://*.zhipin.com/*' }, r);
              });
              const active = tabs && (tabs.find(function (t) { return t.active; }) || tabs[0]);
              if (active) { tabId = active.id; deps.setLastBossTabId(active.id); }
            }
            if (!tabId) {
              sendResponse({ ok: false, error: '没有 BOSS tab' });
              return;
            }
            const encryptUid = msg.candidateId ? await deps.getEncryptUid(msg.candidateId) : '';
            const r = await self.BossSayHi.testDiagnose(tabId, msg.candidateId, encryptUid);
            sendResponse({ ok: true, diagnosis: r, encryptUid: encryptUid });
          } catch (e) {
            sendResponse({ ok: false, error: e.name + ': ' + e.message });
          }
        })();
        return true;
      },

      DEQUEUE_SAYHI: function (msg, sender, sendResponse) {
        self.BossSayHi.dequeue(msg.candidateId).then(function () {
          sendResponse({ ok: true });
        });
        return true;
      }
    };
  }

  global.BossSayHiHandlers = { create: create };
})(self);
