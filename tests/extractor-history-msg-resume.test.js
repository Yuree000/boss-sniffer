// v0.17.0.9 回灌测试:extractFromHistoryMsg 从 messages[].body.resume 提取简历卡片结构化字段
// 样本基于 POC A6 真机 capture(`poc/A6-沟通页字段全集/参考记录/poc-a6-export-20260517-222404.json`)

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

// POC A6 真实样本(简版,只保留必要字段)
function makeApiResponseWithResumeCard() {
  return {
    zpData: {
      hasMore: false,
      minMsgId: 0,
      type: 0,
      messages: [
        {
          // 简历卡片消息:BOSS 主动推
          uncount: 1,
          flag: 1,
          bizType: 21050004,
          mid: 343249492755713,
          received: true,
          securityId: 'aEEwjcPkTdTK--B1...',
          cmid: 0,
          type: 3,
          body: {
            resume: {
              jobSalary: '130-180元/天',
              brandName: '',
              education: '本科',
              gender: 0,
              city: '沈阳',
              lid: '',
              description: '',
              securityId: 'aEEwjcPkTdTK--B1...',
              expectId: 1412221751,
              salary: '3-7K',
              experiences: [
                {
                  occupation: '印度尼西亚语',
                  endDate: '2027',
                  organization: '大连外国语大学',
                  type: 2,
                  startDate: '2023'
                }
              ],
              bottomText: '5月16日 沟通的职位-印尼语实习生',
              extend: '',
              jobId: 400321015,
              content3: '',
              content2: '毕业于 大连外国语大学 | 印度尼西亚语',
              content1: '求职期望  咨询/翻译',
              position: '期望:咨询/翻译(行业)',
              workYear: '27年应届生',
              positionCategory: '印尼语实习生',
              user: { uid: 604100646, name: 'Sisca', avatar: 'https://...' },
              applyStatus: '在校-月内到岗',
              age: '21'
            },
            type: 9,
            templateId: 3,
            headTitle: '点击查看牛人简历'
          },
          from: { uid: 604100646, name: 'Sisca' },
          to: { uid: 74311536, name: 'HR' },
          time: 1778940345666,
          status: 2
        },
        {
          // 普通文本消息(候选人招呼)
          uncount: 0,
          flag: 1,
          bizType: 101,
          mid: 343249492759808,
          received: true,
          type: 3,
          body: { text: '您好,可以占用您一点时间,我想进一步了解一下这个职位', type: 1 },
          from: { uid: 604100646, name: 'Sisca' },
          to: { uid: 74311536, name: 'HR' },
          time: 1778940345674
        }
      ]
    }
  };
}

test('extractResumeCards 提取 bizType=21050004 简历卡片的全部结构化字段', () => {
  const E = loadExtractor();
  const cards = E.extractResumeCards(makeApiResponseWithResumeCard().zpData.messages);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.candidateId, '604100646');
  assert.equal(c.name, 'Sisca');
  assert.equal(c.age, '21');
  assert.equal(c.gender, 0);
  assert.equal(c.education, '本科');
  assert.equal(c.workYear, '27年应届生');
  assert.equal(c.city, '沈阳');
  assert.equal(c.salary, '3-7K');
  assert.equal(c.jobSalary, '130-180元/天');
  assert.equal(c.position, '期望:咨询/翻译(行业)');
  assert.equal(c.positionCategory, '印尼语实习生');
  assert.equal(c.applyStatus, '在校-月内到岗');
  assert.equal(c.bottomText, '5月16日 沟通的职位-印尼语实习生');
  assert.equal(c.content1, '求职期望  咨询/翻译');
  assert.equal(c.content2, '毕业于 大连外国语大学 | 印度尼西亚语');
});

test('extractResumeCards 提取 experiences 数组(简版教育经历)', () => {
  const E = loadExtractor();
  const cards = E.extractResumeCards(makeApiResponseWithResumeCard().zpData.messages);
  assert.equal(cards[0].experiences.length, 1);
  const e = cards[0].experiences[0];
  assert.equal(e.organization, '大连外国语大学');
  assert.equal(e.occupation, '印度尼西亚语');
  assert.equal(e.startDate, '2023');
  assert.equal(e.endDate, '2027');
});

test('extractResumeCards 忽略非简历卡片消息(bizType != 21050004 或 type != 3)', () => {
  const E = loadExtractor();
  const rsp = makeApiResponseWithResumeCard();
  // 第二条消息是 bizType=101 普通文本,不应被认为是简历卡片
  const cards = E.extractResumeCards(rsp.zpData.messages);
  assert.equal(cards.length, 1);  // 仅第一条
});

test('extractResumeCards 兼容字段缺失(无 user.uid 用 from.uid 兜底)', () => {
  const E = loadExtractor();
  const msgs = [{
    type: 3, bizType: 21050004,
    body: { resume: { applyStatus: '在校', education: '本科', /* user 缺失 */ } },
    from: { uid: 999888, name: '匿名候选人' }
  }];
  const cards = E.extractResumeCards(msgs);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].candidateId, '999888');
  assert.equal(cards[0].applyStatus, '在校');
});

test('extractFromHistoryMsg 返回值含 resumeCards 字段', () => {
  const E = loadExtractor();
  const result = E.extractFromHistoryMsg(makeApiResponseWithResumeCard());
  assert.equal(Array.isArray(result.resumeCards), true);
  assert.equal(result.resumeCards.length, 1);
  assert.equal(result.resumeCards[0].applyStatus, '在校-月内到岗');
});

test('extractFromHistoryMsg 空 messages 时 resumeCards 也是空数组(不抛错)', () => {
  const E = loadExtractor();
  const result = E.extractFromHistoryMsg({ zpData: { messages: [] } });
  assert.equal(Array.isArray(result.resumeCards), true);
  assert.equal(result.resumeCards.length, 0);
});

test('extractMessageBody 简历卡片新字段名(user.name/age/education/workYear)能拼出摘要', () => {
  const E = loadExtractor();
  // 通过 extractFromHistoryMsg 间接验证(extractMessageBody 内部)
  const result = E.extractFromHistoryMsg(makeApiResponseWithResumeCard());
  const resumeMsg = result.messages.find(function (m) { return m.kind === 'resume'; });
  assert.ok(resumeMsg, '应该有一条 kind=resume 的消息');
  // 应包含姓名、年龄、学历、应届、城市、薪资、期望职位、申请状态
  assert.match(resumeMsg.text, /Sisca/);
  assert.match(resumeMsg.text, /21岁/);
  assert.match(resumeMsg.text, /本科/);
  assert.match(resumeMsg.text, /27年应届生/);
  assert.match(resumeMsg.text, /沈阳/);
  assert.match(resumeMsg.text, /3-7K/);
  assert.match(resumeMsg.text, /在校-月内到岗/);
});
