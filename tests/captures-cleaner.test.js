const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

test('cleanExpiredCaptures 用 capturedAt 索引 keyRange 删过期', () => {
  const src = read('lib/captures-cleaner.js');
  assert.match(src, /idx\.openCursor\(range\)/);
  assert.match(src, /IDBKeyRange\.upperBound\(cutoff/);
  assert.match(src, /DEFAULT_MAX_AGE_MS = 7 \* 24/);
});

test('background.js SW 启动调一次 cleanExpiredCaptures', () => {
  const src = read('background.js');
  assert.match(src, /BossCapturesCleaner\.cleanExpiredCaptures\(\)/);
});

test('alarms captures-cleanup 注册存在且 idempotent', () => {
  const src = read('background.js');
  assert.match(src, /chrome\.alarms\.get\('captures-cleanup'/);
  assert.match(src, /if \(!existing\) chrome\.alarms\.create\('captures-cleanup'/);
  assert.match(src, /alarm\.name === 'captures-cleanup'/);
});

test('manifest 加了 alarms 权限', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(m.permissions.includes('alarms'));
});
