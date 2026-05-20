// 测试 v0.22.1 · Phase 2·2b：「开始处理本批」按钮接上 scan + eval 串行执行
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.2 子步骤 2b
//
// 跑：node --test tests/sayhi-start-button-wire.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');

// ========== A: HTML disabled 已去除 ==========

test('A1: #btn-sayhi-start 不再 disabled（2a 阶段是占位，2b 接入）', () => {
  // 排除 disabled 应不在 btn-sayhi-start 的 <button> 标签内
  const btnMatch = sidepanelHtml.match(/<button id="btn-sayhi-start"[^>]*>/);
  assert.ok(btnMatch, '应能找到 #btn-sayhi-start');
  assert.doesNotMatch(btnMatch[0], /\bdisabled\b/);
});

test('A2: #btn-sayhi-stop-batch title 更新（不再是 2a 阶段的占位文案）', () => {
  // 停止按钮初始 disabled 合理（没在评估时本该灰），由 renderPool 根据 evalStatus.running 控制
  // 只验证 title 已从 "2b 子步骤将接入" 占位改为真实功能说明
  const btnMatch = sidepanelHtml.match(/<button id="btn-sayhi-stop-batch"[^>]*>/);
  assert.ok(btnMatch);
  assert.doesNotMatch(btnMatch[0], /2b 子步骤将接入/);
  assert.match(btnMatch[0], /停止/);
});

test('A3: #btn-sayhi-start title 更新（不再含 "2b 子步骤将接入" 占位文案）', () => {
  const btnMatch = sidepanelHtml.match(/<button id="btn-sayhi-start"[^>]*>/);
  assert.ok(btnMatch);
  assert.doesNotMatch(btnMatch[0], /2b 子步骤将接入/);
  assert.match(btnMatch[0], /扫描|评估|串行|本批/);  // 真实功能说明
});

// ========== B: JS handler 已绑定 ==========

test('B1: sidepanel.js 含 #btn-sayhi-start click handler', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-start['"]\)\.addEventListener\(['"]click['"]/);
});

