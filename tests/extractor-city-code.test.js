// 测试 v0.15.5 城市编码字典 + chat/geek/info 期望城市反查
// 跑：node --test tests/extractor-city-code.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 把 city-codes.js 和 extractor.js 加载到同一 vm 上下文，让 extractor 能找到 BossCityCodes
function loadStack(opts) {
  const ctx = { self: {}, console };
  ctx.globalThis = ctx;
  if (!opts || !opts.skipCityCodes) {
    const cityFile = path.resolve(__dirname, '../lib/city-codes.js');
    vm.runInNewContext(fs.readFileSync(cityFile, 'utf8'), ctx, { filename: cityFile });
  }
  const extFile = path.resolve(__dirname, '../lib/extractor.js');
  vm.runInNewContext(fs.readFileSync(extFile, 'utf8'), ctx, { filename: extFile });
  return ctx.self;
}

test('city-codes lookupCityCode — 直辖市 / 省会 / 一线 精确命中（v0.16.2 BOSS 真字典）', () => {
  // v0.16.2 用 BOSS 自己 getCityList 接口字典替换 v0.15.5 手工字典。
  // BOSS regionCode 以 0100 结尾（市级聚合），不是 0101（气象站点）。
  const { BossCityCodes } = loadStack();
  assert.equal(BossCityCodes.lookupCityCode('101010100'), '北京');
  assert.equal(BossCityCodes.lookupCityCode('101020100'), '上海');
  assert.equal(BossCityCodes.lookupCityCode('101190100'), '南京');   // 不是 0101
  assert.equal(BossCityCodes.lookupCityCode('101300100'), '南宁');   // 不是 0101
  assert.equal(BossCityCodes.lookupCityCode('101280100'), '广州');   // 不是 0101
  assert.equal(BossCityCodes.lookupCityCode('101280600'), '深圳');   // 不是 0601
  assert.equal(BossCityCodes.lookupCityCode('101320300'), '香港');   // BOSS 实际是 0300
});

test('city-codes lookupCityCode — 二三线地级市命中（覆盖度抽样）', () => {
  const { BossCityCodes } = loadStack();
  assert.equal(BossCityCodes.lookupCityCode('101190400'), '苏州');
  assert.equal(BossCityCodes.lookupCityCode('101281600'), '东莞');
  assert.equal(BossCityCodes.lookupCityCode('101281700'), '中山');
  assert.equal(BossCityCodes.lookupCityCode('101210400'), '宁波');
  assert.equal(BossCityCodes.lookupCityCode('101230200'), '厦门');
});

test('city-codes lookupCityCode — v0.15.5 假编码现在 miss（历史 bug 回归校验）', () => {
  // 历史 bug：v0.15.5 字典写的是 xxxxx0101 / xxxxx0601，BOSS 实际不用这些。
  // 升级 v0.16.2 后这些"假编码"应该走前缀兜底而不是精确命中"假城市"。
  const { BossCityCodes } = loadStack();
  assert.equal(BossCityCodes.lookupCityCode('101280101'), '广东（粗）');   // 不是"广州"
  assert.equal(BossCityCodes.lookupCityCode('101280601'), '广东（粗）');   // 不是"深圳"
  assert.equal(BossCityCodes.lookupCityCode('101300101'), '广西（粗）');   // 不是"南宁"
});

test('city-codes lookupCityCode — miss 时按省份前缀 fallback 标"（粗）"', () => {
  const { BossCityCodes } = loadStack();
  // 一个肯定不在精确表里的县级编码（10128 = 广东）
  assert.equal(BossCityCodes.lookupCityCode('101289999'), '广东（粗）');
  // 江苏段
  assert.equal(BossCityCodes.lookupCityCode('101199876'), '江苏（粗）');
  // 上海段（特殊：所有 1010200xx / 101020xxx 都该兜到上海）
  assert.equal(BossCityCodes.lookupCityCode('101029999'), '上海（粗）');
});

test('city-codes lookupCityCode — 未知 / 非法编码返回 null', () => {
  const { BossCityCodes } = loadStack();
  assert.equal(BossCityCodes.lookupCityCode(null), null);
  assert.equal(BossCityCodes.lookupCityCode(undefined), null);
  assert.equal(BossCityCodes.lookupCityCode(''), null);
  assert.equal(BossCityCodes.lookupCityCode('123'), null);          // 太短
  assert.equal(BossCityCodes.lookupCityCode('999999999'), null);    // 不在任何省份段
});

test('city-codes lookupCityCode — 接受 number 类型编码（BOSS 可能给 number 也可能给 string）', () => {
  const { BossCityCodes } = loadStack();
  assert.equal(BossCityCodes.lookupCityCode(101190100), '南京');
});

test('extractFromGeekInfo — regionCode = 101190100 → cityName = 南京', () => {
  const { BossExtractor } = loadStack();
  const c = BossExtractor.extractFromGeekInfo({
    zpData: {
      data: {
        uid: 'CAND-X',
        name: '张三',
        city: '南京',
        regionCode: '101190100',
        position: '运营',
        toPosition: '印尼语实习生',
        salaryDesc: '130-180元/天'
      }
    }
  });
  assert.equal(c.expectation.cityName, '南京');
});

test('extractFromGeekInfo — regionCode miss 时仍走前缀兜底（"江苏（粗）"）', () => {
  const { BossExtractor } = loadStack();
  const c = BossExtractor.extractFromGeekInfo({
    zpData: { data: { uid: 'X', name: '李四', regionCode: '101199876' } }
  });
  assert.equal(c.expectation.cityName, '江苏（粗）');
});

test('extractFromGeekInfo — regionCode 缺失时 cityName 为 null（兼容老行为）', () => {
  const { BossExtractor } = loadStack();
  const c = BossExtractor.extractFromGeekInfo({
    zpData: { data: { uid: 'X', name: '李四' } }   // 没 regionCode
  });
  assert.equal(c.expectation.cityName, null);
});

test('extractFromGeekInfo — 字典未加载时 extractor 降级 null（不抛错）', () => {
  // 模拟 importScripts 顺序错误：city-codes 没加载，extractor 单独存在
  const { BossExtractor } = loadStack({ skipCityCodes: true });
  const c = BossExtractor.extractFromGeekInfo({
    zpData: { data: { uid: 'X', name: '李四', regionCode: '101190100' } }
  });
  // 字典找不到 → 走 lookupRegionCode 的降级路径 → null
  assert.equal(c.expectation.cityName, null);
});
