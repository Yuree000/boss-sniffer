// 测试 v0.22.5 · A 阶段：IDB DB_VERSION 6→7 + dismissed_candidates store + 备份按钮
//
// 见 .claude/plans/resilient-dazzling-dove.md §A
//
// 范围：
//   - DB_VERSION 升 6→7（仅新增 store，不破坏既有）
//   - dismissed_candidates store + 3 个 indexes (dismissedAt / expiresAt / status)
//   - EXPORT_IDB_BUNDLE message handler（读所有 store → 备份 JSON）
//   - admin 危险操作区新增「📦 导出 IDB 备份 JSON」按钮 + click handler
//
// 跑：node --test tests/v0_22_5-idb-backup.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const bg = read('background.js');
const adminHtml = read('admin/admin.html');
const adminJs = read('admin/admin.js');

// =========================================================================
// A. DB_VERSION 升 6→7（仅 const 升 + onupgradeneeded 新增段）
// =========================================================================

// v0.24.4：删 v0.22.5 加的 dismissed_candidates store（30s 撤销窗口设计回退）
// DB_VERSION 7→8；onupgradeneeded v8 段执行 deleteObjectStore；常量保留供升级使用
test('v0.24.4 A1: DB_VERSION === 8（v7 → v8 删 store）', () => {
  assert.match(bg, /const\s+DB_VERSION\s*=\s*8\b/);
});

test('v0.24.4 A2: 老 DB_VERSION = 7 已被取代（防遗留旧值导致 IDB 不升级）', () => {
  assert.doesNotMatch(bg, /const\s+DB_VERSION\s*=\s*7\b/);
});

