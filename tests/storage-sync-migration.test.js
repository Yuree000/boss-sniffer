// 测试 lib/storage-sync.js 静态结构 + background.js 引用正确性
// 跑：node --test tests/storage-sync-migration.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

test('storage-sync.js 暴露 get/set/migrateFromLocal/precheckSize', () => {
  const src = read('lib/storage-sync.js');
  assert.match(src, /global\.BossStorageSync = \{/);
  assert.match(src, /get: get/);
  assert.match(src, /set: set/);
  assert.match(src, /migrateFromLocal: migrateFromLocal/);
  assert.match(src, /precheckSize: precheckSize/);
});

test('配额预检：单条超 8KB - 1KB 余量必须报错', () => {
  const src = read('lib/storage-sync.js');
  assert.match(src, /QUOTA_BYTES_PER_ITEM = 8192/);
  assert.match(src, /SAFETY_MARGIN = 1024/);
  assert.match(src, /SyncQuotaPerItemError/);
});

test('migrateFromLocal：sync 已有则跳过', () => {
  const src = read('lib/storage-sync.js');
  assert.match(src, /if \(syncBefore\[k\] !== undefined\)[\s\S]*?result\.skipped\.push/);
});

test('migrateFromLocal：per-key flag _migratedToSync_<key> 写入 local 副本不删', () => {
  const src = read('lib/storage-sync.js');
  assert.match(src, /_migratedToSync_/);
  assert.doesNotMatch(src, /chrome\.storage\.local\.remove/);
});

test('migrateFromLocal：per-key flag 不能跨 key set 互相截胡', () => {
  const src = read('lib/storage-sync.js');
  // 不应该有单一全局 flag 的 early-return
  assert.doesNotMatch(src, /localBefore\._migratedToSync === true/);
  // 应该用 per-key flag
  assert.match(src, /'_migratedToSync_' \+ k/);
});

test('get() 检查 chrome.runtime.lastError', () => {
  const src = read('lib/storage-sync.js');
  // get 函数体内必须有 lastError 检查
  assert.match(src, /async function get\([\s\S]*?chrome\.runtime\.lastError[\s\S]*?reject/);
});

test('jd-templates.js 改用 BossStorageSync', () => {
  const src = read('lib/jd-templates.js');
  assert.match(src, /BossStorageSync\.get/);
  assert.doesNotMatch(src, /chrome\.storage\.local\.get\(KEY_TEMPLATES/);
});

test('jd-templates ensureSeeded 加了 migrateFromLocal 调用', () => {
  const src = read('lib/jd-templates.js');
  assert.match(src, /BossStorageSync\.migrateFromLocal\(\[KEY_TEMPLATES/);
});

test('background.js loadConfig 改用 BossStorageSync', () => {
  const src = read('background.js');
  // v0.17.0.10 加 sayHiDom（POC A7 沟通页 DOM 扫描配置）
  // v0.17.1.0 加 autoAction（评估「符合」→ 自动输入话术 + 求简历）
  assert.match(src, /BossStorageSync\.migrateFromLocal\(\['llm', 'sayHi', 'sayHiDom', 'autoAction'\]/);
});

test('background.js importScripts 含 storage-sync.js 且在 jd-templates 之前', () => {
  const src = read('background.js');
  const m = src.match(/importScripts\(([^)]+)\)/);
  assert.ok(m);
  const order = m[1];
  const syncIdx = order.indexOf("'lib/storage-sync.js'");
  const jdIdx = order.indexOf("'lib/jd-templates.js'");
  assert.ok(syncIdx > -1 && jdIdx > -1);
  assert.ok(syncIdx < jdIdx, 'storage-sync.js 必须在 jd-templates.js 之前 importScripts');
});
