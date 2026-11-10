"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");

function between(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
}

function setup() {
  const settings = { defaultProvider: "deepseek", modelConfigRevision: "initial", modelConfigGeneration: 1, providers: {
    deepseek: { name: "DeepSeek", apiKey: "old-fixture", model: "model-a", baseURL: "https://a.invalid/v1", enabled: true },
    custom: { name: "Custom", apiKey: "other-fixture", model: "model-b", baseURL: "https://b.invalid/v1", enabled: true }
  } };
  Object.assign(window, {
    state: { db: { settings }, providerModelErrors: {}, providerModelStatus: {}, providerModels: {}, providerLastChecked: {}, modelConfigSaving: false },
    requests: [], toasts: [], configuredModelList: document.querySelector("#models"), providerSelect: document.querySelector("#provider"),
    currentModelCard: null, modelCenterCurrentName: null, modelCenterCurrentId: null, modelCenterCurrentStatus: null,
    modelCenterCurrentCapabilities: null, modelSortSelect: null, configuredModelCount: null,
    PROVIDER_API_KEY_URLS: {}, providerConnectionState: () => ({ online: true }), providerVerificationMatches: () => true,
    modelPresentationProfile: () => ({ capabilities: [] }), modelSortMode: () => "recommended",
    orderedModelProviders: providers => Object.entries(providers), modelProviderIcon: () => "", renderProviderHealthPanel() {},
    escapeHtml: value => String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    showCopyToast: message => window.toasts.push(message), setModelConfigSaveState() {},
    renderSettings: () => renderModelCenterOverview(), refreshModelCatalog: async () => null,
    tryOpenExternalUrl() {}
  });
  window.api = {
    configureModel: payload => new Promise((resolve, reject) => window.requests.push({ kind: "save", payload, resolve, reject })),
    activateModel: payload => new Promise((resolve, reject) => window.requests.push({ kind: "activate", payload, resolve, reject })),
    modelSettings: async () => structuredClone(window.state.db.settings),
    onModelConfigurationProgress: callback => { window.reportProgress = callback; }
  };
}

async function checks() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const card = key => [...document.querySelectorAll("[data-provider-card]")].find(element => element.dataset.providerCard === key);
  const keyInput = () => card("deepseek").querySelector("input");
  const saveButton = () => card("deepseek").querySelector("[data-confirm-api-key]");
  renderModelCenterOverview();
  keyInput().value = "new-fixture";
  keyInput().dispatchEvent(new Event("input", { bubbles: true }));
  saveButton().click();
  saveButton().click();
  await pause();
  check(requests.length === 1, "Double click duplicated request");
  check(saveButton().disabled && saveButton().textContent.includes("验证"), "Saved was shown before validation");
  check(keyInput().value === "new-fixture" && keyInput().readOnly, "Pending key was lost or editable");
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 5);
  await pause();
  clearInterval(interval);
  check(ticks > 1, "Pending validation blocked UI timer");
  document.querySelector("#composer").value = "未发送草稿";
  reportProgress({ requestId: requests[0].payload.requestId, stage: "saving" });
  check(saveButton().textContent.includes("正在保存"), "Real save stage was not shown");
  requests[0].reject(new Error("fixture unauthorized"));
  await pause();
  check(keyInput().value === "new-fixture" && !saveButton().disabled, "Failure discarded draft or left button blocked");
  check(card("deepseek").textContent.includes("本次操作失败"), "Failure was hidden by old saved configuration");
  saveButton().click();
  const saved = structuredClone(state.db.settings);
  saved.providers.deepseek.apiKey = "new-fixture";
  saved.modelConfigRevision = "saved";
  saved.modelConfigGeneration = 2;
  requests[1].resolve({ ok: true, settings: saved, provider: saved.providers.deepseek });
  await pause();
  check(saveButton().textContent === "已保存" && keyInput().value === API_KEY_MASK, "Committed save did not mask key");
  check(state.db.settings.providers.deepseek.apiKey === "new-fixture", "New key not accepted");
  card("custom").click();
  await pause();
  check(requests[2].kind === "activate" && state.db.settings.defaultProvider === "deepseek", "Provider changed before confirmation");
  requests[2].reject(new Error("fixture apply failed"));
  await pause();
  check(state.db.settings.defaultProvider === "deepseek", "Failed switch replaced old provider");
  card("custom").click();
  const switched = structuredClone(state.db.settings);
  switched.defaultProvider = "custom";
  switched.modelConfigRevision = "switched";
  switched.modelConfigGeneration = 3;
  requests[3].resolve({ ok: true, settings: switched });
  await pause();
  check(state.db.settings.defaultProvider === "custom" && card("custom").classList.contains("selected"), "Confirmed switch did not update card");
  check(document.querySelector("#composer").value === "未发送草稿", "Saving changed composer draft");
  return { pending: true, duplicate: true, draft: true, failure: true, switch: true, timers: true };
}

if (process.argv.includes("--model-settings-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.BAIQIU_MODEL_TEST_PROFILE);
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<div id="models"></div><select id="provider"></select><textarea id="composer"></textarea>'));
    const functions = between("async function useModelProvider(", "\nasync function toggleModelProvider(")
      + between("const API_KEY_MASK =", "\nasync function deleteProviderApiKey(")
      + between("function configuredProviderCardState(", "\nasync function renderProviderHealthPanel(");
    const result = await window.webContents.executeJavaScript("(" + setup.toString() + ")();\n" + functions + "\n(" + checks.toString() + ")()");
    console.log("MODEL_SETTINGS_DOM=" + JSON.stringify(result));
    window.destroy();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  test("model manager real DOM preserves drafts and confirms saves and switches exactly once", context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-model-dom-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, BAIQIU_MODEL_TEST_PROFILE: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require("node:child_process").spawnSync(require("electron"), [__filename, "--model-settings-dom"], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 20000
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /MODEL_SETTINGS_DOM=.*"switch":true/);
  });
}
