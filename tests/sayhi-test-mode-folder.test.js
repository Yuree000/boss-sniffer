// 测试 v0.22.3 · Phase 2·2d：旧 sayhi-actions 按钮 + debug 日志视觉分组到「🧪 测试模式」折叠区
//
// 见 相关文档/specs/2026-05-19-沟通页改造-design.md §5.3
//
// 关键约束（spec §5）：
//   - 分组到折叠区 ≠ 删除（功能 100% 不变）
//   - 默认折叠（让 HR 看到主流程），HR 想用时展开
//   - 4 个旧按钮（scan / eval / stop / clear-pool）全部保留并仍可点
//   - 操作调试日志 #sayhi-debug-details 一并归类进折叠区
//
// 跑：node --test tests/sayhi-test-mode-folder.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const sidepanelHtml = read('sidepanel/sidepanel.html');
const sidepanelJs = read('sidepanel/sidepanel.js');

// 提取「🧪 测试模式」folder 的完整片段（<details id="sayhi-test-mode-details"> ... </details>）
// 注意：折叠区内嵌套了 #sayhi-debug-details，所以不能用非贪婪 regex（会停在内层 </details>）。
// 用 <details>/</details> 深度计数找匹配的外层关闭。
function getTestModeFolder() {
  const idIdx = sidepanelHtml.indexOf('id="sayhi-test-mode-details"');
  if (idIdx < 0) throw new Error('未找到 #sayhi-test-mode-details');
  const startIdx = sidepanelHtml.lastIndexOf('<details', idIdx);
  if (startIdx < 0) throw new Error('未找到 <details 起点');
  const re = /<\/?details\b[^>]*>/g;
  re.lastIndex = startIdx;
  let depth = 0, endIdx = -1, m;
  while ((m = re.exec(sidepanelHtml)) !== null) {
    if (m[0].startsWith('</')) depth--;
    else depth++;
    if (depth === 0) { endIdx = m.index + m[0].length; break; }
  }
  if (endIdx < 0) throw new Error('未找到匹配的 </details>');
  return sidepanelHtml.slice(startIdx, endIdx);
}

// 沟通页 pane 完整段
function getSayhiPane() {
  const m = sidepanelHtml.match(/<div class="page-pane" data-page-pane="sayhi"[\s\S]*?<!-- ===== \/沟通页 pane ===== -->/);
  if (!m) throw new Error('未找到沟通页 pane');
  return m[0];
}

// ========== A: 折叠容器存在 + 默认折叠 + summary 文案 ==========

test('A1: 沟通页 pane 含 <details id="sayhi-test-mode-details"> 折叠容器', () => {
  const pane = getSayhiPane();
  assert.match(pane, /<details[^>]*id="sayhi-test-mode-details"/);
});

test('A2: 折叠容器默认折叠（无 open 属性）', () => {
  const folder = getTestModeFolder();
  // <details ... open> 形式表示默认展开；2d 要求默认折叠
  const openTag = folder.match(/<details[^>]*>/)[0];
  assert.doesNotMatch(openTag, /\bopen\b/);
});

test('A3: summary 含 "🧪 测试模式" 文案（HR 一眼识别这是开发期通道）', () => {
  const folder = getTestModeFolder();
  const m = folder.match(/<summary[\s\S]*?<\/summary>/);
  assert.ok(m, '折叠区缺 <summary>');
  assert.match(m[0], /🧪/);
  assert.match(m[0], /测试模式/);
});

test('v1.0.0 A4: summary 简化（v1.0.0 起删括号说明文字，HR 反馈简洁优先）', () => {
  const folder = getTestModeFolder();
  const m = folder.match(/<summary[\s\S]*?<\/summary>/);
  assert.ok(m);
  // 不再有「交付前移除」等开发期文案
  assert.doesNotMatch(m[0], /交付前移除|开发期保留/);
});

// ========== B: 4 个旧按钮全部迁入折叠区 + 仍存在 ==========

test('B1: #btn-sayhi-scan 在折叠区内', () => {
  const folder = getTestModeFolder();
  assert.match(folder, /id="btn-sayhi-scan"/);
});

test('B2: #btn-sayhi-eval 在折叠区内', () => {
  const folder = getTestModeFolder();
  assert.match(folder, /id="btn-sayhi-eval"/);
});

test('B3: #btn-sayhi-stop 在折叠区内（区别于新 #btn-sayhi-stop-batch）', () => {
  const folder = getTestModeFolder();
  // 注意 -batch 后缀的属于新统一按钮，不应在测试模式折叠区
  assert.match(folder, /id="btn-sayhi-stop"[^-]/);
});

test('B4: #btn-sayhi-clear-pool 在折叠区内', () => {
  const folder = getTestModeFolder();
  assert.match(folder, /id="btn-sayhi-clear-pool"/);
});

