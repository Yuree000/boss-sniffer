// 测试 lib/diag-log.js — 环形 buffer 写入 / 读取 / 清理 / 失败兜底

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 极简内存 IDB 实现:足以让 diag-log.js 跑起来,不追求完整 spec
function makeFakeDb() {
  const rows = [];   // { id, ts, level, tag, msg, payload }
  let nextId = 1;

  function transaction(_storeName, _mode) {
    let completeCb = null;
    let errorCb = null;
    const store = {
      add: function (entry) {
        const r = Object.assign({ id: nextId++ }, entry);
        rows.push(r);
        const req = {};
        // 模拟异步成功:简单同步触发 tx.oncomplete 在 microtask 之后
        setTimeout(function () { if (completeCb) completeCb(); }, 0);
        return req;
      },
      count: function () {
        const req = {};
        setTimeout(function () {
          req.result = rows.length;
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      },
      getAll: function () {
        const req = {};
        setTimeout(function () {
          req.result = rows.slice();
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      },
      openCursor: function () {
        const req = {};
        setTimeout(function () {
          let i = 0;
          function step() {
            if (i >= rows.length) {
              req.onsuccess({ target: { result: null } });
              return;
            }
            const idx = i;
            const cursor = {
              delete: function () { rows.splice(idx, 1); },
              continue: function () {
                // delete 之后数组已位移,但我们用 idx 索引扫描原数组其实有 bug
                // 简化:每次扫第 0 个,删了就少一个
                step();
              }
            };
            // 调整:从尾递归改为始终消费第 0 个,删的也是第 0 个
            req.onsuccess({ target: { result: cursor } });
          }
          // 改用更直观的方式:循环消费 rows[0]
          (function loop() {
            if (rows.length === 0) {
              req.onsuccess({ target: { result: null } });
              return;
            }
            const cursor = {
              delete: function () { rows.shift(); },
              continue: function () { setTimeout(loop, 0); }
            };
            req.onsuccess({ target: { result: cursor } });
          })();
        }, 0);
        return req;
      },
      clear: function () {
        rows.length = 0;
        setTimeout(function () { if (completeCb) completeCb(); }, 0);
      }
    };
    const tx = {
      objectStore: function () { return store; },
      set oncomplete(cb) { completeCb = cb; },
      set onerror(cb) { errorCb = cb; },
      set onabort(cb) { /* ignore */ }
    };
    return tx;
  }
  return {
    transaction: transaction,
    __rows: rows
  };
}

function loadDiag(fakeDb, extraSelf) {
  const file = path.resolve(__dirname, '../lib/diag-log.js');
  const code = fs.readFileSync(file, 'utf8');
  const baseSelf = {
    BOSS_OPEN_DB: function () { return Promise.resolve(fakeDb); },
    BOSS_STORE_DIAG_LOGS: 'diag_logs'
  };
  const ctx = {
    self: Object.assign(baseSelf, extraSelf || {}),
    console: { warn: function () {}, info: function () {}, error: function () {} },
    setTimeout: setTimeout,
    Date: Date
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return { D: ctx.self.BossDiag, db: fakeDb };
}

function tick() { return new Promise(function (r) { setTimeout(r, 5); }); }

test('log 写入 + recent 读取(按 ts 降序)', async () => {
  const { D, db } = loadDiag(makeFakeDb());
  await D.log('info', 'evaluate', '批次启动', { n: 5 });
  await D.log('warn', 'judge.retry', '第 2 次失败');
  await tick();
  const list = await D.recent();
  assert.equal(list.length, 2);
  // 最新在前
  assert.equal(list[0].tag, 'judge.retry');
  assert.equal(list[1].tag, 'evaluate');
  assert.equal(list[1].payload.n, 5);
  assert.equal(db.__rows.length, 2);
});

test('非法 level 退回 info', async () => {
  const { D } = loadDiag(makeFakeDb());
  await D.log('xxxx', 'tag', 'msg');
  await tick();
  const list = await D.recent();
  assert.equal(list[0].level, 'info');
});

test('payload 非 object → 存 null', async () => {
  const { D } = loadDiag(makeFakeDb());
  await D.log('info', 't', 'm', 'not an object');
  await D.log('info', 't', 'm', null);
  await tick();
  const list = await D.recent();
  list.forEach(function (e) { assert.equal(e.payload, null); });
});

test('超过 MAX_ENTRIES (500) 触发清理,保留最新 500', async () => {
  const { D, db } = loadDiag(makeFakeDb());
  // 写 510 条
  for (let i = 0; i < 510; i++) {
    await D.log('info', 'bulk', 'm' + i, { i: i });
  }
  await tick();
  await tick();
  await tick();
  // 清理是 fire-and-forget,可能还没跑完;再 trigger 一次给清理时间
  await D.log('info', 'final', 'after-bulk');
  await tick();
  await tick();
  assert.ok(db.__rows.length <= D.MAX_ENTRIES + 5,
    'rows 应被裁剪到接近 MAX_ENTRIES,实际 ' + db.__rows.length);
  // 最早的 (m0) 应已被删除
  const survivedTags = db.__rows.map(function (r) { return r.msg; });
  assert.ok(survivedTags.indexOf('m0') === -1, 'm0 应已被裁掉');
});

test('IDB 不可用时 log 不抛错(主链路保护)', async () => {
  // 用一个 self,完全没注册 BOSS_OPEN_DB
  const file = path.resolve(__dirname, '../lib/diag-log.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = {
    self: {},  // 没有 BOSS_OPEN_DB
    console: { warn: function () {}, info: function () {}, error: function () {} },
    setTimeout: setTimeout,
    Date: Date
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  const D = ctx.self.BossDiag;
  // 不应抛错
  await D.log('error', 'tag', 'msg');
  const list = await D.recent();
  assert.equal(list.length, 0);
});

test('clearAll 清空 store', async () => {
  const { D, db } = loadDiag(makeFakeDb());
  await D.log('info', 't', 'm1');
  await D.log('info', 't', 'm2');
  await tick();
  await D.clearAll();
  await tick();
  assert.equal(db.__rows.length, 0);
});

test('暴露 API 完整', async () => {
  const { D } = loadDiag(makeFakeDb());
  assert.equal(typeof D.log, 'function');
  assert.equal(typeof D.recent, 'function');
  assert.equal(typeof D.clearAll, 'function');
  assert.equal(D.MAX_ENTRIES, 500);
});
