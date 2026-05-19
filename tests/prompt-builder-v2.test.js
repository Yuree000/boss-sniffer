// 测试 lib/prompt-builder.js v0.12.0 三段式动态拼装

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBuilder() {
  const file = path.resolve(__dirname, '../lib/prompt-builder.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossPromptBuilder;
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
    { id: 'e', text: 'pytest' },
    { id: 'f', text: '接口测试' },
    { id: 'g', text: 'AI 测试' },
    { id: 'h', text: 'AI 工具' }
  ],
  optionalThreshold: 3
};

test('build — 入参为空抛错', () => {
  const PB = loadBuilder();
  assert.throws(() => PB.build(null), /jd 不能为空/);
  assert.throws(() => PB.build(undefined), /jd 不能为空/);
});

test('build — must 和 opt 都为空抛错', () => {
  const PB = loadBuilder();
  assert.throws(
    () => PB.build({ name: '空', mustConditions: [], optionalConditions: [], optionalThreshold: 0 }),
    /至少有一项/
  );
});

test('build — 角色行包含 JD 名称', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /你是 BOSS 直聘 HR 助手/);
  assert.match(prompt, /「测试工程师」/);
});

test('build — 必要条件以 M1/M2/M3 编号出现', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /M1\. 本科及以上学历/);
  assert.match(prompt, /M2\. 年龄不超过 34 岁/);
  assert.match(prompt, /M3\. 简历里同时出现 Python 和 Linux/);
});

test('build — 可选条件以 O1..O5 编号出现 + 阈值 3', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /可选条件（需满足 ≥ 3 个）/);
  for (let i = 1; i <= 5; i++) {
    assert.match(prompt, new RegExp('O' + i + '\\. '));
  }
  assert.match(prompt, /O1\. 自动化测试/);
  assert.match(prompt, /O5\. AI 工具/);
});

test('build — 决策规则包含集合 M / O / 阈值 K', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /M = \{M1, M2, M3\}/);
  assert.match(prompt, /O = \{O1, O2, O3, O4, O5\}/);
  assert.match(prompt, /K = 3/);
  assert.match(prompt, /satisfied >= 3/);
});

test('build — 输出 schema 包含所有 must/opt 的 JSON 模板行', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  // mustBreakdown 中 M1..M3 都要在
  for (let i = 1; i <= 3; i++) {
    assert.match(prompt, new RegExp('"M' + i + '": \\{ "value":'));
  }
  // optionalBreakdown 中 O1..O5 都要在
  for (let i = 1; i <= 5; i++) {
    assert.match(prompt, new RegExp('"O' + i + '": \\{ "value":'));
  }
});

test('build — prompt 不含 "JD 完整描述" 子段', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.doesNotMatch(prompt, /JD 完整描述/);
  assert.doesNotMatch(prompt, /jdText/);
});

test('build — prompt 不含 "token" 字样（任何 case）', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.doesNotMatch(prompt, /token/i);
});

test('build — 纯必要（N=0）, 决策规则 O 集合为空, schema 出 optionalBreakdown: {}', () => {
  const PB = loadBuilder();
  const prompt = PB.build({
    name: '纯必要',
    mustConditions: [{ id: 'a', text: '本科' }],
    optionalConditions: [],
    optionalThreshold: 0
  });
  assert.match(prompt, /M = \{M1\}/);
  assert.match(prompt, /O = \{\(空\)\}/);
  assert.match(prompt, /K = 0/);
  assert.match(prompt, /"optionalBreakdown": \{\},/);
  assert.match(prompt, /M1\. 本科/);
});

test('build — 纯可选（M=0, N=5, K=3）, mustBreakdown: {}', () => {
  const PB = loadBuilder();
  const prompt = PB.build({
    name: '纯可选',
    mustConditions: [],
    optionalConditions: [
      { id: 'a', text: '关键词A' },
      { id: 'b', text: '关键词B' },
      { id: 'c', text: '关键词C' },
      { id: 'd', text: '关键词D' },
      { id: 'e', text: '关键词E' }
    ],
    optionalThreshold: 3
  });
  assert.match(prompt, /M = \{\(空\)\}/);
  assert.match(prompt, /O = \{O1, O2, O3, O4, O5\}/);
  assert.match(prompt, /"mustBreakdown": \{\},/);
  assert.match(prompt, /O1\. 关键词A/);
});

test('build — AI CX JD（M=3 N=3 K=1）prompt 结构正确', () => {
  const PB = loadBuilder();
  const prompt = PB.build({
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
  });
  assert.match(prompt, /「AI CX」/);
  assert.match(prompt, /需满足 ≥ 1 个/);
  assert.match(prompt, /satisfied >= 1/);
  assert.match(prompt, /M3\. 简历里有西班牙语或葡萄牙语/);
});

test('build — 信息源优先级段始终存在', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /信息源优先级/);
  assert.match(prompt, /chatHistory/);
  assert.match(prompt, /bossSignals/);
});

test('build — 决策规则禁止逻辑错误段存在', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /禁止逻辑错误/);
  assert.match(prompt, /must\.value = "unknown" 但 decision = "符合"/);
});

test('buildConditionsSection / buildOutputSchemaSection 单独可调用', () => {
  const PB = loadBuilder();
  assert.equal(typeof PB.buildConditionsSection, 'function');
  assert.equal(typeof PB.buildSourcePrioritySection, 'function');
  assert.equal(typeof PB.buildDecisionRuleSection, 'function');
  assert.equal(typeof PB.buildOutputSchemaSection, 'function');
  const section = PB.buildConditionsSection(QA_JD.mustConditions, QA_JD.optionalConditions, 3);
  assert.match(section, /M1\. 本科/);
});

test('build — 不暴露 estimateTokens 函数（用户要求整产品不出现 token 估算）', () => {
  const PB = loadBuilder();
  assert.equal(PB.estimateTokens, undefined);
});

// v0.17.0.10：地址/base 类条件特殊判定细则
test('build — 决策规则含"地址 / base 类条件"特殊判定细则', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /特殊判定细则 — 地址 \/ base 类条件/);
  // 必须明确只看 basic.city 和 expectation.cityName
  assert.match(prompt, /candidate\.basic\.city/);
  assert.match(prompt, /candidate\.expectation\.cityName/);
  // 必须明确不看 workHistory[].company 地名
  assert.match(prompt, /不看.*workHistory\[\]\.company/);
  // 必须明确不看 chatHistory 推断
  assert.match(prompt, /不看.*chatHistory/);
});

// v0.17.0.10：输出强约束（治"输出不含 JSON 对象"失败）
test('build — 输出格式强制要求第一个字符为 `{`', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /必须以 `\{` 字符为第一个字符/);
  assert.match(prompt, /以 `}` 字符为最后一个字符/);
  // 禁止开头问候 / 拒绝输出
  assert.match(prompt, /不允许.*开头问候/);
  assert.match(prompt, /必须完整输出 JSON/);
});

// v0.17.0.10：reason 字段写法约束
test('build — reason 字段写法约束（M{n}.value 开头 + 禁 hedge）', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /reason 字段写法约束/);
  assert.match(prompt, /M\{n\}\.value=true\/false\/unknown/);
  // 禁止 hedge 措辞
  assert.match(prompt, /禁止使用.*百分比/);
  assert.match(prompt, /推断 70%/);
  assert.match(prompt, /缺少地址信息/);
});
