// BOSS Sniffer - llm-client.js
// Unified LLM client for Anthropic Messages and OpenAI-compatible Chat Completions.
//
// Input config:
// {
//   id, name, providerName,
//   protocol: 'anthropic-messages' | 'openai-chat',
//   apiKey, authType, baseUrl, model, concurrency
// }

(function (global) {
  'use strict';

  const ANTHROPIC_VERSION = '2023-06-01';
  const PROTOCOL_ANTHROPIC = 'anthropic-messages';
  const PROTOCOL_OPENAI_CHAT = 'openai-chat';
  const DEFAULT_MAX_TOKENS = 2048;
  // 单请求超时 30s。配合 judge.js 最多 3 次重试 + 1s/2s 退避,
  // worst case 评估单候选人 ≈ 30*3 + 3 = 93s,从 v0.17.0.7 之前 187s 降到一半。
  // 实测 Wiz 代理 P95 < 15s、Anthropic 直连 P95 < 10s,30s 足够覆盖正常路径。
  const DEFAULT_TIMEOUT_MS = 30000;
  const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
  const DEFAULT_CONCURRENCY = 5;

  function err(name, message, extras) {
    const e = new Error(message);
    e.name = name;
    if (extras) Object.assign(e, extras);
    return e;
  }

  function clampConcurrency(value) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return DEFAULT_CONCURRENCY;
    return Math.max(1, Math.min(15, n));
  }

  function inferProviderName(cfg) {
    const s = String((cfg && (cfg.providerName || cfg.provider || cfg.baseUrl || cfg.model)) || '').toLowerCase();
    if (s.indexOf('anthropic') !== -1 || s.indexOf('claude') !== -1) return 'Anthropic';
    if (s.indexOf('deepseek') !== -1) return 'DeepSeek';
    if (s.indexOf('dashscope') !== -1 || s.indexOf('qwen') !== -1 || s.indexOf('aliyun') !== -1) return '通义千问';
    if (s.indexOf('moonshot') !== -1 || s.indexOf('kimi') !== -1) return 'Kimi';
    if (s.indexOf('openrouter') !== -1) return 'OpenRouter';
    if (s.indexOf('openai') !== -1 || s.indexOf('gpt') !== -1) return 'OpenAI';
    return '自定义厂商';
  }

  function inferProtocol(cfg) {
    const raw = String((cfg && cfg.protocol) || '').trim();
    if (raw === PROTOCOL_ANTHROPIC || raw === 'anthropic' || raw === 'claude') return PROTOCOL_ANTHROPIC;
    if (raw === PROTOCOL_OPENAI_CHAT || raw === 'openai' || raw === 'openai-compatible') return PROTOCOL_OPENAI_CHAT;
    const provider = inferProviderName(cfg);
    const model = String((cfg && (cfg.model || cfg.modelId)) || '').toLowerCase();
    return provider === 'Anthropic' || model.indexOf('claude') !== -1
      ? PROTOCOL_ANTHROPIC
      : PROTOCOL_OPENAI_CHAT;
  }

  function defaultBaseUrl(protocol) {
    return protocol === PROTOCOL_ANTHROPIC ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  }

  function defaultAuthType(protocol) {
    return protocol === PROTOCOL_ANTHROPIC ? 'x-api-key' : 'bearer';
  }

  function makeId(prefix) {
    const random = (global.crypto && global.crypto.getRandomValues)
      ? global.crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
      : Math.floor(Math.random() * 1e9).toString(36);
    return prefix + '_' + Date.now() + '_' + random;
  }

  function normalizeConfig(cfg, index) {
    const raw = cfg || {};
    const protocol = inferProtocol(raw);
    const model = String(raw.model || raw.modelId || '').trim();
    const providerName = String(raw.providerName || raw.provider || inferProviderName(raw)).trim() || '自定义厂商';
    const id = String(raw.id || (index === 0 && raw.__legacy ? 'legacy-llm' : makeId('llm'))).trim();
    const name = String(raw.name || (providerName + (model ? ' · ' + model : ''))).trim();
    return {
      id: id,
      name: name,
      providerName: providerName,
      protocol: protocol,
      baseUrl: String(raw.baseUrl || defaultBaseUrl(protocol)).trim(),
      authType: String(raw.authType || defaultAuthType(protocol)).trim(),
      apiKey: String(raw.apiKey || '').trim(),
      model: model,
      concurrency: clampConcurrency(raw.concurrency)
    };
  }

  function normalizeLlmSettings(input) {
    const raw = input || {};
    let configs;
    if (Array.isArray(raw.configs)) {
      configs = raw.configs.map(function (cfg, i) { return normalizeConfig(cfg, i); });
    } else if (raw.baseUrl || raw.apiKey || raw.model || raw.modelId) {
      configs = [normalizeConfig(Object.assign({}, raw, { __legacy: true }), 0)];
    } else {
      configs = [];
    }

    const ids = configs.map(function (cfg) { return cfg.id; });
    const currentId = ids.indexOf(raw.currentId) !== -1
      ? raw.currentId
      : (ids.indexOf(raw.currentLlmId) !== -1 ? raw.currentLlmId : (ids[0] || ''));

    return {
      currentId: currentId,
      configs: configs
    };
  }

  function getCurrentLlmConfig(settings) {
    const normalized = normalizeLlmSettings(settings);
    if (!normalized.configs.length) return null;
    return normalized.configs.find(function (cfg) { return cfg.id === normalized.currentId; }) || normalized.configs[0];
  }

  function stripTrailingSlashAndV1(baseUrl) {
    let s = String(baseUrl || '').trim() || DEFAULT_ANTHROPIC_BASE_URL;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/v1$/, '');
    return s;
  }

  function buildMessagesUrl(baseUrl) {
    return stripTrailingSlashAndV1(baseUrl || DEFAULT_ANTHROPIC_BASE_URL) + '/v1/messages';
  }

  function buildChatCompletionsUrl(baseUrl) {
    let s = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim();
    s = s.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(s)) return s;
    if (/\/v1$/.test(s)) return s + '/chat/completions';
    return s + '/v1/chat/completions';
  }

  function getHostPermissionPattern(baseUrl) {
    try {
      const u = new URL(String(baseUrl || '').trim());
      return u.origin + '/*';
    } catch (_e) {
      return '';
    }
  }

  function withTimeoutSignal(timeoutMs, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    if (externalSignal) {
      externalSignal.addEventListener('abort', function () { ctrl.abort(); });
    }
    return {
      signal: ctrl.signal,
      clear: function () { clearTimeout(timer); }
    };
  }

  async function readJsonResponse(resp, label) {
    if (!resp.ok) {
      let errBody = '';
      try { errBody = await resp.text(); } catch (_e) {}
      throw err('LLMHttpError', label + ' HTTP ' + resp.status + ' ' + resp.statusText, {
        status: resp.status,
        body: errBody
      });
    }
    try {
      return await resp.json();
    } catch (_e) {
      throw err('LLMResponseError', label + ' 响应不是合法 JSON');
    }
  }

  async function fetchJson(url, headers, body, timeoutMs, signal, label) {
    const timeout = withTimeoutSignal(timeoutMs, signal);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: timeout.signal
      });
      timeout.clear();
      return await readJsonResponse(resp, label);
    } catch (e) {
      timeout.clear();
      if (e.name === 'AbortError') {
        throw err('LLMHttpError', label + ' 请求超时（' + timeoutMs + 'ms）');
      }
      if (e.name === 'LLMHttpError' || e.name === 'LLMResponseError') throw e;
      throw err('LLMHttpError', label + ' 网络错误：' + (e.message || String(e)));
    }
  }

  async function callAnthropicMessages(config, payload) {
    const cfg = config || {};
    const req = payload || {};
    const apiKey = cfg.apiKey;
    const model = cfg.model || cfg.modelId;
    const authType = cfg.authType || defaultAuthType(PROTOCOL_ANTHROPIC);
    const timeoutMs = req.timeoutMs || cfg.timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!apiKey) throw err('LLMConfigError', '未配置 LLM API Key / Token');
    if (!model) throw err('LLMConfigError', '未配置 LLM Model');

    const system = req.system || cfg.system || '';
    const systemBlocks = (req.disableCache || cfg.disableCache)
      ? system
      : [{
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' }
        }];
    const body = {
      model: model,
      max_tokens: req.maxTokens || cfg.maxTokens || DEFAULT_MAX_TOKENS,
      system: systemBlocks,
      messages: [
        { role: 'user', content: req.user || cfg.user || '' },
        // v0.17.0.10 防"输出不含 JSON 对象"失败：assistant 预填 `{` 强制 LLM 从 JSON 起头续写
        // Anthropic Messages API 官方推荐做法。API 返回 content 不含预填部分，所以下面要拼回
        { role: 'assistant', content: '{' }
      ]
    };
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (authType === 'bearer') {
      headers.Authorization = 'Bearer ' + apiKey;
    } else {
      headers['x-api-key'] = apiKey;
    }

    const json = await fetchJson(
      buildMessagesUrl(cfg.baseUrl),
      headers,
      body,
      timeoutMs,
      req.signal || cfg.signal,
      'Anthropic'
    );

    const content = json && json.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw err('LLMResponseError', 'Anthropic 响应无 content 字段');
    }
    const textPart = content.find(function (p) { return p && p.type === 'text'; });
    if (!textPart || !textPart.text) {
      throw err('LLMResponseError', 'Anthropic 响应无 text 内容');
    }
    // v0.17.0.10 把 assistant 预填的 `{` 拼回 LLM 输出最前面（API 返回的 content 不含预填部分）
    // 防御式判断：若 LLM 已经自带 `{` 起头（厂商未来若改变行为），不重复拼
    const rawText = textPart.text;
    const text = rawText.charAt(0) === '{' ? rawText : '{' + rawText;
    return {
      text: text,
      stopReason: json.stop_reason || null,
      usage: json.usage || null
    };
  }

  async function callOpenAIChatCompletions(config, payload) {
    const cfg = config || {};
    const req = payload || {};
    const apiKey = cfg.apiKey;
    const model = cfg.model || cfg.modelId;
    const authType = cfg.authType || defaultAuthType(PROTOCOL_OPENAI_CHAT);
    const timeoutMs = req.timeoutMs || cfg.timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!apiKey) throw err('LLMConfigError', '未配置 LLM API Key / Token');
    if (!model) throw err('LLMConfigError', '未配置 LLM Model');

    const headers = { 'Content-Type': 'application/json' };
    if (authType === 'x-api-key') {
      headers['x-api-key'] = apiKey;
    } else {
      headers.Authorization = 'Bearer ' + apiKey;
    }
    const messages = [];
    if (req.system || cfg.system) messages.push({ role: 'system', content: req.system || cfg.system || '' });
    messages.push({ role: 'user', content: req.user || cfg.user || '' });
    const body = {
      model: model,
      messages: messages,
      max_tokens: req.maxTokens || cfg.maxTokens || DEFAULT_MAX_TOKENS
    };

    const json = await fetchJson(
      buildChatCompletionsUrl(cfg.baseUrl),
      headers,
      body,
      timeoutMs,
      req.signal || cfg.signal,
      'OpenAI-compatible'
    );

    const choice = json && Array.isArray(json.choices) && json.choices[0];
    const message = choice && choice.message;
    // v0.17.0.4：DeepSeek-reasoner / V4 thinking mode 会先输出 reasoning_content（CoT），
    // 然后才输出 content。max_tokens 太小时 thinking 还没结束就截断 → content 为空。
    // 容错：content 空时退回 reasoning_content（思考过程也算回应，对"测试连接"足够）
    let content = message && message.content;
    if (!content && message && message.reasoning_content) {
      content = message.reasoning_content;
    }
    if (!content) {
      const fr = choice && choice.finish_reason;
      let snapshot = '';
      try { snapshot = JSON.stringify(message || choice || json).slice(0, 200); } catch (_e) {}
      throw err('LLMResponseError',
        'OpenAI-compatible 响应缺 content（finish_reason=' + (fr || '?') +
        '）。若 finish_reason=length 说明 max_tokens 太小被截断；snapshot=' + snapshot);
    }
    return {
      text: content,
      stopReason: choice.finish_reason || null,
      usage: json.usage || null
    };
  }

  async function callLlm(config, payload) {
    const cfg = normalizeConfig(config || {}, 0);
    if (cfg.protocol === PROTOCOL_ANTHROPIC) {
      return callAnthropicMessages(cfg, payload);
    }
    return callOpenAIChatCompletions(cfg, payload);
  }

  function stripCommentsAndTrailingCommas(json) {
    let out = '';
    let i = 0;
    let inStr = false;
    let escape = false;
    while (i < json.length) {
      const ch = json[i];
      if (escape) { out += ch; escape = false; i++; continue; }
      if (ch === '\\' && inStr) { out += ch; escape = true; i++; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; i++; continue; }
      if (inStr) { out += ch; i++; continue; }
      if (ch === '/' && json.charAt(i + 1) === '/') {
        while (i < json.length && json.charAt(i) !== '\n') i++;
        continue;
      }
      if (ch === '/' && json.charAt(i + 1) === '*') {
        i += 2;
        while (i < json.length - 1 && !(json.charAt(i) === '*' && json.charAt(i + 1) === '/')) i++;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  function parseJsonOutput(text) {
    if (text === null || text === undefined) {
      throw err('LLMResponseError', 'LLM 输出为空');
    }
    const s = String(text).trim();
    let candidate = s;
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) candidate = fenceMatch[1].trim();

    if (candidate.charAt(0) !== '{') {
      const start = candidate.indexOf('{');
      if (start === -1) {
        throw err('LLMResponseError', 'LLM 输出不含 JSON 对象', { rawText: s });
      }
      let depth = 0;
      let end = -1;
      let inStr = false;
      let escape = false;
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate.charAt(i);
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) {
        throw err('LLMResponseError', 'LLM 输出 JSON 不完整', { rawText: s });
      }
      candidate = candidate.slice(start, end + 1);
    }

    try {
      return JSON.parse(candidate);
    } catch (firstErr) {
      try {
        return JSON.parse(stripCommentsAndTrailingCommas(candidate));
      } catch (_secondErr) {
        throw err('LLMResponseError', 'LLM 输出 JSON 解析失败（含容错二阶尝试）：' + firstErr.message, { rawText: s });
      }
    }
  }

  async function testLlmConnection(opts) {
    const r = await callLlm(opts, {
      system: 'You are a connection tester.',
      user: 'Reply with the single word: OK',
      // v0.17.0.4：从 16 → 256。DeepSeek-reasoner / V4 thinking mode 默认开 CoT，
      // 思考占 token，太小会被截断返回空 content。256 对 chat 模型也无明显开销
      maxTokens: 256,
      timeoutMs: 15000,
      disableCache: true
    });
    return { ok: true, text: r.text, usage: r.usage };
  }

  function callClaudeMessages(opts) {
    const cfg = Object.assign({}, opts || {}, { protocol: PROTOCOL_ANTHROPIC });
    return callAnthropicMessages(cfg, opts || {});
  }

  global.BossLLM = {
    callLlm: callLlm,
    callClaudeMessages: callClaudeMessages,
    callAnthropicMessages: callAnthropicMessages,
    callOpenAIChatCompletions: callOpenAIChatCompletions,
    parseJsonOutput: parseJsonOutput,
    testLlmConnection: testLlmConnection,
    buildMessagesUrl: buildMessagesUrl,
    buildChatCompletionsUrl: buildChatCompletionsUrl,
    getHostPermissionPattern: getHostPermissionPattern,
    normalizeConfig: normalizeConfig,
    normalizeLlmSettings: normalizeLlmSettings,
    getCurrentLlmConfig: getCurrentLlmConfig,
    DEFAULT_BASE_URL: DEFAULT_ANTHROPIC_BASE_URL,
    DEFAULT_AUTH_TYPE: 'x-api-key',
    PROTOCOL_ANTHROPIC: PROTOCOL_ANTHROPIC,
    PROTOCOL_OPENAI_CHAT: PROTOCOL_OPENAI_CHAT
  };
})(self);
