const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PRESET_PROVIDERS, normalizeProvider, callChatCompletion, verifyProviderConnection, probeProvider } = require('../services/model-adapter');
const { HermesConfigService } = require('../services/hermes-config-service');
const reply = () => Response.json({ choices: [{ message: { content: 'BAIQIU_MODEL_OK' } }] });

for (const [providerId, preset] of Object.entries(PRESET_PROVIDERS)) {
  test(`${providerId}: direct verification and Hermes retain the same endpoint, protocol and model`, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'baiqiu-route-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const provider = { ...preset, apiKey: 'fixture-key' };
    const target = preset.apiStyle === 'anthropic' ? 'messages' : 'chat/completions';
    await callChatCompletion({ providerId, provider, body: { messages: [{ role: 'user', content: 'probe' }] },
      fetchImpl: async (url, init) => {
        assert.equal(url, `${preset.baseURL}/${target}`);
        assert.equal(JSON.parse(init.body).model, preset.model);
        assert.equal(init.headers[preset.apiStyle === 'anthropic' ? 'x-api-key' : 'Authorization'], preset.apiStyle === 'anthropic' ? 'fixture-key' : 'Bearer fixture-key');
        return preset.apiStyle === 'anthropic' ? Response.json({ content: [{ type: 'text', text: 'ok' }] }) : reply();
      } });
    const service = new HermesConfigService({ hermesHome: directory });
    service.apply({ provider: providerId, ...provider });
    const config = service.read();
    assert.equal(config.model.base_url, preset.baseURL);
    assert.equal(config.model.default, preset.model);
    assert.equal(config.model.api_mode, preset.apiStyle === 'anthropic' ? 'anthropic_messages' : 'chat_completions');
    if (config.model.provider.startsWith('custom:')) {
      const named = config.custom_providers.find(item => `custom:${item.name}` === config.model.provider);
      assert.equal(named.base_url, preset.baseURL);
      assert.match(fs.readFileSync(path.join(directory, '.env'), 'utf8'), new RegExp(`${named.key_env}=fixture-key`));
    }
  });
}

test('full Messages endpoints and explicit protocol overrides reach the selected API', async () => {
  const provider = { baseURL: ' https://gateway.example/anthropic/v1/messages/// ', apiStyle: 'anthropic', apiKey: 'fixture', model: ' selected-model ' };
  assert.equal(normalizeProvider('doubao', provider).baseURL, 'https://gateway.example/anthropic/v1');
  await callChatCompletion({ providerId: 'doubao', provider, body: { messages: [] }, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://gateway.example/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], 'fixture');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(JSON.parse(init.body).model, 'selected-model');
    return Response.json({ content: [{ type: 'text', text: 'ok' }] });
  } });
  for (const suffix of ['/chat/completions///', '/responses/', '/models/']) {
    assert.equal(normalizeProvider('custom', { baseURL: `https://gateway.example/v1${suffix}` }).baseURL, 'https://gateway.example/v1');
  }
});

test('a deployment absent from the catalog is verified by POST and retained for selection', async () => {
  const calls = [];
  const result = await verifyProviderConnection({ providerId: 'doubao', provider: { apiKey: 'fixture', model: 'ep-user-deployment' },
    fetchImpl: async (url, init) => {
      calls.push(init.method);
      if (init.method === 'GET') return Response.json({ data: [{ id: 'catalog-model' }] });
      assert.equal(JSON.parse(init.body).model, 'ep-user-deployment');
      return reply();
    } });
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal(result.model, 'ep-user-deployment');
  assert.equal(result.verified, true);
  assert.deepEqual(result.models, ['ep-user-deployment', 'catalog-model']);
  assert.deepEqual(result.allModels, ['catalog-model']);
  assert.match(result.modelListWarning, /未出现在模型目录/);
});

