// BUG 1 复现测试：evalSayhiCore 中途异常会留 pending 孤儿
//
// 背景：HR 反馈点"开始本轮"后，有些候选人一直显示"判断中"，
// 即使本轮结束（按钮变回"开始本轮"）那些候选人 UI 上仍显示"判断中"。
//
// 根因（已查证）：
//   background.js:1347-1554 的 evalSayhiCore 是 (async function () { ... })() IIFE，
//   循环里的多个 await 不在 try 内：
//     - line 1438 triggerClickAndScanDetail
//     - line 1443 mergeDomDetailIntoSayhiPool
//     - line 1456 getSayhiPool
//     - line 1480 upsertEvaluation
//   任一抛错 → IIFE 顶层 catch（line 1548-1550）只 log 不清 pending，
//   剩下没跑完的候选人的 pending 占位行成孤儿，5 分钟后才被 watchdog 兜底
//   (line 2531 PENDING_STALE_MS = 5*60*1000)。
//
// 跑：node --test tests/eval-sayhi-pending-orphan.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bgJs = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// ============ A) 静态断言：对源码结构证明 BUG 存在 ============

test('A1: evalSayhiCore 的 for 循环包在 (async function () { ... })() IIFE 里', () => {
  const fnStart = bgJs.indexOf('async function evalSayhiCore');
  assert.ok(fnStart > 0, 'evalSayhiCore 必须存在');
  // IIFE 起点
  const iifeStart = bgJs.indexOf('(async function () {', fnStart);
  assert.ok(iifeStart > 0 && iifeStart - fnStart < 4000,
    'evalSayhiCore 内部应有 (async function () { ... })() IIFE');
});

test('A2: IIFE 顶层 catch 块只 log 不调 clearPendingEvaluations（孤儿源 1）', () => {
  // 截取 evalSayhiCore 函数体（约 250 行）
  const start = bgJs.indexOf('async function evalSayhiCore');
  const end = bgJs.indexOf('\nasync function evalSayhiBatch');
  const body = bgJs.slice(start, end);
  // 找 IIFE 的 try/catch/finally 段
  const catchMatch = body.match(/\}\s*catch\s*\(e\)\s*\{[\s\S]*?\}\s*finally\s*\{/);
  assert.ok(catchMatch, '应能定位 IIFE 顶层 catch/finally');
  const catchBlock = catchMatch[0];
  // 关键断言：当前代码 catch 块里没有清理 pending 的逻辑 → BUG 在此
  assert.doesNotMatch(catchBlock, /clearPendingEvaluations/,
    'BUG: IIFE 顶层 catch 不清 pending；修复后此断言会失败（提示更新测试）');
  // 顺便记录 catch 实际只做了什么
  assert.match(catchBlock, /console\.error/,
    '当前 catch 仅 console.error 落地，没有任何状态修复');
});

