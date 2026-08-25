"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 模型接入校验修复：probeProvider 用 max_tokens=32 对推理模型不兼容——
// 推理模型（deepseek-v4-flash 等）会先消耗 token 思考，32 个不够输出正式回复，
// content 为空导致"没有返回校验词"。已提高到 512。
test("probeProvider uses adequate max_tokens for reasoning models", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "services", "model-adapter.js"), "utf8");
  const probeStart = source.indexOf("async function probeProvider");
  const segment = source.slice(probeStart, probeStart + 1200);
  assert.match(segment, /max_tokens: 512/);
  assert.ok(!/max_tokens: 32/.test(segment), "old 32-token cap must be gone");
  assert.match(segment, /推理模型/);
});

// 集成测试：模拟推理模型（content 只在 token 足够时返回）验证 probeProvider 判定
test("probeProvider accepts a reasoning model reply when content carries the token", async () => {
  const { probeProvider } = require("../services/model-adapter");
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "BAIQIU_MODEL_OK" } }]
    })
  });
  const result = await probeProvider({
    providerId: "deepseek",
    provider: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiStyle: "openai", apiKey: "sk-test-key" },
    fetchImpl: fakeFetch
  });
  assert.equal(result.verified, true);
});
