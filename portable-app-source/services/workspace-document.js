"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_BYTES = 2 * 1024 * 1024;
const writes = new Map();
const editable = /\.(md|markdown|txt|json|jsonc|log|html?|[cm]?js|jsx|css|scss|less|py|ts|tsx|xml|ya?ml|toml|ini|cfg|conf|sh|ps1|bat|cmd|sql|rs|go|java|c|h|cpp|hpp|cs|vue|svelte|rb|php)$/i;
const digest = buffer => createHash("sha256").update(buffer).digest("hex");

function isEditable(source) {
  return editable.test(String(source || ""));
}

async function read(sourcePath) {
  if (!path.isAbsolute(sourcePath) || /^(?:\\\\|\/\/)/.test(sourcePath) || sourcePath.includes("\0")) {
    throw new Error("请使用本机文件的完整路径");
  }
  const source = await fs.realpath(sourcePath);
  if (!isEditable(source)) throw new Error("此文件类型不支持文本编辑");
  const handle = await fs.open(source, "r");
  let buffer;
  let stat;
  try {
    stat = await handle.stat();
    if (!stat.isFile()) throw new Error("请选择文件");
    if (stat.size > MAX_BYTES) throw new Error("文本超过 2 MB，请使用外部编辑器，避免界面卡顿");
    buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("文件正在写入，请稍后重新读取");
    }
    buffer = buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
  let encoding = "utf-8";
  let bom = "";
  if (buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) bom = "efbbbf";
  else if (buffer.subarray(0, 2).equals(Buffer.from([255, 254]))) { encoding = "utf-16le"; bom = "fffe"; }
  else if (buffer.subarray(0, 2).equals(Buffer.from([254, 255]))) { encoding = "utf-16be"; bom = "feff"; }
  let content;
  try { content = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
  catch { throw new Error("文件不是可安全识别的 UTF 文本，请使用外部编辑器，避免改变原编码"); }
  if (content.includes("\0")) throw new Error("文件含有二进制内容，不能作为文本编辑");
  return { ok: true, kind: "text", sourcePath: source, previewText: content,
    contentHash: digest(buffer), modifiedAt: stat.mtimeMs, encoding, bom,
    lineEnding: content.includes("\r\n") && !/(?<!\r)\n/.test(content) ? "CRLF" : "LF",
    truncated: false };
}

async function save(payload) {
  const requested = String(payload.sourcePath || "");
  if (!path.isAbsolute(requested) || /^(?:\\\\|\/\/)/.test(requested) || requested.includes("\0")) {
    throw new Error("请使用本机文件的完整路径");
  }
  const source = await fs.realpath(String(payload.sourcePath || ""));
  const previous = writes.get(source) || Promise.resolve();
  const operation = previous.catch(() => null).then(async () => {
    const original = await read(source);
    if (!payload.expectedHash || original.contentHash !== payload.expectedHash) {
      throw new Error("原文件已更改，未覆盖。请查看磁盘版本并合并修改后再保存");
    }
    if (typeof payload.content !== "string") throw new Error("保存内容必须是文本");
    const content = original.lineEnding === "CRLF" ? payload.content.replace(/\r?\n/g, "\r\n") : payload.content;
    let body = Buffer.from(content, original.encoding === "utf-8" ? "utf8" : "utf16le");
    if (original.encoding === "utf-16be") body.swap16();
    body = Buffer.concat([Buffer.from(original.bom, "hex"), body]);
    if (body.length > MAX_BYTES) throw new Error("内容超过 2 MB，未写入原文件");
    const temporary = path.join(path.dirname(source), `.${path.basename(source)}.baiqiu-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", (await fs.stat(source)).mode);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = null;
      const current = await read(source);
      if (current.contentHash !== original.contentHash) throw new Error("保存期间原文件发生变化，未覆盖，请重新读取");
      await fs.rename(temporary, source);
    } finally {
      await handle?.close().catch(() => null);
      await fs.unlink(temporary).catch(() => null);
    }
    return { ok: true, file: source, contentHash: digest(body),
      modifiedAt: (await fs.stat(source)).mtimeMs, savedAt: new Date().toISOString() };
  });
  writes.set(source, operation);
  try { return await operation; }
  finally { if (writes.get(source) === operation) writes.delete(source); }
}

module.exports = { read, save, isEditable, MAX_BYTES };
