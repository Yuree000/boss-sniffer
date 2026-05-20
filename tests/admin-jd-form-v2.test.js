// 测试 admin/admin.html + admin.js v0.12.0 JD 表单结构
// 用静态文本断言（不启动浏览器，参考 admin-model-config-ui.test.js）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('admin.html — JD 表单删除所有旧字段 id', () => {
  const html = read('admin/admin.html');
  const removedIds = ['jd-base', 'jd-edu', 'jd-language', 'jd-age-max',
                       'jd-exp', 'jd-bonus', 'jd-veto', 'jd-special', 'jd-text'];
  removedIds.forEach(function (id) {
    assert.doesNotMatch(html, new RegExp('id="' + id + '"'),
      'admin.html 不应再含 id="' + id + '"');
  });
});

test('admin.html — JD 表单含新字段 id（must-list / opt-list / jd-threshold）', () => {
  const html = read('admin/admin.html');
  assert.match(html, /id="must-list"/);
  assert.match(html, /id="opt-list"/);
  assert.match(html, /id="jd-threshold"/);
  assert.match(html, /id="btn-add-must"/);
  assert.match(html, /id="btn-add-opt"/);
  assert.match(html, /id="btn-jd-preview-form"/);
});

test('v0.25.0: admin.html — JD 列表 M/N/K 三列已隐藏（只保留 名称 / 操作）', () => {
  const html = read('admin/admin.html');
  // M/N/K 列已隐藏
  assert.doesNotMatch(html, /<th>必要 \(M\)<\/th>/);
  assert.doesNotMatch(html, /<th>可选 \(N\)<\/th>/);
  assert.doesNotMatch(html, /<th>阈值 \(K\)<\/th>/);
  // 名称 + 操作列仍在
  assert.match(html, /<th>名称<\/th>/);
  assert.match(html, /<th class="actions-col">操作<\/th>/);
});

test('admin.html — JD 表单 placeholder 提示新岗位（测试工程师 / AI CX）', () => {
  const html = read('admin/admin.html');
  assert.match(html, /placeholder="如：测试工程师/);
});

test('admin.html — prompt 预览模态底部不含 "token" 字样', () => {
  const html = read('admin/admin.html');
  // modal-hint 文本里不含 token
  const modalSection = html.match(/modal-footer[\s\S]*?<\/div>/);
  assert.ok(modalSection);
  assert.doesNotMatch(modalSection[0], /token/i);
});

test('admin.js — 含新函数 buildJdFromForm / makeConditionRow / renderConditionList', () => {
  const js = read('admin/admin.js');
  assert.match(js, /function buildJdFromForm\(/);
  assert.match(js, /function makeConditionRow\(/);
  assert.match(js, /function renderConditionList\(/);
  assert.match(js, /function collectConditions\(/);
  assert.match(js, /function openPromptModal\(/);
  assert.match(js, /function openPromptPreviewByJdId\(/);
});

test('admin.js — 删旧字段读写（base/educationMin/bonus/veto/specialRules/jdText）', () => {
  const js = read('admin/admin.js');
  // saveJDForm 不应再读 $(\'jd-base\')、$(\'jd-edu\') 等
  const saveJdSection = js.match(/async function saveJDForm[\s\S]*?^}/m);
  assert.ok(saveJdSection);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-base'\)/);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-edu'\)/);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-bonus'\)/);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-veto'\)/);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-special'\)/);
  assert.doesNotMatch(saveJdSection[0], /\$\('jd-text'\)/);
});

test('admin.js — saveJDForm 读取 mustConditions / optionalConditions / optionalThreshold', () => {
  const js = read('admin/admin.js');
  assert.match(js, /mustConditions:/);
  assert.match(js, /optionalConditions:/);
  assert.match(js, /optionalThreshold:/);
});

test('admin.js — 添加 must / opt 按钮 handler 存在', () => {
  const js = read('admin/admin.js');
  assert.match(js, /btn-add-must.*addEventListener/);
  assert.match(js, /btn-add-opt.*addEventListener/);
});

test('admin.js — 表单内 "预览 prompt" 按钮调 PromptBuilder.build', () => {
  const js = read('admin/admin.js');
  assert.match(js, /btn-jd-preview-form.*addEventListener/);
  assert.match(js, /self\.BossPromptBuilder\.build/);
});

// 用户原话"整个产品也不要出现任何 token 估算" —— 禁的是"估算/预估 token" 这一类概念，
// LLM 配置 UI 里 "Bearer token / Auth Token / API token" 是合法的鉴权术语，不在禁止列表
const FORBIDDEN_TOKEN_PATTERN = /(估算\s*token|预估\s*token|token\s*估算|token\s*预估|estimate\s*tokens?|estimat[ie]\w*\s*tokens?)/i;

test('admin.js — 不出现 token 估算文案', () => {
  const js = read('admin/admin.js');
  const lines = js.split('\n');
  lines.forEach(function (l, i) {
    if (FORBIDDEN_TOKEN_PATTERN.test(l)) {
      throw new Error('admin.js:' + (i + 1) + ' 含 token 估算文案: ' + l.trim());
    }
  });
});

test('admin.html — 不出现 token 估算文案', () => {
  const html = read('admin/admin.html');
  const lines = html.split('\n');
  lines.forEach(function (l, i) {
    if (FORBIDDEN_TOKEN_PATTERN.test(l)) {
      throw new Error('admin.html:' + (i + 1) + ' 含 token 估算文案: ' + l.trim());
    }
  });
});
