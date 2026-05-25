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
    // v1.1.10 fix:scanMaxPerRun 1 → 0(0 = 无限),必须跟 background.js 默认值同步。
    // admin UI 已在 v1.0.14 删除,这里只是 deepMerge fallback,但仍是真生效的默认值。
    scanMaxPerRun: 0,
    cooldownMinMs: 5000,
    cooldownMaxMs: 8000,
    // v1.1.12 fix:proactiveFetchEnabled false → true,必须跟 background.js 默认值同步。
    proactiveFetchEnabled: true
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
    type: BossMessageTypes.SET_CONFIG_SECTION,
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
    const r = await chrome.runtime.sendMessage({ type: BossMessageTypes.TEST_LLM_CONFIG, llm: cfg });
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
  const res = await chrome.runtime.sendMessage({ type: BossMessageTypes.GET_CONFIG });
  if (!res || !res.config) {
    setStatus('加载配置失败 — 请检查扩展状态', 'err');
    return;
  }
  loadedConfig = res.config;

  // LLM
  loadedConfig.llm = normalizeLlmSettings(res.config.llm || DEFAULTS.llm);
  renderLlmList();
  closeLlmDrawer();

  // v1.0.14：sayHi / sayHiDom 配置 UI 已删,运行时仍读 chrome.storage.sync(deepMerge + DEFAULTS 兜底)
  //   autoAction 段保留(且新增 hoverDelayMin/MaxMs);actionCooldownMinMs/MaxMs UI 也删,运行时仍读
  const autoAction = res.config.autoAction || DEFAULTS.autoAction;
  $('hover-delay-min').value = autoAction.hoverDelayMinMs != null ? autoAction.hoverDelayMinMs : DEFAULTS.autoAction.hoverDelayMinMs;
  $('hover-delay-max').value = autoAction.hoverDelayMaxMs != null ? autoAction.hoverDelayMaxMs : DEFAULTS.autoAction.hoverDelayMaxMs;

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

