"use strict";

const SOURCE_PREFIX = "intent-confirmation/";
const DATA_MARKER = "baiqiu-intent-confirmation:v1:";

function clean(value, limit = 12000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function sourcePart(value) {
  return clean(value, 240).replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function intentDecisionSource(sessionId, requestId) {
  return `${SOURCE_PREFIX}${sourcePart(sessionId)}/${sourcePart(requestId)}`;
}

function confirmedDirectionFromState(state = {}) {
  const values = state.confirmedDimensions && typeof state.confirmedDimensions === "object"
    ? state.confirmedDimensions
    : {};
  const labels = state.dimensionLabels && typeof state.dimensionLabels === "object"
    ? state.dimensionLabels
    : {};
  const order = Array.isArray(state.confirmedOrder) ? state.confirmedOrder : Object.keys(values);
  const lines = [];
  for (const dimension of [...new Set(order)]) {
    if (dimension === "manual_adjustment") continue;
    const value = clean(values[dimension], 800);
    if (value) lines.push(`- ${clean(labels[dimension], 120) || dimension}: ${value}`);
  }
  const manual = clean(values.manual_adjustment, 1200);
  if (manual) lines.push(`- \u7528\u6237\u8865\u5145: ${manual}`);
  if (!lines.length && clean(state.workingGoal, 1200)) lines.push(`- \u5df2\u786e\u8ba4\u76ee\u6807: ${clean(state.workingGoal, 1200)}`);
  return lines.join("\n");
}

function encodeMemory(memory) {
  return Buffer.from(JSON.stringify(memory), "utf8").toString("base64");
}

function parseIntentDecisionBody(body = "") {
  const match = String(body || "").match(new RegExp(`<!--\\s*${DATA_MARKER.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}([A-Za-z0-9+/=]+)\\s*-->`));
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (parsed?.version !== 1 || !clean(parsed.originalRequest) || !clean(parsed.confirmedDirection)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildIntentDecisionNote({ sessionId = "", requestId = "", project = "", state = {}, executionText = "", now = new Date() } = {}) {
  const originalRequest = clean(state.originalRequest, 4000);
  const confirmedDirection = confirmedDirectionFromState(state);
  const finalExecutionText = clean(executionText, 12000);
  if (!originalRequest || !confirmedDirection || !finalExecutionText) return null;
  const source = intentDecisionSource(sessionId, requestId || state.requestId);
  const memory = {
    version: 1,
    originalRequest,
    confirmedDirection,
    executionText: finalExecutionText,
    project: clean(project, 120),
    sessionId: clean(sessionId, 240),
    requestId: clean(requestId || state.requestId, 240),
    createdAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  };
  const titleRequest = originalRequest.replace(/\s+/g, " ").slice(0, 48);
  return {
    source,
    memory,
    payload: {
      title: `\u610f\u56fe\u786e\u8ba4: ${titleRequest}`,
      category: project ? "projects" : "inbox",
      type: "decision",
      status: "confirmed",
      project: clean(project, 120),
      source,
      tags: ["\u610f\u56fe\u786e\u8ba4", "\u81ea\u52a8\u590d\u7528", clean(project, 120)].filter(Boolean),
      body: [
        `# \u610f\u56fe\u786e\u8ba4: ${titleRequest}`,
        "",
        `<!-- ${DATA_MARKER}${encodeMemory(memory)} -->`,
        "",
        "## \u539f\u59cb\u8bf7\u6c42",
        "",
        originalRequest,
        "",
        "## \u5df2\u786e\u8ba4\u65b9\u5411",
        "",
        confirmedDirection,
        "",
        "## \u6700\u7ec8\u6267\u884c\u8bf7\u6c42",
        "",
        finalExecutionText
      ].join("\n")
    }
  };
}

function canonicalIntentText(value) {
  return clean(value, 4000)
    .toLowerCase()
    .replace(/^(?:please\s+|\u8bf7\u4f60?|\u9ebb\u70e6\u4f60?|\u5e2e\u6211|\u7ed9\u6211|\u6211\u60f3|\u6211\u8981)+/i, "")
    .replace(/(?:\u4e00\u4e0b|\u5427|\u5462|\u554a|\u5440|\u53ef\u4ee5\u5417|\u597d\u5417)+$/i, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function editDistance(left, right) {
  const a = [...left];
  const b = [...right];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length];
}

function intentSimilarity(left, right) {
  const a = canonicalIntentText(left);
  const b = canonicalIntentText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(0, 1 - (editDistance(a, b) / Math.max(a.length, b.length)));
}

function sameProject(candidateProject, currentProject) {
  return clean(candidateProject, 120).toLowerCase() === clean(currentProject, 120).toLowerCase();
}

function selectReusableIntentDecision({ query = "", project = "", searchResults = [], readBody = null, threshold = 0.78 } = {}) {
  const matches = [];
  for (const note of Array.isArray(searchResults) ? searchResults : []) {
    if (!String(note?.source || "").startsWith(SOURCE_PREFIX)) continue;
    if (String(note?.type || "").toLowerCase() !== "decision") continue;
    if (String(note?.status || "").toLowerCase() !== "confirmed") continue;
    if (!sameProject(note?.project, project)) continue;
    let body = note?.body || "";
    if (!body && typeof readBody === "function") {
      const read = readBody(note);
      body = typeof read === "string" ? read : read?.body || "";
    }
    const memory = parseIntentDecisionBody(body);
    if (!memory || !sameProject(memory.project, project)) continue;
    const similarity = intentSimilarity(query, memory.originalRequest);
    if (similarity < threshold) continue;
    matches.push({ note, memory, similarity });
  }
  matches.sort((left, right) => right.similarity - left.similarity || String(right.note.updatedAt || "").localeCompare(String(left.note.updatedAt || "")));
  return matches[0] || null;
}

function executionTextForIntentDecision(currentRequest, memory = {}) {
  const request = clean(currentRequest, 4000);
  const direction = clean(memory.confirmedDirection, 4000);
  if (!request || !direction) return "";
  return `${request}\n\n\u5386\u53f2\u5df2\u786e\u8ba4\u65b9\u5411\uff08\u4ec5\u7528\u4e8e\u7406\u89e3\u5f53\u524d\u8bf7\u6c42\uff09:\n${direction}\n\n\u6309\u8be5\u65b9\u5411\u7ee7\u7eed\u6267\u884c\uff0c\u4e0d\u91cd\u590d\u8fdb\u884c\u610f\u56fe\u786e\u8ba4\u3002`;
}

function applyIntentDecisionReuse({ understanding = {}, executionText = "", memory = {}, permissions = null } = {}) {
  if (!understanding || !executionText) return null;
  const existingMode = String(understanding.responseMode || "");
  const canUseExistingRoute = ["execute", "delegate"].includes(existingMode) && understanding.shouldCreateTask === true;
  const mayPromoteWorker = existingMode === "clarify"
    && String(understanding.intentType || "") === "execution"
    && Number(understanding.workers || 0) === 0
    && permissions?.allowTaskCreation === true;
  if (!canUseExistingRoute && !mayPromoteWorker) return null;
  const responseMode = canUseExistingRoute ? existingMode : "execute";
  const classification = canUseExistingRoute ? understanding.classification : "development_task";
  const routing = responseMode === "delegate" ? "ceo" : "task_brain";
  return Object.freeze({
    ...understanding,
    classification,
    decisionType: classification,
    requestType: classification,
    responseMode,
    response_mode: responseMode,
    routing,
    route: routing,
    role: responseMode === "delegate" ? "CEO" : "WORKER",
    permissions: permissions || understanding.permissions,
    execute: true,
    need_execution: true,
    shouldCreateTask: true,
    context: Object.freeze({
      ...(understanding.context || {}),
      normalizedInput: executionText,
      intentDecisionReuse: Object.freeze({
        source: clean(memory.source || "", 500),
        originalRequest: clean(memory.originalRequest, 4000)
      })
    })
  });
}

module.exports = {
  SOURCE_PREFIX,
  intentDecisionSource,
  confirmedDirectionFromState,
  buildIntentDecisionNote,
  parseIntentDecisionBody,
  intentSimilarity,
  selectReusableIntentDecision,
  executionTextForIntentDecision,
  applyIntentDecisionReuse
};
