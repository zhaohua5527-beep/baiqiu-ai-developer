# Default Relay Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make relay the default model provider for new Baiqiu AI installations, using the approved OpenAI-compatible endpoint and model without storing an API key.

**Architecture:** Define the relay defaults once in resources/app/config.js, consume them from the provider adapter, and add the provider to main.js first-run database defaults. Existing saved settings retain their own defaultProvider; only absent values fall back to relay.

**Tech Stack:** Node.js CommonJS, Electron main process, Node assert tests.

---

## File structure

- resources/app/config.js owns shared non-secret relay defaults.
- resources/app/services/model-adapter.js owns OpenAI-compatible provider normalization and HTTP request construction.
- resources/app/main.js owns first-run settings and provider registration.
- resources/app/tests/default-relay-provider-test.js verifies the provider contract without a real API key or network request.
- resources/app/tests/default-relay-settings-test.js verifies first-run default settings from source.

### Task 1: Define and verify the relay provider contract

**Files:**

- Create: resources/app/tests/default-relay-provider-test.js
- Modify: resources/app/config.js:11-18,50
- Modify: resources/app/services/model-adapter.js:1-10

- [ ] **Step 1: Write the failing provider-contract test**

~~~js
const assert = require("node:assert");
const { DEFAULT_RELAY_PROVIDER } = require("../config");
const { PRESET_PROVIDERS, normalizeProvider, callChatCompletion } = require("../services/model-adapter");

async function main() {
  assert.deepEqual(DEFAULT_RELAY_PROVIDER, {
    name: "默认中转站",
    baseURL: "https://sub2.hhlai.xyz/v1",
    model: "gpt-5.5"
  });
  assert.equal(PRESET_PROVIDERS.relay.baseURL, DEFAULT_RELAY_PROVIDER.baseURL);
  assert.equal(PRESET_PROVIDERS.relay.model, DEFAULT_RELAY_PROVIDER.model);

  const normalized = normalizeProvider("relay", { apiKey: "test-key" });
  assert.equal(normalized.baseURL, "https://sub2.hhlai.xyz/v1");
  assert.equal(normalized.model, "gpt-5.5");
  assert.equal(normalized.requiresApiKey, true);

  let request = null;
  await callChatCompletion({
    providerId: "relay",
    provider: { ...PRESET_PROVIDERS.relay, apiKey: "test-key" },
    body: { messages: [{ role: "user", content: "ping" }] },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "pong" } }] })
      };
    }
  });

  assert.equal(request.url, "https://sub2.hhlai.xyz/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(request.options.body).model, "gpt-5.5");
  console.log(JSON.stringify({ ok: true, cases: ["relay_defaults", "relay_request_url", "relay_bearer_auth"] }));
}

main().catch((error) => { console.error(error); process.exit(1); });
~~~

- [ ] **Step 2: Run the test and verify that it fails before implementation**

Run:

~~~powershell
$env:TEMP='D:\Codex\.tmp'; $env:TMP=$env:TEMP
node resources\app\tests\default-relay-provider-test.js
~~~

Expected: failure because DEFAULT_RELAY_PROVIDER and PRESET_PROVIDERS.relay do not yet exist.

- [ ] **Step 3: Add the shared non-secret relay configuration**

Add this below CLOUD_MODEL_DEFAULTS in resources/app/config.js:

~~~js
const DEFAULT_RELAY_PROVIDER = {
  name: "默认中转站",
  baseURL: "https://sub2.hhlai.xyz/v1",
  model: "gpt-5.5"
};
~~~

Change the export to:

~~~js
module.exports = { getOpenClawConfig, CLOUD_MODEL_DEFAULTS, DEFAULT_RELAY_PROVIDER };
~~~

At the top of resources/app/services/model-adapter.js, import the constant and add this provider before deepseek:

~~~js
const { DEFAULT_RELAY_PROVIDER } = require("../config");

