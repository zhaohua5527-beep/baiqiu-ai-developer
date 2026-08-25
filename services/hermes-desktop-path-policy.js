"use strict";

const path = require("node:path");

const INTERMEDIATE_EXTENSION_PATTERN = /\.(?:py|pyc|pyo|ps1|bat|cmd|tmp|temp|log|ndjson|cache)(?:["'\s,;)}\]]|$)/i;
const WRITE_TOOL_PATTERN = /(?:write|create|edit|save|export|generate|render|download|copy|move|patch|写入|创建|编辑|保存|导出|生成|下载|复制|移动)/i;
const WRITE_COMMAND_PATTERN = /(?:^|[\s|;&"':])(?:set-content|add-content|out-file|new-item|copy-item|move-item|tee|touch|cp|mv)\b|(?:^|[^>])>{1,2}(?!=)|\b(?:write_text|write_bytes|writefile|writealltext)\s*\(|\bopen\s*\([^\r\n]{0,500},\s*[rubf]*["'](?:w|a|x)/i;

function normalized(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

function toolCallText(params = {}) {
  const tool = params.toolCall || {};
  let rawInput = "";
  try { rawInput = JSON.stringify(tool.rawInput || {}); } catch { rawInput = String(tool.rawInput || ""); }
  return `${tool.kind || ""}\n${tool.name || ""}\n${tool.title || ""}\n${rawInput}`;
}

function desktopReferences(desktopRoot = "") {
  const candidates = [
    desktopRoot,
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop"),
    process.env.ONEDRIVE && path.join(process.env.ONEDRIVE, "Desktop")
  ].filter(Boolean).map(normalized);
  return [...new Set(candidates)];
}

function referencesDesktop(value = "", desktopRoot = "") {
  const text = normalized(value);
  if (/(?:^|[\s"'=:,(])desktop[\\/]/i.test(String(value || "")) || text.includes("桌面")) return true;
  return desktopReferences(desktopRoot).some((candidate) => text.includes(candidate));
}

function isWriteOperation(params = {}) {
  const tool = params.toolCall || {};
  const descriptor = `${tool.kind || ""} ${tool.name || ""} ${tool.title || ""}`;
  if (WRITE_TOOL_PATTERN.test(descriptor)) return true;
  let rawInput = "";
  try { rawInput = JSON.stringify(tool.rawInput || {}); } catch { rawInput = String(tool.rawInput || ""); }
  return WRITE_COMMAND_PATTERN.test(rawInput);
}

function userRequestedDesktopDelivery(message = "") {
  const text = String(message || "");
  return /(?:保存|放到|放在|写到|写入|导出|下载|生成|创建|输出).{0,24}桌面|桌面.{0,24}(?:保存|放|写|导出|下载|生成|创建|输出)/i.test(text);
}

function userRequestedDesktopCodeDelivery(message = "") {
  return userRequestedDesktopDelivery(message)
    && /(?:\.py\b|python\s*脚本|powershell\s*脚本|批处理|命令脚本|代码文件|源代码文件)/i.test(String(message || ""));
}

function evaluateHermesDesktopWrite(params = {}, context = {}) {
  const text = toolCallText(params);
  if (!referencesDesktop(text, context.desktopRoot) || !isWriteOperation(params)) {
    return { blocked: false, reason: "not_desktop_write" };
  }
  if (!context.allowDesktopDelivery) {
    return { blocked: true, reason: "desktop_not_requested" };
  }
  if (INTERMEDIATE_EXTENSION_PATTERN.test(text) && !context.allowDesktopCodeDelivery) {
    return { blocked: true, reason: "desktop_intermediate_file" };
  }
  return { blocked: false, reason: "explicit_desktop_delivery" };
}

module.exports = {
  evaluateHermesDesktopWrite,
  isWriteOperation,
  referencesDesktop,
  toolCallText,
  userRequestedDesktopCodeDelivery,
  userRequestedDesktopDelivery
};
