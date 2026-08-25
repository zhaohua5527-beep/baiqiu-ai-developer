const {
  RUNTIME_IDS,
  assertRuntimeShape,
  createRuntimeSessionKey,
  normalizeRuntimeId
} = require("./runtime-port");
const {
  createAgentRuntime,
  getAgentRuntime,
  resetAgentRuntimeForTests,
  listRegisteredRuntimeIds,
  resolveRuntimeIdFromSettings
} = require("./runtime-factory");
const { OpenClawRuntime } = require("./openclaw-runtime");
const { HermesRuntime, defaultHermesConfig } = require("./hermes-runtime");
const { HermesClient } = require("./hermes-client");

module.exports = {
  RUNTIME_IDS,
  assertRuntimeShape,
  createRuntimeSessionKey,
  normalizeRuntimeId,
  createAgentRuntime,
  getAgentRuntime,
  resetAgentRuntimeForTests,
  listRegisteredRuntimeIds,
  resolveRuntimeIdFromSettings,
  OpenClawRuntime,
  HermesRuntime,
  HermesClient,
  defaultHermesConfig
};