// v1.0.14：collectSayHiPatch / collectSayHiDomPatch 已删(UI 移除,storage 旧值不动)
//   collectAutoActionPatch 改为只采 hover delay(其它字段仍在 storage 由 sidepanel 等改)
function collectAutoActionPatch() {
  const hMin = parseInt($('hover-delay-min').value, 10);
  const hMax = parseInt($('hover-delay-max').value, 10);
  const hMinSafe = isNaN(hMin) ? DEFAULTS.autoAction.hoverDelayMinMs : Math.max(0, hMin);
  const hMaxSafe = isNaN(hMax) ? DEFAULTS.autoAction.hoverDelayMaxMs : Math.max(hMinSafe, hMax);
  return {
    hoverDelayMinMs: hMinSafe,
    hoverDelayMaxMs: hMaxSafe
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
    const r = await chrome.runtime.sendMessage({ type: BossMessageTypes.TEST_LLM_CONFIG, llm: llm });
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
    await ensureHostPermissionsForSettings(llmPatch);

    // v1.0.14：sayHi / sayHiDom UI 删除,save 仅保留 llm + autoAction(hover delay)两段
    const autoActionPatch = collectAutoActionPatch();
    const ops = [
      chrome.runtime.sendMessage({ type: BossMessageTypes.SET_CONFIG_SECTION, section: 'llm', patch: llmPatch }),
      chrome.runtime.sendMessage({ type: BossMessageTypes.SET_CONFIG_SECTION, section: 'autoAction', patch: autoActionPatch })
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
  if (!confirm('确认把 LLM 和 hover 时序配置重置为默认？\n（已保存的 API Key 不会被清除，需要单独清空 input 后保存）')) return;
  loadedConfig.llm = normalizeLlmSettings(DEFAULTS.llm);
  renderLlmList();
  closeLlmDrawer();
  // v1.0.14：sayHi / sayHiDom / autoAction.cooldown 三段 UI 已删,reset 仅恢复 hover delay
  $('hover-delay-min').value = DEFAULTS.autoAction.hoverDelayMinMs;
  $('hover-delay-max').value = DEFAULTS.autoAction.hoverDelayMaxMs;
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

// ============ v1.0.14：PoC 调试工具整段删（已包到沟通页 DOM 扫描 UI 折叠区下,UI 删除则 handler 一同删）
//   原有 4 个 handler:btn-find-tab / btn-test-debugger / btn-test-sayhi / btn-diagnose-dom
//   对应消息 type FIND_BOSS_TAB / TEST_DEBUGGER_ATTACH / TEST_SAYHI / TEST_DIAGNOSE_DOM
//   background.js message-router 端 handler 保留(供未来调试/sidepanel 诊断用),admin UI 不再触发。
//   原始代码可从 git log 找回(commit a4c292a 前后)。

// (PoC 调试工具 handler 整段已删除 v1.0.14)

// ============ JD 模板管理（v1.1.23 P3-4：BOSS 岗位树形结构） ============
// 数据层:
//   - self.BossPositions (lib/boss-positions.js):岗位 CRUD + 嵌套查询 + 拖拽排序
//   - self.BossJD (lib/jd-templates.js):模板 CRUD + cloneTemplate
// UI 层在此
//   - 顶层 #position-tree 渲染岗位卡片树
//   - 每个岗位卡片头:折叠箭头 / 岗位名 / 模板计数 / 改名 / 加模板 / 删岗位 / 拖拽手柄
//   - 每个模板行:模板名 / 预览 / 复制(同岗位)/ 编辑 / 删除 / 拖拽手柄
//   - 拖拽:HTML5 原生 drag-drop;岗位间排序、模板在岗位内排序;**不跨岗位**
//   - 复制:cloneTemplate(sourceId) 后,把源岗位 positionId 写到副本上再 saveTemplate

const escapeHtml = window.BossUiUtils.escapeHtml; // v1.1.22 提到 lib/ui-utils.js

// 内存里维护折叠态(positionId → 是否展开),re-render 后保留
// 默认所有岗位展开;HR 点折叠箭头时切到 collapsed
const _positionCollapsed = Object.create(null);

// 当前编辑 JD 表单的 positionId(新建模板时由"+ 添加模板"按钮注入)
let _editingPositionId = '';

async function loadJDList() {
  if (!self.BossPositions || !self.BossJD) {
    console.warn('[admin] BossPositions / BossJD 模块未加载');
    return;
  }
  await self.BossPositions.ensureSeeded();
  const grouped = await self.BossPositions.listPositionsWithTemplates();
  const cur = await self.BossJD.getCurrentJdId();

  const tree = $('position-tree');
  tree.innerHTML = '';

  if (grouped.length === 0) {
    $('position-empty').style.display = 'block';
    return;
  }
  $('position-empty').style.display = 'none';

  grouped.forEach(function (g) {
    tree.appendChild(renderPositionCard(g.position, g.templates, cur));
  });
}

function renderPositionCard(position, templates, currentJdId) {
  const card = document.createElement('div');
  card.className = 'position-card';
  card.dataset.positionId = position.positionId;
  card.draggable = true;
  if (_positionCollapsed[position.positionId]) {
    card.classList.add('collapsed');
  }

  // 卡片头
  const header = document.createElement('div');
  header.className = 'position-card-header';

  const toggle = document.createElement('span');
  toggle.className = 'position-toggle';
  toggle.textContent = '▼';

  const nameEl = document.createElement('div');
  nameEl.className = 'position-name';
  const countText = templates.length === 0 ? '空' : (templates.length + ' 个模板');
  nameEl.innerHTML = escapeHtml(position.name) + '<span class="position-template-count">(' + countText + ')</span>';

  const actions = document.createElement('div');
  actions.className = 'position-actions';
  actions.innerHTML =
    '<button class="btn-rename-position" data-id="' + escapeHtml(position.positionId) + '">改名</button>' +
    '<button class="btn-add-template" data-id="' + escapeHtml(position.positionId) + '">+ 添加模板</button>' +
    '<button class="btn-del-position" data-id="' + escapeHtml(position.positionId) + '">删除岗位</button>' +
    '<span class="position-drag-handle" title="拖拽调整岗位顺序">⋮⋮</span>';

  header.appendChild(toggle);
  header.appendChild(nameEl);
  header.appendChild(actions);

  // 头部点击 = 折叠 / 展开;点 actions 内按钮 stop propagation
  header.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('.position-drag-handle')) return;
    card.classList.toggle('collapsed');
    _positionCollapsed[position.positionId] = card.classList.contains('collapsed');
  });

  // 改名
  header.querySelector('.btn-rename-position').addEventListener('click', function (e) {
    e.stopPropagation();
    renamePosition(position);
  });
  // 加模板(打开 JD 表单,positionId 已注入)
  header.querySelector('.btn-add-template').addEventListener('click', function (e) {
    e.stopPropagation();
    openJDFormForNew(position.positionId);
  });
  // 删岗位
  header.querySelector('.btn-del-position').addEventListener('click', function (e) {
    e.stopPropagation();
    deletePosition(position, templates.length);
  });

  card.appendChild(header);

  // 卡片体
  const body = document.createElement('div');
  body.className = 'position-card-body';
  if (templates.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'position-empty-templates';
    hint.textContent = '该岗位下还没有模板。点上方「+ 添加模板」新建。';
    body.appendChild(hint);
  } else {
    templates.forEach(function (t) {
      body.appendChild(renderTemplateRow(t, position.positionId, currentJdId));
    });
  }
  card.appendChild(body);

  // 岗位卡片拖拽事件(岗位间排序)
  attachPositionDragHandlers(card);

  return card;
}

