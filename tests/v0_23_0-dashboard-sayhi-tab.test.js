// 测试 v0.23.0 · Phase 3·3d 收尾：看板沟通页 tab 解锁
//
// 见 .claude/plans/resilient-dazzling-dove.md §C.4
//
// 范围：dashboard.js 4 处 isChatScenario() → CHAT_PLACEHOLDER_HTML 分支移除，
// events 表新增 engaged / resume_received 后，filterEvents(scenario='chat') 自动 pick up
//
// CHAT_PLACEHOLDER_HTML 常量保留（可能给将来其他过渡场景复用，不删）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const dashboard = read('dashboard/dashboard.js');

// ========== A: 4 处 isChatScenario placeholder 分支移除 ==========

test('A1: 4.B 漏斗（renderViewFunnel）不再走 CHAT_PLACEHOLDER 分支', () => {
  const m = dashboard.match(/function\s+renderViewFunnel\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /if\s*\(\s*isChatScenario\(\)\s*\)\s*\{[\s\S]{0,200}CHAT_PLACEHOLDER_HTML/);
});

test('A2: 4.C JD 分析（renderViewJD）不再走 CHAT_PLACEHOLDER 分支', () => {
  const m = dashboard.match(/function\s+renderViewJD\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /if\s*\(\s*isChatScenario\(\)\s*\)\s*\{[\s\S]{0,200}CHAT_PLACEHOLDER_HTML/);
});

test('A3: 4.D 趋势（renderViewTrend）不再走 CHAT_PLACEHOLDER 分支', () => {
  const m = dashboard.match(/function\s+renderViewTrend\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /if\s*\(\s*isChatScenario\(\)\s*\)\s*\{[\s\S]{0,200}CHAT_PLACEHOLDER_HTML/);
});

test('A4: 4.E 候选人记录（renderViewDrawer）不再走 CHAT_PLACEHOLDER 分支', () => {
  const m = dashboard.match(/function\s+renderViewDrawer\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /if\s*\(\s*isChatScenario\(\)\s*\)\s*\{[\s\S]{0,200}CHAT_PLACEHOLDER_HTML/);
});

// ========== B: CHAT_PLACEHOLDER_HTML 常量保留（不删 — 可能将来复用） ==========

test('B1: CHAT_PLACEHOLDER_HTML 常量仍定义（可作他用，不删）', () => {
  assert.match(dashboard, /CHAT_PLACEHOLDER_HTML/);
});

// ========== C: 沟通页 tab 漏斗渲染 — v0.24.1 撤销 L3/L4 ==========
// HR 反馈：chatHistory role 识别 + resume card 抓取实际未稳定流入 events 表，
// UI 显示 0 反而误导。emit 代码（background.js mergeChatHistory / mergeResumeCards）
// 保留，未来抓取改进可重新启用 UI。

test('v0.24.1 C1: 漏斗 renderViewFunnel 不再渲染 engaged 行（L3 删除）', () => {
  const m = dashboard.match(/function\s+renderViewFunnel\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  // funnelRow 不应含「候选人首次回复」标签
  assert.doesNotMatch(m[0], /funnelRow\([^)]*候选人首次回复/);
  // 不应在 renderViewFunnel 内 filterEvents stage='engaged'
  assert.doesNotMatch(m[0], /stage:\s*['"]engaged['"]/);
});

test('v0.24.1 C2: 漏斗 renderViewFunnel 不再渲染 resume_received 行（L4 删除）', () => {
  const m = dashboard.match(/function\s+renderViewFunnel\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  // funnelRow 不应含「收到候选人简历」标签
  assert.doesNotMatch(m[0], /funnelRow\([^)]*收到候选人简历/);
  // 不应在 renderViewFunnel 内 filterEvents stage='resume_received'
  assert.doesNotMatch(m[0], /stage:\s*['"]resume_received['"]/);
});

test('v0.24.1 C3: emit 代码保留（background.js mergeChatHistory / mergeResumeCards 不动）', () => {
  const bgPath = path.resolve(__dirname, '../background.js');
  const bg = fs.readFileSync(bgPath, 'utf8');
  // L3 emit 仍在
  assert.match(bg, /stage:\s*['"]engaged['"]/);
  // L4 emit 仍在
  assert.match(bg, /stage:\s*['"]resume_received['"]/);
});

// ========== D: 不破坏推荐页 tab ==========

test('D1: recordScenario 业务归一化保留（v0.20.7 修过）', () => {
  assert.match(dashboard, /function\s+recordScenario|recordScenario/);
});

test('D2: 推荐页 funnel 主路径（candidate_pool / match_marked / sayhi_sent）保留', () => {
  assert.match(dashboard, /candidate_pool/);
  assert.match(dashboard, /match_marked/);
  assert.match(dashboard, /sayhi_sent/);
});
