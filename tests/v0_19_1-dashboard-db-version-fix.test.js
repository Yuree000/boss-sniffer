// v0.19.1 BUG 修：dashboard.js 不再硬编码 DB_VERSION
// 背景：background.js 历次升 schema（v5 fsa_state / v6 observability v1 diag_logs），
// dashboard.js 落后于实际版本 → indexedDB.open(name, 5) 抛 VersionError，看板崩。
// 修法：openDb 不传 version 参数，浏览器自动开当前现存版本。
// 跑：node --test tests/v0_19_1-dashboard-db-version-fix.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const dashboardJs = fs.readFileSync(path.join(ROOT, 'dashboard/dashboard.js'), 'utf8');

test('dashboard.js 不再硬编码 DB_VERSION 常量（防再次落后于 background.js schema）', () => {
  assert.doesNotMatch(dashboardJs, /const DB_VERSION = \d+/);
});

test('dashboard.js openDb 用 indexedDB.open(DB_NAME)，不传 version', () => {
  // 必须是 open(DB_NAME) 单参数形式
  assert.match(dashboardJs, /indexedDB\.open\(DB_NAME\)/);
  // 不应再有 (DB_NAME, DB_VERSION) 两参数
  assert.doesNotMatch(dashboardJs, /indexedDB\.open\(DB_NAME,\s*DB_VERSION\)/);
});

test('dashboard.js 注释说明 schema 由 background.js 唯一管理', () => {
  // 留个解释为啥不传 version
  assert.match(dashboardJs, /schema 由 background\.js 唯一|background\.js 唯一负责/);
});
