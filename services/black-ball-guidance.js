"use strict";

const MODES = new Set(["execute", "select", "fill", "select_and_fill", "confirm"]);

function clean(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function normalizeGuidanceCard(raw = {}, { sessionId = "", originalRequest = "", requestId = "" } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const mode = clean(raw.interactionMode || raw.mode || "select_and_fill", 40).toLowerCase();
  const interactionMode = MODES.has(mode) ? mode : "select_and_fill";
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((item, index) => {
      const option = typeof item === "string" ? { label: item, value: item } : item || {};
      const label = clean(option.label || option.text || option.value, 160);
      if (!label) return null;
      return {
        id: clean(option.id || option.optionId || `option_${index + 1}`, 120),
        label,
        value: clean(option.value || option.text || label, 500),
        action: clean(option.action || "select", 40) || "select",
        recommended: option.recommended === true
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  const input = raw.input && typeof raw.input === "object" ? raw.input : {};
  const inputEnabled = interactionMode === "fill"
    || interactionMode === "select_and_fill"
    || input.enabled === true;
  if (!options.length && !inputEnabled) return null;
  return {
    cardType: "task_guidance",
    interactionMode,
    sessionId: clean(raw.sessionId || sessionId, 200),
    requestId: clean(raw.requestId || requestId, 200),
    originalRequest: clean(raw.originalRequest || originalRequest, 2000),
    question: clean(raw.question || raw.prompt, 1000),
    reason: clean(raw.reason, 500),
    required: (Array.isArray(raw.required) ? raw.required : [])
      .map((item) => clean(item, 160)).filter(Boolean).slice(0, 8),
    input: {
      enabled: inputEnabled,
      placeholder: clean(input.placeholder || "也可以直接填写你的要求", 160),
      required: input.required === true,
      fields: Array.isArray(input.fields) ? input.fields.slice(0, 6) : []
    },
    options
  };
}

function createGuidanceState(card, { sessionId = "", originalRequest = "", attachments = [], taskId = "" } = {}) {
  if (!card) return null;
  return {
    ...card,
    sessionId: clean(card.sessionId || sessionId, 200),
    originalRequest: clean(card.originalRequest || originalRequest, 2000),
    taskId: clean(taskId || card.taskId, 200),
    attachments: Array.isArray(attachments) ? attachments.slice(0, 12) : [],
    createdAt: new Date().toISOString()
  };
}

function resolveGuidanceResponse(state, response = {}) {
  if (!state || typeof state !== "object") throw Object.assign(new Error("任务引导已失效，请重新描述需求。"), { code: "GUIDANCE_STALE" });
  if (clean(response.sessionId, 200) !== clean(state.sessionId, 200)) {
    throw Object.assign(new Error("任务引导不属于当前会话。"), { code: "GUIDANCE_SESSION_MISMATCH" });
  }
  if (clean(response.requestId, 200) !== clean(state.requestId, 200)) {
    throw Object.assign(new Error("任务引导已过期，请使用最新提示。"), { code: "GUIDANCE_REQUEST_MISMATCH" });
  }
  const value = clean(response.value || response.label, 2000);
  const option = (state.options || []).find((item) => clean(item.id, 120) === clean(response.optionId, 120));
  const custom = clean(response.action, 40) === "custom";
  if (!option && !(custom && state.input?.enabled)) {
    throw Object.assign(new Error("该选项不属于当前任务引导。"), { code: "GUIDANCE_OPTION_INVALID" });
  }
  if (!value) throw Object.assign(new Error("请先选择一个选项或填写具体要求。"), { code: "GUIDANCE_VALUE_REQUIRED" });
  return {
    selectedValue: value,
    optionId: option?.id || "custom",
    originalRequest: clean(state.originalRequest, 2000),
    attachments: Array.isArray(state.attachments) ? state.attachments : []
  };
}

function continuationForGuidance(state, response = {}) {
  const resolved = resolveGuidanceResponse(state, response);
  return {
    ...resolved,
    text: [
      resolved.originalRequest,
      `用户选择或补充：${resolved.selectedValue}`,
      "请根据这个选择继续处理原请求；如果信息已经足够，直接完成任务。"
    ].filter(Boolean).join("\n\n")
  };
}

module.exports = {
  normalizeGuidanceCard,
  createGuidanceState,
  resolveGuidanceResponse,
  continuationForGuidance
};
