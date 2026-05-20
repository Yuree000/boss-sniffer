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

// v0.24.0：删 v0.17.0.10 地址/base 类细则 + v0.23.1 学历类细则
// 范式转变：从"字段查表心智"转"语义综合心智"，新通则覆盖所有维度
test('v0.24.0: build — 删除旧「地址 / base 类条件」细则段（字段查表心智已废弃）', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.doesNotMatch(prompt, /特殊判定细则 — 地址 \/ base 类条件/);
  assert.doesNotMatch(prompt, /特殊判定细则 — 学历类条件/);
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

// v0.24.0：综合判定原则段（替代旧地址/学历细则的新心智）
// 范式转变：从"字段查表"心智 → "语义综合"心智
//   旧：prompt 硬编码"学历类查 6 个字段、地址类查 2 个字段"
//   新：LLM 识别 must 文本涉及的语义维度 → 扫遍全部字段 → 三态判定
// 优点：未来新增 JD/维度（语言/工龄/年龄/学校/行业等）0 改 prompt
test('v0.24.0: build — 综合判定原则段存在 + 三步法明示', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /综合判定原则（覆盖通则，适用所有 must \/ optional 条件）/);
  // 心智反字段查表
  assert.match(prompt, /不要按字段名查表/);
  // 三步法
  assert.match(prompt, /1\. 识别 must 文本涉及的语义维度/);
  assert.match(prompt, /2\. 扫遍 candidate 所有字段/);
  assert.match(prompt, /3\. 按以下三态判定 m\.value/);
});

test('v0.24.0: build — 三态判定逻辑（true / false / unknown）明示', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /任一字段含 must 关键词、同义表达或更优表达 → true/);
  assert.match(prompt, /任一字段含明确反证.*→ false/);
  assert.match(prompt, /仅有模糊暗示 \/ 全无该维度信息 → unknown/);
});

test('v0.24.0: build — 信息源优先级在原则段内重申', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  // 优先级顺序在通则段就有，但 v0.24.0 原则段三步法也复述一遍（强化）
  assert.match(prompt, /chatHistory > domDetail > 简历字段 > bossSignals/);
});

// few-shot 示例选 "销售经验" + "懂日语" 而非"学历"/"城市"
// 故意避开已知踩坑维度，让 LLM 学方法论而非补丁
test('v0.24.0: build — 示例 1 销售经验（含 4 个子情景）', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /示例 1 · must "5 年以上销售经验"/);
  // 4 个子情景：workHistory 含销售 / bossSignals 含同样 / 全是行政 / 全空
  assert.match(prompt, /销售总监 2017-2024.*→ true/);
  assert.match(prompt, /非简历字段也算强证据/);
  assert.match(prompt, /workHistory 全是行政岗 → false/);
  assert.match(prompt, /工作经历类字段全空 → unknown/);
});

test('v0.24.0: build — 示例 2 懂日语（含 chatHistory 自述强证据）', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /示例 2 · must "懂日语"/);
  // 强证据形式：N1 / 专业 / 工作年限 / 候选人自述
  assert.match(prompt, /日语 N1.*日语专业.*在日本工作/);
  // 候选人自述算强证据（覆盖之前 chatHistory 优先级被埋没的盲点）
  assert.match(prompt, /chatHistory 候选人说.*我可以用日语沟通.*→ true（候选人自述算强证据）/);
  // 反例：在日企不等于会日语
  assert.match(prompt, /在日企不等于会日语/);
});

// 「不能反推」铁律 — 替代旧地址类排他规则，但泛化到所有维度
test('v0.24.0: build — 「不能反推」铁律段 + 5 条具体反推案例', () => {
  const PB = loadBuilder();
  const prompt = PB.build(QA_JD);
  assert.match(prompt, /「不能反推」铁律/);
  assert.match(prompt, /某个事实暗示另一个事实，但不蕴含 → 不算证据/);
  // 5 条不同维度的反推例子（年龄/地点/技术/应届/学校）
  assert.match(prompt, /年龄 26 岁 ⇏ 学历是本科/);
  assert.match(prompt, /workHistory 公司在广州 ⇏ 候选人 base 在广州/);
  assert.match(prompt, /在 SAP 公司工作 ⇏ 候选人会 SAP/);
  assert.match(prompt, /应届生 ⇏ 学历是本科/);
  assert.match(prompt, /学校名声好 ⇏ 个人能力强/);
  // 一句话泛化收尾
  assert.match(prompt, /看起来像但不蕴含.*判 unknown 不要硬猜/);
});