test('Messages SDK root URLs produce the same versioned path in verification and Hermes', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'baiqiu-route-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', apiStyle: 'anthropic', apiKey: 'fixture', model: 'selected' };
  const service = new HermesConfigService({ hermesHome: directory });
  service.apply({ provider: 'doubao', ...provider });
  await callChatCompletion({ providerId: 'doubao', provider, body: { messages: [] }, fetchImpl: async (url) => {
    const sdkBase = service.runtime().baseURL.replace(/\/v1\/?$/, '');
    assert.equal(url, sdkBase + '/v1/messages');
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/coding/v1/messages');
    return Response.json({ content: [{ type: 'text', text: 'ok' }] });
  } });
});

test('a provider without a catalog can still verify its selected model', async () => {
  const result = await verifyProviderConnection({ providerId: 'doubao', provider: { apiKey: 'fixture', model: 'ep-user-deployment' },
    fetchImpl: async (url, init) => init.method === 'GET' ? Response.json({ error: { message: 'no catalog' } }, { status: 404 }) : reply() });
  assert.equal(result.verified, true);
  assert.equal(result.modelListVerified, false);
  assert.deepEqual(result.models, ['ep-user-deployment']);
});

test('catalog availability never bypasses account or subscription failures', async () => {
  for (const [status, message, expected] of [
    [404, 'Your account has not activated the model selected.', /尚未开通模型 selected/],
    [400, 'Your account does not have a valid CodingPlan subscription, or your subscription has expired.', /没有有效的 Coding Plan 订阅/],
    [401, 'Invalid API key', /HTTP 401/],
    [405, 'Method not allowed', /HTTP 405/]
  ]) {
    const calls = [];
    await assert.rejects(verifyProviderConnection({ providerId: 'doubao', provider: { apiKey: 'fixture', model: 'selected' }, fetchImpl: async (url, init) => {
      calls.push(init.method);
      return Response.json({ error: { code: 'upstream-code', message } }, { status });
    } }), error => {
      assert.equal(error.status, status);
      assert.equal(error.providerCode, 'upstream-code');
      assert.equal(error.providerMessage, message);
      assert.match(error.message, expected);
      return true;
    });
    assert.deepEqual(calls, ['POST']);
  }
});

function sourceFunction(filename, start, end) {
  const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return source.slice(startIndex, endIndex);
}

test('the actual main configuration handler verifies the requested model without discovery substitution', async () => {
  const handler = sourceFunction('main.js', 'async function verifiedProviderConfiguration(', 'async function reuseVerifiedProviderConfiguration(');
  for (const strictModel of [true, false]) {
    let requested;
    const db = { settings: { defaultProvider: 'other', providers: { doubao: { apiKey: 'fixture', model: 'selected', baseURL: PRESET_PROVIDERS.doubao.baseURL } } } };
    const context = vm.createContext({ sanitizeText: value => String(value).trim(), loadDb: () => db, PRESET_PROVIDERS,
      recentProviderVerification: () => null, rememberProviderVerification() {}, structuredClone, AbortSignal,
      verifyProviderConnection: async input => { requested = input.provider; return { model: input.provider.model, models: [input.provider.model], baseURL: input.provider.baseURL, verifiedAt: 'now' }; },
      assertModelSettingsRevision: require('../services/model-settings-store').assertModelSettingsRevision,
      emitModelConfigurationStage() {}, applyAndCommitModelSettings: async settings => ({ settings }),
      providerCredentialFingerprint: () => 'fingerprint', blackBallRuntimeReceipt: () => ({}), saveDb: value => value });
    vm.runInContext(handler, context);
    const result = await context.verifiedProviderConfiguration({ providerId: 'doubao', model: 'ep-selected', strictModel });
    assert.equal(requested.model, 'ep-selected');
    assert.equal(result.provider.model, 'ep-selected');
    assert.equal(db.settings.providers.doubao.model, 'selected');
  }
});

