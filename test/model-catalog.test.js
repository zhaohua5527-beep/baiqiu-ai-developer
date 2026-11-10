const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { listProviderModels, deepSeekModelMetadataFromHtml } = require('../services/model-adapter');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer-v2/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const pricing = '<table><tr><td colspan="3">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>unlisted-model</td></tr><tr><td colspan="3">模型版本</td><td>DeepSeek-V99-Fixture</td><td>Unlisted</td></tr></table>';
const provider = { baseURL: 'https://api.deepseek.com/v1', apiKey: 'fixture-key', model: 'deepseek-flash', apiStyle: 'openai' };
const listed = (models = ['deepseek-flash']) => ({ models, modelMetadata: {}, fetchedAt: '2026-09-14T00:00:00.000Z', catalogSource: 'https://api.deepseek.com/v1/models' });
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
function rendererHarness(listModels) {
  const state = { db: { settings: { defaultProvider: 'deepseek', providers: { deepseek: { ...provider, availableModels: ['old-model'], verifiedAt: 'before', verifiedModel: provider.model } } } }, providerCatalogs: {}, providerModels: {} };
  const context = vm.createContext({ state, api: { listModels }, Date, Promise, JSON, Set,
    renderReasoningMode() {}, requestAnimationFrame() {}, positionReasoningMenu() {}, $: () => null,
    compactModelLabel: value => value, escapeHtml: value => value });
  vm.runInContext(between(renderer, 'function providerCatalogIdentity(', 'let modelVersionSwitchRevision'), context);
  return { state, context };
}

test('official display names come from matching table columns, never invented model IDs', () => {
  assert.deepEqual(deepSeekModelMetadataFromHtml(pricing, ['deepseek-flash']), {
    'deepseek-flash': { displayName: 'DeepSeek-V99-Fixture', source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' }
  });
  assert.deepEqual(deepSeekModelMetadataFromHtml('<table><tr><td>not a model table</td></tr></table>', ['deepseek-flash']), {});
});

test('real API IDs remain unchanged and documentation requests carry no credentials', async () => {
  const calls = [];
  const result = await listProviderModels({ providerId: 'deepseek', provider, includeMetadata: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.includes('api-docs') ? new Response(pricing) : Response.json({ data: [{ id: 'deepseek-flash' }] });
    } });
  assert.deepEqual(result.models, ['deepseek-flash']);
  assert.equal(result.modelMetadata['deepseek-flash'].displayName, 'DeepSeek-V99-Fixture');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(calls[1].init.headers, { Accept: 'text/html' });
  assert.equal(result.metadataWarning, '');
});

test('a proxy using DeepSeek IDs is never relabeled using official service documentation', async () => {
  let calls = 0;
  const result = await listProviderModels({ providerId: 'deepseek', provider: { ...provider, baseURL: 'https://proxy.example/v1' }, includeMetadata: true,
    fetchImpl: async () => { calls++; return Response.json({ data: [{ id: 'deepseek-flash', display_name: 'Proxy deployment' }] }); } });
  assert.equal(calls, 1);
  assert.equal(result.modelMetadata['deepseek-flash'].displayName, 'Proxy deployment');
});

test('unavailable documentation preserves the live directory and explicitly falls back to IDs', async () => {
  const result = await listProviderModels({ providerId: 'deepseek', provider, includeMetadata: true,
    fetchImpl: async url => url.includes('api-docs') ? new Response('unavailable', { status: 503 }) : Response.json({ data: [{ id: 'deepseek-flash' }] }) });
  assert.deepEqual(result.models, ['deepseek-flash']);
  assert.equal(result.modelMetadata['deepseek-flash'].displayName, 'deepseek-flash');
  assert.match(result.metadataWarning, /暂未获取/);
});

test('Anthropic-style pagination loads all pages and retains supplier display names', async () => {
  const urls = [];
  const result = await listProviderModels({ providerId: 'anthropic', provider: { apiKey: 'fixture-key' },
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers['x-api-key'], 'fixture-key');
      return urls.length === 1
        ? Response.json({ data: [{ id: 'model-first', display_name: 'First' }], has_more: true, last_id: 'model-first' })
        : Response.json({ data: [{ id: 'model-second', display_name: 'Second' }], has_more: false });
    } });
  assert.deepEqual(result.models, ['model-first', 'model-second']);
  assert.equal(new URL(urls[1]).searchParams.get('after_id'), 'model-first');
  assert.equal(result.modelMetadata['model-second'].displayName, 'Second');
});

test('broken pagination and invalid directories fail instead of publishing a partial new list', async () => {
  await assert.rejects(listProviderModels({ providerId: 'deepseek', provider,
    fetchImpl: async () => Response.json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }) }), /分页未完成/);
  await assert.rejects(listProviderModels({ providerId: 'deepseek', provider,
    fetchImpl: async () => Response.json({ data: [] }) }), /没有返回/);
});

