const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

test('background DB_VERSION ≥ 5 且 fsa_state + pending_fsa_writes store 已建', () => {
  const src = read('background.js');
  // observability v1 起 DB_VERSION = 6,匹配 5 或更高,避免每升一次版本就改这里
  assert.match(src, /DB_VERSION = ([5-9]|\d{2,})/);
  assert.match(src, /createObjectStore\('fsa_state'/);
  assert.match(src, /createObjectStore\('pending_fsa_writes'/);
});

test('enqueuePendingFsaWrite 用 month 作 keyPath 自动去重', () => {
  const src = read('background.js');
  assert.match(src, /async function enqueuePendingFsaWrite\(month\)/);
  assert.match(src, /pending_fsa_writes[\s\S]*?store\.put\(\{ month: month/);
});

test('upsertEvaluation 写完后埋 enqueuePendingFsaWrite', () => {
  const src = read('background.js');
  assert.match(src, /upsertEvaluation[\s\S]{0,3000}enqueuePendingFsaWrite/);
});

test('events.js logEvent 写完后埋入队', () => {
  const src = read('lib/events.js');
  assert.match(src, /BOSS_ENQUEUE_FSA_WRITE/);
});

test('fsa-backup.js 暴露的 API 齐全', () => {
  const src = read('lib/fsa-backup.js');
  assert.match(src, /global\.BossFsaBackup = \{/);
  ['getStatus', 'pickDir', 'requestPermission', 'consumePending', 'writeMonthFile'].forEach(function (fn) {
    assert.match(src, new RegExp(fn + ': ' + fn));
  });
});

// v0.18.1：sidepanel banner UI 已删（CSS display:flex 覆盖 [hidden] 导致空壳渲染）。
// PENDING_FSA_WRITE 广播 + lib/fsa-backup.js + pending_fsa_writes store 保留，等看板/备份重启时再接回。

test('fsa-backup.js openDB 带 onupgradeneeded 兜底（防 SW 未启时空 store）', () => {
  const src = read('lib/fsa-backup.js');
  assert.match(src, /req\.onupgradeneeded[\s\S]*?createObjectStore\('fsa_state'/);
  assert.match(src, /req\.onupgradeneeded[\s\S]*?createObjectStore\('pending_fsa_writes'/);
});