test('model form retains an unlisted ID and the chosen protocol after rendering', () => {
  const render = sourceFunction('renderer-v2/app.js', 'function renderModelConfigDrawer()', 'async function saveModelConfig(');
  const state = { modelConfigKey: 'doubao', modelConfigDraft: { name: '豆包', model: 'ep-private', apiStyle: 'anthropic' },
    providerModels: { doubao: ['catalog-model'] }, providerModelStatus: {} };
  const body = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({ state, modelConfigBody: body, modelConfigTitle: {}, modelConfigLayer: { classList: { remove() {} } },
    modelVersionSuggestions: () => [], providerApiStyle: () => 'openai', escapeHtml: value => String(value || ''), PROVIDER_ROUTE_LABELS: {},
    $: () => null, bindSavedApiKeyMask() {}, setModelConfigSaveState() {}, modelConfigIsDirty: () => false });
  vm.runInContext(render, context);
  context.renderModelConfigDrawer();
  assert.match(body.innerHTML, /id="modelVersionInput"[^>]*value="ep-private"/);
  assert.match(body.innerHTML, /option value="anthropic" selected/);
  assert.equal(state.modelConfigDraft.model, 'ep-private');
});

test('verification retries only explicit output-budget exhaustion on the same model and protocol', async () => {
  const requests = [];
  const result = await probeProvider({ providerId: 'zhipu', provider: { apiKey: 'fixture', model: 'glm-selected' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      return requests.length === 1
        ? Response.json({ choices: [{ message: { content: '', reasoning_content: 'fixture reasoning' }, finish_reason: 'length' }], usage: { completion_tokens: 512 } })
        : reply();
    } });
  assert.equal(result.verified, true);
  assert.equal(result.probeAttempts, 2);
  assert.deepEqual(requests.map(item => item.body.max_tokens), [512, 4096]);
  assert.equal(requests[0].url, requests[1].url);
  assert.deepEqual({ ...requests[0].body, max_tokens: 4096 }, requests[1].body);
  let count = 0;
  await assert.rejects(probeProvider({ providerId: 'zhipu', provider: { apiKey: 'fixture' }, fetchImpl: async () => {
    count += 1;
    return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  } }), { code: 'MODEL_PROBE_EMPTY_TEXT' });
  assert.equal(count, 1);
});

test('cancellation after response headers still reaches the streaming transport', async () => {
  const controller = new AbortController();
  let transportSignal;
  await assert.rejects(callChatCompletion({ providerId: 'doubao', provider: { apiKey: 'fixture' },
    body: { messages: [], stream: true }, signal: controller.signal, onDelta: () => controller.abort(),
    fetchImpl: async (url, init) => {
      transportSignal = init.signal;
      const body = new ReadableStream({ start(stream) {
        init.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true });
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
        setTimeout(() => { if (!init.signal.aborted) stream.close(); }, 25);
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    } }), { name: 'AbortError' });
  assert.equal(transportSignal.aborted, true);
});

test('first stream content clears its deadline without requiring an onDelta subscriber', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let stream;
  const promise = callChatCompletion({ providerId: 'doubao', provider: { apiKey: 'fixture' }, body: { messages: [], stream: true },
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(31000);
  stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" second"},"finish_reason":"stop"}]}\n\n'));
  stream.close();
  const result = await promise;
  assert.equal(result.choices[0].message.content, 'first second');
});

test('cancelling the optional capability probe cannot save a successful verification', async () => {
  const controller = new AbortController();
  await assert.rejects(verifyProviderConnection({ providerId: 'custom', provider: { baseURL: 'https://gateway.example/v1', apiKey: 'fixture', model: 'gpt-5-test' },
    signal: controller.signal, fetchImpl: async (url, init) => {
      if (init.method === 'GET') return Response.json({ data: [{ id: 'gpt-5-test' }] });
      if (JSON.parse(init.body).reasoning_effort) {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return reply();
    } }), { name: 'AbortError' });
});
