// 测试 v0.17.1.2：inject.js 扫「在线简历」弹窗 iframe → resumeFullText 喂 LLM
// 跑：node --test tests/inject-online-resume-iframe.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');
const extractor = fs.readFileSync(path.join(ROOT, 'lib/extractor.js'), 'utf8');
const judge = fs.readFileSync(path.join(ROOT, 'lib/judge.js'), 'utf8');

// === inject.js 新增 helpers ===

test('inject.js 含 _findOnlineResumeButton helper', () => {
  assert.match(inject, /function _findOnlineResumeButton\(\)/);
});

test('inject.js 「在线简历」按钮搜索限定在 detailRoot 内（避免误点）', () => {
  // 搜索 scope 限定到 .base-info-single-container 而不是 document.body
  const m = inject.match(/function _findOnlineResumeButton\(\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /\.base-info-single-container/);
});

test('inject.js 含 _waitForResumeIframe helper（POC A10 验证的弹窗结构）', () => {
  assert.match(inject, /function _waitForResumeIframe\(timeoutMs\)/);
});

test('inject.js 弹窗等待用 .boss-dialog.resume-container（POC A10 验证）', () => {
  const m = inject.match(/function _waitForResumeIframe\(timeoutMs\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /\.boss-dialog\.resume-container/);
});

test('inject.js 找 iframe 用 src 含 c-resume（POC A10 验证）', () => {
  const m = inject.match(/function _waitForResumeIframe\(timeoutMs\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /iframe\[src\*="c-resume"\]/);
});

test('inject.js 等 iframe.contentDocument 加载完成（readyState + body 有内容）', () => {
  const m = inject.match(/function _waitForResumeIframe\(timeoutMs\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /contentDocument/);
  assert.match(m[0], /readyState/);
});

test('inject.js 含 _closeResumeDialog helper（ESC 主路径 + click 关闭按钮兜底）', () => {
  assert.match(inject, /function _closeResumeDialog\(\)/);
  const m = inject.match(/function _closeResumeDialog\(\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // ESC 主路径
  assert.match(m[0], /KeyboardEvent\('keydown'/);
  assert.match(m[0], /Escape/);
});

test('inject.js _closeResumeDialog 关闭后等 dialog 真消失（不假设 click 成功）', () => {
  const m = inject.match(/function _closeResumeDialog\(\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // 等待 .boss-dialog.resume-container 消失
  assert.match(m[0], /!document\.querySelector\('\.boss-dialog\.resume-container'\)/);
});

test('inject.js 含 _scanResumeIframe（主流程）', () => {
  assert.match(inject, /async function _scanResumeIframe\(\)/);
});

test('inject.js _scanResumeIframe 失败时仍尝试关弹窗（避免挡住后续操作）', () => {
  const m = inject.match(/async function _scanResumeIframe\(\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // 失败分支也调 _closeResumeDialog
  const closeCallsInFn = (m[0].match(/_closeResumeDialog\(\)/g) || []).length;
  assert.ok(closeCallsInFn >= 2, '失败和成功路径都应调 _closeResumeDialog');
});

// === _clickAndScanDetail 集成 ===

test('_clickAndScanDetail 在面板扫描后调用 _scanResumeIframe', () => {
  const m = inject.match(/async function _clickAndScanDetail\(uid, timeoutMs\)[\s\S]*?\n  \}\n/);
  assert.ok(m);
  assert.match(m[0], /_scanResumeIframe\(\)/);
});

test('_clickAndScanDetail 在线简历扫描失败时静默 fallback（rawScan.resumeFullText=null）', () => {
  const m = inject.match(/async function _clickAndScanDetail\(uid, timeoutMs\)[\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 失败分支：rawScan.resumeFullText = null
  assert.match(m[0], /rawScan\.resumeFullText\s*=\s*null/);
  // 失败原因记录
  assert.match(m[0], /resumeScanError/);
  // 整体仍然 return ok:true（不阻断主流程）
  assert.match(m[0], /return \{ ok: true, uid: String\(uid\), scan: rawScan/);
});

// === extractor.js domDetail 字段透传 ===

test('extractor.js extractFromDetailPanel 透传 resumeFullText 字段', () => {
  assert.match(extractor, /resumeFullText:\s*nz\(rawScan\.resumeFullText\)/);
});

test('extractor.js extractFromDetailPanel 也透传 resumeScanError（用于诊断 fallback 原因）', () => {
  assert.match(extractor, /resumeScanError:\s*nz\(rawScan\.resumeScanError\)/);
});

// === judge.js prompt 渲染 ===

test('judge.js serializeCandidate 把 resumeFullText 渲染进 prompt', () => {
  // 在 domDetail section 内有 resumeFullText 处理
  assert.match(judge, /resumeFullText/);
  assert.match(judge, /在线简历弹窗完整文本/);
});

test('judge.js domDetail.hasContent 检测含 resumeFullText', () => {
  // hasContent 判断有 resumeFullText
  const m = judge.match(/const hasContent =[\s\S]*?dom\.resumeFullText/);
  assert.ok(m, 'hasContent 应该包含 dom.resumeFullText 判断');
});

test('judge.js resumeFullText 在 prompt 里标注为最丰富信息源', () => {
  assert.match(judge, /最丰富信息源/);
});
