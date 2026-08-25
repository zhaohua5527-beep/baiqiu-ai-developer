"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CONTEXT_AUTO_EXTRACT_REMAIN_PERCENT,
  messagesAfterContextCheckpoint,
  shouldAutoExtractContext,
  contextResetPatch
} = require("../services/context-cycle");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("context checkpoints retain visible history but expose only the active epoch", () => {
  const messages = [
    { id: "old-user", role: "user", text: "old" },
    { id: "checkpoint", role: "assistant", text: "old reply" },
    { id: "new-user", role: "user", text: "new" }
  ];
  const active = messagesAfterContextCheckpoint({ contextArchivedThroughMessageId: "checkpoint" }, messages);
  assert.equal(messages.length, 3);
  assert.deepEqual(active.map((item) => item.id), ["new-user"]);
});

test("a missing checkpoint id falls back to the persisted compaction time", () => {
  const active = messagesAfterContextCheckpoint({
    contextArchivedThroughMessageId: "deleted-message",
    contextCompactedAt: 200
  }, [
    { id: "old", createdAt: 100 },
    { id: "new", createdAt: 201 }
  ]);
  assert.deepEqual(active.map((item) => item.id), ["new"]);
});

test("the low-watermark threshold is inclusive at ten percent", () => {
  assert.equal(CONTEXT_AUTO_EXTRACT_REMAIN_PERCENT, 10);
  assert.equal(shouldAutoExtractContext(11), false);
  assert.equal(shouldAutoExtractContext(10), true);
  assert.equal(shouldAutoExtractContext(0), true);
});

test("resetting context advances one epoch and detaches the Hermes runtime", () => {
  const patch = contextResetPatch({ contextEpoch: 4, hermesSessionId: "hms-old", lastRunId: "run-old" }, [
    { id: "visible-last" }
  ], { snapshotId: "snapshot-1", compactedAt: 1234 });
  assert.deepEqual(patch, {
    contextEpoch: 5,
    contextArchivedThroughMessageId: "visible-last",
    contextCompactedAt: 1234,
    contextLastSnapshotId: "snapshot-1",
    contextAutoExtractPending: null,
    hermesSessionId: null,
    lastRunId: null
  });
});

test("automatic extraction waits for active runs and settles at both terminal paths", () => {
  assert.match(mainSource, /session\.contextAutoExtractPending = \{ epoch, requestedAt: Date\.now\(\), reason: "low_watermark" \};/);
  assert.match(mainSource, /activeRuns\.delete\(sessionId\);\s*settlePendingContextExtraction\(sessionId\);/s);
  assert.match(mainSource, /finishingRun\?\.controller === controller && finishingRun\?\.runId === requestRunId[\s\S]*?activeRuns\.delete\(session\.id\);[\s\S]*?settlePendingContextExtraction\(session\.id\);/s);
  assert.match(mainSource, /await hermesClient\?\.deleteSession\(id\);/);
});

test("manual extraction is explicit compression without another confirmation", () => {
  assert.match(preloadSource, /saveConsciousState: \(scope, sourceId, options = \{\}\)/);
  assert.match(rendererSource, /saveConsciousState\(scope, sourceId, \{ compactContext: true, resetRuntime: true \}\)/);
  assert.doesNotMatch(rendererSource, /confirm\([^\n]*saveConsciousState/);
  assert.match(mainSource, /db\.messages\[session\.id\] = consciousContextMessages\(snapshot, session\);\s*session\.messages = db\.messages\[session\.id\];/s);
});

test("renderer meters and provider history both honor the same checkpoint", () => {
  assert.match(rendererSource, /const activeMessages = messagesAfterContextCheckpoint\(session, messages\);/);
  assert.match(rendererSource, /usage\.remainPercent > 10/);
  assert.match(mainSource, /return messagesAfterContextCheckpoint\(session, items\)/);
  assert.match(mainSource, /ipcMain\.handle\("conscious-center:auto-extract"/);
});
