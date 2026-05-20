// 测试 v0.21.0 · Phase 1·1c：background.js evalSayhiCore 接入 BossJDRouter
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.1 子步骤 1c
//
// 静态文本断言（不启动 service worker，结合 jd-router.test.js 的纯函数测试覆盖整条链路）
// 跑：node --test tests/evalsayhi-route-by-jobname.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// 提取 evalSayhiCore 函数体（从 `async function evalSayhiCore` 到下一个顶层 `async function`）
function getEvalSayhiCoreBody() {
  const m = bg.match(/async function evalSayhiCore\(targetCandidateIds, opts\)[\s\S]*?\n(?=async function evalSayhiBatch)/);
  if (!m) throw new Error('未找到 evalSayhiCore 函数');
  return m[0];
}

// ========== importScripts 接入 ==========

test('background.js — importScripts 含 lib/jd-router.js', () => {
  assert.match(bg, /importScripts\([^)]*lib\/jd-router\.js[^)]*\)/);
});

// ========== evalSayhiCore 路由层 ==========

test('evalSayhiCore — 调用 BossJDRouter.routeWithDiagnosis 做 per-candidate 路由', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /BossJDRouter\.routeWithDiagnosis\(/);
});

test('evalSayhiCore — 路由前 listTemplates 拿全部 JD（批量预算，不在循环内重复读）', () => {
  const body = getEvalSayhiCoreBody();
  // listTemplates 调用应在 for 循环之前
  const listTemplatesIdx = body.search(/BossJD\.listTemplates\(\)/);
  const forLoopIdx = body.search(/for \(let i = 0; i < todo\.length/);
  assert.ok(listTemplatesIdx > 0, 'listTemplates 必须被调用');
  assert.ok(forLoopIdx > 0, 'for 循环必须存在');
  assert.ok(listTemplatesIdx < forLoopIdx, 'listTemplates 应在 for 循环之前');
});

test('evalSayhiCore — routeResults 数组对每个 todo 元素预算一次路由结果', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /routeResults\s*=\s*todo\.map/);
});

test('evalSayhiCore — 删除了旧的全局 const jd = await getCurrentJdTemplate()', () => {
  const body = getEvalSayhiCoreBody();
  // 旧代码模式：const jd = await getCurrentJdTemplate()（在 for 循环之前，作为全局变量给整批用）
  // 1c 改造后这行不应再存在
  assert.doesNotMatch(body, /const jd = await getCurrentJdTemplate\(\)/);
});

// ========== unrouted 候选人处理 ==========

test('evalSayhiCore — unrouted 候选人在批量初始 upsert 阶段 status="unrouted"', () => {
  const body = getEvalSayhiCoreBody();
  // 批量 upsertEvaluations 阶段必须区分 routed / unrouted
  assert.match(body, /status:\s*['"]unrouted['"]/);
});

test('evalSayhiCore — unrouted 评估记录含 unrouteReason 和 jobAligned 字段', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /unrouteReason:/);
  assert.match(body, /jobAligned:/);
});

test('evalSayhiCore — 循环内 unrouted 候选人 continue 跳过（不调 LLM、不做自动操作）', () => {
  const body = getEvalSayhiCoreBody();
  // 必须有 `if (route.reason !== 'matched')` 的早退分支 + continue
  assert.match(body, /route\.reason\s*!==\s*['"]matched['"][\s\S]*?continue;/);
});

test('evalSayhiCore — unrouted 跳过时 sayhiEvalRun.done 仍 ++（进度条照常推进）', () => {
  const body = getEvalSayhiCoreBody();
  // 早退分支里必须有 done++
  const earlySkipMatch = body.match(/route\.reason\s*!==\s*['"]matched['"][\s\S]*?continue;/);
  assert.ok(earlySkipMatch);
  assert.match(earlySkipMatch[0], /sayhiEvalRun\.done\+\+/);
});

// ========== matched 候选人使用 per-candidate jd ==========

test('evalSayhiCore — 循环内 const jd = route.jd（per-candidate 路由命中的 JD）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /const jd\s*=\s*route\.jd/);
});

test('evalSayhiCore — judgeCandidate 调用使用 per-candidate 路由的 jd', () => {
  const body = getEvalSayhiCoreBody();
  // judgeCandidate(fresh, jd, llmCfg) 仍存在，但 jd 不再来自外层 getCurrentJdTemplate
  assert.match(body, /BossJudge\.judgeCandidate\(fresh,\s*jd,\s*llmCfg\)/);
});

// ========== 评估记录字段（给 1d sidepanel 用） ==========

test('evalSayhiCore — matched 评估写入 evaluation.routedJdId / routedJdName / routedByJobName', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /evaluation\.routedJdId\s*=/);
  assert.match(body, /evaluation\.routedJdName\s*=/);
  assert.match(body, /evaluation\.routedByJobName\s*=/);
});

// ========== 诊断日志 ==========

test('evalSayhiCore — 批次开始写诊断日志 sayhi.route（含 total/routed/unrouted）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /BossDiag\.log\([^,]+,\s*['"]sayhi\.route['"]/);
});

test('evalSayhiCore — unrouted 跳过时写诊断日志 sayhi.unrouted_skip', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /BossDiag\.log\([^,]+,\s*['"]sayhi\.unrouted_skip['"]/);
});

// ========== 与单评共用 ==========

test('evalSayhiSingle — 仍走 evalSayhiCore（路由层对单评同样生效）', () => {
  // evalSayhiSingle 必须继续 delegate 到 evalSayhiCore，这样 1c 的路由自动作用于单评
  // （修复用户报告的"单评西语候选人却用印尼 JD"的核心 bug）
  assert.match(bg, /async function evalSayhiSingle\(candidateId\)[\s\S]*?evalSayhiCore\(\[String\(candidateId\)\]/);
});
