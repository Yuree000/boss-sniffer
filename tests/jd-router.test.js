// 测试 lib/jd-router.js BossJDRouter 路由逻辑
//
// v0.21.0 · Phase 1·1c 引入；v0.25.1 重构：bossJobNames 别名 → JD.name 严格相等
//
// 跑：node --test tests/jd-router.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadRouter() {
  const file = path.resolve(__dirname, '../lib/jd-router.js');
  const code = fs.readFileSync(file, 'utf8');
  const selfObj = {};
  const ctx = { self: selfObj, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return selfObj.BossJDRouter;
}

// 共享 fixture（v0.25.1：不再有 bossJobNames 字段）
function makeTpl(jdId, name) {
  return {
    jdId: jdId,
    name: name,
    mustConditions: [{ id: 'm1', text: 'x' }],
    optionalConditions: [],
    optionalThreshold: 0
  };
}

// ========== route() 简化版 ==========

test('v0.25.1 route — 命中：jobAligned 严格相等 JD.name', () => {
  const R = loadRouter();
  const tpls = [
    makeTpl('jd1', '印尼语实习生'),
    makeTpl('jd2', 'AI CX'),
    makeTpl('jd3', '测试工程师')
  ];
  const r = R.route('AI CX', tpls);
  assert.ok(r);
  assert.equal(r.jd.jdId, 'jd2');
  assert.equal(r.jd.name, 'AI CX');
  assert.equal(r.byJobName, 'AI CX');
});

test('v0.25.1 route — jobAligned 不匹配任何 JD.name → null', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', '印尼语实习生'), makeTpl('jd2', 'AI CX')];
  assert.equal(R.route('数据分析师', tpls), null);
});

test('v0.25.1 route — jobAligned 为空 → null', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', 'AI CX')];
  assert.equal(R.route('', tpls), null);
  assert.equal(R.route(null, tpls), null);
  assert.equal(R.route(undefined, tpls), null);
});

test('v0.25.1 route — JD 模板列表为空 → null', () => {
  const R = loadRouter();
  assert.equal(R.route('AI CX', []), null);
  assert.equal(R.route('AI CX', null), null);
});

test('v0.25.1 route — trim 后匹配（候选人 jobAligned 带空格也能命中）', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', 'AI CX')];
  const r = R.route('  AI CX  ', tpls);
  assert.ok(r);
  assert.equal(r.jd.jdId, 'jd1');
});

test('v0.25.1 route — 大小写敏感（严格相等）', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', 'AI CX')];
  // "ai cx" 与 "AI CX" 不严格相等
  assert.equal(R.route('ai cx', tpls), null);
});

test('v0.25.1 route — 多个 JD 同名（异常情况）→ 取首个', () => {
  const R = loadRouter();
  const tpls = [
    makeTpl('jd1', 'AI CX'),
    makeTpl('jd2', 'AI CX')  // 同名重复
  ];
  const r = R.route('AI CX', tpls);
  assert.ok(r);
  assert.equal(r.jd.jdId, 'jd1');  // 取首个
});

// ========== routeWithDiagnosis() ==========

test('v0.25.1 routeWithDiagnosis — 命中：reason="matched", conflicts=[]', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', '印尼语实习生'), makeTpl('jd2', 'AI CX')];
  const r = R.routeWithDiagnosis('印尼语实习生', tpls);
  assert.equal(r.reason, 'matched');
  assert.equal(r.jd.jdId, 'jd1');
  assert.equal(r.byJobName, '印尼语实习生');
  assert.equal(r.conflicts.length, 0);
});

test('v0.25.1 routeWithDiagnosis — 同名冲突：conflicts 列出除首个外其他匹配', () => {
  const R = loadRouter();
  const tpls = [
    makeTpl('jd1', 'AI CX'),
    makeTpl('jd2', 'AI CX'),
    makeTpl('jd3', 'AI CX')
  ];
  const r = R.routeWithDiagnosis('AI CX', tpls);
  assert.equal(r.reason, 'matched');
  assert.equal(r.jd.jdId, 'jd1');
  assert.equal(r.conflicts.length, 2);
  assert.equal(r.conflicts[0].jdId, 'jd2');
  assert.equal(r.conflicts[1].jdId, 'jd3');
});

test('v0.25.1 routeWithDiagnosis — jobAligned 为空 → reason="no_jobAligned"', () => {
  const R = loadRouter();
  const r = R.routeWithDiagnosis('', [makeTpl('jd1', 'AI CX')]);
  assert.equal(r.reason, 'no_jobAligned');
  assert.equal(r.jd, null);
});

test('v0.25.1 routeWithDiagnosis — 模板列表为空 → reason="no_templates"', () => {
  const R = loadRouter();
  const r = R.routeWithDiagnosis('AI CX', []);
  assert.equal(r.reason, 'no_templates');
  assert.equal(r.jd, null);
});

test('v0.25.1 routeWithDiagnosis — 模板全有但都不匹配 → reason="no_match"', () => {
  const R = loadRouter();
  const tpls = [makeTpl('jd1', 'AI CX'), makeTpl('jd2', '测试工程师')];
  const r = R.routeWithDiagnosis('数据分析师', tpls);
  assert.equal(r.reason, 'no_match');
  assert.equal(r.jd, null);
});

// ========== v0.25.1：确认不再用 bossJobNames ==========

test('v0.25.1 — router 代码不再引用 bossJobNames（迁移完成）', () => {
  const file = path.resolve(__dirname, '../lib/jd-router.js');
  const code = fs.readFileSync(file, 'utf8');
  // 只允许出现在注释里（v0.25.1 历史说明），不应有 .bossJobNames 字段访问
  assert.doesNotMatch(code, /\.bossJobNames\b/);
});
