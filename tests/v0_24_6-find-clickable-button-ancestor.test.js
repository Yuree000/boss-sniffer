// v0.24.6 BUG fix 回归 — _findClickableByText 向上找 button-like 祖先
//
// 起因：HR 反馈批量评估时 pass 候选人徽章是「部分成功 ⚠」(wait-card-gone partial)，
//      BOSS 端实际没标不合适。
// 根因：BOSS 工具栏 DOM <div class="op"><span class="text">不合适</span></div>，
//      文本节点的 parentElement 是 span.text，BOSS 的 click handler 绑在外层 div.op。
//      click span.text 时事件冒泡到 div.op 但某些 Vue/React 实现用 event.target
//      严格匹配或外层 stopPropagation，导致 BOSS 业务未触发。
// Fix：_findClickableByText 找到文本节点后，向上 4 层找最近的 button-like 祖先
//      （button / a / [role=button|link] / class 含 btn|operate|action 等 / cursor:pointer）。
//      找到 → click 祖先；找不到 → 回退到原 parentElement（不破坏现有路径）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

test('A1: _isButtonLike helper 函数定义存在', () => {
  assert.match(inject, /function _isButtonLike\(el\)/);
});

test('A2: _isButtonLike 识别 BUTTON / A 标签', () => {
  const m = inject.match(/function _isButtonLike\(el\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /tag === 'BUTTON'/);
  assert.match(m[0], /tag === 'A'/);
});

test('A3: _isButtonLike 识别 role=button / role=link', () => {
  const m = inject.match(/function _isButtonLike\(el\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /role === 'button'/);
  assert.match(m[0], /role === 'link'/);
});

test('A4: _isButtonLike 识别 className 含 btn / operate / action', () => {
  const m = inject.match(/function _isButtonLike\(el\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // 正则覆盖 BOSS 常见按钮 class
  assert.match(m[0], /btn\|button\|operate\|op-\?btn\|action\|icon-btn\|clickable/);
});

test('A5: _isButtonLike 识别 cursor:pointer 元素（Vue 编译产物兜底）', () => {
  const m = inject.match(/function _isButtonLike\(el\)[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /cursor\s*===\s*'pointer'/);
});

test('B1: _findClickableByText 向上找 button-like 祖先（最多 4 层）', () => {
  const m = inject.match(/function _findClickableByText\(text, root\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // 向上循环找 _isButtonLike
  assert.match(m[0], /for\s*\(let depth = 0; depth < 4 && cursor;/);
  assert.match(m[0], /_isButtonLike\(cursor\)/);
});

test('B2: _findClickableByText 找不到 button-like 时回退到 baseEl（兼容旧行为）', () => {
  const m = inject.match(/function _findClickableByText\(text, root\)[\s\S]*?\n  \}/);
  assert.ok(m);
  // clickTarget 默认 = baseEl，循环命中才更新
  assert.match(m[0], /let clickTarget = baseEl/);
});

test('C1: wait-card-gone 超时 6s → 15s', () => {
  // 注释里明示 v0.24.6 调整
  assert.match(inject, /15s 内卡片未消失/);
  // _waitFor 参数 15000
  const m = inject.match(/等左侧卡片消失[\s\S]{0,500}_waitFor\(function[\s\S]*?\}, 15000\)/);
  assert.ok(m, 'wait-card-gone _waitFor 超时应为 15000ms');
});

test('C2: 老的 6s 超时已删除', () => {
  // 「等左侧卡片消失」段下方不应有 6000 数字
  const m = inject.match(/等左侧卡片消失[\s\S]{0,500}_waitFor/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /\b6000\b/);
});
