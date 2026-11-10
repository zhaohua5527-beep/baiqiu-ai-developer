"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { recordUsage, fromMessage, format } = require("../renderer-v2/token-usage");
const { providerDiagnostic } = require("../services/hms-stream-failure");

test("usage accumulates distinct requests, replaces cumulative updates, and ignores stale deliveries", () => {
  const first = { requestId: "request-1", inputTokens: 800, outputTokens: 100, totalTokens: 900 };
  let usage = recordUsage(null, first);
  assert.equal(recordUsage(usage, first), usage);
  usage = recordUsage(usage, { ...first, outputTokens: 400, totalTokens: 1200 });
  assert.equal(recordUsage(usage, first), usage);
  usage = recordUsage(usage, { ...first, requestId: "request-2" });
  assert.equal(usage.totalTokens, 2100);
  assert.equal(usage.inputTokens, 1600);
  assert.equal(usage.outputTokens, 500);
  const restored = fromMessage(JSON.parse(JSON.stringify({ raw: { productResult: { tokenUsage: usage } } })));
  assert.deepEqual(restored, usage);
});

test("unknown usage stays unknown and estimates are not read from historical metadata", () => {
  assert.equal(recordUsage(null, { totalTokens: 10 }), null);
  assert.equal(recordUsage(null, { requestId: "one", inputTokens: -1, outputTokens: 3, totalTokens: 2 }), null);
  assert.equal(fromMessage({ raw: { usage: { total_tokens: 1000 } } }), null);
  assert.equal(fromMessage({ tokenUsage: { source: "estimated", totalTokens: 1000 } }), null);
  assert.equal(format(undefined), "—");
  assert.equal(format(0), "0");
  assert.equal(format(856), "856");
  assert.equal(format(1000), "1k");
  assert.equal(format(1599), "1.5k");
});

test("provider usage crosses the diagnostic boundary with numeric counters only", () => {
  const usage = { type: "provider_usage", requestId: "a1234567-1234-1234-1234-123456789abc", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const update = { sessionUpdate: "agent_message_chunk", content: { text: "" }, _meta: { baiqiu_diagnostic: { ...usage, private: "secret" } } };
  assert.deepEqual(providerDiagnostic(update), usage);
  update._meta.baiqiu_diagnostic.totalTokens = NaN;
  assert.equal(providerDiagnostic(update), null);
});
