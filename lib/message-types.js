// BOSS Sniffer · lib/message-types.js (v1.1.22)
// 集中定义所有 chrome.runtime.sendMessage 的 type 常量
//
// 加载方式:
//   - service worker: importScripts('lib/message-types.js') 在 message-router 之前
//   - UI 页面: <script src="../lib/message-types.js"></script> 在主 JS 之前
//   - content.js: 通过 manifest content_scripts 声明顺序加载（在 content.js 之前)
//   - inject.js (MAIN world): 无法共享 self.BossMessageTypes,保留本地字面量(本仓库当前无)
//
// 公开 API (挂在 self.BossMessageTypes / window.BossMessageTypes):
//   每个 key 对应一个 type 字符串常量,值就是 key 本身。
//   消费方写 BossMessageTypes.START_LOOP 而非裸字符串 'START_LOOP',
//   避免拼写错误 编译不报但运行时静默失败 的 BUG 模式。
//
// 设计取舍:
//   - 历史 TOGGLE type 已废弃(v0.15.0 删 SET_SCREENING_ENABLED + TOGGLE),不放入常量
//   - message-router register 调用里的 string-keyed map(handlers 注册表)不强制替换,
//     map key 可读性优先(BossMessageRouter.register({ START_LOOP: handler, ... })
//     等价于 register({ [BossMessageTypes.START_LOOP]: handler })),保持兼容

(function (global) {
  'use strict';

  global.BossMessageTypes = Object.freeze({
    CAPTURE: 'CAPTURE',
    CHECK_RECENT_EVENTS: 'CHECK_RECENT_EVENTS',
    CLEAR: 'CLEAR',
    CLEAR_EVALUATIONS: 'CLEAR_EVALUATIONS',
    CLEAR_SAYHI_POOL: 'CLEAR_SAYHI_POOL',
    CLICK_AND_SCAN_DETAIL: 'CLICK_AND_SCAN_DETAIL',
    CLICK_LATEST_TAB: 'CLICK_LATEST_TAB',
    DETAIL_PANEL_SCAN: 'DETAIL_PANEL_SCAN',
    EVAL_SAYHI_BATCH: 'EVAL_SAYHI_BATCH',
    EVAL_SAYHI_SINGLE: 'EVAL_SAYHI_SINGLE',
    EXECUTE_GREET_THEN_RESUME: 'EXECUTE_GREET_THEN_RESUME',
    EXECUTE_SAYHI_ACTION: 'EXECUTE_SAYHI_ACTION',
    EXPORT_DIAG_BUNDLE: 'EXPORT_DIAG_BUNDLE',
    GET_CONFIG: 'GET_CONFIG',
    GET_EVALUATIONS: 'GET_EVALUATIONS',
    GET_LOOP_STATE: 'GET_LOOP_STATE',
    GET_SAYHI_POOL: 'GET_SAYHI_POOL',
    GET_SAYHI_STATUS: 'GET_SAYHI_STATUS',
    INJECT_READY: 'INJECT_READY',
    LOCATE_CANDIDATE: 'LOCATE_CANDIDATE',
    MARK_LLM_WRONG: 'MARK_LLM_WRONG',
    REAL_CLICK_AT_COORDS: 'REAL_CLICK_AT_COORDS',
    REFRESH_RECOMMEND_PAGE: 'REFRESH_RECOMMEND_PAGE',
    RESUME_LOOP: 'RESUME_LOOP',
    RETRY_EVALUATION: 'RETRY_EVALUATION',
    SCAN_SAYHI_TAB: 'SCAN_SAYHI_TAB',
    SCROLL_RECOMMEND_LIST: 'SCROLL_RECOMMEND_LIST',
    SCROLL_TO_CANDIDATE: 'SCROLL_TO_CANDIDATE',
    SET_CONFIG_SECTION: 'SET_CONFIG_SECTION',
    START_LOOP: 'START_LOOP',
    STOP_LOOP: 'STOP_LOOP',
    STOP_SAYHI_EVAL: 'STOP_SAYHI_EVAL',
    TEST_LLM_CONFIG: 'TEST_LLM_CONFIG',
    TRIGGER_FETCH_GEEK_INFO_BATCH: 'TRIGGER_FETCH_GEEK_INFO_BATCH',
    UNMARK_LLM_WRONG: 'UNMARK_LLM_WRONG'
  });
})(typeof window !== 'undefined' ? window : self);
