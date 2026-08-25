"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createRequestRun,
  executionOutcomeFromResult,
  deliveryStatusFromResult,
  presentationStatusFromResult,
  buildCancelAudit,
  cancelRequestTargetsRun
} = require("../services/request-run-contract");

test("durable HMS evidence wins over a presentation protocol failure", () => {
  const result = {
    success: false,
    status: "failed",
    stopReason: "missing_public_final_envelope",
    text: "黑球最终包络缺失",
    files: [{ path: "C:/Users/Lenovo/Desktop/result.xlsx" }],
    toolCalls: [{ status: "completed", rawOutput: { success: true } }]
  };
  assert.equal(executionOutcomeFromResult(result), "succeeded");
  assert.equal(deliveryStatusFromResult(result, "succeeded"), "degraded");
  assert.equal(presentationStatusFromResult(result, "degraded"), "recovered");

  const run = createRequestRun({
    runId: "run-final-missing",
    sessionId: "session-1",
    taskId: "task-1",
    interactionKind: "execute",
    result
  });
  assert.equal(run.executionOutcome, "succeeded");
  assert.equal(run.deliveryStatus, "degraded");
  assert.equal(run.presentationStatus, "recovered");
  assert.equal(run.evidence.files.length, 1);
  assert.equal(run.evidence.toolCalls.length, 1);
});

test("cancel audit is not proven without current run abort evidence", () => {
  const unproven = buildCancelAudit({ result: { status: "cancelled", runId: "run-1" }, activeRun: { runId: "run-1" }, runId: "run-1" });
  assert.equal(unproven.requested, false);
  assert.equal(unproven.proven, false);

  const controller = new AbortController();
  controller.abort();
  const proven = buildCancelAudit({
    result: { status: "cancelled", runId: "run-1" },
    activeRun: { runId: "run-1", abortSignalId: "run-1", userAborted: true, userAbortedAt: "2026-08-05T00:00:00.000Z", controller },
    runId: "run-1"
  });
  assert.equal(proven.requested, true);
  assert.equal(proven.proven, true);
});

test("stale run cancellation cannot target a newer active run", () => {
  const controller = new AbortController();
  controller.abort();
  const activeRun = { runId: "run-new", abortSignalId: "run-new", userAborted: true, controller };
  assert.equal(cancelRequestTargetsRun("run-old", activeRun), false);
  assert.equal(cancelRequestTargetsRun("run-new", activeRun), true);
  const audit = buildCancelAudit({ result: { status: "cancelled", runId: "run-old" }, activeRun, runId: "run-old" });
  assert.equal(audit.requested, false);
  assert.equal(audit.proven, false);
});

test("failed tools and missing final without durable evidence remain failed", () => {
  assert.equal(executionOutcomeFromResult({
    success: false,
    status: "failed",
    stopReason: "missing_public_final_envelope",
    toolCalls: [{ status: "failed", rawOutput: { success: false, error: "boom" } }]
  }), "failed");
  assert.equal(executionOutcomeFromResult({
    success: false,
    status: "failed",
    stopReason: "missing_public_final_envelope",
    text: "unbounded model narration"
  }), "failed");
});
