// 测试 lib/extractor.js v0.13.x 的 extractFromHistoryMsg
// 跑：node --test tests/extractor-history-msg.test.js

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

test('extractFromHistoryMsg — 普通对话提取双方 uid + 文本消息', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        {
          mid: 100001,
          time: 1777000000000,
          from: { uid: 'CAND-A', name: '黄蔚兰' },
          to: { uid: 'HR-X', name: '招聘助理' },
          type: 1,
          bizType: null,
          body: { text: '您好，我对印尼语实习生岗位感兴趣' }
        },
        {
          mid: 100002,
          time: 1777000001000,
          from: { uid: 'HR-X', name: '招聘助理' },
          to: { uid: 'CAND-A', name: '黄蔚兰' },
          type: 1,
          bizType: null,
          body: { text: '可以聊聊你的印尼语水平吗' }
        }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(JSON.stringify(r.uids.sort()), JSON.stringify(['CAND-A', 'HR-X']));
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].text, '您好，我对印尼语实习生岗位感兴趣');
  assert.equal(r.messages[0].from.uid, 'CAND-A');
  assert.equal(r.messages[0].kind, 'text');
  assert.equal(r.lastMessageAt, 1777000001000);
});

test('extractFromHistoryMsg — 简历卡片消息（type=3）提取摘要', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        {
          mid: 200001,
          time: 1777000000000,
          from: { uid: 'CAND-B', name: '张三' },
          to: { uid: 'HR-X', name: 'HR' },
          type: 3,
          bizType: 21050004,
          body: {
            resume: {
              name: '张三',
              ageDesc: '24岁',
              degree: '本科',
              city: '南京',
              workDesc: '印尼语翻译 2 年'
            }
          }
        }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].kind, 'resume');
  assert.match(r.messages[0].text, /^\[简历卡片\]/);
  assert.match(r.messages[0].text, /张三.*24岁.*本科.*南京/);
});

test('extractFromHistoryMsg — 链接卡片 / 交互卡 / 附件 kind 区分', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        {
          mid: 300001, time: 1, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' },
          type: 1, bizType: 13,
          body: { hyperLink: { text: '查看公司主页', url: 'https://example.com' } }
        },
        {
          mid: 300002, time: 2, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' },
          type: 1, bizType: 21050025,
          body: { action: { text: '已同意发简历' } }
        }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].kind, 'hyperLink');
  assert.match(r.messages[0].text, /^\[链接\] 查看公司主页/);
  assert.equal(r.messages[1].kind, 'action');
  assert.match(r.messages[1].text, /^\[交互卡\] 已同意发简历/);
});

test('extractFromHistoryMsg — 空 body 消息（保活类）被丢弃', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        { mid: 1, time: 1, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, type: 1, body: {} },
        { mid: 2, time: 2, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, type: 1, body: { text: '有内容的消息' } }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].text, '有内容的消息');
});

test('extractFromHistoryMsg — 缺 from / to 的消息被跳过', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        { mid: 1, time: 1, body: { text: '没 from 的' } },
        { mid: 2, time: 2, from: { uid: 'A' }, body: { text: '没 to 的' } },
        { mid: 3, time: 3, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, body: { text: '完整的' } }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].text, '完整的');
});

test('extractFromHistoryMsg — 多轮对话按 time 升序排列', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        { mid: 1, time: 300, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, body: { text: '第三' } },
        { mid: 2, time: 100, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, body: { text: '第一' } },
        { mid: 3, time: 200, from: { uid: 'B', name: 'b' }, to: { uid: 'A', name: 'a' }, body: { text: '第二' } }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(
    JSON.stringify(r.messages.map(function (m) { return m.text; })),
    JSON.stringify(['第一', '第二', '第三'])
  );
  assert.equal(r.lastMessageAt, 300);
});

test('extractFromHistoryMsg — 空响应 / 非数组 messages 返回空结构', () => {
  const E = loadExtractor();
  const cases = [null, {}, { zpData: {} }, { zpData: { messages: [] } }];
  cases.forEach(function (input) {
    const r = E.extractFromHistoryMsg(input);
    assert.equal(r.uids.length, 0);
    assert.equal(r.messages.length, 0);
    assert.equal(r.lastMessageAt, 0);
  });
});

test('extractFromHistoryMsg — type / bizType 透传给下游（非过滤项保留）', () => {
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        // 链接卡片（bizType=13），保留原始 type / bizType 给下游消费
        { mid: 1, time: 1, from: { uid: 'HR', name: 'h' }, to: { uid: 'CAND', name: 'c' }, type: 1, bizType: 13, body: { text: '查看主页' } },
        // 普通候选人消息（bizType=null）
        { mid: 2, time: 2, from: { uid: 'CAND', name: 'c' }, to: { uid: 'HR', name: 'h' }, type: 1, bizType: null, body: { text: '我有印尼留学经历' } }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].type, 1);
  assert.equal(r.messages[0].bizType, 13);
  assert.equal(r.messages[1].bizType, null);
});

test('extractFromHistoryMsg — 过滤 HR 模板招呼（type=1, bizType=105）', () => {
  // v0.15.3：BOSS 替 HR 发的固定模板话术（如"你好，看到您简历..."），
  // 既不是候选人陈述，也不是 HR 主动撰写，进 chatHistory 会污染 LLM 判断。
  const E = loadExtractor();
  const apiResponse = {
    zpData: {
      messages: [
        // HR 模板招呼语：直接被过滤
        { mid: 1, time: 1, from: { uid: 'HR', name: 'h' }, to: { uid: 'CAND', name: 'c' }, type: 1, bizType: 105, body: { text: '你好，看到您简历对我们岗位很匹配' } },
        // 候选人主动消息：保留
        { mid: 2, time: 2, from: { uid: 'CAND', name: 'c' }, to: { uid: 'HR', name: 'h' }, type: 1, bizType: null, body: { text: '我会印尼语' } }
      ]
    }
  };
  const r = E.extractFromHistoryMsg(apiResponse);
  assert.equal(r.messages.length, 1, '105 应被过滤，只剩 1 条');
  assert.equal(r.messages[0].text, '我会印尼语');
  assert.equal(r.messages[0].from.uid, 'CAND');
});

test('extractFromCapture — historyMsg path 不走主路由（保持 candidate 数组纯净）', () => {
  const E = loadExtractor();
  const result = E.extractFromCapture('/wapi/zpchat/boss/historyMsg', {
    zpData: { messages: [{ mid: 1, time: 1, from: { uid: 'A', name: 'a' }, to: { uid: 'B', name: 'b' }, body: { text: 'X' } }] }
  });
  // historyMsg 应走单独 extractFromHistoryMsg，extractFromCapture 不该返回 candidate
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 0);
});
