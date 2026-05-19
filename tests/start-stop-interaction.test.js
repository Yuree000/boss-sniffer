const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// v0.15.0：screeningEnabled 退化为内部派生状态，跟 LOOP 生命周期绑死
test('screeningEnabled is bound to LOOP lifecycle (no manual user toggle)', () => {
  const background = read('background.js');

  assert.match(
    background,
    /let screeningEnabled = false;/,
    'screeningEnabled remains as internal state, default false'
  );

  // START_LOOP 无条件开（无 if-guard、无 ownership flag）
  assert.match(
    background,
    /case 'START_LOOP':[\s\S]*?screeningEnabled = true;[\s\S]*?self\.BossScheduler\.start/,
    'START_LOOP unconditionally enables screening'
  );

  // STOP_LOOP 无条件关
  assert.match(
    background,
    /case 'STOP_LOOP':[\s\S]*?self\.BossScheduler\.stop\(\);[\s\S]*?screeningEnabled = false;[\s\S]*?reconcileSayHiConsumer\(\);[\s\S]*?sendResponse\({ ok: true }\);/,
    'STOP_LOOP unconditionally disables screening (no ownership helper)'
  );

  // 自然终止无条件关
  assert.match(
    background,
    /setOnStopped\(function \(reason\) {[\s\S]*?screeningEnabled = false;[\s\S]*?reconcileSayHiConsumer\(\);/,
    'natural completion (setOnStopped) unconditionally disables screening'
  );
});

// v0.15.0 (bug fix): in-flight LLM evaluations dropped after STOP_LOOP
test('evaluateIfCandidate worker checks screeningEnabled before upserting late LLM results', () => {
  const background = read('background.js');

  // worker 内 LLM 调用完之后、upsertEvaluation 之前必须有 screeningEnabled 检查
  assert.match(
    background,
    /await self\.BossJudge\.judgeCandidate[\s\S]*?if \(!screeningEnabled\)[\s\S]*?return;[\s\S]*?await upsertEvaluation/,
    'evaluation worker must check screeningEnabled between LLM return and upsertEvaluation'
  );
});

// v0.15.0 (bug fix): STOP_LOOP 立即清掉 pending 卡片
// v0.20.9 扩展：同时清 queued（待评估），HR 停止本轮时排队的也应该停
test('STOP_LOOP clears pending and queued evaluations', () => {
  const background = read('background.js');

  assert.match(
    background,
    /async function clearPendingEvaluations\(\)[\s\S]*?st === 'pending' \|\| st === 'queued'[\s\S]*?cursor\.delete/,
    'clearPendingEvaluations helper must delete both pending and queued entries (v0.20.9)'
  );
  assert.match(
    background,
    /case 'STOP_LOOP':[\s\S]*?clearPendingEvaluations\(\)/,
    'STOP_LOOP must call clearPendingEvaluations'
  );
});

// v0.16.0：currentTab 与 LOOP 生命周期绑死
test('currentTab is bound to LOOP lifecycle', () => {
  const background = read('background.js');

  assert.match(background, /let currentTab = null;/, 'currentTab declared null by default');
  assert.match(
    background,
    /case 'START_LOOP':[\s\S]*?const tab = msg\.tab === 'latest' \? 'latest' : 'recommend';[\s\S]*?currentTab = tab;/,
    'START_LOOP must parse msg.tab and set currentTab'
  );
  assert.match(
    background,
    /case 'STOP_LOOP':[\s\S]*?screeningEnabled = false;[\s\S]*?currentTab = null;/,
    'STOP_LOOP must clear currentTab'
  );
  assert.match(
    background,
    /setOnStopped\(function \(reason\) {[\s\S]*?screeningEnabled = false;[\s\S]*?currentTab = null;/,
    'natural termination must clear currentTab'
  );
});

// v0.16.0：CAPTURE 闸按 currentTab 过滤 list 接口
test('CAPTURE filters list endpoints by currentTab', () => {
  const background = read('background.js');

  assert.match(
    background,
    /case 'CAPTURE':[\s\S]*?if \(msg\.payload\.via !== 'ws' && currentTab\)[\s\S]*?\/rec\/geek\/list[\s\S]*?currentTab !== 'recommend'[\s\S]*?return false;/,
    'CAPTURE must drop /rec/geek/list when currentTab is not recommend'
  );
  assert.match(
    background,
    /case 'CAPTURE':[\s\S]*?\/zprelation\/interaction\/bossGetGeek[\s\S]*?currentTab !== 'latest'[\s\S]*?return false;/,
    'CAPTURE must drop /bossGetGeek when currentTab is not latest'
  );
});

// v0.16.0：START_LOOP 跑最新时调 clickLatestTab
test('START_LOOP calls clickLatestTab when tab=latest', () => {
  const background = read('background.js');

  assert.match(
    background,
    /async function clickLatestTab\(tabId\)[\s\S]*?chrome\.tabs\.sendMessage\([\s\S]*?CLICK_LATEST_TAB/,
    'clickLatestTab helper must exist and send CLICK_LATEST_TAB to BOSS tab'
  );
  assert.match(
    background,
    /case 'START_LOOP':[\s\S]*?if \(currentTab === 'latest'\)[\s\S]*?await clickLatestTab/,
    'START_LOOP must await clickLatestTab when tab=latest'
  );
});

// v0.16.0：sidepanel 加 tab 下拉
test('sidepanel has loop-target-tab dropdown', () => {
  const sidepanel = read('sidepanel/sidepanel.html');
  const sidepanelJs = read('sidepanel/sidepanel.js');

  assert.match(sidepanel, /<select id="loop-target-tab">/, 'tab select must exist');
  assert.match(sidepanel, /<option value="latest">最新<\/option>/, 'latest option must exist');
  assert.match(sidepanel, /<option value="recommend">/, 'recommend option must exist');
  assert.match(
    sidepanelJs,
    /loop-target-tab[\s\S]*?value === 'latest' \? 'latest' : 'recommend'/,
    'sidepanel.js must read tab selection'
  );
  assert.match(
    sidepanelJs,
    /type: 'START_LOOP'[\s\S]*?tab:/,
    'START_LOOP message must include tab field'
  );
});

// v0.16.0：content.js 有 CLICK_LATEST_TAB 路由 + iframe URL 自检
test('content.js routes CLICK_LATEST_TAB only in recommend iframe', () => {
  const content = read('content.js');

  assert.match(
    content,
    /msg\.type === 'CLICK_LATEST_TAB'[\s\S]*?location\.pathname\.indexOf\('\/web\/frame\/recommend'\) === -1[\s\S]*?sendResponse\({ ok: false/,
    'CLICK_LATEST_TAB handler must check iframe URL'
  );
  assert.match(
    content,
    /window\.postMessage\([\s\S]*?kind: 'click-latest-tab-request'/,
    'CLICK_LATEST_TAB must postMessage to inject'
  );
});

// v0.16.0：inject.js 找最新 tab DOM + click
test('inject.js _clickLatestTab uses title selector + text fallback', () => {
  const inject = read('inject.js');

  assert.match(
    inject,
    /async function _clickLatestTab\(\)[\s\S]*?ul\.tab-list li\[title="新牛人"\]/,
    '_clickLatestTab must use ul.tab-list li[title="新牛人"] as primary selector'
  );
  assert.match(
    inject,
    /async function _clickLatestTab\(\)[\s\S]*?nodeValue\.trim\(\) === '最新'/,
    '_clickLatestTab must have text fallback'
  );
  assert.match(
    inject,
    /async function _clickLatestTab\(\)[\s\S]*?tab\.click\(\)/,
    '_clickLatestTab must call .click() on the tab'
  );
  assert.match(
    inject,
    /msg\.kind === 'click-latest-tab-request'[\s\S]*?_clickLatestTab\(\)/,
    'inject must wire click-latest-tab-request kind to _clickLatestTab'
  );
});

// v0.15.0：旧的 ownership 机制完整移除
test('ownership flag and manual screening routes are fully removed', () => {
  const background = read('background.js');

  assert.doesNotMatch(
    background,
    /screeningOpenedByAutomation/,
    'screeningOpenedByAutomation should be fully removed'
  );
  assert.doesNotMatch(
    background,
    /autoCloseScreeningIfAutomationOpened/,
    'the ownership-aware helper should be removed'
  );
  assert.doesNotMatch(
    background,
    /case 'SET_SCREENING_ENABLED':/,
    'SET_SCREENING_ENABLED route should be removed'
  );
  assert.doesNotMatch(
    background,
    /case 'TOGGLE':/,
    'legacy TOGGLE route should be removed'
  );
});

// v0.15.0 修订：START_LOOP 要求招呼数 / 浏览数 至少一个 ≥ 1
test('START_LOOP rejects when both goalN and goalK are missing', () => {
  const background = read('background.js');

  assert.match(
    background,
    /case 'START_LOOP':[\s\S]*?const hasN = typeof msg\.goalN === 'number' && msg\.goalN >= 1;[\s\S]*?const hasK = typeof msg\.goalK === 'number' && msg\.goalK >= 1;[\s\S]*?if \(!hasN && !hasK\)[\s\S]*?sendResponse\({ ok: false, error: '招呼数或浏览数至少填写一个' \}\);[\s\S]*?return;/,
    'START_LOOP must require at least one of goalN/goalK'
  );
});

// sayHi 消费仍跟自动化 + 配置 双 AND 绑定（不变）
test('sayHi consumer still gates on isAutomationActive AND sayHi.enabled', () => {
  const background = read('background.js');

  assert.match(
    background,
    /function isAutomationActive\(\)[\s\S]*?RUNNING[\s\S]*?RESTING/,
    'automation active should still derive from scheduler status'
  );
  assert.match(
    background,
    /function reconcileSayHiConsumer\(\)\s*{[\s\S]*?const on = isAutomationActive\(\) && appConfig\.sayHi && appConfig\.sayHi\.enabled;/,
    'sayHi consumer should only run during an active recommendation run'
  );
  assert.match(
    background,
    /async function maybeEnqueueSayHi\(candidate, evaluation\)\s*{[\s\S]*?if \(!isAutomationActive\(\)\) return;/,
    'matching candidates should not enqueue sayHi outside an active run'
  );
});

// 招呼配额 cap 保留（v0.12.6 行为，不动）
test('automatic sayHi enqueue is capped by the recommendation run N goal', () => {
  const background = read('background.js');

  assert.match(
    background,
    /async function getRemainingSayHiSlots\(\)[\s\S]*goalN[\s\S]*queueLength[\s\S]*return Math\.max\(0, state\.goalN - sent - queued\);/,
    'remaining sayHi slots should subtract already sent and queued candidates from goalN'
  );
  assert.match(
    background,
    /async function maybeEnqueueSayHi\(candidate, evaluation\)[\s\S]*const remainingSlots = await getRemainingSayHiSlots\(\);[\s\S]*if \(remainingSlots <= 0\)[\s\S]*?return;[\s\S]*await self\.BossSayHi\.enqueue/,
    'matching candidates should not be queued once the N goal budget is exhausted'
  );
});

// over_quota marker 保留（v0.12.6 行为，不动）
test('符合 candidates blocked by N budget get an over_quota marker', () => {
  const background = read('background.js');
  assert.match(
    background,
    /if \(remainingSlots <= 0\)[\s\S]*?BOSS_EVAL_GREETING_PATCHER[\s\S]*?status: 'over_quota'[\s\S]*?return;/,
    'when N is exhausted, 符合 candidates should still be marked over_quota'
  );
  const sidepanelJs = read('sidepanel/sidepanel.js');
  assert.match(
    sidepanelJs,
    /greeting\.status === 'over_quota'[\s\S]*?已超 N/,
    'sidepanel renderEvaluation should render the over_quota status with a 已超 N badge'
  );
  const sidepanelHtml = read('sidepanel/sidepanel.html');
  assert.match(
    sidepanelHtml,
    /\.greet-inline\.over_quota/,
    'sidepanel.html should style the over_quota badge'
  );
});

// v0.15.0：侧栏删「开启筛选」按钮 + 「候选人筛选」标签
test('sidepanel removes the standalone 开启筛选 toggle', () => {
  const sidepanel = read('sidepanel/sidepanel.html');
  const sidepanelJs = read('sidepanel/sidepanel.js');

  assert.doesNotMatch(sidepanel, /候选人筛选/, '候选人筛选 label removed');
  assert.doesNotMatch(sidepanel, /btn-screening-toggle/, 'btn-screening-toggle button removed');
  assert.doesNotMatch(sidepanelJs, /SET_SCREENING_ENABLED/, 'sidepanel.js no longer sends SET_SCREENING_ENABLED');
  assert.doesNotMatch(sidepanelJs, /type: 'TOGGLE'/, 'sidepanel.js no longer sends TOGGLE');

  // 自动招呼区块还在
  assert.match(sidepanel, />▶ 开始本轮</);
  assert.match(sidepanel, />■ 停止本轮</);
});
