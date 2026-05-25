// BOSS Sniffer · lib/message-router.js (v1.0.7)
// chrome.runtime.onMessage 分发器 · 注册表模式
//
// 提取自 background.js Sprint C 阶段 3(v1.0.6 → v1.0.7)。
// 见 相关文档/specs/2026-05-21-background拆分-design.md §3
//
// 背景:
//   v1.0.6 之前 background.js 单一 chrome.runtime.onMessage.addListener 内嵌 36 个 case,
//   总行数 ~500。加新 handler 必须动主路由 switch,出错难隔离测试。
//
// 模式:
//   background.js 在加载完毕后调 BossMessageRouter.register({ 'TYPE': handlerFn, ... }),
//   本 lib 内部维护单一 onMessage listener 做分发。每个 handler 是
//   `function (msg, sender, sendResponse) { ...; return true|false; }`,
//   返回值即 onMessage 的 return(true = 异步,会保持 sendResponse 通道开)。
//
// 公开 API(挂在 self.BossMessageRouter):
//   register(typeMap)  注册 handler。同 type 重复注册会覆盖(后注册的胜)
//   getHandlers()       仅供测试 / 调试:返回当前注册表副本

(function (global) {
  'use strict';

  const handlers = Object.create(null);

  function register(typeMap) {
    if (!typeMap || typeof typeMap !== 'object') return;
    Object.keys(typeMap).forEach(function (type) {
      const fn = typeMap[type];
      if (typeof fn === 'function') handlers[type] = fn;
    });
  }

  function getHandlers() {
    return Object.assign({}, handlers);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    const h = handlers[msg.type];
    if (!h) return false;
    try {
      return h(msg, sender, sendResponse);
    } catch (e) {
      // handler 同步抛错 → 写诊断日志(若 BossDiag 已加载)+ 返回 false 让 sender 拿不到响应
      // 业务 handler 应自己 try/catch,这里只兜底
      if (self.BossDiag) {
        self.BossDiag.log('error', 'message-router.handler_error',
          'handler 同步抛错: ' + msg.type, { error: (e && e.message) || String(e) });
      } else {
        console.error('[BossMessageRouter] handler error for type=' + msg.type, e);
      }
      return false;
    }
  });

  global.BossMessageRouter = {
    register: register,
    getHandlers: getHandlers
  };
})(self);
