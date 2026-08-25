const { RUNTIME_IDS, assertRuntimeShape, normalizeRuntimeId } = require("./runtime-port");
const { OpenClawRuntime } = require("./openclaw-runtime");
const { HermesRuntime } = require("./hermes-runtime");

let singleton = null;
let singletonKey = "";

function createAgentRuntime(id = RUNTIME_IDS.OPENCLAW, options = {}) {
  const runtimeId = normalizeRuntimeId(id, RUNTIME_IDS.OPENCLAW);

  if (runtimeId === RUNTIME_IDS.OPENCLAW) {
    const runtime = new OpenClawRuntime(options);
    assertRuntimeShape(runtime, "OpenClawRuntime");
    return runtime;
  }

  if (runtimeId === RUNTIME_IDS.HERMES) {
    const runtime = new HermesRuntime(options);
    assertRuntimeShape(runtime, "HermesRuntime");
    return runtime;
  }

  if (runtimeId === RUNTIME_IDS.LOCAL) {
    const error = new Error("Local-only runtime adapter is reserved. Current local path uses Baiqiu strategies without an external agent runtime.");
    error.code = "RUNTIME_NOT_IMPLEMENTED";
    error.runtimeId = RUNTIME_IDS.LOCAL;
    throw error;
  }

  const error = new Error(`Unsupported agent runtime: ${runtimeId}`);
  error.code = "RUNTIME_UNSUPPORTED";
  error.runtimeId = runtimeId;
  throw error;
}

function getAgentRuntime(options = {}) {
  const runtimeId = normalizeRuntimeId(options.id || options.runtimeId || RUNTIME_IDS.OPENCLAW);
  // Include enough config fingerprint so switching settings.agentRuntime rebuilds the singleton.
  const key = [
    runtimeId,
    options.appRoot || "",
    options.config?.baseURL || "",
    options.config?.port || "",
    options.config?.command || ""
  ].join("::");
  if (!singleton || singletonKey !== key) {
    singleton = createAgentRuntime(runtimeId, options);
    singletonKey = key;
  }
  return singleton;
}

function resetAgentRuntimeForTests() {
  singleton = null;
  singletonKey = "";
}

function listRegisteredRuntimeIds() {
  return [RUNTIME_IDS.OPENCLAW, RUNTIME_IDS.HERMES, RUNTIME_IDS.LOCAL];
}

function resolveRuntimeIdFromSettings(settings = {}, fallback = RUNTIME_IDS.OPENCLAW) {
  const explicit = settings.agentRuntime || settings.runtimeId || "";
  if (explicit) return normalizeRuntimeId(explicit, fallback);
  // Backward compatible: selecting provider=openclaw implies openclaw runtime.
  if (String(settings.defaultProvider || "").toLowerCase() === "openclaw") {
    return RUNTIME_IDS.OPENCLAW;
  }
  if (String(settings.defaultProvider || "").toLowerCase() === "hermes") {
    return RUNTIME_IDS.HERMES;
  }
  return normalizeRuntimeId(fallback, RUNTIME_IDS.OPENCLAW);
}

module.exports = {
  createAgentRuntime,
  getAgentRuntime,
  resetAgentRuntimeForTests,
  listRegisteredRuntimeIds,
  resolveRuntimeIdFromSettings,
  RUNTIME_IDS
};
