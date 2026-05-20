// BOSS Sniffer 设置页 - admin.js
// 通过消息和 background.js 通信，读写所有配置项

const $ = function (id) { return document.getElementById(id); };

// 默认值（与 background.js 的 appConfig 保持一致）
const DEFAULTS = {
  llm: {
    currentId: 'default-anthropic',
    configs: [{
      id: 'default-anthropic',
      name: 'Anthropic · Claude',
      providerName: 'Anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      authType: 'x-api-key',
      apiKey: '',
      model: 'claude-sonnet-4-6',
      concurrency: 5
    }]
  },
  sayHi: {
    enabled: false,
    delayMin: 1500,
    delayMax: 5000,
    restAfter: 30,
    restMinutes: [5, 10]
  },
  // v0.17.0.10 POC A7 阶段 b：沟通页 DOM 扫描风控配置
  sayHiDom: {
    scanMaxPerRun: 1,
    cooldownMinMs: 5000,
    cooldownMaxMs: 8000,
    proactiveFetchEnabled: false
  },
  // v0.17.1.3：评估「符合」→ 自动求简历（仅批量，单评始终手动）
  autoAction: {
    enabledBatchEval: false,
    dryRun: false,
    actionCooldownMinMs: 2000,
    actionCooldownMaxMs: 4000
  }
};

// 跟踪初始加载值，用以判断保存时哪些字段真的被改了
let loadedConfig = null;
let editingLlmId = '';

// ============ v0.17.1：HR 快速配置 - 预置厂商表 ============
// 每个 preset 含：HR 不用碰的高级字段全部固化 + HR 选模型时显示的友好 label。
// custom 不在 PRESET_PROVIDERS 里，是 fallback 标记。
const PRESET_PROVIDERS = {
  wiz: {
    label: 'Wiz（公司中转，推荐）',
    providerName: 'Wiz',
    protocol: 'anthropic-messages',
    baseUrl: 'http://10.0.3.248:3000/api',
    authType: 'x-api-key',
    concurrency: 5,
    nameTemplate: 'Wiz · {model}',
    models: [
      { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6 · 平衡推荐', isDefault: true },
      { id: 'claude-opus-4-7',            label: 'Opus 4.7 · 最聪明 · 贵 · 慢' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5 · 快 · 便宜（大量人筛）' }
    ]
  },
  deepseek: {
    label: 'DeepSeek 官方',
    providerName: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    authType: 'bearer',
    concurrency: 5,
    nameTemplate: 'DeepSeek · {model}',
    // 按官方文档 (https://api-docs.deepseek.com/zh-cn/) 主推 V4：
    // - deepseek-v4-flash：当前主力，默认开思考模式（CoT）
    // - deepseek-v4-pro：最强但慢，思考强（effort=high）
    // - deepseek-chat / deepseek-reasoner：老名字兼容，2026-07-24 弃用
    //   chat = v4-flash 不开思考（快）；reasoner = v4-flash 开思考（准）
    models: [
      { id: 'deepseek-v4-flash', label: 'V4 Flash · 平衡推荐', isDefault: true },
      { id: 'deepseek-v4-pro',   label: 'V4 Pro · 最强 · 慢且贵' },
      { id: 'deepseek-chat',     label: 'Chat（=V4 Flash 不开思考，更快）2026-07-24 弃用' },
      { id: 'deepseek-reasoner', label: 'Reasoner（=V4 Flash 思考模式）2026-07-24 弃用' }
    ]
  }
};

// 根据现有 config 反推 preset key（编辑场景）。baseUrl host 匹配
function detectPresetKey(cfg) {
  if (!cfg || !cfg.baseUrl) return 'wiz';   // 新建默认 wiz
  const url = String(cfg.baseUrl).toLowerCase();
  if (url.indexOf('10.0.3.248') !== -1 || url.indexOf('wiz') !== -1) return 'wiz';
  if (url.indexOf('deepseek.com') !== -1) return 'deepseek';
  return 'custom';
}

// 把 preset 的固化字段写进原 form 隐藏字段。可选 model 强制选中。
function applyPresetToForm(presetKey, forceModel) {
  const preset = PRESET_PROVIDERS[presetKey];
  const modelRow = $('llm-preset-model-row');
  const advanced = $('llm-advanced-details');
  if (!preset) {
    // custom：模型行隐藏；自动展开高级设置
    if (modelRow) modelRow.style.display = 'none';
    if (advanced) advanced.open = true;
    return;
  }
  if (modelRow) modelRow.style.display = '';
  if (advanced) advanced.open = false;

  // 填充模型下拉
  const sel = $('llm-preset-model');
  sel.innerHTML = '';
  const targetModel = forceModel || (preset.models.find(function (m) { return m.isDefault; }) || preset.models[0]).id;
  preset.models.forEach(function (m) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === targetModel) opt.selected = true;
    sel.appendChild(opt);
  });

  // 同步高级字段（HR 看不见但提交时会读）
  $('llm-protocol').value = preset.protocol;
  $('llm-baseurl').value = preset.baseUrl;
  $('llm-authtype').value = preset.authType;
  $('llm-provider-name').value = preset.providerName;
  $('llm-model').value = targetModel;
  $('llm-concurrency').value = preset.concurrency;
  // 配置名称用 template（替换 {model}）
  $('llm-name').value = preset.nameTemplate.replace('{model}', targetModel);
  syncApiKeyLabel();
}

// HR 友好错误翻译
function translateLlmError(rawError) {
  const s = String(rawError || '').toLowerCase();
  if (s.indexOf('401') !== -1 || s.indexOf('unauthorized') !== -1 || s.indexOf('authentication') !== -1) {
    return 'API Key 不对或已失效，请检查';
  }
  if (s.indexOf('403') !== -1 || s.indexOf('forbidden') !== -1) {
    return 'API Key 没权限调这个接口';
  }
  if (s.indexOf('429') !== -1 || s.indexOf('rate limit') !== -1 || s.indexOf('rate_limit') !== -1) {
    return '请求太快或额度用尽，稍等再试';
  }
  if (s.indexOf('402') !== -1 || s.indexOf('balance') !== -1 || s.indexOf('余额') !== -1 || s.indexOf('insufficient') !== -1) {
    return '账户余额不足';
  }
  if (s.indexOf('404') !== -1 || s.indexOf('model not found') !== -1 || s.indexOf('not_found') !== -1) {
    return '模型名不正确或厂商不支持，请改选其他';
  }
  if (s.indexOf('超时') !== -1 || s.indexOf('timeout') !== -1) {
    return '连接超时（检查 VPN / 公司中转是否在线）';
  }
  if (s.indexOf('failed to fetch') !== -1 || s.indexOf('econn') !== -1 || s.indexOf('network') !== -1) {
    return '网络不通（VPN / DNS / 中转 任一环节检查）';
  }
  // 默认带原始信息（≤ 60 字符）
  return rawError ? String(rawError).slice(0, 60) : '未知错误';
}

// ============ 工具 ============
function setStatus(msg, kind) {
  const el = $('save-status');
  el.textContent = msg || '';
  el.className = 'save-status' + (kind ? ' ' + kind : '');
  if (msg) {
    setTimeout(function () {
      if (el.textContent === msg) {
        el.textContent = '';
        el.className = 'save-status';
      }
    }, 4000);
  }
}

function syncApiKeyLabel() {
  const isBearer = $('llm-authtype').value === 'bearer';
  $('llm-apikey-label').textContent = isBearer ? 'Auth Token' : 'API Key';
  // 已存有值时占位提示，未存时提示填什么格式
  const existing = getLlmConfigById(editingLlmId);
  const hasValue = existing && existing.apiKey;
  if (hasValue) {
    $('llm-apikey').placeholder = '已保存的 ' + (isBearer ? 'Token' : 'Key') + '（要改请重新输入）';
  } else {
    $('llm-apikey').placeholder = isBearer ? 'sk-... / cr_... / 厂商 token' : 'sk-ant-...';
  }
}

function normalizeLlmSettings(settings) {
  if (self.BossLLM && typeof self.BossLLM.normalizeLlmSettings === 'function') {
    return self.BossLLM.normalizeLlmSettings(settings || DEFAULTS.llm);
  }
  return settings || DEFAULTS.llm;
}

function getLlmSettings() {
  // v0.17.0.6 fix：不再每次重 normalize。normalizeLlmSettings 返回新对象 +
  // 新 configs 数组，导致 collectLlmFormConfig 内部多次调用拿到不同引用，
  // 后续 push 推到旧引用 → 新增/编辑 LLM 配置全部丢失。
  // 现在改成：loadAll 加载时已 normalize 一次并存入 loadedConfig.llm；后续
  // 所有读写都直接返回同一引用，mutate 安全。
  if (!loadedConfig) loadedConfig = {};
  if (!loadedConfig.llm) {
    loadedConfig.llm = normalizeLlmSettings(DEFAULTS.llm);
  }
  return loadedConfig.llm;
}

function getLlmConfigById(id) {
  const settings = getLlmSettings();
  return (settings.configs || []).find(function (cfg) { return cfg.id === id; }) || null;
}

function currentLlmConfig() {
  const settings = getLlmSettings();
  if (self.BossLLM && typeof self.BossLLM.getCurrentLlmConfig === 'function') {
    return self.BossLLM.getCurrentLlmConfig(settings);
  }
  return (settings.configs || [])[0] || null;
}

function makeLlmId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return 'llm_' + Date.now() + '_' + random;
}

