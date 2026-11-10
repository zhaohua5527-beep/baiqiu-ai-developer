"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const from = source.indexOf("function compactPersistedExecutionPayload(value)");
const to = source.indexOf("function compactPersistedMessageAttachments", from);
assert.ok(from >= 0 && to > from);
const { compactPersistedExecutionPayload, compactPersistedMessagePayload } = new Function("JSON",
  source.slice(from, to) + "; return { compactPersistedExecutionPayload, compactPersistedMessagePayload };"
)({ stringify() { throw new Error("History compaction must not serialize message bodies"); } });

test("repeated history reads preserve payload identity without serializing content", () => {
  const raw = { productResult: { text: "正文🙂".repeat(10000), raw: { answerSegments: [{ text: "保留" }], structuredEvents: [{ message: "阶段结果" }] } } };
  const message = { raw };
  for (let index = 0; index < 20; index++) assert.equal(compactPersistedMessagePayload(message), false);
  assert.equal(message.raw, raw);
  assert.equal(compactPersistedExecutionPayload(raw), raw);
});

test("legacy update-array cleanup copies only changed containers", () => {
  const source = { text: "完整正文", raw: { result: { updates: [{ old: true }], answerSegments: [{ text: "不丢" }] } } };
  const before = structuredClone(source);
  const output = compactPersistedExecutionPayload(source);
  assert.deepEqual(source, before);
  assert.notEqual(output, source);
  assert.deepEqual(output, { text: "完整正文", raw: { result: { answerSegments: [{ text: "不丢" }] } } });
  assert.equal(output.raw.result.answerSegments, source.raw.result.answerSegments);
  assert.equal(compactPersistedExecutionPayload(output), output);
});

test("legacy duplicate envelopes merge with existing precedence and keep all durable outputs", () => {
  const message = { raw: {
    raw: { trace: "keep", priority: "legacy" }, requestRun: { duplicate: true },
    productResult: { text: "正文", requestRun: { current: true }, raw: { priority: "current", structuredEvents: [{ message: "核对结论" }] } }
  } };
  const original = message.raw;
  assert.equal(compactPersistedMessagePayload(message), true);
  assert.equal(message.raw.raw, undefined);
  assert.equal(message.raw.requestRun, undefined);
  assert.deepEqual(message.raw.productResult.raw, { trace: "keep", priority: "current", structuredEvents: [{ message: "核对结论" }] });
  assert.equal(original.raw.priority, "legacy");
  assert.equal(message.raw.productResult.text, "正文");
  assert.equal(compactPersistedMessagePayload(message), false);
});

test("new legacy fields added in place are still cleaned on the next read", () => {
  const message = { raw: { productResult: { text: "正文" } } };
  assert.equal(compactPersistedMessagePayload(message), false);
  message.raw.productResult.updates = [{ delta: "old" }];
  assert.equal(compactPersistedMessagePayload(message), true);
  assert.equal(message.raw.productResult.updates, undefined);
  assert.equal(message.raw.productResult.text, "正文");
});
