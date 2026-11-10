"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { writeJsonAtomic } = require("../services/atomic-json-file");

test("async atomic JSON write serializes once and reports the written byte count", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-atomic-"));
  const file = path.join(directory, "state.json");
  const value = { version: 1, messages: ["a", "b"], nested: { ok: true } };

  const result = await writeJsonAtomic(file, value, { renameSync: true });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an obsolete async snapshot is skipped before atomic rename", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-atomic-"));
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file, JSON.stringify({ version: "new" }));

  const result = await writeJsonAtomic(file, { version: "old" }, {
    renameSync: true,
    beforeRename: () => false
  });

  assert.deepEqual(result, { ok: false, skipped: true, file: path.resolve(file) });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: "new" });
  assert.equal(fs.readdirSync(directory).some((name) => name.includes(".pending-")), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
