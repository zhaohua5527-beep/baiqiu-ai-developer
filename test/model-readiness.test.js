"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { modelConfigurationRequiredText, selectedModelReadiness } = require("../services/model-readiness");

test("default cloud model without a credential is not ready", () => {
  const result = selectedModelReadiness({
    defaultProvider: "deepseek",
    providers: {
      deepseek: { name: "DeepSeek", model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1", apiKey: "" }
    }
  });

  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, ["enabled", "credential", "verification"]);
  assert.match(modelConfigurationRequiredText(), /baiqiu:\/\/open-model-manager/);
});

test("configured cloud and credential-free local models are ready", () => {
  assert.equal(selectedModelReadiness({
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        model: "deepseek-chat",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "configured",
        enabled: true,
        verifiedAt: "2026-08-19T00:00:00.000Z",
        verifiedModel: "deepseek-chat",
        verifiedBaseURL: "https://api.deepseek.com/v1"
      }
    }
  }).configured, true);

  assert.equal(selectedModelReadiness({
    defaultProvider: "local",
    providers: {
      local: {
        model: "local-model",
        baseURL: "http://127.0.0.1:11434/v1",
        requiresApiKey: false,
        enabled: true,
        verifiedAt: "2026-08-19T00:00:00.000Z",
        verifiedModel: "local-model",
        verifiedBaseURL: "http://127.0.0.1:11434/v1"
      }
    }
  }).configured, true);
});

test("verified base URL accepts an equivalent full completion endpoint", () => {
  const result = selectedModelReadiness({
    defaultProvider: "custom-provider",
    providers: {
      "custom-provider": {
        name: "Custom Provider",
        model: "custom-model",
        baseURL: "https://example.test/v1/chat/completions",
        apiKey: "configured",
        enabled: true,
        verifiedAt: "2026-08-27T00:00:00.000Z",
        verifiedModel: "custom-model",
        verifiedBaseURL: "https://example.test/v1"
      }
    }
  });

  assert.equal(result.configured, true);
  assert.deepEqual(result.missing, []);
});

test("renderer preserves the exact internal model-manager and first-use guide links", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  assert.match(renderer, /href === "baiqiu:\/\/open-model-manager"/);
  assert.match(renderer, /if \(href === "baiqiu:\/\/open-model-manager"\) return/);
  assert.match(renderer, /if \(href === "baiqiu:\/\/open-first-use-guide"\) return/);
  assert.match(renderer, /openSettingsTab\("model"\)/);
  assert.match(renderer, /openFirstUseGuide\(\)/);
});

test("fresh installs seed one welcome message and submissions preflight model readiness", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const initBlock = main.slice(main.indexOf('ipcMain.handle("app:init"'), main.indexOf('ipcMain.handle("product:submit-task"'));
  const submitBlock = main.slice(main.indexOf('ipcMain.handle("product:submit-task"'), main.indexOf('ipcMain.handle("product:query-task"'));

  assert.match(initBlock, /if \(!db\.sessions\.length\)/);
  assert.match(initBlock, /seedFirstLaunchWelcome\(session\.id\)/);
  assert.match(main, /\[打开新手手册\]\(baiqiu:\/\/open-first-use-guide\)/);
  assert.match(main, /db\.settings\.firstUseGuide = \{/);
  assert.match(main, /pending: true/);
  assert.doesNotMatch(main, /\*\*先连接模型\*\*/);
  assert.match(main, /回答质量和速度主要取决于模型及其服务状态/);
  assert.ok(submitBlock.indexOf("selectedModelReadiness") < submitBlock.indexOf("ensureTaskBrain"));
  assert.match(submitBlock, /modelConfigurationRequiredResult/);
});
