"use strict";

const path = require("node:path");

const MAX_TOOLS = 96;
const MAX_RESULT_TEXT = 24000;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|password|secret|token|cookie)/i;
const CONVERSATION_READ_TOOL_IDS = Object.freeze(["knowledge_status", "knowledge_search"]);

function cleanText(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function compactSchema(schema = {}, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 5) return {};
  const compact = {};
  if (schema.type) compact.type = cleanText(schema.type, 40);
  if (schema.description) compact.description = cleanText(schema.description, 180);
  if (Array.isArray(schema.enum)) compact.enum = schema.enum.slice(0, 20);
  if (Array.isArray(schema.required)) compact.required = schema.required.slice(0, 40).map((item) => cleanText(item, 80));
  if (schema.items && typeof schema.items === "object") compact.items = compactSchema(schema.items, depth + 1);
  if (schema.properties && typeof schema.properties === "object") {
    compact.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .slice(0, 40)
        .map(([name, child]) => [cleanText(name, 80), compactSchema(child, depth + 1)])
    );
  }
  return compact;
}

function compactParameters(parameters = {}) {
  const compact = compactSchema(parameters);
  return Object.keys(compact).length ? compact : { type: "object", properties: {}, required: [] };
}

function buildHmsToolCatalog(tools = [], { isAvailable = () => true } = {}) {
  const catalog = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const id = cleanText(tool?.id, 120);
    if (!id || seen.has(id) || tool?.enabled === false || !isAvailable(tool)) continue;
    seen.add(id);
    catalog.push({
      id,
      name: cleanText(tool.name || id, 120),
      description: cleanText(tool.description, 260),
      permission: cleanText(tool.permission?.level || tool.permission || "read", 80),
      riskLevel: cleanText(tool.riskLevel || "low", 40),
      parameters: compactParameters(tool.parameters)
    });
    if (catalog.length >= MAX_TOOLS) break;
  }
  return catalog;
}

function toolsForHmsMode(tools = [], { conversationOnly = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  if (!conversationOnly) return list;
  const allowed = new Set(CONVERSATION_READ_TOOL_IDS);
  return list.filter((tool) => allowed.has(cleanText(tool?.id, 120)));
}

function buildHmsToolProtocolPrompt(catalog = []) {
  if (!catalog.length) return "";
  const hasKnowledgeTools = catalog.some((tool) => CONVERSATION_READ_TOOL_IDS.includes(tool.id));
  return [
    "[BAIQIU OPTIONAL CAPABILITY BRIDGE]",
    "Capability availability is evaluated for every request, not fixed when a conversation starts. Never tell the user to create a new conversation to obtain tools; use the capabilities present for this request or report the actual tool error.",
    "Hermes native terminal, file, browser, web, delegation, memory, and skill tools remain available.",
    "The Baiqiu-specific catalog below is separate from Hermes native tools. A short extension catalog does not prove that native browser or other Hermes capabilities are unavailable.",
    "Use baiqiu-action only when you choose one of the Baiqiu-specific capabilities listed below.",
    "Never execute the same effect through both a native Hermes tool and baiqiu-action.",
    "Use desktop_click, desktop_type, desktop_key, and desktop_scroll only for a native window, Canvas, or a page where browser tools cannot act. Inspect or focus the target first, make one physical action, then use the returned foreground and cursor evidence before continuing. Hermes owns external actions; Baiqiu only maps their result.",
    ...(hasKnowledgeTools ? [
      "[Local knowledge boundary]",
      "知识星球是白球本机知识中心，不是外部知识付费平台。询问其状态时调用 knowledge_status，需要资料时调用 knowledge_search。",
      "不得根据 skills list 推断知识星球不存在；零命中只表示没有相关笔记。不得索取 cookie、密码、Token、API Key 或登录凭据。"
    ] : []),
    "【黑球 -> 白球可选能力桥】",
    "你负责选择执行路径。原生黑球工具可直接使用；白球扩展能力可通过 baiqiu-action 调用。",
    "同一个文件、搜索或桌面动作只能选择一条路径，不得原生执行后再通过白球重复执行。",
    "选择白球能力时，每轮最多调用一个工具，并严格输出以下格式：",
    "```baiqiu-action",
    "{\"type\":\"工具ID\",\"参数名\":\"参数值\"}",
    "```",
    "收到 [White Ball tool result] 后，基于结构化证据继续或给出最终答复；失败时修正参数或如实说明。",
    "无论选择哪条执行路径，都必须依据真实产物或工具结果，不得只用文字声称完成。",
    `当前可选的白球扩展能力：${JSON.stringify(catalog)}`
  ].join("\n");
}

function actionToolId(action = {}) {
  return cleanText(action.type || action.name || action.toolId, 120);
}

function selectHmsProtocolActions(actions = [], catalog = [], maxActions = 1) {
  const allowed = new Set((Array.isArray(catalog) ? catalog : []).map((tool) => tool.id));
  const accepted = [];
  const rejected = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    const id = actionToolId(action);
    if (!id || !allowed.has(id)) {
      rejected.push({ toolId: id || "unknown", reason: "tool_not_exposed" });
      continue;
    }
    if (accepted.length >= Math.max(1, Number(maxActions) || 1)) {
      rejected.push({ toolId: id, reason: "one_action_per_round" });
      continue;
    }
    accepted.push({ ...action, type: id });
  }
  return { accepted, rejected };
}

function safeValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, MAX_RESULT_TEXT);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => safeValue(item, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? "***" : safeValue(item, depth + 1);
  }
  return output;
}

function hmsToolResultEnvelope(executed = [], rejected = [], binding = {}) {
  return {
    protocol: "baiqiu-action/1.0",
    taskId: cleanText(binding.taskId, 200),
    sessionId: cleanText(binding.sessionId, 200),
    results: (Array.isArray(executed) ? executed : []).map((item) => ({
      toolId: cleanText(item?.type || item?.response?.toolId, 120),
      success: item?.response?.success === true && !item?.response?.error,
      result: safeValue(item?.response?.result ?? null),
      error: safeValue(item?.response?.error ?? null),
      evidence: safeValue(item?.response?.evidence ?? []),
      durationMs: Number(item?.response?.duration || 0)
    })),
    rejected: safeValue(rejected)
  };
}

const FILE_PATH_KEYS = ["path", "file", "filePath", "outputPath", "savedPath", "targetPath", "outputFile"];

function toolEvidenceFiles(value, output = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => toolEvidenceFiles(item, output, seen, depth + 1));
    return output;
  }
  const filePath = FILE_PATH_KEYS
    .map((key) => value[key])
    .find((item) => typeof item === "string" && /\.[a-z0-9]{1,10}$/i.test(item.trim()));
  if (filePath) {
    const normalizedPath = filePath.trim();
    const name = cleanText(value.name || value.filename || value.fileName, 240)
      || path.win32.basename(normalizedPath)
      || path.basename(normalizedPath);
    output.push({
      name,
      label: cleanText(value.label, 240) || name,
      path: normalizedPath,
      sizeBytes: Number(value.sizeBytes || value.size || 0) || 0
    });
  }
  Object.values(value).forEach((item) => toolEvidenceFiles(item, output, seen, depth + 1));
  return output;
}

function successfulToolDelivery(envelope = {}) {
  const results = Array.isArray(envelope.results) ? envelope.results : [];
  if (!results.length) return { text: "", files: [] };
  const successful = results.filter((item) => item.success);
  const fileMap = new Map();
  successful.forEach((item) => {
    toolEvidenceFiles(item.result).forEach((file) => {
      const identity = String(file.path || file.name || "").toLowerCase();
      if (identity && !fileMap.has(identity)) fileMap.set(identity, file);
    });
  });
  const files = [...fileMap.values()];
  const evidenceLines = results.map((item) => {
    const toolId = cleanText(item.toolId, 120) || "tool";
    const status = item.success ? "成功" : "失败";
    const evidence = item.error || item.result || null;
    let detail = "";
    try { detail = cleanText(typeof evidence === "string" ? evidence : JSON.stringify(evidence), 1200); } catch {}
    detail = detail
      .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[已隐藏密钥]")
      .replace(/\b(api[_\s-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]");
    return `- ${toolId}：${status}${detail ? `；${detail}` : ""}`;
  });
  return {
    text: [
      "工具证据已返回，但黑球未完成最终结论。",
      ...evidenceLines,
      ...(files.length ? ["相关文件：", ...files.map((file) => `- ${file.path}`)] : [])
    ].join("\n"),
    files
  };
}

function successfulToolCompletionText(envelope = {}) {
  return successfulToolDelivery(envelope).text;
}

function knowledgeReferencesFromToolCalls(toolCalls = []) {
  const references = [];
  const seen = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (cleanText(call?.title || call?.toolId, 120) !== "knowledge_search") continue;
    const output = call?.rawOutput?.result || call?.result || {};
    const matches = Array.isArray(output.references) ? output.references : (Array.isArray(output.matches) ? output.matches : []);
    for (const item of matches) {
      const id = cleanText(item?.id, 240);
      const title = cleanText(item?.title, 240);
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      references.push({
        id,
        title,
        type: cleanText(item?.type, 120) || "知识笔记",
        rawType: cleanText(item?.rawType, 80) || "note",
        status: cleanText(item?.status, 120) || "使用中",
        rawStatus: cleanText(item?.rawStatus, 80) || "active",
        project: cleanText(item?.project, 240),
        score: Number(item?.score || 0),
        snippet: cleanText(item?.snippet, 1200)
      });
      if (references.length >= 8) return references;
    }
  }
  return references;
}

module.exports = {
  buildHmsToolCatalog,
  buildHmsToolProtocolPrompt,
  toolsForHmsMode,
  compactParameters,
  selectHmsProtocolActions,
  hmsToolResultEnvelope,
  successfulToolDelivery,
  successfulToolCompletionText,
  knowledgeReferencesFromToolCalls,
  CONVERSATION_READ_TOOL_IDS
};