function renderLlmList() {
  const settings = getLlmSettings();
  const list = settings.configs || [];
  const wrap = $('llm-list');
  wrap.innerHTML = '';
  $('llm-empty').style.display = list.length ? 'none' : 'block';
  renderCurrentLlmSummary();

  list.forEach(function (cfg) {
    const item = document.createElement('div');
    item.className = 'manage-item' + (cfg.id === settings.currentId ? ' is-current' : '');
    item.innerHTML =
      '<div class="item-info">' +
        '<h4>' + escapeHtml(cfg.name || cfg.model || '未命名配置') + (cfg.id === settings.currentId ? '<span class="badge-current">当前</span>' : '') + '</h4>' +
        '<p>' + escapeHtml(cfg.providerName || '自定义厂商') + ' · ' + escapeHtml(cfg.protocol || '') + ' · ' + escapeHtml(cfg.model || '--') + '</p>' +
        '<p>' + escapeHtml(cfg.baseUrl || '--') + '</p>' +
      '</div>' +
      '<div class="item-actions">' +
        (cfg.id === settings.currentId ? '' : '<button class="btn-llm-current" data-id="' + escapeHtml(cfg.id) + '">设为当前</button>') +
        '<button class="btn-llm-test" data-id="' + escapeHtml(cfg.id) + '">测试</button>' +
        '<button class="btn-llm-edit" data-id="' + escapeHtml(cfg.id) + '">编辑</button>' +
        '<button class="btn-llm-del" data-id="' + escapeHtml(cfg.id) + '">删除</button>' +
      '</div>';
    wrap.appendChild(item);
  });

  Array.from(wrap.querySelectorAll('.btn-llm-current')).forEach(function (btn) {
    btn.addEventListener('click', async function () {
      settings.currentId = btn.dataset.id;
      renderLlmList();
      // v0.17.0.7：切换当前模型也立即持久化（HR 不用再点保存所有更改）
      try {
        await persistLlmSettings();
        setStatus('✓ 已切换当前模型（已写入扩展）', 'ok');
      } catch (e) {
        setStatus('✗ 切换失败（内存改了但未写入）：' + e.message, 'err');
      }
    });
  });
  Array.from(wrap.querySelectorAll('.btn-llm-test')).forEach(function (btn) {
    btn.addEventListener('click', function () { testLlmConfigById(btn.dataset.id); });
  });
  Array.from(wrap.querySelectorAll('.btn-llm-edit')).forEach(function (btn) {
    btn.addEventListener('click', function () { openLlmDrawerForEdit(btn.dataset.id); });
  });
  Array.from(wrap.querySelectorAll('.btn-llm-del')).forEach(function (btn) {
    btn.addEventListener('click', function () { deleteLlmConfig(btn.dataset.id); });
  });
}

function renderCurrentLlmSummary() {
  const el = $('current-llm-summary');
  if (!el) return;
  const cfg = currentLlmConfig();
  const value = el.querySelector('.summary-value');
  if (!cfg) {
    value.textContent = '未选择大模型';
    return;
  }
  value.textContent = (cfg.providerName || '自定义厂商') + ' · ' + (cfg.model || '未填写模型') + ' · ' + (cfg.name || cfg.id);
}

function openLlmDrawerForEdit(id) {
  const cfg = getLlmConfigById(id);
  if (!cfg) return;
  editingLlmId = id;
  $('llm-drawer-title').textContent = '编辑大模型';
  $('llm-edit-id').value = cfg.id;
  $('llm-name').value = cfg.name || '';
  $('llm-provider-name').value = cfg.providerName || '';
  $('llm-protocol').value = cfg.protocol || 'openai-chat';
  $('llm-baseurl').value = cfg.baseUrl || '';
  $('llm-authtype').value = cfg.authType || (cfg.protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer');
  $('llm-model').value = cfg.model || '';
  $('llm-concurrency').value = cfg.concurrency != null ? cfg.concurrency : 5;
  $('llm-apikey').value = '';
  // v0.17.1：根据已存 baseUrl 反推 preset；非 custom 时强制选中现有 model
  const presetKey = detectPresetKey(cfg);
  $('llm-preset').value = presetKey;
  if (presetKey === 'custom') {
    applyPresetToForm('custom');
  } else {
    // 注意：applyPresetToForm 会覆盖 baseUrl/protocol/authType 等高级字段。
    // 编辑老配置时我们尊重保存的值，不强制覆盖，所以只重建模型下拉。
    rebuildPresetModelSelect(presetKey, cfg.model);
    $('llm-preset-model-row').style.display = '';
    $('llm-advanced-details').open = false;
  }
  $('llm-drawer').classList.remove('hidden');
  syncApiKeyLabel();
}

function openLlmDrawerForNew() {
  editingLlmId = '';
  $('llm-drawer-title').textContent = '新增大模型';
  $('llm-edit-id').value = '';
  $('llm-apikey').value = '';
  // v0.17.1：默认 Wiz（公司中转）+ 默认模型 Sonnet 4.6
  $('llm-preset').value = 'wiz';
  applyPresetToForm('wiz');
  $('llm-drawer').classList.remove('hidden');
  $('llm-apikey').focus();
}

// 仅重建预置区下拉，不覆盖高级字段（给编辑场景用）
function rebuildPresetModelSelect(presetKey, selectedModel) {
  const preset = PRESET_PROVIDERS[presetKey];
  const sel = $('llm-preset-model');
  if (!preset || !sel) return;
  sel.innerHTML = '';
  preset.models.forEach(function (m) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModel) opt.selected = true;
    sel.appendChild(opt);
  });
  // 如果当前 model 不在预置列表里（HR 手填了非预置模型），加一个临时 option
  if (selectedModel && !preset.models.some(function (m) { return m.id === selectedModel; })) {
    const opt = document.createElement('option');
    opt.value = selectedModel;
    opt.textContent = selectedModel + '（自定义）';
    opt.selected = true;
    sel.appendChild(opt);
  }
}

function closeLlmDrawer() {
  $('llm-drawer').classList.add('hidden');
}

function openLlmTutorial() {
  $('llm-tutorial-modal').classList.remove('hidden');
}

function closeLlmTutorial() {
  $('llm-tutorial-modal').classList.add('hidden');
}

