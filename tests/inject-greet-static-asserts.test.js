// 测试 inject.js v0.17.1.0 executeGreetThenRequestResume 静态结构
// 不真跑 DOM，只断言关键字符串/选择器/逻辑分支存在
// 跑：node --test tests/inject-greet-static-asserts.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

test('inject.js 含 executeGreetThenRequestResume 函数', () => {
  assert.match(src, /async function executeGreetThenRequestResume\(uid, greetText, dryRun\)/);
});

test('inject.js 引用聊天输入框 ID #boss-chat-editor-input', () => {
  assert.match(src, /boss-chat-editor-input/);
});

test('inject.js 用 .submit-content 限定发送按钮搜索范围', () => {
  assert.match(src, /\.submit-content/);
});

test('inject.js 用 chat-message-list .message-item 校验消息发送', () => {
  assert.match(src, /\.chat-message-list \.message-item/);
});

test('inject.js 主路径用 execCommand insertText', () => {
  assert.match(src, /execCommand\('insertText'/);
});

test('inject.js 退路用 textContent + InputEvent', () => {
  assert.match(src, /editor\.textContent = text/);
  assert.match(src, /new InputEvent\('input'/);
});

test('inject.js 检查发送按钮 disabled 状态', () => {
  assert.match(src, /_isSubmitDisabled/);
  assert.match(src, /disabled|is-disabled|btn-disabled/);
});

test('inject.js 消息发送验证带 hard floor 600ms', () => {
  assert.match(src, /setTimeout\(r, 600\)/);
});

test('inject.js 求简历确认弹窗用 dialog-scope 限定', () => {
  assert.match(src, /_findConfirmInDialogScope/);
});

test('inject.js dialog-scope 含 z-index>1000 兜底', () => {
  // 跨行，分两个断言：getComputedStyle.zIndex 读取 + z > 1000 判定
  assert.match(src, /getComputedStyle\(el\)\.zIndex/);
  assert.match(src, /z\s*>\s*1000/);
});

test('inject.js 含 dryRun 双检查点（submit 和 confirm）', () => {
  assert.match(src, /wouldClickSubmit/);
  assert.match(src, /wouldClickConfirm/);
});

test('inject.js 话术文本长度校验 >= 5', () => {
  assert.match(src, /greetText\)\.trim\(\)\.length < 5/);
});

test('inject.js 监听 execute-greet-then-resume-request 消息', () => {
  assert.match(src, /'execute-greet-then-resume-request'/);
});

test('inject.js 复用 _selectSayhiCard / _findClickableByText', () => {
  // 验证不重新发明轮子
  assert.match(src, /_selectSayhiCard\(uid, logs\)/);
  assert.match(src, /_findClickableByText\('求简历'\)/);
});

test('inject.js dryRun 时跳过最后两步真实点击', () => {
  // dryRun: true → wouldClickSubmit log，跳过 submitBtn.click()
  // dryRun: true → wouldClickConfirm log，跳过 confirmBtn.click()
  // 验证有 if (dryRun) 分支保护
  const dryRunBranches = (src.match(/if \(dryRun\)/g) || []).length;
  assert.ok(dryRunBranches >= 2, '应有至少 2 处 if (dryRun) 分支');
});
