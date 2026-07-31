"use strict";

const fs = require("node:fs");
const path = require("node:path");

function cleanText(value = "") {
  return String(value || "").trim();
}

function compareVersions(leftValue, rightValue) {
  const normalize = (value) => cleanText(value || "0.0.0")
    .replace(/^v/i, "")
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => Number((String(part).match(/^\d+/) || ["0"])[0]));
  const left = normalize(leftValue);
  const right = normalize(rightValue);
  for (let index = 0; index < Math.max(left.length, right.length, 3); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return 1;
    if ((left[index] || 0) < (right[index] || 0)) return -1;
  }
  return 0;
}

function normalizeManifest(manifest = {}, { currentVersion = "0.0.0", manifestUrl = "" } = {}) {
  const latestVersion = cleanText(manifest.version || manifest.latestVersion);
  if (!latestVersion) throw new Error("latest.json is missing version");
  const downloadUrl = cleanText(manifest.downloadUrl || manifest.packageUrl || manifest.url);
  const updateNote = cleanText(manifest.updateNote || manifest.changelog || manifest.releaseNotes || manifest.notes);
  const size = Number(manifest.size || manifest.fileSize || 0);
  return {
    configured: true,
    mode: "latest-json",
    manifestUrl,
    name: cleanText(manifest.name || "Baiqiu AI"),
    currentVersion: cleanText(currentVersion || "0.0.0"),
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    forceUpdate: Boolean(manifest.forceUpdate),
    downloadUrl,
    packageUrl: downloadUrl,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    fileSize: Number.isFinite(size) && size > 0 ? size : 0,
    packageType: cleanText(manifest.packageType || ""),
    updateNote,
    changelog: updateNote,
    releaseNotes: updateNote,
    notes: updateNote ? [updateNote] : [],
    checksum: cleanText(manifest.checksum || manifest.sha256),
    sha256: cleanText(manifest.checksum || manifest.sha256)
  };
}

function appendUpdateLog(logPath, entry = {}) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function checkOnlineUpdate({ manifestUrl, currentVersion, logPath = "", source = "manual", fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const requestTime = new Date().toISOString();
  if (typeof fetchImpl !== "function") throw new Error("Online update checks are not supported by this runtime");
  if (!/^https?:\/\//i.test(cleanText(manifestUrl))) throw new Error("A valid HTTP(S) manifest URL is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 12000));
  try {
    const response = await fetchImpl(manifestUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = normalizeManifest(await response.json(), { currentVersion, manifestUrl });
    appendUpdateLog(logPath, {
      requestTime,
      source,
      manifestUrl,
      currentVersion: info.currentVersion,
      serverVersion: info.latestVersion,
      result: info.hasUpdate ? "UPDATE_AVAILABLE" : "UP_TO_DATE",
      downloadUrl: info.downloadUrl,
      updateNote: info.updateNote
    });
    return info;
  } catch (error) {
    appendUpdateLog(logPath, {
      requestTime,
      source,
      manifestUrl,
      currentVersion: cleanText(currentVersion),
      serverVersion: "",
      result: "REQUEST_FAILED",
      error: cleanText(error?.message || error)
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkOnlineUpdate, normalizeManifest, compareVersions, appendUpdateLog };
