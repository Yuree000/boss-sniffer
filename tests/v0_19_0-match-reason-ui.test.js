// v0.19.0 符合理由 UI — 验证 sidepanel 符合/pass 卡片展开 + dashboard 视图四「可选条件命中率」
// v0.19.1 UI 重设计：去顶部一句话总结，改成条件纵向堆叠列表，每条 M_i / O_i 下面挂自己的 reason
// 跑：node --test tests/v0_19_0-match-reason-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelJs = read('sidepanel/sidepanel.js');
const sidepanelHtml = read('sidepanel/sidepanel.html');
// v0.20.0：dashboard 整个重写，B section（旧 view4 / renderView4 / view4-card 等）已搬至
// tests/v0_20_0-dashboard-v2-ui.test.js 并对齐新结构（renderViewJD + view-jd-card）。

// ============ A: sidepanel 符合 / pass 卡片展开（v0.19.1 重构为纵向条件列表）============

test('A: sidepanel.js renderEvaluation 的 expandable 包含 符合 decision', () => {
  // expandable = (status === 'done' && (e.decision === 'pass' || e.decision === '符合')) || status === 'failed'
  assert.match(sidepanelJs, /e\.decision === 'pass' \|\| e\.decision === '符合'/);
});

test('A: sidepanel.js 含 buildConditionsList 函数（v0.19.1 替换 buildAllConditionsTable）', () => {
  assert.match(sidepanelJs, /function buildConditionsList\(evalRecord, mustConditions, optionalConditions\)/);
});

test('A: sidepanel.js v0.19.1 已删 buildAllConditionsTable 及其使用的状态外挂 Set', () => {
  // 函数被 buildConditionsList 取代，不应再存在
  assert.doesNotMatch(sidepanelJs, /function buildAllConditionsTable/);
  // expandedBreakdownIds 也跟着废弃（条件列表常驻展开，无折叠状态需要记）
  assert.doesNotMatch(sidepanelJs, /const expandedBreakdownIds = new Set/);
});

test('A: sidepanel.js buildConditionsList 渲染 .condition-item 块（每条 M_i / O_i 一个）', () => {
  // header: condition-key + condition-text + condition-status
  // reason: condition-reason 在 header 下方
  assert.match(sidepanelJs, /item\.className = 'condition-item'/);
  assert.match(sidepanelJs, /header\.className = 'condition-header'/);
  assert.match(sidepanelJs, /keySpan\.className = 'condition-key'/);
  assert.match(sidepanelJs, /textSpan\.className = 'condition-text'/);
  assert.match(sidepanelJs, /statusSpan\.className = 'condition-status ' \+ dimValueClass/);
  assert.match(sidepanelJs, /reasonDiv\.className = 'condition-reason'/);
});

test('A: sidepanel.js v0.19.1 expand block 不再渲染顶部 pass-reason / pass-detail（信息分散到条件项里）', () => {
  // renderEvaluation 内部 else 分支不应再创建 pass-reason / pass-detail div
  const m = sidepanelJs.match(/} else \{\s*\/\/ v0\.19\.1[\s\S]*?if \(list\) expand\.appendChild\(list\);\s*\}/);
  assert.ok(m, '能定位 v0.19.1 else 分支');
  assert.doesNotMatch(m[0], /reasonDiv\.className = 'pass-reason'/);
  assert.doesNotMatch(m[0], /detail\.className = 'pass-detail'/);
  // 应直接调 buildConditionsList
  assert.match(m[0], /buildConditionsList\(e, mustConditions, optionalConditions\)/);
});

test('A: sidepanel.js dimStatusText 加状态前缀符号（✓ / ✗ / ?，HR 一眼看懂）', () => {
  assert.match(sidepanelJs, /'✓ 通过'/);
  assert.match(sidepanelJs, /'✗ 不通过'/);
  assert.match(sidepanelJs, /'\? 信息不确定'/);
});

test('A: sidepanel.js 条件 reason 缺失时给 placeholder（防 LLM 偷懒留空）', () => {
  assert.match(sidepanelJs, /'condition-reason empty'/);
  assert.match(sidepanelJs, /LLM 未给出理由/);
});

test('A: sidepanel.html 加 .conditions-list / .condition-item / .condition-header / .condition-status 整套 CSS', () => {
  assert.match(sidepanelHtml, /\.conditions-list\s*\{/);
  assert.match(sidepanelHtml, /\.condition-item\s*\{/);
  assert.match(sidepanelHtml, /\.condition-header\s*\{/);
  assert.match(sidepanelHtml, /\.condition-status\.true\s*\{[\s\S]*?#2a6f49/);
  assert.match(sidepanelHtml, /\.condition-status\.false\s*\{[\s\S]*?#a33/);
  assert.match(sidepanelHtml, /\.condition-status\.unknown\s*\{[\s\S]*?#b08000/);
});

test('A: sidepanel.html v0.19.1 已删旧 breakdown 表格 CSS（被纵向 .condition-* 系列替换）', () => {
  assert.doesNotMatch(sidepanelHtml, /\.breakdown table/);
  assert.doesNotMatch(sidepanelHtml, /\.breakdown \.dim-name/);
  assert.doesNotMatch(sidepanelHtml, /\.breakdown \.dim-val/);
  assert.doesNotMatch(sidepanelHtml, /\.breakdown \.dim-reason/);
});

test('A: sidepanel.js v0.19.1 删了 findFailedMust / findUnknownMust / countSatisfiedOptional 三个孤儿', () => {
  // 这三个 helper 在去掉顶部一句话总结后不再被调用
  assert.doesNotMatch(sidepanelJs, /function findFailedMust/);
  assert.doesNotMatch(sidepanelJs, /function findUnknownMust/);
  assert.doesNotMatch(sidepanelJs, /function countSatisfiedOptional/);
});