// v0.17.0.7：拆 collectLlmFormConfig 职责
// - buildLlmFormConfig：只读 form 字段构造 cfg，无副作用（测试连接用）
// - commitLlmFormConfig：把 cfg push/update 进 settings.configs（保存用）
// 原 collectLlmFormConfig 保留作为兼容门面（build + commit）
function buildLlmFormConfig() {
  const id = $('llm-edit-id').value || makeLlmId();
  const settings = getLlmSettings();
  const old = (settings.configs || []).find(function (x) { return x.id === id; }) || {};
  const protocol = $('llm-protocol').value || 'openai-chat';
  const conc = parseInt($('llm-concurrency').value, 10);
  const providerName = $('llm-provider-name').value.trim() || (protocol === 'anthropic-messages' ? 'Anthropic' : '自定义厂商');
  const model = $('llm-model').value.trim();
  return {
    id: id,
    name: $('llm-name').value.trim() || (providerName + (model ? ' · ' + model : '')),
    providerName: providerName,
    protocol: protocol,
    baseUrl: $('llm-baseurl').value.trim() || (protocol === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com'),
    authType: $('llm-authtype').value || (protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
    apiKey: $('llm-apikey').value.trim() || old.apiKey || '',
    model: model,
    concurrency: isNaN(conc) ? 5 : Math.max(1, Math.min(15, conc))
  };
}

function commitLlmFormConfig(cfg) {
  const settings = getLlmSettings();
  const idx = settings.configs.findIndex(function (x) { return x.id === cfg.id; });
  if (idx >= 0) settings.configs[idx] = cfg;
  else settings.configs.push(cfg);
  if (!settings.currentId) settings.currentId = cfg.id;
}

function collectLlmFormConfig() {
  const cfg = buildLlmFormConfig();
  commitLlmFormConfig(cfg);
  return cfg;
}

// 持久化 LLM 设置到 chrome.storage（通过 background SET_CONFIG_SECTION）
async function persistLlmSettings() {
  const settings = getLlmSettings();
  await ensureHostPermissionsForSettings(settings);
  const r = await chrome.runtime.sendMessage({
    type: 'SET_CONFIG_SECTION',
    section: 'llm',
    patch: settings
  });
  if (!r || r.ok === false) {
    throw new Error('扩展未返回 ok：' + (r && r.error ? r.error : 'unknown'));
  }
  return r;
}

async function saveLlmForm() {
  // v0.17.0.7：drawer「保存」改成实时持久化，HR 不用再点页面底部「保存所有更改」
  const cfg = buildLlmFormConfig();
  commitLlmFormConfig(cfg);
  editingLlmId = cfg.id;
  $('llm-edit-id').value = cfg.id;
  $('llm-apikey').value = '';
  renderLlmList();
  syncApiKeyLabel();
  setStatus('保存中...', '');
  $('btn-llm-save').disabled = true;
  try {
    await persistLlmSettings();
    setStatus('✓ 大模型配置已保存（已写入扩展）', 'ok');
    closeLlmDrawer();
  } catch (e) {
    setStatus('✗ 保存失败：' + e.message, 'err');
  } finally {
    $('btn-llm-save').disabled = false;
  }
}

async function deleteLlmConfig(id) {
  const settings = getLlmSettings();
  const cfg = getLlmConfigById(id);
  if (!cfg) return;
  const isCurrent = settings.currentId === id;
  const msg = isCurrent
    ? '该配置正在使用，删除后将自动切换到列表中的第一个可用配置。是否继续？'
    : '确认删除「' + (cfg.name || cfg.model || id) + '」？';
  if (!confirm(msg)) return;
  settings.configs = settings.configs.filter(function (x) { return x.id !== id; });
  if (settings.currentId === id) settings.currentId = (settings.configs[0] && settings.configs[0].id) || '';
  if (editingLlmId === id) {
    editingLlmId = '';
    closeLlmDrawer();
  }
  renderLlmList();
  // v0.17.0.7：删除后立即持久化
  try {
    await persistLlmSettings();
    setStatus('✓ 大模型配置已删除（已写入扩展）', 'ok');
  } catch (e) {
    setStatus('✗ 删除失败（内存改了但未写入）：' + e.message, 'err');
  }
}

async function ensureHostPermission(baseUrl) {
  if (!chrome.permissions || !self.BossLLM || typeof self.BossLLM.getHostPermissionPattern !== 'function') return true;
  const pattern = self.BossLLM.getHostPermissionPattern(baseUrl);
  if (!pattern) throw new Error('Base URL 不合法：' + baseUrl);
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (!ok) throw new Error('未授权访问 ' + pattern + '，无法调用该厂商 API');
  return true;
}

async function ensureHostPermissionsForSettings(settings) {
  const seen = new Set();
  for (const cfg of (settings.configs || [])) {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey) continue;
    const pattern = self.BossLLM && self.BossLLM.getHostPermissionPattern
      ? self.BossLLM.getHostPermissionPattern(cfg.baseUrl)
      : cfg.baseUrl;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    await ensureHostPermission(cfg.baseUrl);
  }
}

async function testLlmConfigById(id) {
  const cfg = getLlmConfigById(id);
  const result = $('llm-list-test-result');
  if (!cfg) return;
  if (!cfg.apiKey) {
    result.className = 'test-result err';
    result.textContent = '✗ 该配置缺少 API Key';
    return;
  }
  result.className = 'test-result loading';
  result.textContent = '⏳ 测试「' + (cfg.name || cfg.model || id) + '」...';
  try {
    await ensureHostPermission(cfg.baseUrl);
    const r = await chrome.runtime.sendMessage({ type: 'TEST_LLM_CONFIG', llm: cfg });
    if (r.ok) {
      result.className = 'test-result ok';
      result.textContent = '✓ 连接成功（响应："' + (r.text || '').slice(0, 40) + '"）';
    } else {
      result.className = 'test-result err';
      result.textContent = '✗ ' + translateLlmError(r.error);
    }
  } catch (e) {
    result.className = 'test-result err';
    result.textContent = '✗ ' + translateLlmError(e.message);
  }
}

// "5,10" → [5, 10]；"7" → [7, 7]；空/非法 → 默认 [5, 10]
function parseRestMinutes(s) {
  const str = String(s || '').trim();
  if (!str) return [5, 10];
  const parts = str.split(/[,，\s]+/).map(function (x) { return parseFloat(x); }).filter(function (n) { return !isNaN(n) && n > 0; });
  if (parts.length === 0) return [5, 10];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [Math.min(parts[0], parts[1]), Math.max(parts[0], parts[1])];
}

// ============ 加载 ============
async function loadAll() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!res || !res.config) {
    setStatus('加载配置失败 — 请检查扩展状态', 'err');
    return;
  }
  loadedConfig = res.config;

  // LLM
  loadedConfig.llm = normalizeLlmSettings(res.config.llm || DEFAULTS.llm);
  renderLlmList();
  closeLlmDrawer();

  // sayHi（enabled 已搬到侧边栏，admin 仅配置详细参数）
  const sayHi = res.config.sayHi || DEFAULTS.sayHi;
  $('sayhi-delay-min').value = sayHi.delayMin != null ? sayHi.delayMin : DEFAULTS.sayHi.delayMin;
  $('sayhi-delay-max').value = sayHi.delayMax != null ? sayHi.delayMax : DEFAULTS.sayHi.delayMax;
  $('sayhi-rest-after').value = sayHi.restAfter != null ? sayHi.restAfter : DEFAULTS.sayHi.restAfter;
  const rm = sayHi.restMinutes || DEFAULTS.sayHi.restMinutes;
  $('sayhi-rest-minutes').value = Array.isArray(rm) ? rm.join(',') : String(rm);

  // v0.17.0.10 POC A7：沟通页 DOM 扫描配置
  const sayHiDom = res.config.sayHiDom || DEFAULTS.sayHiDom;
  $('sayhidom-max-per-run').value = sayHiDom.scanMaxPerRun != null ? sayHiDom.scanMaxPerRun : DEFAULTS.sayHiDom.scanMaxPerRun;
  $('sayhidom-cooldown-min').value = sayHiDom.cooldownMinMs != null ? sayHiDom.cooldownMinMs : DEFAULTS.sayHiDom.cooldownMinMs;
  $('sayhidom-cooldown-max').value = sayHiDom.cooldownMaxMs != null ? sayHiDom.cooldownMaxMs : DEFAULTS.sayHiDom.cooldownMaxMs;
  $('sayhidom-proactive-fetch').checked = !!sayHiDom.proactiveFetchEnabled;

  // v0.17.1.3：批量评估后自动求简历（单评永不自动）
  // v0.24.2：enabledBatchEval / autoMarkUnsuitable / dryRun 不再在 admin 渲染
  //   迁移：前两者由 sidepanel 沟通页 control-bar 现场决定；dryRun 永久关闭无 UI
  const autoAction = res.config.autoAction || DEFAULTS.autoAction;
  $('auto-action-cooldown-min').value = autoAction.actionCooldownMinMs != null ? autoAction.actionCooldownMinMs : DEFAULTS.autoAction.actionCooldownMinMs;
  $('auto-action-cooldown-max').value = autoAction.actionCooldownMaxMs != null ? autoAction.actionCooldownMaxMs : DEFAULTS.autoAction.actionCooldownMaxMs;

  // 版本号（从 manifest 拿）
  if (chrome.runtime && chrome.runtime.getManifest) {
    const m = chrome.runtime.getManifest();
    $('version-tag').textContent = 'v' + m.version;
  }
}

// ============ 收集表单数据 ============
function collectLlmPatch() {
  if (!$('llm-drawer').classList.contains('hidden')) collectLlmFormConfig();
  return getLlmSettings();
}

function collectSayHiPatch() {
  const dMin = parseInt($('sayhi-delay-min').value, 10);
  const dMax = parseInt($('sayhi-delay-max').value, 10);
  const restAfter = parseInt($('sayhi-rest-after').value, 10);
  // 注意：enabled 不在 patch 中（侧边栏单独控制），保存只更新节流参数
  return {
    delayMin: isNaN(dMin) ? DEFAULTS.sayHi.delayMin : Math.max(0, dMin),
    delayMax: isNaN(dMax) ? DEFAULTS.sayHi.delayMax : Math.max(0, dMax),
    restAfter: isNaN(restAfter) ? DEFAULTS.sayHi.restAfter : Math.max(1, restAfter),
    restMinutes: parseRestMinutes($('sayhi-rest-minutes').value)
  };
}

// v0.17.0.10 POC A7：沟通页 DOM 扫描风控配置
function collectSayHiDomPatch() {
  const maxN = parseInt($('sayhidom-max-per-run').value, 10);
  const cMin = parseInt($('sayhidom-cooldown-min').value, 10);
  const cMax = parseInt($('sayhidom-cooldown-max').value, 10);
  const cMinSafe = isNaN(cMin) ? DEFAULTS.sayHiDom.cooldownMinMs : Math.max(0, cMin);
  const cMaxSafe = isNaN(cMax) ? DEFAULTS.sayHiDom.cooldownMaxMs : Math.max(cMinSafe, cMax);
  return {
    scanMaxPerRun: isNaN(maxN) ? DEFAULTS.sayHiDom.scanMaxPerRun : Math.max(0, maxN),
    cooldownMinMs: cMinSafe,
    cooldownMaxMs: cMaxSafe,
    proactiveFetchEnabled: !!$('sayhidom-proactive-fetch').checked
  };
}

// v0.17.1.3：批量评估后自动求简历配置（单评永不自动）
// v0.24.2：admin 只 patch cooldown 参数 + 强制 dryRun=false；
//   enabledBatchEval / autoMarkUnsuitable 由 sidepanel 沟通页 control-bar 各自的
//   SET_CONFIG_SECTION 调用维护（merge 语义不被覆盖）。
function collectAutoActionPatch() {
  const cMin = parseInt($('auto-action-cooldown-min').value, 10);
  const cMax = parseInt($('auto-action-cooldown-max').value, 10);
  const cMinSafe = isNaN(cMin) ? DEFAULTS.autoAction.actionCooldownMinMs : Math.max(0, cMin);
  const cMaxSafe = isNaN(cMax) ? DEFAULTS.autoAction.actionCooldownMaxMs : Math.max(cMinSafe, cMax);
  return {
    actionCooldownMinMs: cMinSafe,
    actionCooldownMaxMs: cMaxSafe,
    dryRun: false  // v0.24.2：试跑模式永久关闭
  };
}

// ============ 测试连接 ============
$('btn-test-llm').addEventListener('click', async function () {
  // v0.17.0.7：测试连接只构造临时 cfg，不写入 settings（避免点测试就保存）
  const llm = buildLlmFormConfig();
  const result = $('test-result');
  if (!llm.apiKey) {
    result.className = 'test-result err';
    result.textContent = '✗ 请先填 ' + (llm.authType === 'bearer' ? 'Auth Token' : 'API Key');
    return;
  }
  result.className = 'test-result loading';
  result.textContent = '⏳ 测试中...';
  $('btn-test-llm').disabled = true;
  try {
    await ensureHostPermission(llm.baseUrl);
    const r = await chrome.runtime.sendMessage({ type: 'TEST_LLM_CONFIG', llm: llm });
    if (r.ok) {
      result.className = 'test-result ok';
      result.textContent = '✓ 连接成功（响应："' + (r.text || '').slice(0, 40) + '"）';
    } else {
      result.className = 'test-result err';
      result.textContent = '✗ ' + translateLlmError(r.error);
    }
  } catch (e) {
    result.className = 'test-result err';
    result.textContent = '✗ ' + translateLlmError(e.message);
  }
  $('btn-test-llm').disabled = false;
});

