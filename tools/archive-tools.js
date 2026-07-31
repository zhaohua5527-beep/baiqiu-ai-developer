"use strict";

function createTools() {
  return [
    {
      id: "archive_create",
      name: "创建压缩包",
      description: "将允许范围内的本地文件夹压缩为 ZIP，并校验压缩包真实存在。",
      category: "file",
      parameters: {
        type: "object",
        required: ["sourceDir", "outputPath"],
        properties: { sourceDir: { type: "string" }, outputPath: { type: "string" } }
      },
      permission: { level: "filesystem.write", scope: "app.desktop.saveLocation" },
      async execute(params, context) {
        const result = await context.runtime.executeArchiveCreate(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "archive", tool: "archive_create", ...(result?.evidence || {}) }] };
      }
    },
    {
      id: "archive_extract",
      name: "解压压缩包",
      description: "将 ZIP 解压到允许范围内的目录，拒绝路径穿越并校验输出文件。",
      category: "file",
      parameters: {
        type: "object",
        required: ["archivePath", "outputDir"],
        properties: { archivePath: { type: "string" }, outputDir: { type: "string" } }
      },
      permission: { level: "filesystem.write", scope: "app.desktop.saveLocation" },
      async execute(params, context) {
        const result = await context.runtime.executeArchiveExtract(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "archive", tool: "archive_extract", ...(result?.evidence || {}) }] };
      }
    }
  ];
}

module.exports = { createTools };
