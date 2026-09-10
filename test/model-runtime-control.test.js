"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  conversationModelIds,
  mapModelCapabilities,
  probeReasoningControl,
  probeProvider,
  verifyProviderConnection
} = require("../services/model-adapter");
const {
  providerCredentialFingerprint,
  providerVerificationMatches,
  selectModelRoute
} = require("../services/model-route-policy");

test("provider discovery keeps conversational models out of speech controls", () => {
  assert.deepEqual(conversationModelIds([
    "mimo-v2.5-pro",
    "mimo-v2.5-asr",
    "mimo-v2.5-tts",
    "mimo-v2.5"
  ]), ["mimo-v2.5-pro", "mimo-v2.5"]);
});

test("discovered model IDs receive conservative reasoning capability mappings", () => {
  const mapped = mapModelCapabilities([
    "gpt-5.6-sol",
    "deepseek-reasoner",
    "vendor-chat-v2"
  ], { apiStyle: "openai" });

  assert.equal(mapped["gpt-5.6-sol"].reasoningMode, "native-candidate");
  assert.equal(mapped["gpt-5.6-sol"].reasoningVerified, false);
  assert.equal(mapped["deepseek-reasoner"].reasoningMode, "native-fixed");
  assert.equal(mapped["vendor-chat-v2"].reasoningMode, "prompt");
});

test("native reasoning is marked verified only after a real reasoning_effort request succeeds", async () => {
  let sentBody = null;
  const capability = await probeReasoningControl({
    providerId: "custom-test",
    provider: {
      name: "Proxy",
      baseURL: "https://proxy.example/v1",
      model: "gpt-5.6-sol",
      apiStyle: "openai",
      apiKey: "test"
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "BAIQIU_MODEL_OK" } }] })
      };
    }
  });

  assert.equal(sentBody.reasoning_effort, "low");
  assert.equal(capability.reasoningMode, "native");
  assert.equal(capability.reasoningVerified, true);
});

test("connection probe accepts non-empty model output and records instruction compliance separately", async () => {
  const result = await probeProvider({
    providerId: "xiaomi",
    provider: {
      baseURL: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
      apiStyle: "openai",
      apiKey: "test"
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "连接正常" } }] })
    })
  });

  assert.equal(result.verified, true);
  assert.equal(result.instructionCompliant, false);
});

test("verification rejects a selected model omitted by the provider account", async () => {
  await assert.rejects(() => verifyProviderConnection({
    providerId: "xiaomi",
    provider: {
      name: "Xiaomi MiMo",
      baseURL: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-flash",
      apiStyle: "openai",
      apiKey: "test"
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "mimo-v2.5" }, { id: "mimo-v2.5-pro" }] })
    })
  }), /不支持文本模型 mimo-v2\.5-flash/);
});

test("model routing only uses enabled and exactly verified providers", () => {
  const settings = {
    defaultProvider: "xiaomi",
    providers: {
      xiaomi: {
        enabled: true,
        model: "mimo-v2.5-flash",
        baseURL: "https://api.xiaomimimo.com/v1",
        apiKey: "configured"
      },
      deepseek: {
        enabled: true,
        model: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "configured",
        verifiedAt: "2026-08-19T00:00:00.000Z",
        verifiedModel: "deepseek-v4-flash",
        verifiedBaseURL: "https://api.deepseek.com/v1"
      }
    }
  };

  const route = selectModelRoute(settings);
  assert.equal(route.providerId, "deepseek");
  assert.equal(route.fallback, true);
});

test("saved verification remains reusable until its credential changes", () => {
  const provider = {
    enabled: false,
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "first-key",
    verifiedAt: "2026-08-28T00:00:00.000Z",
    verifiedModel: "deepseek-chat",
    verifiedBaseURL: "https://api.deepseek.com/v1"
  };
  provider.verifiedCredentialFingerprint = providerCredentialFingerprint("deepseek", provider);

  assert.equal(providerVerificationMatches("deepseek", provider), true);
  assert.equal(providerVerificationMatches("deepseek", { ...provider, apiKey: "replacement-key" }), false);
});

