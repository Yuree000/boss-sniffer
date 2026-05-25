// BOSS Sniffer · lib/debugger-util.js (v1.0.4)
// chrome.debugger 接入 / 脱离工具,带"自愈 attach"。
//
// 背景:同一个调试器对同一 tab 不能 attach 两次。如果上次 detach 没干净
//      (chrome 内部状态残留),下次 attach 抛 "Another debugger is already attached"。
// 自愈策略:遇到此错误就先 detach 再重 attach 一次。
//
// 提取自:
//   - background.js realClickAtCoords (autoMark 真点击,v0.24.7 起)
//   - lib/sayHi.js attachDebugger        (推荐页自动招呼,v0.6.0 起)
// v0.24.7~v0.24.10 一系列调试器 bug 的根因之一是这两处实现漂移
//   (v0.24.9 commit 注释明明写"与 sayHi.js attachDebugger 对齐"但没真合并)。
// v1.0.4 Sprint B 把自愈逻辑统一到这里,两处共用。
//
// 公开 API(挂在 self.BossDebuggerUtil):
//   attachWithSelfHeal(tabId, version='1.3') → Promise<void>
//                              成功 resolve;失败抛 DebuggerAttachError
//                              (自愈失败时 message 含"请关闭 DevTools / 禁用其它扩展"提示)
//   detach(tabId) → Promise<void>  failsafe:错误不抛,直接 resolve
//                              (detach 失败通常说明已经 detach 过)

(function (global) {
  'use strict';

  function makeErr(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  /**
   * 单次 attach 到指定 tab(不带自愈),失败抛 DebuggerAttachError
   *
   * 参数:
   *   - tabId: chrome tab id
   *   - version: CDP 协议版本,默认 '1.3'
   *
   * 返回: Promise(无返回值)
   */
  function attachOnce(tabId, version) {
    return new Promise(function (resolve, reject) {
      chrome.debugger.attach({ tabId: tabId }, version || '1.3', function () {
        if (chrome.runtime.lastError) {
          reject(makeErr('DebuggerAttachError',
            chrome.runtime.lastError.message || 'attach failed'));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 单次 detach(failsafe,失败不抛 — 通常是已 detach 过)
   *
   * 参数:
   *   - tabId: chrome tab id
   *
   * 返回: Promise(无返回值,无论成功失败都 resolve)
   */
  function detach(tabId) {
    return new Promise(function (resolve) {
      chrome.debugger.detach({ tabId: tabId }, function () {
        // 即使 chrome.runtime.lastError 也 resolve(已 detach 过)
        resolve();
      });
    });
  }

  /**
   * 自愈 attach:遇到"already attached"→ 先 detach 再重 attach 一次
   * 主链路用这个,别直接用 attachOnce(同 tab 二次 attach 必失败)
   *
   * 参数:
   *   - tabId: chrome tab id
   *   - version: CDP 协议版本,默认 '1.3'
   *
   * 返回: Promise(无返回值);自愈仍失败抛 DebuggerAttachError(message 含用户介入提示)
   */
  async function attachWithSelfHeal(tabId, version) {
    try {
      await attachOnce(tabId, version);
    } catch (e) {
      const msg = (e && e.message) || '';
      // 自愈正则覆盖 "already attached" 和 "Another debugger" 两种错误措辞
      if (/already attached|Another debugger/i.test(msg)) {
        try { await detach(tabId); } catch (_e) {}
        try {
          await attachOnce(tabId, version);
          return;
        } catch (e2) {
          throw makeErr('DebuggerAttachError',
            (e2.message || 'attach failed') +
            '(自愈失败 — 请关闭 BOSS 页 DevTools / 禁用其它用 debugger 的扩展(如智聘 AI),或刷新 BOSS tab 后重试)');
        }
      }
      throw e;
    }
  }

  global.BossDebuggerUtil = {
    attachWithSelfHeal: attachWithSelfHeal,
    detach: detach
  };
})(self);
