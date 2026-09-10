"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const {
  readHermesDelegationCompletion,
  waitForHermesDelegationCompletion
} = require("../services/hermes-delegation");

function createStateDb(root) {
  fs.mkdirSync(root, { recursive: true });
  const db = new Database(path.join(root, "state.db"));
  db.exec(`
    CREATE TABLE async_delegations (
      delegation_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      completed_at REAL,
      event_json TEXT,
      result_json TEXT,
      task_json TEXT,
      error TEXT
    )
  `);
  db.close();
}

function insertCompleted(root, id) {
  const db = new Database(path.join(root, "state.db"));
  const event = JSON.stringify({
    goals: ["verify workbook"],
    results: [{ task_index: 0, status: "completed", summary: "verified" }]
  });
  db.prepare("INSERT INTO async_delegations (delegation_id, state, completed_at, event_json) VALUES (?, 'completed', ?, ?)")
    .run(id, Date.now() / 1000, event);
  db.close();
}

test("delegation reads the explicitly selected Hermes home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-state-"));
  try {
    createStateDb(root);
    insertCompleted(root, "deleg_explicit");
    const completion = readHermesDelegationCompletion("deleg_explicit", { hermesHome: root });
    assert.equal(completion.status, "completed");
    assert.equal(completion.results[0].summary, "verified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a briefly missing delegation record is polled instead of failing immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-state-"));
  try {
    createStateDb(root);
    const timer = setTimeout(() => insertCompleted(root, "deleg_delayed"), 60);
    const completion = await waitForHermesDelegationCompletion(["deleg_delayed"], {
      hermesHome: root,
      timeoutMs: 1000,
      missingGraceMs: 500,
      intervalMs: 20
    });
    clearTimeout(timer);
    assert.equal(completion.status, "completed");
    assert.equal(completion.results[0].summary, "verified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal worker states stop waiting even without a timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-terminal-"));
  try {
    createStateDb(root);
    const db = new Database(path.join(root, "state.db"));
    for (const status of ["unknown", "stalled", "interrupted", "cancelled", "partial", "failed"]) {
      db.prepare("INSERT INTO async_delegations (delegation_id, state, event_json) VALUES (?, ?, ?)")
        .run(`deleg_${status}`, status, JSON.stringify({ status, error: "worker ended" }));
    }
    db.close();
    for (const status of ["unknown", "stalled", "interrupted", "cancelled", "partial", "failed"]) {
      const result = await waitForHermesDelegationCompletion([`deleg_${status}`], { hermesHome: root, timeoutMs: 0 });
      assert.equal(result.status, "failed");
      assert.equal(result.error, "worker ended");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("single completion preserves the summary and empty completion is not success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-single-"));
  try {
    createStateDb(root);
    const db = new Database(path.join(root, "state.db"));
    db.prepare("INSERT INTO async_delegations (delegation_id, state, result_json) VALUES (?, 'completed', ?)")
      .run("deleg_single", JSON.stringify({ summary: "actual result" }));
    db.prepare("INSERT INTO async_delegations (delegation_id, state) VALUES (?, 'completed')").run("deleg_empty");
    db.close();
    const single = await waitForHermesDelegationCompletion(["deleg_single"], { hermesHome: root });
    assert.equal(single.status, "completed");
    assert.equal(single.results[0].summary, "actual result");
    const empty = await waitForHermesDelegationCompletion(["deleg_empty"], { hermesHome: root });
    assert.equal(empty.status, "partial");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
