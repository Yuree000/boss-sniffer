// v0.24.3 BUG fix 回归测试 — autoMark gate 从 autoActionOn 解耦
//
// 起因：HR 反馈勾上「自动标不合适」没成功。
// 根因：background.js evalSayhiCore line 1970 pass 入队分支用 autoActionOn 当 gate，
//       而 autoActionOn = enabledBatchEval（「自动话术+求简历」开关）。HR 只勾 autoMark
//       不勾 autoGreet 时 autoActionOn=false → pass 候选人不入队 dismissed_candidates。
// Fix：autoMarkOn = executeAction && autoMarkUnsuitable（独立变量）。pass 分支用 autoMarkOn。
//
// 跑：node --test tests/v0_24_3-automark-gate-decoupled.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function evalSayhiCoreBody() {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m, 'evalSayhiCore 函数未找到');
  return m[0];
}

test('A1: evalSayhiCore 定义 autoMarkOn 变量（独立于 autoActionOn）', () => {
  const body = evalSayhiCoreBody();
  assert.match(body, /const autoMarkOn = executeAction && !!\(appConfig\.autoAction && appConfig\.autoAction\.autoMarkUnsuitable\)/);
});

test('A2: autoActionOn 保留并仍绑定 enabledBatchEval（autoGreet 分支不变）', () => {
  const body = evalSayhiCoreBody();
  assert.match(body, /const autoActionOn = executeAction && !!\(appConfig\.autoAction && appConfig\.autoAction\.enabledBatchEval\)/);
});

test('B1: pass 分支 gate 用 autoMarkOn（不依赖 autoActionOn / enabledBatchEval）', () => {
  const body = evalSayhiCoreBody();
  // v0.24.5 重构后：pass 分支 outer if 是 decision==='pass'，里面再判 autoMarkOn 等 gate
  // 关键是：autoMarkOn 仍是 pass 分支的 gate 之一（不被 autoActionOn 替代）
  assert.match(body, /autoMarkOn/);
  // pass 分支结构里出现 autoMarkOn（非 autoActionOn）作为 gate 判定
  assert.match(body, /evaluation\.decision === 'pass'[\s\S]{0,500}autoMarkOn/);
});

test('v0.24.4 B2: pass 分支立即调 triggerSayhiAction（设计回退后 enqueue 已删）', () => {
  const body = evalSayhiCoreBody();
  // v0.24.5 重构后：pass 分支结构 `if (decision === 'pass') { ... triggerSayhiAction(... 'mark-unsuitable') ... }`
  const passBranch = body.match(/evaluation\.decision === 'pass'[\s\S]{0,2000}triggerSayhiAction\([^,]+,\s*['"]mark-unsuitable['"]\)/);
  assert.ok(passBranch, 'pass 立即触发分支未找到');
  // 不应再调 enqueueDismissedCandidate（v0.24.4 已删 30s 撤销窗口）
  assert.doesNotMatch(passBranch[0], /enqueueDismissedCandidate/);
  // gate 判定不重复使用 appConfig.autoAction.autoMarkUnsuitable（已含在 autoMarkOn 内）
  assert.doesNotMatch(passBranch[0], /appConfig\.autoAction\.autoMarkUnsuitable/);
});

test('C1: 符合分支仍用 autoActionOn（autoGreet 走自己的 gate）', () => {
  const body = evalSayhiCoreBody();
  assert.match(body, /if\s*\(autoActionOn && evaluation\.decision === '符合'/);
});

test('D1: BossDiag log 含 autoMarkOn 字段（observability）', () => {
  const body = evalSayhiCoreBody();
  // sayhi.serial_start 事件 payload 含 autoMarkOn
  const startLog = body.match(/sayhi\.serial_start[\s\S]*?\}\);/);
  assert.ok(startLog);
  assert.match(startLog[0], /autoMarkOn:\s*autoMarkOn/);
});

// E：业务正确性——HR 4 种 checkbox 组合的预期 gate 状态
//   ☐ autoGreet ☐ autoMark → 两分支都不触发（纯评估）
//   ☑ autoGreet ☐ autoMark → 符合分支触发，pass 分支不触发
//   ☐ autoGreet ☑ autoMark → 符合分支不触发，pass 分支触发  ← v0.24.3 修的就是这个
//   ☑ autoGreet ☑ autoMark → 两分支都触发
//
// 这些是 static-assert 测不出的运行时行为，留作 HR 真机验收 checklist。
// 此处只锁 gate 表达式独立性。
test('E1: autoMarkOn 表达式与 autoActionOn 不互相依赖（彻底独立）', () => {
  const body = evalSayhiCoreBody();
  const autoMarkOnDef = body.match(/const autoMarkOn = [^;]+;/);
  assert.ok(autoMarkOnDef);
  // autoMarkOn 定义中不引用 autoActionOn / enabledBatchEval
  assert.doesNotMatch(autoMarkOnDef[0], /autoActionOn/);
  assert.doesNotMatch(autoMarkOnDef[0], /enabledBatchEval/);

  const autoActionOnDef = body.match(/const autoActionOn = [^;]+;/);
  assert.ok(autoActionOnDef);
  // autoActionOn 定义中不引用 autoMarkOn / autoMarkUnsuitable
  assert.doesNotMatch(autoActionOnDef[0], /autoMarkOn/);
  assert.doesNotMatch(autoActionOnDef[0], /autoMarkUnsuitable/);
});
