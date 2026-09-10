"use strict";

const { randomUUID } = require("node:crypto");

const RUNTIME_STATUSES = new Set(["idle", "starting", "running", "waiting_hms", "cancel_requested", "ended"]);
const EXECUTION_OUTCOMES = new Set(["none", "succeeded", "failed", "cancelled", "timed_out", "unknown"]);
const DELIVERY_STATUSES = new Set(["none", "delivered", "degraded", "blocked"]);
const PRESENTATION_STATUSES = new Set(["none", "streaming", "typing", "rendered", "recovered", "failed"]);
const INTERACTION_KINDS = new Set(["chat", "execute", "continue", "retry", "cancel", "qa", "system"]);

function cleanText(value, limit = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = cleanText(value, 80).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeInteractionKind(value = "") {
  return normalizeEnum(value, INTERACTION_KINDS, "chat");
}

function normalizeRuntimeStatus(value = "") {
  return normalizeEnum(value, RUNTIME_STATUSES, "idle");
}

function normalizeExecutionOutcome(value = "") {
  return normalizeEnum(value, EXECUTION_OUTCOMES, "unknown");
}

function normalizeDeliveryStatus(value = "") {
  return normalizeEnum(value, DELIVERY_STATUSES, "none");
}

function normalizePresentationStatus(value = "") {
  return normalizeEnum(value, PRESENTATION_STATUSES, "none");
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function completedToolCalls(value = []) {
  return list(value).filter((call) => {
    const status = cleanText(call?.status || call?.state, 80).toLowerCase();
    const output = call?.rawOutput || call?.output || call?.response || call?.result || null;
    return !call?.error
      && output?.error == null
      && output?.success !== false
      && (["completed", "complete", "success", "succeeded", "done"].includes(status) || output?.success === true);
  });
}

function completedDelegations(value = []) {
  return list(value).filter((item) => ["completed", "complete", "success", "succeeded", "done"]
    .includes(cleanText(item?.status || item?.state, 80).toLowerCase()));
}

function hasDurableEvidence(evidence = {}) {
  return list(evidence.files).length > 0
    || completedToolCalls(evidence.toolCalls).length > 0
    || completedDelegations(evidence.delegations).length > 0
    || evidence.hmsFinal === true;
}

function evidenceFromResult(result = {}) {
  const raw = result.raw && typeof result.raw === "object" ? result.raw : {};
  const taskBrain = result.taskBrain && typeof result.taskBrain === "object" ? result.taskBrain : {};
  return {
    hmsFinal: Boolean(
      result.hmsFinal
      || raw.hmsFinal
      || cleanText(result.hmsOutcome?.status || raw.hmsOutcome?.status, 80).toLowerCase() === "completed"
    ),
    files: [
      ...list(result.files),
      ...list(result.generatedFiles),
      ...list(raw.files),
      ...list(raw.generatedFiles),
      ...list(taskBrain.files)
    ],
    toolCalls: [
      ...list(result.toolCalls),
      ...list(raw.toolCalls),
      ...list(taskBrain.tool_evidence)
    ],
    delegations: [
      ...list(result.delegationResults),
      ...list(result.delegationEvidence),
      ...list(raw.delegationResults),
      ...list(raw.delegationEvidence),
      ...list(taskBrain.delegation_results)
    ],
    executionLog: [
      ...list(result.executionLog),
      ...list(raw.executionLog),
      ...list(taskBrain.execution_log)
    ],
    timestamps: {
      startedAt: result.startedAt || "",
      finishedAt: result.finishedAt || ""
    },
    sourceRunIds: [
      result.runId,
      result.projectRunId,
      result.traceId,
      raw.runId,
      raw.projectRunId,
      raw.traceId
    ].map((item) => cleanText(item, 160)).filter(Boolean)
  };
}

function executionOutcomeFromResult(result = {}, evidence = evidenceFromResult(result)) {
  const explicit = cleanText(
    result.executionOutcome
    || result.execution_outcome
    || result.raw?.executionOutcome
    || result.raw?.execution_outcome,
    80
  ).toLowerCase();
  if (EXECUTION_OUTCOMES.has(explicit)) return explicit;
  const status = cleanText(result.status, 80).toLowerCase();
  if (["cancelled", "aborted"].includes(status) || result.cancelled === true) return "cancelled";
  if (status === "timed_out") return "timed_out";
  if (result.stopReason === "missing_public_final_envelope" && hasDurableEvidence(evidence)) return "succeeded";
  if (result.success === false || ["failed", "error", "blocked"].includes(status)) return "failed";
  if (result.success === true || ["done", "completed", "success", "succeeded"].includes(status)) return "succeeded";
  if (evidence.hmsFinal === true) return "succeeded";
  if (hasDurableEvidence(evidence)) return "unknown";
  if (!status) return "none";
  return "unknown";
}

function deliveryStatusFromResult(result = {}, outcome = executionOutcomeFromResult(result)) {
  const explicit = cleanText(result.deliveryStatus || result.delivery_status, 80).toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(explicit)) return "delivered";
  if (outcome === "succeeded" && ["failed", "error", "blocked"].includes(explicit)) return "degraded";
  if (["failed", "error"].includes(explicit)) return "blocked";
  if (explicit) return normalizeDeliveryStatus(explicit, "none");
  if (outcome === "succeeded") {
    return result.stopReason === "missing_public_final_envelope" ? "degraded" : "delivered";
  }
  if (outcome === "failed" || outcome === "timed_out") return "blocked";
  return "none";
}

function presentationStatusFromResult(result = {}, delivery = deliveryStatusFromResult(result)) {
  const explicit = cleanText(result.presentationStatus || result.presentation_status, 80).toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(explicit)) return "rendered";
  if (delivery === "degraded" && ["failed", "error", "blocked"].includes(explicit)) return "recovered";
  if (explicit === "degraded") return "recovered";
  if (explicit) return normalizePresentationStatus(explicit, "none");
  if (delivery === "degraded") return "recovered";
  if (delivery === "delivered") return "rendered";
  if (delivery === "blocked") return "failed";
  return "none";
}

