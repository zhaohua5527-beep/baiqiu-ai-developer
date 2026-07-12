const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mainPath = path.join(__dirname, "..", "main.js");
const mainSource = fs.readFileSync(mainPath, "utf8");
const defaultDbMatch = mainSource.match(/function defaultDb\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction dbPath/);
const defaultDbSource = defaultDbMatch ? defaultDbMatch[0] : "";

function run() {
  assert.ok(defaultDbSource, "defaultDb source should be present");
  assert.match(
    mainSource,
    /const \{ getOpenClawConfig, CLOUD_MODEL_DEFAULTS, DEFAULT_RELAY_PROVIDER \} = require\("\.\/config"\);/,
    "main should import DEFAULT_RELAY_PROVIDER"
  );
  assert.match(defaultDbSource, /defaultProvider:\s*"relay"/, "fresh defaults should select relay");
  assert.match(
    defaultDbSource,
    /providers:\s*\{\s*relay:\s*\{\s*\.\.\.DEFAULT_RELAY_PROVIDER,\s*enabled:\s*true,\s*apiKey:\s*""\s*\}/,
    "fresh defaults should provide an enabled relay provider without an API key"
  );
  assert.match(
    mainSource,
    /db\.settings\.defaultProvider \|\|= "relay";/,
    "loadDb should use relay when a saved default provider is absent"
  );
  assert.doesNotMatch(
    defaultDbSource,
    /apiKey\s*:\s*["']sk-/i,
    "default providers must not embed sk- API keys"
  );

  return {
    ok: true,
    cases: [
      "main_imports_default_relay_provider",
      "fresh_defaults_select_relay",
      "fresh_defaults_include_enabled_relay_without_api_key",
      "load_db_falls_back_to_relay",
      "default_sources_do_not_embed_sk_api_keys"
    ]
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run(), null, 2));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { run };
