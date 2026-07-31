"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("../data-root");

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function candidatePaths(plan = {}) {
  const keys = new Set(["path", "filePath", "targetPath", "outputPath", "sourcePath"]);
  const found = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (!value || typeof value !== "object") {
      if (keys.has(key) && typeof value === "string") found.push(value);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(plan);
  return [...new Set(found.map((item) => path.resolve(String(item).replace(/^['"]|['"]$/g, ""))))];
}

class ExecutionCheckpointManager {
  constructor({ root = path.join(dataRoot(), "execution-checkpoints"), maxFileBytes = 20 * 1024 * 1024 } = {}) {
    this.root = root;
    this.maxFileBytes = maxFileBytes;
  }

  create({ sessionId = "", plan = {}, goal = "" } = {}) {
    const id = `checkpoint-${randomUUID()}`;
    const dir = path.join(this.root, id);
    const snapshots = [];
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    for (const [index, file] of candidatePaths(plan).entries()) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > this.maxFileBytes) continue;
        const backup = path.join(dir, "files", `${String(index).padStart(3, "0")}-${path.basename(file)}`);
        fs.copyFileSync(file, backup);
        snapshots.push({ original: file, backup, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    const checkpoint = {
      id,
      sessionId,
      goal: String(goal || "").slice(0, 2000),
      status: "ready",
      plan,
      snapshots,
      completedSteps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    atomicWrite(path.join(dir, "checkpoint.json"), checkpoint);
    return checkpoint;
  }

  update(checkpoint, patch = {}) {
    if (!checkpoint?.id) return null;
    const next = { ...checkpoint, ...patch, updatedAt: new Date().toISOString() };
    atomicWrite(path.join(this.root, checkpoint.id, "checkpoint.json"), next);
    return next;
  }

  complete(checkpoint, result = {}) {
    return this.update(checkpoint, { status: "completed", result: this.safeResult(result), completedAt: new Date().toISOString() });
  }

  fail(checkpoint, error = "") {
    return this.update(checkpoint, { status: "failed", error: String(error || "").slice(0, 2000), failedAt: new Date().toISOString() });
  }

  restore(checkpoint) {
    if (!checkpoint?.id) return { restored: 0, failed: [] };
    const restored = [];
    const failed = [];
    for (const snapshot of checkpoint.snapshots || []) {
      try {
        fs.mkdirSync(path.dirname(snapshot.original), { recursive: true });
        fs.copyFileSync(snapshot.backup, snapshot.original);
        restored.push(snapshot.original);
      } catch (error) {
        failed.push({ path: snapshot.original, error: error.message || String(error) });
      }
    }
    this.update(checkpoint, { status: failed.length ? "restore_partial" : "restored", restored, restoreFailed: failed, restoredAt: new Date().toISOString() });
    return { restored: restored.length, files: restored, failed };
  }

  safeResult(result) {
    return {
      success: Boolean(result?.normalized?.success ?? result?.success),
      toolId: result?.toolId || "",
      retryCount: Number(result?.reliability?.retryCount || 0)
    };
  }
}

module.exports = { ExecutionCheckpointManager, candidatePaths };