test('concurrent menu opens share one fetch and a fresh directory is cached', async () => {
  let resolve;
  let calls = 0;
  const { state, context } = rendererHarness(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = context.refreshModelCatalog();
  const second = context.refreshModelCatalog();
  assert.equal(calls, 1);
  resolve(listed());
  await Promise.all([first, second]);
  await context.refreshModelCatalog();
  assert.equal(calls, 1);
  assert.equal(state.providerCatalogs.deepseek.loading, false);
  assert.equal(state.db.settings.providers.deepseek.model, 'deepseek-flash');
});

test('refresh replaces obsolete catalogue entries but retains a verified custom selection', async () => {
  const { context, state } = rendererHarness(async () => listed(['new-model']));
  await context.refreshModelCatalog();
  assert.deepEqual(Array.from(context.modelVersionsForProvider('deepseek', state.db.settings.providers.deepseek)), ['new-model', 'deepseek-flash']);
  assert.equal(state.db.settings.providers.deepseek.model, 'deepseek-flash');
});

test('failed refresh keeps last successful list and does not disable or switch the model', async () => {
  let fail = false;
  const { context, state } = rendererHarness(async () => { if (fail) throw new Error('offline'); return listed(); });
  await context.refreshModelCatalog();
  fail = true;
  await context.refreshModelCatalog('deepseek', state.db.settings.providers.deepseek, { force: true });
  assert.deepEqual(Array.from(state.providerCatalogs.deepseek.result.models), ['deepseek-flash']);
  assert.equal(state.providerCatalogs.deepseek.error, 'offline');
  assert.equal(state.db.settings.providers.deepseek.model, 'deepseek-flash');
});

test('an old credential response cannot overwrite a newer catalogue request', async () => {
  const pending = [];
  const { context, state } = rendererHarness(() => new Promise(resolve => pending.push(resolve)));
  const old = context.refreshModelCatalog();
  state.db.settings.providers.deepseek.apiKey = 'new-fixture-key';
  const current = context.refreshModelCatalog();
  pending[1](listed(['new-account-model']));
  await current;
  pending[0](listed(['old-account-model']));
  await old;
  assert.deepEqual(Array.from(state.providerModels.deepseek), ['new-account-model']);
  assert.deepEqual(Array.from(state.db.settings.providers.deepseek.availableModels), ['new-account-model']);
});

test('renderer display name is separate from the model selection value', async () => {
  const { context, state } = rendererHarness(async () => ({ ...listed(), modelMetadata: { 'deepseek-flash': { displayName: 'Official version' } } }));
  await context.refreshModelCatalog();
  assert.equal(context.modelCatalogLabel('deepseek', 'deepseek-flash'), 'Official version');
  assert.equal(state.db.settings.providers.deepseek.model, 'deepseek-flash');
  const menu = between(renderer, 'function renderReasoningMode()', 'function compactModelLabel(');
  assert.match(menu, /data-model-version="\$\{escapeHtml\(version\)\}"/);
  assert.match(menu, /modelCatalogLabel\(providerKey, version\)/);
});

test('only a matching saved route gets persisted catalogue metadata, with selection untouched', async () => {
  let db = { settings: { providers: { deepseek: { ...provider, model: 'selected', availableModels: ['before'], modelCapabilities: { selected: { reasoningVerified: true } } } } } };
  let finish;
  const context = vm.createContext({ structuredClone, AbortSignal,
    listProviderModels: () => new Promise(resolve => { finish = resolve; }),
    loadDb: () => db,
    ensureModelSettingsStore: () => ({
      cacheCatalog: async (settings, providerId, _provider, metadata) => Object.assign(settings.providers[providerId], metadata),
      apply: settings => settings
    }),
    providerVerificationCacheKey: (_key, value) => JSON.stringify([value.baseURL, value.apiKey, value.apiStyle, value.model]) });
  vm.runInContext(between(main, 'async function refreshProviderModelCatalog(', 'async function verifiedProviderConfiguration('), context);
  const first = context.refreshProviderModelCatalog('deepseek', provider);
  finish(listed());
  await first;
  assert.deepEqual(db.settings.providers.deepseek.availableModels, ['deepseek-flash']);
  assert.equal(db.settings.providers.deepseek.model, 'selected');
  assert.equal(db.settings.providers.deepseek.modelCapabilities.selected.reasoningVerified, true);
  const second = context.refreshProviderModelCatalog('deepseek', provider);
  db.settings.providers.deepseek.baseURL = 'https://changed.example/v1';
  finish(listed(['late-model']));
  await second;
  assert.deepEqual(db.settings.providers.deepseek.availableModels, ['deepseek-flash']);
});
