const assert = require("node:assert");
const path = require("node:path");
const {
  RUNTIME_IDS,
  assertRuntimeShape,
  normalizeRuntimeId,
  createAgentRuntime,
  getAgentRuntime,
  resetAgentRuntimeForTests,
  listRegisteredRuntimeIds,
  resolveRuntimeIdFromSettings,
  OpenClawRuntime,
  HermesRuntime
} = require("../services/runtime");
const { AgentServices } = require("../services/agent-services");

function createFakeClient() {
  const handlers = new Map();
  return {
    connected: false,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) || []) handler(payload);
    },
    connect() {
      this.connected = true;
      this.emit("status", { state: "connected" });
    },
    waitUntilReady() {
      return Promise.resolve();
    },
    history(sessionKey, limit) {
      return Promise.resolve({ sessionKey, limit, messages: [] });
    },
    sendChat(input) {
      return Promise.resolve({ runId: "run-1", input });
    },
    abortChat(input) {
      return Promise.resolve({ aborted: true, input });
    }
  };
}

async function run() {
  assert.strictEqual(normalizeRuntimeId("open-claw"), RUNTIME_IDS.OPENCLAW);
  assert.strictEqual(normalizeRuntimeId("HERMES"), RUNTIME_IDS.HERMES);
  assert.strictEqual(normalizeRuntimeId("oc"), RUNTIME_IDS.OPENCLAW);
  assert.deepStrictEqual(listRegisteredRuntimeIds(), [
    RUNTIME_IDS.OPENCLAW,
    RUNTIME_IDS.HERMES,
    RUNTIME_IDS.LOCAL
  ]);

  assert.strictEqual(resolveRuntimeIdFromSettings({ agentRuntime: "hermes" }), RUNTIME_IDS.HERMES);
  assert.strictEqual(resolveRuntimeIdFromSettings({ defaultProvider: "openclaw" }), RUNTIME_IDS.OPENCLAW);
  assert.strictEqual(resolveRuntimeIdFromSettings({ defaultProvider: "hermes" }), RUNTIME_IDS.HERMES);
  assert.strictEqual(resolveRuntimeIdFromSettings({ defaultProvider: "relay" }), RUNTIME_IDS.OPENCLAW);

  resetAgentRuntimeForTests();
  const fakeClient = createFakeClient();
  const fakeConfig = { port: 18789, host: "127.0.0.1", token: "test-token" };
  const runtime = createAgentRuntime(RUNTIME_IDS.OPENCLAW, {
    client: fakeClient,
    appRoot: path.join(__dirname, ".."),
    getConfig: () => fakeConfig,
    canConnect: async () => true,
    nodeLikeCommand: () => ({ command: process.execPath, env: {} })
  });

  assert.ok(runtime instanceof OpenClawRuntime);
  assertRuntimeShape(runtime, "OpenClawRuntime");
  assert.strictEqual(runtime.id, RUNTIME_IDS.OPENCLAW);
  assert.strictEqual(runtime.name, "OpenClaw");
  assert.strictEqual(runtime.getClient(), fakeClient);

  const started = await runtime.ensureStarted();
  assert.strictEqual(started, true);

  let connectAttempts = 0;
  const runtimeNeedsStart = createAgentRuntime(RUNTIME_IDS.OPENCLAW, {
    client: createFakeClient(),
    getConfig: () => fakeConfig,
    canConnect: async () => {
      connectAttempts += 1;
      return false;
    },
    nodeLikeCommand: () => ({ command: process.execPath, env: {} }),
    getHomePath: () => path.join(__dirname, "__missing_home__"),
    getAppDataPath: () => path.join(__dirname, "__missing_appdata__"),
    appRoot: path.join(__dirname, "__missing_app__")
  });
  const startedMissing = await runtimeNeedsStart.ensureStarted();
  assert.strictEqual(startedMissing, false);
  assert.ok(connectAttempts >= 1);

  let sawStatus = false;
  runtime.onStatus((status) => {
    if (status?.state === "connected") sawStatus = true;
  });
  runtime.connect();
  assert.strictEqual(runtime.connected, true);
  assert.strictEqual(sawStatus, true);
  assert.strictEqual(runtime.getStatus().connected, true);
  assert.strictEqual(runtime.getStatus().runtimeId, RUNTIME_IDS.OPENCLAW);

  const chat = await runtime.sendChat({ sessionKey: "agent:main:test", message: "hello" });
  assert.strictEqual(chat.runId, "run-1");
  assert.strictEqual(chat.input.message, "hello");

  const history = await runtime.history("agent:main:test", 10);
  assert.strictEqual(history.sessionKey, "agent:main:test");
  assert.strictEqual(history.limit, 10);

  const aborted = await runtime.abortChat({ sessionKey: "agent:main:test", runId: "run-1" });
  assert.strictEqual(aborted.aborted, true);

  // Hermes runtime is now implemented.
  resetAgentRuntimeForTests();
  const hermes = createAgentRuntime(RUNTIME_IDS.HERMES, {
    useHttp: false,
    stubReply: "hello from hermes",
    config: {
      autoStart: false,
      baseURL: "http://127.0.0.1:18791/v1",
      port: 18791,
      host: "127.0.0.1"
    },
    canConnect: async () => false
  });
  assert.ok(hermes instanceof HermesRuntime);
  assertRuntimeShape(hermes, "HermesRuntime");
  assert.strictEqual(hermes.id, RUNTIME_IDS.HERMES);
  assert.strictEqual(hermes.name, "Hermes");
  // local binary missing + autoStart false => ensureStarted false
  assert.strictEqual(await hermes.ensureStarted(), false);
  hermes.connect();
  assert.strictEqual(hermes.connected, true);
  const hermesChat = await hermes.sendChat({ sessionKey: "agent:main:hermes-test", message: "ping" });
  assert.strictEqual(hermesChat.status, "done");
  assert.match(String(hermesChat.text || ""), /hello from hermes/);
  const hermesHistory = await hermes.history("agent:main:hermes-test", 20);
  assert.ok(Array.isArray(hermesHistory.messages));
  assert.ok(hermesHistory.messages.length >= 2);
  const hermesAbort = await hermes.abortChat({ sessionKey: "agent:main:hermes-test", runId: hermesChat.runId });
  assert.strictEqual(hermesAbort.aborted, true);

  // Remote Hermes baseURL without local binary still counts as startable.
  const remoteHermes = createAgentRuntime(RUNTIME_IDS.HERMES, {
    useHttp: false,
    config: {
      autoStart: true,
      baseURL: "https://hermes.example.com/v1",
      port: 18791,
      host: "127.0.0.1"
    },
    canConnect: async () => false
  });
  assert.strictEqual(await remoteHermes.ensureStarted(), true);

  assert.throws(
    () => createAgentRuntime(RUNTIME_IDS.LOCAL),
    /Local-only runtime adapter is reserved/
  );
  assert.throws(
    () => createAgentRuntime("unknown-runtime"),
    /Unsupported agent runtime/
  );

  resetAgentRuntimeForTests();
  const singletonA = getAgentRuntime({ id: RUNTIME_IDS.OPENCLAW, client: createFakeClient(), canConnect: async () => true });
  const singletonB = getAgentRuntime({ id: RUNTIME_IDS.OPENCLAW, client: createFakeClient(), canConnect: async () => true });
  assert.strictEqual(singletonA, singletonB);

  // Switching runtime id should create a different singleton instance.
  const hermesSingleton = getAgentRuntime({ id: RUNTIME_IDS.HERMES, useHttp: false, canConnect: async () => false, config: { autoStart: false } });
  assert.notStrictEqual(hermesSingleton, singletonA);
  assert.strictEqual(hermesSingleton.id, RUNTIME_IDS.HERMES);

  const services = new AgentServices({});
  assert.strictEqual(services.canUseOpenClaw({ settings: { defaultProvider: "openclaw" } }), true);
  assert.strictEqual(services.canUseOpenClaw({ settings: { defaultProvider: "relay" } }), false);
  assert.strictEqual(services.canUseOpenClaw({ settings: { defaultProvider: "relay", agentRuntime: "openclaw" } }), true);
  assert.strictEqual(services.canUseOpenClaw({ settings: { defaultProvider: "openclaw", agentRuntime: "hermes" } }), true);
  assert.strictEqual(services.canUseOpenClaw({ settings: { defaultProvider: "hermes" } }), true);

  const mainSource = require("node:fs").readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(mainSource, /require\("\.\/services\/runtime"\)/);
  assert.match(mainSource, /function ensureAgentRuntime\(/);
  assert.match(mainSource, /agentRuntime/);
  assert.match(mainSource, /hermes:/);
  assert.doesNotMatch(mainSource, /new GatewayClient\s*\(/);
  assert.doesNotMatch(mainSource, /require\("\.\/gateway-client"\)/);

  return {
    ok: true,
    cases: [
      "runtime_id_normalization",
      "registered_runtime_ids",
      "resolve_runtime_id_from_settings",
      "openclaw_runtime_shape",
      "openclaw_runtime_start_connect_chat_history_abort",
      "openclaw_runtime_missing_binary_returns_false",
      "hermes_runtime_implemented",
      "hermes_runtime_chat_history_abort",
      "hermes_remote_baseurl_startable",
      "local_runtime_reserved",
      "unsupported_runtime_rejected",
      "runtime_factory_singleton",
      "runtime_factory_switches_on_id_change",
      "agent_services_runtime_gate_includes_hermes",
      "main_uses_runtime_factory_not_direct_gateway_client"
    ]
  };
}

if (require.main === module) {
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
}

module.exports = { run };
