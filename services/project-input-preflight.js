"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".html", ".htm"]);

function clean(value, limit = 1200) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, limit);
}

function safeFileName(value, fallback = "input") {
  const name = path.basename(clean(value, 240)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return name || fallback;
}

function declaredPaths(attachment = {}) {
  return [...new Set([
    attachment.sourcePath,
    attachment.path,
    attachment.originalPath,
    attachment.filePath,
    attachment.cachedPath,
    attachment.cachePath,
    attachment.localPath
  ].map((value) => clean(value, 4000)).filter(Boolean))];
}

function dataUrlBuffer(value = "") {
  const match = String(value).match(/^data:[^,]*;base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? Buffer.from(match[1].replace(/\s+/g, ""), "base64") : null;
}

function requiresProjectInput(goal = "", attachments = []) {
  if (Array.isArray(attachments) && attachments.length > 0) return true;
  const text = clean(goal, 6000);
  const inputType = "(?:文件|表格|数据表|数据集|图片|图像|Excel|xlsx|xls|csv|PDF|Word|docx|PPT|pptx|压缩包)";
  const reference = "(?:上面|上述|刚才|当前|这个|这份|该|已上传|上传的|发送的|提供的|附件中的?)";
  const action = "(?:分析|读取|打开|处理|拆分|汇总|检查|识别|导入|提取|整理)";
  const referencedInput = new RegExp(`${reference}.{0,12}${inputType}|${action}.{0,12}(?:${reference}.{0,6})?${inputType}`, "i");
  const fileNameOrPath = /(?:[a-z]:[\\/]|\\\\|\.{1,2}[\\/]|[^\s<>:"|?*]+\.(?:txt|md|json|csv|xlsx?|pdf|docx?|pptx?|zip|rar|7z|png|jpe?g|webp))(?:\s|$)/i;
  return referencedInput.test(text) || fileNameOrPath.test(text);
}

function readableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: "目标不是文件" };
    fs.accessSync(file, fs.constants.R_OK);
    return { ok: true, sizeBytes: stat.size };
  } catch (error) {
    return { ok: false, reason: clean(error.message || "文件不可读取", 500) };
  }
}

function materializeAttachment(attachment = {}, inputRoot, index) {
  const name = safeFileName(attachment.name || `input-${index + 1}`);
  const id = clean(attachment.id || `input-${index + 1}`, 120).replace(/[^a-zA-Z0-9_-]/g, "_");
  const target = path.join(inputRoot, `${id}-${name}`);
  const sourceCandidates = declaredPaths(attachment);
  const checkedSources = sourceCandidates.map((source) => ({ source, check: readableFile(path.resolve(source)) }));
  const readableSource = checkedSources.find((item) => item.check.ok) || null;
  const source = readableSource?.source || sourceCandidates[0] || "";
  const sourceCheck = readableSource?.check || checkedSources[0]?.check || { ok: false, reason: "没有声明文件路径" };

  try {
    fs.mkdirSync(inputRoot, { recursive: true });
    if (sourceCheck.ok) {
      const resolvedSource = path.resolve(source);
      if (resolvedSource.toLowerCase() !== path.resolve(target).toLowerCase()) fs.copyFileSync(resolvedSource, target);
    } else {
      const embedded = dataUrlBuffer(attachment.dataUrl);
      const extension = path.extname(name).toLowerCase();
      if (embedded) fs.writeFileSync(target, embedded);
      else if (TEXT_EXTENSIONS.has(extension) && String(attachment.textContent || "").trim()) fs.writeFileSync(target, String(attachment.textContent), "utf8");
      else {
        return { ok: false, code: "PROJECT_INPUT_NOT_FOUND", name, reason: source ? sourceCheck.reason : "附件没有可读取路径或内容" };
      }
    }
    const check = readableFile(target);
    if (!check.ok) return { ok: false, code: "PROJECT_INPUT_UNREADABLE", name, reason: check.reason };
    const analysisText = clean(attachment.textContent, 120000);
    const analysisPath = analysisText ? `${target}.analysis.txt` : "";
    if (analysisPath) fs.writeFileSync(analysisPath, analysisText, "utf8");
    return {
      ok: true,
      id: clean(attachment.id || id, 240),
      name,
      path: path.resolve(target),
      sourcePath: sourceCheck.ok ? path.resolve(source) : "",
      mimeType: clean(attachment.mimeType, 160) || "application/octet-stream",
      sizeBytes: check.sizeBytes,
      analysisPath: analysisPath ? path.resolve(analysisPath) : ""
    };
  } catch (error) {
    return { ok: false, code: "PROJECT_INPUT_UNREADABLE", name, reason: clean(error.message || "文件复制失败", 500) };
  }
}

function preflightProjectInputs({ goal = "", attachments = [], workspace = "" } = {}) {
  const required = requiresProjectInput(goal, attachments);
  const workspaceValue = clean(workspace, 4000);
  const root = workspaceValue ? path.resolve(workspaceValue) : "";
  if (!required) return { ok: true, required: false, workspace: root, inputs: [], checked: [] };
  if (!root || root === path.parse(root).root) {
    return { ok: false, required: true, code: "PROJECT_INPUT_WORKSPACE_MISSING", message: "任务需要输入文件，但项目工作目录不可用。", inputs: [], checked: [] };
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {
      ok: false,
      required: true,
      code: "PROJECT_INPUT_NOT_FOUND",
      message: "任务未找到需要分析的文件。请重新上传文件或先选择文件后再执行。员工任务尚未启动。",
      inputs: [],
      checked: []
    };
  }

  const inputRoot = path.join(root, "inputs");
  const results = attachments.map((attachment, index) => materializeAttachment(attachment, inputRoot, index));
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    const names = failed.map((item) => `${item.name || "附件"}：${item.reason}`).join("；");
    return {
      ok: false,
      required: true,
      code: failed.some((item) => item.code === "PROJECT_INPUT_UNREADABLE") ? "PROJECT_INPUT_UNREADABLE" : "PROJECT_INPUT_NOT_FOUND",
      message: `任务未开始。输入文件不可用：${names}。请重新上传或修复文件后再执行。员工任务尚未启动。`,
      inputs: [],
      checked: results
    };
  }
  return {
    ok: true,
    required: true,
    workspace: root,
    inputRoot,
    inputs: results,
    checked: results.map((item) => ({ name: item.name, path: item.path, sizeBytes: item.sizeBytes }))
  };
}

