"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { HermesConfigService, normalizeHermesReasoningEffort } = require("../services/hermes-config-service");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("maximum reasoning is the default and provider APIs receive reasoning_effort", () => {
  assert.match(mainSource, /const requestedLevel = String\(settings\.reasoning \|\| "maximum"\)/);
  assert.match(mainSource, /maximum: "xhigh"/);
  assert.match(mainSource, /reasoningTransportEvidence\(localSettings, "provider-api", body\)/);
  assert.match(mainSource, /providerReasoningEffort: transport === "provider-api"/);
});

test("HMS receives verified native reasoning with auditable transport evidence", () => {
  const hmsBody = mainSource.slice(
    mainSource.indexOf("async function runHermesSessionPrompt"),
    mainSource.indexOf("function recoverableHermesProtocolFailure")
  );
  assert.match(hmsBody, /buildSystemPrompt\(getPersonaProfile\(settings\), settings/);
  assert.match(hmsBody, /runtimeReasoning\.nativeReasoning \? "hms-native-reasoning" : "hms-system-prompt"/);
  assert.match(hmsBody, /reasoningTransport/);
  assert.match(mainSource, /promptInstructionIncluded: systemText\.includes\(expectedInstruction\)/);
  assert.match(mainSource, /nativeHmsReasoningParameter: nativeHmsReasoning/);
  assert.match(mainSource, /provesModelBehavior: false/);
});

test("Hermes runtime config persists only verified native reasoning effort", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-reasoning-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new HermesConfigService({ hermesHome: home });
  service.apply({
    provider: "custom-provider",
    model: "gpt-5.6-terra",
    baseURL: "https://example.invalid/v1",
    reasoning: "extra_high",
    nativeReasoning: true
  });
  assert.equal(normalizeHermesReasoningEffort("extra_high"), "xhigh");
  assert.equal(service.read().agent.reasoning_effort, "xhigh");

  service.apply({
    provider: "custom-provider",
    model: "plain-chat-model",
    baseURL: "https://example.invalid/v1",
    reasoning: "high",
    nativeReasoning: false
  });
  assert.equal(service.read().agent.reasoning_effort, undefined);
});

test("Hermes runtime config stores an OpenAI-compatible base URL instead of a full endpoint", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-endpoint-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new HermesConfigService({ hermesHome: home });
  service.apply({
    provider: "custom-provider",
    model: "chat-model",
    baseURL: "https://example.invalid/v1/chat/completions/"
  });
  const config = service.read();
  assert.equal(config.model.base_url, "https://example.invalid/v1");
  assert.equal(config.delegation.base_url, "https://example.invalid/v1");
  assert.equal(config.custom_providers[0].base_url, "https://example.invalid/v1");
});
