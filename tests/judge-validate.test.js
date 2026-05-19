// 测试 lib/judge.js v0.12.0 动态 validateOutput

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadJudge() {
  const file = path.resolve(__dirname, '../lib/judge.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossJudge;
}

const QA_JD = {
  jdId: 'qa-engineer-2026',
  name: '测试工程师',
  mustConditions: [
    { id: 'a', text: '本科' },
    { id: 'b', text: '年龄 34' },
    { id: 'c', text: 'Python Linux' }
  ],
  optionalConditions: [
    { id: 'd', text: '自动化' },
    { id: 'e', text: 'pytest' }
  ],
  optionalThreshold: 1
};

// 完整合法的输出
function fullValid() {
  return {
    decision: 'pass',
    mustBreakdown: {
      M1: { value: true, reason: 'ok' },
      M2: { value: false, reason: '37' },
      M3: { value: 'unknown', reason: '没提到' }
    },
    optionalBreakdown: {
      O1: { value: true, reason: 'auto' },
      O2: { value: false, reason: 'no' }
    },
    reason: '年龄超 34'
  };
}

test('validateOutput — 完整合法输出通过', () => {
  const J = loadJudge();
  J.validateOutput(fullValid(), QA_JD);
});

test('validateOutput — null / 非对象抛错', () => {
  const J = loadJudge();
  assert.throws(() => J.validateOutput(null, QA_JD), /LLM 输出不是对象/);
  assert.throws(() => J.validateOutput('text', QA_JD), /LLM 输出不是对象/);
  assert.throws(() => J.validateOutput(42, QA_JD), /LLM 输出不是对象/);
});

test('validateOutput — decision 非法抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  bad.decision = '不确定';
  assert.throws(() => J.validateOutput(bad, QA_JD), /decision 非法/);
  bad.decision = null;
  assert.throws(() => J.validateOutput(bad, QA_JD), /decision 非法/);
});

test('validateOutput — 缺 mustBreakdown 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  delete bad.mustBreakdown;
  assert.throws(() => J.validateOutput(bad, QA_JD), /缺 mustBreakdown/);
});

test('validateOutput — 缺 optionalBreakdown 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  delete bad.optionalBreakdown;
  assert.throws(() => J.validateOutput(bad, QA_JD), /缺 optionalBreakdown/);
});

test('validateOutput — 缺 M2 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  delete bad.mustBreakdown.M2;
  assert.throws(() => J.validateOutput(bad, QA_JD), /mustBreakdown 缺 M2/);
});

test('validateOutput — 多出 M4 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  bad.mustBreakdown.M4 = { value: true, reason: 'extra' };
  assert.throws(() => J.validateOutput(bad, QA_JD), /键数不匹配|超出范围/);
});

test('validateOutput — M2 value 是数字 3 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  bad.mustBreakdown.M2.value = 3;
  assert.throws(() => J.validateOutput(bad, QA_JD), /M2 value 非法/);
});

test('validateOutput — O1 value 是 "maybe" 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  bad.optionalBreakdown.O1.value = 'maybe';
  assert.throws(() => J.validateOutput(bad, QA_JD), /O1 value 非法/);
});

test('validateOutput — mustBreakdown 含非法 key (X1) 抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  delete bad.mustBreakdown.M3;
  bad.mustBreakdown.X1 = { value: true, reason: 'bad key' };
  assert.throws(() => J.validateOutput(bad, QA_JD), /缺 M3|非法 key/);
});

test('validateOutput — mustBreakdown 是数组抛错', () => {
  const J = loadJudge();
  const bad = fullValid();
  bad.mustBreakdown = [{ value: true }];
  assert.throws(() => J.validateOutput(bad, QA_JD), /mustBreakdown 必须是对象/);
});

test('validateOutput — M=0 (纯可选 JD)，mustBreakdown: {} 通过', () => {
  const J = loadJudge();
  const pureOpt = {
    name: '纯可选',
    mustConditions: [],
    optionalConditions: [{ id: 'a', text: 'AI' }],
    optionalThreshold: 1
  };
  J.validateOutput({
    decision: '符合',
    mustBreakdown: {},
    optionalBreakdown: { O1: { value: true, reason: 'ai 命中' } },
    reason: '可选满足'
  }, pureOpt);
});

test('validateOutput — N=0 (纯必要 JD)，optionalBreakdown: {} 通过', () => {
  const J = loadJudge();
  const pureMust = {
    name: '纯必要',
    mustConditions: [{ id: 'a', text: '本科' }],
    optionalConditions: [],
    optionalThreshold: 0
  };
  J.validateOutput({
    decision: '符合',
    mustBreakdown: { M1: { value: true, reason: 'ok' } },
    optionalBreakdown: {},
    reason: 'must 满足且无可选'
  }, pureMust);
});

test('validateOutput — M=0 但 LLM 给了 M1 仍报错', () => {
  const J = loadJudge();
  const pureOpt = {
    name: '纯可选',
    mustConditions: [],
    optionalConditions: [{ id: 'a', text: 'AI' }],
    optionalThreshold: 1
  };
  const bad = {
    decision: '符合',
    mustBreakdown: { M1: { value: true, reason: 'should not exist' } },
    optionalBreakdown: { O1: { value: true, reason: 'ok' } },
    reason: ''
  };
  assert.throws(() => J.validateOutput(bad, pureOpt), /键数不匹配|超出范围/);
});

test('暴露 API — 不再含 VALID_VALUES (7 维已删)', () => {
  const J = loadJudge();
  assert.equal(J.VALID_VALUES, undefined);
  // vm.runInNewContext 下 Array 不同源，逐项断言更稳
  assert.equal(J.VALID_DECISIONS.length, 2);
  assert.equal(J.VALID_DECISIONS[0], '符合');
  assert.equal(J.VALID_DECISIONS[1], 'pass');
  assert.equal(typeof J.validateOutput, 'function');
  assert.equal(typeof J.judgeCandidate, 'function');
  assert.equal(typeof J.serializeCandidate, 'function');
});