test('A3: 循环内 4 个关键 await 不在 try/catch 内（孤儿源 2 — 异常不被拦下）', () => {
  const start = bgJs.indexOf('for (let i = 0; i < todo.length; i++) {', bgJs.indexOf('evalSayhiCore'));
  const end = bgJs.indexOf('\n      if (self.BossDiag) {', start);
  const loopBody = bgJs.slice(start, end);
  assert.ok(loopBody.length > 0, '应能定位串行循环体');

  // 这 4 个 await 当前都直接暴露在循环顶层（非 try 内）
  const exposedAwaits = [
    'await triggerClickAndScanDetail',
    'await mergeDomDetailIntoSayhiPool',
    'await getSayhiPool()',
    'await upsertEvaluation('
  ];
  exposedAwaits.forEach(function (snippet) {
    assert.match(loopBody, new RegExp(snippet.replace(/[()]/g, '\\$&')),
      '循环体应含 ' + snippet);
  });

  // 唯一被 try 包住的是 BossJudge.judgeCandidate
  const tryMatch = loopBody.match(/try\s*\{[\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?status:\s*'failed'/);
  assert.ok(tryMatch, '只有 BossJudge.judgeCandidate 被 try 拦截转 failed');
  // try 体内只含 judgeCandidate，不含其他 4 个 await
  const tryBody = tryMatch[0];
  exposedAwaits.forEach(function (snippet) {
    assert.doesNotMatch(tryBody, new RegExp(snippet.replace(/[()]/g, '\\$&')),
      snippet + ' 不在 try 内（这就是孤儿源）');
  });
});

test('A4: pending watchdog 兜底周期 5 分钟（HR 体感"过了一段时间仍判断中"的真相）', () => {
  assert.match(bgJs, /PENDING_STALE_MS = 5 \* 60 \* 1000/,
    '当前 watchdog 等 5 分钟才把孤儿 pending 转 failed');
  // 注释里已自认是 SW 中断兜底
  assert.match(bgJs, /SW 可能中途重启/);
});

// ============ B) 行为复现：mock 版 runSerialEval 注入中途异常 ============
//
// 这一段独立用 Map 模拟 evaluations store + 一个最小串行循环，
// 镜像 evalSayhiCore 的 4 个关键阶段（pending upsert / scan / LLM / final upsert），
// 注入"第 3 个候选人 mergeDomDetail 抛错"，断言剩下 N-3 个 pending 孤儿存在。
//
// 这个复现独立于 background.js（不 require chrome / IndexedDB），
// 但逻辑结构与真实 evalSayhiCore 等价 → 同样的代码模式同样会有 BUG。

function makeMockStore() {
  const store = new Map();
  return {
    upsertOne: async function (rec) { store.set(rec.candidateId, rec); },
    upsertMany: async function (recs) { recs.forEach(function (r) { store.set(r.candidateId, r); }); },
    all: async function () { return Array.from(store.values()); },
    countPending: async function () {
      let n = 0;
      store.forEach(function (r) { if (r.evaluation && r.evaluation.status === 'pending') n++; });
      return n;
    }
  };
}

// 简化版 runSerialEval —— 镜像 evalSayhiCore 的结构（含相同 BUG）
async function runSerialEvalBuggy(todo, deps) {
  // 阶段 1：批量写 pending 占位（镜像 background.js:1387-1395）
  await deps.upsertMany(todo.map(function (c) {
    return {
      candidateId: c.candidateId,
      evaluation: { status: 'pending', startedAt: Date.now() }
    };
  }));

  // 阶段 2：(async function () { ... })() IIFE 串行循环（镜像 background.js:1347-1554）
  try {
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i];
      // 镜像 line 1438：triggerClickAndScanDetail 不在 try 内
      await deps.scanDetail(c.candidateId);
      // 镜像 line 1443：mergeDomDetailIntoSayhiPool 不在 try 内
      await deps.mergeDomDetail(c.candidateId);
      // 镜像 line 1462-1479：只有 LLM 调用被 try 包
      let evaluation;
      try {
        evaluation = await deps.judge(c);
      } catch (err) {
        evaluation = { status: 'failed', error: err.message };
      }
      // 镜像 line 1480：final upsert 不在 try 内
      await deps.upsertOne({ candidateId: c.candidateId, evaluation: evaluation });
    }
  } catch (e) {
    // 镜像 line 1548-1550：顶层 catch 只 log 不清 pending ← BUG 在此
    // （这里故意空 catch，匹配真实代码行为）
  }
}

test('B1: 顺路场景 — 全 5 人跑完，0 pending 孤儿', async () => {
  const store = makeMockStore();
  const todo = [1, 2, 3, 4, 5].map(function (id) { return { candidateId: id }; });
  await runSerialEvalBuggy(todo, {
    upsertMany: store.upsertMany,
    upsertOne: store.upsertOne,
    scanDetail: async function () {},
    mergeDomDetail: async function () {},
    judge: async function () { return { status: 'done', decision: '符合' }; }
  });
  assert.equal(await store.countPending(), 0, '顺路全跑完应无 pending');
});

