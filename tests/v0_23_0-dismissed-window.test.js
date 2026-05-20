// v0.24.4 撤销窗口设计回退 — 验证 v0.23.0 加的 30s 撤销窗口体系已完全移除
//
// 起因：HR 反馈 v0.23.0 的「pass → 入队 30s 撤销窗口 → sweep 真点不合适」实际不工作；
//      且 HR 已勾 checkbox 表达意图 = 信任 LLM = 不需二次确认，30s 等待是 UX 负担。
// 设计回退：pass 候选人立刻点不合适（与 autoGreet 分支同等待遇），失败按 STEP_POLICY 处理。
//
// 此文件**保留**作为反向锁：防止未来不小心又把 v0.23.0 那套加回来。
// 跑：node --test tests/v0_23_0-dismissed-window.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const sidepanelHtml = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
const sidepanelJs = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');

// =========================================================================
// A. background.js — 5 个 helper + 2 个常量已删
// =========================================================================

test('v0.24.4 A1: enqueueDismissedCandidate 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+enqueueDismissedCandidate\s*\(/);
});

test('v0.24.4 A2: listDismissedCandidates 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+listDismissedCandidates\s*\(/);
});

test('v0.24.4 A3: upsertDismissedCandidate 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+upsertDismissedCandidate\s*\(/);
});

test('v0.24.4 A4: cancelDismissedCandidate 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+cancelDismissedCandidate\s*\(/);
});

test('v0.24.4 A5: sweepExpiredDismissals 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+sweepExpiredDismissals\s*\(/);
});

test('v0.24.4 A6: cleanupExpiredDismissedRecords 函数定义已删', () => {
  assert.doesNotMatch(bg, /async\s+function\s+cleanupExpiredDismissedRecords\s*\(/);
});

test('v0.24.4 A7: DISMISSED_UNDO_WINDOW_MS 常量已删', () => {
  assert.doesNotMatch(bg, /const\s+DISMISSED_UNDO_WINDOW_MS/);
});

test('v0.24.4 A8: DISMISSED_HISTORY_TTL_MS 常量已删', () => {
  assert.doesNotMatch(bg, /const\s+DISMISSED_HISTORY_TTL_MS/);
});

test('v0.24.4 A9: dismissedSweepInFlight 并发标志已删', () => {
  assert.doesNotMatch(bg, /let\s+dismissedSweepInFlight/);
});

// =========================================================================
// B. evalSayhiCore pass 分支改为立即触发
// =========================================================================

test('v0.24.4 B1: evalSayhiCore pass 分支立即调 triggerSayhiAction(mark-unsuitable)', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  // v0.24.5 重构后：pass 分支结构为 `if (decision === 'pass') { if (gate-blocked) {...} else { triggerSayhiAction... } }`
  assert.match(m[0], /evaluation\.decision === 'pass'[\s\S]{0,1500}triggerSayhiAction\([^,]+,\s*['"]mark-unsuitable['"]\)/);
});

test('v0.24.4 B2: pass 分支不再调 enqueueDismissedCandidate', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /enqueueDismissedCandidate/);
});

test('v0.24.4 B3: pass 分支按 STEP_POLICY 处理失败（stop-batch / partial-continue / fail-streak）', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  // pass 分支体里引用 STEP_POLICY
  assert.match(m[0], /evaluation\.decision === 'pass'[\s\S]{0,2000}STEP_POLICY/);
  // v0.24.5：失败计入 actionMarkFailStreak（独立于 autoGreet 的 actionGreetFailStreak）
  assert.match(m[0], /evaluation\.decision === 'pass'[\s\S]{0,3000}actionMarkFailStreak\+\+/);
});

// v0.24.5 BUG fix 回归断言（防 BUG 退化）
test('v0.24.5 B5: actionFailStreak 已拆为 actionGreetFailStreak + actionMarkFailStreak（独立计数）', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  // 两个独立的 streak 变量都存在
  assert.match(m[0], /let actionGreetFailStreak\s*=\s*0/);
  assert.match(m[0], /actionMarkFailStreak\s*=\s*0/);
  // 老的共享变量已不再使用（防退化）
  assert.doesNotMatch(m[0], /let actionFailStreak/);
});

