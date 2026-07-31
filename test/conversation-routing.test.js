"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ConversationUnderstandingLayer } = require("../services/conversation-understanding-layer");

test("agent small talk stays on the shared chat route", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: "你好",
    context: { sessionId: "agent-chat", sessionType: "Agent" }
  });

  assert.equal(understanding.shouldCreateTask, false);
  assert.equal(understanding.responseMode, "answer");
  assert.ok(understanding.executionMetadata);
  assert.equal(Object.hasOwn(understanding, "uug"), false);
});

test("full site wording alone no longer creates a confirmation gate", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: "开始执行完整网站设计",
    context: { sessionId: "task-routing", sessionType: "CEO" }
  });

  assert.ok(understanding.context.taskSpec);
  assert.equal(understanding.context.taskSpec.requiresConfirmation, false);
});
