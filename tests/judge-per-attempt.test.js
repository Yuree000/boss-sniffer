// 测试 judgeCandidate 的 perAttempt 轨迹记录(成功 / 重试后成功 / 全失败 三场景)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 加载 judge.js + 注入 mock BossLLM / BossPromptBuilder
function loadJudge(mockLlm) {
  const file = path.resolve(__dirname, '../lib/judge.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = {
    self: {
      BossLLM: mockLlm,
      BossPromptBuilder: { build: function () { return 'system'; } }
    },
    console: { warn: function () {}, info: function () {}, error: function () {} },
    setTimeout: setTimeout,  // judge.js 用 sleep(delay) 在重试间退避
    Date: Date
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossJudge;
}

const JD = {
  jdId: 'qa', name: '测试',
  mustConditions: [{ id: 'a', text: '本科' }],
  optionalConditions: [{ id: 'b', text: 'AI' }],
  optionalThreshold: 1
};

const CAND = { candidateId: 'c1', basic: { name: '张三' } };
const CFG = { apiKey: 'sk-x', model: 'm', providerName: 'Test', protocol: 'anthropic-messages' };

function validParsed() {
  return JSON.stringify({
    decision: 'pass',
    mustBreakdown: { M1: { value: true, reason: 'ok' } },
    optionalBreakdown: { O1: { value: false, reason: 'no' } },
    reason: '理由'
  });
}

test('一次成功 → perAttempt 长度 1,error=null', async () => {
  let calls = 0;
  const J = loadJudge({
    callLlm: async function () { calls++; return { text: validParsed(), usage: null }; },
    parseJsonOutput: function (s) { return JSON.parse(s); }
  });
  const out = await J.judgeCandidate(CAND, JD, CFG);
  assert.equal(calls, 1);
  assert.equal(out.attempts, 1);
  assert.equal(Array.isArray(out.perAttempt), true);
  assert.equal(out.perAttempt.length, 1);
  assert.equal(out.perAttempt[0].error, null);
  assert.equal(out.perAttempt[0].errorName, null);
  assert.ok(typeof out.perAttempt[0].latencyMs === 'number');
});

test('重试 2 次后成功 → perAttempt 长度 3,前两个 error 非空', async () => {
  let calls = 0;
  const J = loadJudge({
    callLlm: async function () {
      calls++;
      if (calls < 3) {
        const e = new Error('Wiz HTTP 500');
        e.name = 'LLMHttpError';
        e.status = 500;
        e.body = '<html>bad gateway</html>';
        throw e;
      }
      return { text: validParsed(), usage: null };
    },
    parseJsonOutput: function (s) { return JSON.parse(s); }
  });
  const out = await J.judgeCandidate(CAND, JD, CFG);
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
  assert.equal(out.perAttempt.length, 3);
  assert.equal(out.perAttempt[0].errorName, 'LLMHttpError');
  assert.equal(out.perAttempt[0].httpStatus, 500);
  assert.equal(out.perAttempt[0].errorBody, '<html>bad gateway</html>');
  assert.equal(out.perAttempt[1].errorName, 'LLMHttpError');
  assert.equal(out.perAttempt[2].error, null);
});

test('3 次全失败 → 抛错且 err.perAttempt 长度 3', async () => {
  const J = loadJudge({
    callLlm: async function () {
      const e = new Error('timeout 30000ms');
      e.name = 'LLMHttpError';
      throw e;
    },
    parseJsonOutput: function (s) { return JSON.parse(s); }
  });
  let thrown = null;
  try {
    await J.judgeCandidate(CAND, JD, CFG);
  } catch (e) { thrown = e; }
  assert.ok(thrown, '应该抛错');
  assert.equal(Array.isArray(thrown.perAttempt), true);
  assert.equal(thrown.perAttempt.length, 3);
  assert.equal(thrown.attempts, 3);
  assert.ok(typeof thrown.totalLatencyMs === 'number');
  thrown.perAttempt.forEach(function (a) {
    assert.equal(a.errorName, 'LLMHttpError');
    assert.ok(a.error.length > 0);
  });
});

test('LLMResponseError 透传 rawText 到 perAttempt.rawLlmText', async () => {
  const J = loadJudge({
    callLlm: async function () { return { text: 'I am not JSON at all', usage: null }; },
    parseJsonOutput: function (text) {
      // 模拟 llm-client.parseJsonOutput 抛 LLMResponseError 时附 rawText
      const e = new Error('LLM 输出不含 JSON 对象');
      e.name = 'LLMResponseError';
      e.rawText = String(text);
      throw e;
    }
  });
  let thrown = null;
  try { await J.judgeCandidate(CAND, JD, CFG); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.perAttempt[0].errorName, 'LLMResponseError');
  assert.equal(thrown.perAttempt[0].rawLlmText, 'I am not JSON at all');
});

test('JudgeSchemaError → rawLlmText 从 parsed JSON.stringify 兜底', async () => {
  // LLM 给了能 parse 但 schema 校验不通过的 JSON
  const badParsed = {
    decision: '不确定',  // 非法 decision
    mustBreakdown: { M1: { value: true, reason: 'x' } },
    optionalBreakdown: { O1: { value: true, reason: 'y' } },
    reason: ''
  };
  const J = loadJudge({
    callLlm: async function () { return { text: JSON.stringify(badParsed), usage: null }; },
    parseJsonOutput: function (s) { return JSON.parse(s); }
  });
  let thrown = null;
  try { await J.judgeCandidate(CAND, JD, CFG); } catch (e) { thrown = e; }
  assert.ok(thrown);
  // schema 错 3 次都失败,任取一条断言
  assert.equal(thrown.perAttempt[0].errorName, 'JudgeSchemaError');
  assert.ok(thrown.perAttempt[0].rawLlmText, 'rawLlmText 应回填 parsed JSON');
  assert.ok(thrown.perAttempt[0].rawLlmText.indexOf('不确定') !== -1);
});

test('errorBody 超 1KB 触发截断,rawLlmText 超 2KB 触发截断', async () => {
  const longBody = 'x'.repeat(2000);
  const longRaw = 'y'.repeat(3000);
  const J = loadJudge({
    callLlm: async function () {
      const e = new Error('500');
      e.name = 'LLMHttpError';
      e.status = 500;
      e.body = longBody;
      throw e;
    },
    parseJsonOutput: function () { throw new Error('not reached'); }
  });
  let thrown = null;
  try { await J.judgeCandidate(CAND, JD, CFG); } catch (e) { thrown = e; }
  const a = thrown.perAttempt[0];
  assert.ok(a.errorBody.length < 1100, 'errorBody 应截断到 ~1024');
  assert.ok(a.errorBody.indexOf('截断') !== -1);

  // 再测 rawLlmText 截断
  const J2 = loadJudge({
    callLlm: async function () { return { text: longRaw, usage: null }; },
    parseJsonOutput: function (text) {
      const e = new Error('bad');
      e.name = 'LLMResponseError';
      e.rawText = String(text);
      throw e;
    }
  });
  try { await J2.judgeCandidate(CAND, JD, CFG); } catch (e) { thrown = e; }
  assert.ok(thrown.perAttempt[0].rawLlmText.length < 2100);
  assert.ok(thrown.perAttempt[0].rawLlmText.indexOf('截断') !== -1);
});

test('不可重试错(LLMConfigError)立即抛,perAttempt 长度 1', async () => {
  let calls = 0;
  const J = loadJudge({
    callLlm: async function () {
      calls++;
      const e = new Error('401 鉴权失败');
      e.name = 'LLMHttpError';
      e.status = 401;
      throw e;
    },
    parseJsonOutput: function () { throw new Error('not reached'); }
  });
  let thrown = null;
  try { await J.judgeCandidate(CAND, JD, CFG); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(calls, 1, '4xx 不应重试');
  assert.equal(thrown.perAttempt.length, 1);
  assert.equal(thrown.perAttempt[0].httpStatus, 401);
});