test("renderer controls use transactional Black Ball runtime APIs", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.doesNotMatch(renderer, /const MODEL_VERSION_SUGGESTIONS/);
  assert.match(renderer, /api\.configureModel\(/);
  assert.match(renderer, /api\.setModelReasoning\(/);
  assert.match(preload, /models:configure/);
  assert.match(preload, /models:set-reasoning/);
  assert.match(main, /ipcMain\.handle\("models:configure"/);
  assert.match(main, /blackBallRuntimeReceipt/);
  assert.match(main, /hermesForegroundClient = null/);
});

test("runtime controls preserve discovered models and distinguish native from prompt reasoning", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(renderer, /Array\.isArray\(provider\.availableModels\)/);
  assert.match(renderer, /modeLabel: "黑球推理强度"/);
  assert.match(renderer, /modeLabel: "模型原生推理 · 接口已验证"/);
  assert.match(main, /reasoningMode === "native"/);
  assert.match(main, /modelCapabilities/);
  assert.match(main, /selectedModelReadiness\(settings\)\.configured/);
  assert.match(main, /runModelRuntimeTransition\(\s*\(\) => verifiedProviderConfiguration\(/);
  assert.match(main, /enable: true/);
  assert.match(main, /activate: true/);
});

test("saved credentials are reconciled into the Black Ball runtime without re-entry", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(main, /async function reconcileSelectedModelRuntime\(\)/);
  assert.match(main, /readiness\.missing\.length === 1/);
  assert.match(main, /if \(!modelRuntimeStartupReconciled\) clearHermesSessionBindings\(next\)/);
  assert.match(main, /saveDb\(next, \{ immediate: true, requireCommit: true \}\)/);
  assert.match(main, /ipcMain\.handle\("models:runtime-state", \(\) => runModelRuntimeTransition\(\(\) => reconcileSelectedModelRuntime\(\)\)\)/);
  assert.match(renderer, /await api\.modelRuntimeState\?\.\(\)/);
  assert.doesNotMatch(renderer, /setTimeout\(async \(\) => \{\s*try \{\s*const receipt = await api\.modelRuntimeState/);
  assert.match(renderer, /label: "待验证"/);
  assert.match(renderer, /label: "已验证 · 未启用"/);
  assert.doesNotMatch(renderer, /provider\.enabled \|\| selected \? " checked"/);
});

test("saved API keys remain visibly masked and the mask is never submitted as a credential", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

  assert.match(renderer, /const API_KEY_MASK = "\*{15}"/);
  assert.match(renderer, /data-saved-api-key=/);
  assert.match(renderer, /value === API_KEY_MASK && provider\.apiKey/);
  assert.match(renderer, /apiKeyInput\?\.dataset\.savedApiKey === "1" && apiKeyValue === API_KEY_MASK/);
  assert.match(renderer, /saved \? "已保存" : "验证并保存"/);
  assert.doesNotMatch(renderer, /value="\$\{escapeHtml\(provider\.apiKey \|\| ""\)\}"/);
});

test("composer model switching updates locally without reloading the full database or showing a toast", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const start = renderer.indexOf("async function selectModelVersion");
  const end = renderer.indexOf("\nfunction closeModelConfigDrawer", start);
  const body = renderer.slice(start, end);

  assert.match(body, /provider\.model = version/);
  assert.match(body, /modelVersionSwitchRevision/);
  assert.match(body, /state\.db\.settings\.providers\[key\] =/);
  assert.doesNotMatch(body, /await api\.init\(\)/);
  assert.doesNotMatch(body, /renderSettings\(/);
  assert.doesNotMatch(body, /showCopyToast\(/);
});

test("chat and product requests wait for the model runtime transition", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const productStart = main.indexOf('ipcMain.handle("product:submit-task"');
  const productEnd = main.indexOf('ipcMain.handle("product:query-task"', productStart);
  const productBody = main.slice(productStart, productEnd);
  const chatStart = main.indexOf('ipcMain.handle("chat:send"');
  const chatEnd = main.indexOf('ipcMain.on("chat:abort-signal"', chatStart);
  const chatBody = main.slice(chatStart, chatEnd);

  assert.match(main, /function runModelRuntimeTransition\(task\)/);
  assert.match(main, /function waitForModelRuntimeTransition\(signal = null\)/);
  assert.match(productBody, /await waitForModelRuntimeTransition\(controller\.signal\)/);
  assert.match(chatBody, /await waitForModelRuntimeTransition\(controller\.signal\)/);
  assert.ok(productBody.indexOf("activeRuns.set(sessionId") < productBody.indexOf("waitForModelRuntimeTransition(controller.signal)"));
  assert.ok(chatBody.indexOf("activeRuns.set(session.id") < chatBody.indexOf("waitForModelRuntimeTransition(controller.signal)"));
  assert.match(main, /models:configure[\s\S]*runModelRuntimeTransition/);
});

test("smart model recommendations read settings from the persisted database", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = main.indexOf("ipcMain.handle('model:recommend'");
  const body = main.slice(start, start + 500);

  assert.match(body, /const settings = loadDb\(\)\.settings/);
  assert.doesNotMatch(body, /readSettings\(\)/);
});
