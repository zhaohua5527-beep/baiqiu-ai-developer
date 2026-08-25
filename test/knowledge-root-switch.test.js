"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { KnowledgeVault } = require("../services/knowledge/knowledge-vault");

test("knowledge index follows a changed Markdown root", () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-root-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-root-b-"));
  let root = first;
  const opened = [];
  class FakeIndex {
    constructor({ dbPath }) { this.dbPath = dbPath; opened.push(dbPath); }
    close() { this.closed = true; }
  }
  const vault = new KnowledgeVault({ rootProvider: () => root, SearchIndexClass: FakeIndex });
  try {
    const indexA = vault.ensureSearchIndex();
    root = second;
    const indexB = vault.ensureSearchIndex();
    assert.notEqual(indexA, indexB);
    assert.equal(indexA.closed, true);
    assert.equal(opened[0], path.join(first, "knowledge", ".baiqiu", "knowledge-index.sqlite"));
    assert.equal(opened[1], path.join(second, "knowledge", ".baiqiu", "knowledge-index.sqlite"));
  } finally {
    vault.close();
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("settings save resets the knowledge queue and vault", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("settings:save"');
  const end = source.indexOf('ipcMain.handle("customer-profile:complete"', start);
  const handler = source.slice(start, end);
  assert.match(handler, /const saved = saveDb\(db\)\.settings;[\s\S]*?refreshCapabilities\(\);\s*resetKnowledgeRuntime\(\);/);
});
