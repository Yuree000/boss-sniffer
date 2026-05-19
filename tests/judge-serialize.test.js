// 测试 lib/judge.js 的 serializeCandidate —— LLM 输入序列化是否干净
// v0.15.2 关键回归点：candidate.expectation.jobAligned 字段保留在对象中，
// 但 LLM prompt 里不出现（避免"jobAligned: 印尼语实习生"误导 LLM）。
//
// 跑：node --test tests/judge-serialize.test.js

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

function sampleCandidate(overrides) {
  const base = {
    candidateId: 'CAND-001',
    basic: {
      name: '张三', age: '24岁', gender: 0,
      education: '本科', yearsOfExperience: '26届应届',
      city: '南京', activeStatus: '今日活跃', desc: null
    },
    expectation: {
      candidateOwn: '总助/CEO 助理',
      jobAligned: '印尼语实习生',  // 这个不该出现在 prompt 里
      salaryDesc: '130-180元/天',
      salaryLow: 130,
      salaryHigh: 180,
      cityName: '南京'
    },
    workHistory: [],
    education: [
      { from: '2022-09', to: '2026-06', school: '吉林师范大学', major: '印尼语', degree: '本科', degreeCode: 203 }
    ],
    bossSignals: {
      highlightWords: ['印尼语'],
      markWords: null,
      bothTalked: true
    }
  };
  return Object.assign({}, base, overrides || {});
}

test('v0.15.2 — jobAligned 字段保留在 candidate 对象中（不破坏 sidepanel / 调试）', () => {
  const J = loadJudge();
  const c = sampleCandidate();
  // 字段层面：candidate.expectation.jobAligned 仍存在
  assert.equal(c.expectation.jobAligned, '印尼语实习生');
  // 序列化结果可被调用（不会因字段而报错）
  const prompt = J.serializeCandidate(c);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

test('v0.15.2 — jobAligned 不再出现在 LLM prompt 文本里', () => {
  const J = loadJudge();
  const prompt = J.serializeCandidate(sampleCandidate());
  // 关键回归：prompt 不含 jobAligned 字段名 也不含"印尼语实习生"这个 HR JD 名值
  assert.equal(prompt.indexOf('jobAligned'), -1, 'jobAligned 字段名仍然泄漏到 prompt');
  assert.equal(prompt.indexOf('印尼语实习生'), -1, '印尼语实习生（HR JD 名）泄漏到 prompt');
});

test('v0.15.2 — expectation 段其他字段仍正常输出（candidateOwn / salaryDesc / cityName）', () => {
  const J = loadJudge();
  const prompt = J.serializeCandidate(sampleCandidate());
  assert.match(prompt, /## expectation（期望）/);
  assert.match(prompt, /candidateOwn: 总助\/CEO 助理/);
  assert.match(prompt, /salaryDesc: 130-180元\/天/);
  assert.match(prompt, /cityName（期望城市）: 南京/);
});

test('v0.15.2 — jobAligned 为 null 时同样不漏（防御 candidate 不同来源 schema）', () => {
  const J = loadJudge();
  const c = sampleCandidate({
    expectation: { candidateOwn: 'X', jobAligned: null, salaryDesc: '10K', cityName: '南宁' }
  });
  const prompt = J.serializeCandidate(c);
  assert.equal(prompt.indexOf('jobAligned'), -1);
  assert.match(prompt, /candidateOwn: X/);
});

test('v0.15.2 — chatHistory 仍正常渲染（v0.15.1 回归覆盖）', () => {
  const J = loadJudge();
  const c = sampleCandidate({
    chatHistory: [
      { mid: '1', time: 100, from: { uid: 'CAND-001', name: '张三' }, to: { uid: 'HR', name: 'h' }, text: '我是印尼留学生', kind: 'text', role: 'candidate' },
      { mid: '2', time: 200, from: { uid: 'HR', name: 'h' }, to: { uid: 'CAND-001', name: '张三' }, text: '你印尼语水平如何', kind: 'text', role: 'hr' }
    ]
  });
  const prompt = J.serializeCandidate(c);
  assert.match(prompt, /## chatHistory（聊天，最高优先级）/);
  assert.match(prompt, /我是印尼留学生/);
  assert.match(prompt, /你印尼语水平如何/);
});

// v0.17.0.10 POC A7 回灌：domDetail 段渲染
// v0.18.0 死代码清理：desc / skillTags 字段已删，prompt 里不再渲染
//   简介+技能信息现在统一由 resumeFullText（在线简历 iframe）承载
test('v0.17.0.10 / v0.18.0 — domDetail 段渲染多城市原文 + 工作经历 DOM 文本（无 desc/skillTags）', () => {
  const J = loadJudge();
  const c = sampleCandidate({
    bossSignals: {
      highlightWords: ['印尼语'],
      domDetail: {
        scannedAt: 1779076079678,
        baseStats: '26岁3年本科',
        expect: {
          prefix: '期望',
          original: '玉林 & 南宁 · 西班牙语翻译 5-6K',
          cityRaw: '玉林 & 南宁',
          cities: ['玉林', '南宁'],
          jobRaw: '西班牙语翻译',
          salaryRaw: '5-6K'
        },
        workEduText: '康泊斯流体技术 · 西班牙语翻译 浙江外国语学院 · 西班牙语言文学 · 本科',
        resumeCardText: '5月17日 沟通的职位-西语实习生'
      }
    }
  });
  const prompt = J.serializeCandidate(c);
  assert.match(prompt, /## domDetail（沟通页详情面板 DOM 实际显示，次高优先级）/);
  assert.match(prompt, /baseStats（DOM 摘要）: 26岁3年本科/);
  assert.match(prompt, /expect\.cityRaw（期望工作城市原文）: 玉林 & 南宁/);
  assert.match(prompt, /expect\.cities（拆分后多城市数组）: 玉林 \| 南宁/);
  assert.match(prompt, /expect\.jobRaw: 西班牙语翻译/);
  assert.match(prompt, /expect\.salaryRaw: 5-6K/);
  assert.match(prompt, /workEduText（工作\+教育混合，BOSS UI 完整文本）: 康泊斯流体技术/);
  assert.match(prompt, /resumeCard（BOSS 简历卡片消息）: 5月17日/);
  // v0.18.0：desc / skillTags 不再渲染
  assert.doesNotMatch(prompt, /desc（个人简介长文本/);
  assert.doesNotMatch(prompt, /skillTags:/);
});

test('v0.17.0.10 — domDetail 字段为 null 时不渲染段（向后兼容）', () => {
  const J = loadJudge();
  const prompt = J.serializeCandidate(sampleCandidate());
  assert.equal(prompt.indexOf('## domDetail'), -1, 'domDetail 段在没有 DOM 数据时泄漏');
});

test('v0.17.0.10 — prompt-builder 信息源优先级段含 domDetail', () => {
  const file = path.resolve(__dirname, '../lib/prompt-builder.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  const PB = ctx.self.BossPromptBuilder;
  const prompt = PB.build({
    name: 'test', mustConditions: [{ id: 'a', text: '本科' }],
    optionalConditions: [], optionalThreshold: 0
  });
  assert.match(prompt, /domDetail（沟通页详情面板 DOM 实际显示文本/);
  assert.match(prompt, /与简历字段冲突时按 DOM 走/);
});

