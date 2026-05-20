// 测试 admin v0.17.1.0 话术模板管理 + auto-action toggle 静态结构
// 跑：node --test tests/admin-greet-form.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin/admin.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');

// v0.25.2：admin 话术模板管理 section 整段删除（话术内嵌 JD 模板内）
test('v0.25.2: admin.html 不再含话术模板管理 section', () => {
  assert.doesNotMatch(html, /<h2>话术模板管理<\/h2>/);
  assert.doesNotMatch(html, /id="greet-list-body"/);
  assert.doesNotMatch(html, /id="btn-greet-new"/);
});

test('v0.25.2: admin.html JD 表单含「话术模板」内嵌区（jd-greet-templates-list + 添加按钮）', () => {
  assert.match(html, /id="jd-greet-templates-list"/);
  assert.match(html, /id="btn-add-jd-greet"/);
});

// v0.24.2：admin 删 enabledBatchEval / dryRun 两个 checkbox
//   迁移：前者由 sidepanel 沟通页 control-bar 现场决定；后者永久关闭无 UI
//   admin 只保留 cooldown 参数（链路自有冷却，不归 sidepanel 管）
test('v0.24.2: admin.html 不再含 #auto-action-enabled / #auto-action-dry-run', () => {
  assert.doesNotMatch(html, /id="auto-action-enabled"/);
  assert.doesNotMatch(html, /id="auto-action-dry-run"/);
});

test('v0.24.2: admin.html 仍保留 auto-action cooldown 两个 input', () => {
  assert.match(html, /id="auto-action-cooldown-min"/);
  assert.match(html, /id="auto-action-cooldown-max"/);
});

test('v0.24.2: admin.html 含迁移说明文字（指引 HR 去 sidepanel 沟通页）', () => {
  assert.match(html, /已迁移到.*侧边栏.*沟通页/);
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

test('v0.24.2: admin.js 重置 button 不再重置 enabledBatchEval / dryRun', () => {
  // 这两个 element 不存在，重置时 $().checked 会报错——必须删除
  assert.doesNotMatch(js, /\$\('auto-action-enabled'\)\.checked = DEFAULTS\.autoAction/);
  assert.doesNotMatch(js, /\$\('auto-action-dry-run'\)\.checked = DEFAULTS\.autoAction/);
  // 但 cooldown 重置仍在
  assert.match(js, /\$\('auto-action-cooldown-min'\)\.value = DEFAULTS\.autoAction/);
});

test('v0.24.2: admin.js collectAutoActionPatch 不读两个 checkbox + 强制 dryRun=false', () => {
  const m = js.match(/function collectAutoActionPatch\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  // 不再读 form
  assert.doesNotMatch(m[0], /\$\('auto-action-enabled'\)/);
  assert.doesNotMatch(m[0], /\$\('auto-action-dry-run'\)/);
  // dryRun 显式设 false
  assert.match(m[0], /dryRun:\s*false/);
});

test('v0.24.2: admin.js renderConfig 不再设 enabledBatchEval / dryRun checkbox', () => {
  assert.doesNotMatch(js, /\$\('auto-action-enabled'\)\.checked = !!autoAction/);
  assert.doesNotMatch(js, /\$\('auto-action-dry-run'\)\.checked = !!autoAction/);
});

test('v0.25.2: admin.js loadAll 后不再调 loadGreetList()（话术管理 section 已删）', () => {
  assert.match(js, /loadAll\(\);\s*\nloadJDList\(\);/);
  assert.doesNotMatch(js, /loadAll\(\);\s*\nloadJDList\(\);\s*\nloadGreetList\(\);/);
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
