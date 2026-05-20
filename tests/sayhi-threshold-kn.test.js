// 测试 v0.22.3 · Phase 2·2d：阈值 K/N 接入 evalSayhiCore
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.2.3
//
// 语义：
//   K（浏览数）= 本批最多评估几人，截断 todo（留空 = 全部未读）
//   N（招呼数）= 本批最多发几条话术，仅在 enabledBatchEval=true 时生效
//   任一达上限即停整批（与推荐页心智一致）
//
// 跑：node --test tests/sayhi-threshold-kn.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const bg = read('background.js');
const sidepanelJs = read('sidepanel/sidepanel.js');
const sidepanelHtml = read('sidepanel/sidepanel.html');

// 提取 evalSayhiCore 函数体（到 evalSayhiBatch 定义为止）
function getEvalSayhiCoreBody() {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  if (!m) throw new Error('未找到 evalSayhiCore');
  return m[0];
}

// 提取 GET_SAYHI_POOL 响应体
function getSayhiPoolHandler() {
  const m = bg.match(/case ['"]GET_SAYHI_POOL['"]:[\s\S]*?return true;/);
  if (!m) throw new Error('未找到 GET_SAYHI_POOL handler');
  return m[0];
}

// ========== A: appConfig.sayhiBatch 默认配置 ==========

test('A1: appConfig 含 sayhiBatch 节（与 sayHiDom / autoAction 平级）', () => {
  // appConfig 顶层应有 sayhiBatch 字段
  const m = bg.match(/let appConfig = \{[\s\S]*?^\};/m);
  assert.ok(m, '未找到 appConfig 定义');
  assert.match(m[0], /sayhiBatch:\s*\{/, 'appConfig 应含 sayhiBatch 节');
});

test('A2: sayhiBatch 默认 maxBrowseK = null（= 留空 = 全部未读）', () => {
  const m = bg.match(/sayhiBatch:\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /maxBrowseK:\s*null/);
});

test('v0.25.0 A3: sayhiBatch 不再含 maxGreetN 字段（彻底废弃）', () => {
  const m = bg.match(/sayhiBatch:\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /maxGreetN/);
});

test('A4: loadConfig 把 sayhiBatch 纳入 chrome.storage.sync 持久化范畴', () => {
  // loadConfig 里 storage-sync get 应含 sayhiBatch
  const m = bg.match(/function loadConfig\(\)[\s\S]*?^\}/m);
  assert.ok(m);
  assert.match(m[0], /sayhiBatch/);
});

// ========== B: GET_SAYHI_POOL 响应回带 sayhiBatch（sidepanel 渲染 input value 用） ==========

test('B1: GET_SAYHI_POOL 响应含 sayhiBatch 字段', () => {
  const h = getSayhiPoolHandler();
  assert.match(h, /sayhiBatch:\s*\{/);
});

test('v0.25.0 B2: 响应里的 sayhiBatch 含 maxBrowseK（仅，maxGreetN 已删）', () => {
  const h = getSayhiPoolHandler();
  assert.match(h, /maxBrowseK:/);
  assert.doesNotMatch(h, /maxGreetN/);
});

// ========== C: evalSayhiCore 接入 K 截断 todo ==========

test('C1: evalSayhiCore 读 appConfig.sayhiBatch（拿 K/N 阈值）', () => {
  const body = getEvalSayhiCoreBody();
  assert.match(body, /appConfig\.sayhiBatch/);
});

test('C2: evalSayhiCore 在 todo 计算后用 K 截断（slice）', () => {
  const body = getEvalSayhiCoreBody();
  // 必须有 todo.slice 截断逻辑（或 splice / Math.min length），且涉及 maxBrowseK
  assert.match(body, /maxBrowseK/);
  // 截断动作存在
  assert.match(body, /todo\s*=\s*todo\.slice|todo\.length\s*=\s*Math\.min/);
});

test('C3: K 截断仅在 K 为正整数时生效（留空 / 0 / NaN 不截断）', () => {
  const body = getEvalSayhiCoreBody();
  // 截断条件应判断 K > 0 + Number.isFinite (或类似的正数门)
  assert.match(body, /Number\.isFinite\([^)]*K\)|K\s*>\s*0/);
});

// ========== D: v0.25.0 删 maxGreetN/招呼数 cap 整套（彻底废弃）==========

test('v0.25.0 D1: evalSayhiCore 不再读 maxGreetN', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /maxGreetN/);
});

