"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inheritKnowledge, markdownFiles } = require("../services/knowledge/knowledge-inheritance");

function writeKnowledge(file, title, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ntitle: ${title}\ncategory: projects\nsource: legacy-test\n---\n\n# ${title}\n\n${body}\n`, "utf8");
}

test("legacy knowledge is backed up, merged without overwrite, and inherited idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-inheritance-"));
  const sourceRoot = path.join(root, "old", "knowledge");
  const targetRoot = path.join(root, "current", "knowledge");
  const registryFile = path.join(root, "current", "knowledge-registry.json");
  const conflictingSource = path.join(sourceRoot, "projects", "shared.md");
  const conflictingTarget = path.join(targetRoot, "projects", "shared.md");
  const newSource = path.join(sourceRoot, "resources", "new.md");
  try {
    writeKnowledge(conflictingSource, "Shared", "Legacy content must remain available.");
    writeKnowledge(conflictingTarget, "Shared", "Current content must not be overwritten.");
    writeKnowledge(newSource, "New", "A legacy-only knowledge item.");
    const originalSource = fs.readFileSync(conflictingSource, "utf8");
    const indexed = [];
    const clock = () => new Date("2026-08-27T05:00:00.000Z");

    const first = inheritKnowledge({
      targetRoot,
      candidateRoots: [sourceRoot],
      registryFile,
      now: clock,
      onImported: (file) => indexed.push(file)
    });
    assert.equal(first.imported, 2);
    assert.equal(first.conflicts, 1);
    assert.equal(first.errors, 0);
    assert.equal(indexed.length, 2);
    assert.equal(fs.readFileSync(conflictingTarget, "utf8").includes("Current content"), true);
    assert.equal(fs.readFileSync(conflictingSource, "utf8"), originalSource);
    assert.equal(markdownFiles(targetRoot).some((file) => /shared-legacy-[a-f0-9]{8}\.md$/i.test(file)), true);
    assert.equal(fs.existsSync(path.join(targetRoot, "resources", "new.md")), true);

    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(registry.activeRoot, path.resolve(targetRoot));
    assert.equal(registry.migrations.length, 1);
    const migration = registry.migrations[0];
    assert.equal(fs.existsSync(path.join(root, "current", "knowledge-backups", migration.migrationId, "knowledge", "projects", "shared.md")), true);
    assert.equal(fs.existsSync(path.join(root, "current", "knowledge-migrations", `${migration.migrationId}.json`)), true);

    const second = inheritKnowledge({ targetRoot, candidateRoots: [sourceRoot], registryFile, now: clock });
    assert.equal(second.imported, 0);
    assert.equal(markdownFiles(targetRoot).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
