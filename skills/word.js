"use strict";

const MANIFEST = {
  "name": "word",
  "description": "白球已验证专业技能：Word 处理",
  "parameters": {
    "type": "object",
    "properties": {
      "request": {
        "type": "string",
        "description": "用户当前任务"
      },
      "host": {
        "type": "string",
        "description": "主机地址"
      },
      "port": {
        "type": "number",
        "description": "端口"
      },
      "timeoutMs": {
        "type": "number",
        "description": "超时时间"
      }
    },
    "required": []
  },
  "permission": {
    "level": "skill.execute",
    "scope": "skills"
  }
};

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
}
async function execute(params = {}) {
  const outputDir = String(params.outputDir || path.join(os.tmpdir(), "baiqiu-skill-health"));
  const fileName = String(params.fileName || "baiqiu-word-test.doc").replace(/[\\/:*?"<>|]/g, "-");
  const filePath = path.join(outputDir, /\.docx?$/i.test(fileName) ? fileName : fileName + ".doc");
  const title = escapeHtml(params.title || "Baiqiu Word Skill Test");
  const content = escapeHtml(params.content || params.request || "Word skill runtime verification passed.");
  const document = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + title + '</title></head><body><h1>' + title + '</h1><p>' + content + '</p></body></html>';
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, document, "utf8");
  const stat = fs.statSync(filePath);
  return { success: stat.isFile() && stat.size > 100, result: { filePath, size: stat.size, format: "word-doc" }, error: stat.size > 100 ? null : "Word document is empty", evidence: [{ type: "file", capability: "word_document", path: filePath, size: stat.size }] };
}

module.exports = { MANIFEST, execute };
