"use strict";

function documentTool(id, name, description, parameters, permission, run) {
  return {
    id,
    name,
    description,
    category: "file",
    supportedIntent: ["office.doc", "file.create"],
    parameters,
    permission,
    async execute(params, context) {
      const result = await run(params || {}, context.runtime);
      return {
        success: result?.success === true,
        result,
        error: result?.success === true ? null : result?.error,
        evidence: [{ type: "document", tool: id, ...(result?.evidence || {}) }]
      };
    }
  };
}

function createTools() {
  const readParams = { type: "object", required: ["path"], properties: { path: { type: "string" }, maxChars: { type: "integer", minimum: 100, maximum: 200000 } } };
  const writeParams = { type: "object", required: ["path", "text"], properties: { path: { type: "string" }, title: { type: "string" }, text: { type: "string" } } };
  return [
    documentTool("word_read", "读取 Word", "读取允许范围内 DOCX 文件的真实文字内容。", readParams, { level: "filesystem.read", scope: "documents" }, (params, runtime) => runtime.executeWordRead(params)),
    documentTool("word_write", "生成 Word", "生成真实 DOCX 文件并重新读取验证内容。", writeParams, { level: "filesystem.write", scope: "documents" }, (params, runtime) => runtime.executeWordWrite(params)),
    documentTool("pdf_read", "读取 PDF", "读取允许范围内 PDF 文件的文字、页数和元数据。", readParams, { level: "filesystem.read", scope: "documents" }, (params, runtime) => runtime.executePdfRead(params)),
    documentTool("pdf_write", "生成 PDF", "生成真实 PDF 文件并重新解析验证页数和文字。", writeParams, { level: "filesystem.write", scope: "documents" }, (params, runtime) => runtime.executePdfWrite(params))
  ];
}

module.exports = { createTools };
