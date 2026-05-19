// v0.20.7 scenario 业务归一化测试
// 跑：node --test tests/v0_20_7-scenario-unification.test.js
//
// 背景 BUG：HR 跑 BOSS「最新候选人」tab 时，看板的「推荐页 / 沟通页」漏斗 tab 都看不到数据
//   - 物理 scenario：extractor.js 已写入 4 种（recommend/latest/chat/sayhi-tab）
//   - 但 background.js deriveScenario 简化映射只输出 2 种（recommend/chat），把 latest 误归 chat
//   - 看板 currentFunnelTab 只有 'recommend'/'chat'，过滤 latest 数据时全过滤掉
//
// v0.20.7 修复：
//   1. dashboard.js recordScenario：业务归一化（recommend+latest → recommend；chat+sayhi-tab → chat）
//   2. background.js deriveScenario：单独识别 latest（写入侧物理 scenario 跟 extractor 对齐）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const dashboardJs = read('dashboard/dashboard.js');
const bgJs = read('background.js');
const extractorJs = read('lib/extractor.js');

// ============ A: 静态断言（源码结构层） ============

test('A1: dashboard.js recordScenario 业务归一化（recommend+latest → recommend）', () => {
  // 找 recordScenario 函数体
  const m = dashboardJs.match(/function recordScenario\(r\)[\s\S]*?\n\s*\}/);
  assert.ok(m, 'recordScenario 函数应存在');
  const body = m[0];
  // 含 'latest' → 'recommend' 映射
  assert.match(body, /raw === 'recommend' \|\| raw === 'latest'[\s\S]*?return 'recommend'/);
});

test('A2: dashboard.js recordScenario 沟通业务归一化（chat+sayhi-tab → chat）', () => {
  const m = dashboardJs.match(/function recordScenario\(r\)[\s\S]*?\n\s*\}/);
  assert.ok(m);
  const body = m[0];
  assert.match(body, /raw === 'chat' \|\| raw === 'sayhi-tab'[\s\S]*?return 'chat'/);
});

test('A3: background.js deriveScenario 识别 /zprelation/interaction/bossGetGeek → latest', () => {
  const m = bgJs.match(/function deriveScenario\(apiPath\)[\s\S]*?\n\}/);
  assert.ok(m, 'deriveScenario 函数应存在');
  const body = m[0];
  assert.match(body, /\/zprelation\/interaction\/bossGetGeek[\s\S]*?return 'latest'/);
});

test('A4: background.js deriveScenario /chat/ 和其他 /zprelation/ 仍归 chat', () => {
  const m = bgJs.match(/function deriveScenario\(apiPath\)[\s\S]*?\n\}/);
  assert.ok(m);
  const body = m[0];
  assert.match(body, /\/chat\/[\s\S]*?\/zprelation\/[\s\S]*?return 'chat'/);
});

test('A5: extractor.js 仍写入 4 种物理 scenario（未动）', () => {
  assert.match(extractorJs, /scenario:\s*'recommend'/);
  assert.match(extractorJs, /scenario:\s*'latest'/);
  assert.match(extractorJs, /scenario:\s*'chat'/);
  assert.match(extractorJs, /scenario:\s*'sayhi-tab'/);
});

// ============ B: 行为单元测试（实际执行 recordScenario / deriveScenario） ============

// 把 recordScenario 函数从源码里提取出来在 Node 里执行
// 注意：函数嵌套在 dashboard IIFE 内部，简单方法是把它复刻一份在测试里
// 复刻规则：跟 dashboard.js:136 的实现一字不差
function recordScenarioImpl(r) {
  if (!r) return null;
  const raw = r.scenario || (r.candidate && r.candidate.source && r.candidate.source.scenario);
  if (raw === 'recommend' || raw === 'latest') return 'recommend';
  if (raw === 'chat' || raw === 'sayhi-tab') return 'chat';
  return raw;
}

