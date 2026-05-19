// v0.20.6 sidepanel 简化 + admin 危险操作区测试
// 跑：node --test tests/v0_20_6-sidepanel-cleanup.test.js
//
// v0.20.6 改动总览：
//   1. sidepanel 删 4 个失效/冗余 UI：
//      - #filter-current-loop（仅显示本轮）—— START_LOOP 已自动清评估，开关失效
//      - #btn-refresh（手动刷新）—— 有 1.5s 自动轮询，按钮冗余
//      - #btn-clear-eval（清空评估）—— HR 无业务场景；原文案误导（说"不影响看板"实际清了看板）
//      - #btn-clear（清空全部）—— HR 无业务场景
//   2. admin 加「危险操作」section：BG 消息 CLEAR / CLEAR_EVALUATIONS 保留供开发调试
//      迁移到 admin 双重/三重 confirm 二级菜单避免误点

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');
const adminHtml = read('admin/admin.html');
const adminJs = read('admin/admin.js');
const bgJs = read('background.js');

// ============ A: sidepanel.html 已删 4 个元素 ============

test('A1: sidepanel.html 不再含 #filter-current-loop 复选框', () => {
  assert.doesNotMatch(sidepanelHtml, /id="filter-current-loop"/);
  assert.doesNotMatch(sidepanelHtml, /仅显示本轮候选人/);
  assert.doesNotMatch(sidepanelHtml, /id="filter-hint"/);
});

test('A2: sidepanel.html 不再含 #btn-refresh', () => {
  assert.doesNotMatch(sidepanelHtml, /id="btn-refresh"/);
});

test('A3: sidepanel.html 不再含 #btn-clear（清空全部）', () => {
  assert.doesNotMatch(sidepanelHtml, /id="btn-clear"/);
});

test('A4: sidepanel.html 不再含 #btn-clear-eval（清空评估）', () => {
  assert.doesNotMatch(sidepanelHtml, /id="btn-clear-eval"/);
  assert.doesNotMatch(sidepanelHtml, /清空评估/);
});

test('A5: sidepanel.html footer 仍含 看板 / 设置 入口', () => {
  assert.match(sidepanelHtml, /id="btn-dashboard"/);
  assert.match(sidepanelHtml, /id="btn-options"/);
});

// ============ B: sidepanel.js 已删失效逻辑 ============

test('B1: sidepanel.js 不再含 filterByLoop / loopStartedAt 过滤逻辑', () => {
  assert.doesNotMatch(sidepanelJs, /filterByLoop/);
  // 残留对 res.loopStartedAt 的读取也清除
  assert.doesNotMatch(sidepanelJs, /Number\(res\.loopStartedAt\)/);
});

test('B2: sidepanel.js 不再监听 #btn-refresh / #btn-clear / #btn-clear-eval / #filter-current-loop', () => {
  assert.doesNotMatch(sidepanelJs, /\$\('btn-refresh'\)\.addEventListener/);
  assert.doesNotMatch(sidepanelJs, /\$\('btn-clear'\)\.addEventListener/);
  assert.doesNotMatch(sidepanelJs, /\$\('btn-clear-eval'\)\.addEventListener/);
  assert.doesNotMatch(sidepanelJs, /\$\('filter-current-loop'\)\.addEventListener/);
});

test('B3: sidepanel.js refresh() 函数 + 1.5s 自动轮询保留（删的是手动按钮，不是机制）', () => {
  assert.match(sidepanelJs, /async function refresh\(\)/);
  assert.match(sidepanelJs, /setInterval\(refresh, 1500\)/);
});

// ============ C: admin 危险操作 section ============

test('C1: admin.html 含「危险操作」section（标题 + 两个按钮）', () => {
  assert.match(adminHtml, /危险操作（开发调试用）/);
  assert.match(adminHtml, /id="btn-danger-clear-eval"/);
  assert.match(adminHtml, /id="btn-danger-clear-all"/);
  assert.match(adminHtml, /id="danger-op-status"/);
});

test('C2: admin.html 文案明确说明清空评估会清看板（修了之前 sidepanel 的误导文案）', () => {
  assert.match(adminHtml, /看板漏斗 \/ JD 分析 \/ 趋势 \/ 候选人记录[\s\S]*?全部清空/);
});

test('C3: admin.js 含双重/三重 confirm 流程 + 状态反馈', () => {
  // CLEAR_EVALUATIONS：2 步 confirm
  assert.match(adminJs, /第 1\/2 步[\s\S]*?CLEAR_EVALUATIONS/);
  // CLEAR：3 步 confirm
  const all3Steps = adminJs.match(/第 1\/3 步[\s\S]*?第 2\/3 步[\s\S]*?第 3\/3 步[\s\S]*?type: 'CLEAR'/);
  assert.ok(all3Steps, 'CLEAR 操作应有三重 confirm');
});

test('C4: admin.js 绑定两个按钮事件', () => {
  assert.match(adminJs, /document\.getElementById\('btn-danger-clear-eval'\)/);
  assert.match(adminJs, /document\.getElementById\('btn-danger-clear-all'\)/);
});

// ============ D: background.js 消息 handler 保留 ============

test('D1: background.js 仍处理 CLEAR / CLEAR_EVALUATIONS 消息（admin 调试入口要用）', () => {
  assert.match(bgJs, /case 'CLEAR':\s*\n\s*clearAll\(\)/);
  assert.match(bgJs, /case 'CLEAR_EVALUATIONS':\s*\n\s*clearEvaluations\(\)/);
});

test('D2: background.js clearAll / clearEvaluations 函数定义保留', () => {
  assert.match(bgJs, /async function clearAll\(\)/);
  assert.match(bgJs, /async function clearEvaluations\(\)/);
});

// ============ E: START_LOOP 行为不变（v0.12.4 起就清评估） ============

test('E1: START_LOOP 仍在新一轮开始前清 evaluations（这是删 filter-current-loop 的前提）', () => {
  const m = bgJs.match(/case 'START_LOOP':[\s\S]*?await clearEvaluations\(\)/);
  assert.ok(m, 'START_LOOP 必须仍调 clearEvaluations，否则删 filter-current-loop 后会展示历史轮次');
});