function renderTemplateRow(template, positionId, currentJdId) {
  const row = document.createElement('div');
  row.className = 'template-row';
  row.dataset.templateId = template.jdId;
  row.dataset.positionId = positionId;
  row.draggable = true;
  if (template.jdId === currentJdId) row.classList.add('is-current');

  const nameEl = document.createElement('div');
  nameEl.className = 'template-name';
  nameEl.textContent = template.name || '(未命名)';

  const actions = document.createElement('div');
  actions.className = 'template-actions';
  // 按钮顺序:预览 / 复制 / 编辑 / 删除(沿用 v1.1.22 P2-7 视线扫描顺序)
  actions.innerHTML =
    '<button class="btn-tpl-preview" data-id="' + escapeHtml(template.jdId) + '">预览</button>' +
    '<button class="btn-tpl-clone" data-id="' + escapeHtml(template.jdId) + '">复制</button>' +
    '<button class="btn-tpl-edit" data-id="' + escapeHtml(template.jdId) + '">编辑</button>' +
    '<button class="btn-tpl-del btn-del-template" data-id="' + escapeHtml(template.jdId) + '">删除</button>' +
    '<span class="template-drag-handle" title="拖拽调整模板顺序">⋮⋮</span>';

  row.appendChild(nameEl);
  row.appendChild(actions);

  // 按钮 handler
  actions.querySelector('.btn-tpl-preview').addEventListener('click', function () {
    openPromptPreviewByJdId(template.jdId);
  });
  actions.querySelector('.btn-tpl-clone').addEventListener('click', async function (e) {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      // 1) cloneTemplate 复制评估字段(不含 positionId — lib 层显式拷贝白名单)
      const newJd = await self.BossJD.cloneTemplate(template.jdId);
      // 2) 补一刀:把源 positionId 写到副本上,再 saveTemplate 整体回写(merge 安全)
      //    这是"补 positionId"那一刀 — 是一次 saveTemplate 调用,不是两次独立写,
      //    满足任务约束(避免两次完全独立 save 破坏 contentHash / updatedAt)
      newJd.positionId = positionId;
      await self.BossJD.saveTemplate(newJd);
      await loadJDList();
      openJDFormForEdit(newJd.jdId);
      setStatus('✓ 已复制为「' + newJd.name + '」', 'ok');
    } catch (err) {
      btn.disabled = false;
      setStatus('✗ 复制失败:' + (err.message || err), 'err');
    }
  });
  actions.querySelector('.btn-tpl-edit').addEventListener('click', function () {
    openJDFormForEdit(template.jdId);
  });
  actions.querySelector('.btn-tpl-del').addEventListener('click', async function () {
    if (!confirm('确认删除模板「' + (template.name || '未命名') + '」?\n(不可撤销)')) return;
    await self.BossJD.deleteTemplate(template.jdId);
    await loadJDList();
    setStatus('✓ 模板已删除', 'ok');
  });

  // 模板行拖拽事件(同岗位内排序)
  attachTemplateDragHandlers(row);

  return row;
}

