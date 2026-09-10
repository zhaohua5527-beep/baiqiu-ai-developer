"use strict";

(function attachPersistedReplay(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BaiqiuPersistedReplay = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const objectValue = (value) => value && typeof value === "object" ? value : {};
  const arrayValue = (value) => Array.isArray(value) ? value : [];
  const eventTarget = (event = {}) => String(event.target || event.progressTarget || event.type || event.kind || "").toLowerCase();
  const eventFingerprint = (event) => JSON.stringify(event);
  function eventDisplayText(event = {}) {
    const delta = event.delta;
    if (delta !== undefined && delta !== null && String(delta).length > 0) return String(delta);
    return String(event.message ?? event.text ?? "");
  }

  function mergeStructuredEventLists(...lists) {
    const events = [];
    const seen = new Map();
    for (const event of lists.flatMap(arrayValue)) {
      if (!event || typeof event !== "object") continue;
      const target = eventTarget(event);
      if (!["structured", "structured_result", "public_progress"].includes(target)
        && !String(event.kind || "").toLowerCase().includes("structured")) continue;
      const sequence = Number(event.sequence || event.turnSequence || 0) || events.length + 1;
      const turnId = String(event.turnId || event.runId || "legacy-turn").trim();
      const type = String(event.type || event.kind || "public_progress").trim();
      const eventId = String(event.eventId || `${turnId}:structured:${sequence}:${type}`).trim();
      const normalized = { ...event, turnId, eventId, sequence, target: "structured_result", type };
      if (seen.has(eventId)) {
        if (seen.get(eventId) !== eventFingerprint(normalized)) console.error("[StructuredEvent] conflicting duplicate eventId", eventId);
        continue;
      }
      seen.set(eventId, eventFingerprint(normalized));
      events.push({ ...normalized, __arrival: events.length });
    }
    return events
      .sort((a, b) => (Number(a.turnSequence || a.sequence || 0) - Number(b.turnSequence || b.sequence || 0)) || (a.__arrival - b.__arrival))
      .map(({ __arrival, ...event }) => event);
  }

  function structuredEventsFromMessage(message = {}) {
    const raw = objectValue(message.raw);
    const nested = objectValue(raw.raw);
    const product = objectValue(raw.productResult);
    const productRaw = objectValue(product.raw);
    return mergeStructuredEventLists(
      message.structuredEvents,
      raw.structuredEvents,
      nested.structuredEvents,
      product.structuredEvents,
      productRaw.structuredEvents,
      objectValue(productRaw.raw).structuredEvents
    );
  }

  function mergeAnswerSegmentLists(...lists) {
    const output = [];
    const positions = new Map();
    for (const item of lists.flatMap(arrayValue)) {
      if (!item || typeof item !== "object") continue;
      const segmentId = String(item.segmentId || item.segment_id || "").trim();
      const text = String(item.text || item.content || "");
      if (!segmentId || !text) continue;
      const sequence = Number(item.sequence || item.turnSequence || 0) || output.length + 1;
      const turnId = String(item.turnId || item.runId || "legacy-turn").trim();
      const eventId = String(item.eventId || `${turnId}:answer:${sequence}:${segmentId}`).trim();
      const normalized = { ...item, turnId, eventId, sequence, segmentId, target: "answer", type: String(item.type || "answer_segment"), text };
      const position = positions.get(eventId);
      if (position === undefined) {
        positions.set(eventId, output.length);
        output.push(normalized);
      } else if (eventFingerprint(output[position]) !== eventFingerprint(normalized)) {
        console.error("[AnswerEvent] conflicting duplicate eventId", eventId);
      }
    }
    return output.sort((a, b) => (Number(a.turnSequence || a.sequence || 0) - Number(b.turnSequence || b.sequence || 0)) || (a.sequence - b.sequence));
  }

  function answerSegmentsFromMessage(message = {}) {
    const raw = objectValue(message.raw);
    const nested = objectValue(raw.raw);
    const product = objectValue(raw.productResult);
    const productRaw = objectValue(product.raw);
    return mergeAnswerSegmentLists(
      message.answerSegments,
      raw.answerSegments,
      nested.answerSegments,
      product.answerSegments,
      productRaw.answerSegments,
      objectValue(productRaw.raw).answerSegments
    );
  }

  function executionLogFromMessage(message = {}) {
    const raw = objectValue(message.raw);
    const nested = objectValue(raw.raw);
    const product = objectValue(raw.productResult);
    const productRaw = objectValue(product.raw);
    const requestEvidence = objectValue(raw.requestRun?.evidence);
    const nestedEvidence = objectValue(nested.requestRun?.evidence);
    const productEvidence = objectValue(product.requestRun?.evidence);
    const productRawEvidence = objectValue(productRaw.requestRun?.evidence);
    return [
      message.executionLog,
      raw.executionLog,
      nested.executionLog,
      requestEvidence.executionLog,
      nestedEvidence.executionLog,
      product.executionLog,
      productRaw.executionLog,
      productEvidence.executionLog,
      productRawEvidence.executionLog,
      product.taskBrain?.execution_log
    ].flatMap(arrayValue);
  }

  function replaySegmentModel(message = {}, processDetails = executionLogFromMessage(message)) {
    const structuredEvents = structuredEventsFromMessage(message);
    const authored = answerSegmentsFromMessage(message);
    const answerSegments = authored.length || !structuredEvents.length
      ? authored
      : [{
          turnId: String(structuredEvents[0]?.turnId || "legacy-turn"),
          eventId: `${String(structuredEvents[0]?.turnId || "legacy-turn")}:answer:1:__default`,
          sequence: 1,
          segmentId: "__default",
          target: "answer",
          type: "answer_segment",
          text: String(message.text || "")
        }];
    const orderedSegments = [...answerSegments].sort((a, b) => (Number(a.turnSequence || a.sequence || 0) - Number(b.turnSequence || b.sequence || 0)) || (a.sequence - b.sequence));
    const segmentIds = new Set(orderedSegments.map((segment) => String(segment.segmentId || "__default")));
    const processBySegment = new Map([...segmentIds].map((id) => [id, []]));
    const structuredBySegment = new Map([...segmentIds].map((id) => [id, []]));
    const segmentForEvent = (event) => {
      const explicit = String(event.segmentId || event.segment_id || "").trim();
      if (explicit && segmentIds.has(explicit)) return explicit;
      const sequence = Number(event.turnSequence || event.sequence || 0);
      const candidate = orderedSegments.find((segment) => sequence > 0 && Number(segment.turnSequence || segment.sequence || 0) >= sequence) || orderedSegments.at(-1);
      return candidate ? String(candidate.segmentId || "__default") : "";
    };
    for (const detail of arrayValue(processDetails)) {
      if (["structured", "structured_result"].includes(String(detail.target || "").toLowerCase())) continue;
      const id = segmentForEvent(detail);
      if (id) processBySegment.get(id).push(detail);
    }
    for (const event of structuredEvents) {
      const id = segmentForEvent(event);
      if (id) structuredBySegment.get(id).push(event);
    }
    return { answerSegments, structuredEvents, processDetails: arrayValue(processDetails), orderedSegments, processBySegment, structuredBySegment };
  }

  function snapshotMessageIdentity(message = {}) {
    const raw = objectValue(message.raw);
    const product = objectValue(raw.productResult);
    return String(message.id || raw.responseMessageId || product.responseMessageId || raw.clientMessageId || message.clientMessageId || "").trim();
  }

  function mergeSessionSnapshotMessage(current = {}, incoming = {}) {
    const currentRaw = objectValue(current.raw);
    const incomingRaw = objectValue(incoming.raw);
    const currentResult = objectValue(currentRaw.productResult);
    const incomingResult = objectValue(incomingRaw.productResult);
    const structuredEvents = mergeStructuredEventLists(
      current.structuredEvents, currentRaw.structuredEvents, objectValue(currentRaw.raw).structuredEvents,
      currentResult.structuredEvents, objectValue(currentResult.raw).structuredEvents,
      incoming.structuredEvents, incomingRaw.structuredEvents, objectValue(incomingRaw.raw).structuredEvents,
      incomingResult.structuredEvents, objectValue(incomingResult.raw).structuredEvents
    );
    const answerSegments = mergeAnswerSegmentLists(
      current.answerSegments, currentRaw.answerSegments, objectValue(currentRaw.raw).answerSegments,
      currentResult.answerSegments, objectValue(currentResult.raw).answerSegments,
      incoming.answerSegments, incomingRaw.answerSegments, objectValue(incomingRaw.raw).answerSegments,
      incomingResult.answerSegments, objectValue(incomingResult.raw).answerSegments
    );
    const currentText = String(current.text || "");
    const incomingText = String(incoming.text || "");
    let text = incomingText || currentText;
    let preserveCurrentResult = false;
    if (current.role === "assistant" && currentText) {
      if (!incomingText || currentText.startsWith(incomingText)) {
        text = currentText;
        preserveCurrentResult = true;
      } else if (!incomingText.startsWith(currentText) && incomingText !== currentText) {
        console.error("[SessionSnapshot] refused to overwrite committed answer", snapshotMessageIdentity(current));
        text = currentText;
        preserveCurrentResult = true;
      }
    }
    const mergedRaw = { ...currentRaw, ...incomingRaw, raw: { ...objectValue(currentRaw.raw), ...objectValue(incomingRaw.raw) } };
    const mergedProduct = {
      ...(preserveCurrentResult ? incomingResult : currentResult),
      ...(preserveCurrentResult ? currentResult : incomingResult)
    };
    if (structuredEvents.length) mergedProduct.structuredEvents = structuredEvents;
    if (answerSegments.length) mergedProduct.answerSegments = answerSegments;
    if (Object.keys(mergedProduct).length) mergedRaw.productResult = mergedProduct;
    if (structuredEvents.length) mergedRaw.structuredEvents = structuredEvents;
    if (answerSegments.length) mergedRaw.answerSegments = answerSegments;
    return { ...current, ...incoming, text, raw: mergedRaw };
  }

  return {
    mergeStructuredEventLists,
    structuredEventsFromMessage,
    mergeAnswerSegmentLists,
    eventDisplayText,
    answerSegmentsFromMessage,
    executionLogFromMessage,
    replaySegmentModel,
    mergeSessionSnapshotMessage
  };
});
