// 测试 v0.17.1.0 evalSayhiCore 已退出 pipeline 改为串行
// 跑：node --test tests/eval-sayhi-serial.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// 提取 evalSayhiCore 函数体
function getEvalSayhiCoreBody() {
  // 匹配从 "async function evalSayhiCore" 到 "async function evalSayhiBatch" 之前
  const m = src.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  if (!m) throw new Error('未找到 evalSayhiCore 函数定义');
  return m[0];
}

test('background.js 全局已删除 createLlmSemaphore 函数定义', () => {
  // 不应再定义 function createLlmSemaphore
  assert.doesNotMatch(src, /^function createLlmSemaphore/m);
});

test('evalSayhiCore 函数体内不再调用 createLlmSemaphore', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /createLlmSemaphore/);
});

test('evalSayhiCore 函数体内不再有 fireLlm 异步派发', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /fireLlm/);
});

test('evalSayhiCore 函数体内不再用 Promise.all(llmPromises)', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /Promise\.all\(llmPromises\)/);
  assert.doesNotMatch(body, /llmPromises/);
});

test('evalSayhiCore 函数体内 await BossJudge.judgeCandidate（同步等 LLM）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /await self\.BossJudge\.judgeCandidate/);
});

test('evalSayhiCore 含 executeAction 分支判断', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /executeAction/);
  assert.match(body, /autoActionOn/);
});

test('evalSayhiCore 含幂等保护：lastAction.action === greet-then-resume && ok', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /lastAction/);
  assert.match(body, /greet-then-resume/);
  assert.match(body, /already-greeted/);
});

test('evalSayhiCore 含 ACTION_FAIL_STOP 失败连续 3 次自动停', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /ACTION_FAIL_STOP\s*=\s*3/);
});

test('evalSayhiCore 冷却分支：autoActionOn 用 2-4s actionCooldown，否则用 sayHiDom 5-8s', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /actCooldownMin/);
  assert.match(body, /actCooldownMax/);
  // executeAction=true 用 act*；executeAction=false 用 dom*
  assert.match(body, /autoActionOn \?/);
});

test('evalSayhiCore 用 triggerGreetThenResume 触发自动操作', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /triggerGreetThenResume\(c\.candidateId/);
});

test('evalSayhiCore 操作后 recordSayhiActionResult 写回 lastAction', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /recordSayhiActionResult\(c\.candidateId, 'greet-then-resume'/);
});

test('triggerGreetThenResume 函数定义存在', () => {
  assert.match(src, /async function triggerGreetThenResume\(candidateId, greetText, dryRun\)/);
});

test('triggerGreetThenResume 用 EXECUTE_GREET_THEN_RESUME 类型转发', () => {
  const m = src.match(/async function triggerGreetThenResume\([\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /type: 'EXECUTE_GREET_THEN_RESUME'/);
  assert.match(m[0], /greetText: String\(greetText/);
  assert.match(m[0], /dryRun: !!dryRun/);
});

test('getCurrentGreetTemplate 函数定义存在', () => {
  assert.match(src, /async function getCurrentGreetTemplate\(\)/);
});

test('getCurrentGreetTemplate 用 BossGreetTemplates 模块', () => {
  const m = src.match(/async function getCurrentGreetTemplate\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /self\.BossGreetTemplates/);
  assert.match(m[0], /ensureSeeded/);
  assert.match(m[0], /getCurrentGreetId/);
});
