"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const functions = source.slice(source.indexOf("function showUpdateBadge("), source.indexOf("function resetQuickUpdateVisual("));
const status = source.slice(source.indexOf("function renderUpdateStatus("), source.indexOf("function renderUpdateTabProgress("));

function harness() {
  const button = id => ({ id, dataset: {}, title: "", attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } });
  const settings = button("settingsBtn");
  const update = button("updateTabBtn");
  const context = vm.createContext({
    $: () => settings, updateTabBtn: update, updateQuickBtn: null, updateQuickBadge: null,
    updateContent: null, availableUpdateInfo: null,
    updateBadgeCheckPromise: null, updateBadgeCheckedAt: 0, updateOperationActive: false,
    Date, api: { updateInfo: async () => ({ configured: true, hasUpdate: false }) }
  });
  vm.runInContext(functions + status, context);
  return { context, settings, update };
}

const release = { configured: true, hasUpdate: true, currentVersion: "3.0.24", latestVersion: "3.0.25" };

test("both settings entries show the available version without the removed quick button", () => {
  const { context, settings, update } = harness();
  context.syncUpdateBadge(release);
  for (const button of [settings, update]) {
    assert.equal(button.dataset.updateBadge, "1");
    assert.match(button.attributes["aria-label"], /3\.0\.25/);
  }
});

test("checking, opening settings, downloading and failed updates keep the badge", () => {
  const { context, settings, update } = harness();
  context.syncUpdateBadge(release);
  for (const phase of ["checking", "available", "downloading", "verifying", "prepared", "restarting", "error"]) {
    context.renderUpdateStatus({ phase });
    assert.equal(settings.dataset.updateBadge, "1", phase);
    assert.equal(update.dataset.updateBadge, "1", phase);
  }
  context.syncUpdateBadge(null);
  context.syncUpdateBadge({ configured: false, hasUpdate: false });
  assert.equal(settings.dataset.updateBadge, "1");
});

test("confirmed current version and completed installation clear both entries", () => {
  const { context, settings, update } = harness();
  for (const finish of [() => context.syncUpdateBadge({ configured: true, hasUpdate: false }),
    () => context.renderUpdateStatus({ phase: "completed" }),
    () => context.renderUpdateStatus({ phase: "current" })]) {
    context.syncUpdateBadge(release);
    finish();
    assert.equal(settings.dataset.updateBadge, "0");
    assert.equal(update.dataset.updateBadge, "0");
    assert.equal(settings.title, "设置");
  }
});

test("background checks share pending work, throttle focus checks and retain badges on network failure", async () => {
  const { context, settings } = harness();
  let finish;
  let calls = 0;
  context.api.updateInfo = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = context.refreshUpdateBadge();
  const second = context.refreshUpdateBadge();
  assert.equal(calls, 1);
  finish(release);
  await Promise.all([first, second]);
  await context.refreshUpdateBadge();
  assert.equal(calls, 1);
  assert.equal(settings.dataset.updateBadge, "1");
  context.updateBadgeCheckedAt = 0;
  context.api.updateInfo = async () => { throw new Error("offline"); };
  await context.refreshUpdateBadge();
  assert.equal(settings.dataset.updateBadge, "1");
  assert.equal(context.updateBadgeCheckPromise, null);
});

test("no badge is invented for missing version information or unknown update state", () => {
  const { context, settings } = harness();
  context.syncUpdateBadge({ configured: true });
  context.showUpdateBadge({ hasUpdate: true });
  context.showUpdateBadge({ latestVersion: "3.0.25", hasUpdate: false });
  assert.equal(settings.dataset.updateBadge, undefined);
});
