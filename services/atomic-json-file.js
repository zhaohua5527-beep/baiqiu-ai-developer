"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);

function sleepSync(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJsonAtomicSync(file, value, options = {}) {
  const target = path.resolve(file);
  const io = options.fs || fs;
  const attempts = Math.max(1, Number(options.attempts || 6));
  const retryDelayMs = Math.max(1, Number(options.retryDelayMs || 8));
  const wait = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const temporary = String(options.temporaryFile || `${target}.pending-${process.pid}`);
  const serialized = JSON.stringify(value);
  let descriptor = null;

  io.mkdirSync(path.dirname(target), { recursive: true });
  try {
    descriptor = io.openSync(temporary, "w");
    io.writeFileSync(descriptor, serialized, "utf8");
    io.fsyncSync?.(descriptor);
  } finally {
    if (descriptor !== null) io.closeSync(descriptor);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      io.renameSync(temporary, target);
      return { ok: true, file: target, bytes: Buffer.byteLength(serialized), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(String(error?.code || "")) || attempt === attempts) break;
      wait(retryDelayMs * (2 ** (attempt - 1)));
    }
  }

  const error = lastError || new Error(`Unable to replace ${target}`);
  error.code ||= "ATOMIC_JSON_REPLACE_FAILED";
  error.targetFile = target;
  error.temporaryFile = temporary;
  throw error;
}

async function writeJsonAtomic(file, value, options = {}) {
  const target = path.resolve(file);
  const io = options.fs || fs.promises;
  const temporary = `${target}.pending-${process.pid}-${require("node:crypto").randomUUID()}`;
  const serialized = JSON.stringify(value);
  const serializedBytes = Buffer.byteLength(serialized);
  await io.mkdir(path.dirname(target), { recursive: true });
  let descriptor;
  try {
    descriptor = await io.open(temporary, "wx", 0o600);
    await descriptor.writeFile(serialized, "utf8");
    await descriptor.sync();
    await descriptor.close();
    descriptor = null;
    if (typeof options.beforeRename === "function" && !options.beforeRename()) {
      return { ok: false, skipped: true, file: target };
    }
    if (options.renameSync) {
      const syncIo = options.syncFs || fs;
      let lastError = null;
      for (let attempt = 1; attempt <= Math.max(1, Number(options.attempts || 6)); attempt += 1) {
        try {
          syncIo.renameSync(temporary, target);
          return { ok: true, file: target, bytes: serializedBytes, attempts: attempt };
        } catch (error) {
          lastError = error;
          if (!RETRYABLE_RENAME_CODES.has(String(error?.code || "")) || attempt === Math.max(1, Number(options.attempts || 6))) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(options.retryDelayMs || 8)) * (2 ** (attempt - 1))));
        }
      }
      throw lastError || new Error(`Unable to replace ${target}`);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await io.rename(temporary, target);
        return { ok: true, file: target };
      } catch (error) {
        if (!RETRYABLE_RENAME_CODES.has(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 8 * (2 ** attempt)));
      }
    }
  } finally {
    await descriptor?.close().catch(() => null);
    await io.unlink(temporary).catch(() => null);
  }
}

module.exports = {
  RETRYABLE_RENAME_CODES,
  writeJsonAtomicSync,
  writeJsonAtomic
};
