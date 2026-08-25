"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TaskBrain, attachmentManifest } = require("../services/task-brain");

test("awaiting input resumes the same task and preserves its attachment workset", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-workset-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-workset" });
    const submitted = brain.submit({
      sessionId: "session-1",
      input: "Use table 1 and table 2 to fill table 3",
      attachments: [
        { id: "table-1", name: "table1.xlsx", path: "C:/cache/table1.xlsx" },
        { id: "table-2", name: "table2.csv", path: "C:/cache/table2.csv" }
      ]
    });
    brain.update(submitted.task_id, { status: "awaiting_input", current_stage: "awaiting_input" });

    const pending = brain.getAwaitingInput("session-1");
    assert.equal(pending.task_id, submitted.task_id);
    const resumed = brain.resumeAwaitingInput(pending.task_id, {
      input: "Prefer UPC and skip unmatched products",
      attachments: [{ id: "table-3", name: "table3.xlsx", path: "C:/cache/table3.xlsx" }]
    });

    assert.equal(resumed.task_id, submitted.task_id);
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.original_input, "Use table 1 and table 2 to fill table 3");
    assert.deepEqual(resumed.attachments.map((item) => item.id), ["table-1", "table-2", "table-3"]);
    assert.equal(resumed.followups.at(-1).text, "Prefer UPC and skip unmatched products");
    assert.equal(resumed.workset.confirmations.at(-1).text, "Prefer UPC and skip unmatched products");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("four-file worksets keep stable table aliases through short replies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-four-table-workset-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-four-tables" });
    const attachments = [
      { id: "store", name: "store.xlsx", path: "C:/cache/store.xlsx" },
      { id: "traffic", name: "traffic.csv", path: "C:/cache/traffic.csv" },
      { id: "excluded", name: "excluded.xlsx", path: "C:/cache/excluded.xlsx" },
      { id: "template", name: "template.xlsx", path: "C:/cache/template.xlsx" }
    ];
    const submitted = brain.submit({
      sessionId: "session-four",
      input: "Map table 2 through table 1, exclude table 3, and fill table 4",
      attachments
    });
    brain.update(submitted.task_id, { status: "awaiting_input", current_stage: "awaiting_input" });
    const resumed = brain.resumeAwaitingInput(submitted.task_id, { input: "B" });

    assert.equal(resumed.task_id, submitted.task_id);
    assert.deepEqual(resumed.attachments.map((item) => item.tableAlias), ["表1", "表2", "表3", "表4"]);
    assert.deepEqual(resumed.workset.attachment_manifest.map((item) => item.name), attachments.map((item) => item.name));
    assert.equal(resumed.workset.confirmations.at(-1).text, "B");
    assert.deepEqual(attachmentManifest(resumed.attachments).map((item) => item.ordinal), [1, 2, 3, 4]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preparing a resumed task never replaces its original input or attachments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-prepare-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-prepare" });
    const submitted = brain.submit({
      sessionId: "session-2",
      input: "Original multi-file task",
      attachments: [{ id: "original", name: "original.xlsx", path: "C:/cache/original.xlsx" }]
    });
    const prepared = brain.prepare({
      sessionId: "session-2",
      taskId: submitted.task_id,
      attachments: [{ id: "followup", name: "followup.xlsx", path: "C:/cache/followup.xlsx" }],
      understanding: {
        intentType: "task",
        goal: "Follow-up classification text",
        context: { normalizedInput: "Follow-up classification text", taskSpec: { taskType: "spreadsheet", level: 3 } }
      }
    });

    assert.equal(prepared.original_input, "Original multi-file task");
    assert.deepEqual(prepared.attachments.map((item) => item.id), ["original", "followup"]);
    assert.equal(prepared.workset.original_goal, "Original multi-file task");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime timing upgrades are persisted on the canonical task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-timing-upgrade-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-timing-upgrade" });
    const submitted = brain.submit({
      sessionId: "session-timing",
      input: "Fill table 4",
      timing: { profile: "model_response", hardTimeoutMs: 180000 }
    });
    const updated = brain.updateTiming(submitted.task_id, {
      profile: "agent_execution",
      expectedMs: 90000,
      softTimeoutMs: 180000,
      hardTimeoutMs: 1200000,
      heartbeatMs: 15000
    });

    assert.equal(updated.timing.profile, "agent_execution");
    assert.equal(updated.timing.hard_timeout_ms, 1200000);
    const reloaded = new TaskBrain({ root });
    assert.equal(reloaded.get(submitted.task_id).timing.hard_timeout_ms, 1200000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a contextual follow-up reopens the completed workset with the same task id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-completed-followup-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-same-id" });
    const submitted = brain.submit({
      sessionId: "session-followup",
      input: "Filter the four bound workbooks",
      attachments: [{ id: "table-1", name: "table1.xlsx", path: "C:/cache/table1.xlsx" }]
    });
    brain.complete(submitted.task_id, "6386 rows were delivered");

    const continued = brain.continueWorkset(submitted.task_id, {
      input: "Are you sure these are zero exposure and zero orders?",
      reopenCompleted: true
    });

    assert.equal(continued.task_id, submitted.task_id);
    assert.equal(continued.status, "ready");
    assert.equal(continued.followups.at(-1).text, "Are you sure these are zero exposure and zero orders?");
    assert.equal(continued.result_history.at(-1).result, "6386 rows were delivered");
    assert.deepEqual(continued.attachments.map((item) => item.id), ["table-1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit execution confirmation reopens a failed four-file workset intact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-failed-four-file-workset-"));
  try {
    const brain = new TaskBrain({ root, idFactory: () => "task-v4-same-id" });
    const attachments = [
      { id: "table-1", name: "store.xlsx", path: "C:/cache/store.xlsx" },
      { id: "table-2", name: "traffic.xlsx", path: "C:/cache/traffic.xlsx" },
      { id: "table-3", name: "excluded.xlsx", path: "C:/cache/excluded.xlsx" },
      { id: "table-4", name: "upload-template.xlsx", path: "C:/cache/upload-template.xlsx" }
    ];
    const submitted = brain.submit({
      sessionId: "session-v4",
      input: "Generate V4 from all four workbooks with the confirmed inventory filters",
      attachments
    });
    brain.fail(submitted.task_id, {
      code: "hms_file_evidence_missing",
      text: "Black Ball returned no verifiable file evidence"
    });

    const continued = brain.continueWorkset(submitted.task_id, {
      input: "对的 执行",
      reopenTerminal: true
    });

    assert.equal(continued.task_id, submitted.task_id);
    assert.equal(continued.status, "ready");
    assert.equal(continued.reopened_from_terminal_status, "failed");
    assert.equal(continued.followups.at(-1).text, "对的 执行");
    assert.deepEqual(continued.attachments.map((item) => item.id), attachments.map((item) => item.id));
    assert.deepEqual(continued.workset.attachment_manifest.map((item) => item.name), attachments.map((item) => item.name));
    assert.equal(continued.result_history.at(-1).status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