// ============ 岗位 CRUD ============
async function createNewPosition() {
  const name = prompt('新岗位名称(对应 BOSS 端发的招聘职位名,沟通页按此与候选人 jobAligned 严格相等匹配):');
  if (name === null) return;
  const trimmed = String(name).trim();
  if (!trimmed) {
    alert('岗位名不能为空');
    return;
  }
  try {
    const saved = await self.BossPositions.savePosition({ name: trimmed });
    // 新建岗位默认展开
    _positionCollapsed[saved.positionId] = false;
    await loadJDList();
    setStatus('✓ 岗位「' + trimmed + '」已创建', 'ok');
  } catch (e) {
    setStatus('✗ 创建岗位失败:' + (e.message || e), 'err');
  }
}

async function renamePosition(position) {
  const next = prompt('修改岗位名(原: ' + position.name + ')', position.name);
  if (next === null) return;
  const trimmed = String(next).trim();
  if (!trimmed) {
    alert('岗位名不能为空');
    return;
  }
  if (trimmed === position.name) return;
  try {
    await self.BossPositions.savePosition({
      positionId: position.positionId,
      name: trimmed
    });
    await loadJDList();
    setStatus('✓ 岗位已改名为「' + trimmed + '」', 'ok');
  } catch (e) {
    setStatus('✗ 改名失败:' + (e.message || e), 'err');
  }
}

async function deletePosition(position, templateCount) {
  const msg = templateCount > 0
    ? '确认删除岗位「' + position.name + '」?\n' +
      '⚠️ 会级联删除该岗位下 ' + templateCount + ' 个模板,所有相关筛选条件、话术、自定义 prompt 一同丢失。\n(不可撤销)'
    : '确认删除岗位「' + position.name + '」?(该岗位下无模板)';
  if (!confirm(msg)) return;
  if (templateCount > 0) {
    // 二次确认 — 有模板的岗位删除影响大
    if (!confirm('再次确认:删除岗位「' + position.name + '」 + ' + templateCount + ' 个模板?')) return;
  }
  try {
    const r = await self.BossPositions.deletePosition(position.positionId, { cascade: true });
    await loadJDList();
    setStatus('✓ 已删除岗位「' + position.name + '」,级联删除 ' + r.deletedTemplatesCount + ' 个模板', 'ok');
  } catch (e) {
    setStatus('✗ 删除岗位失败:' + (e.message || e), 'err');
  }
}

// ============ 拖拽排序(HTML5 原生)============
// 设计:
//   - 岗位卡片之间拖拽 → 调 BossPositions.reorderPositions(orderedIds)
//   - 模板行在同一岗位内拖拽 → 调 BossPositions.reorderTemplatesInPosition(positionId, orderedIds)
//   - 不允许跨岗位拖模板(dragenter 时若 srcPositionId !== thisPositionId 直接 reject)
//   - 视觉:dragging 元素半透明;drop target 上下边显示蓝色横线(drag-over-top / drag-over-bottom)

let _dragSource = null;       // { type: 'position'|'template', id, positionId? }

