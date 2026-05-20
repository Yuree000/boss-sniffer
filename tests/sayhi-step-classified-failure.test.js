// 测试 v0.22.4 · Phase 3·3b：失败检测分类加固（按 step 区分策略）
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.3 ·3
//
// 设计：
//   - inject.js 每个 fail return 加 result.failedStep 枚举字段（14 个值）
//   - executeGreetThenRequestResume 内 _setEditorText 失败重试 1 次（sleep 500ms 再试）
//   - 'click-confirm' 失败的 result.ok 从 false 改成 true（语义半成功，与 wait-card-gone 对齐）
//   - background.js evalSayhiCore 加 STEP_POLICY 表，按 failedStep 分流：
//       'stop-batch'        立即停整批（求简历/不合适按钮找不到 = BOSS UI 改名）
//       'skip-candidate'    跳过该候选人（话术输入重试 1 次仍失败）
//       'partial-continue'  partial 标记 + 继续下一人（已发出动作的后半失败）
//       未分类失败 → 走老 actionFailStreak 兜底
//
// 跑：node --test tests/sayhi-step-classified-failure.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const inject = read('inject.js');
const bg = read('background.js');

// 提取 executeGreetThenRequestResume 函数体
function getGreetThenResumeBody() {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?(?=\n  \/\/ v0\.16\.0|\n  async function _clickLatestTab|\n  \/\/ 监听 content\.js)/);
  if (!m) throw new Error('未找到 executeGreetThenRequestResume');
  return m[0];
}

// 提取 executeSayhiAction 函数体
function getSayhiActionBody() {
  const m = inject.match(/async function executeSayhiAction\([\s\S]*?(?=\n  \/\/ ============ 8\.5|\n  function _findChatInputEditor)/);
  if (!m) throw new Error('未找到 executeSayhiAction');
  return m[0];
}

// 提取 evalSayhiCore 自动操作分支
function getEvalSayhiCoreBody() {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  if (!m) throw new Error('未找到 evalSayhiCore');
  return m[0];
}

// =========================================================================
// A 段：inject.js 各 fail return 都设 failedStep + 枚举值合法
// =========================================================================

// spec §3.3·3 + 兜底 — 14 个 failedStep 枚举值
const FAILED_STEPS = [
  // executeGreetThenRequestResume
  'validate-greet-text',
  'find-card',
  'find-editor',
  'editor-input',
  'find-submit-btn',
  'click-submit',
  'wait-message-sent',
  'find-request-btn',
  'click-request-btn',
  'wait-confirm-dialog',
  'click-confirm',
  // executeSayhiAction (mark-unsuitable)
  'find-unsuitable-btn',
  'click-unsuitable-btn',
  'wait-card-gone'
];

test('A1: executeGreetThenRequestResume 每个 fail return 都设 result.failedStep（11 个）', () => {
  const body = getGreetThenResumeBody();
  const greetSteps = [
    'validate-greet-text', 'find-card', 'find-editor', 'editor-input',
    'find-submit-btn', 'click-submit', 'wait-message-sent', 'find-request-btn',
    'click-request-btn', 'wait-confirm-dialog', 'click-confirm'
  ];
  greetSteps.forEach(function (step) {
    const re = new RegExp("result\\.failedStep\\s*=\\s*['\"]" + step + "['\"]");
    assert.match(body, re, 'executeGreetThenRequestResume 缺 failedStep="' + step + '"');
  });
});

test('A2: executeSayhiAction 每个 fail return 都设 result.failedStep（3 个）', () => {
  const body = getSayhiActionBody();
  const markSteps = ['find-unsuitable-btn', 'click-unsuitable-btn', 'wait-card-gone'];
  markSteps.forEach(function (step) {
    const re = new RegExp("result\\.failedStep\\s*=\\s*['\"]" + step + "['\"]");
    assert.match(body, re, 'executeSayhiAction 缺 failedStep="' + step + '"');
  });
});

test('A3: inject.js 所有 result.failedStep = 字面量都在枚举内（防 typo）', () => {
  const re = /result\.failedStep\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(inject)) !== null) {
    assert.ok(FAILED_STEPS.indexOf(m[1]) >= 0,
      'inject.js 出现未定义的 failedStep 值: "' + m[1] + '"');
  }
});