// ============ 保存 ============
$('btn-save').addEventListener('click', async function () {
  setStatus('保存中...', '');
  $('btn-save').disabled = true;
  try {
    const llmPatch = collectLlmPatch();
    const sayHiPatch = collectSayHiPatch();
    await ensureHostPermissionsForSettings(llmPatch);

    const sayHiDomPatch = collectSayHiDomPatch();
    const autoActionPatch = collectAutoActionPatch();
    const ops = [
      chrome.runtime.sendMessage({ type: 'SET_CONFIG_SECTION', section: 'llm', patch: llmPatch }),
      chrome.runtime.sendMessage({ type: 'SET_CONFIG_SECTION', section: 'sayHi', patch: sayHiPatch }),
      chrome.runtime.sendMessage({ type: 'SET_CONFIG_SECTION', section: 'sayHiDom', patch: sayHiDomPatch }),
      chrome.runtime.sendMessage({ type: 'SET_CONFIG_SECTION', section: 'autoAction', patch: autoActionPatch })
    ];

    const results = await Promise.all(ops);
    const allOk = results.every(function (r) { return r && (r.ok !== false); });
    if (!allOk) {
      setStatus('部分配置保存失败，请重试', 'err');
      return;
    }

    setStatus('✓ 已保存（下次评估生效）', 'ok');
    await loadAll(); // 重新加载，刷新 placeholder 等
  } catch (e) {
    setStatus('✗ ' + e.message, 'err');
  } finally {
    $('btn-save').disabled = false;
  }
});

// ============ 重置 ============
$('btn-reset').addEventListener('click', function () {
  if (!confirm('确认把 LLM 和 sayHi 配置重置为默认？\n（已保存的 API Key 不会被清除，需要单独清空 input 后保存）')) return;
  loadedConfig.llm = normalizeLlmSettings(DEFAULTS.llm);
  renderLlmList();
  closeLlmDrawer();
  $('sayhi-delay-min').value = DEFAULTS.sayHi.delayMin;
  $('sayhi-delay-max').value = DEFAULTS.sayHi.delayMax;
  $('sayhi-rest-after').value = DEFAULTS.sayHi.restAfter;
  // v0.17.0.10 sayHiDom 重置
  $('sayhidom-max-per-run').value = DEFAULTS.sayHiDom.scanMaxPerRun;
  $('sayhidom-cooldown-min').value = DEFAULTS.sayHiDom.cooldownMinMs;
  $('sayhidom-cooldown-max').value = DEFAULTS.sayHiDom.cooldownMaxMs;
  $('sayhidom-proactive-fetch').checked = DEFAULTS.sayHiDom.proactiveFetchEnabled;
  $('sayhi-rest-minutes').value = DEFAULTS.sayHi.restMinutes.join(',');
  // v0.17.1.3 autoAction 重置
  // v0.24.2：enabledBatchEval / autoMarkUnsuitable / dryRun 已迁出 admin，此处不再重置
  $('auto-action-cooldown-min').value = DEFAULTS.autoAction.actionCooldownMinMs;
  $('auto-action-cooldown-max').value = DEFAULTS.autoAction.actionCooldownMaxMs;
  setStatus('已恢复表单为默认值，点击「保存所有更改」生效', '');
});

// ============ 联动 ============
$('btn-llm-new').addEventListener('click', openLlmDrawerForNew);
$('btn-llm-save').addEventListener('click', saveLlmForm);
$('btn-llm-cancel').addEventListener('click', closeLlmDrawer);
$('llm-drawer-close').addEventListener('click', closeLlmDrawer);
$('llm-drawer').querySelector('.drawer-overlay').addEventListener('click', closeLlmDrawer);
$('btn-llm-help').addEventListener('click', openLlmTutorial);
$('llm-tutorial-close').addEventListener('click', closeLlmTutorial);
$('llm-tutorial-modal').querySelector('.modal-overlay').addEventListener('click', closeLlmTutorial);
$('llm-authtype').addEventListener('change', syncApiKeyLabel);
$('llm-protocol').addEventListener('change', function () {
  if ($('llm-protocol').value === 'anthropic-messages') {
    if (!$('llm-baseurl').value.trim() || $('llm-baseurl').value.indexOf('deepseek') !== -1) $('llm-baseurl').value = 'https://api.anthropic.com';
    if (!$('llm-model').value.trim() || $('llm-model').value.indexOf('deepseek') !== -1) $('llm-model').value = 'claude-sonnet-4-6';
    $('llm-authtype').value = 'x-api-key';
  } else {
    if (!$('llm-baseurl').value.trim() || $('llm-baseurl').value.indexOf('anthropic') !== -1) $('llm-baseurl').value = 'https://api.deepseek.com';
    if (!$('llm-model').value.trim() || $('llm-model').value.indexOf('claude') !== -1) $('llm-model').value = 'deepseek-chat';
    $('llm-authtype').value = 'bearer';
  }
  syncApiKeyLabel();
});

// v0.17.1：HR 快速配置联动
$('llm-preset').addEventListener('change', function () {
  applyPresetToForm($('llm-preset').value);
});
// 切换"模型"下拉时同步到高级字段的 llm-model + 更新配置名称
$('llm-preset-model').addEventListener('change', function () {
  const model = $('llm-preset-model').value;
  $('llm-model').value = model;
  const preset = PRESET_PROVIDERS[$('llm-preset').value];
  if (preset) $('llm-name').value = preset.nameTemplate.replace('{model}', model);
});

// 注：sayHi 启用确认弹窗已搬到侧边栏（与启用 toggle 在同一处）

// ============ PoC 调试工具 ============
function setPocStatus(msg, kind) {
  const el = $('poc-status');
  el.className = 'test-result' + (kind ? ' ' + kind : '');
  el.textContent = msg || '';
}

$('btn-find-tab').addEventListener('click', async function () {
  setPocStatus('查找中...', 'loading');
  const r = await chrome.runtime.sendMessage({ type: 'FIND_BOSS_TAB' });
  if (r.ok) {
    setPocStatus('✓ 找到 tab #' + r.tabId + '：' + (r.url || '').slice(0, 60), 'ok');
  } else {
    setPocStatus('✗ ' + (r.error || '未知错误'), 'err');
  }
});

$('btn-test-debugger').addEventListener('click', async function () {
  setPocStatus('attaching...', 'loading');
  $('btn-test-debugger').disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_DEBUGGER_ATTACH' });
    if (r.ok) {
      const page = r.page || {};
      setPocStatus('✓ debugger 工作正常 — 当前页：' + (page.title || '?').slice(0, 30) + ' [' + (page.url || '').slice(0, 50) + ']', 'ok');
    } else {
      setPocStatus('✗ ' + (r.error || '未知错误'), 'err');
    }
  } finally {
    $('btn-test-debugger').disabled = false;
  }
});

$('btn-test-sayhi').addEventListener('click', async function () {
  const cid = $('test-candidate-id').value.trim();
  if (!cid) {
    setPocStatus('✗ 请先填 candidateId', 'err');
    return;
  }
  setPocStatus('执行中...', 'loading');
  $('btn-test-sayhi').disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_SAYHI', candidateId: cid });
    if (r.ok) {
      const strat = r.matchStrategy ? '['+r.matchStrategy+'] ' : '';
      const confirm = r.confirmClicked ? '+确认弹窗"' + (r.confirmButtonText || '') + '"' : (r.confirmClicked === false ? '（无确认弹窗）' : '');
      setPocStatus('✓ ' + strat + '点击"' + (r.buttonText || '打招呼') + '"' + confirm + '（' + new Date(r.clickedAt).toLocaleTimeString() + '）', 'ok');
    } else {
      const hint = r.hint ? ' [' + r.hint + ']' : '';
      setPocStatus('✗ ' + (r.error || '失败') + hint + '（试试 ④ 诊断 DOM）', 'err');
    }
  } finally {
    $('btn-test-sayhi').disabled = false;
  }
});