test('B2: handler 内部串行调用 SCAN_SAYHI_TAB → EVAL_SAYHI_BATCH', () => {
  // 提取 btn-sayhi-start handler 函数体
  const handlerMatch = sidepanelJs.match(/\$\(['"]btn-sayhi-start['"]\)\.addEventListener\(['"]click['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(handlerMatch, '应能找到 btn-sayhi-start handler');
  const body = handlerMatch[0];
  // 必须有 SCAN_SAYHI_TAB
  assert.match(body, /type:\s*['"]SCAN_SAYHI_TAB['"]/);
  // 必须有 EVAL_SAYHI_BATCH
  assert.match(body, /type:\s*['"]EVAL_SAYHI_BATCH['"]/);
  // 顺序：SCAN 在 EVAL 之前
  const scanIdx = body.indexOf('SCAN_SAYHI_TAB');
  const evalIdx = body.indexOf('EVAL_SAYHI_BATCH');
  assert.ok(scanIdx < evalIdx, 'SCAN_SAYHI_TAB 应在 EVAL_SAYHI_BATCH 之前');
});

test('B3: handler 扫到 0 人时不应自动启动评估（避免空跑）', () => {
  const handlerMatch = sidepanelJs.match(/\$\(['"]btn-sayhi-start['"]\)\.addEventListener\(['"]click['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(handlerMatch);
  const body = handlerMatch[0];
  // 必须有 scanned 检查 + 早 return（中间可能有提示文案，所以 non-greedy 任意长度）
  assert.match(body, /scanRes\.scanned[\s\S]*?return;/);
  // 同时 SCAN_SAYHI_TAB 早 return 必须出现在 EVAL_SAYHI_BATCH 之前
  const earlyReturnIdx = body.search(/scanRes\.scanned[\s\S]*?return;/);
  const evalIdx = body.indexOf('EVAL_SAYHI_BATCH');
  assert.ok(earlyReturnIdx < evalIdx, '扫到 0 人的 return 应在 EVAL_SAYHI_BATCH 调用之前');
});

test('B4: handler 用 sayhiStartInFlight 标志 gate（避免 refreshSayhiPane 覆盖按钮文字）', () => {
  // 模块级声明
  assert.match(sidepanelJs, /let\s+sayhiStartInFlight\s*=\s*false/);
  // handler 内置位 + finally 清位
  const handlerMatch = sidepanelJs.match(/\$\(['"]btn-sayhi-start['"]\)\.addEventListener\(['"]click['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(handlerMatch);
  const body = handlerMatch[0];
  assert.match(body, /sayhiStartInFlight\s*=\s*true/);
  assert.match(body, /sayhiStartInFlight\s*=\s*false/);
});

test('B5: handler 防重入（sayhiStartInFlight=true 时 return）', () => {
  const handlerMatch = sidepanelJs.match(/\$\(['"]btn-sayhi-start['"]\)\.addEventListener\(['"]click['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(handlerMatch);
  // handler 开头应检查 sayhiStartInFlight 防重入
  assert.match(handlerMatch[0], /if\s*\(sayhiStartInFlight\)\s*return/);
});

// ========== C: 停止按钮 ==========

test('C1: sidepanel.js 含 #btn-sayhi-stop-batch click handler', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-stop-batch['"]\)\.addEventListener\(['"]click['"]/);
});

test('C2: 停止按钮 handler 调 STOP_SAYHI_EVAL', () => {
  const handlerMatch = sidepanelJs.match(/\$\(['"]btn-sayhi-stop-batch['"]\)\.addEventListener\(['"]click['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(handlerMatch);
  assert.match(handlerMatch[0], /type:\s*['"]STOP_SAYHI_EVAL['"]/);
});

// ========== D: renderPool 管理新按钮状态 ==========

test('D1: renderPool 用 sayhiStartInFlight 守门，避免覆盖 handler 设置的文字', () => {
  const renderPoolMatch = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(renderPoolMatch);
  assert.match(renderPoolMatch[0], /if\s*\(!sayhiStartInFlight\)/);
});

test('D2: renderPool evalStatus.running 时 #btn-sayhi-start 显示进度文字', () => {
  const renderPoolMatch = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(renderPoolMatch);
  // 必须有 "评估中 X / Y" 之类的格式
  assert.match(renderPoolMatch[0], /评估中[\s\S]{0,40}evalStatus\.done[\s\S]{0,20}evalStatus\.total/);
});

test('D3: renderPool 非 running 时 #btn-sayhi-start 复位"▶ 开始处理本批"', () => {
  const renderPoolMatch = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(renderPoolMatch);
  assert.match(renderPoolMatch[0], /开始处理本批/);
});

test('D4: renderPool 控制 #btn-sayhi-stop-batch disabled（仅 running 时启用）', () => {
  const renderPoolMatch = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(renderPoolMatch);
  // 包含 stopBatchBtn.disabled 赋值
  assert.match(renderPoolMatch[0], /stopBatchBtn\.disabled/);
});

test('D5: renderPool LLM 未配置时禁用 #btn-sayhi-start（防止用户白跑）', () => {
  const renderPoolMatch = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(renderPoolMatch);
  // res.llmConfigured 影响 startBtn.disabled
  assert.match(renderPoolMatch[0], /startBtn\.disabled\s*=[^;]*llmConfigured/);
});

// ========== E: 不破坏现有按钮 ==========

test('E1: 现有 #btn-sayhi-scan handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-scan['"]\)\.addEventListener/);
});

test('E2: 现有 #btn-sayhi-eval handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-eval['"]\)\.addEventListener/);
});

test('E3: 现有 #btn-sayhi-stop（旧）handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-stop['"]\)\.addEventListener/);
});
