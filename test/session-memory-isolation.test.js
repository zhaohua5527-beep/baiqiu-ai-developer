"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ContextManager } = require("../services/context-manager");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-context-isolation-"));
  return {
    root,
    manager: new ContextManager({ root, maxHistoryLength: 6 }),
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("context summaries, decisions and open tasks are scoped to the current session", () => {
  const current = fixture();
  try {
    const manager = current.manager;
    manager.appendMessage("session-a", { role: "user", text: "我的项目叫 城北店 活动项目" });
    manager.appendMessage("session-a", { role: "user", text: "确认进入 Phase 1，先做城北店活动方案" });
    manager.updateTaskState("session-a", { status: "running", intent: "城北店活动方案" });
    manager.appendMessage("session-b", { role: "user", text: "你好" });

    const a = manager.getActiveContext("session-a");
    const b = manager.getActiveContext("session-b");
    assert.equal(a.summary.project.name, "城北店 活动项目");
    assert.equal(b.summary.project.name, undefined);
    assert.equal(a.summary.importantDecisions.length, 1);
    assert.equal(b.summary.importantDecisions.length, 0);
    assert.equal(a.summary.openTasks.length, 1);
    assert.equal(b.summary.openTasks.length, 0);
  } finally {
    current.dispose();
  }
});

test("context project questions do not read another session project name", () => {
  const current = fixture();
  try {
    const manager = current.manager;
    manager.appendMessage("session-a", { role: "user", text: "我的项目叫 城北店" });
    assert.match(manager.answerContextQuestion("我的项目叫什么？", "session-a").text, /城北店/);
    assert.doesNotMatch(manager.answerContextQuestion("我的项目叫什么？", "session-b").text, /城北店/);
  } finally {
    current.dispose();
  }
});

test("terminal task state removes stale open tasks for that session", () => {
  const current = fixture();
  try {
    current.manager.updateTaskState("session-a", { status: "running", intent: "第一件事情" });
    assert.equal(current.manager.getActiveContext("session-a").summary.openTasks.length, 1);
    current.manager.updateTaskState("session-a", { status: "completed", intent: "第一件事情" });
    assert.deepEqual(current.manager.getActiveContext("session-a").summary.openTasks, []);
  } finally {
    current.dispose();
  }
});

test("compression creates separate summaries for interleaved sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-context-compression-isolation-"));
  const manager = new ContextManager({ root, maxHistoryLength: 1000, maxContextSize: 1024 * 1024 });
  try {
    for (let index = 0; index < 20; index += 1) {
      manager.appendMessage("session-a", { role: "user", text: `项目 A 任务 A-${index}` });
      manager.appendMessage("session-b", { role: "user", text: `项目 B 任务 B-${index}` });
    }
    const result = manager.compress({ reason: "test" });
    manager.save();
    assert.equal(result.compressed, true);
    assert.equal(result.summaryIds.length, 2);
    const a = manager.getActiveContext("session-a").summary.summaries.join("\n");
    const b = manager.getActiveContext("session-b").summary.summaries.join("\n");
    assert.match(a, /任务 A-/);
    assert.doesNotMatch(a, /任务 B-/);
    assert.match(b, /任务 B-/);
    assert.doesNotMatch(b, /任务 A-/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy mixed summaries leave active context and remain archived", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-context-scope-migration-"));
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({
      version: 1,
      summaries: [{ id: "legacy-summary", sessionId: "session-a", text: "旧的混合会话摘要" }],
      project: {},
      preferences: [],
      importantDecisions: [],
      openTasks: [{ sessionId: "session-a", text: "旧任务仍在执行" }]
    }), "utf8");
    const manager = new ContextManager({ root });
    const active = manager.getActiveContext("session-a");
    assert.deepEqual(active.summary.summaries, []);
    assert.deepEqual(active.summary.openTasks, []);
    assert.equal(manager.snapshot().archive.items.some((item) => item.id === "legacy-summary" && item.legacyScope === true), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
