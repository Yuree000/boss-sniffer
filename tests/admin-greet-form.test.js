// 测试 admin v0.17.1.0 话术模板管理 + auto-action toggle 静态结构
// 跑：node --test tests/admin-greet-form.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin/admin.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');

test('admin.html 含话术模板管理 section', () => {
  assert.match(html, /话术模板管理/);
});

test('admin.html 含 greet-list-body 表格 + greet-form 编辑表单', () => {
  assert.match(html, /id="greet-list-body"/);
  assert.match(html, /id="greet-form"/);
  assert.match(html, /id="greet-name"/);
  assert.match(html, /id="greet-text"/);
  assert.match(html, /id="greet-char-count"/);
});

test('admin.html 含话术 CRUD 按钮', () => {
  assert.match(html, /id="btn-greet-new"/);
  assert.match(html, /id="btn-greet-save"/);
  assert.match(html, /id="btn-greet-cancel"/);
});

test('admin.html 含 auto-action 三个控件', () => {
  assert.match(html, /id="auto-action-enabled"/);
  assert.match(html, /id="auto-action-dry-run"/);
  assert.match(html, /id="auto-action-cooldown-min"/);
  assert.match(html, /id="auto-action-cooldown-max"/);
});

test('admin.html 加载 greet-templates.js', () => {
  assert.match(html, /<script src="\.\.\/lib\/greet-templates\.js"><\/script>/);
});

test('admin.js DEFAULTS 含 autoAction 块', () => {
  assert.match(js, /autoAction:\s*\{/);
  assert.match(js, /enabledBatchEval:\s*false/);
  assert.match(js, /actionCooldownMinMs:\s*2000/);
});

test('admin.js 含 loadGreetList / openGreetFormForNew / openGreetFormForEdit / saveGreetForm', () => {
  assert.match(js, /async function loadGreetList\(\)/);
  assert.match(js, /function openGreetFormForNew\(\)/);
  assert.match(js, /async function openGreetFormForEdit\(greetId\)/);
  assert.match(js, /async function saveGreetForm\(\)/);
});

test('admin.js 含 collectAutoActionPatch 函数', () => {
  assert.match(js, /function collectAutoActionPatch\(\)/);
});

test('admin.js 保存时发送 section autoAction', () => {
  assert.match(js, /section: 'autoAction', patch: autoActionPatch/);
});

test('admin.js 重置 button 重置 autoAction', () => {
  // 在 btn-reset handler 内
  assert.match(js, /\$\('auto-action-enabled'\)\.checked = DEFAULTS\.autoAction/);
  assert.match(js, /\$\('auto-action-dry-run'\)\.checked = DEFAULTS\.autoAction/);
});

test('admin.js loadAll 后调 loadGreetList()', () => {
  assert.match(js, /loadAll\(\);\s*\nloadJDList\(\);\s*\nloadGreetList\(\);/);
});

test('admin.js saveGreetForm 处理错误显示', () => {
  const m = js.match(/async function saveGreetForm\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // 显示错误时 className 改 err
  assert.match(m[0], /greet-form-status[\s\S]*?err/);
  assert.match(m[0], /BossGreetTemplates\.saveTemplate/);
});

test('admin.js 含字符计数提示 updateGreetCharCount', () => {
  assert.match(js, /function updateGreetCharCount\(\)/);
  // 不足 5 字符红色提示
  assert.match(js, /len < 5/);
});
