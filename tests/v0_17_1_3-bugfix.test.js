// v0.17.1.3 三处 bug 修复 — 静态断言
// 跑：node --test tests/v0_17_1_3-bugfix.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin/admin.html'), 'utf8');
const sidepanelJs = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
const sidepanelHtml = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');

// ============ 改动 1：单评/批量自动操作解耦 ============

test('background.js 旧 key enabledSingleEval 已删除（语义已变）', () => {
  // 应用配置定义 + 评估循环 + 单评 / 批量函数 — 都不应再用 enabledSingleEval
  assert.doesNotMatch(bg, /enabledSingleEval/);
});

test('background.js appConfig.autoAction 用 enabledBatchEval', () => {
  const m = bg.match(/let appConfig = \{[\s\S]*?\n\};/);
  assert.ok(m);
  assert.match(m[0], /enabledBatchEval:\s*false/);
});

test('background.js autoActionOn 判断用 enabledBatchEval', () => {
  // evalSayhiCore 函数体内
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  assert.match(m[0], /enabledBatchEval/);
  assert.doesNotMatch(m[0], /enabledSingleEval/);
});

test('admin.js DEFAULTS.autoAction.enabledBatchEval 替代 enabledSingleEval', () => {
  assert.doesNotMatch(adminJs, /enabledSingleEval/);
  assert.match(adminJs, /enabledBatchEval:\s*false/);
});

// v0.24.2：admin 删了 enabledBatchEval / dryRun 两个 checkbox + 配套 banner 文案
//   迁移到 sidepanel 沟通页 control-bar；旧 banner 文案已撤
test('v0.24.2: admin.html 不再含旧 banner「仅批量评估自动 / 单评始终手动」文案', () => {
  assert.doesNotMatch(adminHtml, /仅批量评估自动/);
});

test('v0.24.2: admin.html 不再含「启用批量评估自动求简历」label', () => {
  assert.doesNotMatch(adminHtml, /启用批量评估自动求简历/);
  // 旧版本残留也不应在
  assert.doesNotMatch(adminHtml, /启用单评自动求简历/);
});

test('sidepanel.js refreshAutoActionBadge 检查 enabledBatchEval', () => {
  assert.match(sidepanelJs, /enabledBatchEval/);
});

test('sidepanel.html 徽章文案改为「批量自动 ON」', () => {
  assert.match(sidepanelHtml, /批量自动 ON|批量评估自动求简历/);
});

// ============ 改动 2：求简历确定按钮 fallback ============

test('_findConfirmInDialogScope 含 v0.14 fallback：document.createTreeWalker(document, ...)', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  // 步 2 fallback 是全 document 扫
  assert.match(m[0], /createTreeWalker\(document,/);
  // 上溯祖先 8 层
  assert.match(m[0], /for \(let d = 0; d < 8/);
});

test('_findConfirmInDialogScope 两步逻辑都存在（dialog-scope 优先 + 全文 fallback）', () => {
  const m = inject.match(/function _findConfirmInDialogScope\(dialogTexts\)[\s\S]*?return null;\s*\}/);
  assert.ok(m);
  // dialog-scope 步：用 dlg 限定
  assert.match(m[0], /createTreeWalker\(dlg,/);
  // fallback 步：用 document
  assert.match(m[0], /createTreeWalker\(document,/);
});

test('executeGreetThenRequestResume 求简历弹窗等待 6s（原来 4s）', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 弹窗等待 6000ms（不限定 _findConfirmInDialogScope 的入参形态——v0.17.1.4 改为数组）
  assert.match(m[0], /_findConfirmInDialogScope\([\s\S]*?\}, 6000\)/);
});

// ============ 改动 3：拟人冷却 ============

test('executeGreetThenRequestResume 发完话术后加 1-2s 拟人冷却', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 1000-2000 抖动
  assert.match(m[0], /humanCooldownBeforeRequest/);
  assert.match(m[0], /1000 \+ Math\.random\(\) \* 1000/);
});

test('humanCooldownBeforeRequest log 含 cooldownMs 字段', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  assert.match(m[0], /humanCooldownBeforeRequest[\s\S]*?cooldownMs/);
});

test('humanCooldownBeforeRequest 仅在 dryRun=false 时跑（dryRun 时跳过 submit.click，不需要冷却）', () => {
  const m = inject.match(/async function executeGreetThenRequestResume\([\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 冷却代码应在 else 分支里（即 dryRun=false 走 submit.click 那条）
  // 大致判断：humanCooldownBeforeRequest 出现在 _waitForMessageSent 成功后
  const idxCooldown = m[0].indexOf('humanCooldownBeforeRequest');
  const idxWaitSent = m[0].indexOf('waitMessageSent');
  assert.ok(idxCooldown > idxWaitSent, '拟人冷却应该在 waitMessageSent 之后');
});
