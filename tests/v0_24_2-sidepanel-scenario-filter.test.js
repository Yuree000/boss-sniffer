// v0.24.2 BUG fix 回归测试 — 推荐页 #evaluations 列表按 scenario 过滤
//
// 起因：HR 反馈在沟通页单评李常发后，推荐页 sidebar 列表也出现这个候选人。
// 根因：sidepanel.js refreshEvaluations 直接渲染所有 records，沟通页评估
//       （scenario='chat' / 'sayhi-tab'）混入推荐页 #evaluations 列表。
// Fix：refreshEvaluations 加 scenario filter，只放行 recommend / latest / 无 scenario
//       兜底（旧数据兼容）。
//
// 跑：node --test tests/v0_24_2-sidepanel-scenario-filter.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const sidepanelJs = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');

test('A1: refreshEvaluations 从 allRecords 派生 records（保留全集 + 过滤后）', () => {
  const m = sidepanelJs.match(/async function refreshEvaluations\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // allRecords 全集（排序后）
  assert.match(m[0], /const allRecords = sortByBatchAndIndex/);
  // records 由 allRecords.filter 派生
  assert.match(m[0], /const records = allRecords\.filter/);
});

test('A2: refreshEvaluations filter 读 candidate.source.scenario', () => {
  const m = sidepanelJs.match(/async function refreshEvaluations\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // filter callback 内读 source.scenario
  assert.match(m[0], /r\.candidate && r\.candidate\.source && r\.candidate\.source\.scenario/);
});

test('A3: filter 放行 recommend + latest，兜底无 scenario 旧数据', () => {
  const m = sidepanelJs.match(/async function refreshEvaluations\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // 三种放行情况
  assert.match(m[0], /sc === 'recommend'/);
  assert.match(m[0], /sc === 'latest'/);
  assert.match(m[0], /!sc/);
});

test('A4: filter 不包含 chat / sayhi-tab 显式（这些被隐式排除）', () => {
  const m = sidepanelJs.match(/async function refreshEvaluations\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // 推荐页 filter 表达式里不应显式包含 chat / sayhi-tab
  // 而是通过白名单（recommend/latest/!sc）隐式排除
  const filterCallback = m[0].match(/const records = allRecords\.filter\(function \(r\)[\s\S]*?\}\);/);
  assert.ok(filterCallback);
  assert.doesNotMatch(filterCallback[0], /sc === 'chat'/);
  assert.doesNotMatch(filterCallback[0], /sc === 'sayhi-tab'/);
});

test('A5: eval-count 用过滤后的 records.length（不是 allRecords.length）', () => {
  const m = sidepanelJs.match(/async function refreshEvaluations\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // eval-count 显示 records.length 而非 allRecords.length
  assert.match(m[0], /\$\('eval-count'\)\.textContent = '\(' \+ records\.length/);
  assert.doesNotMatch(m[0], /\$\('eval-count'\)\.textContent = '\(' \+ allRecords\.length/);
});

test('B1: 沟通页 #sayhi-evaluations 仍由 renderPool 独立渲染（不动）', () => {
  // sanity check：沟通页 pane 有自己的列表，本次 BUG fix 不影响它
  assert.match(sidepanelJs, /sayhi-evaluations/);
  assert.match(sidepanelJs, /function renderPool\(res\)/);
});
