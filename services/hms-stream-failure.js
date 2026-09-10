"use strict";

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
    && value?.type === "provider_timing"
    && /^(client_prepare|client_ready|http_request|http_headers|first_byte|stream_activity|stream_closed|connection_(connect_tcp|start_tls)_(started|complete)|http(11|2)_(send_request_body_complete|receive_response_headers_started))$/.test(value.stage || "")
    && /^[a-f0-9-]{36}$/.test(value.requestId || "")) {
    const timing = { type: "provider_timing", stage: value.stage, requestId: value.requestId };
    for (const key of ["timestamp", "httpStatus", "requestBytes", "bytesReceived", "messageCount", "toolCount", "contextChars", "runtimeContextCount", "visibleHistoryCount", "replayedReasoningChars"]) {
      if (Number.isFinite(value[key]) && value[key] >= 0) timing[key] = value[key];
    }
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
  return request.timeoutKind === "first_event"
    ? { code: "MODEL_FIRST_EVENT_TIMEOUT", message: "模型在 30 秒内没有返回首个内容。" }
    : { code: "MODEL_NO_PROGRESS_TIMEOUT", message: "连续 2 分钟没有收到模型、工具或正文事件。" };
}

function preserveFailedOutput(result = {}, failureText = "") {
  const segments = Array.isArray(result.answerSegments) ? result.answerSegments
    : Array.isArray(result.raw?.answerSegments) ? result.raw.answerSegments : [];
  const text = segments.map((segment) => String(segment.text || "")).join("");
  return text.trim() ? `${text}\n\n${failureText}` : failureText;
}

module.exports = { PROVIDER_ERRORS, providerDiagnostic, timeoutFailure, preserveFailedOutput };
