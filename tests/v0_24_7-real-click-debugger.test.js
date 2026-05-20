// v0.24.7 chrome.debugger 真用户点击 mark-unsuitable
//
// 起因：HR 反馈 v0.24.6 仍 partial=true（btn.click() 合成事件 isTrusted=false
//      被 BOSS 拒绝业务）。HR 确认真用户 click 直接生效，无需二级菜单。
// 方案：取按钮中心坐标 → inject postMessage → content sendMessage → BG
//      chrome.debugger.attach + Input.dispatchMouseEvent + detach → 返回
// 代价：「正在调试此浏览器」黄条（已知 trade-off）。
//
// 测试范围：静态断言代码存在 + RPC 链路三端都改对（无法跑真 chrome.debugger）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const inject = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

// =========================================================================
// A. background.js — realClickAtCoords + REAL_CLICK_AT_COORDS handler
// =========================================================================

test('A1: background.js 含 realClickAtCoords 函数', () => {
  assert.match(bg, /async function realClickAtCoords\(tabId, x, y\)/);
});

test('A2: realClickAtCoords 用 chrome.debugger.attach + sendCommand', () => {
  const m = bg.match(/async function realClickAtCoords[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /chrome\.debugger\.attach/);
  assert.match(m[0], /chrome\.debugger\.sendCommand/);
});

test('A3: realClickAtCoords 触发 3 步真用户点击：mouseMoved + mousePressed + mouseReleased', () => {
  const m = bg.match(/async function realClickAtCoords[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /Input\.dispatchMouseEvent/);
  // v0.24.8 fix：补 mouseMoved 前置（与 lib/sayHi.js 对齐，确保 BOSS click handler 接住）
  assert.match(m[0], /mouseMoved/);
  assert.match(m[0], /mousePressed/);
  assert.match(m[0], /mouseReleased/);
  // mouseMoved button: 'none'（无按键按下时移动）
  assert.match(m[0], /type:\s*['"]mouseMoved['"][\s\S]{0,100}button:\s*['"]none['"]/);
});

test('A4: realClickAtCoords 用 left button + clickCount:1（标准单击）', () => {
  const m = bg.match(/async function realClickAtCoords[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /button:\s*['"]left['"]/);
  assert.match(m[0], /clickCount:\s*1/);
});

test('A5: realClickAtCoords 自愈 attach — "already attached" 时先 detach 再重 attach（v0.24.9）', () => {
  const m = bg.match(/async function realClickAtCoords[\s\S]*?\n\}/);
  assert.ok(m);
  // 自愈正则覆盖 "already attached" 和 "Another debugger" 两种错误措辞
  assert.match(m[0], /already attached\|Another debugger/i);
});

test('A6: realClickAtCoords finally detach 始终清理（v0.24.9：去掉 alreadyAttached 错误分支）', () => {
  const m = bg.match(/async function realClickAtCoords[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /finally/);
  assert.match(m[0], /chrome\.debugger\.detach/);
  // v0.24.9：自愈策略下永远是自己 attach 的，不再判 alreadyAttached 跳过 detach
  assert.doesNotMatch(m[0], /alreadyAttached\s*=\s*!!/);
});

test('A7: REAL_CLICK_AT_COORDS message handler 存在', () => {
  assert.match(bg, /case\s*['"]REAL_CLICK_AT_COORDS['"]/);
});

test('A8: REAL_CLICK_AT_COORDS handler 从 sender.tab 拿 tabId（确保只点当前 BOSS tab）', () => {
  const m = bg.match(/case\s*['"]REAL_CLICK_AT_COORDS['"]:[\s\S]*?return\s+true;/);
  assert.ok(m);
  assert.match(m[0], /sender\.tab\.id/);
});

test('A9: REAL_CLICK_AT_COORDS handler 校验坐标合法性（防注入异常值）', () => {
  const m = bg.match(/case\s*['"]REAL_CLICK_AT_COORDS['"]:[\s\S]*?return\s+true;/);
  assert.ok(m);
  // 用 Number.isFinite + x >= 0 / y >= 0 校验
  assert.match(m[0], /Number\.isFinite/);
});

test('A10: REAL_CLICK_AT_COORDS handler 写 BossDiag log（observability）', () => {
  const m = bg.match(/case\s*['"]REAL_CLICK_AT_COORDS['"]:[\s\S]*?return\s+true;/);
  assert.ok(m);
  assert.match(m[0], /sayhi\.real_click_/);
});

// =========================================================================
// B. content.js — 'real-click-request' postMessage 转发到 BG
// =========================================================================

test('B1: content.js 监听 inject 的 "real-click-request" postMessage', () => {
  assert.match(content, /msg\.kind === ['"]real-click-request['"]/);
});

test('B2: content.js 收到 real-click-request 调 chrome.runtime.sendMessage type=REAL_CLICK_AT_COORDS', () => {
  const m = content.match(/msg\.kind === ['"]real-click-request['"][\s\S]*?\}\);/);
  assert.ok(m);
  assert.match(m[0], /chrome\.runtime\.sendMessage/);
  assert.match(m[0], /type:\s*['"]REAL_CLICK_AT_COORDS['"]/);
});

test('B3: content.js BG response 后 postMessage "real-click-result" 给 inject', () => {
  const m = content.match(/msg\.kind === ['"]real-click-request['"][\s\S]*?\}\);/);
  assert.ok(m);
  assert.match(m[0], /kind:\s*['"]real-click-result['"]/);
  assert.match(m[0], /requestId:/);
});

// =========================================================================
// C. inject.js — mark 分支用 _requestRealClick 替代 btn.click()
// =========================================================================

test('C1: inject.js 含 _requestRealClick helper（postMessage 异步等 BG 真点击完成）', () => {
  assert.match(inject, /function _requestRealClick\(x, y\)/);
});

test('C2: _requestRealClick postMessage kind=real-click-request 含 x/y/requestId', () => {
  const m = inject.match(/function _requestRealClick[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /kind:\s*['"]real-click-request['"]/);
  assert.match(m[0], /x:\s*x/);
  assert.match(m[0], /y:\s*y/);
  assert.match(m[0], /requestId:\s*reqId/);
});

test('C3: _requestRealClick 监听 real-click-result + 校验 requestId 匹配', () => {
  const m = inject.match(/function _requestRealClick[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /m\.kind !== ['"]real-click-result['"]/);
  assert.match(m[0], /m\.requestId !== reqId/);
});

test('C4: _requestRealClick 12s 超时兜底（防 BG 卡死无响应）', () => {
  const m = inject.match(/function _requestRealClick[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m[0], /12000\)/);
  assert.match(m[0], /real-click-timeout/);
});

test('C5: executeSayhiAction mark 分支不再直接 btn.click()，改用 _requestRealClick', () => {
  // 提取 mark-unsuitable 段（findUnsuitableBtn 到 waitCardGone）
  const m = inject.match(/findUnsuitableBtn[\s\S]{0,3000}_findSayhiCardByUid/);
  assert.ok(m, 'mark-unsuitable 段未找到');
  // 不再调 btn.click()
  assert.doesNotMatch(m[0], /\bbtn\.click\(\)/);
  // 改用 _requestRealClick(cx, cy)
  assert.match(m[0], /_requestRealClick\(cx, cy\)/);
});

test('C6: mark 分支 click 前 scrollIntoView 确保坐标在视口内', () => {
  const m = inject.match(/findUnsuitableBtn[\s\S]{0,3000}_findSayhiCardByUid/);
  assert.ok(m);
  assert.match(m[0], /scrollIntoView/);
});

test('C7: mark 分支取按钮中心坐标（getBoundingClientRect → cx/cy）', () => {
  const m = inject.match(/findUnsuitableBtn[\s\S]{0,3000}_findSayhiCardByUid/);
  assert.ok(m);
  assert.match(m[0], /getBoundingClientRect/);
  assert.match(m[0], /const cx = Math\.round/);
  assert.match(m[0], /const cy = Math\.round/);
});

test('C8: mark 分支真点击失败时 failedStep=click-unsuitable-btn', () => {
  const m = inject.match(/findUnsuitableBtn[\s\S]{0,3000}_findSayhiCardByUid/);
  assert.ok(m);
  // 真点击失败分支设置 failedStep
  assert.match(m[0], /chrome\.debugger 真点击失败[\s\S]{0,200}failedStep = 'click-unsuitable-btn'/);
});

// =========================================================================
// D. 兼容性：autoGreet 路径（求简历）不动 — btn.click() 仍在 executeGreetThenRequestResume
// =========================================================================

test('D1: executeGreetThenRequestResume 仍保留 btn.click 路径（autoGreet 现状 work，不动）', () => {
  // 求简历两步点击仍用 .click()
  const m = inject.match(/async function executeGreetThenRequestResume[\s\S]*?\n  \}/);
  assert.ok(m);
  // 仍有 .click() 调用（提交按钮 / 求简历按钮 / 确定按钮）
  assert.match(m[0], /\.click\(\)/);
});

test('D2: manifest debugger permission 已声明（chrome.debugger 必需）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.indexOf('debugger') !== -1, 'manifest permissions 应含 "debugger"');
});
