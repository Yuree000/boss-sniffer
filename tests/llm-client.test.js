const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadClient(fetchImpl) {
  const file = path.resolve(__dirname, '../lib/llm-client.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = {
    self: {},
    console,
    fetch: fetchImpl,
    AbortController,
    URL,
    setTimeout,
    clearTimeout
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: file });
  return ctx.self.BossLLM;
}

test('calls OpenAI-compatible chat completions with bearer auth', async () => {
  const calls = [];
  const client = loadClient(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"decision":"pass"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    };
  });

  const result = await client.callLlm({
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    authType: 'bearer',
    model: 'deepseek-chat'
  }, {
    system: 'system prompt',
    user: 'user prompt',
    maxTokens: 123
  });

  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.max_tokens, 123);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' }
  ]);
  assert.equal(result.text, '{"decision":"pass"}');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2 });
});

test('calls Anthropic messages API for anthropic protocol', async () => {
  const calls = [];
  const client = loadClient(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        // v0.17.0.10 起 Anthropic 走 assistant 预填 `{`，API 返回 content 不含起手的 `{`
        // 模拟 LLM 续写 — 返回 JSON 主体（去掉首个 `{`）
        content: [{ type: 'text', text: '"decision":"pass"}' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    };
  });

  const result = await client.callLlm({
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    authType: 'x-api-key',
    model: 'claude-sonnet-4-6'
  }, {
    system: 'system prompt',
    user: 'user prompt',
    maxTokens: 16,
    disableCache: true
  });

  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant-test');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.system, 'system prompt');
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, 'user prompt');
  // v0.17.0.10 assistant 预填 `{`
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, '{');
  // 拼回 `{` 后下游 parseJsonOutput 能找到合法 JSON 起点
  assert.equal(result.text, '{"decision":"pass"}');
});

test('Anthropic 拼回 `{` — 防御式：若 LLM 自带 `{` 起头则不重复拼', async () => {
  const client = loadClient(async () => ({
    ok: true,
    json: async () => ({
      // 模拟厂商未来变更：LLM 返回时自带 `{` 起头
      content: [{ type: 'text', text: '{"decision":"pass"}' }]
    })
  }));
  const result = await client.callLlm({
    protocol: 'anthropic-messages',
    apiKey: 'sk-ant', model: 'claude-sonnet-4-6'
  }, { system: 's', user: 'u' });
  // 没有重复拼成 `{{...}`
  assert.equal(result.text, '{"decision":"pass"}');
});

test('migrates legacy single llm config into current config list', () => {
  const client = loadClient(async () => {
    throw new Error('unexpected fetch');
  });

  const settings = client.normalizeLlmSettings({
    baseUrl: 'https://api.anthropic.com',
    authType: 'x-api-key',
    apiKey: 'sk-ant-old',
    model: 'claude-opus-4-7',
    concurrency: 3
  });

  assert.equal(settings.currentId, 'legacy-llm');
  assert.equal(settings.configs.length, 1);
  assert.equal(settings.configs[0].providerName, 'Anthropic');
  assert.equal(settings.configs[0].protocol, 'anthropic-messages');
  assert.equal(settings.configs[0].apiKey, 'sk-ant-old');
  assert.equal(settings.configs[0].concurrency, 3);
});

test('parseJsonOutput 不含 JSON 对象 → 抛 LLMResponseError 且附 rawText', () => {
  const client = loadClient(async () => { throw new Error('unexpected fetch'); });
  let thrown = null;
  try { client.parseJsonOutput('I am not JSON at all'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'LLMResponseError');
  assert.equal(thrown.rawText, 'I am not JSON at all');
});

test('parseJsonOutput JSON 解析失败 → 抛错且附原始 rawText', () => {
  const client = loadClient(async () => { throw new Error('unexpected fetch'); });
  let thrown = null;
  try { client.parseJsonOutput('{"decision":"pass", broken'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'LLMResponseError');
  assert.ok(thrown.rawText && thrown.rawText.indexOf('broken') !== -1);
});

test('normalizes OpenAI-compatible base URLs and permission patterns', () => {
  const client = loadClient(async () => {
    throw new Error('unexpected fetch');
  });

  assert.equal(
    client.buildChatCompletionsUrl('https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/chat/completions'
  );
  assert.equal(
    client.buildChatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    client.getHostPermissionPattern('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/*'
  );
});