const PRESET_PROVIDERS = {
  relay: { ...DEFAULT_RELAY_PROVIDER, apiStyle: "openai", requiresApiKey: true },
  deepseek: { name: "供应商2", baseURL: "https://codekey.buzz/keys", model: "deepseek-chat", apiStyle: "openai", requiresApiKey: true },
~~~

Do not add apiKey to either shared constant or preset.

- [ ] **Step 4: Run the provider-contract test and verify that it passes**

Run:

~~~powershell
$env:TEMP='D:\Codex\.tmp'; $env:TMP=$env:TEMP
node resources\app\tests\default-relay-provider-test.js
~~~

Expected: exit code 0 and all three JSON case names.

- [ ] **Step 5: Commit the provider contract**

~~~powershell
git add resources/app/config.js resources/app/services/model-adapter.js resources/app/tests/default-relay-provider-test.js
git commit -m "feat: add default relay provider"
~~~

### Task 2: Make relay the first-run application default

**Files:**

- Create: resources/app/tests/default-relay-settings-test.js
- Modify: resources/app/main.js:11,432,506-518,533

- [ ] **Step 1: Write the failing first-run-settings test**

~~~js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function main() {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(source, /DEFAULT_RELAY_PROVIDER/);
  assert.match(source, /defaultProvider:\s*"relay"/);
  assert.match(source, /relay:\s*\{\s*\.\.\.DEFAULT_RELAY_PROVIDER,\s*enabled:\s*true,\s*apiKey:\s*""\s*\}/);
  assert.match(source, /db\.settings\.defaultProvider \|\|= "relay"/);
  assert(!source.includes('apiKey: "sk-'), "default settings must not embed an API key");
  console.log(JSON.stringify({ ok: true, cases: ["new_install_uses_relay", "relay_key_starts_empty", "legacy_settings_preserved"] }));
}

main();
~~~

- [ ] **Step 2: Run the test and verify that it fails before changing main.js**

Run:

~~~powershell
$env:TEMP='D:\Codex\.tmp'; $env:TMP=$env:TEMP
node resources\app\tests\default-relay-settings-test.js
~~~

Expected: failure because the current first-run default is deepseek.

- [ ] **Step 3: Register relay in fresh settings without migrating saved users**

Change the config import in resources/app/main.js to:

~~~js
const { getOpenClawConfig, CLOUD_MODEL_DEFAULTS, DEFAULT_RELAY_PROVIDER } = require("./config");
~~~

In defaultDb(), set:

~~~js
defaultProvider: "relay",
~~~

Add this as the first entry in the providers object:

~~~js
relay: { ...DEFAULT_RELAY_PROVIDER, enabled: true, apiKey: "" },
~~~

Keep the existing deepseek entry unchanged except set enabled to false. Change the loadDb fallback to:

~~~js
db.settings.defaultProvider ||= "relay";
~~~

Do not alter the providers merge loop: it preserves existing user-selected providers and API keys.

- [ ] **Step 4: Run both new tests**

Run:

~~~powershell
$env:TEMP='D:\Codex\.tmp'; $env:TMP=$env:TEMP
node resources\app\tests\default-relay-settings-test.js
node resources\app\tests\default-relay-provider-test.js
~~~

Expected: both commands exit with code 0.

- [ ] **Step 5: Commit the first-run default**

~~~powershell
git add resources/app/main.js resources/app/tests/default-relay-settings-test.js
git commit -m "feat: default new installs to relay"
~~~

### Task 3: Run regression checks and verify credential hygiene

**Files:**

- Verify: resources/app/package.json
- Verify: resources/app/tests/high-frequency-acceptance-test.js
- Verify: resources/app/tests/high-frequency-capabilities-test.js

- [ ] **Step 1: Run syntax and regression checks with D-drive temporary files**

Run:

~~~powershell
$env:TEMP='D:\Codex\.tmp'; $env:TMP=$env:TEMP
npm --prefix resources\app run check
node resources\app\tests\default-relay-provider-test.js
node resources\app\tests\default-relay-settings-test.js
node resources\app\tests\high-frequency-acceptance-test.js
node resources\app\tests\high-frequency-capabilities-test.js
~~~

Expected: every command exits with code 0.

- [ ] **Step 2: Check that no API key entered the repository**

Run:

~~~powershell
git diff --check
git grep -n -E 'apiKey:\s*["''](sk-|rk-|Bearer )' -- resources/app
git status --short
~~~

Expected: git diff --check has no output and the credential search has no matches.

- [ ] **Step 3: Commit the implementation plan before execution**

~~~powershell
git add docs/superpowers/plans/2026-07-12-default-relay-provider.md
git commit -m "docs: add relay provider implementation plan"
~~~