$('btn-diagnose-dom').addEventListener('click', async function () {
  const cid = $('test-candidate-id').value.trim();
  setPocStatus('诊断中...', 'loading');
  $('btn-diagnose-dom').disabled = true;
  const out = $('diag-output');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_DIAGNOSE_DOM', candidateId: cid });
    if (r.ok) {
      const d = r.diagnosis;
      const lines = [];
      lines.push('=== 诊断结果 ===');
      lines.push('当前页 URL: ' + d.url);
      lines.push('页面标题: ' + d.title);
      lines.push('candidateId: ' + cid);
      lines.push('encryptUid (从 IndexedDB): ' + (r.encryptUid || '(无)'));
      lines.push('');
      lines.push('=== ID 匹配命中数 ===');
      lines.push('用 candidateId 匹配到的元素: ' + d.idMatchCount.byCandidateId);
      lines.push('用 encryptUid 匹配到的元素:  ' + d.idMatchCount.byEncryptUid);
      lines.push('');
      lines.push('=== 命中 ID 的 attribute（这就是 BOSS 用的字段名！） ===');
      if (d.idMatchedAttrs && d.idMatchedAttrs.length) {
        d.idMatchedAttrs.forEach(function (x) {
          lines.push('  ' + x.attr + ' (出现 ' + x.count + ' 次)');
        });
      } else {
        lines.push('  ⚠ 没有任何元素的 attribute 含目标 ID');
        lines.push('  → 候选人可能不在当前页 DOM；或 BOSS 把 ID 放在 textContent 里');
      }
      lines.push('');
      lines.push('=== 页面 attribute 频率 Top 20（看 BOSS 命名风格） ===');
      d.attrFrequency.forEach(function (x) {
        lines.push('  ' + x.attr.padEnd(30, ' ') + ' × ' + x.count);
      });
      if (d.matchedElementChain) {
        lines.push('');
        lines.push('=== 匹配元素的祖先链（从下到上） ===');
        d.matchedElementChain.forEach(function (n, i) {
          lines.push('  [' + i + '] <' + n.tag + '> class="' + n.cls + '"');
          n.attrs.forEach(function (a) { lines.push('       ' + a); });
        });
      }
      lines.push('');
      lines.push('=== 🎯 "打招呼"按钮（' + (d.greetButtons || []).length + ' 个找到） ===');
      (d.greetButtons || []).forEach(function (g, i) {
        lines.push('--- 按钮 [' + i + '] 文本="' + g.buttonText + '" 坐标=(' + g.buttonRect.x + ',' + g.buttonRect.y + ') 尺寸=' + g.buttonRect.w + 'x' + g.buttonRect.h + ' ---');
        lines.push('  按钮 class: "' + g.buttonClass + '"');
        lines.push('  祖先链:');
        g.ancestorChain.forEach(function (n, di) {
          lines.push('    [' + di + '] <' + n.tag + '> class="' + n.cls + '"');
          n.attrs.forEach(function (a) { lines.push('         ' + a); });
        });
        if (g.cardOuterHTML) {
          lines.push('  卡片 outerHTML:');
          lines.push('    ' + g.cardOuterHTML);
        }
        lines.push('');
      });
      if ((d.scopedIdSamples || []).length > 0) {
        lines.push('=== 🧱 高频 Vue 组件样本（疑似候选人卡片） ===');
        d.scopedIdSamples.forEach(function (s, i) {
          lines.push('--- 样本 [' + i + '] scope=' + s.scopedAttr + ' <' + s.tag + '> 尺寸=' + s.size + ' ---');
          lines.push('  class: "' + s.cls + '"');
          s.attrs.forEach(function (a) { lines.push('  ' + a); });
          lines.push('  outerHTML:');
          lines.push('    ' + s.outerHTML);
          lines.push('');
        });
      }
      if ((d.kaValues || []).length > 0) {
        lines.push('=== ka= 属性值（' + d.kaValues.length + ' 个） ===');
        d.kaValues.forEach(function (k) { lines.push('  ' + k); });
      }
      lines.push('');
      lines.push('=== 🪟 iframe 检查（' + (d.iframes || []).length + ' 个） ===');
      (d.iframes || []).forEach(function (f, i) {
        lines.push('--- iframe [' + i + '] ---');
        lines.push('  src: ' + f.src);
        lines.push('  name: ' + f.name);
        lines.push('  尺寸: ' + f.rect.w + 'x' + f.rect.h + ' @ (' + f.rect.x + ',' + f.rect.y + ')');
        lines.push('  同源可访问: ' + f.sameOrigin);
        if (f.crossOriginError) lines.push('  跨域错: ' + f.crossOriginError);
        if (f.innerCounts) {
          lines.push('  内部元素总数: ' + f.innerCounts.totalElements);
          lines.push('  内部 .card-inner: ' + f.innerCounts.cardInner);
          lines.push('  内部 [data-geekid]: ' + f.innerCounts.dataGeekid);
          lines.push('  内部 [data-geek]: ' + f.innerCounts.dataGeek);
          lines.push('  内部 button.btn-greet: ' + f.innerCounts.btnGreet);
          lines.push('  内部 [ka]: ' + f.innerCounts.ka);
          lines.push('  内部 ID 命中数: ' + f.innerCounts.idMatchInIframe);
        }
        if (f.innerSamples) {
          lines.push('  内部样本:');
          lines.push('    ' + f.innerSamples);
        }
      });
      if ((d.cardSamples || []).length > 0) {
        lines.push('');
        lines.push('=== 候选人卡片样本（启发式 selector） ===');
        d.cardSamples.forEach(function (s) {
          lines.push('--- selector: ' + s.selector + '（' + s.count + ' 个） ---');
          lines.push(s.first2000);
          lines.push('');
        });
      }
      out.textContent = lines.join('\n');
      out.style.display = 'block';
      setPocStatus('✓ 诊断完成 — 把下面输出复制给开发者', 'ok');
    } else {
      setPocStatus('✗ ' + (r.error || '失败'), 'err');
    }
  } finally {
    $('btn-diagnose-dom').disabled = false;
  }
});

// ============ JD 模板管理（v0.12.0：必要 + 可选 + 阈值） ============
// 数据层 self.BossJD（lib/jd-templates.js），UI 层在此
//   - 列表表头：名称 / 必要 (M) / 可选 (N) / 阈值 (K) / 操作
//   - 表单：必要条件动态列表 + 可选条件动态列表 + 阈值
//   - 预览：按钮触发（从表单当前状态构造临时 jd 调 BossPromptBuilder）

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadJDList() {
  if (!self.BossJD) {
    console.warn('[admin] BossJD 模块未加载');
    return;
  }
  await self.BossJD.ensureSeeded();
  const list = await self.BossJD.listTemplates();
  const cur = await self.BossJD.getCurrentJdId();

  const tbody = $('jd-list-body');
  tbody.innerHTML = '';
  if (list.length === 0) {
    $('jd-empty').style.display = 'block';
    $('jd-table').style.display = 'none';
  } else {
    $('jd-empty').style.display = 'none';
    $('jd-table').style.display = '';
    list.forEach(function (t) {
      // v0.25.0：删 M/N/K 三列（HR 反馈列表不需要看这些数字）
      const tr = document.createElement('tr');
      if (t.jdId === cur) tr.classList.add('jd-row-current');
      tr.innerHTML =
        '<td>' + escapeHtml(t.name) + '</td>' +
        '<td class="actions-col">' +
          '<button class="btn-jd-preview" data-id="' + escapeHtml(t.jdId) + '">预览</button> ' +
          '<button class="btn-jd-edit" data-id="' + escapeHtml(t.jdId) + '">编辑</button> ' +
          '<button class="btn-jd-del" data-id="' + escapeHtml(t.jdId) + '">删除</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    Array.from(tbody.querySelectorAll('.btn-jd-preview')).forEach(function (btn) {
      btn.addEventListener('click', function () { openPromptPreviewByJdId(btn.dataset.id); });
    });
    Array.from(tbody.querySelectorAll('.btn-jd-edit')).forEach(function (btn) {
      btn.addEventListener('click', function () { openJDFormForEdit(btn.dataset.id); });
    });
    Array.from(tbody.querySelectorAll('.btn-jd-del')).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const t = list.find(function (x) { return x.jdId === btn.dataset.id; });
        if (!t) return;
        if (!confirm('确认删除「' + t.name + '」？\n（不可撤销）')) return;
        await self.BossJD.deleteTemplate(t.jdId);
        await loadJDList();
        setStatus('✓ JD 已删除', 'ok');
      });
    });
  }
  // 当前 JD 切换由侧边栏负责，admin 仅在列表中以 ● 高亮展示
}

// === 动态条件行（must / optional） ===
// 每行结构：<div class="condition-row"><span class="condition-prefix">M1.</span><input type="text"><button class="condition-del">×</button></div>
// 前缀 M1/M2/.../O1/O2/... 实时根据 DOM 顺序刷新（删除中间行后自动重排）
function makeConditionRow(prefix, idx, text) {
  const row = document.createElement('div');
  row.className = 'condition-row';

  const prefixSpan = document.createElement('span');
  prefixSpan.className = 'condition-prefix';
  prefixSpan.textContent = prefix + idx + '.';
  row.appendChild(prefixSpan);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = text || '';
  input.placeholder = prefix === 'M'
    ? '如：本科及以上学历'
    : '如：自动化测试';
  row.appendChild(input);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'condition-del';
  del.textContent = '×';
  del.title = '删除此条';
  del.addEventListener('click', function () {
    row.parentNode && row.parentNode.removeChild(row);
    refreshPrefixes(prefix === 'M' ? 'must-list' : 'opt-list', prefix);
  });
  row.appendChild(del);

  return row;
}

function refreshPrefixes(listId, prefix) {
  const rows = $(listId).querySelectorAll('.condition-row');
  rows.forEach(function (row, i) {
    const span = row.querySelector('.condition-prefix');
    if (span) span.textContent = prefix + (i + 1) + '.';
  });
}

function renderConditionList(listId, prefix, conditions) {
  const container = $(listId);
  container.innerHTML = '';
  (conditions || []).forEach(function (c, i) {
    container.appendChild(makeConditionRow(prefix, i + 1, c.text || ''));
  });
}

function collectConditions(listId, prefix) {
  const container = $(listId);
  const rows = container.querySelectorAll('.condition-row');
  const out = [];
  rows.forEach(function (row) {
    const input = row.querySelector('input[type="text"]');
    if (input) {
      out.push({ text: String(input.value || '').trim() });
    }
  });
  return out;
}

// v0.25.1：删 v0.21.0 · Phase 1·1b 沟通职位别名 CRUD 整段（路由改用 JD.name 严格相等）

// === v0.25.2：JD 内嵌话术模板 CRUD ===
// 每行：[默认 radio] [名称 input] [text textarea] [× 删除]
// 一个 JD 至多一个默认（radio name 复用 + 选中即同步 hidden defaultGreetTemplateId）

let _currentEditCustomPrompt = null;  // 编辑时缓存 JD 的 customPrompt，保存时一并写回

function makeJdGreetTemplateRow(g, isDefault) {
  const row = document.createElement('div');
  row.className = 'condition-row';
  row.dataset.greetId = g && g.id ? g.id : self.BossJD.genGreetTemplateId();

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'jd-greet-default';
  radio.title = '设为本 JD 的默认话术';
  radio.checked = !!isDefault;
  radio.style.cssText = 'flex:0 0 auto;margin-right:4px;';
  row.appendChild(radio);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = (g && g.name) || '';
  nameInput.placeholder = '话术名（如：寒暄 / 自我介绍）';
  nameInput.style.cssText = 'flex:0 0 35%;';
  row.appendChild(nameInput);

  const textInput = document.createElement('textarea');
  textInput.rows = 2;
  textInput.value = (g && g.text) || '';
  textInput.placeholder = '话术正文（候选人将收到这条独立消息）';
  textInput.style.cssText = 'flex:1;font-family:inherit;font-size:13px;padding:4px 8px;border:1px solid #d0d7de;border-radius:4px;resize:vertical;';
  row.appendChild(textInput);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'condition-del';
  del.textContent = '×';
  del.title = '删除此话术';
  del.addEventListener('click', function () {
    row.parentNode && row.parentNode.removeChild(row);
  });
  row.appendChild(del);

  return row;
}

