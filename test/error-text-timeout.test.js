"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { userFacingError } = require("../services/user-facing-error-adapter");
const { callChatCompletion } = require("../services/model-adapter");

test("real timeout (最长允许时长) is reported as timeout, not as security block", () => {
  const err = {
    code: "NC3001",
    message: "NC3001 Tool Failure: 任务超过最长允许时长（local_create）",
    meta: { errorCode: "TASK_HARD_TIMEOUT (NC3001)" }
  };
  const text = userFacingError(err);
  assert.ok(text.includes("超过允许时长") || text.includes("超时"), `should report timeout, got: ${text}`);
  assert.ok(!text.includes("没有安全地进入执行链"), "must not be reported as security block");
});

test("plain timeout keywords map to timeout text", () => {
  const text = userFacingError({ message: "timeout after 90000ms" });
  assert.ok(text.includes("超时") || text.includes("允许时长"), `got: ${text}`);
});

test("permission errors still map to permission text", () => {
  const text = userFacingError({ code: "NC3001", message: "NC3001 Tool Failure: EACCES permission denied" });
  assert.ok(text.includes("权限"), `got: ${text}`);
});

test("provider HTTP 402 errors retain status and become a Chinese actionable message", async () => {
  await assert.rejects(
    () => callChatCompletion({
      providerId: "xiaomi",
      provider: { apiKey: "test-key" },
      body: { model: "mimo-v2.5-pro", messages: [{ role: "user", content: "你好" }] },
      fetchImpl: async () => ({
        ok: false,
        status: 402,
        headers: { get: () => "application/json" },
        json: async () => ({ error: { message: "Billing or credits exhausted: HTTP 402: Insufficient account balance" } })
      })
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_HTTP_402");
      assert.equal(error.status, 402);
      assert.equal(error.providerId, "xiaomi");
      assert.match(userFacingError(error), /账户余额或额度不足/);
      assert.doesNotMatch(userFacingError(error), /Billing|Insufficient|account balance/);
      return true;
    }
  );
});

test("billing text is localized even when an upstream adapter only provides a raw message", () => {
  const text = userFacingError({
    message: "Billing or credits exhausted: HTTP 402: Insufficient account balance"
  });
  assert.match(text, /本次请求未执行/);
  assert.doesNotMatch(text, /Billing|Insufficient|account balance/);
});
