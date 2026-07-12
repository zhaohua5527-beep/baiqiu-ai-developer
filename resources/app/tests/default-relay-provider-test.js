const assert = require("node:assert");

const { DEFAULT_RELAY_PROVIDER } = require("../config");
const { PRESET_PROVIDERS, normalizeProvider, callChatCompletion } = require("../services/model-adapter");

async function run() {
  const expectedRelay = {
    name: "默认中转站",
    baseURL: "https://sub2.hhlai.xyz/v1",
    model: "gpt-5.5"
  };

  assert.deepStrictEqual(DEFAULT_RELAY_PROVIDER, expectedRelay);
  assert.strictEqual(PRESET_PROVIDERS.relay.baseURL, expectedRelay.baseURL);
  assert.strictEqual(PRESET_PROVIDERS.relay.model, expectedRelay.model);

  const provider = normalizeProvider("relay", { apiKey: "test-key" });
  let request;
  const response = await callChatCompletion({
    providerId: "relay",
    provider,
    body: { messages: [{ role: "user", content: "Hello" }] },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Hi" } }] })
      };
    }
  });

  assert.strictEqual(request.url, "https://sub2.hhlai.xyz/v1/chat/completions");
  assert.strictEqual(request.options.headers.Authorization, "Bearer test-key");
  assert.strictEqual(JSON.parse(request.options.body).model, "gpt-5.5");
  assert.strictEqual(response.choices[0].message.content, "Hi");

  return {
    ok: true,
    cases: [
      "default_relay_provider_export",
      "relay_preset_uses_default_base_url_and_model",
      "relay_chat_completion_uses_openai_compatible_request"
    ]
  };
}

if (require.main === module) {
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
}

module.exports = { run };
