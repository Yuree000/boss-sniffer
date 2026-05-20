// 测试 v0.22.2 · Phase 2·2c：两个自动操作 checkbox + 联动约束（默认 OFF）
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §3.2 子步骤 2c
//
// 跑：node --test tests/sayhi-auto-action-toggles.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');
const bg = read('background.js');

// ========== A: HTML 去 disabled + title 更新 ==========

test('A1: #sayhi-auto-greet-toggle 不再 hardcode disabled（运行时由 renderPool 控制）', () => {
  const m = sidepanelHtml.match(/<input[^>]*id="sayhi-auto-greet-toggle"[^>]*>/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /\bdisabled\b(?!=)/);
});

test('A2: #sayhi-auto-mark-unsuitable-toggle 不再 hardcode disabled', () => {
  const m = sidepanelHtml.match(/<input[^>]*id="sayhi-auto-mark-unsuitable-toggle"[^>]*>/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /\bdisabled\b(?!=)/);
});

test('A3: title 不再含 "2c 子步骤将接入"（已接入）', () => {
  const m1 = sidepanelHtml.match(/<input[^>]*id="sayhi-auto-greet-toggle"[^>]*>/);
  const m2 = sidepanelHtml.match(/<input[^>]*id="sayhi-auto-mark-unsuitable-toggle"[^>]*>/);
  assert.ok(m1 && m2);
  assert.doesNotMatch(m1[0], /2c 子步骤将接入/);
  assert.doesNotMatch(m2[0], /2c 子步骤将接入/);
});

test('A4: 自动标不合适 checkbox 明确标"Phase 3 加固后才执行"（HR 知情）', () => {
  // label 文本或 title 必须告知 HR 此 checkbox 在 Phase 2 阶段不实际执行
  const labelArea = sidepanelHtml.match(/sayhi-auto-mark-unsuitable-toggle[\s\S]{0,500}<\/label>/);
  assert.ok(labelArea);
  assert.match(labelArea[0], /Phase 3/);
});

// ========== B: background appConfig + GET_SAYHI_POOL ==========

test('B1: appConfig.autoAction 默认含 autoMarkUnsuitable: false', () => {
  const m = bg.match(/autoAction:\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /autoMarkUnsuitable:\s*false/);
});

test('B2: appConfig.autoAction 保留 enabledBatchEval（向后兼容）', () => {
  const m = bg.match(/autoAction:\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /enabledBatchEval:\s*false/);
});

test('B3: GET_SAYHI_POOL 响应含 autoAction（让 sidepanel 读真实状态）', () => {
  const m = bg.match(/case ['"]GET_SAYHI_POOL['"]:[\s\S]*?return true;/);
  assert.ok(m);
  assert.match(m[0], /autoAction:\s*\{/);
  assert.match(m[0], /enabledBatchEval:/);
  assert.match(m[0], /autoMarkUnsuitable:/);
});

test('v0.25.1 B4: GET_SAYHI_POOL 响应不再含 jdBossJobNames（沟通页路由改用 JD.name 严格相等）', () => {
  const m = bg.match(/case ['"]GET_SAYHI_POOL['"]:[\s\S]*?return true;/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /jdBossJobNames:/);
});

// ========== C: evalSayhiCore 不接入 autoMarkUnsuitable 执行（防 P3 撤销窗口前的事故） ==========

test('C1: evalSayhiCore 已接入 autoMarkUnsuitable（v0.23.0 · 3c 落地，撤销窗口护栏已就位）', () => {
  // v0.22.2 时此断言为 doesNotMatch（防 3c 撤销窗口前误执行不可逆操作）
  // v0.23.0 · 3c 起：dismissed_candidates 入队 + 30s 撤销窗口 + 24h 复盘已落地，flag 现在被读取
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  assert.match(m[0], /autoMarkUnsuitable/);
});

test('C2: evalSayhiCore 仍读 enabledBatchEval（自动话术+求简历功能不变）', () => {
  const m = bg.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  assert.match(m[0], /enabledBatchEval/);
});

// ========== D: sidepanel renderPool 状态管理 ==========

test('D1: renderPool 从 res.autoAction 读 checkbox 状态', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /res\.autoAction/);
});

test('D2: renderPool 把 autoGreet checkbox.checked 设为 enabledBatchEval', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /autoGreetEl\.checked\s*=[^;]*enabledBatchEval/);
});

test('D3: renderPool 把 autoMark checkbox.checked 设为 autoMarkUnsuitable', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /autoMarkEl\.checked\s*=[^;]*autoMarkUnsuitable/);
});

