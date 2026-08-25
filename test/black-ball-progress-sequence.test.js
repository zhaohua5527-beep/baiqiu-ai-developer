"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to).trim();
}

function createPublicProgressHarness() {
  const isPublic = sourceBetween(
    mainSource,
    "function isBlackBallPublicProgress",
    "function publicProgressTarget"
  );
  const target = sourceBetween(
    mainSource,
    "function publicProgressTarget",
    "function publicChatProgress"
  );
  const normalize = sourceBetween(
    mainSource,
    "function publicChatProgress",
    "function emitBlackBallRunStarted"
  );
  return vm.runInNewContext(`
    (() => {
      const chatStreamProgressSequences = new Map();
      const safeActivitySnippet = (value, maxLength) => String(value || "").slice(0, maxLength);
      const safeReasoningDelta = (value) => String(value || "");
      ${isPublic}
      ${target}
      ${normalize}
      return { publicChatProgress };
    })()
  `);
}

test("lifecycle and first model progress receive distinct authoritative sequences", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const streamId = "turn-sequence-regression";
  const lifecycle = publicChatProgress(streamId, {
    type: "start",
    progress: {
      source: "hms",
      actor: "blackball",
      provenance: "blackball_runtime",
      kind: "lifecycle",
      message: "request accepted",
      target: "execution_activity"
    }
  });
  const structured = publicChatProgress(streamId, {
    type: "phase",
    progress: {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: "public_reasoning",
      sequence: 1,
      eventId: `${streamId}:live:1`,
      segmentId: "1",
      message: "checked the requested scope",
      target: "structured_result"
    }
  });

  assert.equal(lifecycle.sequence, 1);
  assert.equal(structured.sequence, 2);
  assert.equal(structured.turnId, streamId);
  assert.equal(structured.eventId, `${streamId}:live:1`);
  assert.equal(structured.target, "structured_result");
  assert.equal(structured.outputType, "structured_result");
  assert.equal(structured.kind, "public_reasoning");
});

test("each stream owns an independent monotonic public event sequence", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const progress = (eventId, sequence) => ({
    type: "phase",
    progress: {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: "public_reasoning",
      sequence,
      eventId,
      message: eventId,
      target: "structured_result"
    }
  });

  assert.equal(publicChatProgress("turn-a", progress("turn-a:live:9", 9)).sequence, 1);
  assert.equal(publicChatProgress("turn-a", progress("turn-a:live:10", 10)).sequence, 2);
  assert.equal(publicChatProgress("turn-b", progress("turn-b:live:1", 1)).sequence, 1);
});
