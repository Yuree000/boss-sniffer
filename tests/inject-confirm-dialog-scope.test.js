// 测试：求简历确认弹窗的「确定」按钮搜索必须被限制在 dialog 容器内
// 不能裸 walker scan 整个 document（容易误选其他位置的「确定」）
// 跑：node --test tests/inject-confirm-dialog-scope.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

test('_findConfirmInDialogScope 存在', () => {
  assert.match(src, /function _findConfirmInDialogScope\(dialogTexts\)/);
});

test('_findConfirmInDialogScope 使用 .boss-dialog / [role=dialog] / .modal / .dialog 多重选择器', () => {
  // 提取该函数体
  const m = src.match(/function _findConfirmInDialogScope\([\s\S]*?\n  \}/);
  assert.ok(m, '应能定位函数体');
  const body = m[0];
  assert.match(body, /\.boss-dialog/);
  assert.match(body, /\[role="dialog"\]/);
  assert.match(body, /\.modal|\.dialog/);
});

test('_findConfirmInDialogScope 用 z-index>1000 兜底', () => {
  const m = src.match(/function _findConfirmInDialogScope\([\s\S]*?\n  \}/);
  assert.ok(m, '应能定位 _findConfirmInDialogScope 函数体');
  // 函数体内必须含 z > 1000 的判定
  assert.match(m[0], /z\s*>\s*1000/);
});

// v0.17.1.3：策略改为「dialog-scope 优先 + 全文档 fallback」
// 完整 dialog-scope 限定在 v0.17.1.0-v0.17.1.2 实测有 bug（求简历确定点不上），
// v0.14 全文档扫『确定』叶子上溯 8 层找 dialogText 实测可靠，作为 fallback
test('_findConfirmInDialogScope 两步逻辑：dialog-scope 优先 + 全文档 fallback', () => {
  const m = src.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  const body = m[0];
  // 步 1：dialog-scope 优先
  assert.match(body, /createTreeWalker\(dlg/);
  // 步 2：全文档 fallback（v0.14 上溯祖先法）
  assert.match(body, /createTreeWalker\(document,/);
  assert.match(body, /for \(let d = 0; d < 8/);
});

test('executeGreetThenRequestResume 用 _findConfirmInDialogScope 找确认按钮', () => {
  // 验证主流程使用的是限定版而不是裸的全文本 walker
  // v0.17.1.4：调用方传文案数组（BOSS 新弹窗用「索取简历」，旧用「请求简历」）
  const m = src.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m, '应能定位 executeGreetThenRequestResume 函数体');
  assert.match(m[0], /_findConfirmInDialogScope\(\[\s*'请求简历'\s*,\s*'索取简历'\s*\]\)/);
});
