// v0.20.x 看板 v2 UI 累积测试 — 含 v0.20.0 / v0.20.1 / v0.20.2 / v0.20.3 改动
// 跑：node --test tests/v0_20_0-dashboard-v2-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const dashboardJs = read('dashboard/dashboard.js');
const dashboardHtml = read('dashboard/dashboard.html');
const dashboardCss = read('dashboard/dashboard.css');
const adminJs = read('admin/admin.js');
const adminCss = read('admin/admin.css');

// ============ A: dashboard.html v0.20.3 结构 ============

test('dashboard.html v0.20.3 含 4 个 view-card（funnel / jd / trend / drawer），无 today-card', () => {
  assert.match(dashboardHtml, /id="view-funnel-card"/);
  assert.match(dashboardHtml, /id="view-jd-card"/);
  assert.match(dashboardHtml, /id="view-trend-card"/);
  assert.match(dashboardHtml, /id="view-drawer-card"/);
  // v0.20.3 删除
  assert.doesNotMatch(dashboardHtml, /id="view-today-card"/);
});

test('dashboard.html v0.20.3 顶部恢复 [日][周][月] 三态时间窗按钮', () => {
  assert.match(dashboardHtml, /data-time="day"[^>]*>日/);
  assert.match(dashboardHtml, /data-time="week"[^>]*>周/);
  assert.match(dashboardHtml, /data-time="month"[^>]*>月/);
  // 默认日 active
  assert.match(dashboardHtml, /class="time-btn active" data-time="day"/);
});

test('dashboard.html v0.20.3 漏斗卡内嵌 [推荐页][沟通页] tab', () => {
  assert.match(dashboardHtml, /class="funnel-tab active" data-scenario="recommend"/);
  assert.match(dashboardHtml, /class="funnel-tab" data-scenario="chat"/);
  assert.match(dashboardHtml, /id="funnel-tabs"/);
});

test('dashboard.html v0.20.3 候选人记录卡默认展示（无 hidden 属性，无 close 按钮）', () => {
  // <section class="board-card drawer-card" id="view-drawer-card">  — 不带 hidden
  assert.match(dashboardHtml, /id="view-drawer-card"[^>]*>/);
  const drawerSection = dashboardHtml.match(/<section class="board-card drawer-card"[\s\S]*?<\/section>/);
  assert.ok(drawerSection);
  assert.doesNotMatch(drawerSection[0], /\shidden\b/);
  assert.doesNotMatch(drawerSection[0], /id="drawer-close"/);
});

test('dashboard.html 调试信息折叠到 .diag-drawer（默认收起，开发用）', () => {
  assert.match(dashboardHtml, /<details class="diag-drawer"/);
  assert.match(dashboardHtml, /开发用/);
});

// ============ B: dashboard.js v0.20.3 状态机 + render 函数 ============

test('dashboard.js v0.20.3 含 4 个 render 函数（Funnel / JD / Trend / Drawer），无 Today', () => {
  assert.match(dashboardJs, /function renderViewFunnel\(\)/);
  assert.match(dashboardJs, /function renderViewJD\(\)/);
  assert.match(dashboardJs, /function renderViewTrend\(\)/);
  assert.match(dashboardJs, /function renderViewDrawer\(\)/);
  // v0.20.3 删除
  assert.doesNotMatch(dashboardJs, /function renderViewToday/);
  assert.doesNotMatch(dashboardJs, /function renderDelta/);
});

test('dashboard.js v0.20.3 含 currentTimeMode + currentFunnelTab 状态', () => {
  assert.match(dashboardJs, /let currentTimeMode = 'day'/);
  assert.match(dashboardJs, /let currentFunnelTab = 'recommend'/);
});

test('dashboard.js v0.20.3 时间窗 dispatcher：currentBounds() + weekBounds() + monthBounds()', () => {
  assert.match(dashboardJs, /function currentBounds\(\)/);
  assert.match(dashboardJs, /function weekBounds\(\)/);
  assert.match(dashboardJs, /function monthBounds\(\)/);
  assert.match(dashboardJs, /function todayBounds\(\)/);
  // currentBounds 按 mode 切
  assert.match(dashboardJs, /currentTimeMode === 'week'/);
  assert.match(dashboardJs, /currentTimeMode === 'month'/);
});

