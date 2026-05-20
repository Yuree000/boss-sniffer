// 测试 v0.17.1.0 自动操作的开关与互斥保护
// - 单评路径传 executeAction:true，批量路径传 executeAction:false
// - executeSayhiActionForCandidate 在评估循环中被互斥
// - appConfig.autoAction 默认全关
// 跑：node --test tests/auto-action-gate.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

test('appConfig.autoAction 默认 enabledBatchEval:false', () => {
  // 在 appConfig 定义内
  const m = src.match(/let appConfig = \{[\s\S]*?\n\};/);
  assert.ok(m, '应能找到 appConfig 定义');
  const body = m[0];
  assert.match(body, /autoAction:\s*\{/);
  assert.match(body, /enabledBatchEval:\s*false/);
  assert.match(body, /dryRun:\s*false/);
});

test('appConfig.autoAction 默认 actionCooldown 2-4s', () => {
  const m = src.match(/let appConfig = \{[\s\S]*?\n\};/);
  assert.ok(m);
  assert.match(m[0], /actionCooldownMinMs:\s*2000/);
  assert.match(m[0], /actionCooldownMaxMs:\s*4000/);
});

// v0.17.1.3：单评批量自动求简历角色反转
//   批量 evalSayhiBatch → executeAction:true（受 enabledBatchEval 控制）
//   单评 evalSayhiSingle → executeAction:false（永不自动，HR 始终手动点 🎯）
test('evalSayhiBatch 传 executeAction:true（批量受 admin 开关控制）', () => {
  const m = src.match(/async function evalSayhiBatch\(\)[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /evalSayhiCore\(null, \{ executeAction:\s*true \}\)/);
});

test('evalSayhiSingle 传 executeAction:false（单评永不自动求简历）', () => {
  const m = src.match(/async function evalSayhiSingle\(candidateId\)[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /executeAction:\s*false/);
  // 同时保留 force:true（绕过 30min 新鲜度门）
  assert.match(m[0], /force:\s*true/);
});

test('executeSayhiActionForCandidate 被 sayhiEvalRun.running 互斥', () => {
  const m = src.match(/async function executeSayhiActionForCandidate\(candidateId\)[\s\S]*?\n\}\n/);
  assert.ok(m, '应能找到 executeSayhiActionForCandidate 函数');
  assert.match(m[0], /sayhiEvalRun\s*&&\s*sayhiEvalRun\.running/);
  // 中文错误提示
  assert.match(m[0], /评估循环进行中/);
});

test('autoActionOn 双判：executeAction && appConfig.autoAction.enabledBatchEval', () => {
  // 在 evalSayhiCore 函数体内
  const m = src.match(/async function evalSayhiCore\([\s\S]*?(?=async function evalSayhiBatch)/);
  assert.ok(m);
  assert.match(m[0], /executeAction\s*&&[\s\S]*?appConfig\.autoAction[\s\S]*?enabledBatchEval/);
});

test('loadConfig 把 autoAction 加入 migrateFromLocal（v0.22.3 起列表含 sayhiBatch）', () => {
  // 只断言 autoAction 在列表里，不锁定整个数组（防止后续加新 section 时此处假阴性）
  const m = src.match(/migrateFromLocal\(\[([^\]]+)\]\)/);
  assert.ok(m, '未找到 migrateFromLocal 调用');
  assert.match(m[0], /'autoAction'/);
  assert.match(m[0], /'llm'/);
  assert.match(m[0], /'sayHi'/);
  assert.match(m[0], /'sayHiDom'/);
});

test('loadConfig 含 autoAction 的 deepMerge', () => {
  assert.match(src, /if \(res\.autoAction\) deepMerge\(appConfig\.autoAction, res\.autoAction\)/);
});

test('消息 case EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE 存在（admin 试执行入口）', () => {
  assert.match(src, /case 'EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE':/);
});

test('EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE 也受 sayhiEvalRun.running 互斥', () => {
  // 从 case 行到下一个 case 之间
  const m = src.match(/case 'EXECUTE_GREET_THEN_RESUME_FOR_CANDIDATE':[\s\S]*?return true;/);
  assert.ok(m);
  assert.match(m[0], /sayhiEvalRun[\s\S]*?running/);
  assert.match(m[0], /评估循环进行中/);
});