test('B2: LLM 单个失败 — 仍是 0 pending（被 catch 转 failed 覆写）', async () => {
  const store = makeMockStore();
  const todo = [1, 2, 3, 4, 5].map(function (id) { return { candidateId: id }; });
  await runSerialEvalBuggy(todo, {
    upsertMany: store.upsertMany,
    upsertOne: store.upsertOne,
    scanDetail: async function () {},
    mergeDomDetail: async function () {},
    judge: async function (c) {
      if (c.candidateId === 3) throw new Error('LLM 503');
      return { status: 'done', decision: '符合' };
    }
  });
  assert.equal(await store.countPending(), 0,
    'LLM 抛错被内层 try 转 failed，循环继续 → 仍是 0 孤儿');
});

test('B3: BUG 现场 — 中途 mergeDomDetail 抛错，剩下 N-i 个 pending 孤儿', async () => {
  const store = makeMockStore();
  const todo = [1, 2, 3, 4, 5].map(function (id) { return { candidateId: id }; });
  await runSerialEvalBuggy(todo, {
    upsertMany: store.upsertMany,
    upsertOne: store.upsertOne,
    scanDetail: async function () {},
    mergeDomDetail: async function (id) {
      // 模拟 chrome.runtime.sendMessage 偶发抛错（标签页死/导航走）
      if (id === 3) throw new Error('content script disconnected');
    },
    judge: async function () { return { status: 'done', decision: '符合' }; }
  });
  // 候选人 1、2 跑完转 done；3 在 mergeDomDetail 抛错 → IIFE catch 接住 → 4、5 永远没轮到
  // 当前代码：3 仍是 pending（pending 占位没被 LLM 覆写），4、5 也是 pending
  const pending = await store.countPending();
  assert.equal(pending, 3,
    'BUG 现场：候选人 3、4、5 的 pending 占位全成孤儿（实际 ' + pending + '）');
});

test('B4: BUG 现场 2 — scanDetail 抛错也一样有孤儿', async () => {
  const store = makeMockStore();
  const todo = [1, 2, 3, 4, 5].map(function (id) { return { candidateId: id }; });
  await runSerialEvalBuggy(todo, {
    upsertMany: store.upsertMany,
    upsertOne: store.upsertOne,
    scanDetail: async function (id) {
      if (id === 2) throw new Error('tab closed during scan');
    },
    mergeDomDetail: async function () {},
    judge: async function () { return { status: 'done', decision: '符合' }; }
  });
  const pending = await store.countPending();
  assert.equal(pending, 4,
    'scanDetail 在 c=2 抛错 → 2、3、4、5 全成 pending 孤儿（实际 ' + pending + '）');
});

test('B5: BUG 现场 3 — 最终 upsertOne 抛错（IndexedDB 拥塞），剩下也都是孤儿', async () => {
  const store = makeMockStore();
  const todo = [1, 2, 3, 4, 5].map(function (id) { return { candidateId: id }; });
  let upsertCount = 0;
  await runSerialEvalBuggy(todo, {
    upsertMany: store.upsertMany,
    upsertOne: async function (rec) {
      upsertCount++;
      // 模拟第 4 次写 upsertOne 时 IDB 拥塞
      if (upsertCount === 4) throw new Error('IDB QuotaExceeded');
      return store.upsertOne(rec);
    },
    scanDetail: async function () {},
    mergeDomDetail: async function () {},
    judge: async function () { return { status: 'done', decision: '符合' }; }
  });
  // upsertOne 第 1/2/3 次（c=1/2/3）成功覆写为 done，第 4 次（c=4）抛 → 4、5 永远没机会
  const pending = await store.countPending();
  assert.equal(pending, 2,
    'final upsert 在 c=4 抛错 → 4、5 是孤儿（实际 ' + pending + '）');
});