test('dashboard.js v0.20.3 漏斗 tab 切换：推荐页实数据 + 沟通页占位', () => {
  assert.match(dashboardJs, /function isChatScenario\(\)/);
  assert.match(dashboardJs, /沟通页统计待主链路完工/);
});

// v0.20.5：候选人记录顶部加显示全部 / 仅符合 筛选 tab
test('v0.20.5: dashboard.html 候选人记录卡含 drawer-filter-tabs（显示全部 / 仅符合）', () => {
  assert.match(dashboardHtml, /id="drawer-filter-tabs"/);
  assert.match(dashboardHtml, /data-filter="all"[^>]*>显示全部/);
  assert.match(dashboardHtml, /data-filter="match"[^>]*>仅符合/);
  // 默认 active = all
  assert.match(dashboardHtml, /class="drawer-filter-tab active" data-filter="all"/);
});

test('v0.20.5: dashboard.js bindControls 监听 drawer-filter-tab 切换 currentDrawerFilter', () => {
  assert.match(dashboardJs, /\.drawer-filter-tab/);
  // match 分支：currentDrawerFilter = { decision: '符合' }
  assert.match(dashboardJs, /filter === 'match'[\s\S]*?currentDrawerFilter = \{ decision: '符合' \}/);
});

test('v0.20.5: dashboard.js renderViewDrawer 同步 filter-tab active 状态', () => {
  // 根据 currentDrawerFilter.decision==='符合' 设 match active，否则 all
  assert.match(dashboardJs, /activeFilter = \(currentDrawerFilter && currentDrawerFilter\.decision === '符合'\) \? 'match' : 'all'/);
});