function cancelRequestTargetsRun(requestedRunId = "", activeRun = null) {
  const requested = cleanText(requestedRunId, 160);
  const active = cleanText(activeRun?.runId || activeRun?.abortSignalId, 160);
  return Boolean(requested && active && requested === active);
}

function buildCancelAudit({ result = {}, activeRun = null, requestedBy = "", runId = "" } = {}) {
  const resultRunId = cleanText(runId || result.runId || result.traceId, 160);
  const matchesActiveRun = cancelRequestTargetsRun(resultRunId, activeRun);
  const explicitAudit = result.cancelAudit && typeof result.cancelAudit === "object" ? result.cancelAudit : {};
  const requested = Boolean(
    (matchesActiveRun && activeRun?.userAborted)
    || (explicitAudit.requested === true && (!explicitAudit.abortSignalId || explicitAudit.abortSignalId === resultRunId))
  );
  const proven = Boolean(requested && (
    (matchesActiveRun && activeRun?.userAborted && activeRun?.controller?.signal?.aborted)
    || explicitAudit.proven === true
  ));
  return {
    requested,
    requestedBy: cleanText(requestedBy || explicitAudit.requestedBy || (requested ? "user" : ""), 80),
    requestedAt: explicitAudit.requestedAt || (matchesActiveRun ? activeRun?.userAbortedAt : "") || "",
    abortSignalId: cleanText(explicitAudit.abortSignalId || (matchesActiveRun ? activeRun?.abortSignalId || activeRun?.runId : ""), 160),
    hmsStopReason: cleanText(result.stopReason || "", 160),
    proven
  };
}

function decisionFromUnderstanding(understanding = {}) {
  const route = cleanText(understanding.route || understanding.routing || "chat", 80).toLowerCase() || "chat";
  const responseMode = cleanText(understanding.responseMode || understanding.requiredAction || "answer", 80).toLowerCase();
  const shouldExecute = Boolean(understanding.shouldCreateTask || understanding.need_execution || responseMode === "execute");
  return {
    authority: "whiteball_understanding",
    shouldExecute,
    shouldAsk: responseMode === "clarify",
    shouldAnswer: !shouldExecute && responseMode !== "clarify",
    route,
    reasonCode: cleanText(understanding.reasonCode || understanding.intentType || understanding.classification, 160),
    confidence: Number.isFinite(Number(understanding.confidence)) ? Number(understanding.confidence) : null,
    noBusinessGate: true
  };
}

function createRequestRun(input = {}) {
  const runId = cleanText(input.runId || input.traceId || `run-${randomUUID()}`, 160);
  const eventId = cleanText(input.eventId || `${runId}:created`, 220);
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : evidenceFromResult(input.result || {});
  const executionOutcome = normalizeExecutionOutcome(input.executionOutcome || executionOutcomeFromResult(input.result || {}, evidence));
  const deliveryStatus = normalizeDeliveryStatus(input.deliveryStatus || deliveryStatusFromResult(input.result || {}, executionOutcome));
  const presentationStatus = normalizePresentationStatus(input.presentationStatus || presentationStatusFromResult(input.result || {}, deliveryStatus));
  return {
    schemaVersion: 1,
    runId,
    eventId,
    sessionId: cleanText(input.sessionId, 160),
    userMessageId: cleanText(input.userMessageId, 160),
    responseMessageId: cleanText(input.responseMessageId, 160),
    interactionKind: normalizeInteractionKind(input.interactionKind),
    decision: input.decision && typeof input.decision === "object"
      ? input.decision
      : decisionFromUnderstanding(input.understanding || {}),
    taskId: cleanText(input.taskId, 160),
    runtimeStatus: normalizeRuntimeStatus(input.runtimeStatus || "ended"),
    executionOutcome,
    deliveryStatus,
    presentationStatus,
    evidence,
    cancelAudit: input.cancelAudit && typeof input.cancelAudit === "object"
      ? input.cancelAudit
      : buildCancelAudit({ result: input.result || {}, activeRun: input.activeRun || null, requestedBy: input.requestedBy || "", runId })
  };
}

module.exports = {
  createRequestRun,
  evidenceFromResult,
  executionOutcomeFromResult,
  deliveryStatusFromResult,
  presentationStatusFromResult,
  buildCancelAudit,
  cancelRequestTargetsRun,
  decisionFromUnderstanding,
  hasDurableEvidence,
  normalizeInteractionKind,
  normalizeRuntimeStatus,
  normalizeExecutionOutcome,
  normalizeDeliveryStatus,
  normalizePresentationStatus
};