test('v0.25.0 D2: evalSayhiCore 不再维护 greetSentCount', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /greetSentCount/);
});

test('v0.25.0 D3: 循环开头不再有 N 满 break 检查', () => {
  const body = getEvalSayhiCoreBody();
  assert.doesNotMatch(body, /greetSentCount\s*>=\s*\w*N/);
  assert.doesNotMatch(body, />=\s*maxGreetN/);
});

// ========== E: sidepanel HTML 去 K/N input 的 disabled ==========

test('E1: #sayhi-loop-goal-k 不再 hardcode disabled', () => {
  const m = sidepanelHtml.match(/<input[^>]*id="sayhi-loop-goal-k"[^>]*>/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /\bdisabled\b(?!=)/);
});

test('v0.25.0 E2: #sayhi-loop-goal-n input 已彻底删除', () => {
  assert.doesNotMatch(sidepanelHtml, /id="sayhi-loop-goal-n"/);
});

test('v0.25.0 E3: K input title 不再含 "2d 子步骤将接入"（已接入）', () => {
  const mK = sidepanelHtml.match(/<input[^>]*id="sayhi-loop-goal-k"[^>]*>/);
  assert.ok(mK);
  assert.doesNotMatch(mK[0], /2d 子步骤将接入/);
});

// ========== F: sidepanel.js 读 / 写 K/N ==========

test('F1: renderPool 把 res.sayhiBatch.maxBrowseK 回写到 #sayhi-loop-goal-k.value', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /res\.sayhiBatch/);
  assert.match(m[0], /sayhi-loop-goal-k/);
});

test('v0.25.0 F2: renderPool 不再读 #sayhi-loop-goal-n（已删）', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /sayhi-loop-goal-n/);
});

test('v0.25.0 F3: 仅 K input 有 change handler（N 已删）', () => {
  assert.match(sidepanelJs, /\$\(['"]sayhi-loop-goal-k['"]\)\.addEventListener\(['"]change['"]/);
  assert.doesNotMatch(sidepanelJs, /\$\(['"]sayhi-loop-goal-n['"]\)\.addEventListener/);
});

test('F4: change handler 调 SET_CONFIG_SECTION 写 sayhiBatch.maxBrowseK', () => {
  const m = sidepanelJs.match(/\$\(['"]sayhi-loop-goal-k['"]\)\.addEventListener\(['"]change['"],[\s\S]*?^  \}\);/m);
  assert.ok(m);
  assert.match(m[0], /type:\s*['"]SET_CONFIG_SECTION['"]/);
  assert.match(m[0], /section:\s*['"]sayhiBatch['"]/);
  assert.match(m[0], /maxBrowseK/);
});

test('v0.25.0 F5: 无 maxGreetN change handler（已删）', () => {
  // sayhiBatch patch 里不应再出现 maxGreetN 字段
  assert.doesNotMatch(sidepanelJs, /patch:\s*\{\s*maxGreetN/);
});

test('F6: 空输入 → 持久化为 null（"留空 = 全部"语义）', () => {
  // K handler 必须把空字符串 / NaN 处理成 null
  const m = sidepanelJs.match(/\$\(['"]sayhi-loop-goal-k['"]\)\.addEventListener\(['"]change['"],[\s\S]*?^  \}\);/m);
  assert.ok(m);
  // 显式有 null 字面量
  assert.match(m[0], /null/);
});

// ========== G: 联动约束 ==========

test('v0.25.0 G1: renderPool 评估运行中 → K input disabled（防中途改阈值）', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  const kCtx = m[0].match(/sayhi-loop-goal-k[\s\S]{0,300}/);
  assert.ok(kCtx);
  assert.match(kCtx[0], /evalStatus\.running|disabled/);
});

// ========== H: 不破坏其他配置 ==========

test('H1: appConfig.autoAction 仍存在（2c 行为不变）', () => {
  assert.match(bg, /autoAction:\s*\{/);
  assert.match(bg, /enabledBatchEval:/);
  assert.match(bg, /autoMarkUnsuitable:/);
});

test('H2: evalSayhiBatch 仍调 evalSayhiCore（不绕开 2d 阈值）', () => {
  const m = bg.match(/async function evalSayhiBatch\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /evalSayhiCore/);
});