function deriveScenarioImpl(apiPath) {
  if (!apiPath) return 'recommend';
  if (apiPath.indexOf('/rec/') !== -1) return 'recommend';
  if (apiPath.indexOf('/zprelation/interaction/bossGetGeek') !== -1) return 'latest';
  if (apiPath.indexOf('/chat/') !== -1 || apiPath.indexOf('/zprelation/') !== -1) return 'chat';
  return 'recommend';
}

test('B1: recordScenario({scenario:"recommend"}) → recommend', () => {
  assert.equal(recordScenarioImpl({ scenario: 'recommend' }), 'recommend');
});

test('B2: recordScenario({scenario:"latest"}) → recommend（业务归一化 ★ 核心 BUG 修复）', () => {
  assert.equal(recordScenarioImpl({ scenario: 'latest' }), 'recommend');
});

test('B3: recordScenario({scenario:"chat"}) → chat', () => {
  assert.equal(recordScenarioImpl({ scenario: 'chat' }), 'chat');
});

test('B4: recordScenario({scenario:"sayhi-tab"}) → chat（业务归一化）', () => {
  assert.equal(recordScenarioImpl({ scenario: 'sayhi-tab' }), 'chat');
});

test('B5: recordScenario fallback 到 candidate.source.scenario', () => {
  // 模拟 evaluations 表的真实结构：r.scenario 为空，靠 r.candidate.source.scenario
  const r = { candidate: { source: { scenario: 'latest' } } };
  assert.equal(recordScenarioImpl(r), 'recommend',
    'evaluations 表 r.scenario 为空时，应 fallback 到 candidate.source.scenario 并归一化');
});

test('B6: recordScenario 未知 scenario 返回 raw（防御）', () => {
  assert.equal(recordScenarioImpl({ scenario: 'unknown-future' }), 'unknown-future');
});

test('B7: deriveScenario("/wapi/zpgeek/rec/geek/list") → recommend', () => {
  assert.equal(deriveScenarioImpl('/wapi/zpgeek/rec/geek/list'), 'recommend');
});

test('B8: deriveScenario("/wapi/zprelation/interaction/bossGetGeek") → latest（修复 ★）', () => {
  // 修复前：被错归 'chat'；修复后：单独识别 'latest'
  assert.equal(deriveScenarioImpl('/wapi/zprelation/interaction/bossGetGeek'), 'latest');
});

test('B9: deriveScenario("/wapi/zpchat/v2/chat/geek/info") → chat（沟通页本来）', () => {
  assert.equal(deriveScenarioImpl('/wapi/zpchat/v2/chat/geek/info'), 'chat');
});

test('B10: deriveScenario("/wapi/zprelation/xxx") 其他 /zprelation/ 仍归 chat（保持兼容）', () => {
  assert.equal(deriveScenarioImpl('/wapi/zprelation/some-other-path'), 'chat');
});

// ============ C: 业务闭环 — 模拟 HR 跑「最新」tab 后看板能显示 ============

test('C1: HR 跑最新 tab：candidate.source.scenario="latest" 的 evaluation 进推荐 tab 视图', () => {
  // 模拟 extractor 写入的 evaluation record（截图里的真实结构）
  const evalRecord = {
    candidateId: '669323364',
    candidate: { source: { scenario: 'latest', apiPath: '/wapi/zprelation/interaction/bossGetGeek' } },
    evaluation: { decision: 'pass', status: 'done', jdId: 'indonesia-intern-2026' }
  };
  // 看板「推荐」tab：currentFunnelTab='recommend' → 应该接受这条记录
  assert.equal(recordScenarioImpl(evalRecord), 'recommend',
    '最新 tab 跑出来的 evaluation 在看板「推荐页」tab 应显示');
});

test('C2: 同理，最新 tab 写入的 event（scenario="latest"）也归推荐 tab', () => {
  const event = { scenario: 'latest', stage: 'candidate_pool', jobId: 'indonesia-intern-2026' };
  assert.equal(recordScenarioImpl(event), 'recommend');
});

test('C3: 沟通页招呼 event（sayhi-tab）正确归到沟通页 tab', () => {
  const event = { scenario: 'sayhi-tab', stage: 'sayhi_sent' };
  assert.equal(recordScenarioImpl(event), 'chat');
});
