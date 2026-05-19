const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

test('admin.html 有数据导入/导出按钮', () => {
  const html = read('admin/admin.html');
  assert.match(html, /id="btn-import-backup"/);
  assert.match(html, /id="btn-export-jd"/);
  assert.match(html, /id="btn-import-jd"/);
  assert.match(html, /id="import-result"/);
});

test('admin.html 引入 storage-sync.js（在 admin.js 之前）', () => {
  const html = read('admin/admin.html');
  const syncIdx = html.indexOf('lib/storage-sync.js');
  const adminIdx = html.indexOf('"admin.js"');
  assert.ok(syncIdx > -1, 'storage-sync.js 必须被引入');
  assert.ok(adminIdx > -1, 'admin.js 必须被引入');
  assert.ok(syncIdx < adminIdx, 'storage-sync.js 必须在 admin.js 之前');
});

test('admin.js 用 showDirectoryPicker 选目录 + 按 YYYY-MM.json 过滤', () => {
  const src = read('admin/admin.js');
  assert.match(src, /showDirectoryPicker\(\{ mode: 'read'/);
  assert.match(src, /\^\\d\{4\}-\\d\{2\}\\\.json\$/);
});

test('admin.js bulkWrite events 删 id 让 autoIncrement', () => {
  const src = read('admin/admin.js');
  assert.match(src, /delete copy\.id/);
});

test('admin.js 导出 JD 用 BossStorageSync.get + Blob 下载', () => {
  const src = read('admin/admin.js');
  assert.match(src, /BossStorageSync\.get\(\['jd_templates'/);
  assert.match(src, /new Blob/);
});

test('admin.js 导入 JD 用 BossStorageSync.set', () => {
  const src = read('admin/admin.js');
  assert.match(src, /BossStorageSync\.set\(\{ jd_templates:/);
});

test('admin.js openIDB 带防御性 onupgradeneeded（v5 兜底）', () => {
  const src = read('admin/admin.js');
  assert.match(src, /req\.onupgradeneeded[\s\S]*?createObjectStore\('fsa_state'/);
  assert.match(src, /req\.onupgradeneeded[\s\S]*?createObjectStore\('pending_fsa_writes'/);
});

test('admin.js AbortError 不报错而是显示「已取消」', () => {
  const src = read('admin/admin.js');
  assert.match(src, /e\.name === 'AbortError'[\s\S]*?'已取消'/);
});
