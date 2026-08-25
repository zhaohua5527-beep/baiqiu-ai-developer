"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureBundledHermesHome } = require("../services/hermes-bundled-runtime");

function createRuntime(root) {
  const runtime = path.join(root, "runtime");
  const agent = path.join(runtime, "hermes", "hermes-agent");
  fs.mkdirSync(path.join(runtime, "python"), { recursive: true });
  fs.mkdirSync(path.join(agent, "venv", "Lib", "site-packages"), { recursive: true });
  fs.mkdirSync(path.join(agent, "acp_adapter"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "hermes", "skills"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "hermes", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "python", "python.exe"), "runtime");
  fs.writeFileSync(path.join(agent, "acp_adapter", "entry.py"), "entry");
  fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), '{"version":"one"}');
  fs.writeFileSync(path.join(runtime, "hermes", "skills", "base.md"), "base");
  fs.writeFileSync(path.join(runtime, "hermes", "SOUL.md"), "soul");
  return runtime;
}

test("bundled Hermes home skips recursive copying until the runtime manifest changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-home-cache-"));
  try {
    const runtime = createRuntime(root);
    const home = path.join(root, "home");
    const options = { bundledRuntimePath: runtime, hermesHome: home };
    const first = ensureBundledHermesHome(options);
    assert.equal(first.cached, false);
    assert.equal(fs.existsSync(path.join(home, "skills", "base.md")), true);
    const modelsDevCache = JSON.parse(fs.readFileSync(path.join(home, "models_dev_cache.json"), "utf8"));
    assert.deepEqual(modelsDevCache.__baiqiu_offline_fallback__.models, {});

    fs.writeFileSync(path.join(runtime, "hermes", "skills", "later.md"), "later");
    const cached = ensureBundledHermesHome(options);
    assert.equal(cached.cached, true);
    assert.equal(fs.existsSync(path.join(home, "skills", "later.md")), false);

    fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), '{"version":"two"}');
    const refreshed = ensureBundledHermesHome(options);
    assert.equal(refreshed.cached, false);
    assert.equal(fs.existsSync(path.join(home, "skills", "later.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real models.dev cache is never replaced by the offline fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-model-cache-"));
  try {
    const runtime = createRuntime(root);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const cachePath = path.join(home, "models_dev_cache.json");
    const realCache = { deepseek: { models: { "deepseek-chat": { limit: { context: 64000 } } } } };
    fs.writeFileSync(cachePath, JSON.stringify(realCache));
    ensureBundledHermesHome({ bundledRuntimePath: runtime, hermesHome: home });
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), realCache);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
