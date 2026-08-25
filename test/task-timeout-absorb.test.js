"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TaskBrain } = require("../services/task-brain");

function createBrain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-absorb-"));
  const brain = new TaskBrain({ root });
  return { root, brain, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a timed-out task is absorbed to completed when late success carries evidence", () => {
  const fixture = createBrain();
  try {
    const task = fixture.brain.submit({ sessionId: "s1", input: "make calculator" });
    fixture.brain.markExecuting(task.task_id);
    fixture.brain.markTimedOut(task.task_id, "任务超过最长允许时长（local_create）。");
    assert.equal(fixture.brain.get(task.task_id).status, "timed_out");

    // 执行链在超时后返回真实成功（如 calculator 产物已生成）
    const absorbed = fixture.brain.complete(task.task_id, "已创建并打开白球计算器", { absorbAfterTimeout: true });
    assert.equal(absorbed.status, "completed");
    assert.equal(absorbed.absorbed_after_timeout, "已创建并打开白球计算器");
    assert.equal(absorbed.error, undefined, "超时错误应被清除");
  } finally {
    fixture.dispose();
  }
});

test("complete without absorb flag still refuses to overwrite timeout", () => {
  const fixture = createBrain();
  try {
    const task = fixture.brain.submit({ sessionId: "s1", input: "x" });
    fixture.brain.markTimedOut(task.task_id, "deadline");
    const result = fixture.brain.complete(task.task_id, "late success");
    assert.equal(result.status, "timed_out", "default complete must not overwrite timeout");
    assert.equal(result.error, "deadline");
  } finally {
    fixture.dispose();
  }
});

test("absorbed result still triggers onComplete notification", () => {
  const fixture = createBrain();
  const completions = [];
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-absorb-"));
  try {
    const brain = new TaskBrain({ root: root2, onComplete: (task) => completions.push(task.status) });
    const task = brain.submit({ sessionId: "s1", input: "x" });
    brain.markTimedOut(task.task_id, "deadline");
    brain.complete(task.task_id, "result with artifact", { absorbAfterTimeout: true });
    assert.deepEqual(completions, ["completed"], "onComplete should fire for absorbed completion");
  } finally {
    fixture.dispose();
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("fail still refuses to overwrite a completed task", () => {
  const fixture = createBrain();
  try {
    const task = fixture.brain.submit({ sessionId: "s1", input: "x" });
    fixture.brain.complete(task.task_id, "done", { absorbAfterTimeout: true });
    const after = fixture.brain.fail(task.task_id, "late fail");
    assert.equal(after.status, "completed", "fail must not overwrite completed");
  } finally {
    fixture.dispose();
  }
});

test("task completion and failure retain execution evidence independently from display status", () => {
  const fixture = createBrain();
  try {
    const completedTask = fixture.brain.submit({ sessionId: "s1", input: "write file" });
    const completed = fixture.brain.complete(completedTask.task_id, "done", {
      evidence: {
        files: [{ path: "C:/result.xlsx" }],
        tool_evidence: [{ title: "execute_code", status: "completed" }],
        delivery_status: "degraded",
        presentation_status: "recovered"
      }
    });
    assert.deepEqual(completed.files, [{ path: "C:/result.xlsx" }]);
    assert.equal(completed.delivery_status, "degraded");

    const failedTask = fixture.brain.submit({ sessionId: "s1", input: "write another file" });
    const failed = fixture.brain.fail(failedTask.task_id, "reply delivery failed", {
      evidence: {
        files: [{ path: "C:/partial.xlsx" }],
        execution_log: [{ message: "file write completed" }]
      }
    });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.files, [{ path: "C:/partial.xlsx" }]);
    assert.deepEqual(failed.execution_log, [{ message: "file write completed" }]);
  } finally {
    fixture.dispose();
  }
});
