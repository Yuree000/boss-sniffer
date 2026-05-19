// observability v1: pending-watchdog alarm 静态断言
// (sweepStalePending 的 IDB 链路在端到端手测覆盖;这里只确认结构正确)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

test('pending-watchdog alarm 注册用 alarms.get 守护幂等(规约 v0.17 教训)', () => {
  const src = read('background.js');
  assert.match(src, /chrome\.alarms\.get\('pending-watchdog'/);
  assert.match(src, /chrome\.alarms\.create\('pending-watchdog'/);
  // 必须在 alarms.get 回调里建,不能裸 create
  assert.match(src, /alarms\.get\('pending-watchdog'[\s\S]{0,200}if\s*\(\s*!existing\s*\)[\s\S]{0,200}alarms\.create\('pending-watchdog'/);
});

test('PENDING_STALE_MS = 5 分钟,PENDING_WATCHDOG_PERIOD_MIN = 0.5(30s)', () => {
  const src = read('background.js');
  assert.match(src, /PENDING_STALE_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(src, /PENDING_WATCHDOG_PERIOD_MIN\s*=\s*0\.5/);
});

test('sweepStalePending 写 status=failed 且带 AutoTimeout 标识', () => {
  const src = read('background.js');
  assert.match(src, /async function sweepStalePending/);
  assert.match(src, /status:\s*'failed'[\s\S]{0,300}AutoTimeout/);
});

test('onAlarm 监听里分派 pending-watchdog → sweepStalePending', () => {
  const src = read('background.js');
  assert.match(src, /alarm\.name === 'pending-watchdog'[\s\S]{0,80}sweepStalePending/);
});
