"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { ClarificationHandler } = require("../services/response-router");

test("when HMS generation fails, clarification returns noSuggestion instead of fallback rules", async () => {
  const handler = new ClarificationHandler();
  // generate 抛错（模拟 HMS 不可用）
  const failingGenerate = async () => { throw new Error("HMS unavailable"); };
  const stage = await handler.nextStage(
    { originalRequest: "帮我做一个软件", round: 1, askedDimensions: [], confirmedDimensions: {}, candidates: [], evidence: [] },
    { generate: failingGenerate }
  );
  assert.equal(stage.noSuggestion, true, "should suppress suggestion when HMS fails");
  assert.equal(stage.source, "model_unavailable");
});

test("when HMS returns invalid JSON, clarification returns noSuggestion", async () => {
  const handler = new ClarificationHandler();
  const invalidGenerate = async () => ({ text: "this is not json" });
  const stage = await handler.nextStage(
    { originalRequest: "帮我做一个软件", round: 1, askedDimensions: [], confirmedDimensions: {}, candidates: [], evidence: [] },
    { generate: invalidGenerate }
  );
  assert.equal(stage.noSuggestion, true, "should suppress on invalid JSON");
});

test("when generate is absent, deterministic local stages still work", async () => {
  const handler = new ClarificationHandler();
  const stage = await handler.nextStage(
    { originalRequest: "帮我做一个软件", round: 1, askedDimensions: [], confirmedDimensions: {}, candidates: [], evidence: [] },
    { generate: null }
  );
  assert.ok(!stage.noSuggestion, "without generate, local deterministic fallback may be used");
  assert.ok(stage.source === "deterministic", "deterministic stage source expected");
});

test("clarification preserves the exact user input instead of the normalized goal", async () => {
  const handler = new ClarificationHandler();
  const result = await handler.handle({
    input: "\u5e2e\u6211\u505a\u4e00\u4e2a\u8f6f\u4ef6",
    understanding: { goal: "\u505a\u4e00\u4e2a\u8f6f\u4ef6" },
    sessionId: "exact-input-session",
    requestId: "exact-input-request",
    structuredClarification: true,
    generate: null
  });
  assert.equal(result.clarification.originalRequest, "\u5e2e\u6211\u505a\u4e00\u4e2a\u8f6f\u4ef6");
});
