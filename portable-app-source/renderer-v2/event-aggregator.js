"use strict";

(function attachEventAggregator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BaiqiuEventAggregator = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const SEMANTIC_TYPES = new Set([
    "thinking", "action", "cross", "stage_result", "tool", "final"
  ]);
  const ALIASES = Object.freeze({
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

  function semanticType(event = {}) {
    const value = String(
      event.semanticType ?? event.semantic_type ?? event.type ?? event.kind ?? ""
    ).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const normalized = ALIASES[value] || value;
    return SEMANTIC_TYPES.has(normalized) ? normalized : "";
  }

  function eventId(event = "", fallback = "") {
    return String(event?.eventId || fallback || "").trim();
  }

  function sequenceOf(event = {}, index = 0) {
    const value = Number(event.sequence ?? event.turnSequence ?? event.seq ?? 0);
    return Number.isFinite(value) && value > 0 ? value : index + 1;
  }

  function turnOf(event = "", fallback = "") {
    return String(event?.turnId || event?.runId || fallback || "").trim();
  }

  function stableText(event = {}) {
    return String(event.text ?? event.message ?? event.delta ?? event.publicSummary ?? "");
  }

  function normalizeEvent(event = {}, index = 0, fallbackTurnId = "") {
    const source = event && typeof event === "object" ? event : { message: event };
    const turnId = turnOf(source, fallbackTurnId);
    const sequence = sequenceOf(source, index);
    const semantic = semanticType(source);
    const id = eventId(source, `${turnId || "turn"}:event:${sequence}:${index}`);
    return {
      ...source,
      turnId,
      eventId: id,
      sequence,
      turnSequence: Number(source.turnSequence ?? source.seq ?? sequence) || sequence,
      semanticType: semantic,
      stage: String(source.stage || source.stageId || "").trim(),
      stageId: String(source.stageId || source.stage || "").trim(),
      action: String(source.action || source.actionId || "").trim(),
      actionId: String(source.actionId || source.publicActionId || source.toolCallId || "").trim(),
      category: String(source.category || source.toolCategory || source.tool || "").trim(),
      text: stableText(source)
    };
  }

  function compareEvents(a, b) {
    return (Number(a.sequence || 0) - Number(b.sequence || 0))
      || (Number(a.turnSequence || 0) - Number(b.turnSequence || 0))
      || (Number(a.timestamp || 0) - Number(b.timestamp || 0))
      || String(a.eventId || "").localeCompare(String(b.eventId || ""));
  }

  function actionKey(event) {
    if (event.actionId) return `id:${event.actionId}`;
    if (event.action || event.category) return `kind:${event.action || ""}:${event.category || ""}`;
    if (["cross", "stage_result", "final"].includes(event.semanticType)) return `event:${event.eventId}`;
    return `event:${event.eventId}`;
  }

  function stageKey(event) {
    return event.stageId || event.stage || "stage:default";
  }

  function aggregateExecutionEvents(rawEvents = [], options = {}) {
    const input = Array.isArray(rawEvents) ? rawEvents : [];
    const fallbackTurnId = String(options.turnId || "").trim();
    const normalized = input.map((event, index) => normalizeEvent(event, index, fallbackTurnId));
    const selectedTurnId = fallbackTurnId || normalized.find((event) => event.turnId)?.turnId || "";
    const scoped = normalized.filter((event) => !selectedTurnId || !event.turnId || event.turnId === selectedTurnId);
    const seen = new Map();
    const deduped = [];
    const conflicts = [];
    for (const event of scoped.sort(compareEvents)) {
      const existing = seen.get(event.eventId);
      if (!existing) {
        seen.set(event.eventId, event);
        deduped.push(event);
        continue;
      }
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        conflicts.push({ eventId: event.eventId, first: existing, conflicting: event });
      }
    }
    const stages = [];
    const stageMap = new Map();
    for (const event of deduped) {
      const key = stageKey(event);
      let stage = stageMap.get(key);
      if (!stage) {
        stage = {
          id: key,
          label: event.stage || key.replace(/^stage:/, "") || "当前阶段",
          kind: event.stage || "",
          status: "running",
          sourceEventIds: [],
          actionGroups: [],
          latestEvent: null,
          cross: null,
          crossEvents: [],
          stageResult: null,
          stageResults: []
        };
        stageMap.set(key, stage);
        stages.push(stage);
      }
      stage.sourceEventIds.push(event.eventId);
      stage.latestEvent = event;
      if (event.semanticType === "cross") {
        stage.cross = event;
        stage.crossEvents.push(event);
      }
      if (event.semanticType === "stage_result") {
        stage.stageResult = event;
        stage.stageResults.push(event);
        stage.status = event.status === "failed" ? "failed" : "completed";
      } else if (event.status === "failed") stage.status = "failed";
      else if (event.semanticType === "final") stage.status = "completed";
      if (!["cross", "stage_result", "final"].includes(event.semanticType)) {
        const keyForAction = actionKey(event);
        let action = stage.actionGroups.find((item) => item.id === keyForAction);
        if (!action) {
          action = {
            id: keyForAction,
            label: event.action || event.category || event.semanticType || "执行",
            category: event.category || "",
            sourceEventIds: [],
            eventCount: 0,
            latestEvent: null
          };
          stage.actionGroups.push(action);
        }
        action.sourceEventIds.push(event.eventId);
        action.eventCount += 1;
        action.latestEvent = event;
      }
    }
    const currentStage = [...stages].reverse().find((stage) => stage.status === "running") || stages.at(-1) || null;
    const currentAction = currentStage?.actionGroups?.at(-1) || null;
    const currentEvent = deduped.at(-1) || null;
    return {
      turnId: selectedTurnId,
      rawEvents: input.slice(),
      events: deduped,
      stages,
      currentStage,
      currentAction,
      currentEvent,
      hasCross: deduped.some((event) => event.semanticType === "cross"),
      stageResultCount: deduped.filter((event) => event.semanticType === "stage_result").length,
      finalReceived: deduped.some((event) => event.semanticType === "final"),
      conflicts
    };
  }

  return { aggregateExecutionEvents, normalizeEvent, semanticType };
});
