const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('admin large model section is list-first with drawer and tutorial entry', () => {
  const html = read('admin/admin.html');

  assert.match(html, /<h2>大模型配置<\/h2>/);
  assert.doesNotMatch(html, /<h2>LLM 配置<\/h2>/);
  assert.match(html, /id="current-llm-summary"/);
  assert.match(html, /id="btn-llm-new"[\s\S]*新增大模型/);
  assert.match(html, /id="btn-llm-help"[\s\S]*使用教程/);
  assert.match(html, /id="llm-drawer"[^>]*class="side-drawer hidden"/);
  assert.match(html, /id="llm-drawer-title"/);
  assert.match(html, /id="llm-tutorial-modal"/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /通义千问/);
  assert.match(html, /Kimi/);
  assert.match(html, /Claude/);
});

test('admin script opens model editor in drawer instead of showing form on load', () => {
  const js = read('admin/admin.js');

  assert.match(js, /function openLlmDrawerForNew\(/);
  assert.match(js, /function openLlmDrawerForEdit\(/);
  assert.match(js, /function closeLlmDrawer\(/);
  assert.match(js, /function openLlmTutorial\(/);
  assert.doesNotMatch(js, /if \(cur\) openLlmFormForEdit\(cur\.id\);[\s\S]*else openLlmFormForNew\(\);/);
});
