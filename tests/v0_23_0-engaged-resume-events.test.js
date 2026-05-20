// 测试 v0.23.0 · Phase 3·3d：L3 engaged / L4 resume_received 漏斗埋点
//
// 见 .claude/plans/resilient-dazzling-dove.md §C + spec §3.3·4
//
// 范围：
//   - lib/events.js 加 hasRecentEvent helper（防重复 emit）
//   - background.js mergeChatHistoryFromHistoryMsg 检测候选人回复 → emit engaged
//   - background.js mergeResumeCardsToStore 首次拿到简历 → emit resume_received

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const bg = read('background.js');
const events = read('lib/events.js');

// ========== A: lib/events.js hasRecentEvent helper ==========

test('A1: lib/events.js 含 hasRecentEvent 函数', () => {
  assert.match(events, /(?:async\s+)?function\s+hasRecentEvent\s*\(/);
});

test('A2: hasRecentEvent 在 BossEvents 公开 API 中暴露', () => {
  // 查 global.BossEvents = { ... } 对象中含 hasRecentEvent
  const m = events.match(/global\.BossEvents\s*=\s*\{[\s\S]*?\};/);
  assert.ok(m);
  assert.match(m[0], /hasRecentEvent/);
});

test('A3: hasRecentEvent 入参 candidateId + stage + withinMs', () => {
  const m = events.match(/function\s+hasRecentEvent\s*\(([^)]+)\)/);
  assert.ok(m);
  assert.match(m[1], /candidateId/);
  assert.match(m[1], /stage/);
  // 时间窗参数（withinMs / sinceMs / windowMs 任一名）
  assert.match(m[1], /withinMs|sinceMs|windowMs/);
});

// ========== B: engaged 事件 emit ==========

test('B1: mergeChatHistoryFromHistoryMsg 含 engaged emit 逻辑', () => {
  const m = bg.match(/async function mergeChatHistoryFromHistoryMsg[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /stage:\s*['"]engaged['"]/);
});

test('B2: engaged emit 前检查 hasRecentEvent 防重复', () => {
  const m = bg.match(/async function mergeChatHistoryFromHistoryMsg[\s\S]*?\n\}/);
  assert.ok(m);
  // 引用 hasRecentEvent 或等价的 getEventsByCandidate 查重
  assert.match(m[0], /hasRecentEvent|getEventsByCandidate/);
});

test('B3: engaged emit 仅在检测到 role=candidate 消息时触发', () => {
  const m = bg.match(/async function mergeChatHistoryFromHistoryMsg[\s\S]*?\n\}/);
  assert.ok(m);
  // engaged emit 块内（同一 mergeChatHistoryFromHistoryMsg 函数体）应有 role=candidate 检查
  // 不锁定具体位置（实现可能把 candidateMsg 提取到函数顶部），只要同一函数体内同时有 stage=engaged + role===candidate
  assert.match(m[0], /stage:\s*['"]engaged['"]/);
  assert.match(m[0], /role\s*===?\s*['"]candidate['"]/);
});

test('B4: engaged scenario 为 chat', () => {
  const m = bg.match(/async function mergeChatHistoryFromHistoryMsg[\s\S]*?\n\}/);
  assert.ok(m);
  const idx = m[0].search(/stage:\s*['"]engaged['"]/);
  const ctx = m[0].slice(idx, idx + 400);
  assert.match(ctx, /scenario:\s*['"]chat['"]/);
});

// ========== C: resume_received 事件 emit ==========

test('C1: mergeResumeCardsToStore 含 resume_received emit', () => {
  const m = bg.match(/async function mergeResumeCardsToStore[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /stage:\s*['"]resume_received['"]/);
});

test('C2: resume_received emit 前检查 hasRecentEvent 防重复', () => {
  const m = bg.match(/async function mergeResumeCardsToStore[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /hasRecentEvent|getEventsByCandidate/);
});

test('C3: resume_received emit 仅在首次拿到简历时触发', () => {
  const m = bg.match(/async function mergeResumeCardsToStore[\s\S]*?\n\}/);
  assert.ok(m);
  // emit 段附近应有 bossSignals.resumeCard 检查（已存在则跳过）
  const idx = m[0].search(/stage:\s*['"]resume_received['"]/);
  const ctx = m[0].slice(Math.max(0, idx - 600), idx + 200);
  assert.match(ctx, /resumeCard|hasRecentEvent/);
});

test('C4: resume_received payload 含 applyStatus / position 等关键字段', () => {
  const m = bg.match(/async function mergeResumeCardsToStore[\s\S]*?\n\}/);
  assert.ok(m);
  const idx = m[0].search(/stage:\s*['"]resume_received['"]/);
  const ctx = m[0].slice(idx, idx + 500);
  // 至少含其中一个核心字段
  assert.match(ctx, /applyStatus|position|resumeReceivedAt/);
});

// ========== D: 不破坏既有 ==========

test('D1: lib/events.js VALID_STAGES 仍含 engaged + resume_received（schema 早就预留）', () => {
  assert.match(events, /'engaged'/);
  assert.match(events, /'resume_received'/);
});

test('D2: 既有 candidate_pool / match_marked / sayhi_sent emit 不动', () => {
  assert.match(bg, /stage:\s*['"]candidate_pool['"]/);
  assert.match(bg, /stage:\s*['"]match_marked['"]/);
  assert.match(bg, /stage:\s*['"]sayhi_sent['"]/);
});
