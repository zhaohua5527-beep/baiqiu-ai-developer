"use strict";

const { runtimeOutcome, hasCommittedRuntimeDelivery } = require("./runtime-outcome");

const PROVIDER_ERRORS = Object.freeze({
  HERMES_PROVIDER_OVERLOADED: "模型供应商服务器当前过载，请稍后重试。",
  HERMES_PROVIDER_RATE_LIMITED: "模型供应商当前限流，请稍后重试。",
  HERMES_PROVIDER_AUTH_FAILED: "模型供应商拒绝了身份验证，请检查 API Key 和访问权限。",
  HERMES_PROVIDER_READ_TIMEOUT: "等待模型供应商的数据超时，请稍后重试。",
  HERMES_PROVIDER_STREAM_DROPPED: "模型供应商的数据流中断，本轮未正常完成。",
  HERMES_PROVIDER_FAILURE: "模型供应商返回错误，本轮未正常完成。"
});

function providerDiagnostic(update = {}) {
  const value = update._meta?.baiqiu_diagnostic;
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "supplement" && ["accepted", "applied", "addressed", "needs_clarification", "failed", "pending", "cancelled"].includes(value.stage)
    && /^supplement:[a-f0-9-]{36}$/.test(value.eventId || "")
    && typeof value.supplementId === "string" && value.supplementId.length > 0 && value.supplementId.length <= 240
    && typeof value.turnId === "string" && value.turnId.length > 0 && value.turnId.length <= 240
    && Number.isSafeInteger(value.sequence) && value.sequence > 0 && Number.isFinite(value.timestamp) && value.timestamp > 0) {
    return { type: value.type, stage: value.stage, supplementId: value.supplementId,
      turnId: value.turnId, eventId: value.eventId, sequence: value.sequence, timestamp: value.timestamp,
      ...(typeof value.responseSegmentId === "string" ? { responseSegmentId: value.responseSegmentId.slice(0, 160) } : {}) };
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "stage_delivery"
    && ["checkpoint", "invalid_assessment", "ready", "pending", "authored", "delivery_missing", "assessment_missing", "final"].includes(value.stage)
    && /^stage-delivery:[a-f0-9-]{36}$/.test(value.eventId || "")
    && typeof value.turnId === "string" && value.turnId.length <= 240
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && Number.isFinite(value.timestamp) && value.timestamp > 0) {
    const diagnostic = { type: value.type, stage: value.stage, eventId: value.eventId,
      turnId: value.turnId, sequence: value.sequence, timestamp: value.timestamp };
    for (const key of ["toolCount", "unassessedCount", "pendingCount", "contentChars"]) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) diagnostic[key] = value[key];
    }
    for (const key of ["segmentId", "goalId"]) {
      if (typeof value[key] === "string") diagnostic[key] = value[key].slice(0, 160);
    }
    if (typeof value.evidenceResolved === "boolean") diagnostic.evidenceResolved = value.evidenceResolved;
    return diagnostic;
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "session_waiting" && ["waiting", "ready"].includes(value.phase)
    && /^session-wait:[a-f0-9-]{36}$/.test(value.eventId || "")
    && typeof value.turnId === "string" && value.turnId.length <= 240
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && Number.isFinite(value.timestamp) && value.timestamp > 0) {
    return { type: value.type, phase: value.phase, eventId: value.eventId,
      turnId: value.turnId, sequence: value.sequence, timestamp: value.timestamp };
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "protocol_recovery"
    && ["retrying", "recovered", "failed", "warning"].includes(value.phase)
    && /^protocol-recovery:[a-f0-9-]{36}$/.test(value.eventId || "")
    && Number.isInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 2
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && Number.isFinite(value.timestamp) && value.timestamp > 0
    && /^[a-z_]{1,64}$/.test(value.reason || "")) {
    return { type: value.type, phase: value.phase, reason: value.reason,
      eventId: value.eventId, sequence: value.sequence, attempt: value.attempt, timestamp: value.timestamp };
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "provider_usage" && /^[a-f0-9-]{36}$/.test(value.requestId || "")
    && [value.inputTokens, value.outputTokens, value.totalTokens].every(number => Number.isSafeInteger(number) && number >= 0)) {
    const usage = { type: "provider_usage", requestId: value.requestId,
      inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens };
    for (const key of ["cacheReadTokens", "cacheWriteTokens"]) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
    }
    return usage;
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === ""
    && value?.type === "provider_timing"
    && /^(context_prepare|context_ready|client_prepare|client_ready|http_request|http_headers|first_byte|stream_activity|stream_closed|connection_(connect_tcp|start_tls)_(started|complete)|http(11|2)_(send_request_body_complete|receive_response_headers_started))$/.test(value.stage || "")
    && /^[a-f0-9-]{36}$/.test(value.requestId || "")) {
    const timing = { type: "provider_timing", stage: value.stage, requestId: value.requestId };
    for (const key of ["timestamp", "httpStatus", "requestBytes", "bytesReceived", "messageCount", "toolCount", "contextChars", "runtimeContextCount", "visibleHistoryCount", "replayedReasoningChars",
      "toolSchemaChars", "systemChars", "userChars", "assistantChars", "toolResultChars", "toolCallChars", "protocolReplayChars", "imageDataChars", "imageCount",
      "contextBeforeChars", "contextCandidateChars", "contextSelectedChars", "contextOffloadedCount", "contextCandidateCount", "contextArchiveFailures", "contextRelevantCount"]) {
      if (Number.isFinite(value[key]) && value[key] >= 0) timing[key] = value[key];
    }
    if (["off", "shadow", "on"].includes(value.contextPolicy)) timing.contextPolicy = value.contextPolicy;
    for (const key of ["thinkingEnabled", "preservedThinking", "toolStream"]) {
      if (typeof value[key] === "boolean") timing[key] = value[key];
    }
    if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoningEffort)) timing.reasoningEffort = value.reasoningEffort;
    return timing;
  }
  if (update.sessionUpdate !== "agent_message_chunk" || update.content?.text !== ""
    || value?.type !== "provider_error" || !Object.hasOwn(PROVIDER_ERRORS, value.code)) return null;
  const diagnostic = { type: "provider_error", code: value.code };
  if (value.errorCategory === "weekly_limit_exceeded") diagnostic.errorCategory = value.errorCategory;
  if (/^[A-Za-z0-9_]{1,80}$/.test(value.errorType || "")) diagnostic.errorType = value.errorType;
  for (const key of ["timestamp", "httpStatus", "requestStartedAt", "firstChunkAt"]) {
    if (Number.isFinite(value[key]) && value[key] > 0) diagnostic[key] = value[key];
  }
  return diagnostic;
}