test('v0.24.4 A3: STORE_DISMISSED_CANDIDATES 常量保留（供 onupgradeneeded 使用）', () => {
  // store 不再使用，但常量保留方便 v8 升级时引用
  assert.match(bg, /const\s+STORE_DISMISSED_CANDIDATES\s*=\s*['"]dismissed_candidates['"]/);
});

test('v0.24.4 A4: onupgradeneeded 删 dismissed_candidates store（v8 升级时执行）', () => {
  // 守卫式删除：if (contains) deleteObjectStore
  assert.match(bg, /if\s*\(\s*db\.objectStoreNames\.contains\(\s*STORE_DISMISSED_CANDIDATES\s*\)\s*\)/);
  assert.match(bg, /db\.deleteObjectStore\(\s*STORE_DISMISSED_CANDIDATES\s*\)/);
});

test('v0.24.4 A5: 不再 createObjectStore(STORE_DISMISSED_CANDIDATES)', () => {
  assert.doesNotMatch(bg, /createObjectStore\(\s*STORE_DISMISSED_CANDIDATES/);
});

test('v0.24.4 A6: 不再 createIndex 3 个 dismissed_* 索引', () => {
  // 这 3 个 createIndex 应该全删（它们只在 dismissed_candidates store 上有）
  // 注意 dismissedAt 等是字段名，不会出现在其他 createIndex 里
  const createIndexBlocks = bg.match(/createIndex\(\s*['"]dismissedAt['"]/g) || [];
  assert.equal(createIndexBlocks.length, 0, 'dismissedAt index 应已删除');
});

test('A7: 既有 5 个 store 的 contains 守卫都保留（升级不破坏既有 schema）', () => {
  ['STORE_CAPTURES', 'STORE_EVALUATIONS', 'STORE_EVENTS', 'STORE_SAYHI_POOL', 'STORE_DIAG_LOGS'].forEach(function (name) {
    const re = new RegExp('if\\s*\\(\\s*!db\\.objectStoreNames\\.contains\\(\\s*' + name + '\\s*\\)\\s*\\)');
    assert.match(bg, re, '既有 store 守卫缺失：' + name);
  });
});

// =========================================================================
// B. EXPORT_IDB_BUNDLE message handler
// =========================================================================

test('B1: background.js 含 EXPORT_IDB_BUNDLE case', () => {
  assert.match(bg, /case\s*['"]EXPORT_IDB_BUNDLE['"]/);
});

test('B2: EXPORT_IDB_BUNDLE handler 调用 buildIdbBackupBundle 或类似函数', () => {
  // 提取 case 'EXPORT_IDB_BUNDLE' 到 return true 的代码块
  const m = bg.match(/case\s*['"]EXPORT_IDB_BUNDLE['"]:[\s\S]*?return true;/);
  assert.ok(m, '未找到 EXPORT_IDB_BUNDLE handler');
  // 必须有"读 IDB 输出 bundle"的功能调用
  assert.match(m[0], /buildIdbBackupBundle|buildIdbBundle|exportIdb/);
});

test('B3: buildIdbBackupBundle 函数定义存在', () => {
  assert.match(bg, /async\s+function\s+buildIdbBackupBundle\s*\(/);
});

test('v0.24.4 B4: buildIdbBackupBundle 不再读 STORE_DISMISSED_CANDIDATES（已删除）', () => {
  const m = bg.match(/async\s+function\s+buildIdbBackupBundle\s*\([\s\S]*?\n\}/);
  assert.ok(m, '未找到 buildIdbBackupBundle 函数体');
  const body = m[0];
  // 其他 4 个 store 仍在
  ['STORE_CAPTURES', 'STORE_EVALUATIONS', 'STORE_EVENTS', 'STORE_SAYHI_POOL'].forEach(function (name) {
    assert.match(body, new RegExp(name), '备份 bundle 应仍含 ' + name);
  });
  // STORE_DISMISSED_CANDIDATES 不在 backup 列表中
  assert.doesNotMatch(body, /STORE_DISMISSED_CANDIDATES/);
});

test('B5: bundle 结构含 version / exportedAt / stores 字段', () => {
  const m = bg.match(/async\s+function\s+buildIdbBackupBundle\s*\([\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /exportedAt/);
  assert.match(m[0], /version/);
  // stores 是核心字段（按 store 名分组的 rows）
  assert.match(m[0], /stores/);
});

// =========================================================================
// C. admin UI：危险操作区加备份按钮
// =========================================================================

test('C1: admin.html 危险操作区含 #btn-export-idb-backup 按钮', () => {
  assert.match(adminHtml, /id="btn-export-idb-backup"/);
});

test('C2: 备份按钮在危险操作 section 内（而非别处）', () => {
  // 危险操作 section 起点
  const dangerStart = adminHtml.indexOf('危险操作');
  assert.ok(dangerStart > 0, '危险操作 section 未找到');
  const btnIdx = adminHtml.indexOf('id="btn-export-idb-backup"');
  assert.ok(btnIdx > dangerStart, '备份按钮应在危险操作 section 内');
});

test('C3: 备份按钮附近有「IDB 升级」+「v0.23.x 沟通页改造收尾」相关说明', () => {
  const btnIdx = adminHtml.indexOf('id="btn-export-idb-backup"');
  const ctx = adminHtml.slice(Math.max(0, btnIdx - 600), btnIdx + 600);
  // 文案应提到这是 IDB schema 升级前的回滚兜底
  assert.match(ctx, /IDB|备份|schema|回滚/);
});

// =========================================================================
// D. admin.js click handler
// =========================================================================

test('D1: admin.js 含 #btn-export-idb-backup click handler', () => {
  assert.match(adminJs, /\$\(['"]btn-export-idb-backup['"]\)\.addEventListener\(['"]click['"]/);
});

test('D2: click handler 发 EXPORT_IDB_BUNDLE message', () => {
  // 找 handler 函数体
  const m = adminJs.match(/\$\(['"]btn-export-idb-backup['"]\)\.addEventListener\(['"]click['"],[\s\S]*?\n\s{0,4}\}\);/);
  assert.ok(m, '未找到 backup button click handler');
  assert.match(m[0], /type:\s*['"]EXPORT_IDB_BUNDLE['"]/);
});

test('D3: handler 用 Blob + a.click 触发下载（与 diag bundle 同模式）', () => {
  const m = adminJs.match(/\$\(['"]btn-export-idb-backup['"]\)\.addEventListener\(['"]click['"],[\s\S]*?\n\s{0,4}\}\);/);
  assert.ok(m);
  assert.match(m[0], /new\s+Blob\(/);
  assert.match(m[0], /URL\.createObjectURL/);
  assert.match(m[0], /\.click\(\)/);
});

test('D4: 下载文件名格式 boss-sniffer-idb-backup-YYYYMMDD-HHMM.json', () => {
  const m = adminJs.match(/\$\(['"]btn-export-idb-backup['"]\)\.addEventListener\(['"]click['"],[\s\S]*?\n\s{0,4}\}\);/);
  assert.ok(m);
  // 文件名 prefix
  assert.match(m[0], /boss-sniffer-idb-backup/);
  // .json 后缀
  assert.match(m[0], /\.json/);
});

// =========================================================================
// E. 不破坏既有功能
// =========================================================================

test('E1: 老 EXPORT_DIAG_BUNDLE case 仍存在（不同功能，不替代）', () => {
  assert.match(bg, /case\s*['"]EXPORT_DIAG_BUNDLE['"]/);
});

test('E2: 既有 #btn-danger-clear-eval / -all 按钮保留', () => {
  assert.match(adminHtml, /id="btn-danger-clear-eval"/);
  assert.match(adminHtml, /id="btn-danger-clear-all"/);
});

test('E3: openDB 函数返回 Promise（不变）', () => {
  assert.match(bg, /function\s+openDB\s*\(\s*\)\s*\{[\s\S]*?return\s+new\s+Promise/);
});