test('v0.20.5: dashboard.css 含 .drawer-filter-tabs / .drawer-filter-tab.active', () => {
  assert.match(dashboardCss, /\.drawer-filter-tabs\s*\{/);
  assert.match(dashboardCss, /\.drawer-filter-tab\.active\s*\{/);
});

test('v0.20.5: meta 上「点这里取消筛选」只在 action filter 时显示（decision filter 用 tab 切）', () => {
  assert.match(dashboardJs, /const isActionFilter = currentDrawerFilter && currentDrawerFilter\.action/);
});

// v0.20.4：tab 切换驱动 4.C/D/E 整盘联动
test('v0.20.4: currentScenario() 抽象 + 4.C/D/E 用 currentScenario 而非硬编码 SCENARIO_PRIMARY', () => {
  assert.match(dashboardJs, /function currentScenario\(\) \{ return currentFunnelTab; \}/);
  // 4.C/D/E 至少 3 处用 currentScenario()
  const matches = dashboardJs.match(/currentScenario\(\)/g) || [];
  assert.ok(matches.length >= 4, '至少 4 处用 currentScenario()（funnel/JD/trend/drawer）');
});

test('v0.23.0 · 3d：4.C/D/E 沟通页 scenario 占位已移除（events 真数据流入后自动渲染）', () => {
  // v0.20.4 此断言锁住"沟通页 tab 显示占位"
  // v0.23.0 · 3d 起：移除 isChatScenario() 占位早 return，让 filterEvents(scenario='chat') 自动 pick up
  // CHAT_PLACEHOLDER_HTML 常量保留（将来可能他用），但 3 个 render 不再走 placeholder 早 return
  assert.match(dashboardJs, /const CHAT_PLACEHOLDER_HTML/);
  // 关键反转：jd/trend/drawer 三个 render 现在 sayhi tab 时不再 placeholder 占位
  const jdMatch = dashboardJs.match(/function renderViewJD\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  const trendMatch = dashboardJs.match(/function renderViewTrend\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  const drawerMatch = dashboardJs.match(/function renderViewDrawer\s*\(\s*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(jdMatch && trendMatch && drawerMatch);
  // 三个函数都不再有 "if (isChatScenario()) { ... CHAT_PLACEHOLDER_HTML ... return }" 早出口
  [jdMatch, trendMatch, drawerMatch].forEach(function (m) {
    assert.doesNotMatch(m[0], /if\s*\(\s*isChatScenario\(\)\s*\)\s*\{[\s\S]{0,200}CHAT_PLACEHOLDER_HTML[\s\S]{0,200}return/);
  });
});

test('v0.20.4: funnel-tab 切换触发 renderAll（不只 renderViewFunnel）', () => {
  // 在 funnel-tab handler 内调用 renderAll
  const m = dashboardJs.match(/document\.querySelectorAll\('\.funnel-tab'\)[\s\S]*?renderAll\(\)/);
  assert.ok(m, 'funnel-tab handler 应调 renderAll 不只 renderViewFunnel');
});

test('v0.20.4: 4.D 趋势三指标对齐 4.B 漏斗：判断候选人数 / 符合数 / 自动招呼发出数（删 LLM 时长）', () => {
  const m = dashboardJs.match(/function renderViewTrend[\s\S]*?\$\('view-trend-content'\)\.innerHTML = html;\s*\}/);
  assert.ok(m);
  const body = m[0];
  // 三指标新名
  assert.match(body, /trendRow\('判断候选人数'/);
  assert.match(body, /trendRow\('符合数'/);
  assert.match(body, /trendRow\('自动招呼发出数'/);
  // 三指标顺序：池 → 符合 → 招呼
  const iPool = body.indexOf("'判断候选人数'");
  const iMatch = body.indexOf("'符合数'");
  const iSayhi = body.indexOf("'自动招呼发出数'");
  assert.ok(iPool < iMatch && iMatch < iSayhi);
  // 不再渲染 LLM 判定时间
  assert.doesNotMatch(body, /LLM 判定时间/);
  assert.doesNotMatch(body, /formatLatency/);
});

test('dashboard.js v0.20.3 漏斗删触达率（符合 → 自动招呼 之间不再有 rate）', () => {
  // 不再渲染「↓ 触达率」UI 字符串（注释里可能还提到，但不渲染到 HTML）
  assert.doesNotMatch(dashboardJs, /funnelRate.*'↓ 触达率/);
  // 漏斗标签：符合数 + 自动招呼发出
  assert.match(dashboardJs, /'符合数'/);
  assert.match(dashboardJs, /'自动招呼发出'/);
});

test('dashboard.js v0.20.3 renderViewJD 用 currentBounds() 切片（不再固定今日）', () => {
  const m = dashboardJs.match(/function renderViewJD[\s\S]*?\$\('view-jd-content'\)\.innerHTML = html;\s*\}/);
  assert.ok(m);
  assert.match(m[0], /currentBounds\(\)/);
  assert.doesNotMatch(m[0], /todayBounds\(\)/);
});

test('dashboard.js v0.20.3 renderViewTrend 粒度跟时间窗：日 → 7 / 周 → 8 / 月 → 6', () => {
  const m = dashboardJs.match(/function renderViewTrend[\s\S]*?\$\('view-trend-content'\)\.innerHTML = html;\s*\}/);
  assert.ok(m);
  // 三种粒度的桶数
  assert.match(m[0], /bucketCount = 7/);
  assert.match(m[0], /bucketCount = 8/);
  assert.match(m[0], /bucketCount = 6/);
  // 含 buildTrendBuckets helper
  assert.match(dashboardJs, /function buildTrendBuckets\(count, bucketMs\)/);
});

test('dashboard.js v0.20.3 renderViewDrawer 默认展示 + 待续提示（超出 DRAWER_TOP_N）', () => {
  assert.match(dashboardJs, /const DRAWER_TOP_N = 28/);
  assert.match(dashboardJs, /function renderViewDrawer\(\)/);
  // 待续提示文案
  assert.match(dashboardJs, /drawer-overflow-hint/);
  assert.match(dashboardJs, /下方还有 <span class="overflow-count">/);
  // 超出 DRAWER_TOP_N 时显示 overflow-hint
  assert.match(dashboardJs, /const overflow = total - shown\.length/);
});

test('dashboard.js v0.20.3 applyDrawerFilter / clearDrawerFilter（点 4.B 数字触发临时筛选）', () => {
  assert.match(dashboardJs, /function applyDrawerFilter\(filter\)/);
  assert.match(dashboardJs, /function clearDrawerFilter\(\)/);
  assert.match(dashboardJs, /let currentDrawerFilter = null/);
});

test('dashboard.js v0.20.3 bindControls 监听 time-btn + funnel-tab', () => {
  const m = dashboardJs.match(/function bindControls[\s\S]*?\$\('btn-refresh'\)\.addEventListener[^;]*;\s*\}/);
  assert.ok(m);
  assert.match(m[0], /\.time-btn/);
  assert.match(m[0], /\.funnel-tab/);
});

test('dashboard.js v0.20.3 切时间窗 / 切 JD 时清掉 drawer filter', () => {
  // time-btn click handler 内有 currentDrawerFilter = null
  // jd-filter change handler 内同样
  const m = dashboardJs.match(/function bindControls[\s\S]*?\$\('btn-refresh'\)\.addEventListener[^;]*;\s*\}/);
  assert.ok(m);
  // 两处都清 filter
  const countNull = (m[0].match(/currentDrawerFilter = null/g) || []).length;
  assert.ok(countNull >= 2, 'time-btn 和 jd-filter handler 都应清 drawer filter');
});

// ============ C: dashboard.js v0.20.x 累积断言（M_i pass 主因 / scenario 限定） ============

test('dashboard.js 限定 SCENARIO_PRIMARY = recommend', () => {
  assert.match(dashboardJs, /const SCENARIO_PRIMARY = 'recommend'/);
});

test('dashboard.js filterEvaluations / filterEvents 支持 scenario 过滤', () => {
  assert.match(dashboardJs, /function recordScenario\(r\)/);
  assert.match(dashboardJs, /opts\.scenario && recordScenario/);
});

test('v0.20.1: dashboard.js renderViewJD 含 M_i pass 主因分析 + 信息缺占比', () => {
  const m = dashboardJs.match(/function renderViewJD[\s\S]*?\$\('view-jd-content'\)\.innerHTML = html;\s*\}/);
  assert.ok(m);
  const body = m[0];
  assert.match(body, /必要条件 M_i ── pass 主因占比 \/ 信息缺占比/);
  assert.match(body, /stage: 'pass_marked'/);
  assert.match(body, /e\.payload && e\.payload\.passReason/);
  assert.match(body, /c\.text \+ '\(信息缺\)'/);
});

test('v0.20.1: dashboard.js M_i 段在 O_i 段上方（HR 决策优先看 pass 主因）', () => {
  const m = dashboardJs.match(/function renderViewJD[\s\S]*?\$\('view-jd-content'\)\.innerHTML = html;\s*\}/);
  assert.ok(m);
  const body = m[0];
  const iMust = body.indexOf('必要条件 M_i');
  const iOpt = body.indexOf('可选条件 O_i');
  assert.ok(iMust !== -1 && iOpt !== -1);
  assert.ok(iMust < iOpt);
});

test('v0.20.2: dashboard.js 删 health verdict 系列函数 + .health-verdict 渲染', () => {
  assert.doesNotMatch(dashboardJs, /function mustVerdict/);
  assert.doesNotMatch(dashboardJs, /function optionalVerdict/);
  assert.doesNotMatch(dashboardJs, /function healthVerdict/);
  assert.doesNotMatch(dashboardJs, /<span class="verdict-text">/);
});

test('dashboard.js 改用 .jd-action-row 包「去 admin 改」按钮', () => {
  assert.match(dashboardJs, /<div class="jd-action-row">/);
});

test('dashboard.js 含 renderSparkSvg 输出 SVG 折线图', () => {
  assert.match(dashboardJs, /function renderSparkSvg\(series\)/);
  assert.match(dashboardJs, /<svg class="trend-svg"/);
  assert.match(dashboardJs, /<polyline/);
});

test('dashboard.js exportDrawerCsv 输出 CSV blob', () => {
  assert.match(dashboardJs, /function exportDrawerCsv\(rows\)/);
  assert.match(dashboardJs, /'text\/csv;charset=utf-8;'/);
});

test('dashboard.js syncDefaultJd 读 BossJD.getCurrentJdId 同步顶部下拉', () => {
  assert.match(dashboardJs, /async function syncDefaultJd\(\)/);
  assert.match(dashboardJs, /self\.BossJD\.getCurrentJdId\(\)/);
});

test('dashboard.js DOMContentLoaded 顺序：bindControls → loadJdOptions → syncDefaultJd → reloadAll', () => {
  const m = dashboardJs.match(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/);
  assert.ok(m);
  const body = m[0];
  const iBC = body.indexOf('bindControls');
  const iLJD = body.indexOf('loadJdOptions');
  const iSync = body.indexOf('syncDefaultJd');
  const iRA = body.indexOf('reloadAll');
  assert.ok(iBC < iLJD && iLJD < iSync && iSync < iRA);
});

// ============ D: dashboard.css ============

test('dashboard.css v0.20.3 含时间窗按钮 + funnel-tab + 待续提示样式', () => {
  assert.match(dashboardCss, /\.time-btn\s*\{/);
  assert.match(dashboardCss, /\.time-btn\.active\s*\{/);
  assert.match(dashboardCss, /\.funnel-tab\s*\{/);
  assert.match(dashboardCss, /\.funnel-tab\.active\s*\{/);
  assert.match(dashboardCss, /\.funnel-placeholder\s*\{/);
  assert.match(dashboardCss, /\.drawer-overflow-hint\s*\{/);
});

test('dashboard.css v0.20.3 删 .today-* / .funnel-pair / .funnel-col 旧样式', () => {
  assert.doesNotMatch(dashboardCss, /\.today-cell\s*\{/);
  assert.doesNotMatch(dashboardCss, /\.today-value\s*\{/);
  assert.doesNotMatch(dashboardCss, /\.funnel-pair\s*\{/);
  assert.doesNotMatch(dashboardCss, /\.funnel-col\s*\{/);
});

test('dashboard.css 含 v2 共用样式（reason 系列 + trend / drawer）', () => {
  assert.match(dashboardCss, /\.reason-fill\s*\{/);
  assert.match(dashboardCss, /\.reason-fill\.match-fill\s*\{/);
  assert.match(dashboardCss, /\.reason-fill\.miss-fill\s*\{[\s\S]*?#f5a623/);
  assert.match(dashboardCss, /\.trend-svg\s*\{/);
  assert.match(dashboardCss, /\.drawer-table\s*\{/);
  assert.match(dashboardCss, /\.btn-admin-jump\s*\{/);
  assert.match(dashboardCss, /\.jd-section-title\s*\{/);
});

// ============ E: admin URL 跳转保留 ============

test('admin.js 含 setupJdJumpFromUrl IIFE', () => {
  assert.match(adminJs, /function setupJdJumpFromUrl\(\)/);
  assert.match(adminJs, /params\.get\('jdId'\)/);
  assert.match(adminJs, /params\.get\('scrollTo'\)/);
});

test('admin.js URL 跳转：等 JD list 加载 → openJDFormForEdit → scroll + 高亮', () => {
  assert.match(adminJs, /\.btn-jd-edit\[data-id="' \+ jdId/);
  assert.match(adminJs, /await openJDFormForEdit\(jdId\)/);
  assert.match(adminJs, /\/\^\(\[MO\]\)\(\\d\+\)\$\//);
  assert.match(adminJs, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
  assert.match(adminJs, /classList\.add\('flash-highlight'\)/);
});

test('admin.css 含 .condition-row.flash-highlight 黄色闪烁动画', () => {
  assert.match(adminCss, /\.condition-row\.flash-highlight\s*\{[\s\S]*?animation:\s*condition-flash/);
  assert.match(adminCss, /@keyframes condition-flash/);
});

// ============ F: sidepanel 看板入口（v0.20.2 加） ============

test('v0.25.0: sidepanel.html 顶部 h2 含 btn-dashboard（从 footer 迁移过来）', () => {
  const sidepanelHtml = read('sidepanel/sidepanel.html');
  // v0.25.0：按钮从 footer 迁移到顶部 h2 同一行；id 不变，只是位置变 + 加了 style 属性
  assert.match(sidepanelHtml, /id="btn-dashboard"[^>]*>📊 看板/);
});

test('sidepanel.js btn-dashboard 监听 chrome.tabs.create 打开 dashboard.html', () => {
  const sidepanelJs = read('sidepanel/sidepanel.js');
  assert.match(sidepanelJs, /const btnDashboard = \$\('btn-dashboard'\)/);
  assert.match(sidepanelJs, /chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\('dashboard\/dashboard\.html'\) \}\)/);
});
