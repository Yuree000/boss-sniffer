// 测试 lib/jd-templates.js 的 v0.12.0 schema + SEED 重置逻辑
// 跑：node --test tests/jd-templates-seed.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 构造一个最小 BossStorageSync mock（v0.17.0 起 jd-templates.js 改用 sync）
// 所有写读都走 syncStore 对象；localStore 仅供 migrateFromLocal 读取旧数据
function makeSyncMock(initialSyncStore, initialLocalStore) {
  const syncStore = Object.assign({}, initialSyncStore || {});
  const localStore = Object.assign({}, initialLocalStore || {});

  function storeGet(store, keys) {
    return new Promise(function (resolve) {
      if (typeof keys === 'string') {
        const out = {};
        if (keys in store) out[keys] = store[keys];
        resolve(out);
        return;
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach(function (k) { if (k in store) out[k] = store[k]; });
        resolve(out);
        return;
      }
      // 不传 keys = 拿全部
      resolve(Object.assign({}, store));
    });
  }

  const BossStorageSyncMock = {
    get: function (keys) { return storeGet(syncStore, keys); },
    set: function (obj) {
      return new Promise(function (resolve) {
        Object.assign(syncStore, obj);
        resolve();
      });
    },
    precheckSize: function () {},  // 测试中不校验配额大小
    migrateFromLocal: function (keys) {
      // 简化迁移逻辑：若 local 有数据且 sync 无，则复制
      return new Promise(function (resolve) {
        const result = { migrated: [], skipped: [], errors: [] };
        keys.forEach(function (k) {
          if (syncStore[k] !== undefined) {
            result.skipped.push(k);
          } else if (localStore[k] !== undefined) {
            syncStore[k] = localStore[k];
            result.migrated.push(k);
          }
        });
        resolve(result);
      });
    },
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    SAFETY_MARGIN: 1024
  };

  // chrome mock 仅用于兼容 migrateFromLocal 内部对 chrome.storage.local.get 的调用
  const chromeMock = {
    storage: {
      local: {
        get: function (keys) { return storeGet(localStore, keys); },
        set: function (obj) {
          return new Promise(function (resolve) {
            Object.assign(localStore, obj);
            resolve();
          });
        }
      },
      sync: {
        get: function (keys, cb) { storeGet(syncStore, keys).then(cb); },
        set: function (obj, cb) {
          Object.assign(syncStore, obj);
          if (cb) cb();
        }
      }
    },
    runtime: { lastError: null }
  };

  return { BossStorageSyncMock, chromeMock, syncStore, localStore };
}