function timeoutFailure(request = {}) {
  if (request.timeoutKind === "connection") return { code: "MODEL_CONNECTION_TIMEOUT", message: "请求发出后 30 秒内未收到模型响应数据。" };
  if (request.timeoutKind === "first_public") return { code: "MODEL_PUBLIC_OUTPUT_TIMEOUT", message: "模型已响应，但 2 分钟内仍未产生正文或公开执行事件。" };
  if (request.timeoutKind === "total") return { code: "MODEL_TASK_TIMEOUT", message: "本次任务已达到 30 分钟执行时限。" };
  const pendingTool = (Array.isArray(request.toolCalls) ? request.toolCalls : []).findLast(tool =>
    ["pending", "in_progress", "running"].includes(tool.status)
    || (!tool.status && tool.sessionUpdate === "tool_call"));
  if (pendingTool) return { code: "TOOL_NO_PROGRESS_TIMEOUT",
    message: "工具执行期间连续 2 分钟没有返回进展，本轮已停止；已经生成的文件和内容仍然保留。" };
  return request.timeoutKind === "first_event"
    ? { code: "MODEL_FIRST_EVENT_TIMEOUT", message: "模型在 30 秒内没有返回首个内容。" }
    : { code: "MODEL_NO_PROGRESS_TIMEOUT", message: "连续 2 分钟没有收到模型、工具或正文事件。" };
}

function preserveFailedOutput(result = {}, failureText = "") {
  const segments = Array.isArray(result.answerSegments) ? result.answerSegments
    : Array.isArray(result.raw?.answerSegments) ? result.raw.answerSegments : [];
  const text = segments.map((segment) => String(segment.text || "")).join("").trim();
  if (!text) return failureText;
  if (!failureText || text === failureText || text.endsWith(`\n\n${failureText}`)) return text;
  return `${text}\n\n${failureText}`;
}

function failIncompleteProtocol(result = {}, streamedText = "") {
  const publicResult = { ...result, text: String(streamedText || result.text || "") };
  const committed = runtimeOutcome(publicResult);
  const cancelled = ["cancelled", "aborted"].includes(result.status);
  if (!cancelled && committed?.status === "completed" && hasCommittedRuntimeDelivery(publicResult)) {
    return { ...publicResult, status: "done", ok: true, success: true,
      executionOutcome: "succeeded", protocolError: false, protocolWarning: true,
      protocolFailureReason: "invalid_public_protocol",
      deliveryError: result.error || "输出格式校验异常，黑球已提交的结果已保留。",
      error: null, deliveryStatus: "degraded", presentationStatus: "recovered",
      stopReason: committed.stopReason || "committed_runtime_delivery" };
  }
  return { ...result, text: String(streamedText || result.text || ""),
    status: cancelled ? result.status : "failed", success: false,
    executionOutcome: cancelled ? "cancelled" : "failed",
    error: cancelled ? result.error : result.error || "本次任务未完成：输出格式校验未通过。已保留当前结果。",
    deliveryStatus: "degraded", presentationStatus: cancelled ? "cancelled" : "failed",
    stopReason: cancelled ? result.stopReason : "invalid_public_protocol" };
}

function finalizePublicProtocol(result = {}, parsed = {}, publicText = "") {
  const text = String(publicText || "");
  if (parsed.protocolError || result.protocolError) {
    return failIncompleteProtocol({ ...result, protocolError: true }, text);
  }
  if (!parsed.progressProtocolError) return { ...result, text };
  const pendingTools = (result.toolCalls || []).some(tool => !["completed", "failed", "cancelled"].includes(tool.status));
  const complete = result.status === "done" && text.trim() && !pendingTools;
  if (!complete) return failIncompleteProtocol({ ...result, protocolError: true, progressProtocolWarning: true }, text);
  return { ...result, text, progressProtocolWarning: true };
}

module.exports = { PROVIDER_ERRORS, providerDiagnostic, timeoutFailure, preserveFailedOutput, failIncompleteProtocol, finalizePublicProtocol };