function renderJdGreetTemplates(greetTemplates, defaultId) {
  const container = $('jd-greet-templates-list');
  container.innerHTML = '';
  const list = (greetTemplates && greetTemplates.length) ? greetTemplates : [];
  if (!list.length) {
    // 默认空 1 行
    container.appendChild(makeJdGreetTemplateRow(null, true));
    return;
  }
  list.forEach(function (g) {
    container.appendChild(makeJdGreetTemplateRow(g, g.id === defaultId));
  });
}

function collectJdGreetTemplates() {
  const container = $('jd-greet-templates-list');
  const rows = container.querySelectorAll('.condition-row');
  const out = [];
  let defaultId = '';
  rows.forEach(function (row) {
    const id = row.dataset.greetId;
    const radio = row.querySelector('input[type="radio"]');
    const inputs = row.querySelectorAll('input[type="text"], textarea');
    const name = inputs[0] ? String(inputs[0].value || '').trim() : '';
    const text = inputs[1] ? String(inputs[1].value || '').trim() : '';
    if (!name && !text) return;  // 全空行跳过
    out.push({ id: id, name: name, text: text });
    if (radio && radio.checked) defaultId = id;
  });
  // 若 HR 没选默认且有话术，自动取首条为默认
  if (!defaultId && out.length) defaultId = out[0].id;
  return { greetTemplates: out, defaultGreetTemplateId: defaultId };
}

function openJDFormForNew() {
  $('jd-form-title').textContent = '新建 JD 模板';
  $('jd-edit-id').value = '';
  $('jd-name').value = '';
  // 默认给 1 个空 must 行 + 1 个空 opt 行让 HR 一眼看到结构
  renderConditionList('must-list', 'M', [{ text: '' }]);
  renderConditionList('opt-list', 'O', [{ text: '' }]);
  $('jd-threshold').value = '0';
  // v0.25.2：默认 1 个空话术行
  renderJdGreetTemplates([], '');
  _currentEditCustomPrompt = null;  // 新建时 customPrompt 默认 null
  $('jd-form-status').textContent = '';
  $('jd-form-status').className = 'test-result';
  $('jd-form').style.display = 'block';
  $('jd-name').focus();
  $('jd-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openJDFormForEdit(jdId) {
  const t = await self.BossJD.getTemplate(jdId);
  if (!t) {
    alert('该 JD 模板不存在或已被删除');
    return;
  }
  $('jd-form-title').textContent = '编辑 JD 模板';
  $('jd-edit-id').value = t.jdId;
  $('jd-name').value = t.name || '';
  renderConditionList('must-list', 'M', t.mustConditions || []);
  renderConditionList('opt-list', 'O', t.optionalConditions || []);
  $('jd-threshold').value = String(t.optionalThreshold || 0);
  // v0.25.2：回显 greetTemplates + customPrompt
  renderJdGreetTemplates(t.greetTemplates || [], t.defaultGreetTemplateId || '');
  _currentEditCustomPrompt = (typeof t.customPrompt === 'string' && t.customPrompt) ? t.customPrompt : null;
  $('jd-form-status').textContent = '';
  $('jd-form-status').className = 'test-result';
  $('jd-form').style.display = 'block';
  $('jd-name').focus();
  $('jd-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeJDForm() {
  $('jd-form').style.display = 'none';
}

// 从当前 JD 表单状态构造 jd 对象（含临时 id，供 PromptBuilder 用）
function buildJdFromForm() {
  const name = $('jd-name').value.trim();
  const must = collectConditions('must-list', 'M')
    .filter(function (c) { return c.text; })
    .map(function (c) { return { id: self.BossJD.genConditionId('must'), text: c.text }; });
  const opt = collectConditions('opt-list', 'O')
    .filter(function (c) { return c.text; })
    .map(function (c) { return { id: self.BossJD.genConditionId('opt'), text: c.text }; });
  const K = parseInt($('jd-threshold').value || '0', 10);
  const greetCollected = collectJdGreetTemplates();
  return {
    jdId: $('jd-edit-id').value || undefined,
    name: name,
    mustConditions: must,
    optionalConditions: opt,
    optionalThreshold: Number.isInteger(K) && K >= 0 ? K : 0,
    // v0.25.2：内嵌话术 + customPrompt
    greetTemplates: greetCollected.greetTemplates,
    defaultGreetTemplateId: greetCollected.defaultGreetTemplateId,
    customPrompt: _currentEditCustomPrompt
  };
}

async function saveJDForm() {
  const tpl = buildJdFromForm();
  if (!tpl.name) {
    $('jd-form-status').textContent = '✗ 名称必填';
    $('jd-form-status').className = 'test-result err';
    $('jd-name').focus();
    return;
  }
  $('btn-jd-save').disabled = true;
  try {
    await self.BossJD.saveTemplate(tpl);  // 数据层做最终校验（≥1 项 / 阈值合法）
    closeJDForm();
    await loadJDList();
    setStatus('✓ JD 已保存', 'ok');
  } catch (e) {
    $('jd-form-status').textContent = '✗ ' + e.message;
    $('jd-form-status').className = 'test-result err';
  } finally {
    $('btn-jd-save').disabled = false;
  }
}

$('btn-jd-new').addEventListener('click', openJDFormForNew);
$('btn-jd-cancel').addEventListener('click', closeJDForm);
$('btn-jd-save').addEventListener('click', saveJDForm);

// 添加必要 / 可选条件行
$('btn-add-must').addEventListener('click', function () {
  const idx = $('must-list').querySelectorAll('.condition-row').length + 1;
  $('must-list').appendChild(makeConditionRow('M', idx));
});
$('btn-add-opt').addEventListener('click', function () {
  const idx = $('opt-list').querySelectorAll('.condition-row').length + 1;
  $('opt-list').appendChild(makeConditionRow('O', idx));
});
// v0.25.1：删添加沟通职位别名行 handler（功能已废弃）

// v0.25.2：添加 JD 内嵌话术模板行
$('btn-add-jd-greet').addEventListener('click', function () {
  $('jd-greet-templates-list').appendChild(makeJdGreetTemplateRow(null, false));
});

// 表单内"预览 prompt" — 从当前表单状态构造临时 jd，不存 storage
$('btn-jd-preview-form').addEventListener('click', function () {
  const tpl = buildJdFromForm();
  if (!tpl.name) tpl.name = '(未命名)';
  let prompt;
  try {
    prompt = self.BossPromptBuilder.build(tpl);
  } catch (e) {
    prompt = '✗ prompt 拼装失败：' + e.message + '\n\n请先在表单里填入至少一项必要或可选条件。';
  }
  openPromptModal('预览 SYSTEM_PROMPT — ' + tpl.name, prompt);
});

// ============ 话术模板管理（v0.17.1.0） ============
// 数据层 self.BossGreetTemplates（lib/greet-templates.js）
// 简单：列表 + 新建/编辑（name + text textarea），无条件结构、无变量

async function loadGreetList() {
  if (!self.BossGreetTemplates) {
    console.warn('[admin] BossGreetTemplates 模块未加载');
    return;
  }
  await self.BossGreetTemplates.ensureSeeded();
  const list = await self.BossGreetTemplates.listTemplates();
  const cur = await self.BossGreetTemplates.getCurrentGreetId();

  const tbody = $('greet-list-body');
  tbody.innerHTML = '';
  if (list.length === 0) {
    $('greet-empty').style.display = 'block';
    $('greet-table').style.display = 'none';
  } else {
    $('greet-empty').style.display = 'none';
    $('greet-table').style.display = '';
    list.forEach(function (t) {
      const preview = (t.text || '').slice(0, 50) + (t.text && t.text.length > 50 ? '…' : '');
      const tr = document.createElement('tr');
      if (t.greetId === cur) tr.classList.add('jd-row-current');
      tr.innerHTML =
        '<td>' + escapeHtml(t.name) + (t.greetId === cur ? ' <span style="color:#00b572">●</span>' : '') + '</td>' +
        '<td>' + escapeHtml(preview) + '</td>' +
        '<td>' + (t.text || '').length + '</td>' +
        '<td class="actions-col">' +
          '<button class="btn-greet-edit" data-id="' + escapeHtml(t.greetId) + '">编辑</button> ' +
          '<button class="btn-greet-del" data-id="' + escapeHtml(t.greetId) + '">删除</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    Array.from(tbody.querySelectorAll('.btn-greet-edit')).forEach(function (btn) {
      btn.addEventListener('click', function () { openGreetFormForEdit(btn.dataset.id); });
    });
    Array.from(tbody.querySelectorAll('.btn-greet-del')).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const t = list.find(function (x) { return x.greetId === btn.dataset.id; });
        if (!t) return;
        if (!confirm('确认删除「' + t.name + '」？\n（不可撤销）')) return;
        await self.BossGreetTemplates.deleteTemplate(t.greetId);
        await loadGreetList();
        setStatus('✓ 话术已删除', 'ok');
      });
    });
  }
}

