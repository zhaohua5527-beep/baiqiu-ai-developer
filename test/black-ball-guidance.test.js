"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeGuidanceCard,
  createGuidanceState,
  continuationForGuidance
} = require("../services/black-ball-guidance");

test("normalizes a Black Ball select and fill decision", () => {
  const card = normalizeGuidanceCard({
    interactionMode: "select_and_fill",
    sessionId: "session-1",
    requestId: "request-1",
    question: "你希望怎样处理这份文件？",
    reason: "当前请求有三个会改变结果的方向。",
    options: [
      { id: "polish", label: "润色文字" },
      { id: "format", label: "调整格式" }
    ],
    input: { enabled: true, placeholder: "补充你的要求" }
  });
  assert.equal(card.cardType, "task_guidance");
  assert.equal(card.interactionMode, "select_and_fill");
  assert.equal(card.options.length, 2);
  assert.equal(card.input.placeholder, "补充你的要求");
});

test("continues the same request only for the same session and request", () => {
  const card = normalizeGuidanceCard({
    interactionMode: "select",
    sessionId: "session-1",
    requestId: "request-1",
    question: "请选择",
    options: [{ id: "analyze", label: "分析内容" }]
  });
  const state = createGuidanceState(card, { taskId: "task-1", originalRequest: "帮我处理这个文件" });
  const continuation = continuationForGuidance(state, {
    sessionId: "session-1",
    requestId: "request-1",
    optionId: "analyze",
    action: "select",
    value: "分析内容"
  });
  assert.match(continuation.text, /帮我处理这个文件/);
  assert.match(continuation.text, /分析内容/);
  assert.throws(() => continuationForGuidance(state, {
    sessionId: "other-session",
    requestId: "request-1",
    optionId: "analyze",
    action: "select",
    value: "分析内容"
  }), /不属于当前会话/);
});

test("fill mode accepts a custom value without options", () => {
  const card = normalizeGuidanceCard({
    interactionMode: "fill",
    sessionId: "session-1",
    requestId: "request-2",
    question: "请填写文件名",
    input: { enabled: true }
  });
  const state = createGuidanceState(card, { originalRequest: "保存结果" });
  const continuation = continuationForGuidance(state, {
    sessionId: "session-1",
    requestId: "request-2",
    optionId: "custom",
    action: "custom",
    value: "销售汇总"
  });
  assert.match(continuation.text, /销售汇总/);
});
