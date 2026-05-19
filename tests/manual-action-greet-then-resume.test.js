// 测试 v0.17.1.1：手动 🎯 求简历按钮升级走话术+求简历新链路
// 跑：node --test tests/manual-action-greet-then-resume.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const sidepanelJs = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');

// === background.js executeSayhiActionForCandidate 改造 ===

function getExecuteSayhiActionForCandidateBody() {
  const m = bg.match(/async function executeSayhiActionForCandidate\(candidateId\)[\s\S]*?\n\}\n/);
  if (!m) throw new Error('未找到 executeSayhiActionForCandidate 函数');
  return m[0];
}

test('executeSayhiActionForCandidate：decision=符合 走 triggerGreetThenResume（不是旧 triggerSayhiAction）', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  // 符合分支必须调 triggerGreetThenResume
  assert.match(body, /action === 'request-resume'[\s\S]*?triggerGreetThenResume\(cid/);
});

test('executeSayhiActionForCandidate：符合分支取 getCurrentGreetTemplate', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  assert.match(body, /action === 'request-resume'[\s\S]*?getCurrentGreetTemplate\(\)/);
});

test('executeSayhiActionForCandidate：没选话术模板时返回错误', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  // 检查 greet 为空或 text 空时早 return
  assert.match(body, /!greet[\s\S]*?greet\.text[\s\S]*?return/);
  assert.match(body, /请先选择当前话术模板/);
});

test('executeSayhiActionForCandidate：手动调用 dryRun 写死 false（忽略 admin 开关）', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  // 找 triggerGreetThenResume 调用，第三个参数应该是 false
  assert.match(body, /triggerGreetThenResume\(cid, greet\.text, false\)/);
});

test('executeSayhiActionForCandidate：成功后 recordSayhiActionResult 写 greet-then-resume', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  assert.match(body, /recordSayhiActionResult\(cid, 'greet-then-resume'/);
});

test('executeSayhiActionForCandidate：pass 决策仍走 v0.14 triggerSayhiAction 旧路径', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  // 'mark-unsuitable' 分支不动
  assert.match(body, /triggerSayhiAction\(cid, action\)/);
});

test('executeSayhiActionForCandidate：保留 sayhiEvalRun.running 互斥', () => {
  const body = getExecuteSayhiActionForCandidateBody();
  assert.match(body, /sayhiEvalRun\s*&&\s*sayhiEvalRun\.running/);
  assert.match(body, /评估循环进行中/);
});

// === sidepanel.js makeActionButton 改造 ===

test('sidepanel.js makeActionButton：符合 决策按钮文案改为「话术+求简历」', () => {
  // 标签字符串
  assert.match(sidepanelJs, /label\s*=\s*'🎯 话术\+求简历'/);
  // 不应再用旧文案
  assert.doesNotMatch(sidepanelJs, /label\s*=\s*'🎯 求简历'/);
});

test('sidepanel.js makeActionButton：pass 决策按钮保持「标不合适」不变', () => {
  assert.match(sidepanelJs, /label\s*=\s*'🎯 标不合适'/);
});

test('sidepanel.js makeActionButton：title 说明会发当前话术', () => {
  // title 文案含「发送当前话术」
  assert.match(sidepanelJs, /发送当前话术[\s\S]*?求简历/);
});

test('sidepanel.js makeActionButton：confirm 文案告知会发话术', () => {
  // confirm 文案含「发送当前话术」
  assert.match(sidepanelJs, /发送当前话术 → 求简历 → 确定/);
});

test('sidepanel.js makeActionButton：title 说明忽略 admin 试跑模式', () => {
  // 让 HR 知道手动点是真发
  assert.match(sidepanelJs, /忽略 admin 试跑模式/);
});

test('sidepanel.js lastAction 徽章：含 greet-then-resume 分支但去掉了「自动」字样', () => {
  // 现在手动也走这条，不应该再叫"自动"
  assert.match(sidepanelJs, /actionLabel = '🎯 话术\+求简历'/);
  assert.doesNotMatch(sidepanelJs, /actionLabel = '🎯 自动话术\+求简历'/);
});

test('sidepanel.js partialHint 按 action 区分（话术+求简历 vs 标不合适）', () => {
  // partial 含义不同：'request-resume' = 部分步骤失败；'mark-unsuitable' = 卡片未消失
  assert.match(sidepanelJs, /action === 'request-resume'/);
  assert.match(sidepanelJs, /部分步骤失败/);
});
