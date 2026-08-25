"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ConsciousCenter,
  compactConsciousSnapshot,
  stripCognitiveSnapshotFields
} = require("../services/conscious-center");
const { ConsciousExtractionSkill } = require("../services/conscious-extraction-skill");

const FORBIDDEN_FIELDS = [
  "coreDecisions",
  "decisions",
  "projectConstraints",
  "constraints",
  "explicitRequirements",
  "userPreferences",
  "user_preferences",
  "chatHistorySummary",
  "conversation_summary",
  "distillation",
  "nextPlan",
  "next_actions",
  "sessionMemory",
  "globalPersona",
  "memoryLayer",
  "contextReplacement"
];

function assertExecutionOnly(snapshot) {
  for (const field of FORBIDDEN_FIELDS) {
    assert.equal(Object.hasOwn(snapshot, field), false, `${field} must not be stored in a conscious snapshot`);
  }
  assert.equal(Object.hasOwn(snapshot.core || {}, "decisions"), false);
  assert.equal(Object.hasOwn(snapshot.core || {}, "constraints"), false);
  assert.equal(Object.hasOwn(snapshot.core || {}, "user_preferences"), false);
}

function legacySnapshot(id = "conscious-legacy") {
  return {
    schemaVersion: 2,
    type: "conscious-snapshot",
    id,
    version: 1,
    scope: "session",
    sourceId: "session-1",
    sessionId: "session-1",
    title: "Legacy",
    currentTaskGoal: "Finish the active task",
    currentProgress: { percent: 40, summary: "running" },
    completedTasks: ["step-1"],
    pendingTasks: ["step-2"],
    agentStates: [{ name: "Worker", status: "running" }],
    fileChanges: [{ name: "report.xlsx", path: "D:/report.xlsx" }],
    taskBrainState: [{ task_id: "task-1", status: "executing", pending: ["step-2"] }],
    coreDecisions: [{ decision: "Use option A" }],
    projectConstraints: ["Never upload"],
    userPreferences: { replyStyle: "short" },
    chatHistorySummary: [{ text: "private conversation summary" }],
    nextPlan: ["infer a future plan"],
    decisions: ["Use option A"],
    constraints: ["Never upload"],
    next_actions: ["infer a future plan"],
    conversation_summary: "private conversation summary",
    distillation: { compactContext: "private conversation summary", originalMessages: 20, distilledMessages: 1 },
    core: {
      goal: "Finish the active task",
      current_stage: "running",
      completed_tasks: ["step-1"],
      pending_tasks: ["step-2"],
      important_files: ["D:/report.xlsx"],
      agent_state: [{ name: "Worker", status: "running" }],
      decisions: ["Use option A"],
      constraints: ["Never upload"],
      user_preferences: { replyStyle: "short" }
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

test("conscious snapshots retain execution state and reject cognitive memory", () => {
  const sanitized = stripCognitiveSnapshotFields(legacySnapshot());
  assertExecutionOnly(sanitized);
  assert.equal(sanitized.schemaVersion, 3);
  assert.equal(sanitized.responsibility, "execution_state");
  assert.deepEqual(sanitized.pendingTasks, ["step-2"]);
  assert.deepEqual(sanitized.core.pending_tasks, ["step-2"]);
  assert.equal(sanitized.taskBrainState[0].task_id, "task-1");

  const compact = compactConsciousSnapshot(legacySnapshot());
  assertExecutionOnly(compact);
  assert.deepEqual(compact.completedTasks, ["step-1"]);
  assert.deepEqual(compact.fileChanges, [{ name: "report.xlsx", path: "D:/report.xlsx" }]);
});

test("conscious center migrates stored legacy snapshots and clears cognitive index terms", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-conscious-contract-"));
  const snapshotsRoot = path.join(root, "snapshots");
  fs.mkdirSync(snapshotsRoot, { recursive: true });
  const legacy = legacySnapshot();
  fs.writeFileSync(path.join(snapshotsRoot, `${legacy.id}.json`), JSON.stringify(legacy, null, 2));
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({
    schemaVersion: 1,
    items: [{
      id: legacy.id,
      scope: legacy.scope,
      sourceId: legacy.sourceId,
      title: legacy.title,
      keywords: ["private", "conversation"],
      searchText: "private conversation summary",
      nextActions: legacy.next_actions,
      updatedAt: legacy.updatedAt
    }]
  }, null, 2));

  try {
    const center = new ConsciousCenter({ root });
    const migrated = center.get(legacy.id);
    assertExecutionOnly(migrated);
    assert.equal(migrated.responsibility, "execution_state");
    const stored = JSON.parse(fs.readFileSync(path.join(snapshotsRoot, `${legacy.id}.json`), "utf8"));
    assertExecutionOnly(stored);
    const item = center.list({ limit: 10 })[0];
    assert.deepEqual(item.nextActions, ["step-2"]);
    assert.doesNotMatch(item.searchText, /private conversation summary/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conscious extraction restores only execution state", () => {
  const snapshot = stripCognitiveSnapshotFields(legacySnapshot());
  const result = new ConsciousExtractionSkill().extract(snapshot);
  assert.deepEqual(result.state.completed, ["step-1"]);
  assert.deepEqual(result.state.pending, ["step-2"]);
  assert.equal(result.state.agentStates[0].name, "Worker");
  assert.equal(Object.hasOwn(result.state, "decisions"), false);
  assert.equal(Object.hasOwn(result.state, "constraints"), false);
  assert.equal(Object.hasOwn(result.state, "userPreferences"), false);
  assert.equal(Object.hasOwn(result.state, "chatHistorySummary"), false);
});
