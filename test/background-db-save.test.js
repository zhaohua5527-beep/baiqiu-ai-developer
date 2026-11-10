"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { BackgroundJsonSnapshot } = require("../services/background-json-snapshot");
const { writeJsonAtomicSync } = require("../services/atomic-json-file");
const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

test("worker stages a complete snapshot without replacing the committed database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-worker-stage-"));
  const file = path.join(root, "db.json");
  fs.writeFileSync(file, '{"version":1}');
  const writer = new BackgroundJsonSnapshot();
  try {
    const value = { version: 2, messages: [{ text: "保留全部内容".repeat(10000) }] };
    const staged = await writer.stage(file, value);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(staged.temporaryFile, "utf8")), value);
    fs.renameSync(staged.temporaryFile, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value);
    assert.deepEqual(fs.readdirSync(root), ["db.json"]);
  } finally {
    await writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-db-fence-"));
  const file = path.join(root, "db.json");
  fs.writeFileSync(file, '{"version":0}');
  const stages = [];
  const stageWaiters = new Map();
  class DeferredWriter {
    stage(target, value) {
      const temporaryFile = path.join(root, `stage-${stages.length}.json`);
      fs.writeFileSync(temporaryFile, JSON.stringify(value));
      return new Promise((resolve, reject) => {
        const index = stages.length;
        stages.push({ resolve: () => resolve({ temporaryFile, bytes: 1 }), reject });
        stageWaiters.get(index)?.();
      });
    }
  }
  const context = vm.createContext({ fs, setTimeout, clearTimeout, console: { error() {} },
    dbPath: () => file, dbCache: null, _messagesCacheMeta: {}, _messagesRawCache: "",
    BackgroundJsonSnapshot: DeferredWriter, writeJsonAtomicSync,
    mergeCachedMessagesIntoDb() {}, dbForStorage: db => db });
  vm.runInContext(main.slice(main.indexOf("let saveDbPending = null"), main.indexOf("function ensureIntentAgent")) +
    "\nfunction queueSnapshot(db) { saveDbPending = db; dbCache = db; dbFlushGeneration += 1; }", context);
  return { context, stages, file,
    waitForStage: index => stages[index] ? Promise.resolve() : new Promise(resolve => stageWaiters.set(index, resolve)),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("an old worker snapshot cannot overwrite a newer synchronous commit", async () => {
  const fixture = harness();
  try {
    fixture.context.queueSnapshot({ version: 1 });
    const background = fixture.context.flushDbAsync();
    fixture.context.queueSnapshot({ version: 2, messages: ["新消息"] });
    assert.equal(fixture.context.flushDbSync().ok, true);
    fixture.stages[0].resolve();
    assert.equal((await background).skipped, true);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).version, 2);
  } finally { fixture.close(); }
});

test("concurrent flush callers serialize snapshots and commit the newest pending messages", async () => {
  const fixture = harness();
  try {
    fixture.context.queueSnapshot({ version: 1 });
    const first = fixture.context.flushDbAsync();
    fixture.context.queueSnapshot({ version: 2, messages: ["第一条", "第二条"] });
    const second = fixture.context.flushDbAsync();
    assert.equal(fixture.stages.length, 1);
    fixture.stages[0].resolve();
    await fixture.waitForStage(1);
    assert.equal(fixture.stages.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).version, 0);
    fixture.stages[1].resolve();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file)).messages, ["第一条", "第二条"]);
  } finally { fixture.close(); }
});

test("failed background write retains the committed file and retries the pending data", async () => {
  const fixture = harness();
  try {
    fixture.context.queueSnapshot({ version: 1 });
    const pending = fixture.context.flushDbAsync();
    fixture.stages[0].reject(new Error("disk unavailable"));
    assert.equal((await pending).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).version, 0);
    assert.equal(fixture.context.flushDbSync().ok, true);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).version, 1);
  } finally { fixture.close(); }
});

test("exit flush saves an in-flight snapshot even when the pending queue is empty", async () => {
  const fixture = harness();
  try {
    fixture.context.queueSnapshot({ version: 1, messages: ["退出前的消息"] });
    const pending = fixture.context.flushDbAsync();
    assert.equal(fixture.context.flushDbSync().ok, true);
    fixture.stages[0].resolve();
    await pending;
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file)).messages, ["退出前的消息"]);
  } finally { fixture.close(); }
});

test("all concurrent persistence waiters receive a write failure", async () => {
  const fixture = harness();
  try {
    fixture.context.queueSnapshot({ version: 1 });
    const first = fixture.context.flushDbAsync();
    const second = fixture.context.flushDbAsync();
    fixture.stages[0].reject(new Error("disk unavailable"));
    assert.equal((await first).ok, false);
    assert.equal((await second).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).version, 0);
    assert.equal(fixture.context.flushDbSync().ok, true);
  } finally { fixture.close(); }
});
