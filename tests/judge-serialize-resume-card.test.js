// v0.17.0.9 回灌测试:serializeCandidate 喂入 bossSignals.resumeCard 字段到 LLM prompt

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

function makeCandidateWithResumeCard() {
  return {
    candidateId: '604100646',
    basic: {
      name: 'Sisca',
      age: '21岁',
      education: '本科',
      yearsOfExperience: '27年应届生',
      city: '沈阳',
      desc: null   // chat/geek/info 没返回 desc
    },
    expectation: {
      candidateOwn: '咨询/翻译',
      salaryDesc: '3-7K'
    },
    workHistory: [],
    education: [
      { from: '2023', to: '2027', school: '大连外国语大学', major: '印度尼西亚语', degree: '本科' }
    ],
    bossSignals: {
      highlightWords: ['印尼语', '留学'],
      // POC A6 回灌新增字段
      resumeCard: {
        candidateId: '604100646',
        applyStatus: '在校-月内到岗',
        content1: '求职期望  咨询/翻译',
        content2: '毕业于 大连外国语大学 | 印度尼西亚语',
        content3: null,
        bottomText: '5月16日 沟通的职位-印尼语实习生',
        position: '期望:咨询/翻译(行业)',
        experiences: [
          { organization: '大连外国语大学', occupation: '印度尼西亚语', startDate: '2023', endDate: '2027', type: 2 }
        ]
      }
    },
    chatHistory: []
  };
}

test('serializeCandidate basic 区含 applyStatus(来自 bossSignals.resumeCard)', () => {
  const J = loadJudge();
  const text = J.serializeCandidate(makeCandidateWithResumeCard());
  assert.match(text, /applyStatus.*简历卡片.*在校-月内到岗/);
});

test('serializeCandidate bossSignals 区含 content1 / content2 / bottomText / position', () => {
  const J = loadJudge();
  const text = J.serializeCandidate(makeCandidateWithResumeCard());
  assert.match(text, /bossResumeCard\.content1.*求职期望/);
  assert.match(text, /bossResumeCard\.content2.*毕业于 大连外国语大学/);
  assert.match(text, /bossResumeCard\.bottomText.*印尼语实习生/);
  assert.match(text, /bossResumeCard\.position.*咨询\/翻译/);
});

test('serializeCandidate bossSignals 区含 experiences 简版教育经历', () => {
  const J = loadJudge();
  const text = J.serializeCandidate(makeCandidateWithResumeCard());
  assert.match(text, /bossResumeCard\.experiences\[0\].*大连外国语大学.*印度尼西亚语/);
});

test('serializeCandidate 无 resumeCard 时,bossSignals 区也不出现 resumeCard 行(不输出空字段)', () => {
  const J = loadJudge();
  const c = makeCandidateWithResumeCard();
  delete c.bossSignals.resumeCard;
  const text = J.serializeCandidate(c);
  // applyStatus 字段不应出现(因为 bossSignals.resumeCard 整个空)
  assert.equal(text.indexOf('applyStatus（来自 BOSS 简历卡片消息）'), -1);
  assert.equal(text.indexOf('bossResumeCard'), -1);
});

test('serializeCandidate resumeCard 部分字段缺失不影响其它字段输出', () => {
  const J = loadJudge();
  const c = makeCandidateWithResumeCard();
  c.bossSignals.resumeCard.content2 = null;
  c.bossSignals.resumeCard.experiences = null;
  const text = J.serializeCandidate(c);
  // content1 / bottomText / position 应仍输出
  assert.match(text, /bossResumeCard\.content1.*求职期望/);
  assert.match(text, /bossResumeCard\.bottomText/);
  // content2 / experiences 不输出
  assert.equal(text.indexOf('content2'), -1);
  assert.equal(text.indexOf('experiences'), -1);
});

test('serializeCandidate basic.applyStatus 来自 resumeCard,不与 chat/geek/info 的 basic.activeStatus 冲突', () => {
  const J = loadJudge();
  const c = makeCandidateWithResumeCard();
  c.basic.activeStatus = '3日内活跃';
  const text = J.serializeCandidate(c);
  // 两个字段同时输出(activeStatus 是 BOSS 最后活跃,applyStatus 是到岗状态,不矛盾)
  assert.match(text, /activeStatus.*3日内活跃/);
  assert.match(text, /applyStatus.*在校-月内到岗/);
});

// v0.17.0.9 P1 测试:chat/geek/info 字段查漏(lastCompany / lastPosition / everWorkPositionNameList)
test('serializeCandidate 渲染 bossSignals.lastCompany / lastPosition / everWorkPositionNameList', () => {
  const J = loadJudge();
  const c = {
    candidateId: '123',
    basic: { name: 'X' },
    expectation: {},
    workHistory: [],
    education: [],
    bossSignals: {
      lastCompany: '某科技公司',
      lastPosition: '高级测试工程师',
      everWorkPositionNameList: ['测试工程师', '自动化测试', '质量保障经理']
    },
    chatHistory: []
  };
  const text = J.serializeCandidate(c);
  assert.match(text, /lastCompany:.*某科技公司/);
  assert.match(text, /lastPosition:.*高级测试工程师/);
  assert.match(text, /everWorkPositionNameList:.*测试工程师.*自动化测试.*质量保障经理/);
});

test('serializeCandidate workHistory 为空时,bossSignals 的 lastCompany/lastPosition 是关键弥补', () => {
  const J = loadJudge();
  // 应届候选人,workHistory = [],但 lastCompany 显示曾在某公司实习
  const c = {
    candidateId: '123',
    basic: { name: '小李', yearsOfExperience: '应届' },
    expectation: { candidateOwn: '前端' },
    workHistory: [],
    education: [],
    bossSignals: { lastCompany: '腾讯', lastPosition: '前端实习' },
    chatHistory: []
  };
  const text = J.serializeCandidate(c);
  // workHistory 区不应出现,但 bossSignals 区有 lastCompany / lastPosition
  assert.equal(text.indexOf('## workHistory'), -1);
  assert.match(text, /## bossSignals/);
  assert.match(text, /lastCompany.*腾讯/);
});
