// 测试 lib/events.js v0.12.0 derivePassReason 派生逻辑

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadEvents() {
  const file = path.resolve(__dirname, '../lib/events.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossEvents;
}

const QA_JD = {
  jdId: 'qa-engineer-2026',
  name: '测试工程师',
  mustConditions: [
    { id: 'a', text: '本科及以上学历' },
    { id: 'b', text: '年龄不超过 34 岁' },
    { id: 'c', text: '简历里同时出现 Python 和 Linux' }
  ],
  optionalConditions: [
    { id: 'd', text: '自动化测试' },
    { id: 'e', text: 'pytest' }
  ],
  optionalThreshold: 1
};

test('derivePassReason — jd 缺失返回 "其他"', () => {
  const E = loadEvents();
  assert.equal(E.derivePassReason({}, {}, null), '其他');
  assert.equal(E.derivePassReason({}, {}, undefined), '其他');
  assert.equal(E.derivePassReason({}, {}, {}), '其他');  // 无 mustConditions
});

test('derivePassReason — M1=false 返回 must[0].text', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: false, reason: '专科' }, M2: { value: true }, M3: { value: true } },
    { O1: { value: true }, O2: { value: true } },
    QA_JD
  );
  assert.equal(reason, '本科及以上学历');
});

test('derivePassReason — M2=false（M1 true）返回 must[1].text', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: true }, M2: { value: false, reason: '37 岁' }, M3: { value: true } },
    { O1: { value: true }, O2: { value: true } },
    QA_JD
  );
  assert.equal(reason, '年龄不超过 34 岁');
});

test('derivePassReason — M3=unknown 返回 must[2].text + "(信息缺)"', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: true }, M2: { value: true }, M3: { value: 'unknown', reason: '简历没提 Linux' } },
    { O1: { value: true }, O2: { value: true } },
    QA_JD
  );
  assert.equal(reason, '简历里同时出现 Python 和 Linux(信息缺)');
});

test('derivePassReason — false 优先于 unknown（M1 false + M2 unknown）', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: false }, M2: { value: 'unknown' }, M3: { value: true } },
    { O1: { value: true }, O2: { value: true } },
    QA_JD
  );
  assert.equal(reason, '本科及以上学历');
});

test('derivePassReason — must 全过 + optional 不足 → "可选不足"', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: true }, M2: { value: true }, M3: { value: true } },
    { O1: { value: false }, O2: { value: false } },
    QA_JD
  );
  assert.equal(reason, '可选不足');
});

test('derivePassReason — must 全过 + optional unknown → "可选不足"（unknown 算不满足）', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: true }, M2: { value: true }, M3: { value: true } },
    { O1: { value: 'unknown' }, O2: { value: 'unknown' } },
    QA_JD
  );
  assert.equal(reason, '可选不足');
});

test('derivePassReason — JD 无 must 仅有 optional 时不足 → "可选不足"', () => {
  const E = loadEvents();
  const pureOpt = {
    name: '纯可选',
    mustConditions: [],
    optionalConditions: [{ id: 'a', text: 'AI' }],
    optionalThreshold: 1
  };
  const reason = E.derivePassReason(
    {},
    { O1: { value: false } },
    pureOpt
  );
  assert.equal(reason, '可选不足');
});

test('derivePassReason — must 文本含空格/标点都不会丢失', () => {
  const E = loadEvents();
  const reason = E.derivePassReason(
    { M1: { value: false } },
    {},
    {
      mustConditions: [{ id: 'a', text: '本科 / 硕士（双非也接受）' }],
      optionalConditions: [],
      optionalThreshold: 0
    }
  );
  assert.equal(reason, '本科 / 硕士（双非也接受）');
});

test('derivePassReason — AI CX JD 必要不达场景', () => {
  const E = loadEvents();
  const AI_CX = {
    name: 'AI CX',
    mustConditions: [
      { id: 'a', text: '本科及以上学历' },
      { id: 'b', text: '年龄不超过 28 岁' },
      { id: 'c', text: '简历里有西班牙语或葡萄牙语' }
    ],
    optionalConditions: [
      { id: 'd', text: '西班牙语/葡萄牙语专业' },
      { id: 'e', text: '语言相关等级证书' },
      { id: 'f', text: '有翻译/运营相关经验' }
    ],
    optionalThreshold: 1
  };
  // 简历没提西语/葡语 → M3 unknown
  const reason = E.derivePassReason(
    { M1: { value: true }, M2: { value: true }, M3: { value: 'unknown' } },
    { O1: { value: false }, O2: { value: false }, O3: { value: false } },
    AI_CX
  );
  assert.equal(reason, '简历里有西班牙语或葡萄牙语(信息缺)');
});