test('B5: 4 个旧按钮 ID 在整个 sidepanel.html 中仅出现一次（防止被复制 / 漏迁）', () => {
  const ids = ['btn-sayhi-scan', 'btn-sayhi-eval', 'btn-sayhi-clear-pool'];
  ids.forEach(function (id) {
    const re = new RegExp('id="' + id + '"', 'g');
    const matches = sidepanelHtml.match(re) || [];
    assert.equal(matches.length, 1, '#' + id + ' 应在 HTML 中只出现 1 次（防迁移漏拷或重复）');
  });
  // btn-sayhi-stop 单独检查（避免误中 -stop-batch）
  const stopMatches = sidepanelHtml.match(/id="btn-sayhi-stop"/g) || [];
  assert.equal(stopMatches.length, 1);
});

// ========== C: 操作调试日志 #sayhi-debug-details 一并归入测试模式折叠区 ==========

test('C1: #sayhi-debug-details 在测试模式折叠区内', () => {
  const folder = getTestModeFolder();
  assert.match(folder, /id="sayhi-debug-details"/);
});

test('C2: #sayhi-debug-details 在整个 HTML 中只出现 1 次（已搬不复存）', () => {
  const matches = sidepanelHtml.match(/id="sayhi-debug-details"/g) || [];
  assert.equal(matches.length, 1);
});

// ========== D: 新统一按钮 NOT 在测试模式折叠区（必须留在 control-bar） ==========

test('D1: #btn-sayhi-start 不在测试模式折叠区', () => {
  const folder = getTestModeFolder();
  assert.doesNotMatch(folder, /id="btn-sayhi-start"/);
});

test('D2: #btn-sayhi-stop-batch 不在测试模式折叠区', () => {
  const folder = getTestModeFolder();
  assert.doesNotMatch(folder, /id="btn-sayhi-stop-batch"/);
});

test('D3: 自动操作 checkbox 不在测试模式折叠区（属主流程 control-bar）', () => {
  const folder = getTestModeFolder();
  assert.doesNotMatch(folder, /id="sayhi-auto-greet-toggle"/);
  assert.doesNotMatch(folder, /id="sayhi-auto-mark-unsuitable-toggle"/);
});

test('D4: K/N 阈值 input 不在测试模式折叠区（属主流程 control-bar）', () => {
  const folder = getTestModeFolder();
  assert.doesNotMatch(folder, /id="sayhi-loop-goal-k"/);
  assert.doesNotMatch(folder, /id="sayhi-loop-goal-n"/);
});

// ========== E: 折叠区位置（必须在沟通页 pane 内，且在 sayhi-pool-bar 后） ==========

test('E1: 折叠区在沟通页 pane 内', () => {
  const pane = getSayhiPane();
  assert.match(pane, /id="sayhi-test-mode-details"/);
});

test('E2: 折叠区在 sayhi-pool-bar / sayhi-evaluations 之后（让 HR 主流程视觉优先）', () => {
  const pane = getSayhiPane();
  const folderIdx = pane.indexOf('id="sayhi-test-mode-details"');
  const evalsIdx = pane.indexOf('id="sayhi-evaluations"');
  assert.ok(folderIdx > 0 && evalsIdx > 0);
  assert.ok(folderIdx > evalsIdx, '折叠区应在评估列表后（HR 主流程视觉优先）');
});

// ========== F: 按钮 wire 仍在 sidepanel.js（搬 DOM 不动 wire） ==========

test('F1: btn-sayhi-scan click handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-scan['"]\)\.addEventListener\(['"]click['"]/);
});

test('F2: btn-sayhi-eval click handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-eval['"]\)\.addEventListener\(['"]click['"]/);
});

test('F3: btn-sayhi-stop click handler 保留', () => {
  // 区别于 btn-sayhi-stop-batch (2b 新统一按钮)
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-stop['"]\)\.addEventListener\(['"]click['"]/);
});

test('F4: btn-sayhi-clear-pool click handler 保留', () => {
  assert.match(sidepanelJs, /\$\(['"]btn-sayhi-clear-pool['"]\)\.addEventListener\(['"]click['"]/);
});

test('F5: btn-sayhi-debug-clear click handler 保留', () => {
  assert.match(sidepanelJs, /btn-sayhi-debug-clear/);
});

// ========== G: 旧 .sayhi-actions 容器仍存在（搬进折叠区，不删） ==========

test('G1: .sayhi-actions 容器在折叠区内（仍是一组按钮组，不打散）', () => {
  const folder = getTestModeFolder();
  assert.match(folder, /class="sayhi-actions"/);
});

test('G2: .sayhi-actions 在整个 HTML 中只出现 1 次', () => {
  const matches = sidepanelHtml.match(/class="sayhi-actions"/g) || [];
  assert.equal(matches.length, 1);
});
