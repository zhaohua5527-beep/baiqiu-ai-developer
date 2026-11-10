"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");

function between(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function harness(text, options = {}) {
  let now = 1000;
  const entry = {
    text, rendered: {}, targetText: "", targetChars: [], visibleText: "", visibleChars: [],
    revealedLength: 0, segmentOrder: [], segmentEndLengths: new Map(),
    segmentCharsById: new Map(), segmentBlocks: new Map(), activeSegmentId: "", ...options
  };
  const context = vm.createContext({
    performance: { now: () => now }, filterAssistantExecutionOutput: text => text,
    assistantTypingCharsPerSecond: () => 1000, typingPauseFor: () => 0,
    renderProgressiveMarkdown: (answer, text) => { answer.source = text; },
    softenProgressiveTail() {}, syncExecutionReplyTimeline() {}, completeLiveReasoningSegment() {},
    liveAnswerSegmentIsVisible: () => true, flushQueuedReasoning() {}, setLiveCurrentThinking() {},
    ensureLiveSegmentBlock(entry, id) {
      if (!entry.segmentBlocks.has(id)) entry.segmentBlocks.set(id, { answer: {}, renderedVisibleCount: -1 });
      return entry.segmentBlocks.get(id);
    }
  });
  vm.runInContext(between("function renderSegmentedLiveAnswer", "function completedActivityHtml")
    + between("function settleLiveSegmentTransition", "function hideLiveThinkingLayer"), context);
  return { entry, tick() { now += 1000; context.revealLiveChatStreamText(entry); context.settleLiveSegmentTransition(entry); } };
}

test("an absent active segment does not impose a zero-character limit", () => {
  const view = harness("完整正文😀结尾。");
  view.tick(); view.tick();
  assert.equal(view.entry.visibleText, view.entry.text);
  assert.equal(view.entry.segmentBlocks.get("__default").answer.source, view.entry.text);
});

test("completion drains a suffix beyond the old segment end", () => {
  const text = "**完整结果**\n\n" + "长正文。".repeat(400);
  const view = harness(text, {
    backendCompleted: true, activeSegmentId: "answer", segmentOrder: ["answer"],
    segmentEndLengths: new Map([["answer", 1]]),
    segmentCharsById: new Map([["answer", Array.from(text)]])
  });
  for (let tick = 0; tick < 5; tick++) view.tick();
  assert.equal(view.entry.visibleText, text);
  assert.equal(view.entry.segmentBlocks.get("answer").answer.source, text);
});

test("live segment boundaries still preserve interleaved answer order", () => {
  const view = harness("前段😀后段结束。", {
    activeSegmentId: "first", segmentOrder: ["first", "second"],
    segmentEndLengths: new Map([["first", 3], ["second", 8]]),
    segmentCharsById: new Map([["first", Array.from("前段😀")], ["second", Array.from("后段结束。")]])
  });
  for (let tick = 0; tick < 4; tick++) view.tick();
  assert.equal(view.entry.segmentBlocks.get("first").answer.source, "前段😀");
  assert.equal(view.entry.segmentBlocks.get("second").answer.source, "后段结束。");
  assert.equal(view.entry.visibleText, view.entry.text);
});

function finalizeText(entry, finalDisplayText) {
  const finalizer = between("function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");
  const comparison = finalizer.slice(finalizer.indexOf("  const normalizeFinalText ="),
    finalizer.indexOf("  // A durable final answer"));
  const merge = finalizer.slice(finalizer.indexOf('  if (!String(entry.text || "").trim())'),
    finalizer.indexOf("  entry.terminalType ||="));
  const errors = [];
  const context = vm.createContext({
    entry, finalDisplayText, responseMessageId: "response",
    rawBlackBallAnswerText: text => text,
    reportLiveTurnProtocolError: (entry, reason) => errors.push(reason)
  });
  vm.runInContext(comparison + merge, context);
  return errors;
}

test("a durable suffix drains completely without changing the preceding segment", () => {
  const prefix = "前段结果。\n\n", partial = "后段写到";
  const complete = prefix + partial + "这里才完整😀。";
  const firstChars = Array.from(prefix);
  const view = harness(prefix + partial, {
    streamedAnswerText: prefix + partial, activeSegmentId: "last",
    segmentOrder: ["first", "last"],
    segmentEndLengths: new Map([["first", firstChars.length], ["last", Array.from(prefix + partial).length]]),
    segmentCharsById: new Map([["first", firstChars], ["last", Array.from(partial)]])
  });
  assert.deepEqual(finalizeText(view.entry, complete), []);
  view.tick(); view.tick();
  assert.equal(view.entry.visibleText, complete);
  assert.equal(view.entry.segmentCharsById.get("first"), firstChars);
  assert.equal(view.entry.segmentBlocks.get("last").answer.source, "后段写到这里才完整😀。");
});

test("conflicting or shorter durable text cannot replace the received answer", () => {
  for (const finalText of ["不同的答案。", "已显示", ""]) {
    const received = "已显示的真实结果。";
    const view = harness(received, {
      streamedAnswerText: received, activeSegmentId: "answer", segmentOrder: ["answer"],
      segmentCharsById: new Map([["answer", Array.from(received)]])
    });
    assert.deepEqual(finalizeText(view.entry, finalText), ["durable_answer_conflicts_with_stream"]);
    view.tick(); view.tick();
    assert.equal(view.entry.text, received);
    assert.equal(view.entry.segmentBlocks.get("answer").answer.source, received);
  }
});
