// 测试 v0.22.0 · Phase 2·2a：sidepanel 沟通页 pane HTML 重构（control-bar 骨架）
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.2 子步骤 2a
//
// 范围：HTML 结构 + 占位元素 + 现有元素未破坏。事件接入是 2b/2c/2d 的事，2a 不接入。
// 跑：node --test tests/sayhi-control-bar-skeleton.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');

// 提取沟通页 pane 完整结构（hidden 标记 → /沟通页 pane 结尾）
function getSayhiPane() {
  const m = sidepanelHtml.match(/<div class="page-pane" data-page-pane="sayhi"[\s\S]*?<!-- ===== \/沟通页 pane ===== -->/);
  if (!m) throw new Error('未找到沟通页 pane');
  return m[0];
}

// ========== A: 新 control-bar 结构 ==========

test('A1: 沟通页 pane 含新 control-bar 容器', () => {
  const pane = getSayhiPane();
  assert.match(pane, /<div class="control-bar"/);
});

test('A2: control-bar 在 sayhi-pool-bar 之前（top of pane）', () => {
  const pane = getSayhiPane();
  const cbIdx = pane.indexOf('class="control-bar"');
  const poolIdx = pane.indexOf('class="sayhi-pool-bar"');
  assert.ok(cbIdx > 0 && poolIdx > 0);
  assert.ok(cbIdx < poolIdx, 'control-bar 必须在 sayhi-pool-bar 之前');
});

// ========== B: 当前话术下拉 — v0.25.0 已删（话术 v0.25.2 集成 JD 后由 JD 默认话术决定） ==========

test('v0.25.0 B1: #greet-current 已删除（话术下拉沟通页不再展示）', () => {
  const pane = getSayhiPane();
  assert.doesNotMatch(pane, /<select id="greet-current"/);
});

test('v0.25.0 B2: control-bar 内不含 #greet-current（已彻底移除）', () => {
  const pane = getSayhiPane();
  assert.doesNotMatch(pane, /id="greet-current"/);
});

test('B3: #auto-action-badge 仍存在（功能不变）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="auto-action-badge"/);
});

// ========== C: 新增占位元素（2b/2c/2d 已全部接入） ==========
// v0.22.3 · 2d 起：K/N 阈值 input 不再 hardcode disabled，由 renderPool 按 evalStatus.running 动态控制
// disabled 状态详细断言见 tests/sayhi-threshold-kn.test.js E1/E2/G1

test('C1: 新增 #sayhi-loop-goal-k 浏览数 input 存在（2d 已接入 wire）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-loop-goal-k"/);
});

test('v0.25.0 C2: #sayhi-loop-goal-n 招呼数 input 已删除（maxGreetN 概念彻底废弃）', () => {
  const pane = getSayhiPane();
  assert.doesNotMatch(pane, /id="sayhi-loop-goal-n"/);
});

test('C3: 新增 #btn-sayhi-start 开始处理本批按钮存在（2b 接入 click handler）', () => {
  // 注：2a 阶段此按钮 disabled，2b 接入 click handler 后去掉 disabled。
  // 是否 disabled 由 2b 的 sayhi-start-button-wire.test.js 断言；这里只确认按钮 DOM 仍在。
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-start"[\s\S]*?开始处理本批/);
});

test('C4: 新增 #btn-sayhi-stop-batch 停止按钮存在（2b 接入 click handler）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-stop-batch"/);
});

test('C5: 新增 #sayhi-auto-greet-toggle 自动话术 checkbox 存在（2c 接入 change handler + 联动）', () => {
  // 注：2a 阶段此 checkbox disabled，2c 接入后 disabled 由 renderPool 动态控制
  // disabled 状态断言由 2c 的 sayhi-auto-action-toggles.test.js 管
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-auto-greet-toggle"/);
});

test('C6: 新增 #sayhi-auto-mark-unsuitable-toggle 自动标不合适 checkbox 存在（2c 接入）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-auto-mark-unsuitable-toggle"/);
});

test('v0.25.0 C7: 所有新增元素都有 title 提示（功能说明）', () => {
  const pane = getSayhiPane();
  // v0.25.0：删 #sayhi-loop-goal-n（招呼数 input 已废弃）
  const newIds = ['sayhi-loop-goal-k', 'btn-sayhi-start',
                  'btn-sayhi-stop-batch', 'sayhi-auto-greet-toggle', 'sayhi-auto-mark-unsuitable-toggle'];
  newIds.forEach(function (id) {
    const re = new RegExp('id="' + id + '"[^>]*title="[^"]+"', 'i');
    assert.match(pane, re, '元素 #' + id + ' 缺 title 提示');
  });
});

// ========== D: 不破坏 Phase 1 + 现有功能 ==========

test('D1: 现有 #btn-sayhi-scan 保留（2d 才迁移到测试模式折叠区）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-scan"/);
});

test('D2: 现有 #btn-sayhi-eval 保留', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-eval"/);
});

test('D3: 现有 #btn-sayhi-stop 保留（不同于新 #btn-sayhi-stop-batch）', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-stop"[^-]/);  // 排除 -batch 后缀
});

test('D4: 现有 #btn-sayhi-clear-pool 保留', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="btn-sayhi-clear-pool"/);
});

test('D5: 现有 #sayhi-debug-details 保留', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-debug-details"/);
});

test('D6: 现有 #sayhi-pool-bar / #sayhi-evaluations / #sayhi-progress 都保留', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-pool-bar"/);
  assert.match(pane, /id="sayhi-evaluations"/);
  assert.match(pane, /id="sayhi-progress"/);
});

// ========== E: 2a 不接入 JS 事件（2b/2c/2d 的事） ==========

test('v0.25.0 E1: sidepanel.js 仅 K 阈值 input 有 change handler（N 已删）', () => {
  // v0.25.0：删 #sayhi-loop-goal-n change handler
  const re = new RegExp("\\$\\(['\"]sayhi-loop-goal-k['\"]\\).*addEventListener", 'i');
  assert.match(sidepanelJs, re, '#sayhi-loop-goal-k 应仍有 change handler');
  assert.doesNotMatch(sidepanelJs, /\$\(['"]sayhi-loop-goal-n['"]\)\.addEventListener/);
});

test('E2: sidepanel.js 现有按钮 handler 不动（btn-sayhi-scan / -eval / -stop / -clear-pool 都保留）', () => {
  // 这些应该都还在原绑定逻辑里
  assert.match(sidepanelJs, /btn-sayhi-scan.*addEventListener/);
  assert.match(sidepanelJs, /btn-sayhi-eval.*addEventListener/);
  assert.match(sidepanelJs, /btn-sayhi-clear-pool.*addEventListener/);
});