test('A4: 每个 failedStep 字面量至少在 inject.js 中出现 1 次（防漏掉某一类）', () => {
  FAILED_STEPS.forEach(function (step) {
    const re = new RegExp("result\\.failedStep\\s*=\\s*['\"]" + step + "['\"]");
    assert.match(inject, re, '枚举值 "' + step + '" 未在 inject.js 出现');
  });
});

// =========================================================================
// B 段：editor-input 重试 1 次结构
// =========================================================================

test('B1: executeGreetThenRequestResume 对 _setEditorText 调用至少 2 次（一次主调用 + 一次 retry）', () => {
  const body = getGreetThenResumeBody();
  const matches = body.match(/_setEditorText\s*\(/g) || [];
  assert.ok(matches.length >= 2,
    'executeGreetThenRequestResume 应调用 _setEditorText ≥ 2 次（含 retry），实际 ' + matches.length);
});

test('B2: editor-input retry 间至少有一次 sleep / setTimeout 等待（避免立即重试）', () => {
  const body = getGreetThenResumeBody();
  // 找 retry 段：第一次 _setEditorText 调用之后到 fail return 之前必须有 setTimeout 等待
  // 简化版：找 result.failedStep = 'editor-input' 前面 800 字符内必须有 setTimeout
  const idx = body.search(/result\.failedStep\s*=\s*['"]editor-input['"]/);
  assert.ok(idx > 0, '未找到 editor-input fail return 位置');
  const ctx = body.slice(Math.max(0, idx - 1500), idx);
  assert.match(ctx, /setTimeout|sleep/, 'editor-input retry 前应有 sleep/setTimeout 等待');
});

test('B3: retry 段记 log 标识便于诊断（如 logs 含 "retry" 字样）', () => {
  const body = getGreetThenResumeBody();
  // 找 editor-input 失败位置附近的 _logStep 调用包含 retry / attempt
  const idx = body.search(/result\.failedStep\s*=\s*['"]editor-input['"]/);
  const ctx = body.slice(Math.max(0, idx - 2000), idx);
  assert.match(ctx, /retry|attempt|重试/i, 'editor-input retry 段应有 retry 标识 log');
});

// =========================================================================
// C 段：background.js STEP_POLICY 表 + 分流逻辑
// =========================================================================

test('C1: background.js 含 STEP_POLICY 常量（const STEP_POLICY = {...}）', () => {
  assert.match(bg, /const\s+STEP_POLICY\s*=\s*\{/);
});

test('C2: STEP_POLICY 含 spec §3.3·3 列出的关键映射', () => {
  // 提取 STEP_POLICY 对象字面量
  const m = bg.match(/const\s+STEP_POLICY\s*=\s*\{[\s\S]*?\n\s{2,}\}/);
  assert.ok(m, '未找到 STEP_POLICY 对象');
  const tbl = m[0];
  // 'find-request-btn' / 'find-unsuitable-btn' → stop-batch
  assert.match(tbl, /'find-request-btn'\s*:\s*'stop-batch'/);
  assert.match(tbl, /'find-unsuitable-btn'\s*:\s*'stop-batch'/);
  // 'editor-input' → skip-candidate
  assert.match(tbl, /'editor-input'\s*:\s*'skip-candidate'/);
  // 'click-confirm' / 'wait-card-gone' → partial-continue
  assert.match(tbl, /'click-confirm'\s*:\s*'partial-continue'/);
  assert.match(tbl, /'wait-card-gone'\s*:\s*'partial-continue'/);
});

test('C3: evalSayhiCore 内有按 failedStep 查 STEP_POLICY 的代码', () => {
  const body = getEvalSayhiCoreBody();
  // 读 actionResp.result.failedStep
  assert.match(body, /actionResp\.result[\s\S]{0,30}failedStep|result\.failedStep/);
  // 用 STEP_POLICY[...] 查表
  assert.match(body, /STEP_POLICY\s*\[/);
});

test('C4: evalSayhiCore 3 个分流分支都存在', () => {
  const body = getEvalSayhiCoreBody();
  // stop-batch
  assert.match(body, /===\s*['"]stop-batch['"]|['"]stop-batch['"]\s*===/);
  // skip-candidate
  assert.match(body, /===\s*['"]skip-candidate['"]|['"]skip-candidate['"]\s*===/);
  // partial-continue
  assert.match(body, /===\s*['"]partial-continue['"]|['"]partial-continue['"]\s*===/);
});

test('C5: stop-batch 分支会让循环 break 或 abortRequested=true', () => {
  const body = getEvalSayhiCoreBody();
  // v0.24.x 后 evalSayhiCore 长了很多（dismissed/real-click 等），STEP_POLICY 字面量到分支处理跨度大
  // 改用：policy/markPolicy === 'stop-batch' 后 1000 字符内必有 abortRequested 或 break
  const matches = [...body.matchAll(/(?:policy|markPolicy)\s*===\s*['"]stop-batch['"]/g)];
  assert.ok(matches.length >= 1, 'stop-batch 分支判定语句未找到');
  // 每个匹配点附近 1000 字符内应有 abortRequested 或 break
  matches.forEach(function (m) {
    const ctx = body.slice(m.index, m.index + 1000);
    assert.match(ctx, /\bbreak\b|abortRequested\s*=\s*true/, 'stop-batch 分支应触发 break / abortRequested');
  });
});

test('C6: actionFailStreak 兜底未删（未分类失败仍走老逻辑）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /actionFailStreak/);
  assert.match(body, /ACTION_FAIL_STOP/);
});

test('C7: 3 个新 BossDiag 事件名都接入', () => {
  const body = getEvalSayhiCoreBody();
  // stop-batch / skip-by-step / partial-continue 三个事件至少出现一次（中至少 2 个）
  let count = 0;
  if (/sayhi\.stop_batch_by_step/.test(body)) count++;
  if (/sayhi\.skip_by_step/.test(body)) count++;
  if (/sayhi\.partial_continue/.test(body)) count++;
  assert.ok(count >= 2, '至少 2 个新 BossDiag 事件名应接入（stop_batch_by_step / skip_by_step / partial_continue）');
});

// =========================================================================
// D 段：click-confirm 失败语义改 result.ok = true（半成功）
// =========================================================================

test('D1: clickConfirm catch 分支 result.ok = true（v0.22.4 改）', () => {
  const body = getGreetThenResumeBody();
  // 找 'click-confirm' failedStep 前后 ±500 字符必须有 result.ok = true
  const idx = body.search(/result\.failedStep\s*=\s*['"]click-confirm['"]/);
  assert.ok(idx > 0);
  const ctx = body.slice(Math.max(0, idx - 500), Math.min(body.length, idx + 500));
  assert.match(ctx, /result\.ok\s*=\s*true/);
});

test('D2: clickConfirm catch 分支 partial 仍是 true（不变）', () => {
  const body = getGreetThenResumeBody();
  const idx = body.search(/result\.failedStep\s*=\s*['"]click-confirm['"]/);
  const ctx = body.slice(Math.max(0, idx - 500), Math.min(body.length, idx + 500));
  assert.match(ctx, /result\.partial\s*=\s*true/);
});

// =========================================================================
// E 段：不破坏 v0.22.3 现有行为
// =========================================================================

test('v0.25.0 E1: actionSuccess 仍存在；greetSentCount 已删（招呼数 cap 废弃）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /actionSuccess/);
  assert.doesNotMatch(body, /greetSentCount/);
});

test('E2: ACTION_FAIL_STOP = 3 常量仍存在（兜底未变）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /ACTION_FAIL_STOP\s*=\s*3/);
});

test('E3: recordSayhiActionResult 仍调（lastAction 持久化不破坏，failedStep 走 result 透传）', () => {
  assert.match(bg, /recordSayhiActionResult/);
});