function clearDragOverClasses(root) {
  Array.from(root.querySelectorAll('.drag-over-top, .drag-over-bottom')).forEach(function (el) {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
}

function attachPositionDragHandlers(card) {
  card.addEventListener('dragstart', function (e) {
    // 只允许通过 handle 或 header 起拖;但模板行有自己的 dragstart 也会冒泡上来 — 用 srcElement 判断
    if (e.target.closest('.template-row')) return;
    _dragSource = { type: 'position', id: card.dataset.positionId };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.positionId); } catch (_) {}
    e.stopPropagation();
  });
  card.addEventListener('dragend', function () {
    card.classList.remove('dragging');
    _dragSource = null;
    clearDragOverClasses($('position-tree'));
  });
  card.addEventListener('dragover', function (e) {
    if (!_dragSource || _dragSource.type !== 'position') return;
    if (_dragSource.id === card.dataset.positionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    card.classList.toggle('drag-over-top', isAbove);
    card.classList.toggle('drag-over-bottom', !isAbove);
  });
  card.addEventListener('dragleave', function (e) {
    // 离开本卡片范围才清(否则进入子元素也会触发 leave)
    if (!card.contains(e.relatedTarget)) {
      card.classList.remove('drag-over-top', 'drag-over-bottom');
    }
  });
  card.addEventListener('drop', async function (e) {
    if (!_dragSource || _dragSource.type !== 'position') return;
    if (_dragSource.id === card.dataset.positionId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = card.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    const sourceId = _dragSource.id;
    const targetId = card.dataset.positionId;
    card.classList.remove('drag-over-top', 'drag-over-bottom');
    await applyPositionReorder(sourceId, targetId, isAbove);
  });
}

async function applyPositionReorder(sourceId, targetId, insertBefore) {
  const tree = $('position-tree');
  const cards = Array.from(tree.querySelectorAll('.position-card'));
  const ids = cards.map(function (c) { return c.dataset.positionId; });
  const srcIdx = ids.indexOf(sourceId);
  if (srcIdx === -1) return;
  ids.splice(srcIdx, 1);
  let tgtIdx = ids.indexOf(targetId);
  if (tgtIdx === -1) return;
  if (!insertBefore) tgtIdx++;
  ids.splice(tgtIdx, 0, sourceId);
  try {
    await self.BossPositions.reorderPositions(ids);
    await loadJDList();
  } catch (e) {
    setStatus('✗ 岗位排序保存失败:' + (e.message || e), 'err');
  }
}

function attachTemplateDragHandlers(row) {
  row.addEventListener('dragstart', function (e) {
    _dragSource = {
      type: 'template',
      id: row.dataset.templateId,
      positionId: row.dataset.positionId
    };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', row.dataset.templateId); } catch (_) {}
    e.stopPropagation();  // 别冒泡触发外层 position-card 的 dragstart
  });
  row.addEventListener('dragend', function () {
    row.classList.remove('dragging');
    _dragSource = null;
    clearDragOverClasses($('position-tree'));
  });
  row.addEventListener('dragover', function (e) {
    if (!_dragSource || _dragSource.type !== 'template') return;
    // 不允许跨岗位拖
    if (_dragSource.positionId !== row.dataset.positionId) return;
    if (_dragSource.id === row.dataset.templateId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle('drag-over-top', isAbove);
    row.classList.toggle('drag-over-bottom', !isAbove);
  });
  row.addEventListener('dragleave', function (e) {
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    }
  });
  row.addEventListener('drop', async function (e) {
    if (!_dragSource || _dragSource.type !== 'template') return;
    if (_dragSource.positionId !== row.dataset.positionId) return;
    if (_dragSource.id === row.dataset.templateId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;
    const sourceId = _dragSource.id;
    const targetId = row.dataset.templateId;
    const positionId = row.dataset.positionId;
    row.classList.remove('drag-over-top', 'drag-over-bottom');
    await applyTemplateReorder(positionId, sourceId, targetId, isAbove);
  });
}

async function applyTemplateReorder(positionId, sourceId, targetId, insertBefore) {
  // 从当前 DOM 抓该 position 下所有模板行的 templateId 顺序
  const card = $('position-tree').querySelector('.position-card[data-position-id="' + positionId + '"]');
  if (!card) return;
  const rows = Array.from(card.querySelectorAll('.template-row'));
  const ids = rows.map(function (r) { return r.dataset.templateId; });
  const srcIdx = ids.indexOf(sourceId);
  if (srcIdx === -1) return;
  ids.splice(srcIdx, 1);
  let tgtIdx = ids.indexOf(targetId);
  if (tgtIdx === -1) return;
  if (!insertBefore) tgtIdx++;
  ids.splice(tgtIdx, 0, sourceId);
  try {
    await self.BossPositions.reorderTemplatesInPosition(positionId, ids);
    await loadJDList();
  } catch (e) {
    setStatus('✗ 模板排序保存失败:' + (e.message || e), 'err');
  }
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

function openJDFormForNew(positionId) {
  // v1.1.23 P3-4:positionId 是从"+ 添加模板"按钮注入的,标记当前编辑模板归属哪个岗位
  // 表单保存(saveJDForm)时通过 _editingPositionId 写到 template.positionId
  _editingPositionId = positionId || '';
  $('jd-form-title').textContent = '新建 JD 模板';
  $('jd-edit-id').value = '';
  $('jd-name').value = '';
  // 默认给 1 个空 must 行 + 1 个空 opt 行让 HR 一眼看到结构
  renderConditionList('must-list', 'M', [{ text: '' }]);
  renderConditionList('opt-list', 'O', [{ text: '' }]);
  $('jd-threshold').value = '0';
  // v1.1.15:新建 JD 默认带 1 条招呼语(HR 可改 / 删)。
  //   原 v0.25.2 默认空话术,HR 需手填才能用 autoGreet,导致刚建完 JD autoGreet 一直走 skip。
  const defaultGreet = (self.BossJD && typeof self.BossJD.buildDefaultGreetTemplate === 'function')
    ? self.BossJD.buildDefaultGreetTemplate()
    : null;
  if (defaultGreet) {
    renderJdGreetTemplates([defaultGreet], defaultGreet.id);
  } else {
    renderJdGreetTemplates([], '');
  }
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
  // v1.1.23 P3-4:编辑现有模板时把它的 positionId 记下,保存时回写(保留岗位归属)
  _editingPositionId = t.positionId || '';
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
  _editingPositionId = '';  // v1.1.23 P3-4:清岗位归属缓存
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
    // v1.1.23 P3-4:写入岗位归属 — 新建从"+ 添加模板"入口拿 positionId,编辑沿用既有
    positionId: _editingPositionId || undefined,
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

// v1.1.23 P3-4:全局"新建 JD"入口删除,改为每个岗位卡片的"+ 添加模板"按钮
//   全局新建岗位入口仍在 — 通过 #btn-position-new 触发
$('btn-position-new').addEventListener('click', createNewPosition);
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

// ===== 数据导入 / 导出（v1.0.3：FSA 备份导入已删，仅留 JD 模板导入导出）=====
const btnExportJd = document.getElementById('btn-export-jd');
const btnImportJd = document.getElementById('btn-import-jd');
const fileImportJd = document.getElementById('file-import-jd');
const importResult = document.getElementById('import-result');

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
      // v1.1.23 P3-4:旧 .btn-jd-edit 改为 .btn-tpl-edit(模板行按钮新 class)
      // 等岗位树加载完成
      let tries = 0;
      while (tries < 40 && !document.querySelector('.btn-tpl-edit[data-id="' + jdId + '"]')) {
        await new Promise(function (r) { setTimeout(r, 100); });
        tries++;
      }
      if (typeof openJDFormForEdit !== 'function') {
        console.warn('[Admin] openJDFormForEdit 未就绪,跳过 URL 跳转');
        return;
      }
      // 确保对应岗位卡片是展开的(否则编辑按钮虽在 DOM 但不可见,不影响逻辑)
      const targetBtn = document.querySelector('.btn-tpl-edit[data-id="' + jdId + '"]');
      if (targetBtn) {
        const card = targetBtn.closest('.position-card');
        if (card && card.classList.contains('collapsed')) {
          card.classList.remove('collapsed');
          if (card.dataset.positionId) _positionCollapsed[card.dataset.positionId] = false;
        }
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
      const resp = await chrome.runtime.sendMessage({ type: BossMessageTypes.CLEAR_EVALUATIONS });
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
      const resp = await chrome.runtime.sendMessage({ type: BossMessageTypes.CLEAR });
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

// v1.0.14：「📦 导出 IDB 备份 JSON」按钮 + handler 已删（灾备走重装 + chrome.storage.sync 平台同步）
// background.js 端 EXPORT_IDB_BUNDLE message handler 保留（供未来诊断包扩展用），admin UI 不再触发。
