"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("renderer sends chat, attachment, and skill requests through one product route", () => {
  assert.doesNotMatch(source, /function shouldUseProductTask/);
  assert.doesNotMatch(source, /function submitAttachmentInput/);
  assert.doesNotMatch(source, /function submitSkillLearningInput/);
  assert.doesNotMatch(source, /fallbackResult = await submitProductInput/);
  assert.match(source, /templateId: "desktop\.chat_runtime"/);
  assert.match(source, /const productResult = await submitProductInput\(session, requestText, \{/);
});

test("renderer never retries a failed product request as a second conversation", () => {
  assert.doesNotMatch(source, /fallbackResult/);
  assert.doesNotMatch(source, /conversationOnly: true/);
});
