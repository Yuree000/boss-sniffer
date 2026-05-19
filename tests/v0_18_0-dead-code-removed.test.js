// v0.18.0 死代码清理 — 验证 Tier 1 A-E 五项删干净
// 跑：node --test tests/v0_18_0-dead-code-removed.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');
const extractor = fs.readFileSync(path.join(ROOT, 'lib/extractor.js'), 'utf8');
const judge = fs.readFileSync(path.join(ROOT, 'lib/judge.js'), 'utf8');

// ============ A: inject.js executeSayhiAction.request-resume 分支删干净 ============

test('A: executeSayhiAction 函数仍存在（处理 mark-unsuitable）', () => {
  assert.match(inject, /async function executeSayhiAction\(uid, action\)/);
});

test('A: executeSayhiAction 入口校验仅放行 mark-unsuitable', () => {
  // 提取整个函数体
  const m = inject.match(/async function executeSayhiAction\(uid, action\)[\s\S]*?\n  \}\n/);
  assert.ok(m, '应能定位 executeSayhiAction 函数');
  const body = m[0];
  // 入口校验：只接受 'mark-unsuitable'
  assert.match(body, /action !== 'mark-unsuitable'/);
  // 不应再有 'action === \'request-resume\'' 分支判断
  assert.doesNotMatch(body, /action === 'request-resume'/);
});

test('A: executeSayhiAction 函数体内不再含 findRequestBtn / clickRequestBtn / waitConfirmDialog 步骤', () => {
  const m = inject.match(/async function executeSayhiAction\(uid, action\)[\s\S]*?\n  \}\n/);
  assert.ok(m);
  // 这些 step name 是旧 request-resume 分支才有的
  assert.doesNotMatch(m[0], /findRequestBtn/);
  assert.doesNotMatch(m[0], /clickRequestBtn/);
  assert.doesNotMatch(m[0], /waitConfirmDialog/);
});

// ============ B: opts.overrideAction 删干净 ============

test('B: background.js 不再有 overrideAction（dead debug param）', () => {
  assert.doesNotMatch(bg, /overrideAction/);
});

test('B: executeSayhiActionForCandidate 函数签名只接 candidateId', () => {
  assert.match(bg, /async function executeSayhiActionForCandidate\(candidateId\)/);
  // 不应再有 opts 参数或 opts = opts || {}
  assert.doesNotMatch(bg, /async function executeSayhiActionForCandidate\(candidateId, opts\)/);
});

test('B: EXECUTE_SAYHI_ACTION 消息 handler 不再传 overrideAction', () => {
  // 找消息 case 块
  const m = bg.match(/case 'EXECUTE_SAYHI_ACTION':[\s\S]*?return true;/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /overrideAction/);
});

// ============ C: DETAIL_SELECTORS.description / tagItem 删干净 ============

test('C: inject.js DETAIL_SELECTORS 不再含 description 字典项', () => {
  const m = inject.match(/const DETAIL_SELECTORS = \{[\s\S]*?\};/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /description:/);
  assert.doesNotMatch(m[0], /tagItem:/);
  // 但其他字段应保留
  assert.match(m[0], /detailRoot:/);
  assert.match(m[0], /expectContent:/);
  assert.match(m[0], /workEduList:/);
  assert.match(m[0], /resumeCard:/);
});

test('C: scanDetailPanelDom 不再用 descHit / tagsHit 变量', () => {
  const m = inject.match(/function scanDetailPanelDom\(\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /descHit/);
  assert.doesNotMatch(m[0], /tagsHit/);
  // 返回字段也不该有 descText / skillTags
  assert.doesNotMatch(m[0], /descText:/);
  assert.doesNotMatch(m[0], /skillTags:/);
});

// ============ D: extractor.js desc / skillTags 字段删干净 ============

test('D: extractFromDetailPanel 返回对象不含 desc / skillTags 字段', () => {
  const m = extractor.match(/function extractFromDetailPanel\(rawScan\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /desc:\s*nz/);
  assert.doesNotMatch(m[0], /skillTags:/);
  // 仍保留 resumeFullText
  assert.match(m[0], /resumeFullText:/);
});

// ============ E: judge.js dom.desc / dom.skillTags 渲染删干净 ============

test('E: judge.js serializeCandidate 不再渲染 dom.desc / dom.skillTags', () => {
  // 在 domDetail 段（## domDetail 之后）
  const m = judge.match(/## domDetail[\s\S]*?return lines\.join\('\\n'\);/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /dom\.desc/);
  assert.doesNotMatch(m[0], /dom\.skillTags/);
  // 但 resumeFullText 应保留
  assert.match(m[0], /dom\.resumeFullText/);
});

test('E: hasContent 判断不含 dom.desc / dom.skillTags', () => {
  const m = judge.match(/const hasContent =[\s\S]*?;/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /dom\.desc\b/);
  assert.doesNotMatch(m[0], /dom\.skillTags/);
  // 保留 dom.expect / dom.workEduText / dom.baseStats / dom.resumeCardText / dom.resumeFullText
  assert.match(m[0], /dom\.expect/);
  assert.match(m[0], /dom\.resumeFullText/);
});