function buildAssignmentContracts(assignments = [], { inputManifest = {}, task = {} } = {}) {
  const inputs = Array.isArray(inputManifest.inputs) ? inputManifest.inputs : [];
  const taskDeliveryMode = clean(task.delivery_mode || task.deliveryMode, 40);
  const acceptance = Array.isArray(task.acceptance) && task.acceptance.length
    ? task.acceptance
    : ["只基于指定输入文件执行", "返回真实数据依据", "给出可复核的结论"];
  return (Array.isArray(assignments) ? assignments : []).map((assignment, index) => {
    const deliveryMode = clean(assignment.deliveryMode, 40) === "file"
      || (taskDeliveryMode === "file" && !assignment.deliveryMode)
      ? "file"
      : "chat";
    return {
      ...assignment,
      scope: clean(assignment.scope || assignment.goal || `任务范围 ${index + 1}`, 2000),
      inputFiles: inputs.map((item) => ({
        name: item.name,
        path: item.path,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        analysisPath: clean(item.analysisPath, 4000)
      })),
      workingDirectory: clean(inputManifest.workspace, 4000),
      deliveryMode,
      expectedFileCount: deliveryMode === "file" ? Math.max(1, Number(assignment.expectedFileCount || 1)) : 0,
      deliverable: clean(assignment.deliverable || (deliveryMode === "file"
        ? "生成用户明确要求的文件，并在员工会话返回文件与结果"
        : "直接在员工会话返回完整结果，不创建文件"), 1000),
      acceptance: acceptance.map((item) => clean(item, 500)).filter(Boolean).slice(0, 12),
      maxToolCalls: 8
    };
  });
}

module.exports = {
  buildAssignmentContracts,
  preflightProjectInputs,
  requiresProjectInput
};
