"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseMarkdown, knowledgeContentHash } = require("./knowledge-vault");

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function markdownFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".baiqiu") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(file);
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  return files.sort();
}

function contentHash(file) {
  const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
  const title = String(parsed.meta?.title || path.basename(file, path.extname(file))).trim();
  return knowledgeContentHash(title, parsed.body || "");
}

function fingerprint(sourceRoot, targetRoot, entries) {
  const source = [path.resolve(sourceRoot), path.resolve(targetRoot), ...entries.map((entry) => `${entry.relative}:${entry.hash}`)].join("\n");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function copyAtomic(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.migration-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temporary, target);
  const stat = fs.statSync(source);
  try { fs.utimesSync(target, stat.atime, stat.mtime); } catch {}
}

function conflictTarget(file, hash) {
  const extension = path.extname(file);
  const base = file.slice(0, -extension.length);
  const preferred = `${base}-legacy-${hash.slice(0, 8)}${extension}`;
  if (!fs.existsSync(preferred)) return preferred;
  let index = 2;
  while (fs.existsSync(`${base}-legacy-${hash.slice(0, 8)}-${index}${extension}`)) index += 1;
  return `${base}-legacy-${hash.slice(0, 8)}-${index}${extension}`;
}

function inheritKnowledge({ targetRoot, candidateRoots = [], registryFile, now = () => new Date(), onImported = null } = {}) {
  const target = path.resolve(String(targetRoot || ""));
  if (!targetRoot || !registryFile) throw new Error("Knowledge inheritance requires targetRoot and registryFile.");
  fs.mkdirSync(target, { recursive: true });

  const registry = readJson(registryFile, { schemaVersion: 1, activeRoot: "", knownRoots: [], migrations: [] });
  const knownRoots = [...new Set([...(registry.knownRoots || []), ...candidateRoots]
    .map((item) => { try { return path.resolve(String(item || "")); } catch { return ""; } })
    .filter(Boolean))];
  const roots = knownRoots.filter((item) => item !== target
    && !item.startsWith(`${target}${path.sep}`)
    && !target.startsWith(`${item}${path.sep}`)
    && fs.existsSync(item)
    && fs.statSync(item).isDirectory());
  const targetHashes = new Map();
  for (const file of markdownFiles(target)) {
    try { targetHashes.set(contentHash(file), file); } catch {}
  }

  const completed = [];
  for (const sourceRoot of roots) {
    const entries = markdownFiles(sourceRoot).map((file) => {
      try { return { file, relative: path.relative(sourceRoot, file), hash: contentHash(file) }; }
      catch (error) { return { file, relative: path.relative(sourceRoot, file), hash: "", error: error?.message || String(error) }; }
    });
    const pending = entries.filter((entry) => entry.hash && !targetHashes.has(entry.hash));
    if (!pending.length) continue;

    const migrationHash = fingerprint(sourceRoot, target, entries);
    const migrationId = `knowledge-${migrationHash.slice(0, 16)}`;
    const startedAt = now().toISOString();
    const migrationRoot = path.join(path.dirname(target), "knowledge-migrations");
    const manifestFile = path.join(migrationRoot, `${migrationId}.json`);
    const backupRoot = path.join(path.dirname(target), "knowledge-backups", migrationId, "knowledge");
    const manifest = {
      schemaVersion: 1,
      migrationId,
      sourceRoot,
      targetRoot: target,
      startedAt,
      completedAt: "",
      status: "running",
      imported: 0,
      merged: 0,
      conflicts: 0,
      skipped: entries.length - pending.length,
      errors: [],
      contentHashes: Object.fromEntries(entries.filter((entry) => entry.hash).map((entry) => [entry.relative.replace(/\\/g, "/"), entry.hash]))
    };
    writeJson(manifestFile, manifest);

    try {
      if (!fs.existsSync(backupRoot)) {
        fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
        const temporaryBackup = `${backupRoot}.tmp-${process.pid}-${Date.now()}`;
        try {
          fs.cpSync(sourceRoot, temporaryBackup, { recursive: true, errorOnExist: true, force: false });
          fs.renameSync(temporaryBackup, backupRoot);
        } catch (error) {
          try { fs.rmSync(temporaryBackup, { recursive: true, force: true }); } catch {}
          throw error;
        }
      }
    } catch (error) {
      manifest.status = "failed";
      manifest.errors.push({ stage: "backup", error: error?.message || String(error) });
      manifest.completedAt = now().toISOString();
      writeJson(manifestFile, manifest);
      completed.push(manifest);
      continue;
    }

    for (const entry of entries) {
      if (!entry.hash) {
        manifest.errors.push({ file: entry.relative, error: entry.error || "Unable to hash knowledge file." });
        continue;
      }
      if (targetHashes.has(entry.hash)) continue;
      try {
        let destination = path.resolve(target, entry.relative);
        if (destination !== target && !destination.startsWith(`${target}${path.sep}`)) throw new Error("Knowledge path escapes target root.");
        let conflicted = false;
        if (fs.existsSync(destination)) {
          destination = conflictTarget(destination, entry.hash);
          conflicted = true;
        }
        copyAtomic(entry.file, destination);
        targetHashes.set(entry.hash, destination);
        manifest.imported += 1;
        manifest.merged += conflicted ? 0 : 1;
        manifest.conflicts += conflicted ? 1 : 0;
        onImported?.(destination);
      } catch (error) {
        manifest.errors.push({ file: entry.relative, error: error?.message || String(error) });
      }
    }
    manifest.status = manifest.errors.length ? "completed_with_errors" : "completed";
    manifest.completedAt = now().toISOString();
    writeJson(manifestFile, manifest);
    completed.push(manifest);
  }

  const migrationSummaries = completed.map(({ contentHashes, errors, ...item }) => ({ ...item, errorCount: errors.length }));
  const migrationHistory = new Map((registry.migrations || []).map((item) => [item.migrationId, item]));
  for (const item of migrationSummaries) migrationHistory.set(item.migrationId, item);
  writeJson(registryFile, {
    schemaVersion: 1,
    activeRoot: target,
    knownRoots: [...new Set([target, ...knownRoots])],
    lastVerifiedAt: now().toISOString(),
    lastMigrationId: migrationSummaries.at(-1)?.migrationId || registry.lastMigrationId || "",
    migrations: [...migrationHistory.values()].slice(-100)
  });
  return {
    activeRoot: target,
    sources: roots.length,
    imported: completed.reduce((sum, item) => sum + item.imported, 0),
    conflicts: completed.reduce((sum, item) => sum + item.conflicts, 0),
    errors: completed.reduce((sum, item) => sum + item.errors.length, 0),
    migrations: migrationSummaries
  };
}

module.exports = { inheritKnowledge, markdownFiles };
