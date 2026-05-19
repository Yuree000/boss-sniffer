// v0.20.9 三态卡片 + 开始本轮 ⓘ 弹出提示
// 跑：node --test tests/v0_20_9-three-state-evaluation.test.js
//
// 三态：queued（待评估）/ pending（评估中）/ done|failed（结果）
//   - 推荐页：阶段 1 写 queued 占位 → runWithConcurrency worker 进入时 upsert pending → LLM 返回 upsert done
//   - 沟通页：阶段 1 写 queued 占位 → for 循环 LLM 前一刻 upsert pending → done
//   - clearPendingEvaluations 同时清 queued
//   - watchdog 兜 queued 超 5min 也转 failed

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const bgJs = read('background.js');
const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');

// ============ A: 写入侧 — 推荐页主链路 ============

test('A1: 推荐页阶段 1 写占位 status="queued"（待评估），queuedAt 记入队时刻', () => {
  // background.js:592 一带的占位 upsert
  const m = bgJs.match(/阶段 1[\s\S]*?upsertEvaluations\(candidates\.map[\s\S]*?status:\s*'queued'[\s\S]*?queuedAt:\s*Date\.now\(\)/);
  assert.ok(m, '推荐页阶段 1 占位写 status:queued + queuedAt');
});

test('A2: 推荐页 runWithConcurrency worker 进入时 upsert pending（评估中）+ startedAt', () => {
  // worker 函数体一开始就 upsertEvaluation pending
  const m = bgJs.match(/runWithConcurrency\(candidates[\s\S]*?async function \(c\) \{[\s\S]*?upsertEvaluation\(\{[\s\S]*?status:\s*'pending'[\s\S]*?startedAt:\s*Date\.now\(\)[\s\S]*?\}\);[\s\S]*?BossJudge\.judgeCandidate/);
  assert.ok(m, 'runWithConcurrency worker 进入应 upsert pending（在 LLM 调用前）');
});

// ============ B: 写入侧 — 沟通页 evalSayhiCore ============

test('B1: 沟通页 evalSayhiCore 占位写 status="queued"（待评估）', () => {
  const m = bgJs.match(/upsertEvaluations\(todo\.map[\s\S]*?status:\s*'queued'[\s\S]*?queuedAt:\s*Date\.now\(\)/);
  assert.ok(m, '沟通页 evalSayhiCore 占位写 queued + queuedAt');
});

test('B2: 沟通页 for 循环 LLM 调用前 upsert pending（评估中）', () => {
  // LLM judgeCandidate 调用前一行 upsertEvaluation pending
  const m = bgJs.match(/upsertEvaluation\(\{[\s\S]*?status:\s*'pending'[\s\S]*?startedAt:\s*Date\.now\(\)[\s\S]*?capturedUrl:\s*'sayhi-tab'[\s\S]*?\}\);[\s\S]*?BossJudge\.judgeCandidate\(fresh/);
  assert.ok(m, '沟通页循环里 LLM 前一刻 upsert pending');
});

// ============ C: 清理侧 — clearPendingEvaluations 同时清 queued ============

test('C1: clearPendingEvaluations 同时清 queued 和 pending', () => {
  const m = bgJs.match(/function clearPendingEvaluations[\s\S]*?if \(st === 'pending' \|\| st === 'queued'\) \{[\s\S]*?cursor\.delete\(\)/);
  assert.ok(m, 'STOP_LOOP 时所有排队 + 评估中的都要清掉');
});

// ============ D: 兜底 — watchdog sweep queued + pending ============

test('D1: watchdog sweepStalePending 兜底 queued（超 5min 也转 failed）', () => {
  const m = bgJs.match(/function sweepStalePending[\s\S]*?e\.status === 'queued'[\s\S]*?queuedAt[\s\S]*?PENDING_STALE_MS/);
  assert.ok(m, 'queued 超 5min 应被 watchdog 转 failed');
});

test('D2: watchdog 用 startedAt 或 queuedAt 算 elapsed', () => {
  const m = bgJs.match(/const sinceTs = r\.evaluation\.startedAt \|\| r\.evaluation\.queuedAt/);
  assert.ok(m, '兼容 pending（startedAt） / queued（queuedAt）两种时间字段');
});

// ============ E: 渲染侧 — sidepanel.js decisionLabel / decisionClass ============

test('E1: sidepanel.js decisionLabel 三态文案', () => {
  assert.match(sidepanelJs, /status === 'queued'[\s\S]*?return '⏳ 待评估'/);
  assert.match(sidepanelJs, /status === 'pending'[\s\S]*?return '🔄 评估中'/);
});

test('E2: sidepanel.js decisionClass 把 queued 映射到独立 CSS class', () => {
  const m = sidepanelJs.match(/function decisionClass[\s\S]*?status === 'queued'[\s\S]*?return 'queued'/);
  assert.ok(m);
});

// ============ F: CSS — 三态视觉区分 ============

test('F1: sidepanel.html 含 .decision.queued 灰色 + .decision.pending 蓝色 + 脉动动画', () => {
  assert.match(sidepanelHtml, /\.decision\.queued\s*\{[\s\S]*?background:\s*#eee/);
  assert.match(sidepanelHtml, /\.decision\.pending\s*\{[\s\S]*?background:\s*#2467f0/);
  assert.match(sidepanelHtml, /@keyframes pending-pulse/);
  assert.match(sidepanelHtml, /animation: pending-pulse/);
});

// ============ G: 开始本轮区域不带任何说明（v0.20.10 删了 ⓘ popup，HR 觉得不需要）============

test('G1: sidepanel.html 不再含 .start-hint 常驻横幅 + .start-help-toggle ⓘ 按钮', () => {
  assert.doesNotMatch(sidepanelHtml, /<div class="start-hint"/);
  assert.doesNotMatch(sidepanelHtml, /start-help-toggle/);
  assert.doesNotMatch(sidepanelHtml, /start-help-popup/);
});
