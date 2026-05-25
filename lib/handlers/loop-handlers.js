// BOSS Sniffer · lib/handlers/loop-handlers.js (v1.1.22)
// LOOP 5 态机控制 handler (4 个)

(function (global) {
  'use strict';

  function create(deps) {
    return {
      START_LOOP: function (msg, sender, sendResponse) {
        (async function () {
          try {
            // v0.15.0:招呼数 / 浏览数 至少一个必填(否则 LOOP 无终止条件)
            const hasN = typeof msg.goalN === 'number' && msg.goalN >= 1;
            const hasK = typeof msg.goalK === 'number' && msg.goalK >= 1;
            if (!hasN && !hasK) {
              sendResponse({ ok: false, error: '招呼数或浏览数至少填写一个' });
              return;
            }
            const tab = msg.tab === 'latest' ? 'latest' : 'recommend';
            const jd = await deps.getCurrentJdTemplate().catch(function () { return null; });
            if (!jd || !jd.jdId) {
              sendResponse({ ok: false, error: '请先在侧边栏选择当前 JD' });
              return;
            }
            if (!deps.isCurrentLlmConfigured()) {
              sendResponse({ ok: false, error: '请先在 admin 配置 LLM API Key' });
              return;
            }
            // v1.1.23 P3-3:推荐页多模板支持 — 透传 templateIds
            //   - 空数组 / undefined → null,evaluateIfCandidate 内部落回"当前 position 下全选"
            //   - 1 个 → 单模板模式(向后兼容)
            //   - N 个 → 多模板模式
            //   存进 recommendLoopRun.templateIds,saveCapture 时取出传给 evaluateIfCandidate
            const templateIds = Array.isArray(msg.templateIds) && msg.templateIds.length > 0
              ? msg.templateIds.slice()
              : null;
            // v0.15.0:screeningEnabled 跟 LOOP 生命周期绑死,无条件开
            deps.setScreeningEnabled(true);
            deps.setCurrentTab(tab);
            // v1.1.17:推荐页批次启动 — 设 batchId/startedAt + emit loop_start
            // v1.1.18:jobId 存进 recommendLoopRun,让 setOnStopped 时 emit loop_end 用同一值
            // v1.1.23 P3-3:加 templateIds 字段 — 推荐页评估按 HR 选定的模板集合(N>=1)跑
            deps.setRecommendLoopRun({
              batchId: 'batch_' + Date.now(),
              startedAt: Date.now(),
              jobId: (jd && jd.jdId) || '',
              templateIds: templateIds
            });
            const _run = deps.getRecommendLoopRun();
            await deps.emitLoopStartEvent({
              batchId: _run.batchId,
              scenario: tab,
              jobId: _run.jobId,
              totalTarget: msg.goalK || msg.goalN || 0
            });
            self.BossScheduler.start({ goalN: msg.goalN, goalK: msg.goalK });
            deps.reconcileSayHiConsumer();
            sendResponse({ ok: true });

            // v0.12.4: 新一轮开始前清空 evaluations
            await deps.clearEvaluations();

            // 异步:触发 BOSS 页 reload + 等 ~2.5s 让 inject/content 重注入、首批 fetch 抓到
            await deps.refreshBossPage();
            await new Promise(function (r) { setTimeout(r, 2500); });
            // v0.16.0:跑最新 tab 时,reload 后 BOSS 默认落推荐,需要主动 click 切到最新
            if (deps.getCurrentTab() === 'latest') {
              try {
                await deps.clickLatestTab(deps.getLastBossTabId());
                console.info('[BOSS-Sniffer START_LOOP] 已切到最新 tab,等 BOSS fire /bossGetGeek');
                await new Promise(function (r) { setTimeout(r, 1500); });
              } catch (e) {
                console.warn('[BOSS-Sniffer START_LOOP] 切换最新 tab 失败:', e && e.message);
              }
            }
            if (typeof self.BossScheduler.runTick === 'function') {
              self.BossScheduler.runTick();
            }
          } catch (e) {
            console.error('[BOSS-Sniffer START_LOOP] 异步段失败:', e);
          }
        })();
        return true;
      },

      STOP_LOOP: function (msg, sender, sendResponse) {
        try {
          // v1.1.17:HR 主动停止 → emit loop_end(endReason=aborted)
          // 注意先取 snapshot 再 reset,否则 currentTab 会被设 null
          const _tab = deps.getCurrentTab();
          const _batchSnap = deps.getRecommendLoopRun();
          self.BossScheduler.stop();
          deps.setScreeningEnabled(false);
          deps.setCurrentTab(null);
          // v0.15.0:清掉"评估中"卡片让侧栏立即干净
          deps.clearPendingEvaluations().catch(function (e) {
            console.warn('[BOSS-Sniffer STOP_LOOP] clearPendingEvaluations 失败:', e);
          });
          deps.reconcileSayHiConsumer();
          sendResponse({ ok: true });
          // v1.1.17:批次结束事件 — 异步 emit
          if (_batchSnap && _batchSnap.batchId && _batchSnap.startedAt) {
            // v1.1.23 P3-3:reset 时也清 templateIds(下次 START_LOOP 重新设置);templateIds 放前面让 jobId 仍在末尾,
            //   保持 v1.1.18-B2 测试反向断言 /jobId:\s*['"]['"],/ 仍通过
            deps.setRecommendLoopRun({ batchId: '', startedAt: 0, templateIds: null, jobId: '' });
            (async function () {
              const tally = await deps.tallyLoopOutcomeFromEvents(_tab, _batchSnap.startedAt);
              await deps.emitLoopEndEvent({
                batchId: _batchSnap.batchId,
                startedAt: _batchSnap.startedAt,
                scenario: _tab,
                jobId: _batchSnap.jobId || '',
                processed: tally.processed,
                matched: tally.matched,
                passed: tally.passed,
                endReason: 'aborted'
              });
            })();
          }
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message });
        }
        return false;
      },

      RESUME_LOOP: function (msg, sender, sendResponse) {
        try {
          self.BossScheduler.resume();
          deps.reconcileSayHiConsumer();
          if (typeof self.BossScheduler.runTick === 'function') {
            self.BossScheduler.runTick();
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.name + ': ' + e.message });
        }
        return false;
      },

      GET_LOOP_STATE: function (msg, sender, sendResponse) {
        sendResponse({ state: self.BossScheduler.getState() });
        return false;
      }
    };
  }

  global.BossLoopHandlers = { create: create };
})(self);
