// BOSS Sniffer · lib/runtime-utils.js (v1.1.22)
// 共享运行时工具:sleep / err 构造
//
// 提取自 v1.1.22 P1-1 重构。之前 sleep × 4 (inject.js / judge.js / scheduler.js / sayHi.js)
// + err × 3 (llm-client.js / sayHi.js / scheduler.js as makeErr)。
//
// 加载方式:
//   - service worker: importScripts('lib/runtime-utils.js') 必须放在使用它的 lib 之前
//   - inject.js (MAIN world): 无法共享,保留本地 sleep
//   - UI 页面: 暂无 sleep 用途,不加载
//
// 公开 API (挂在 self.BossRuntimeUtils):
//   sleep(ms)            返回延时 ms 毫秒的 Promise
//   err(name, msg, ext?) 构造命名错误对象 (ext 字段 merge 到 err 实例)

(function (global) {
  'use strict';

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function err(name, message, extras) {
    const e = new Error(message);
    e.name = name;
    if (extras) Object.assign(e, extras);
    return e;
  }

  global.BossRuntimeUtils = {
    sleep: sleep,
    err: err
  };
})(self);
