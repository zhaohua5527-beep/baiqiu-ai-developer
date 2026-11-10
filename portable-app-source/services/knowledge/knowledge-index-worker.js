"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const { KnowledgeSearchIndex } = require("./knowledge-search-index");
const { KnowledgeVault, parseMarkdown } = require("./knowledge-vault");

function hash(title, body) {
  return crypto.createHash("sha256").update(`${String(title || "").trim().toLowerCase()}\n${String(body || "").replace(/\s+/g, " ").trim()}`).digest("hex");
}

function indexDocument(vault, index, file, usageStore) {
  const stat = fs.statSync(file);
  const id = vault.idFor(file);
  const previous = index.signature(id);
  if (previous && Number(previous.mtimeMs) === stat.mtimeMs && Number(previous.byteSize) === stat.size) return { id, changed: false };
  const raw = fs.readFileSync(file, "utf8");
  const note = vault.digest(file, { usageStore });
  const body = parseMarkdown(raw).body || "";
  index.upsert({
    ...note,
    body,
    mtimeMs: stat.mtimeMs,
    contentHash: hash(note.title, body)
  });
  return { id, changed: true };
}

function reconcileKnowledgeIndex({ storageRoot, dbPath, cleanup = false } = {}) {
  const vault = new KnowledgeVault({ rootProvider: () => storageRoot, enableSearchIndex: false });
  const index = new KnowledgeSearchIndex({ dbPath });
  const cleanupReport = cleanup ? vault.cleanupInactive({ permanentlyDelete: false }) : null;
  const usageStore = vault.readUsageStore();
  const seen = new Set();
  const errors = [];
  let scanned = 0;
  let upserted = 0;
  let removed = 0;
  try {
    for (const file of vault.files()) {
      scanned += 1;
      try {
        const result = indexDocument(vault, index, file, usageStore);
        seen.add(result.id);
        if (result.changed) upserted += 1;
      } catch (error) {
        errors.push({ filePath: file, error: error?.message || String(error) });
      }
    }
    for (const id of index.ids()) {
      if (seen.has(id)) continue;
      const signature = index.signature(id);
      if (signature?.filePath && fs.existsSync(signature.filePath)) continue;
      index.remove(id);
      removed += 1;
    }
    const completedAt = new Date().toISOString();
    index.setMeta("last_reconciled_at", completedAt);
    index.setMeta("last_reconcile_errors", String(errors.length));
    return { ok: true, scanned, upserted, removed, errors, cleanup: cleanupReport, completedAt, total: index.count() };
  } finally {
    index.close();
  }
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ type: "complete", result: reconcileKnowledgeIndex(workerData || {}) });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error?.stack || error?.message || String(error) });
  }
}

module.exports = { reconcileKnowledgeIndex, indexDocument };
