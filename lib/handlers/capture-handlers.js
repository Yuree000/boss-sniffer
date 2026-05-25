// BOSS Sniffer · lib/handlers/capture-handlers.js (v1.1.22)
// 数据采集类 message handler:CAPTURE / INJECT_READY / DETAIL_PANEL_SCAN
//
// 加载顺序: importScripts 在 message-router.js 之前
// 工厂模式: create(deps) 返回 handler map,deps 包含 background.js 内的闭包变量/函数

(function (global) {
  'use strict';

  function create(deps) {
    return {
      // 推荐页 / 沟通页 fetch/XHR/WS capture 入口
      CAPTURE: function (msg, sender, sendResponse) {
        // v0.12.10:WS 业务消息(沟通页新招呼)绕开 screeningEnabled,HR 一进沟通页就抓
        // v0.15.0:HTTP 类(fetch/xhr)只在 LOOP 跑中入库(screeningEnabled 跟 LOOP 生命周期绑死)
        if (msg.payload && (msg.payload.via === 'ws' || deps.getScreeningEnabled())) {
          // v0.16.0:当 currentTab 已定(LOOP 跑中),只接当前 tab 对应的 list 接口;
          // 防推荐 tab 残余 fetch 污染最新 tab 评估,反之亦然。其他路径不过滤。
          const currentTab = deps.getCurrentTab();
          if (msg.payload.via !== 'ws' && currentTab) {
            const _path = String(msg.payload.url || '').split('?')[0];
            if (_path.indexOf('/rec/geek/list') !== -1 && currentTab !== 'recommend') {
              console.debug('[BOSS-Sniffer CAPTURE] 丢弃非当前 tab 接口', _path, 'currentTab=', currentTab);
              return false;
            }
            if (_path.indexOf('/zprelation/interaction/bossGetGeek') !== -1 && currentTab !== 'latest') {
              console.debug('[BOSS-Sniffer CAPTURE] 丢弃非当前 tab 接口', _path, 'currentTab=', currentTab);
              return false;
            }
          }
          const tabId = sender && sender.tab && sender.tab.id;
          deps.saveCapture(msg.payload, tabId).catch(function (err) {
            console.error('[BOSS-Sniffer] save failed:', err);
          });
        }
        return false;
      },

      INJECT_READY: function (msg, sender, sendResponse) {
        console.debug('[BOSS-Sniffer] inject ready @', msg.url);
        return false;
      },

      // v0.17.0.10 POC A7 回灌:沟通页详情面板 DOM 扫描结果
      DETAIL_PANEL_SCAN: function (msg, sender, sendResponse) {
        try {
          if (msg.candidateId && msg.payload &&
              self.BossExtractor &&
              typeof self.BossExtractor.extractFromDetailPanel === 'function') {
            const domDetail = self.BossExtractor.extractFromDetailPanel(msg.payload);
            if (domDetail) {
              deps.mergeDomDetailIntoSayhiPool(msg.candidateId, domDetail)
                .then(function (merged) {
                  if (self.BossDiag) {
                    self.BossDiag.log(merged ? 'info' : 'warn', 'sayhi.detail_panel_scan',
                      merged ? 'DOM 详情面板扫描已 merge 到 sayhi_pool' : 'DOM 扫描成功但 sayhi_pool 没这人(可能不在当前 LOOP)',
                      {
                        candidateId: msg.candidateId,
                        merged: merged,
                        fields: {
                          hasExpect: !!(domDetail.expect && domDetail.expect.cityRaw),
                          cityRaw: domDetail.expect && domDetail.expect.cityRaw || null,
                          hasDesc: !!domDetail.desc,
                          hasWorkEdu: !!domDetail.workEduText,
                          skillTagsCount: (domDetail.skillTags || []).length
                        }
                      });
                  }
                })
                .catch(function (e) {
                  console.warn('[BOSS-Sniffer DETAIL_PANEL_SCAN] merge failed:', e);
                });
            }
          }
        } catch (e) {
          console.warn('[BOSS-Sniffer DETAIL_PANEL_SCAN] handler error:', e);
        }
        return false;
      }
    };
  }

  global.BossCaptureHandlers = { create: create };
})(self);
