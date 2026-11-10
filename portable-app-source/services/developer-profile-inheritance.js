"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { writeJsonAtomicSync } = require("./atomic-json-file");

const EXCLUDED_AREAS = [
  "activation",
  "authorization",
  "billing",
  "browser-profile",
  "customerProfile",
  "license",
  "membership",
  "messages",
  "projects",
  "sessions",
  "update"
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function modelSettings(settings = {}) {
  return {
    defaultProvider: String(settings.defaultProvider || "").trim(),
    reasoning: String(settings.reasoning || "").trim(),
    providers: clone(settings.providers && typeof settings.providers === "object" ? settings.providers : {})
  };
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeTimestamp(now) {
  return now().toISOString().replace(/[:.]/g, "-");
}

function inheritDeveloperProfile({
  sourceDbFile,
  targetDbFile,
  targetTemplate = {},
  manifestFile,
  backupRoot,
  now = () => new Date()
} = {}) {
  if (!sourceDbFile || !targetDbFile || !manifestFile || !backupRoot) {
    throw new Error("Developer profile inheritance requires source, target, manifest, and backup paths.");
  }
  const sourceFile = path.resolve(sourceDbFile);
  const targetFile = path.resolve(targetDbFile);
  if (sourceFile === targetFile) throw new Error("Developer profile inheritance cannot target production data.");

  const existingTarget = readJson(targetFile, null);
  const target = existingTarget || clone(targetTemplate) || {};
  if (!existingTarget && !fs.existsSync(targetFile)) writeJsonAtomicSync(targetFile, target);

  const source = readJson(sourceFile, null);
  if (!source?.settings || typeof source.settings !== "object") {
    return { ok: false, applied: false, reason: "source_unavailable", sourceFile, targetFile };
  }

  const sourceModel = modelSettings(source.settings);
  if (!sourceModel.defaultProvider || !Object.keys(sourceModel.providers).length) {
    return { ok: false, applied: false, reason: "source_model_unconfigured", sourceFile, targetFile };
  }

  const previousManifest = readJson(manifestFile, {});
  const sourceFingerprint = fingerprint(sourceModel);
  const targetFingerprint = fingerprint(modelSettings(target.settings || {}));
  const targetWasModified = Boolean(
    previousManifest.appliedModelFingerprint
    && targetFingerprint !== previousManifest.appliedModelFingerprint
  );
  if (previousManifest.sourceModelFingerprint === sourceFingerprint || targetWasModified) {
    return {
      ok: true,
      applied: false,
      reason: targetWasModified ? "developer_model_modified" : "already_inherited",
      sourceFile,
      targetFile
    };
  }

  let backupFile = "";
  if (existingTarget) {
    fs.mkdirSync(backupRoot, { recursive: true });
    backupFile = path.join(backupRoot, `heiqiu-db.before-model-inheritance-${safeTimestamp(now)}.json`);
    fs.copyFileSync(targetFile, backupFile, fs.constants.COPYFILE_EXCL);
  }

  target.settings = {
    ...(target.settings || {}),
    providers: sourceModel.providers,
    defaultProvider: sourceModel.defaultProvider,
    reasoning: sourceModel.reasoning || target.settings?.reasoning || "maximum"
  };
  delete target.settings.modelRuntime;
  writeJsonAtomicSync(targetFile, target);

  const appliedModelFingerprint = fingerprint(modelSettings(target.settings));
  const manifest = {
    schemaVersion: 1,
    status: "applied",
    importedAt: now().toISOString(),
    sourceDbFile: sourceFile,
    targetDbFile: targetFile,
    backupFile,
    defaultProvider: sourceModel.defaultProvider,
    providerIds: Object.keys(sourceModel.providers).sort(),
    sourceModelFingerprint: sourceFingerprint,
    appliedModelFingerprint,
    excludedAreas: EXCLUDED_AREAS
  };
  writeJsonAtomicSync(manifestFile, manifest);
  return { ok: true, applied: true, sourceFile, targetFile, backupFile, manifest };
}

module.exports = {
  EXCLUDED_AREAS,
  inheritDeveloperProfile,
  modelSettings
};