function loadJD(initialSyncStore, initialLocalStore) {
  const { BossStorageSyncMock, chromeMock } = makeSyncMock(initialSyncStore, initialLocalStore);
  const file = path.resolve(__dirname, '../lib/jd-templates.js');
  const code = fs.readFileSync(file, 'utf8');
  const selfObj = { BossStorageSync: BossStorageSyncMock };
  const ctx = {
    self: selfObj,
    console,
    chrome: chromeMock
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return { BossJD: ctx.self.BossJD, ctx: ctx };
}

test('ensureSeeded — 空 storage 写入三条 SEED + currentJdId 默认 indonesia-intern-2026', async () => {
  const { BossJD } = loadJD();
  await BossJD.ensureSeeded();
  const list = await BossJD.listTemplates();
  assert.equal(list.length, 3);
  // 印尼语实习生排第一（MVP 单岗位 / 业务文档 5.6 §11.1）
  assert.equal(list[0].jdId, 'indonesia-intern-2026');
  assert.equal(list[0].name, '印尼语实习生');
  assert.equal(list[1].jdId, 'qa-engineer-2026');
  assert.equal(list[1].name, '测试工程师');
  assert.equal(list[2].jdId, 'ai-cx-2026');
  assert.equal(list[2].name, 'AI CX');
  assert.equal(await BossJD.getCurrentJdId(), 'indonesia-intern-2026');
});

test('ensureSeeded — 印尼语实习生 SEED 含 4 必要 + 0 可选 + 阈值 0', async () => {
  const { BossJD } = loadJD();
  await BossJD.ensureSeeded();
  const tpl = await BossJD.getTemplate('indonesia-intern-2026');
  assert.equal(tpl.mustConditions.length, 4);
  assert.equal(tpl.optionalConditions.length, 0);
  assert.equal(tpl.optionalThreshold, 0);
  // 关键关键词必须在 SEED 里
  const mustTexts = tpl.mustConditions.map(function (m) { return m.text; }).join(' ');
  assert.match(mustTexts, /南京/);
  assert.match(mustTexts, /南宁/);
  assert.match(mustTexts, /本科/);
  assert.match(mustTexts, /印尼语/);
  assert.match(mustTexts, /印尼籍/);
  assert.match(mustTexts, /大四|大三|毕业/);
});

test('ensureSeeded — 测试工程师 SEED 含 3 必要 + 5 可选 + 阈值 3', async () => {
  const { BossJD } = loadJD();
  await BossJD.ensureSeeded();
  const tpl = await BossJD.getTemplate('qa-engineer-2026');
  assert.equal(tpl.mustConditions.length, 3);
  assert.equal(tpl.optionalConditions.length, 5);
  assert.equal(tpl.optionalThreshold, 3);
  // 关键关键词必须在 SEED 里
  const mustTexts = tpl.mustConditions.map(function (m) { return m.text; }).join(' ');
  assert.match(mustTexts, /Python/);
  assert.match(mustTexts, /Linux/);
  assert.match(mustTexts, /34/);
  const optTexts = tpl.optionalConditions.map(function (o) { return o.text; }).join(' ');
  assert.match(optTexts, /pytest/);
  assert.match(optTexts, /自动化测试/);
});

test('ensureSeeded — AI CX SEED 含 3 必要 + 3 可选 + 阈值 1', async () => {
  const { BossJD } = loadJD();
  await BossJD.ensureSeeded();
  const tpl = await BossJD.getTemplate('ai-cx-2026');
  assert.equal(tpl.mustConditions.length, 3);
  assert.equal(tpl.optionalConditions.length, 3);
  assert.equal(tpl.optionalThreshold, 1);
  const mustTexts = tpl.mustConditions.map(function (m) { return m.text; }).join(' ');
  assert.match(mustTexts, /西班牙语|葡萄牙语/);
  assert.match(mustTexts, /28/);
});

test('ensureSeeded — 旧 schema（含 base 字段）被一次性覆盖为三条新 SEED', async () => {
  // 模拟用户旧扩展的存储：旧数据在 local（尚未迁移到 sync），sync 为空
  const oldLocalStore = {
    jd_templates: [{
      jdId: 'indonesia-intern-2026',
      name: '印尼语实习生',
      base: '南京、南宁',
      educationMin: '本科及以上',
      language: '印尼语',
      ageMax: null,
      experienceHard: '',
      bonus: '',
      veto: 'base 不在范围（非印尼籍）',
      specialRules: '印尼籍候选人不看学历与年级',
      jdText: ''
    }],
    current_jd_id: 'indonesia-intern-2026'
  };
  const { BossJD } = loadJD({}, oldLocalStore);
  await BossJD.ensureSeeded();
  const list = await BossJD.listTemplates();
  assert.equal(list.length, 3);
  assert.equal(list[0].jdId, 'indonesia-intern-2026');
  assert.equal(list[1].jdId, 'qa-engineer-2026');
  assert.equal(list[2].jdId, 'ai-cx-2026');
  // 同名 indonesia-intern-2026 仍存在但 schema 已升级（4 必要 0 可选）
  const updated = await BossJD.getTemplate('indonesia-intern-2026');
  assert.equal(updated.base, undefined);            // 旧字段消失
  assert.equal(updated.mustConditions.length, 4);   // 新字段就位
  assert.equal(updated.optionalConditions.length, 0);
  assert.equal(updated.optionalThreshold, 0);
  // currentJdId 仍指向 'indonesia-intern-2026'（jdId 重叠，新 SEED 沿用同 jdId，不被切走）
  assert.equal(await BossJD.getCurrentJdId(), 'indonesia-intern-2026');
});

test('ensureSeeded — 新 schema 已存在则幂等不改', async () => {
  // 新 schema 数据直接在 sync 中（已迁移）
  const { BossJD } = loadJD({
    jd_templates: [{
      jdId: 'custom-1',
      name: '自定义 JD',
      mustConditions: [{ id: 'a', text: '本科' }],
      optionalConditions: [],
      optionalThreshold: 0,
      createdAt: 100,
      updatedAt: 100
    }],
    current_jd_id: 'custom-1'
  });
  await BossJD.ensureSeeded();
  const list = await BossJD.listTemplates();
  assert.equal(list.length, 1);
  assert.equal(list[0].jdId, 'custom-1');
  assert.equal(list[0].createdAt, 100);  // 不动
  assert.equal(await BossJD.getCurrentJdId(), 'custom-1');
});

test('saveTemplate — 必要 + 可选都为空报错', async () => {
  const { BossJD } = loadJD();
  await assert.rejects(
    () => BossJD.saveTemplate({
      name: '空 JD',
      mustConditions: [],
      optionalConditions: [],
      optionalThreshold: 0
    }),
    /至少要有一项/
  );
});

test('saveTemplate — 阈值大于可选数量报错', async () => {
  const { BossJD } = loadJD();
  await assert.rejects(
    () => BossJD.saveTemplate({
      name: '不合理 JD',
      mustConditions: [{ id: 'a', text: '本科' }],
      optionalConditions: [{ id: 'b', text: 'AI' }],
      optionalThreshold: 5
    }),
    /阈值/
  );
});

test('saveTemplate — 可选条件文本为空报错', async () => {
  const { BossJD } = loadJD();
  await assert.rejects(
    () => BossJD.saveTemplate({
      name: '空文本',
      mustConditions: [{ id: 'a', text: '本科' }],
      optionalConditions: [{ id: 'b', text: '' }],
      optionalThreshold: 0
    }),
    /可选条件第 1 项 text 不能为空/
  );
});

test('saveTemplate — 新建生成 jdId + createdAt', async () => {
  const { BossJD } = loadJD();
  const saved = await BossJD.saveTemplate({
    name: '新 JD',
    mustConditions: [{ id: 'm1', text: '本科' }],
    optionalConditions: [],
    optionalThreshold: 0
  });
  assert.ok(saved.jdId);
  assert.ok(saved.createdAt > 0);
  assert.ok(saved.updatedAt > 0);
});

test('saveTemplate — 编辑保留 createdAt', async () => {
  const { BossJD } = loadJD();
  const first = await BossJD.saveTemplate({
    name: '初次',
    mustConditions: [{ id: 'm1', text: '本科' }],
    optionalConditions: [],
    optionalThreshold: 0
  });
  // 稍微等一下让 updatedAt 拉开
  await new Promise(function (r) { setTimeout(r, 10); });
  const updated = await BossJD.saveTemplate({
    jdId: first.jdId,
    name: '改名',
    mustConditions: [{ id: 'm1', text: '本科' }, { id: 'm2', text: '硕士' }],
    optionalConditions: [],
    optionalThreshold: 0
  });
  assert.equal(updated.createdAt, first.createdAt);
  assert.ok(updated.updatedAt > first.updatedAt);
  assert.equal(updated.name, '改名');
  assert.equal(updated.mustConditions.length, 2);
});

test('genConditionId — 不同前缀，多次调用不重复', () => {
  const { BossJD } = loadJD();
  const a = BossJD.genConditionId('must');
  const b = BossJD.genConditionId('must');
  const c = BossJD.genConditionId('opt');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^must_/);
  assert.match(c, /^opt_/);
});

