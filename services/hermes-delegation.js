const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveHermesHome(options = {}) {
  return path.resolve(
    options.hermesHome
      || process.env.HERMES_HOME
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes")
  );
}

function searchableToolText(tool = {}) {
  const selected = {
    kind: tool.kind,
    title: tool.title,
    name: tool.name,
    toolName: tool.toolName,
    rawInput: tool.rawInput,
    rawOutput: tool.rawOutput,
    content: tool.content
  };
  try {
    return JSON.stringify(selected).toLowerCase();
  } catch {
    return `${tool.kind || ""} ${tool.title || ""} ${tool.name || ""}`.toLowerCase();
  }
}

function isHermesDelegationTool(tool = {}) {
  return /delegate[_ -]?task|delegate batch|delegation_id/.test(searchableToolText(tool));
}

function hermesDelegationEvidence(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .filter(isHermesDelegationTool)
    .map((tool, index) => ({
      id: String(tool.toolCallId || tool.id || `delegate-${index + 1}`),
      delegationIds: extractDelegationIds([tool]),
      title: String(tool.title || tool.name || "delegate_task"),
      status: String(tool.status || tool.state || "completed"),
      kind: String(tool.kind || "tool"),
      locations: Array.isArray(tool.locations) ? tool.locations : [],
      content: Array.isArray(tool.content) ? tool.content : []
    }));
}

function extractDelegationIds(toolCalls = []) {
  const ids = new Set();
  for (const tool of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!isHermesDelegationTool(tool)) continue;
    let serialized = "";
    try { serialized = JSON.stringify(tool); } catch { serialized = searchableToolText(tool); }
    for (const id of serialized.match(/deleg_[a-z0-9]+/gi) || []) ids.add(id);
  }
  return [...ids];
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function completionFromRow(row, delegationId) {
  if (!row) return { delegationId, status: "missing", results: [], error: "Hermes 没有找到该委派批次的持久化记录。" };
  const event = parseJson(row.event_json) || parseJson(row.result_json) || {};
  const task = parseJson(row.task_json) || {};
  const state = String(row.state || event.status || "unknown").toLowerCase();
  const results = Array.isArray(event.results) ? event.results : [];
  return {
    delegationId,
    status: state === "completed" ? "completed" : state === "error" ? "failed" : state,
    results,
    event,
    task,
    completedAt: row.completed_at || event.completed_at || null,
    error: row.error || event.error || ""
  };
}

