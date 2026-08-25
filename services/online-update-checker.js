"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PATCH_PUBLIC_KEY, canonicalValue } = require("./patch-update");

// The release machine keeps the matching private key. HTTP transport is safe
// only because every security-sensitive manifest field is signed here.
const UPDATE_MANIFEST_PUBLIC_KEY = PATCH_PUBLIC_KEY;

function cleanText(value = "") {
  return String(value || "").trim();
}

// 校验更新包下载地址是否真实可达（HEAD 请求）。
// 清单声明有更新但 downloadUrl 404 是"虚假更新"的根源——客户端会看到
// "有更新"却下载失败。这里是清单消费前的最后一道真实性校验。
async function downloadUrlReachable(downloadUrl, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!downloadUrl || !/^https?:\/\//i.test(cleanText(downloadUrl))) return false;
  if (typeof fetchImpl !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10000));
  try {
    const response = await fetchImpl(downloadUrl, { method: "HEAD", signal: controller.signal, cache: "no-store", redirect: "follow" });
    return response.ok || response.status === 200 || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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

function onlineManifestPayload(manifest = {}) {
  const value = { ...manifest };
  delete value.signature;
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function signOnlineManifest(manifest, privateKey) {
  if (!privateKey) throw new Error("Missing online update signing private key");
  return {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      value: crypto.sign(null, onlineManifestPayload(manifest), privateKey).toString("base64")
    }
  };
}

function verifyOnlineManifest(manifest, { publicKey = UPDATE_MANIFEST_PUBLIC_KEY, currentVersion = "0.0.0" } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Online update manifest is missing");
  if (Number(manifest.schemaVersion) !== 1) throw new Error("Unsupported online update manifest schema");
  if (cleanText(manifest.manifestType) !== "baiqiu-online-update") throw new Error("Unsupported online update manifest type");
  const signature = manifest.signature;
  if (signature?.algorithm !== "ed25519" || !cleanText(signature.value)) throw new Error("Online update manifest is unsigned");
  let signatureBytes;
  try { signatureBytes = Buffer.from(cleanText(signature.value), "base64"); }
  catch { throw new Error("Online update manifest signature is invalid"); }
  if (signatureBytes.length !== 64 || !crypto.verify(null, onlineManifestPayload(manifest), publicKey, signatureBytes)) {
    throw new Error("Online update manifest signature verification failed");
  }
  const version = cleanText(manifest.version || manifest.latestVersion);
  if (!version) throw new Error("Online update manifest is missing version");
  if (compareVersions(version, currentVersion) < 0) {
    throw new Error(`Online update downgrade blocked: ${currentVersion} -> ${version}`);
  }
  const downloadUrl = cleanText(manifest.downloadUrl || manifest.packageUrl || manifest.url);
  const checksum = cleanText(manifest.checksum || manifest.sha256);
  if (compareVersions(version, currentVersion) > 0) {
    if (!/^https?:\/\//i.test(downloadUrl)) throw new Error("Online update manifest has an invalid package URL");
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error("Online update manifest is missing a valid SHA-256");
  }
  return manifest;
}

function normalizeManifest(manifest = {}, { currentVersion = "0.0.0", manifestUrl = "" } = {}) {
  const latestVersion = cleanText(manifest.version || manifest.latestVersion);
  if (!latestVersion) throw new Error("latest.json is missing version");
  const downloadUrl = cleanText(manifest.downloadUrl || manifest.packageUrl || manifest.url);
  const installerUrl = cleanText(manifest.installerUrl || manifest.setupUrl || manifest.installer?.url);
  const updateNote = cleanText(manifest.updateNote || manifest.changelog || manifest.releaseNotes || manifest.notes);
  const size = Number(manifest.size || manifest.fileSize || manifest.zipSize || 0);
  const installerSize = Number(manifest.installerSize || manifest.setupSize || manifest.installer?.size || 0);
  return {
    configured: true,
    mode: "signed-update-json",
    signatureVerified: true,
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
    installerUrl,
    installerChecksum: cleanText(manifest.installerSha256 || manifest.installerChecksum || manifest.installer?.sha256),
    installerSha256: cleanText(manifest.installerSha256 || manifest.installerChecksum || manifest.installer?.sha256),
    installerSize: Number.isFinite(installerSize) && installerSize > 0 ? installerSize : 0,
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

async function checkOnlineUpdate({ manifestUrl, currentVersion, logPath = "", source = "manual", fetchImpl = globalThis.fetch, timeoutMs = 12000, publicKey = UPDATE_MANIFEST_PUBLIC_KEY } = {}) {
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
    const manifest = await response.json();
    verifyOnlineManifest(manifest, { publicKey, currentVersion });
    const info = normalizeManifest(manifest, { currentVersion, manifestUrl });
    // 真实性校验：清单说有更新，但 downloadUrl 不可达（404）→ 不算有更新，
    // 避免"检查更新发现有版本，下载时却 404"的虚假更新。
    if (info.hasUpdate) {
      const reachable = await downloadUrlReachable(info.downloadUrl, { fetchImpl, timeoutMs });
      if (!reachable) {
        info.hasUpdate = false;
        info.updateBlocked = true;
        info.blockReason = `更新包地址不可达：${info.downloadUrl || "(空)"}`;
      }
    }
    appendUpdateLog(logPath, {
      requestTime,
      source,
      manifestUrl,
      currentVersion: info.currentVersion,
      serverVersion: info.latestVersion,
      result: info.hasUpdate ? "UPDATE_AVAILABLE" : info.updateBlocked ? "UPDATE_BLOCKED_UNREACHABLE" : "UP_TO_DATE",
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

module.exports = {
  UPDATE_MANIFEST_PUBLIC_KEY,
  checkOnlineUpdate,
  normalizeManifest,
  compareVersions,
  appendUpdateLog,
  downloadUrlReachable,
  onlineManifestPayload,
  signOnlineManifest,
  verifyOnlineManifest
};