test('isOldSchema / isNewSchema — 字段判别', () => {
  const { BossJD } = loadJD();
  assert.equal(BossJD.isOldSchema({ base: '北京' }), true);
  assert.equal(BossJD.isOldSchema({ educationMin: '本科' }), true);
  assert.equal(BossJD.isOldSchema({ veto: '...' }), true);
  assert.equal(BossJD.isOldSchema({ mustConditions: [] }), false);
  assert.equal(BossJD.isNewSchema({ mustConditions: [] }), true);
  assert.equal(BossJD.isNewSchema({ optionalConditions: [] }), true);
  assert.equal(BossJD.isNewSchema({ base: '北京' }), false);
});

test('deleteTemplate — 删当前 JD 后 currentJdId 置空', async () => {
  const { BossJD } = loadJD();
  await BossJD.ensureSeeded();
  // 默认 currentJdId = 'indonesia-intern-2026'（v0.12.1 起，业务文档 MVP 单岗位）
  assert.equal(await BossJD.getCurrentJdId(), 'indonesia-intern-2026');
  await BossJD.deleteTemplate('indonesia-intern-2026');
  assert.equal(await BossJD.getCurrentJdId(), '');
  const list = await BossJD.listTemplates();
  assert.equal(list.length, 2);
  assert.equal(list[0].jdId, 'qa-engineer-2026');
  assert.equal(list[1].jdId, 'ai-cx-2026');
});
