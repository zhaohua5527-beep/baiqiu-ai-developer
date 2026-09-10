"use strict";

(function attachBlackBallPublicEventContract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BaiqiuBlackBallPublicEvents = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const SEMANTIC_TYPES = Object.freeze([
    "thinking",
    "action",
    "cross",
    "stage_result",
    "tool",
    "final"
  ]);
  const SEMANTIC_TYPE_SET = new Set(SEMANTIC_TYPES);
  const TYPE_ALIASES = Object.freeze({
    reasoning_delta: "thinking",
    reasoning_note: "thinking",
    public_reasoning: "thinking",
    thought: "thinking",
    public_progress: "thinking",
    plan: "action",
    execution: "action",
    tool_started: "tool",
    tool_result: "tool",
    verification_result: "tool",
    turn_complete: "final"
  });
  const TYPE_TARGETS = Object.freeze({
    thinking: "structured_result",
    action: "execution_activity",
    cross: "structured_result",
    stage_result: "structured_result",
    tool: "execution_activity",
    final: "answer"
  });

  function normalizeSemanticType(value = "") {
    const type = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (SEMANTIC_TYPE_SET.has(type)) return type;
    return TYPE_ALIASES[type] || "";
  }

  function semanticTypeFromEvent(event = {}) {
    const source = event && typeof event === "object" ? event : {};
    return normalizeSemanticType(
      source.semanticType
      || source.semantic_type
      || source.type
      || source.kind
      || ""
    );
  }

  function targetForSemanticType(value = "") {
    return TYPE_TARGETS[normalizeSemanticType(value)] || "";
  }

  function canonicalTarget(value = "") {
    const target = String(value || "").trim().toLowerCase();
    if (["structured", "structured_result", "reasoning"].includes(target)) return "structured_result";
    if (["execution", "execution_activity", "activity"].includes(target)) return "execution_activity";
    if (["answer", "result", "prose"].includes(target)) return "answer";
    return "";
  }

  function createEventState(turnId = "") {
    return {
      turnId: String(turnId || "").trim(),
      events: [],
      duplicates: 0,
      violations: [],
      hasCross: false,
      stageResultCount: 0,
      finalReceived: false
    };
  }

  function stableEventValue(value) {
    if (Array.isArray(value)) return value.map(stableEventValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value)
      .filter((key) => !key.startsWith("__"))
      .sort()
      .map((key) => [key, stableEventValue(value[key])]));
  }

  function eventFingerprint(event = {}) {
    return JSON.stringify(stableEventValue({
      ...event,
      target: canonicalTarget(event.target || event.outputType),
      semanticType: normalizeSemanticType(event.semanticType)
    }));
  }

  function addViolation(state, code, event = {}) {
    state.violations.push({
      code,
      eventId: String(event.eventId || ""),
      sequence: Number(event.sequence || 0)
    });
    return state;
  }

  function recomputeState(state) {
    state.events.sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)
      || Number(a.turnSequence || 0) - Number(b.turnSequence || 0)
      || String(a.eventId || "").localeCompare(String(b.eventId || "")));
    state.hasCross = state.events.some((event) => event.semanticType === "cross");
    state.stageResultCount = state.events.filter((event) => event.semanticType === "stage_result").length;
    state.finalReceived = state.events.some((event) => event.semanticType === "final");
    return state;
  }

  function reduceEventState(previous = createEventState(), source = {}) {
    const state = {
      ...createEventState(previous.turnId),
      ...previous,
      events: Array.isArray(previous.events) ? previous.events.map((event) => ({ ...event })) : [],
      violations: Array.isArray(previous.violations) ? previous.violations.map((item) => ({ ...item })) : []
    };
    const declaredValue = source?.semanticType ?? source?.semantic_type;
    if (declaredValue === undefined || declaredValue === null || String(declaredValue).trim() === "") return state;
    const semanticType = normalizeSemanticType(declaredValue);
    if (!semanticType) return addViolation(state, "unsupported_semantic_type", source);
    const turnId = String(source.turnId || state.turnId || "").trim();
    const eventId = String(source.eventId || "").trim();
    const sequence = Number(source.sequence || 0);
    const target = canonicalTarget(source.target || source.outputType);
    if (!turnId || !eventId || sequence <= 0 || !target) return addViolation(state, "invalid_event_envelope", source);
    if (state.turnId && state.turnId !== turnId) return addViolation(state, "turn_mismatch", source);
    const expectedTarget = targetForSemanticType(semanticType);
    if (target !== expectedTarget) return addViolation(state, "semantic_target_mismatch", source);
    const event = { ...source, turnId, eventId, sequence, target, semanticType };
    const existing = state.events.find((item) => item.eventId === eventId);
    if (existing) {
      if (eventFingerprint(existing) !== eventFingerprint(event)) return addViolation(state, "conflicting_event_id", event);
      state.duplicates = Number(state.duplicates || 0) + 1;
      return state;
    }
    const terminalSequence = state.events
      .filter((item) => item.semanticType === "final")
      .reduce((lowest, item) => Math.min(lowest, Number(item.sequence || Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    if (semanticType !== "final" && sequence > terminalSequence) return addViolation(state, "event_after_final", event);
    state.turnId = turnId;
    state.events.push(event);
    return recomputeState(state);
  }

  return {
    SEMANTIC_TYPES,
    normalizeSemanticType,
    semanticTypeFromEvent,
    targetForSemanticType,
    canonicalTarget,
    createEventState,
    reduceEventState
  };
});
