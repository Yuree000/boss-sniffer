// 测试 lib/greet-templates.js 的 SEED + CRUD 逻辑（克隆 jd-templates-seed.test.js 模式）
// 跑：node --test tests/greet-templates-seed.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    precheckSize: function () {},
    migrateFromLocal: function (keys) {
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

function loadGreet(initialSyncStore, initialLocalStore) {
  const { BossStorageSyncMock, chromeMock } = makeSyncMock(initialSyncStore, initialLocalStore);
  const file = path.resolve(__dirname, '../lib/greet-templates.js');
  const code = fs.readFileSync(file, 'utf8');
  const selfObj = { BossStorageSync: BossStorageSyncMock };
  const ctx = {
    self: selfObj,
    console,
    chrome: chromeMock
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return { BossGreetTemplates: ctx.self.BossGreetTemplates, ctx: ctx };
}

test('ensureSeeded — 空 storage 写入三条 SEED + 当前默认 = 通用礼貌型', async () => {
  const { BossGreetTemplates } = loadGreet();
  await BossGreetTemplates.ensureSeeded();
  const list = await BossGreetTemplates.listTemplates();
  assert.equal(list.length, 3);
  assert.equal(list[0].greetId, 'greet-generic-2026');
  assert.equal(list[0].name, '通用礼貌型');
  assert.equal(list[1].greetId, 'greet-brief-2026');
  assert.equal(list[1].name, '简洁型');
  assert.equal(list[2].greetId, 'greet-intro-2026');
  assert.equal(list[2].name, '自我介绍型');
  assert.equal(await BossGreetTemplates.getCurrentGreetId(), 'greet-generic-2026');
});

test('ensureSeeded — SEED text 全部 >= MIN_TEXT_LEN', async () => {
  const { BossGreetTemplates } = loadGreet();
  await BossGreetTemplates.ensureSeeded();
  const list = await BossGreetTemplates.listTemplates();
  list.forEach(function (t) {
    assert.ok(t.text.trim().length >= BossGreetTemplates.MIN_TEXT_LEN,
      'SEED ' + t.name + ' text 太短：' + t.text);
  });
});

test('ensureSeeded — 已有数据则幂等', async () => {
  const { BossGreetTemplates } = loadGreet({
    greet_templates: [{
      greetId: 'custom-1',
      name: '自定义话术',
      text: '你好朋友，能聊聊吗',
      createdAt: 100,
      updatedAt: 100
    }],
    current_greet_id: 'custom-1'
  });
  await BossGreetTemplates.ensureSeeded();
  const list = await BossGreetTemplates.listTemplates();
  assert.equal(list.length, 1);
  assert.equal(list[0].greetId, 'custom-1');
  assert.equal(list[0].createdAt, 100);
  assert.equal(await BossGreetTemplates.getCurrentGreetId(), 'custom-1');
});

test('ensureSeeded — 从 local 迁移到 sync', async () => {
  // 旧数据在 local（尚未迁移到 sync）
  const { BossGreetTemplates } = loadGreet({}, {
    greet_templates: [{
      greetId: 'legacy-1',
      name: '旧话术',
      text: '您好，请问方便聊聊吗',
      createdAt: 100,
      updatedAt: 100
    }],
    current_greet_id: 'legacy-1'
  });
  await BossGreetTemplates.ensureSeeded();
  const list = await BossGreetTemplates.listTemplates();
  assert.equal(list.length, 1);
  assert.equal(list[0].greetId, 'legacy-1');
});

test('saveTemplate — text 少于 5 字符报错', async () => {
  const { BossGreetTemplates } = loadGreet();
  await assert.rejects(
    () => BossGreetTemplates.saveTemplate({
      name: '太短',
      text: '嗨'
    }),
    /至少需要 5 字符/
  );
});

test('saveTemplate — text trim 后少于 5 字符报错（防纯空白）', async () => {
  const { BossGreetTemplates } = loadGreet();
  await assert.rejects(
    () => BossGreetTemplates.saveTemplate({
      name: '空白',
      text: '   嗨   '
    }),
    /至少需要 5 字符/
  );
});

test('saveTemplate — name 必填', async () => {
  const { BossGreetTemplates } = loadGreet();
  await assert.rejects(
    () => BossGreetTemplates.saveTemplate({
      text: '您好，方便聊聊吗？'
    }),
    /name 必填/
  );
});

test('saveTemplate — 新建生成 greetId + createdAt + updatedAt', async () => {
  const { BossGreetTemplates } = loadGreet();
  const saved = await BossGreetTemplates.saveTemplate({
    name: '新话术',
    text: '您好，看到您的简历，很合适我们的岗位'
  });
  assert.ok(saved.greetId);
  assert.ok(saved.createdAt > 0);
  assert.ok(saved.updatedAt > 0);
  assert.equal(saved.text, '您好，看到您的简历，很合适我们的岗位');
});

test('saveTemplate — 编辑保留 createdAt 更新 updatedAt', async () => {
  const { BossGreetTemplates } = loadGreet();
  const first = await BossGreetTemplates.saveTemplate({
    name: '初次',
    text: '初版话术，您好方便聊聊吗'
  });
  // 等 1ms 确保 updatedAt 不同
  await new Promise(function (r) { setTimeout(r, 5); });
  const updated = await BossGreetTemplates.saveTemplate({
    greetId: first.greetId,
    name: '更新后',
    text: '更新版话术，您好您看挺合适的方便聊聊吗'
  });
  assert.equal(updated.greetId, first.greetId);
  assert.equal(updated.createdAt, first.createdAt);  // 保留
  assert.ok(updated.updatedAt > first.updatedAt);    // 更新
  assert.equal(updated.name, '更新后');
});

test('deleteTemplate — 删的是当前 → 当前置空', async () => {
  const { BossGreetTemplates } = loadGreet();
  await BossGreetTemplates.ensureSeeded();
  // 当前 = greet-generic-2026
  const ok = await BossGreetTemplates.deleteTemplate('greet-generic-2026');
  assert.equal(ok, true);
  assert.equal(await BossGreetTemplates.getCurrentGreetId(), '');
  const list = await BossGreetTemplates.listTemplates();
  assert.equal(list.length, 2);  // 剩两个 SEED
});

test('deleteTemplate — 删不是当前 → 当前不变', async () => {
  const { BossGreetTemplates } = loadGreet();
  await BossGreetTemplates.ensureSeeded();
  await BossGreetTemplates.deleteTemplate('greet-brief-2026');
  assert.equal(await BossGreetTemplates.getCurrentGreetId(), 'greet-generic-2026');
});

test('getTemplate — 查不到返回 null', async () => {
  const { BossGreetTemplates } = loadGreet();
  await BossGreetTemplates.ensureSeeded();
  const t = await BossGreetTemplates.getTemplate('not-exist');
  assert.equal(t, null);
});

test('全局暴露：BossGreetTemplates API 完整性', async () => {
  const { BossGreetTemplates } = loadGreet();
  assert.equal(typeof BossGreetTemplates.listTemplates, 'function');
  assert.equal(typeof BossGreetTemplates.getTemplate, 'function');
  assert.equal(typeof BossGreetTemplates.saveTemplate, 'function');
  assert.equal(typeof BossGreetTemplates.deleteTemplate, 'function');
  assert.equal(typeof BossGreetTemplates.getCurrentGreetId, 'function');
  assert.equal(typeof BossGreetTemplates.setCurrentGreetId, 'function');
  assert.equal(typeof BossGreetTemplates.ensureSeeded, 'function');
  assert.equal(typeof BossGreetTemplates.MIN_TEXT_LEN, 'number');
  assert.equal(BossGreetTemplates.MIN_TEXT_LEN, 5);
  // SEED 常量
  assert.ok(BossGreetTemplates.SEED_GENERIC);
  assert.ok(BossGreetTemplates.SEED_BRIEF);
  assert.ok(BossGreetTemplates.SEED_INTRO);
});
