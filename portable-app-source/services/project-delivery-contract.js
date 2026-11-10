"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PRODUCT_EXTENSION = /\.(?:txt|md|json|csv|html?|xlsx?|pdf|docx?|pptx?|png|jpe?g|webp|zip)$/i;
const OUTPUT_ACTION = /(?:生成|创建|制作|保存|导出|写入|产出|交付)/i;
const CEO_REFERENCE = /(?:\bCEO\b|项目负责人|负责人)/i;

function clean(value, limit = 12000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, limit);
}

function absoluteWindowsPaths(text = "") {
  const matches = clean(text).match(/[a-z]:\\[^\s，。；;、,|`"'<>()（）]+/gi) || [];
  return [...new Set(matches
    .map((item) => item.replace(/[，。；;、)）}\]]+$/g, ""))
    .filter((item) => PRODUCT_EXTENSION.test(item)))];
}

function clauses(text = "") {
  return String(text || "").match(/[^。；;\n]+[。；;\n]?/g) || [];
}

function declaredOutputPaths(text = "") {
  return [...new Set(clauses(text)
    .filter((item) => OUTPUT_ACTION.test(item))
    .flatMap((item) => absoluteWindowsPaths(item)))];
}

function ceoOutputPaths(text = "") {
  return [...new Set(clauses(text)
    .filter((item) => CEO_REFERENCE.test(item) && OUTPUT_ACTION.test(item))
    .flatMap((item) => absoluteWindowsPaths(item)))];
}

function snapshotFiles(files = []) {
  return new Map(files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return [path.win32.resolve(file).toLowerCase(), { exists: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [path.win32.resolve(file).toLowerCase(), { exists: false, size: 0, mtimeMs: 0 }];
    }
  }));
}

function verifyChangedFiles(files = [], before = new Map()) {
  const verified = [];
  const missing = [];
  const unchanged = [];
  for (const file of files) {
    const key = path.win32.resolve(file).toLowerCase();
    const previous = before.get(key) || { exists: false, size: 0, mtimeMs: 0 };
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        missing.push(file);
        continue;
      }
      if (previous.exists && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) unchanged.push(file);
      verified.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      missing.push(file);
    }
  }
  return { ok: missing.length === 0 && unchanged.length === 0, verified, missing, unchanged };
}

function buildCeoDeliveryPrompt({ goal = "", files = [], workerResults = [] } = {}) {
  const workerEvidence = (Array.isArray(workerResults) ? workerResults : []).map((item, index) => ({
    worker: clean(item.roleName || item.role || `Worker ${index + 1}`, 200),
    status: clean(item.status, 80),
    summary: clean(item.summary, 4000),
    warnings: Array.isArray(item.warnings) ? item.warnings.map((warning) => clean(warning, 500)).filter(Boolean) : []
  }));
  return [
    "你负责黑球项目的最终交付，两个内部执行单元的任务已经由黑球真实执行并完成。",
    "现在只完成原始任务中明确属于黑球最终交付的部分，不得重做或伪造内部执行单元产物。",
    `原始任务：${clean(goal)}`,
    `员工真实结果：${JSON.stringify(workerEvidence)}`,
    `黑球必须生成并核验这些文件：${JSON.stringify(files)}`,
    "必须使用当前已有工具或运行时能力真实写入上述精确路径，不得改名、改扩展名或只在正文声称完成。",
    "禁止安装或下载任何依赖。完成后逐一返回绝对路径和核验结果。"
  ].join("\n\n");
}

async function completeCeoFileDelivery({ goal = "", workerResults = [], execute } = {}) {
  const files = ceoOutputPaths(goal);
  if (!files.length) return { required: false, files: [], verified: [], text: "", toolCalls: [] };
  if (typeof execute !== "function") throw new Error("黑球最终交付需要黑球执行器。");
  const before = snapshotFiles(files);
  const result = await execute(buildCeoDeliveryPrompt({ goal, files, workerResults }));
  const status = clean(result?.status, 80).toLowerCase();
  const check = verifyChangedFiles(files, before);
  if (["failed", "cancelled"].includes(status) || !check.ok) {
    const reasons = [
      result?.text,
      check.missing.length ? `未生成：${check.missing.join("、")}` : "",
      check.unchanged.length ? `未更新：${check.unchanged.join("、")}` : ""
    ].map((item) => clean(item, 2000)).filter(Boolean);
    const error = new Error(`黑球最终交付未完成。${reasons.join("；")}`);
    error.code = "PROJECT_CEO_DELIVERY_INCOMPLETE";
    error.ceoDelivery = { files, result, check };
    throw error;
  }
  return {
    required: true,
    files,
    verified: check.verified,
    text: clean(result?.text, 12000),
    toolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls : [],
    hermesSessionId: clean(result?.hermesSessionId, 240)
  };
}

module.exports = {
  absoluteWindowsPaths,
  buildCeoDeliveryPrompt,
  ceoOutputPaths,
  completeCeoFileDelivery,
  declaredOutputPaths,
  verifyChangedFiles
};
