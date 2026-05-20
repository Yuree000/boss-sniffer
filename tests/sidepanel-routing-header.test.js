// 测试 v0.21.0 · Phase 1·1d：sidepanel 加 unrouted 卡片样式 + 沟通职位 → JD 路由头
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.1 子步骤 1d
//
// 跑：node --test tests/sidepanel-routing-header.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');

// ========== HTML / CSS ==========

test('sidepanel.html — 含 .eval-card.unrouted 卡片样式（黄色边）', () => {
  assert.match(sidepanelHtml, /\.eval-card\.unrouted\s*\{[\s\S]*?border-left-color/);
});

test('sidepanel.html — 含 .decision.unrouted 决策标样式', () => {
  assert.match(sidepanelHtml, /\.decision\.unrouted\s*\{/);
});

test('sidepanel.html — 含 .routing-header 小字头样式', () => {
  assert.match(sidepanelHtml, /\.routing-header\s*\{/);
});

test('sidepanel.html — 含 .routing-header.unrouted 黄底样式', () => {
  assert.match(sidepanelHtml, /\.routing-header\.unrouted\s*\{/);
});

test('sidepanel.html — 不再含 #sayhi-jd-title（沟通页全局 JD label 已删，每候选人各自路由）', () => {
  // 注意：推荐页 pane 的 #jd-title 是独立元素，仍保留（推荐页一次只用一个 JD）
  assert.doesNotMatch(sidepanelHtml, /id="sayhi-jd-title"/);
});

// ========== JS：decisionClass / decisionLabel 三态扩展 ==========

test('sidepanel.js — decisionClass 把 status="unrouted" 映射到 "unrouted" CSS class', () => {
  const fn = sidepanelJs.match(/function decisionClass\([\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn[0], /status === ['"]unrouted['"][\s\S]*?return ['"]unrouted['"]/);
});

test('sidepanel.js — decisionLabel 对 unrouted 返回 "🟡 未识别岗位"', () => {
  const fn = sidepanelJs.match(/function decisionLabel\([\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn[0], /status === ['"]unrouted['"][\s\S]*?未识别/);
});

// ========== JS：makeRoutingHeader 函数 ==========

test('sidepanel.js — 含 makeRoutingHeader 函数', () => {
  assert.match(sidepanelJs, /function makeRoutingHeader\(/);
});

test('sidepanel.js — makeRoutingHeader 处理 unrouted 状态（含 reason=no_jobAligned 分支）', () => {
  const fn = sidepanelJs.match(/function makeRoutingHeader\([\s\S]*?^\}/m);
  assert.ok(fn);
  // 必须区分 no_jobAligned vs 其他（如 no_match）
  assert.match(fn[0], /unrouteReason === ['"]no_jobAligned['"]/);
  assert.match(fn[0], /沟通职位缺失/);
  assert.match(fn[0], /未识别/);
});

test('sidepanel.js — makeRoutingHeader 命中（routedJdName 存在）显示 "沟通职位 → JD: xxx"', () => {
  const fn = sidepanelJs.match(/function makeRoutingHeader\([\s\S]*?^\}/m);
  assert.ok(fn);
  assert.match(fn[0], /e\.routedJdName/);
  // 应有"沟通职位 → JD"模板
  assert.match(fn[0], /沟通职位/);
});

test('sidepanel.js — makeRoutingHeader 兜底：仅 jobAligned 存在（idle/queued/pending）也显示沟通职位', () => {
  const fn = sidepanelJs.match(/function makeRoutingHeader\([\s\S]*?^\}/m);
  assert.ok(fn);
  // 必须有"if (jobAligned)" 兜底分支返回 div
  assert.match(fn[0], /if\s*\(jobAligned\)\s*\{[\s\S]*?return div/);
});

test('sidepanel.js — makeRoutingHeader 无 jobAligned 且非 unrouted 返回 null', () => {
  const fn = sidepanelJs.match(/function makeRoutingHeader\([\s\S]*?^\}/m);
  assert.ok(fn);
  // 函数末尾 return null（无数据可显示时）
  assert.match(fn[0], /return null;\s*\n\}/);
});

// ========== JS：renderSayhiCard 接入 ==========

test('sidepanel.js — renderSayhiCard 调用 makeRoutingHeader 渲染路由头', () => {
  const fn = sidepanelJs.match(/function renderSayhiCard\(record, poolItem\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(fn);
  // idle 分支 + evaluated 分支都应该调
  const calls = fn[0].match(/makeRoutingHeader\(/g) || [];
  assert.ok(calls.length >= 2, 'renderSayhiCard 应至少 2 次调 makeRoutingHeader（idle + evaluated）');
});

test('sidepanel.js — renderSayhiCard evaluated 分支把 routing-header 插在 eval-row1 之后', () => {
  const fn = sidepanelJs.match(/function renderSayhiCard[\s\S]*?\n  \}/);
  assert.ok(fn);
  // 应使用 insertBefore + row1.nextSibling
  assert.match(fn[0], /insertBefore\(routingHeader,\s*row1\.nextSibling\)/);
});

// ========== JS：删了 sayhi-jd-title 的 setter ==========

test('sidepanel.js — 不再写 sayhi-jd-title 的 textContent（全局 JD 标 setter 已删）', () => {
  // 找以 $('sayhi-jd-title') 开头的赋值语句不应存在
  assert.doesNotMatch(sidepanelJs, /\$\(['"]sayhi-jd-title['"]\)\.textContent\s*=/);
});
