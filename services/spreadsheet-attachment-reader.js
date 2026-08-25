const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

function dataUrlBuffer(dataUrl = "") {
  const match = String(dataUrl).match(/^data:[^,]*;base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? Buffer.from(match[1].replace(/\s+/g, ""), "base64") : null;
}

function isCsvAttachment(attachment = {}) {
  return path.extname(String(attachment.name || attachment.path || "")).toLowerCase() === ".csv"
    || /(?:^|\/)csv(?:;|$)/i.test(String(attachment.mimeType || ""));
}

function detectCsvEncoding(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "gbk";
  }
}

function readSpreadsheetWorkbook(XLSX, buffer, attachment = {}) {
  if (!XLSX) throw new Error("Missing xlsx parser");
  let input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const options = { type: "buffer", cellDates: true };
  const encoding = isCsvAttachment(attachment) ? detectCsvEncoding(input) : "";
  const codepage = { "utf-8": 65001, "utf-16le": 1200, "utf-16be": 1201, gbk: 936 }[encoding];
  if (encoding === "utf-8" && input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    // UTF-8 BOM 会干扰 xlsx 的 codepage 65001 解析，导致首字符损坏，读前剥掉
    input = input.subarray(3);
  }
  if (codepage) options.codepage = codepage;
  return { workbook: XLSX.read(input, options), encoding };
}

function readSpreadsheetAttachment(attachment = {}, options = {}) {
  const embedded = dataUrlBuffer(attachment.dataUrl);
  if (embedded) return { buffer: embedded, source: "data-url", sourcePath: "" };

  const sourcePath = String(options.resolvePath?.(attachment) || "").trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  return {
    buffer: fs.readFileSync(sourcePath),
    source: "file",
    sourcePath
  };
}

module.exports = {
  dataUrlBuffer,
  detectCsvEncoding,
  isCsvAttachment,
  readSpreadsheetAttachment,
  readSpreadsheetWorkbook
};
