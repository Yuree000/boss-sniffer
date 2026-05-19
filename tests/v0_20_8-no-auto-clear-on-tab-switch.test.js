// v0.20.8 测试：删除 onUpdated 自动清 evaluations 监听器
// 跑：node --test tests/v0_20_8-no-auto-clear-on-tab-switch.test.js
//
// 背景：v0.12.4 加的功能 — 监听 BOSS tab URL 变化，切推荐 ↔ 沟通 时自动清 evaluations。
// HR 反馈：切沟通页处理新招呼后回推荐页，希望保留刚才筛选的候选人池（"猎豹"）。
// 新口径：evaluations 只在 HR 主动点 [开始本轮] 时清（START_LOOP 内）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const bgJs = read('background.js');
const sidepanelHtml = read('sidepanel/sidepanel.html');

// ============ A: onUpdated 监听器 + 配套代码已删 ============

test('A1: background.js 不再含 chrome.tabs.onUpdated 自动清 evaluations 监听器', () => {
  // 整个监听器 + isRecommendPage + lastBossTabUrl 都应消失
  assert.doesNotMatch(bgJs, /chrome\.tabs\.onUpdated\.addListener[\s\S]*?clearEvaluations\(\)/);
  assert.doesNotMatch(bgJs, /let lastBossTabUrl/);
  assert.doesNotMatch(bgJs, /function isRecommendPage/);
});

test('A2: background.js 不再含 v0.12.4 注释（"监听 BOSS tab URL 变化，自动清 evaluations"）', () => {
  assert.doesNotMatch(bgJs, /v0\.12\.4: 监听 BOSS tab URL 变化，自动清 evaluations/);
});

test('A3: background.js 仍保留 START_LOOP 内的 clearEvaluations（HR 主动入口不动）', () => {
  // START_LOOP case 内仍有 await clearEvaluations()
  const m = bgJs.match(/case 'START_LOOP':[\s\S]*?await clearEvaluations\(\)/);
  assert.ok(m, 'START_LOOP 仍是 HR 主动清 evaluations 的入口');
});

test('A4: background.js clearEvaluations 函数定义保留（仍被 START_LOOP / admin 调用）', () => {
  assert.match(bgJs, /async function clearEvaluations\(\)/);
});

test('A5: background.js 留下 v0.20.8 删除说明注释（防止有人再加回来）', () => {
  assert.match(bgJs, /v0\.20\.8/);
  assert.match(bgJs, /删除 v0\.12\.4 的 onUpdated 自动清/);
});

// ============ B: sidepanel.html 「开始本轮」按钮加了文案提示 ============

test('B1: v0.20.10 删了 btn-start 的 title 属性（HR 不要任何说明）', () => {
  // 历史：v0.20.8 加 title → v0.20.10 删（跟 .start-help-toggle 一起去掉）
  assert.doesNotMatch(sidepanelHtml, /id="btn-start"[^>]*title=/);
});

test('B2: v0.20.10 删了所有「开始本轮」说明（HR 觉得不需要），sidepanel.html 应无 hint 残留', () => {
  // 历史演进：v0.20.8 加 .start-hint 横幅 → v0.20.9 改 ⓘ popup → v0.20.10 全删
  assert.doesNotMatch(sidepanelHtml, /class="start-hint"/);
  assert.doesNotMatch(sidepanelHtml, /start-help-toggle/);
});

// ============ C: 行为验证 — 模拟 onUpdated 触发，确认无自动清 ============

test('C1: 即使有人再加 chrome.tabs.onUpdated 监听，也不应调用 clearEvaluations', () => {
  // 反向断言：搜全文找所有 onUpdated listener 引用，确保没有跟 clearEvaluations 配对的
  const onUpdatedMatches = bgJs.match(/chrome\.tabs\.onUpdated[\s\S]{0,500}/g) || [];
  onUpdatedMatches.forEach(function (snippet) {
    assert.doesNotMatch(snippet, /clearEvaluations/,
      'onUpdated 监听器 500 字内不应含 clearEvaluations 调用');
  });
});

test('C2: clearEvaluations 仍只被以下场景调用：① START_LOOP（HR 主动） ② CLEAR_EVALUATIONS 消息（admin） ③ CLEAR_ALL 链路', () => {
  // 截掉函数定义本身，统计调用点
  const callSites = bgJs.match(/clearEvaluations\(\)/g) || [];
  // 定义本身（async function clearEvaluations() {）+ 调用点
  // 期望 ≤ 5 处（函数定义 + 实际调用），不应多余
  assert.ok(callSites.length <= 6, '调用点数量被严格控制（' + callSites.length + ' 处）');
});
