"use strict";

const { createHash } = require("node:crypto");

function runtimeOutcome(result = {}) {
  const outcome = result.runtimeOutcome || result.raw?.runtimeOutcome;
  if (outcome?.source !== "black_ball_runtime" || !outcome.turnId || !outcome.eventId
    || !Number.isSafeInteger(outcome.sequence) || outcome.sequence < 2) return null;
  const runId = result.runId || result.raw?.runId;
  if (runId && outcome.turnId !== runId) return null;
  return outcome;
}

function preserveCommittedOutcome(previous = {}, incoming = {}) {
  const committed = runtimeOutcome(previous);
  if (committed?.status !== "completed" || incoming.runId !== previous.runId) return incoming;
  const next = runtimeOutcome(incoming);
  if (next?.eventId === committed.eventId && next.sequence === committed.sequence
    && next.status !== committed.status) throw new Error("Conflicting Black Ball terminal event");
  return previous;
}

function enforceRuntimeOutcome(result = {}) {
  const outcome = runtimeOutcome(result);
  if (outcome?.status === "completed" && outcome.completion
    && !["failed", "cancelled", "aborted"].includes(result.status)
    && !hasCommittedRuntimeDelivery(result)) {
    return { ...result, status: "unknown", success: undefined, executionOutcome: "unknown",
      completedDelivery: false, deliveryStatus: "incomplete",
      error: "黑球已结束，但交付清单中的内容尚未收齐或校验未通过；已收到的内容已保留。" };
  }
  if (!outcome || outcome.status === "completed") return result;
  if (outcome.status === "awaiting_input" && !result.protocolError && result.status !== "failed") return { ...result, status: "awaiting_input", success: true,
    executionOutcome: "none", runtimeOutcome: outcome };
  const status = outcome.status === "cancelled" ? "cancelled" : outcome.status === "unknown" ? "unknown" : "failed";
  return { ...result, status, success: status === "unknown" ? undefined : false,
    executionOutcome: status, runtimeOutcome: outcome };
}

function hasCommittedRuntimeDelivery(result = {}) {
  if (!result || typeof result !== "object") return false;
  const outcome = runtimeOutcome(result);
  const completion = outcome?.completion;
  if (!completion && outcome?.status === "completed" && outcome.stopReason === "end_turn"
    && !outcome.pendingToolIds?.length && !outcome.pendingSupplementIds?.length
    && !Object.keys(outcome.supplements || {}).length) {
    const answers = result.answerSegments || result.raw?.answerSegments;
    const text = Array.isArray(answers) && answers.length
      ? answers.map(event => event.text || "").join("") : result.text || result.raw?.text || "";
    return Boolean(String(text).trim());
  }
  if (!["completed", "awaiting_input"].includes(outcome?.status) || completion?.version !== 1 || completion.status !== outcome.status
    || outcome.pendingToolIds?.length || (outcome.status === "completed" && outcome.pendingSupplementIds?.length)
    || !Array.isArray(completion.outputs) || !completion.outputs.length || completion.outputs.length > 100) return false;
  if (outcome.status === "completed" && Object.values(outcome.supplements || {}).some(item => item.status !== "addressed")) return false;
  const supplementIds = Object.keys(outcome.supplements || {});
  if (outcome.status === "completed" && supplementIds.length
    && (completion.scope !== "active_task" || !Array.isArray(completion.addressedSupplementIds)
      || completion.addressedSupplementIds.length !== supplementIds.length
      || !supplementIds.every(id => completion.addressedSupplementIds.includes(id)))) return false;
  const suppliedEvents = result.structuredEvents || result.raw?.structuredEvents;
  const suppliedAnswers = result.answerSegments || result.raw?.answerSegments;
  const events = Array.isArray(suppliedEvents) ? suppliedEvents : [];
  const answers = Array.isArray(suppliedAnswers) ? suppliedAnswers : [];
  const text = String(answers.length ? answers.map(event => event.text || "").join("") : result.text || result.raw?.text || "")
    .replace(/\r\n/g, "\n").trim();
  const hash = content => createHash("sha256").update(content).digest("hex");
  return completion.outputs.every(reference => {
    if (typeof reference?.segmentId !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256 || "")) return false;
    if (reference.target === "answer") return Number.isSafeInteger(reference.contentChars) && reference.contentChars > 0
      && text.length >= reference.contentChars && hash(text.slice(-reference.contentChars)) === reference.sha256;
    return reference.target === "structured" && events.some(event => event.turnId === outcome.turnId && event.eventId
      && (event.semanticType || event.type) === "stage_result"
      && event.nativeSegmentId === reference.segmentId
      && hash(String(event.message || "").replace(/\r\n/g, "\n").trim()) === reference.sha256);
  });
}

module.exports = { runtimeOutcome, preserveCommittedOutcome, enforceRuntimeOutcome, hasCommittedRuntimeDelivery };
