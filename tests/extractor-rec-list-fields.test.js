// 测试 v0.15.4 新增的 7 个字段：
//   workHistory: industry / workType / workMonths
//   education:   eduDescription / eduType
//   expectation: expectType
//   basic:       freshGraduate
// 覆盖 extractor.js（rec/geek/list + bossGetGeek 两条路径）+ judge.js 序列化两端。
//
// 跑：node --test tests/extractor-rec-list-fields.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadExtractor() {
  const file = path.resolve(__dirname, '../lib/extractor.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossExtractor;
}

function loadJudge() {
  const file = path.resolve(__dirname, '../lib/judge.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossJudge;
}

// rec/geek/list 单条 item 的最小可用样本
function buildRecItem(overrides) {
  const base = {
    encryptGeekId: 'ENC-1',
    activeTimeDesc: '今日活跃',
    haveChatted: false,
    recommendReason: '匹配岗位推荐',
    showWorks: [
      {
        startDate: '2024-06', endDate: '2025-06',
        company: 'XX 公司', positionName: '运营实习',
        responsibility: '负责活动',
        industry: '互联网/IT', workType: 3, workMonths: 12
      }
    ],
    showEdus: [
      {
        startDate: '2022-09', endDate: '2026-06',
        school: '吉林师范', major: '印尼语', degree: 203, degreeName: '本科',
        eduDescription: '2024 赴印尼大学交换 1 学期 / GPA 3.8',
        eduType: 1
      }
    ],
    geekCard: {
      geekId: 'CAND-REC-001',
      geekName: '张三', ageDesc: '24岁', geekGender: 0,
      geekDegree: '本科', geekWorkYear: '应届',
      expectLocationName: '南京',
      geekAvatar: 'http://x.png',
      geekDesc: { content: '我希望从事印尼语相关实习' },
      expectPositionName: '运营 / 翻译',
      salary: '130-180元/天', lowSalary: 130, highSalary: 180,
      matches: ['印尼语'],
      markWords: null,
      viewed: false,
      applyStatusDesc: null,
      // ⭐ v0.15.4 新增 2 字段
      expectType: 3,
      freshGraduate: 1
    }
  };
  if (overrides && overrides.geekCard) {
    base.geekCard = Object.assign({}, base.geekCard, overrides.geekCard);
    delete overrides.geekCard;
  }
  return Object.assign(base, overrides || {});
}

// bossGetGeek（最新 tab）单条 item 的最小可用样本
function buildLatestItem(overrides) {
  const base = {
    encryptGeekId: 'ENC-2',
    activeTimeDesc: '昨日活跃',
    haveChatted: true,
    geekCard: {
      geekId: 'CAND-LAT-001',
      geekName: '李四', ageDesc: '23岁', geekGender: 1,
      geekDegree: '本科', geekWorkYear: '在读',
      expectLocationName: '南宁',
      geekDesc: { content: '希望毕业前找一份实习' },
      expectPositionName: '翻译',
      salary: '面议',
      matches: ['印尼语'],
      highLightMatches: ['留学'],
      geekWorks: [
        {
          startDate: '2025-03', endDate: '2025-08',
          company: 'YY 公司', positionName: '翻译实习',
          responsibility: '陪同翻译',
          industry: '教育', workType: 3, workMonths: 5
        }
      ],
      geekEdus: [
        {
          startDate: '2023-09', endDate: '2027-06',
          school: 'A 大学', major: '印尼语', degree: 203, degreeName: '本科',
          eduDescription: '一年印尼海外交换',
          eduType: 1
        }
      ],
      expectType: 3,
      freshGraduate: 0
    }
  };
  if (overrides && overrides.geekCard) {
    base.geekCard = Object.assign({}, base.geekCard, overrides.geekCard);
    delete overrides.geekCard;
  }
  return Object.assign(base, overrides || {});
}

test('extractOneFromRecList — workHistory 含 industry / workType / workMonths', () => {
  const E = loadExtractor();
  const c = E.extractFromRecList({ zpData: { geekList: [buildRecItem()] } })[0];
  assert.equal(c.workHistory.length, 1);
  const w = c.workHistory[0];
  assert.equal(w.industry, '互联网/IT');
  assert.equal(w.workType, 3);
  assert.equal(w.workMonths, 12);
});

test('extractOneFromRecList — education 含 eduDescription / eduType', () => {
  const E = loadExtractor();
  const c = E.extractFromRecList({ zpData: { geekList: [buildRecItem()] } })[0];
  assert.equal(c.education.length, 1);
  const e = c.education[0];
  assert.match(e.eduDescription, /印尼大学交换/);
  assert.match(e.eduDescription, /GPA 3\.8/);
  assert.equal(e.eduType, 1);
});

test('extractOneFromRecList — expectation 含 expectType / basic 含 freshGraduate', () => {
  const E = loadExtractor();
  const c = E.extractFromRecList({ zpData: { geekList: [buildRecItem()] } })[0];
  assert.equal(c.expectation.expectType, 3);
  assert.equal(c.basic.freshGraduate, 1);
});

test('extractOneFromLatestList — workHistory / education 同样含 7 字段集', () => {
  const E = loadExtractor();
  const c = E.extractFromLatestList({ zpData: { geekList: [buildLatestItem()] } })[0];
  assert.equal(c.workHistory[0].industry, '教育');
  assert.equal(c.workHistory[0].workType, 3);
  assert.equal(c.workHistory[0].workMonths, 5);
  assert.match(c.education[0].eduDescription, /印尼海外交换/);
  assert.equal(c.education[0].eduType, 1);
  assert.equal(c.expectation.expectType, 3);
  assert.equal(c.basic.freshGraduate, 0);
});

test('extractOneFromRecList — 字段缺失时新 7 字段为 null（不报错）', () => {
  const E = loadExtractor();
  const minimal = {
    encryptGeekId: 'ENC-min',
    showWorks: [{ startDate: '2024', endDate: '2025', company: '甲', positionName: '乙' }],
    showEdus: [{ startDate: '2022', endDate: '2026', school: '丙', major: '丁', degreeName: '本科' }],
    geekCard: {
      geekId: 'CAND-MIN',
      geekName: '无字段',
      expectLocationName: '南京'
    }
  };
  const c = E.extractFromRecList({ zpData: { geekList: [minimal] } })[0];
  assert.equal(c.workHistory[0].industry, null);
  assert.equal(c.workHistory[0].workType, null);
  assert.equal(c.workHistory[0].workMonths, null);
  assert.equal(c.education[0].eduDescription, null);
  assert.equal(c.education[0].eduType, null);
  assert.equal(c.expectation.expectType, null);
  assert.equal(c.basic.freshGraduate, null);
});

test('serializeCandidate — 7 个新字段全部渲染到 prompt', () => {
  const E = loadExtractor();
  const J = loadJudge();
  const c = E.extractFromRecList({ zpData: { geekList: [buildRecItem()] } })[0];
  const prompt = J.serializeCandidate(c);
  // workHistory 段
  assert.match(prompt, /industry: 互联网\/IT/);
  assert.match(prompt, /workType（BOSS 原始枚举）: 3/);
  assert.match(prompt, /workMonths: 12/);
  // education 段
  assert.match(prompt, /eduDescription: .*印尼大学交换/);
  assert.match(prompt, /eduType（BOSS 原始枚举）: 1/);
  // expectation 段
  assert.match(prompt, /expectType（BOSS 原始枚举）: 3/);
  // basic 段
  assert.match(prompt, /freshGraduate（BOSS 原始枚举）: 1/);
});

test('serializeCandidate — freshGraduate=0 / expectType=0 也渲染（0 是合法枚举不是 null）', () => {
  const J = loadJudge();
  const c = {
    candidateId: 'X',
    basic: { name: '甲', freshGraduate: 0 },
    expectation: { candidateOwn: '运营', expectType: 0 },
    workHistory: [],
    education: []
  };
  const prompt = J.serializeCandidate(c);
  assert.match(prompt, /freshGraduate（BOSS 原始枚举）: 0/);
  assert.match(prompt, /expectType（BOSS 原始枚举）: 0/);
});

test('serializeCandidate — 字段全 null 不渲染（保持 prompt 简洁）', () => {
  const J = loadJudge();
  const c = {
    candidateId: 'Y',
    basic: { name: '乙', freshGraduate: null },
    expectation: { candidateOwn: '运营', expectType: null },
    workHistory: [{ company: '甲', title: '乙', timeDesc: '2024-2025', industry: null, workType: null, workMonths: null }],
    education: [{ from: '2022', to: '2026', school: '丙', major: '丁', degree: '本科', eduDescription: null, eduType: null }]
  };
  const prompt = J.serializeCandidate(c);
  assert.equal(prompt.indexOf('freshGraduate'), -1);
  assert.equal(prompt.indexOf('expectType'), -1);
  assert.equal(prompt.indexOf('industry:'), -1);
  assert.equal(prompt.indexOf('workType（'), -1);
  assert.equal(prompt.indexOf('workMonths:'), -1);
  assert.equal(prompt.indexOf('eduDescription'), -1);
  assert.equal(prompt.indexOf('eduType'), -1);
});
