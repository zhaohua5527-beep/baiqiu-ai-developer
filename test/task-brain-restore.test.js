"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TaskBrain } = require("../services/task-brain");

function createBrain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-restore-"));
  const brain = new TaskBrain({ root });
  return { root, brain, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function snapshotTask(taskId, status, sessionId = "session-1") {
  return {
    task_id: taskId,
    session_id: sessionId,
    status,
    current_stage: status,
    goal: "test",
    task_goal: "test",
    original_input: "test",
    output: "",
    plan: [],
    pending: [],
    completed: [],
    constraints: [],
    timeline: [],
    timing: {}
  };
}

test("replaceSessionTasks normalizes in-flight tasks to interrupted", () => {
  const fixture = createBrain();
  try {
    fixture.brain.replaceSessionTasks(["session-1"], [
      snapshotTask("t-executing", "executing"),
      snapshotTask("t-submitted", "submitted"),
      snapshotTask("t-awaiting", "awaiting_confirmation"),
      snapshotTask("t-completed", "completed")
    ], "session-1");

    assert.equal(fixture.brain.get("t-executing").status, "interrupted");
    assert.equal(fixture.brain.get("t-submitted").status, "interrupted");
    assert.equal(fixture.brain.get("t-executing").interruption_reason, "恢复快照时仍在运行的任务已中断");
    // 确认流程可接续、终态不复活
    assert.equal(fixture.brain.get("t-awaiting").status, "awaiting_confirmation");
    assert.equal(fixture.brain.get("t-completed").status, "completed");
  } finally {
    fixture.dispose();
  }
});

test("replaceSessionTasks replaces same-session tasks and keeps other sessions", () => {
  const fixture = createBrain();
  try {
    fixture.brain.submit({ sessionId: "session-2", input: "keep me" });
    const before = fixture.brain.list("session-2").length;
    fixture.brain.replaceSessionTasks(["session-1"], [
      snapshotTask("t-running", "running")
    ], "session-1");
    assert.equal(fixture.brain.get("t-running").status, "interrupted");
    assert.equal(fixture.brain.list("session-2").length, before, "other session tasks untouched");
  } finally {
    fixture.dispose();
  }
});

test("restoreSnapshot normalizes in-flight tasks and keeps terminal states", () => {
  const fixture = createBrain();
  try {
    fixture.brain.restoreSnapshot([
      snapshotTask("r-verifying", "verifying"),
      snapshotTask("r-timedout", "timed_out"),
      snapshotTask("r-cancelled", "cancelled")
    ], "session-1");
    assert.equal(fixture.brain.get("r-verifying").status, "interrupted");
    assert.equal(fixture.brain.get("r-timedout").status, "timed_out");
    assert.equal(fixture.brain.get("r-cancelled").status, "cancelled");
  } finally {
    fixture.dispose();
  }
});

test("interrupted tasks from restore can be resumed", () => {
  const fixture = createBrain();
  try {
    fixture.brain.replaceSessionTasks(["session-1"], [
      snapshotTask("t-executing", "executing")
    ], "session-1");
    const resumed = fixture.brain.resume("t-executing");
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.current_stage, "resume_ready");
    assert.equal(resumed.resume_attempt, 1);
  } finally {
    fixture.dispose();
  }
});

test("retry starts a clean run without cloned transient evidence", () => {
  const fixture = createBrain();
  try {
    const submitted = fixture.brain.submit({ sessionId: "session-1", input: "生成表格" });
    fixture.brain.update(submitted.task_id, {
      timeline: [{ stage: "executing", at: "old" }],
      files: [{ path: "C:/old.xlsx" }],
      tool_evidence: [{ name: "write_xlsx" }],
      delegation_results: [{ status: "completed" }],
      execution_log: [{ sequence: 1, message: "old" }],
      delivery_status: "failed",
      presentation_status: "failed",
      cancel_audit: { proven: true },
      interrupted_at: "old",
      interruption_reason: "old cancel"
    });
    fixture.brain.fail(submitted.task_id, "展示失败", {
      evidence: {
        files: [{ path: "C:/old.xlsx" }],
        tool_evidence: [{ name: "write_xlsx" }],
        delegation_results: [{ status: "completed" }],
        execution_log: [{ sequence: 1, message: "old" }],
        delivery_status: "failed",
        presentation_status: "failed"
      }
    });

    const retried = fixture.brain.retry(submitted.task_id, { sessionId: "session-1" });
    assert.equal(retried.status, "ready");
    assert.equal(retried.retry_of, submitted.task_id);
    assert.deepEqual(retried.timeline, []);
    assert.equal(retried.files, undefined);
    assert.equal(retried.tool_evidence, undefined);
    assert.equal(retried.delegation_results, undefined);
    assert.equal(retried.execution_log, undefined);
    assert.equal(retried.delivery_status, undefined);
    assert.equal(retried.presentation_status, undefined);
    assert.equal(retried.cancel_audit, undefined);
    assert.equal(retried.interruption_reason, undefined);
  } finally {
    fixture.dispose();
  }
});