function readHermesDelegationCompletion(delegationId, options = {}) {
  const id = String(delegationId || "").trim();
  if (!id) return { delegationId: "", status: "missing", results: [], error: "委派 ID 为空。" };
  const dbPath = options.dbPath || path.join(resolveHermesHome(options), "state.db");
  if (!fs.existsSync(dbPath)) return { delegationId: id, status: "missing", results: [], error: `Hermes 状态库不存在：${dbPath}` };
  let db;
  try {
    const Database = options.Database || require("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = new Set(db.prepare("PRAGMA table_info(async_delegations)").all().map((item) => item.name));
    const selected = [
      "delegation_id", "origin_session", "origin_ui_session_id", "origin_session_id",
      "parent_session_id", "state", "dispatched_at", "completed_at", "event_json",
      "result_json", "task_json", "delivery_state", "error"
    ]
      .filter((column) => columns.has(column));
    if (!selected.includes("delegation_id")) {
      return { delegationId: id, status: "unavailable", results: [], error: "Hermes 状态库缺少 async_delegations.delegation_id。" };
    }
    const row = db.prepare(`SELECT ${selected.join(", ")} FROM async_delegations WHERE delegation_id = ?`).get(id);
    return completionFromRow(row, id);
  } catch (error) {
    return { delegationId: id, status: "unavailable", results: [], error: `读取 Hermes 委派记录失败：${error.message}` };
  } finally {
    try { db?.close?.(); } catch {}
  }
}

function findHermesDelegationIdsByAssignments({ parentSessionId = "", assignmentIds = [] } = {}, options = {}) {
  const parentId = String(parentSessionId || "").trim();
  const markers = [...new Set((Array.isArray(assignmentIds) ? assignmentIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .map((id) => `[BAIQIU_ASSIGNMENT_ID=${id}]`))];
  if (!parentId || !markers.length) return [];
  const dbPath = options.dbPath || path.join(resolveHermesHome(options), "state.db");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    const Database = options.Database || require("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare([
      "SELECT delegation_id, event_json, task_json",
      "FROM async_delegations",
      "WHERE parent_session_id = ?",
      "ORDER BY dispatched_at DESC LIMIT 100"
    ].join(" ")).all(parentId);
    return rows
      .filter((row) => {
        const payload = `${row.event_json || ""}\n${row.task_json || ""}`;
        return markers.every((marker) => payload.includes(marker));
      })
      .map((row) => String(row.delegation_id || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    try { db?.close?.(); } catch {}
  }
}

async function waitForHermesDelegationDiscovery(query = {}, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0));
  const intervalMs = Math.max(50, Number(options.intervalMs || 250));
  const startedAt = Date.now();
  do {
    if (options.signal?.aborted) return [];
    const ids = findHermesDelegationIdsByAssignments(query, options);
    if (ids.length) return ids;
    if (timeoutMs && Date.now() - startedAt >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
  return [];
}

function delegationResultText(result = {}) {
  const candidates = [result.summary, result.text, result.message, result.result?.text, result.result?.summary];
  return candidates.find((item) => typeof item === "string" && item.trim())?.trim() || "";
}

function normalizeDelegationResults(completions = []) {
  return completions.flatMap((completion) => (completion.results || []).map((result, index) => ({
    delegationId: completion.delegationId,
    taskIndex: Number.isInteger(result.task_index) ? result.task_index : index,
    status: String(result.status || "unknown"),
    summary: delegationResultText(result),
    model: result.model || "",
    apiCalls: Number(result.api_calls || 0),
    tokens: result.tokens || null,
    durationSeconds: result.duration_seconds ?? null,
    exitReason: result.exit_reason || "",
    liveTranscript: result.live_transcript || "",
    error: result.error || ""
  })));
}

function reconcileDelegationResults(completions = [], results = []) {
  const expected = completions.reduce((sum, completion) => Math.max(
    sum,
    Number(completion.event?.goals?.length || 0),
    Number(completion.event?.results?.length || 0)
  ), 0);
  if (!expected) return results;
  const byIndex = new Map(results.map((item) => [Number(item.taskIndex), item]));
  return Array.from({ length: expected }, (_, taskIndex) => byIndex.get(taskIndex) || ({
    taskIndex,
    status: "failed",
    summary: "",
    model: "",
    apiCalls: 0,
    tokens: null,
    durationSeconds: null,
    exitReason: "missing_result",
    liveTranscript: "",
    error: "内部执行单元未返回正文，委派批次已结束。"
  }));
}

function formatDelegationResults(results = []) {
  return results.map((result, index) => [
    `【内部执行单元 ${index + 1}｜${result.status === "completed" ? "已完成" : result.status}】`,
    result.summary || result.error || "该子任务没有返回可显示正文。"
  ].join("\n")).join("\n\n");
}

async function waitForHermesDelegationCompletion(delegationIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(delegationIds) ? delegationIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { status: "missing", completions: [], results: [], error: "没有真实 delegation_id。" };
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0));
  const missingGraceMs = Math.max(0, Number(options.missingGraceMs ?? 5000));
  const intervalMs = Math.max(50, Number(options.intervalMs || 250));
  const startedAt = Date.now();
  while (!timeoutMs || Date.now() - startedAt <= timeoutMs) {
    if (options.signal?.aborted) return { status: "cancelled", completions: [], results: [], error: "委派等待已取消。" };
    const completions = ids.map((id) => readHermesDelegationCompletion(id, options));
    const results = reconcileDelegationResults(completions, normalizeDelegationResults(completions));
    if (completions.every((item) => item.status === "completed")) {
      const expected = completions.reduce((sum, item) => sum + Number(item.event?.goals?.length || item.event?.results?.length || 0), 0);
      const completed = results.filter((item) => item.status === "completed" && item.summary).length;
      if (expected === 0 || completed >= expected) return { status: "completed", completions, results, text: formatDelegationResults(results) };
      return { status: "partial", completions, results, text: formatDelegationResults(results), error: `Hermes 委派批次完成，但只有 ${completed}/${expected} 个子任务返回正文。` };
    }
    const missing = completions.some((item) => item.status === "missing");
    if (missing && Date.now() - startedAt < (timeoutMs ? Math.min(timeoutMs, missingGraceMs) : missingGraceMs)) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (completions.some((item) => ["failed", "missing", "unavailable"].includes(item.status))) {
      const completed = results.filter((item) => item.status === "completed" && item.summary).length;
      if (completed > 0) return { status: "partial", completions, results, text: formatDelegationResults(results), error: completions.find((item) => item.error)?.error || "Hermes 委派批次部分完成。" };
      return { status: "failed", completions, results, error: completions.find((item) => item.error)?.error || "Hermes 委派批次未完成。" };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const completions = ids.map((id) => readHermesDelegationCompletion(id, options));
  const results = reconcileDelegationResults(completions, normalizeDelegationResults(completions));
  const completed = results.filter((item) => item.status === "completed" && item.summary).length;
  if (completed > 0) return { status: "partial", completions, results, text: formatDelegationResults(results), error: `等待 Hermes 委派结果超过 ${Math.round(timeoutMs / 1000)} 秒，已保留 ${completed} 个真实结果。` };
  return { status: "timeout", completions, results, error: `等待 Hermes 委派结果超过 ${Math.round(timeoutMs / 1000)} 秒。` };
}

module.exports = {
  extractDelegationIds,
  findHermesDelegationIdsByAssignments,
  formatDelegationResults,
  hermesDelegationEvidence,
  isHermesDelegationTool,
  reconcileDelegationResults,
  normalizeDelegationResults,
  readHermesDelegationCompletion,
  searchableToolText,
  waitForHermesDelegationDiscovery,
  waitForHermesDelegationCompletion
};