test('v0.24.5 B6: pass 分支 gate-blocked 时输出诊断 log（让 HR 排查为啥没标）', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  // sayhi.auto_mark_gate_blocked 事件 + 含三个 gate 字段
  assert.match(m[0], /sayhi\.auto_mark_gate_blocked/);
  assert.match(m[0], /autoMarkOn:\s*autoMarkOn/);
  assert.match(m[0], /abortRequested:\s*sayhiEvalRun\.abortRequested/);
  assert.match(m[0], /actionMarkFailStreak:\s*actionMarkFailStreak/);
});

test('v0.24.4 B4: 循环开头不再调 sweepExpiredDismissals（三层触发点已删）', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  // 仅检查"调用"形式（不限制注释里能否提到这个名字）
  assert.doesNotMatch(m[0], /await\s+sweepExpiredDismissals\s*\(/);
  assert.doesNotMatch(m[0], /sweepExpiredDismissals\s*\(\s*\)\s*\.then/);
});

// =========================================================================
// C. message handler 删除
// =========================================================================

test('v0.24.4 C1: CANCEL_DISMISSED_CANDIDATE message handler 已删', () => {
  assert.doesNotMatch(bg, /case\s*['"]CANCEL_DISMISSED_CANDIDATE['"]/);
});

test('v0.24.4 C2: GET_SAYHI_POOL 响应不再含 dismissedQueue 字段', () => {
  const m = bg.match(/case\s*['"]GET_SAYHI_POOL['"]:[\s\S]*?return\s+true;/);
  assert.ok(m);
  // 仅检查"字段引用"形式（不限制注释里提到）
  assert.doesNotMatch(m[0], /dismissedQueue:/);
  assert.doesNotMatch(m[0], /dismissedQueue\s*=/);
});

// =========================================================================
// D. alarm 注册 + dispatcher 删除 + alarms.clear 主动清理旧 alarm
// =========================================================================

test('v0.24.4 D1: dismissed-sweep alarm 不再 create', () => {
  assert.doesNotMatch(bg, /chrome\.alarms\.create\(\s*['"]dismissed-sweep['"]/);
});

test('v0.24.4 D2: dismissed-cleanup alarm 不再 create', () => {
  assert.doesNotMatch(bg, /chrome\.alarms\.create\(\s*['"]dismissed-cleanup['"]/);
});

test('v0.24.4 D3: 主动 alarms.clear 清理 v0.23.0 旧 alarm（避免老 alarm 继续 fire）', () => {
  assert.match(bg, /chrome\.alarms\.clear\(\s*['"]dismissed-sweep['"]\)/);
  assert.match(bg, /chrome\.alarms\.clear\(\s*['"]dismissed-cleanup['"]\)/);
});

test('v0.24.4 D4: onAlarm dispatcher 不再含 dismissed-sweep / dismissed-cleanup 分支', () => {
  const m = bg.match(/chrome\.alarms\.onAlarm\.addListener\(function[\s\S]*?\n\}\);/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /alarm\.name === ['"]dismissed-sweep['"]/);
  assert.doesNotMatch(m[0], /alarm\.name === ['"]dismissed-cleanup['"]/);
});

// =========================================================================
// E. sidepanel UI 删除
// =========================================================================

test('v0.24.4 E1: sidepanel.html 沟通页 pane 不再含 #sayhi-dismissed-queue', () => {
  assert.doesNotMatch(sidepanelHtml, /id="sayhi-dismissed-queue"/);
});

test('v0.24.4 E2: sidepanel.html 不再含 #sayhi-dismissed-history-details', () => {
  assert.doesNotMatch(sidepanelHtml, /id="sayhi-dismissed-history-details"/);
});

test('v0.24.4 E3: sidepanel.html 不再含 .sayhi-dismissed-queue CSS 定义', () => {
  assert.doesNotMatch(sidepanelHtml, /\.sayhi-dismissed-queue\s*\{/);
  assert.doesNotMatch(sidepanelHtml, /\.dismissed-item\s*\{/);
  assert.doesNotMatch(sidepanelHtml, /\.di-countdown\s*\{/);
});

test('v0.24.4 E4: sidepanel.js renderDismissedQueue 函数已删', () => {
  assert.doesNotMatch(sidepanelJs, /function\s+renderDismissedQueue/);
});

test('v0.24.4 E5: sidepanel.js 不再发 CANCEL_DISMISSED_CANDIDATE message', () => {
  assert.doesNotMatch(sidepanelJs, /['"]CANCEL_DISMISSED_CANDIDATE['"]/);
});
