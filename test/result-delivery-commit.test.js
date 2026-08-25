"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeJsonAtomicSync } = require("../services/atomic-json-file");
const { TaskBrain } = require("../services/task-brain");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-result-commit-"));
}

test("atomic JSON commit retries transient Windows replacement failures", () => {
  const directory = temporaryRoot();
  try {
    const file = path.join(directory, "db.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
    let renameAttempts = 0;
    const io = Object.create(fs);
    io.renameSync = (source, target) => {
      renameAttempts += 1;
      if (renameAttempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      return fs.renameSync(source, target);
    };

    const result = writeJsonAtomicSync(file, { version: 2, result: "delivered" }, {
      fs: io,
      attempts: 4,
      retryDelayMs: 1,
      sleep: () => {}
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(renameAttempts, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2, result: "delivered" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed atomic JSON commit is explicit and keeps one recoverable pending snapshot", () => {
  const directory = temporaryRoot();
  try {
    const file = path.join(directory, "db.json");
    const pending = path.join(directory, "db.pending.json");
    const io = Object.create(fs);
    io.renameSync = () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    };

    assert.throws(() => writeJsonAtomicSync(file, { result: "not-lost" }, {
      fs: io,
      attempts: 3,
      retryDelayMs: 1,
      sleep: () => {},
      temporaryFile: pending
    }), (error) => error.code === "EBUSY" && error.temporaryFile === pending);
    assert.deepEqual(JSON.parse(fs.readFileSync(pending, "utf8")), { result: "not-lost" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("TaskBrain prepare preserves the originating client message id", () => {
  const directory = temporaryRoot();
  try {
    const brain = new TaskBrain({ root: directory });
    const task = brain.prepare({
      sessionId: "session-1",
      clientMessageId: "message-1",
      understanding: {
        goal: "run self test",
        taskGoal: "run self test",
        intent: "system_test",
        intentType: "system_test",
        context: { normalizedInput: "run self test", taskSpec: { taskType: "system_test" } }
      }
    });
    assert.equal(task.client_message_id, "message-1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("product result delivery cannot acknowledge persistence before verified commit", () => {
  const persistStart = mainSource.indexOf("function persistProductResult");
  const persistEnd = mainSource.indexOf("function canConnect", persistStart);
  const persist = mainSource.slice(persistStart, persistEnd);
  const mirrorStart = mainSource.indexOf("function mirrorTaskBrainTask");
  const mirrorEnd = mainSource.indexOf("function startTaskTimingWatch", mirrorStart);
  const mirror = mainSource.slice(mirrorStart, mirrorEnd);

  assert.match(mainSource, /function commitDbSnapshot\(db\)/);
  assert.match(mainSource, /writeJsonAtomicSync\(file, dbForStorage\(db\)\)/);
  assert.match(mainSource, /function writeProductResultOutbox\(record = \{\}\)/);
  assert.match(mainSource, /function verifyProductResultCommit\(sessionId = "", responseMessageId = ""\)/);
  assert.match(persist, /String\(clientMessageId \|\| taskId \|\| ""\)/);
  assert.match(persist, /saveDb\(db, \{ immediate: true, requireCommit: true \}\)/);
  assert.match(persist, /if \(!verifyProductResultCommit\(sessionId, resolvedMessageId\)\)/);
  assert.match(persist, /persistedByMain: false,[\s\S]*?deliveryPending: true,[\s\S]*?outboxAccepted/);
  assert.match(mirror, /awaitingProductDelivery[\s\S]*?status: awaitingProductDelivery \? "running"/);
  assert.match(rendererSource, /productResult\?\.deliveryPending === true && productResult\.outboxAccepted === true/);
  assert.match(rendererSource, /id: productResult\.responseMessageId/);
});
