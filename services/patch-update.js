"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");

// The matching private key is kept only on the release machine.
const PATCH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvgwkCd/0+G/cd8K3eSxfSHtPHY4lR1jA2TP1zhn6NZM=
-----END PUBLIC KEY-----`;
const MAX_PATCH_MANIFEST_BYTES = 1024 * 1024;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function patchPayload(manifest = {}) {
  const value = { ...manifest };
  delete value.signature;
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function signPatchManifest(manifest, privateKey) {
  if (!privateKey) throw new Error("Missing patch signing private key");
  return {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      value: crypto.sign(null, patchPayload(manifest), privateKey).toString("base64")
    }
  };
}

function safePatchPath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  const normalized = raw.replace(/^\/+/, "");
  if (!normalized || raw.includes(":") || normalized.includes("../") || normalized === ".." || /\0/.test(normalized)) throw new Error("Patch contains an unsafe file path");
  return normalized;
}

function verifyPatchManifest(manifest, { publicKey = PATCH_PUBLIC_KEY, fromVersion = "", toVersion = "" } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("Patch manifest is missing");
  if (manifest.schemaVersion !== 1 || manifest.packageType !== "file-patch") throw new Error("Unsupported patch package");
  if (!String(manifest.fromVersion || "").trim() || !String(manifest.toVersion || "").trim()) throw new Error("Patch manifest is missing version information");
  if (fromVersion && String(manifest.fromVersion) !== String(fromVersion)) throw new Error(`Patch base version mismatch: expected ${fromVersion}, got ${manifest.fromVersion}`);
  if (toVersion && String(manifest.toVersion) !== String(toVersion)) throw new Error(`Patch target version mismatch: expected ${toVersion}, got ${manifest.toVersion}`);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Patch manifest has no file operations");
  for (const file of manifest.files) {
    safePatchPath(file?.path);
    if (!["replace", "delete"].includes(file?.operation)) throw new Error("Patch manifest has an invalid file operation");
    if (file.operation === "replace" && !/^[a-f0-9]{64}$/i.test(String(file.after?.sha256 || ""))) throw new Error("Patch manifest has an invalid target hash");
    if (file.before?.sha256 && !/^[a-f0-9]{64}$/i.test(String(file.before.sha256))) throw new Error("Patch manifest has an invalid base hash");
  }
  const signature = manifest.signature;
  if (signature?.algorithm !== "ed25519" || !signature.value) throw new Error("Patch manifest is unsigned");
  const valid = crypto.verify(null, patchPayload(manifest), publicKey, Buffer.from(String(signature.value), "base64"));
  if (!valid) throw new Error("Patch signature verification failed");
  return manifest;
}

function readAt(filePath, offset, size) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(descriptor, buffer, 0, size, offset);
    return read === size ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

function zipEntry(zipPath, wantedName) {
  const size = fs.statSync(zipPath).size;
  const tailLength = Math.min(size, 0xffff + 22);
  const tail = readAt(zipPath, size - tailLength, tailLength);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Update package is not a supported ZIP file");
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (centralSize <= 0 || centralSize > 64 * 1024 * 1024) throw new Error("Update ZIP central directory is invalid");
  const central = readAt(zipPath, centralOffset, centralSize);
  let offset = 0;
  while (offset + 46 <= central.length) {
    if (central.readUInt32LE(offset) !== 0x02014b50) throw new Error("Update ZIP central directory is corrupt");
    const method = central.readUInt16LE(offset + 10);
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const localOffset = central.readUInt32LE(offset + 42);
    // Compress-Archive on Windows writes central-directory names with backslashes.
    // ZIP readers must treat both separators as the same logical package path.
    const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    if (name === wantedName) return { method, compressedSize, uncompressedSize, localOffset };
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function readZipEntry(zipPath, wantedName, maximumSize = MAX_PATCH_MANIFEST_BYTES) {
  const entry = zipEntry(zipPath, wantedName);
  if (!entry) return null;
  if (entry.uncompressedSize > maximumSize || entry.compressedSize > maximumSize) throw new Error("Patch manifest is too large");
  const header = readAt(zipPath, entry.localOffset, 30);
  if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error("Update ZIP local entry is invalid");
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const compressed = readAt(zipPath, entry.localOffset + 30 + nameLength + extraLength, entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new Error("Update ZIP entry is incomplete");
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: maximumSize });
  throw new Error("Patch manifest uses an unsupported ZIP compression method");
}

function validateFullClientManifest(manifest, { toVersion = "" } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("Full update manifest is missing");
  if (manifest.packageType !== "full-client") throw new Error("Update package is not a full-client release");
  if (!String(manifest.version || "").trim()) throw new Error("Full update manifest is missing version information");
  if (toVersion && String(manifest.version) !== String(toVersion)) {
    throw new Error(`Package version mismatch: expected ${toVersion}, got ${manifest.version}`);
  }
  if (!manifest.executable?.path || !/^[a-f0-9]{64}$/i.test(String(manifest.executable.sha256 || ""))) {
    throw new Error("Full update manifest is missing executable integrity data");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 10) throw new Error("Full update manifest has too few files");
  for (const file of manifest.files) {
    safePatchPath(file?.path);
    if (!Number.isFinite(Number(file?.size)) || Number(file.size) < 0 || !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || ""))) {
      throw new Error("Full update manifest has an invalid file entry");
    }
  }
  return manifest;
}

function inspectUpdatePackage(zipPath, options = {}) {
  const content = readZipEntry(zipPath, "patch-manifest.json");
  if (content) {
    let manifest;
    try { manifest = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error("Patch manifest is not valid JSON"); }
    return { packageType: "file-patch", manifest: verifyPatchManifest(manifest, options) };
  }
  const fullContent = readZipEntry(zipPath, "client/release-manifest.json") || readZipEntry(zipPath, "release-manifest.json");
  if (!fullContent) throw new Error("Full update package is missing release-manifest.json");
  let manifest;
  try { manifest = JSON.parse(fullContent.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error("Full update manifest is not valid JSON"); }
  return { packageType: "full-client", manifest: validateFullClientManifest(manifest, options) };
}

module.exports = {
  PATCH_PUBLIC_KEY,
  canonicalValue,
  patchPayload,
  signPatchManifest,
  verifyPatchManifest,
  validateFullClientManifest,
  inspectUpdatePackage,
  readZipEntry,
  safePatchPath
};
