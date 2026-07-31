const fs = require("node:fs");

function dataUrlBuffer(dataUrl = "") {
  const match = String(dataUrl).match(/^data:[^,]*;base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? Buffer.from(match[1].replace(/\s+/g, ""), "base64") : null;
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
  readSpreadsheetAttachment
};
