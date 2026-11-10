"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { ModelSettingsStore, copyModelSettings, assertModelSettingsRevision } = require("../services/model-settings-store");
const mainSource = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, "Missing boundary: " + start);
  return source.slice(first, last);
}

function fixture() {
  return { defaultProvider: "deepseek", reasoning: "high", providers: {
    deepseek: { name: "DeepSeek", apiKey: "old-fixture-key", baseURL: "https://fixture.invalid/v1", model: "fixture-model", apiStyle: "openai", enabled: true },
    custom: { name: "Custom", apiKey: "custom-fixture-key", baseURL: "https://custom.invalid/v1", model: "custom-model", apiStyle: "openai", enabled: true }
  } };
}

function temporaryStore(context, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-model-settings-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ModelSettingsStore(path.join(directory, "model-settings.json"), options);
}

test("configuration survives restart without rewriting conversation history", async context => {
  const store = temporaryStore(context);
  const history = path.join(path.dirname(store.file), "heiqiu-db.json");
  const original = JSON.stringify({ messages: { one: [{ text: "保留回答".repeat(500000) }] } });
  fs.writeFileSync(history, original);
  const committed = await store.commit(fixture());
  assert.ok(committed.modelConfigRevision);
  assert.equal(fs.readFileSync(history, "utf8"), original);
  assert.ok(fs.statSync(store.file).size < 10000);
  const restored = new ModelSettingsStore(store.file).apply({ theme: "keep" });
  assert.equal(restored.providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(restored.theme, "keep");
  assert.equal(restored.modelConfigRevision, committed.modelConfigRevision);
});

test("failed commit never publishes new settings and can be retried", async context => {
  const store = temporaryStore(context);
  const original = await store.commit(fixture());
  const realWrite = store.write;
  store.write = async () => { throw new Error("fixture disk full"); };
  const changed = structuredClone(original);
  changed.providers.deepseek.apiKey = "new-fixture-key";
  await assert.rejects(store.commit(changed), /disk full/);
  assert.equal(store.apply({}).providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(new ModelSettingsStore(store.file).apply({}).providers.deepseek.apiKey, "old-fixture-key");
  store.write = realWrite;
  await store.commit(changed);
  assert.equal(store.apply({}).providers.deepseek.apiKey, "new-fixture-key");
});

test("concurrent revisions cannot overwrite the first committed change", async context => {
  const store = temporaryStore(context);
  const original = await store.commit(fixture());
  const first = structuredClone(original);
  first.defaultProvider = "custom";
  const second = structuredClone(original);
  second.providers.deepseek.apiKey = "late-fixture-key";
  const results = await Promise.allSettled([store.commit(first), store.commit(second)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "MODEL_SETTINGS_CONFLICT");
  assert.equal(store.apply({}).defaultProvider, "custom");
  assert.equal(store.apply({}).providers.deepseek.apiKey, "old-fixture-key");
});

test("catalog refresh preserves revision and rejects old credentials", async context => {
  const store = temporaryStore(context);
  const settings = fixture();
  await store.cacheCatalog(settings, "deepseek", settings.providers.deepseek, { availableModels: ["new-model"] });
  assert.equal(store.apply({}).modelConfigRevision, "");
  const changed = store.apply({});
  changed.providers.deepseek.apiKey = "new-fixture-key";
  const committed = await store.commit(changed);
  assert.equal(await store.cacheCatalog(settings, "deepseek", settings.providers.deepseek, { availableModels: ["stale"] }), false);
  assert.equal(store.apply({}).modelConfigRevision, committed.modelConfigRevision);
  assert.deepEqual(store.apply({}).providers.deepseek.availableModels, ["new-model"]);
});

function mainHarness(context, { verifyError, failWrite } = {}) {
  const store = temporaryStore(context, failWrite ? { write: async () => { throw new Error("fixture write failed"); } } : undefined);
  const database = { settings: fixture(), sessions: [{ id: "one", hermesSessionId: "keep-until-applied" }] };
  Object.defineProperty(database, "messages", { enumerable: true, get() { throw new Error("Model save accessed conversation history"); } });
  const activeRuns = new Map();
  const applied = [];
  const stages = [];
  const sandbox = vm.createContext({
    structuredClone, AbortSignal, setTimeout, clearTimeout, Date, modelSettingsCommitBarrier: null,
    activeRuns, hermesClient: null, hermesForegroundClient: null, hermesHealthClient: null,
    loadDb: () => database, ensureModelSettingsStore: () => store, copyModelSettings, assertModelSettingsRevision,
    sanitizeText: value => String(value || "").trim(), PRESET_PROVIDERS: {},
    providerVerificationMatches: () => true, recentProviderVerification: () => null,
    verifyProviderConnection: async ({ provider }) => {
      if (verifyError) throw new Error(verifyError);
      return { verifiedAt: "fixture", model: provider.model, baseURL: provider.baseURL, models: [provider.model] };
    },
    rememberProviderVerification() {}, verifiedNativeReasoningLevels: () => [],
    providerCredentialFingerprint: () => "fixture-fingerprint",
    blackBallRuntimeReceipt: settings => ({ applied: true, providerId: settings.defaultProvider, executionVerified: false }),
    syncHermesRuntimeConfig: async settings => { applied.push(structuredClone(settings)); },
    clearHermesSessionBindings: database => { database.sessions.forEach(session => { session.hermesSessionId = null; }); },
    safeMainWindowSend: (_name, payload) => stages.push(payload),
    rendererDbSnapshot: database => ({ settings: database.settings }),
    ensureRunActive: signal => { if (signal?.aborted) throw new Error("aborted"); }
  });
  vm.runInContext(between(mainSource, "async function commitModelSettings(", "\nfunction loadDb("), sandbox);
  vm.runInContext(between(mainSource, "async function verifiedProviderConfiguration(", "\nlet modelRuntimeReconcilePromise"), sandbox);
  vm.runInContext(between(mainSource, "let modelRuntimeTransition =", "\nasync function reconcileSelectedModelRuntime("), sandbox);
  return { sandbox, database, store, activeRuns, applied, stages };
}

test("active credential save waits for completion while queued new runs do not deadlock", async context => {
  const harness = mainHarness(context);
  harness.activeRuns.set("existing", { waitingForModelRuntime: false });
  harness.activeRuns.set("queued", { waitingForModelRuntime: true });
  const payload = { providerId: "deepseek", apiKey: "new-fixture-key", activate: true, expectedRevision: "", requestId: "one" };
  const operation = harness.sandbox.runModelConfigurationOperation(payload, () => harness.sandbox.verifiedProviderConfiguration(payload));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(harness.applied.length, 0);
  assert.equal(harness.database.settings.providers.deepseek.apiKey, "old-fixture-key");
  assert.ok(harness.stages.some(item => item.stage === "waiting_for_task"));
  harness.activeRuns.delete("existing");
  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(harness.applied.length, 1);
  assert.equal(result.settings.providers.deepseek.apiKey, "new-fixture-key");
  assert.equal(harness.database.sessions[0].hermesSessionId, null);
});

test("saving inactive provider neither stops runtime nor resets bindings", async context => {
  const harness = mainHarness(context);
  harness.activeRuns.set("existing", { waitingForModelRuntime: false });
  const result = await harness.sandbox.verifiedProviderConfiguration({ providerId: "custom", apiKey: "new-custom-fixture", activate: false });
  assert.equal(result.ok, true);
  assert.equal(harness.applied.length, 0);
  assert.equal(result.settings.defaultProvider, "deepseek");
  assert.equal(harness.database.sessions[0].hermesSessionId, "keep-until-applied");
});

test("validation failure preserves credentials without applying or persisting", async context => {
  const harness = mainHarness(context, { verifyError: "fixture unauthorized" });
  await assert.rejects(harness.sandbox.verifiedProviderConfiguration({ providerId: "deepseek", apiKey: "bad-fixture", activate: true }), /unauthorized/);
  assert.equal(harness.applied.length, 0);
  assert.equal(fs.existsSync(harness.store.file), false);
  assert.equal(harness.database.settings.providers.deepseek.apiKey, "old-fixture-key");
});

test("failed persistence rolls runtime back and retains old session bindings", async context => {
  const harness = mainHarness(context, { failWrite: true });
  await assert.rejects(harness.sandbox.verifiedProviderConfiguration({ providerId: "deepseek", apiKey: "new-fixture-key", activate: true }), /write failed/);
  assert.equal(harness.applied.length, 2);
  assert.equal(harness.applied[1].providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(harness.database.settings.providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(harness.database.sessions[0].hermesSessionId, "keep-until-applied");
});

function useRealRuntimeSync(harness) {
  let runtime = null;
  Object.assign(harness.sandbox, {
    hermesConfigSyncPromise: null, hermesConfigFingerprint: "",
    selectedHermesConfig: settings => ({ provider: settings.defaultProvider, ...settings.providers[settings.defaultProvider] }),
    fingerprintHermesConfig: config => JSON.stringify(config),
    ensureHermesConfigService: () => ({
      runtime: () => runtime,
      apply: config => { runtime = structuredClone(config); harness.applied.push(runtime); return runtime; }
    })
  });
  vm.runInContext(between(mainSource, "async function syncHermesRuntimeConfig(", "\nconst BLACK_BALL_REASONING_LEVELS"), harness.sandbox);
  return () => runtime;
}

for (const failWrite of [false, true]) {
  test("background warmup waits for " + (failWrite ? "failed commit rollback" : "successful durable commit"), async context => {
    const harness = mainHarness(context);
    const runtime = useRealRuntimeSync(harness);
    const oldSnapshot = structuredClone(harness.database.settings);
    const realWrite = harness.store.write;
    let releaseWrite;
    let announceWrite;
    const startedWrite = new Promise(resolve => { announceWrite = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    harness.store.write = async (...args) => {
      announceWrite();
      await writeGate;
      if (failWrite) throw new Error("fixture write failure");
      return realWrite(...args);
    };
    const payload = { providerId: "deepseek", apiKey: "new-fixture-key", activate: true, expectedRevision: "" };
    const operation = harness.sandbox.runModelConfigurationOperation(payload, () => harness.sandbox.verifiedProviderConfiguration(payload));
    const outcome = operation.then(value => ({ value }), error => ({ error }));
    await startedWrite;
    let warmupFinished = false;
    const warmup = harness.sandbox.syncHermesRuntimeConfig(oldSnapshot).then(() => { warmupFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warmupFinished, false);
    assert.equal(runtime().apiKey, "new-fixture-key");
    assert.equal(harness.database.settings.providers.deepseek.apiKey, "old-fixture-key");
    releaseWrite();
    const result = await outcome;
    await warmup;
    if (failWrite) assert.match(result.error.message, /write failure/);
    else assert.equal(result.value.ok, true);
    const expectedKey = failWrite ? "old-fixture-key" : "new-fixture-key";
    assert.equal(runtime().apiKey, expectedKey);
    assert.equal(harness.database.settings.providers.deepseek.apiKey, expectedKey);
    assert.equal(harness.sandbox.modelSettingsCommitBarrier, null);
    await harness.sandbox.syncHermesRuntimeConfig(oldSnapshot);
    assert.equal(runtime().apiKey, expectedKey);
    assert.equal(harness.applied.length, failWrite ? 2 : 1);
  });
}

test("an already-running old sync cannot overwrite a later configuration commit", async context => {
  const harness = mainHarness(context);
  const runtime = useRealRuntimeSync(harness);
  const oldSnapshot = structuredClone(harness.database.settings);
  let releaseStop;
  const stopped = new Promise(resolve => { releaseStop = resolve; });
  harness.sandbox.hermesClient = { stop: () => stopped };
  const earlierSync = harness.sandbox.syncHermesRuntimeConfig(oldSnapshot);
  const waitingSync = harness.sandbox.syncHermesRuntimeConfig(oldSnapshot);
  const payload = { providerId: "deepseek", apiKey: "new-fixture-key", activate: true, expectedRevision: "" };
  const operation = harness.sandbox.runModelConfigurationOperation(payload, () => harness.sandbox.verifiedProviderConfiguration(payload));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime().apiKey, "old-fixture-key");
  releaseStop();
  await Promise.all([earlierSync, waitingSync, operation]);
  assert.equal(runtime().apiKey, "new-fixture-key");
  assert.equal(harness.database.settings.providers.deepseek.apiKey, "new-fixture-key");
});

function rendererHarness() {
  const settings = fixture();
  settings.modelConfigRevision = "initial";
  const state = { db: { settings }, providerModelErrors: {}, providerModelStatus: {}, providerModels: {}, providerLastChecked: {}, modelConfigSaving: false };
  const requests = [];
  const toasts = [];
  const list = { innerHTML: "", querySelectorAll: () => [] };
  let progress;
  const sandbox = vm.createContext({ state, Map, Date,
    api: { configureModel: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })), onModelConfigurationProgress: callback => { progress = callback; } },
    configuredModelList: list, providerSelect: { value: "deepseek" },
    currentModelCard: null, modelCenterCurrentName: null, modelCenterCurrentId: null, modelCenterCurrentStatus: null,
    modelCenterCurrentCapabilities: null, modelSortSelect: null, configuredModelCount: null,
    providerConnectionState: () => ({ online: true }), providerVerificationMatches: () => true,
    modelPresentationProfile: () => ({ capabilities: [] }), modelSortMode: () => "recommended",
    orderedModelProviders: providers => Object.entries(providers), PROVIDER_API_KEY_URLS: {},
    escapeHtml: value => String(value || ""), modelProviderIcon: () => "", renderProviderHealthPanel() {},
    showCopyToast: message => toasts.push(message), setModelConfigSaveState() {},
    renderSettings: () => sandbox.renderModelCenterOverview()
  });
  vm.runInContext(between(rendererSource, "const API_KEY_MASK =", "\nasync function deleteProviderApiKey("), sandbox);
  vm.runInContext(between(rendererSource, "function configuredProviderCardState(", "\nasync function renderProviderHealthPanel("), sandbox);
  return { sandbox, state, requests, toasts, list, progress: message => progress(message) };
}

test("new key remains a draft while pending and after failure; double-click submits once", async () => {
  const harness = rendererHarness();
  const input = { value: "new-fixture-key", dataset: { savedApiKey: "0" } };
  const operation = harness.sandbox.confirmProviderApiKey("deepseek", input);
  assert.equal(harness.requests.length, 1);
  assert.ok(harness.list.innerHTML.includes('value="new-fixture-key"'));
  assert.ok(harness.list.innerHTML.includes("正在验证并保存"));
  await harness.sandbox.confirmProviderApiKey("deepseek", input);
  assert.equal(harness.requests.length, 1);
  harness.requests[0].reject(new Error("fixture invalid key"));
  await operation;
  assert.ok(harness.list.innerHTML.includes('value="new-fixture-key"'));
  assert.ok(harness.list.innerHTML.includes("本次操作失败"));
  assert.equal(harness.state.db.settings.providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(harness.toasts.some(message => message.includes("配置已保存")), false);
});

test("saved label requires durable receipt; old progress is ignored", async () => {
  const harness = rendererHarness();
  const operation = harness.sandbox.confirmProviderApiKey("deepseek", { value: "new-fixture-key", dataset: { savedApiKey: "0" } });
  harness.progress({ requestId: "old-operation", stage: "saving" });
  assert.equal(harness.state.providerModelStatus.deepseek, "正在验证并保存…");
  const settings = fixture();
  settings.modelConfigRevision = "committed";
  settings.providers.deepseek.apiKey = "new-fixture-key";
  harness.requests[0].resolve({ ok: true, settings, provider: settings.providers.deepseek });
  await operation;
  assert.ok(harness.list.innerHTML.includes('data-saved-api-key="1"'));
  assert.equal(harness.list.innerHTML.includes('value="new-fixture-key"'), false);
  assert.equal(harness.state.db.settings.modelConfigRevision, "committed");
  assert.ok(harness.toasts.includes("接口正文验证通过，配置已保存"));
});

test("failed IPC receipts cannot produce false success", async () => {
  const harness = rendererHarness();
  const operation = harness.sandbox.confirmProviderApiKey("deepseek", { value: "new-fixture-key", dataset: { savedApiKey: "0" } });
  harness.requests[0].resolve({ ok: false });
  await operation;
  assert.equal(harness.state.db.settings.providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(harness.state.providerModelErrors.deepseek, true);
  assert.ok(harness.list.innerHTML.includes('value="new-fixture-key"'));
});

test("ordinary settings snapshots cannot overwrite model configuration fields", () => {
  const current = fixture();
  current.modelConfigRevision = "committed";
  const incoming = fixture();
  incoming.defaultProvider = "custom";
  incoming.providers.deepseek.apiKey = "stale-fixture";
  incoming.theme = "updated";
  copyModelSettings(current, incoming);
  assert.equal(incoming.defaultProvider, "deepseek");
  assert.equal(incoming.providers.deepseek.apiKey, "old-fixture-key");
  assert.equal(incoming.theme, "updated");
  const handler = between(mainSource, 'ipcMain.handle("settings:save"', 'ipcMain.handle("customer-profile:complete"');
  assert.ok(handler.includes("copyModelSettings(current.settings, db.settings)"));
  assert.ok(handler.includes("isDeepStrictEqual(db.settings, current.settings)"));
  assert.ok(handler.includes("const latest = loadDb();"));
  assert.ok(handler.includes("saveDb(latest)"));
});

test("a connectivity test does not persist configuration or reload conversation history", async () => {
  const settings = fixture();
  const original = structuredClone(settings);
  const state = { db: { settings }, providerModelErrors: {}, providerModelStatus: {}, providerModels: {}, providerLastChecked: {} };
  const sandbox = vm.createContext({ state, modelSettingsOperation: null,
    api: {
      verifyModel: async () => ({ verifiedAt: "fixture", model: "fixture-model", baseURL: "https://fixture.invalid/v1", models: [], latencyMs: 1 }),
      saveSettings: () => { throw new Error("Probe attempted full settings save"); },
      init: () => { throw new Error("Probe attempted full history reload"); }
    },
    renderModelCenterOverview() {}, renderModelConfigDrawer() {}, modelConfigLayer: { hidden: true }
  });
  vm.runInContext(between(rendererSource, "async function refreshProviderModels(", "\nlet renderAllInFlight"), sandbox);
  await sandbox.refreshProviderModels("deepseek", null, null, "test");
  assert.equal(state.providerModelErrors.deepseek, false);
  assert.match(state.providerModelStatus.deepseek, /验证通过/);
  assert.deepEqual(settings, original);
});

test("late session snapshot preserves committed model settings and visible answers", () => {
  const sandbox = vm.createContext({ state: { authoritativeMessagesBySession: new Map() },
    snapshotMessageIdentity: message => message.id,
    mergeSessionSnapshotMessage: (current, incoming) => ({ ...incoming, ...current }) });
  vm.runInContext(between(rendererSource, "function mergeSessionChangedDb(", "\nfunction addMessage("), sandbox);
  const current = { settings: { ...fixture(), modelConfigGeneration: 2 }, messages: { one: [{ id: "answer", text: "保留结果" }] } };
  const older = { settings: { ...fixture(), defaultProvider: "custom", modelConfigGeneration: 1 }, messages: {} };
  const merged = sandbox.mergeSessionChangedDb(current, older);
  assert.equal(merged.settings.defaultProvider, "deepseek");
  assert.equal(merged.settings.modelConfigGeneration, 2);
  assert.equal(merged.messages.one[0].text, "保留结果");
});

test("agent-triggered changes report pending until current task completes", async context => {
  const harness = mainHarness(context);
  harness.activeRuns.set("agent", { waitingForModelRuntime: false });
  const queued = harness.sandbox.queueModelSettingsChange(
    () => harness.sandbox.reuseVerifiedProviderConfiguration({ providerId: "custom", activate: true }),
    { providerId: "custom" }
  );
  assert.equal(queued.pending, true);
  assert.equal(queued.applied, false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.database.settings.defaultProvider, "deepseek");
  harness.activeRuns.delete("agent");
  await harness.sandbox.waitForModelRuntimeTransition();
  assert.equal(harness.database.settings.defaultProvider, "custom");
});
