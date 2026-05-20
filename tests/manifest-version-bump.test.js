// 测试 manifest.json version + description 在每次 patch 升版后同步更新（防止忘改）
// 跑：node --test tests/manifest-version-bump.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('manifest.json version === 1.0.2', () => {
  assert.equal(manifest.version, '1.0.2');
});

test('manifest.json name === BOSS Sniffer（v0.20.11 简化，去掉「· 沟通页完整版」副标题）', () => {
  assert.equal(manifest.name, 'BOSS Sniffer');
});

test('manifest.json manifest_version === 3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('manifest.json description 一句话当前版本主题（v0.24.4 起规则，不再保留历史段）', () => {
  // description 简化为一句话当前版本 + 指向 CHANGELOG（v0.24.4 起规则）
  assert.match(manifest.description, new RegExp('v' + manifest.version));
  assert.match(manifest.description, /CHANGELOG/);
  // description 应短（< 200 字符），不再像 v0.24.3 前那样累积历史
  assert.ok(manifest.description.length < 200, 'description 应一句话（实测 ' + manifest.description.length + ' 字符）');
});

test('manifest.json 含必要 permissions', () => {
  const perms = manifest.permissions || [];
  assert.ok(perms.includes('storage'), 'storage permission 必须');
  assert.ok(perms.includes('sidePanel'), 'sidePanel permission 必须');
  assert.ok(perms.includes('tabs'), 'tabs permission 必须');
});

test('manifest.json 含 BOSS host_permissions', () => {
  const hp = manifest.host_permissions || [];
  assert.ok(hp.some(function (p) { return /zhipin\.com/.test(p); }), 'BOSS 域名 host permission 必须');
});

test('manifest.json content_scripts 含 inject.js + content.js', () => {
  const cs = manifest.content_scripts || [];
  const allJs = cs.flatMap(function (c) { return c.js || []; });
  assert.ok(allJs.includes('inject.js'));
  assert.ok(allJs.includes('content.js'));
});

test('manifest.json background.service_worker === background.js', () => {
  assert.equal(manifest.background && manifest.background.service_worker, 'background.js');
});