function openGreetFormForNew() {
  $('greet-form-title').textContent = '新建话术模板';
  $('greet-edit-id').value = '';
  $('greet-name').value = '';
  $('greet-text').value = '';
  updateGreetCharCount();
  $('greet-form-status').textContent = '';
  $('greet-form-status').className = 'test-result';
  $('greet-form').style.display = 'block';
  $('greet-name').focus();
  $('greet-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openGreetFormForEdit(greetId) {
  const t = await self.BossGreetTemplates.getTemplate(greetId);
  if (!t) {
    alert('该话术模板不存在或已被删除');
    return;
  }
  $('greet-form-title').textContent = '编辑话术模板';
  $('greet-edit-id').value = t.greetId;
  $('greet-name').value = t.name || '';
  $('greet-text').value = t.text || '';
  updateGreetCharCount();
  $('greet-form-status').textContent = '';
  $('greet-form-status').className = 'test-result';
  $('greet-form').style.display = 'block';
  $('greet-name').focus();
  $('greet-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeGreetForm() {
  $('greet-form').style.display = 'none';
}

function updateGreetCharCount() {
  const len = ($('greet-text').value || '').trim().length;
  const span = $('greet-char-count');
  if (!span) return;
  span.textContent = len + ' 字符';
  if (len < 5) {
    span.style.color = '#d33';
  } else {
    span.style.color = '#888';
  }
}

async function saveGreetForm() {
  const name = $('greet-name').value.trim();
  const text = $('greet-text').value.trim();
  if (!name) {
    $('greet-form-status').textContent = '✗ 名称必填';
    $('greet-form-status').className = 'test-result err';
    $('greet-name').focus();
    return;
  }
  $('btn-greet-save').disabled = true;
  try {
    await self.BossGreetTemplates.saveTemplate({
      greetId: $('greet-edit-id').value || undefined,
      name: name,
      text: text
    });
    closeGreetForm();
    await loadGreetList();
    setStatus('✓ 话术已保存', 'ok');
  } catch (e) {
    $('greet-form-status').textContent = '✗ ' + e.message;
    $('greet-form-status').className = 'test-result err';
  } finally {
    $('btn-greet-save').disabled = false;
  }
}

// v0.25.2：admin 话术管理 section 删除（话术内嵌 JD），4 个 handler 绑定也撤
//   函数定义 openGreetFormForNew / saveGreetForm / loadGreetList / updateGreetCharCount 保留供调试
//   实际 DOM 元素已不存在，运行时绑定会抛 TypeError（$('btn-greet-new') 返回 null）
// $('btn-greet-new').addEventListener('click', openGreetFormForNew);
// $('btn-greet-cancel').addEventListener('click', closeGreetForm);
// $('btn-greet-save').addEventListener('click', saveGreetForm);
// $('greet-text').addEventListener('input', updateGreetCharCount);

// ============ 预览 prompt（按钮触发） ============
// v0.25.2：加「修改」+「保存自定义」+「恢复默认」按钮（HR 可手工覆盖 prompt-builder 生成的 prompt）
//   修改后保存到 jd.customPrompt；judge.js 评估时优先使用 customPrompt（v0.25.2 已接入）
//   恢复默认 = 清空 jd.customPrompt，下次评估回到 prompt-builder.build(jd)

let _currentPreviewJdId = null;       // 当前预览的 JD ID
let _currentPreviewDefault = '';      // 当前 JD 的 prompt-builder 自动生成版本

async function openPromptPreviewByJdId(jdId) {
  if (!self.BossJD || !self.BossPromptBuilder) {
    alert('依赖模块未加载');
    return;
  }
  const t = await self.BossJD.getTemplate(jdId);
  if (!t) {
    alert('该 JD 模板不存在或已被删除');
    return;
  }
  let defaultPrompt;
  try {
    defaultPrompt = self.BossPromptBuilder.build(t);
  } catch (e) {
    defaultPrompt = '✗ prompt 拼装失败：' + e.message;
  }
  _currentPreviewJdId = jdId;
  _currentPreviewDefault = defaultPrompt;
  // 若 JD 有 customPrompt → 显示 custom 版本 + status 提示
  const showCustom = typeof t.customPrompt === 'string' && t.customPrompt.trim();
  openPromptModal('预览 SYSTEM_PROMPT — ' + (t.name || '未命名'),
                   showCustom ? t.customPrompt : defaultPrompt,
                   !!showCustom);
}

function openPromptModal(title, content, isCustom) {
  $('prompt-modal-title').textContent = title;
  $('prompt-modal-content').textContent = content;
  $('prompt-modal-content').classList.remove('hidden');
  $('prompt-modal-edit').classList.add('hidden');
  $('prompt-modal-edit-toggle').textContent = '修改';
  $('prompt-modal-save').classList.add('hidden');
  // 恢复默认按钮：仅在有自定义时才显示
  if (isCustom) {
    $('prompt-modal-reset').classList.remove('hidden');
    $('prompt-modal-status').textContent = '⚠ 当前显示 HR 自定义版本（已覆盖默认）。点「恢复默认」清空，或「修改」继续编辑。';
    $('prompt-modal-status').style.color = '#b08000';
  } else {
    $('prompt-modal-reset').classList.add('hidden');
    $('prompt-modal-status').textContent = '当前显示自动生成的默认版本。点「修改」可手工编辑后保存覆盖。';
    $('prompt-modal-status').style.color = '#666';
  }
  $('prompt-modal').classList.remove('hidden');
}

function closePromptPreview() {
  $('prompt-modal').classList.add('hidden');
  _currentPreviewJdId = null;
  _currentPreviewDefault = '';
}

$('prompt-modal-close').addEventListener('click', closePromptPreview);
$('prompt-modal').querySelector('.modal-overlay').addEventListener('click', closePromptPreview);
$('prompt-modal-copy').addEventListener('click', async function () {
  // 复制当前显示的内容（自定义 / 默认 / 编辑中的 textarea 都用这个出口）
  const editEl = $('prompt-modal-edit');
  const text = editEl.classList.contains('hidden')
    ? $('prompt-modal-content').textContent
    : editEl.value;
  try {
    await navigator.clipboard.writeText(text);
    $('prompt-modal-copy').textContent = '✓ 已复制';
    setTimeout(function () { $('prompt-modal-copy').textContent = '复制全文'; }, 1500);
  } catch (e) {
    alert('复制失败：' + e.message);
  }
});

// v0.25.2：「修改」按钮 — 切换 pre 显示 / textarea 编辑模式
$('prompt-modal-edit-toggle').addEventListener('click', function () {
  const preEl = $('prompt-modal-content');
  const editEl = $('prompt-modal-edit');
  const saveBtn = $('prompt-modal-save');
  const toggleBtn = $('prompt-modal-edit-toggle');
  if (editEl.classList.contains('hidden')) {
    // 进入编辑模式：把 pre 内容 copy 到 textarea
    editEl.value = preEl.textContent;
    preEl.classList.add('hidden');
    editEl.classList.remove('hidden');
    saveBtn.classList.remove('hidden');
    toggleBtn.textContent = '取消修改';
    $('prompt-modal-status').textContent = '编辑模式：修改后点「保存自定义」写入 JD（评估时将用此版本）。';
    $('prompt-modal-status').style.color = '#2467f0';
  } else {
    // 退出编辑模式（取消）
    preEl.classList.remove('hidden');
    editEl.classList.add('hidden');
    saveBtn.classList.add('hidden');
    toggleBtn.textContent = '修改';
    $('prompt-modal-status').textContent = '已取消编辑（未保存）。';
    $('prompt-modal-status').style.color = '#666';
  }
});

// v0.25.2：「保存自定义」按钮 — 写入 jd.customPrompt
$('prompt-modal-save').addEventListener('click', async function () {
  if (!_currentPreviewJdId) { alert('未选中 JD'); return; }
  const newPrompt = String($('prompt-modal-edit').value || '').trim();
  if (!newPrompt) {
    alert('prompt 不能为空（若要回到默认请点「恢复默认」）');
    return;
  }
  try {
    const t = await self.BossJD.getTemplate(_currentPreviewJdId);
    if (!t) { alert('JD 已被删除'); return; }
    t.customPrompt = newPrompt;
    await self.BossJD.saveTemplate(t);
    $('prompt-modal-status').textContent = '✓ 已保存。下次评估将用此自定义版本。';
    $('prompt-modal-status').style.color = '#2a6f49';
    // 退出编辑模式，显示新内容
    $('prompt-modal-content').textContent = newPrompt;
    $('prompt-modal-content').classList.remove('hidden');
    $('prompt-modal-edit').classList.add('hidden');
    $('prompt-modal-save').classList.add('hidden');
    $('prompt-modal-edit-toggle').textContent = '修改';
    $('prompt-modal-reset').classList.remove('hidden');
  } catch (e) {
    alert('保存失败：' + e.message);
  }
});

// v0.25.2：「恢复默认」按钮 — 清空 jd.customPrompt
$('prompt-modal-reset').addEventListener('click', async function () {
  if (!_currentPreviewJdId) { alert('未选中 JD'); return; }
  if (!confirm('确认恢复默认？\n\n将清空本 JD 的自定义 prompt，下次评估回到自动生成的版本。')) return;
  try {
    const t = await self.BossJD.getTemplate(_currentPreviewJdId);
    if (!t) { alert('JD 已被删除'); return; }
    t.customPrompt = null;
    await self.BossJD.saveTemplate(t);
    $('prompt-modal-content').textContent = _currentPreviewDefault;
    $('prompt-modal-status').textContent = '✓ 已恢复默认。当前显示自动生成版本。';
    $('prompt-modal-status').style.color = '#2a6f49';
    $('prompt-modal-reset').classList.add('hidden');
  } catch (e) {
    alert('恢复失败：' + e.message);
  }
});

// ============ 看板入口（v0.12.3 从 sidepanel 迁移到此） ============
$('btn-open-dashboard').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// ============ 启动 ============
loadAll();
loadJDList();
// v0.25.2：删 loadGreetList 启动调用（话术管理 section 已删）

// ===== v0.17.0：数据导入 / 导出 =====
const DB_NAME = 'boss-sniffer-db';
const DB_VERSION = 5;

function openIDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 防御性 onupgradeneeded：与 lib/fsa-backup.js 一致，兜底建 v5 新 store
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('fsa_state')) {
        db.createObjectStore('fsa_state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('pending_fsa_writes')) {
        const s = db.createObjectStore('pending_fsa_writes', { keyPath: 'month' });
        s.createIndex('enqueuedAt', 'enqueuedAt', { unique: false });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function bulkWrite(db, storeName, items) {
  if (!items || items.length === 0) return Promise.resolve(0);
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let count = 0;
    items.forEach(function (it) {
      if (storeName === 'events') {
        // events 是 autoIncrement id，导入时去掉 id 让其重新分配（避免与现有 id 冲突）
        const copy = Object.assign({}, it);
        delete copy.id;
        store.add(copy);
      } else {
        // evaluations 是 candidateId keyPath，put 自然去重（覆盖同 candidateId 旧记录）
        store.put(it);
      }
      count++;
    });
    tx.oncomplete = function () { resolve(count); };
    tx.onerror = function () { reject(tx.error); };
  });
}

const btnImportBackup = document.getElementById('btn-import-backup');
const btnExportJd = document.getElementById('btn-export-jd');
const btnImportJd = document.getElementById('btn-import-jd');
const fileImportJd = document.getElementById('file-import-jd');
const importResult = document.getElementById('import-result');

if (btnImportBackup) {
  btnImportBackup.onclick = async function () {
    if (!window.showDirectoryPicker) {
      importResult.textContent = '当前浏览器不支持 FSA，无法导入。请用 Chrome / Edge 最新版。';
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read', id: 'boss-sniffer-import' });
      const months = [];
      for await (const entry of handle.values()) {
        if (entry.kind === 'file' && /^\d{4}-\d{2}\.json$/.test(entry.name)) {
          months.push(entry);
        }
      }
      if (months.length === 0) {
        importResult.textContent = '目录里没有 YYYY-MM.json 备份文件';
        return;
      }
      importResult.textContent = '导入中...（' + months.length + ' 个月份）';
      let evalCount = 0, eventCount = 0;
      const db = await openIDB();
      for (let i = 0; i < months.length; i++) {
        const fh = months[i];
        const file = await fh.getFile();
        let data;
        try { data = JSON.parse(await file.text()); }
        catch (e) {
          console.warn('[admin import] 跳过损坏的 ' + fh.name + ':', e.message);
          continue;
        }
        if (Array.isArray(data.evaluations)) {
          evalCount += await bulkWrite(db, 'evaluations', data.evaluations);
        }
        if (Array.isArray(data.events)) {
          eventCount += await bulkWrite(db, 'events', data.events);
        }
      }
      importResult.textContent = '导入完成：' + evalCount + ' 条评估、' + eventCount + ' 条事件';
    } catch (e) {
      if (e.name === 'AbortError') {
        importResult.textContent = '已取消';
      } else {
        importResult.textContent = '导入失败：' + e.message;
      }
    }
  };
}

if (btnExportJd) {
  btnExportJd.onclick = async function () {
    try {
      const r = await self.BossStorageSync.get(['jd_templates', 'current_jd_id']);
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jd-templates-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      importResult.textContent = '已导出 jd-templates-' + new Date().toISOString().slice(0, 10) + '.json';
    } catch (e) {
      importResult.textContent = '导出失败：' + e.message;
    }
  };
}

if (btnImportJd) {
  btnImportJd.onclick = function () { fileImportJd && fileImportJd.click(); };
}
if (fileImportJd) {
  fileImportJd.onchange = async function (e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.jd_templates)) {
        importResult.textContent = 'JSON 格式不对（缺 jd_templates 数组字段）';
        return;
      }
      await self.BossStorageSync.set({ jd_templates: data.jd_templates });
      if (data.current_jd_id) {
        await self.BossStorageSync.set({ current_jd_id: data.current_jd_id });
      }
      importResult.textContent = 'JD 模板导入完成：' + data.jd_templates.length + ' 条';
    } catch (err) {
      importResult.textContent = '导入失败：' + err.message;
    } finally {
      fileImportJd.value = '';  // 允许再次选同一文件
    }
  };
}

