"use strict";

const CONTINUATION_REQUEST = /^(?:继续|执行|继续执行|接着执行|恢复任务|恢复执行|继续刚才的任务|继续刚才的操作|重新继续)(?:\s*[，,：:]\s*.+)?$/i;
const SUMMARY_HEADER = /^请核对需求摘要后决定是否执行[。.!！]?/;
const INCOMPLETE_RESUME_STATUSES = new Set([
  "failed",
  "cancelled",
  "aborted",
  "timeout",
  "blocked",
  "pending_confirmation"
]);

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isContinuationRequest(text = "") {
  return CONTINUATION_REQUEST.test(String(text || "").trim());
}

function continuationInstruction(text = "") {
  const value = String(text || "").trim();
  const match = value.match(/^(?:继续|执行|继续执行|接着执行|恢复任务|恢复执行|继续刚才的任务|继续刚才的操作|重新继续)(?:\s*[，,：:]\s*(.+))?$/i);
  return String(match?.[1] || "").trim();
}

function isInternalRuntimeFailure(error = "") {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || error || "").trim();
  return code === "HERMES_PROMPT_FAILED"
    || code === "HERMES_SESSION_BUSY"
    || /^(?:Internal error|Queued for the next turn\b)/i.test(message)
    || /Hermes.*(?:session|ACP).*(?:failed|error|cancel|busy)/i.test(message);
}

function isInterruptedCheckpoint(checkpoint = null) {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  if (checkpoint.kind === "clarification") {
    return Boolean(checkpoint.state && typeof checkpoint.state === "object");
  }
  if (!["execution", "task", "summary"].includes(checkpoint.kind)) return false;
  return Boolean(String(checkpoint.input || "").trim());
}

function resumeResultCompleted(result = null) {
  if (!result || typeof result !== "object" || result.success === false) return false;
  if (result.clarification || result.confirmationRequired) return false;
  return !INCOMPLETE_RESUME_STATUSES.has(String(result.status || "").trim().toLowerCase());
}

function isSuccessfulAssistant(message = {}) {
  if (message.role !== "assistant") return false;
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const result = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : raw;
  if (result.success === true || result.status === "completed" || result.status === "success") {
    return !/执行失败|Internal error|Queued for the next turn/i.test(String(message.text || ""));
  }
  return false;
}

function isFailedAssistant(message = {}) {
  if (message.role !== "assistant") return false;
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const result = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : raw;
  return result.success === false
    || result.status === "failed"
    || /执行失败|Internal error|Queued for the next turn/i.test(String(message.text || ""));
}

function latestRecoverableSummary(messages = [], sessionStatus = "") {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "assistant" || !SUMMARY_HEADER.test(String(message.text || "").trim())) continue;
    const later = list.slice(index + 1).filter((item) => item?.role === "assistant");
    if (later.some(isSuccessfulAssistant)) continue;
    if (later.some(isFailedAssistant) || ["aborted", "failed", "FAILED"].includes(String(sessionStatus || ""))) {
      return String(message.text || "").trim();
    }
  }
  return "";
}

function summaryExecutionText(summary = "") {
  const text = String(summary || "").trim();
  if (!text) return "";
  return [
    "请按以下已经确认的需求直接执行，不要重新进入意图确认：",
    text
  ].join("\n\n");
}

function createInterruptedCheckpoint({ session = {}, activeRun = null, pendingTask = null, task = null, hermesSessionId = "", messages = [] } = {}) {
  const sessionId = String(session?.id || session?.sessionId || activeRun?.sessionId || pendingTask?.session_id || "").trim();
  const traceId = String(activeRun?.traceId || pendingTask?.trace_id || "").trim();
  const taskSnapshot = task || pendingTask || null;
  const taskState = taskSnapshot && typeof taskSnapshot === "object"
    ? {
        taskId: String(taskSnapshot.task_id || "").trim(),
        status: String(taskSnapshot.status || "").trim(),
        currentStage: String(taskSnapshot.current_stage || "").trim(),
        currentStep: String(taskSnapshot.current_step || "").trim(),
        completed: clone(taskSnapshot.completed || []),
        pending: clone(taskSnapshot.pending || []),
        plan: clone(taskSnapshot.plan || []),
        acceptance: clone(taskSnapshot.acceptance || []),
        constraints: clone(taskSnapshot.constraints || []),
        requiresConfirmation: Boolean(taskSnapshot.requires_confirmation),
        riskLevel: String(taskSnapshot.risk_level || "").trim()
      }
    : null;
  const runtimeIdentity = String(hermesSessionId || session?.hermesSessionId || "").trim();
  const resumeMetadata = {
    ...(runtimeIdentity ? { hermesSessionId: runtimeIdentity } : {}),
    ...(taskState?.taskId ? { taskState } : {})
  };
  const identity = {
    ...(sessionId ? { sessionId } : {}),
    ...(traceId ? { traceId } : {})
  };
  const clarificationState = session.clarificationState && typeof session.clarificationState === "object"
    ? clone(session.clarificationState)
    : null;
  if (clarificationState) {
    return {
      version: 2,
      kind: "clarification",
      state: clarificationState,
      input: String(clarificationState.originalRequest || "").trim(),
      ...identity,
      ...resumeMetadata,
      createdAt: new Date().toISOString()
    };
  }
  const activeInput = String(activeRun?.payloadText || "").trim();
  if (activeInput) {
    return {
      version: 2,
      kind: "execution",
      input: activeInput,
      taskId: String(activeRun?.taskId || "").trim(),
      ...identity,
      ...resumeMetadata,
      attachments: clone(activeRun?.payloadAttachments || []),
      createdAt: new Date().toISOString()
    };
  }
  const taskInput = String(pendingTask?.original_input || pendingTask?.originalInput || "").trim();
  if (taskInput) {
    return {
      version: 2,
      kind: "task",
      input: taskInput,
      taskId: String(pendingTask.task_id || "").trim(),
      ...identity,
      ...resumeMetadata,
      attachments: clone(pendingTask.attachments || []),
      createdAt: new Date().toISOString()
    };
  }
  const summary = latestRecoverableSummary(messages, session.status);
  if (summary) {
    return {
      version: 2,
      kind: "summary",
      input: summaryExecutionText(summary),
      summary,
      ...identity,
      ...resumeMetadata,
      createdAt: new Date().toISOString()
    };
  }
  return null;
}

function checkpointMatchesSession(checkpoint = null, { sessionId = "" } = {}) {
  if (!isInterruptedCheckpoint(checkpoint)) return false;
  const expected = String(sessionId || "").trim();
  const recorded = String(checkpoint.sessionId || "").trim();
  return !recorded || !expected || recorded === expected;
}

function continuationInput(checkpoint = {}) {
  return String(checkpoint?.input || "").trim();
}

module.exports = {
  isContinuationRequest,
  isInternalRuntimeFailure,
  isInterruptedCheckpoint,
  resumeResultCompleted,
  latestRecoverableSummary,
  summaryExecutionText,
  createInterruptedCheckpoint,
  continuationInput,
  continuationInstruction,
  checkpointMatchesSession
};
