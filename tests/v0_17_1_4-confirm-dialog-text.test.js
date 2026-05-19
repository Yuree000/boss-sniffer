// v0.17.1.4：求简历弹窗文案改名 bug 修复 — 静态断言
// BOSS 把弹窗标题从「请求简历」改成「索取简历」（5/18 用户截图证实）
// 修复：_findConfirmInDialogScope 接收多文案数组，等弹窗消失也检测两个变体
// 跑：node --test tests/v0_17_1_4-confirm-dialog-text.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

// === _findConfirmInDialogScope 多文案数组 ===

test('_findConfirmInDialogScope 接收多文案数组（dialogTexts）', () => {
  // 函数签名改成 dialogTexts（复数）
  assert.match(inject, /function _findConfirmInDialogScope\(dialogTexts\)/);
});

test('_findConfirmInDialogScope 字符串入参自动包成数组（向后兼容）', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  assert.match(m[0], /typeof dialogTexts === 'string'/);
  assert.match(m[0], /dialogTexts = \[dialogTexts\]/);
});

test('_findConfirmInDialogScope 任一 text 命中即返回（ancestorMatchesAny）', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  // 应该有 ancestorMatchesAny 或 containerMatchesAny 之类的辅助函数
  assert.match(m[0], /ancestorMatchesAny|containerMatchesAny/);
});

test('_findConfirmInDialogScope 加了 boss-message-box / boss-confirm dialog 容器兜底', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  assert.match(m[0], /\.boss-message-box/);
  assert.match(m[0], /\.boss-confirm/);
});

test('_findConfirmInDialogScope fallback 仍保留：全 document walker + 上溯 8 层', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  assert.match(m[0], /createTreeWalker\(document,/);
  assert.match(m[0], /for \(let d = 0; d < 8/);
});

// === executeGreetThenRequestResume 调用方传两文案 ===

test('executeGreetThenRequestResume 调用 _findConfirmInDialogScope 时传入两个文案变体', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 应该传 ['请求简历', '索取简历']
  assert.match(m[0], /_findConfirmInDialogScope\(\[\s*'请求简历'\s*,\s*'索取简历'\s*\]\)/);
});

test('executeGreetThenRequestResume 弹窗超时 log 文案更新（提到两个变体）', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  // log 应该说明搜索的两个文案，便于调试
  assert.match(m[0], /请求简历[\s\S]*?索取简历|索取简历[\s\S]*?请求简历/);
});

// === 等弹窗消失也检测两个变体 ===

test('等弹窗消失检测「确定向牛人请求简历」和「确定向牛人索取简历」两个变体', () => {
  // 在 executeGreetThenRequestResume 函数体内
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  assert.match(m[0], /确定向牛人请求简历/);
  assert.match(m[0], /确定向牛人索取简历/);
});