// ============ v0.20.0：URL 参数 ?jdId=&scrollTo=O{n} 跳转 ============
// 看板「去 admin 改 ▸」按钮打开此页时，自动打开该 JD 编辑表单 + scroll 到 O_n + flash 高亮
(function setupJdJumpFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const jdId = params.get('jdId');
  const scrollTo = params.get('scrollTo');  // 如 "O1" / "M2"
  if (!jdId) return;

  async function jumpToJd() {
    try {
      // 等 JD list 加载完（loadJdList 是顶层 await 不到的，轮询 .btn-jd-edit 出现）
      let tries = 0;
      while (tries < 40 && !document.querySelector('.btn-jd-edit[data-id="' + jdId + '"]')) {
        await new Promise(function (r) { setTimeout(r, 100); });
        tries++;
      }
      if (typeof openJDFormForEdit !== 'function') {
        console.warn('[Admin] openJDFormForEdit 未就绪，跳过 URL 跳转');
        return;
      }
      await openJDFormForEdit(jdId);

      // 找到 scrollTo 对应的条件行（按 condition-prefix 文本匹配「O1.」/「M2.」）
      if (!scrollTo) return;
      const match = /^([MO])(\d+)$/.exec(scrollTo);
      if (!match) return;
      const prefix = match[1];
      const idx = parseInt(match[2], 10);
      const listId = prefix === 'M' ? 'must-list' : 'opt-list';
      const list = document.getElementById(listId);
      if (!list) return;
      const rows = list.querySelectorAll('.condition-row');
      if (idx < 1 || idx > rows.length) return;
      const targetRow = rows[idx - 1];
      // scroll + 高亮
      setTimeout(function () {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetRow.classList.add('flash-highlight');
        setTimeout(function () { targetRow.classList.remove('flash-highlight'); }, 1600);
      }, 200);
    } catch (e) {
      console.warn('[Admin] URL 跳转失败:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', jumpToJd);
  } else {
    jumpToJd();
  }
})();

// ============ v0.20.6 危险操作（开发调试用） ============
// 来源：sidepanel 删了 btn-clear / btn-clear-eval 之后，开发偶尔仍需清表，迁来 admin。
// 双重 confirm + 状态反馈，避免误点。
(function setupDangerOps() {
  function setStatus(text, color) {
    const el = document.getElementById('danger-op-status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#666';
  }

  async function clearEvaluations() {
    if (!confirm('⚠️ 第 1/2 步：清空 evaluations 表会让看板的「判断/符合/JD 分析/趋势/候选人记录」全部归零（只保留招呼数）。确定继续？')) return;
    if (!confirm('⚠️ 第 2/2 步：操作不可撤销。最后确认要清空 evaluations 表？')) return;
    setStatus('正在清空...', '#666');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_EVALUATIONS' });
      if (resp && resp.ok) {
        setStatus('✅ evaluations 表已清空', '#0a0');
      } else {
        setStatus('❌ 清空失败：' + ((resp && resp.error) || '未知错误'), '#c33');
      }
    } catch (e) {
      setStatus('❌ 调用失败：' + (e && e.message), '#c33');
    }
  }

  async function clearAll() {
    if (!confirm('⚠️ 第 1/3 步：清空全部会让看板所有数据（漏斗/JD 分析/趋势/候选人记录/招呼数）归零。sayhi_pool/话术/JD 模板保留。确定继续？')) return;
    if (!confirm('⚠️ 第 2/3 步：操作不可撤销，无法恢复。再次确认？')) return;
    if (!confirm('⚠️ 第 3/3 步：最后一次确认 — 真的清空 captures + evaluations + events 三个表？')) return;
    setStatus('正在清空...', '#666');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLEAR' });
      if (resp && resp.ok) {
        setStatus('✅ captures + evaluations + events 三表已清空', '#0a0');
      } else {
        setStatus('❌ 清空失败：' + ((resp && resp.error) || '未知错误'), '#c33');
      }
    } catch (e) {
      setStatus('❌ 调用失败：' + (e && e.message), '#c33');
    }
  }

  function bind() {
    const btnEval = document.getElementById('btn-danger-clear-eval');
    const btnAll = document.getElementById('btn-danger-clear-all');
    if (btnEval) btnEval.addEventListener('click', clearEvaluations);
    if (btnAll) btnAll.addEventListener('click', clearAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();

// ============ v0.22.5 · Phase 3·3c 前置：IDB 备份按钮 ============
// HR 可选在 schema 升级前一键导出全 store JSON 作回滚兜底
// 复用 sidepanel diag bundle 的 Blob.click 下载模式
$('btn-export-idb-backup').addEventListener('click', async function () {
  const btn = $('btn-export-idb-backup');
  const status = $('idb-backup-status');
  function setStatus(text, color) {
    if (!status) return;
    status.textContent = text || '';
    status.style.color = color || '#666';
  }
  btn.disabled = true;
  setStatus('⏳ 正在读取 IDB...', '#666');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'EXPORT_IDB_BUNDLE' });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '未知错误');
    const bundle = resp.bundle;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const stamp = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'boss-sniffer-idb-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    const totalRows = Object.keys(bundle.counts || {}).reduce(function (s, k) { return s + (bundle.counts[k] || 0); }, 0);
    setStatus('✅ 已导出 ' + totalRows + ' 行（dbVersion=' + bundle.dbVersion + '）', '#0a0');
  } catch (err) {
    setStatus('❌ 导出失败：' + ((err && err.message) || err), '#c33');
    console.error('[BOSS-Sniffer admin] export IDB backup failed:', err);
  } finally {
    btn.disabled = false;
  }
});
