// 测试 lib/extractor.js v0.17.0.10 沟通页 DOM 路线（POC A7 回灌）
// 跑：node --test tests/extractor-detail-panel.test.js

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

// ========== parseExpectText ==========

test('parseExpectText — 单城市基础解析（朱怡蜚案例）', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('期望： 大连 · 进出口贸易 2-3K');
  assert.equal(r.prefix, '期望');
  assert.equal(r.cityRaw, '大连');
  assert.equal(JSON.stringify(r.cities), JSON.stringify(['大连']));
  assert.equal(r.jobRaw, '进出口贸易');
  assert.equal(r.salaryRaw, '2-3K');
});

test('parseExpectText — 多城市用 & 分（POC A7 真机李常发案例）', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('期望： 玉林 & 南宁 · 西班牙语翻译 5-6K');
  assert.equal(r.cityRaw, '玉林 & 南宁');
  assert.equal(JSON.stringify(r.cities), JSON.stringify(['玉林', '南宁']));
  assert.equal(r.jobRaw, '西班牙语翻译');
  assert.equal(r.salaryRaw, '5-6K');
});

test('parseExpectText — 兼容"最近关注"前缀（候选人没填期望时 BOSS 推算的 fallback）', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('最近关注： 广州 & 南宁 · 用户运营 6-8K');
  assert.equal(r.prefix, '最近关注');
  assert.equal(r.cityRaw, '广州 & 南宁');
  assert.equal(JSON.stringify(r.cities), JSON.stringify(['广州', '南宁']));
  assert.equal(r.jobRaw, '用户运营');
  assert.equal(r.salaryRaw, '6-8K');
});

test('parseExpectText — 兼容中文逗号多城市（"广州、上海"）', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('期望： 广州、上海 · 销售助理 8-13K');
  assert.equal(JSON.stringify(r.cities), JSON.stringify(['广州', '上海']));
  assert.equal(r.cityRaw, '广州、上海');
});

test('parseExpectText — 兼容日薪格式 "130-180元/天"', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('期望： 南宁 · 西语实习生 130-180元/天');
  assert.equal(r.cityRaw, '南宁');
  assert.equal(r.salaryRaw, '130-180元/天');
});

test('parseExpectText — 空输入返回 null', () => {
  const E = loadExtractor();
  assert.equal(E.parseExpectText(null), null);
  assert.equal(E.parseExpectText(''), null);
  assert.equal(E.parseExpectText(undefined), null);
});

test('parseExpectText — 没有前缀也能解析（容错）', () => {
  const E = loadExtractor();
  const r = E.parseExpectText('广州 · 运营助理 5-8K');
  assert.equal(r.prefix, null);
  assert.equal(r.cityRaw, '广州');
});

// ========== extractFromDetailPanel ==========

test('extractFromDetailPanel — 完整字段标准化（POC A7 李常发真实数据）', () => {
  const E = loadExtractor();
  const rawScan = {
    scannedAt: 1779076079678,
    candidateName: '李常发',
    baseStats: '26岁3年本科',
    expectRaw: '期望： 玉林 & 南宁 · 西班牙语翻译 5-6K',
    workEduListRaw: '康泊斯流体技术 · 西班牙语翻译 浙江外国语学院 · 西班牙语言文学 · 本科',
    resumeCardRaw: '5月17日 沟通的职位-西语实习生',
    domHits: {
      detailRoot: '.base-info-single-container',
      name: '.base-info-single-top .base-info-item',
      expect: '.expect'
    }
  };
  const r = E.extractFromDetailPanel(rawScan);
  assert.ok(r);
  assert.equal(r.candidateName, '李常发');
  assert.equal(r.baseStats, '26岁3年本科');
  assert.equal(r.expect.cityRaw, '玉林 & 南宁');
  assert.equal(JSON.stringify(r.expect.cities), JSON.stringify(['玉林', '南宁']));
  assert.equal(r.expect.jobRaw, '西班牙语翻译');
  assert.equal(r.workEduText, '康泊斯流体技术 · 西班牙语翻译 浙江外国语学院 · 西班牙语言文学 · 本科');
  assert.equal(r.resumeCardText, '5月17日 沟通的职位-西语实习生');
  assert.equal(r.domHits.detailRoot, '.base-info-single-container');
  // v0.18.0：desc / skillTags 字段已删
  assert.equal(r.desc, undefined);
  assert.equal(r.skillTags, undefined);
});

test('extractFromDetailPanel — 没填期望时 expect=null', () => {
  const E = loadExtractor();
  const r = E.extractFromDetailPanel({
    candidateName: '张三',
    expectRaw: null
  });
  assert.equal(r.expect, null);
  assert.equal(r.candidateName, '张三');
});

test('extractFromDetailPanel — 空输入返回 null', () => {
  const E = loadExtractor();
  assert.equal(E.extractFromDetailPanel(null), null);
  assert.equal(E.extractFromDetailPanel(undefined), null);
  assert.equal(E.extractFromDetailPanel('not an object'), null);
});

// v0.18.0：原 'extractFromDetailPanel — 有 skillTags 时保留数组' 测试已删除
//   skillTags 字段在 v0.18.0 整体下线（POC A7/A9/A10 证实 BOSS 详情面板没这字段，永远 null）
//   简介+技能信息现在统一由 resumeFullText（在线简历 iframe）承载
test('extractFromDetailPanel — desc / skillTags 字段已下线（v0.18.0 死代码清理）', () => {
  const E = loadExtractor();
  // 即使 rawScan 里残留这两字段，extractor 也不再透传
  const r = E.extractFromDetailPanel({
    candidateName: '测试',
    descText: '这段简介应该被忽略',
    skillTags: ['印尼语', '翻译', 'Office']
  });
  assert.equal(r.desc, undefined);
  assert.equal(r.skillTags, undefined);
});

test('extractFromDetailPanel — 暴露在 BossExtractor 上供 background 调用', () => {
  const E = loadExtractor();
  assert.equal(typeof E.extractFromDetailPanel, 'function');
  assert.equal(typeof E.parseExpectText, 'function');
});
