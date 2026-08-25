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

test("agent project direction questions are answered instead of dispatched", () => {
  const layer = new ConversationUnderstandingLayer();
  for (const input of [
    "\u6211\u60f3\u505a\u4e00\u4e2aagent\u9879\u76ee\uff0c\u6709\u4ec0\u4e48\u65b9\u5411\u5417",
    "\u600e\u4e48\u505a\u4e00\u4e2a Agent \u9879\u76ee\uff1f",
    "\u6211\u60f3\u5199\u4e00\u7bc7\u6587\u7ae0\uff0c\u6709\u4ec0\u4e48\u9009\u9898\u5efa\u8bae\u5417"
  ]) {
    const understanding = layer.understand({
      input,
      context: { sessionId: "direction-question", sessionType: "chat" }
    });

    assert.equal(understanding.intentType, "question", input);
    assert.equal(understanding.shouldCreateTask, false, input);
    assert.equal(understanding.responseMode, "answer", input);
    assert.notEqual(understanding.classification, "management_task", input);
    assert.equal(understanding.context.taskSpec, null, input);
  }
});

test("explicit agent creation still creates an execution task", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: "\u8bf7\u521b\u5efa\u4e00\u4e2a Agent \u9879\u76ee\u5e76\u751f\u6210\u4ee3\u7801",
    context: { sessionId: "agent-create", sessionType: "chat" }
  });

  assert.equal(understanding.intentType, "execution");
  assert.equal(understanding.shouldCreateTask, true);
  assert.equal(understanding.responseMode, "execute");
  assert.ok(understanding.context.taskSpec);
});

test("inline handbook writing stays in conversation and does not create TaskBrain", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: "\u5199\u4e00\u4efd\u4f7f\u7528\u4f60\u7684\u624b\u518c\u653e\u5728\u5bf9\u8bdd\u6846",
    context: { sessionId: "inline-handbook", sessionType: "chat" }
  });

  assert.equal(understanding.classification, "chat");
  assert.equal(understanding.responseMode, "answer");
  assert.equal(understanding.routing, "conversation");
  assert.equal(understanding.shouldCreateTask, false);
  assert.equal(understanding.context.taskSpec, null);
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

test("pasted completion reports do not create a new execution task", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: [
      "修复内容：已替换应用包。",
      "部署状态：已完成。",
      "查看所有产物 (2)",
      "查看所有变更 (5)"
    ].join("\n"),
    context: { sessionId: "reference-report", sessionType: "chat" }
  });

  assert.equal(understanding.intentType, "conversation");
  assert.equal(understanding.shouldCreateTask, false);
  assert.equal(understanding.responseMode, "answer");
  assert.equal(understanding.permissions.allowTools, false);
});

test("attachments always receive a canonical execution envelope", () => {
  const layer = new ConversationUnderstandingLayer();
  const understanding = layer.understand({
    input: "表1映射表2，排除表3后填入表4并放到桌面",
    context: { sessionId: "four-table-task", sessionType: "chat", hasAttachments: true, attachmentCount: 4 }
  });

  assert.equal(understanding.intentType, "execution");
  assert.equal(understanding.classification, "development_task");
  assert.equal(understanding.shouldCreateTask, true);
  assert.equal(understanding.route, "task_brain");
});

test("contextual overwrite questions are recognized as references to prior task output", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const helper = mainSource.slice(
    mainSource.indexOf("function contextualTaskFollowup"),
    mainSource.indexOf("function latestTaskBoundAssistantMessage")
  );
  assert.match(helper, /覆盖\|替换/);
  assert.match(helper, /对吗\|吗/);
});