// v0.24.1：移除 v0.22.2 jdHasAliases 联动 + evalStatus.running 限制
//   设计变更：配置态（HR 意图）与执行态（runtime 是否触发）解耦——
//   v0.21.2 multi-JD per-candidate 路由完成后，unrouted 候选人在
//   evalSayhiCore 循环开头 continue 跳过 LLM 和自动操作，无需再用
//   UI disabled 兜底。HR 永远可点 = 表达意图；runtime 按路由结果决定行为。
test('v0.24.1 D4: renderPool 两个 checkbox 不再依赖 jdHasAliases 做 disabled', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // jdHasAliases 不再出现在 .disabled 赋值表达式右侧（注释里历史背景可保留）
  assert.doesNotMatch(m[0], /\.disabled\s*=[^;]*jdHasAliases/);
  // 两个 checkbox 显式 disabled = false
  assert.match(m[0], /autoGreetEl\.disabled\s*=\s*false/);
  assert.match(m[0], /autoMarkEl\.disabled\s*=\s*false/);
});

test('v0.24.1 D5: renderPool 评估运行中也允许改 checkbox（下个候选人即生效）', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // checkbox disabled 不再依赖 evalStatus.running
  assert.doesNotMatch(m[0], /autoGreetEl\.disabled\s*=[^;]*evalStatus\.running/);
  assert.doesNotMatch(m[0], /autoMarkEl\.disabled\s*=[^;]*evalStatus\.running/);
});

test('v0.24.1 D6: renderPool 新 title 文案反映 runtime 行为（路由未命中跳过）', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // 新文案体现"仅对路由命中 JD 的候选人生效"
  assert.match(m[0], /仅对路由命中 JD 的候选人生效/);
  // 旧"防错岗"文案应全部移除
  assert.doesNotMatch(m[0], /未配 BOSS 沟通职位别名/);
  assert.doesNotMatch(m[0], /防错岗自动操作/);
});

test('D6: renderPool 给 disabled 状态加 hover title 说明原因', () => {
  const m = sidepanelJs.match(/function renderPool\(res\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /autoGreetEl\.title/);
  // 文案明确提到 bossJobNames 缺失
  assert.match(m[0], /bossJobNames|沟通职位别名/);
});

// ========== E: change handlers 写回 appConfig ==========

test('E1: #sayhi-auto-greet-toggle 有 change handler', () => {
  assert.match(sidepanelJs, /\$\(['"]sayhi-auto-greet-toggle['"]\)\.addEventListener\(['"]change['"]/);
});

test('E2: #sayhi-auto-mark-unsuitable-toggle 有 change handler', () => {
  assert.match(sidepanelJs, /\$\(['"]sayhi-auto-mark-unsuitable-toggle['"]\)\.addEventListener\(['"]change['"]/);
});

test('E3: autoGreet handler 调 SET_CONFIG_SECTION 写 enabledBatchEval', () => {
  const m = sidepanelJs.match(/\$\(['"]sayhi-auto-greet-toggle['"]\)\.addEventListener\(['"]change['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(m);
  assert.match(m[0], /type:\s*['"]SET_CONFIG_SECTION['"]/);
  assert.match(m[0], /section:\s*['"]autoAction['"]/);
  assert.match(m[0], /enabledBatchEval:\s*checked/);
});

test('E4: autoMark handler 调 SET_CONFIG_SECTION 写 autoMarkUnsuitable', () => {
  const m = sidepanelJs.match(/\$\(['"]sayhi-auto-mark-unsuitable-toggle['"]\)\.addEventListener\(['"]change['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(m);
  assert.match(m[0], /type:\s*['"]SET_CONFIG_SECTION['"]/);
  assert.match(m[0], /autoMarkUnsuitable:\s*checked/);
});

test('E5: handler 保存失败时回滚 checkbox UI', () => {
  const m1 = sidepanelJs.match(/\$\(['"]sayhi-auto-greet-toggle['"]\)\.addEventListener\(['"]change['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(m1);
  assert.match(m1[0], /ev\.target\.checked\s*=\s*!checked/);
});

test('E6: autoMark handler 提示 HR "Phase 3 才执行"（避免错觉以为已生效）', () => {
  const m = sidepanelJs.match(/\$\(['"]sayhi-auto-mark-unsuitable-toggle['"]\)\.addEventListener\(['"]change['"],\s*async function[\s\S]*?^  \}\);/m);
  assert.ok(m);
  // toast 文案应明确告知 P3 才接入实际执行
  assert.match(m[0], /Phase 3|撤销窗口|不会自动/);
});
