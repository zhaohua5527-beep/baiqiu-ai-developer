"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { conversationResultStatus } = require("../services/response-router");

test("clarification response with a task returns awaiting_input", () => {
  const status = conversationResultStatus({
    clarification: { cardType: "intent_clarification", question: "你要做什么类型的东西？", options: [{ label: "工具" }] }
  }, { hasTask: true });
  assert.equal(status, "awaiting_input");
});

test("clarification response without a task still returns completed (pure chat)", () => {
  const status = conversationResultStatus({
    clarification: { cardType: "intent_clarification", question: "具体想做哪方面的？" }
  }, { hasTask: false });
  assert.equal(status, "completed");
});

test("plain conversation reply cannot complete an existing task", () => {
  assert.equal(conversationResultStatus({ text: "你好" }, { hasTask: true }), "unverified");
  assert.equal(conversationResultStatus({ text: "你好" }, { hasTask: false }), "completed");
  assert.equal(conversationResultStatus(null, { hasTask: true }), "unverified");
  assert.equal(conversationResultStatus("plain string", { hasTask: true }), "unverified");
});

test("clarification with options but no cardType still counts as clarification", () => {
  const status = conversationResultStatus({
    clarification: { question: "选哪个？", options: ["A", "B"] }
  }, { hasTask: true });
  assert.equal(status, "awaiting_input");
});

test("plain HMS confirmation text is converted into a resumable task clarification", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function extractHmsClarificationEnvelope");
  const end = mainSource.indexOf("function extractHmsPresentationEnvelope", start);
  const extract = new Function(`${mainSource.slice(start, end)}; return extractHmsClarificationEnvelope;`)();
  const result = extract("执行前请回复确认按 A 执行，我立即处理。");

  assert.equal(result.clarification.preserveTask, true);
  assert.equal(result.clarification.inferredFromPlainText, true);
  assert.deepEqual(result.clarification.options, [{ label: "A", value: "A" }]);
});
