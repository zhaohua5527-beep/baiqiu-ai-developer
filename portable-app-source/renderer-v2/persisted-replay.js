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
    const output = [];
    const seen = new Map();
    for (const event of [
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
    ].flatMap(arrayValue)) {
      if (!event || typeof event !== "object") {
        output.push(event);
        continue;
      }
      const eventId = String(event.eventId || "").trim();
      let key = eventId;
      if (!key) {
        try { key = JSON.stringify(event); } catch { key = `${output.length}`; }
      }
      if (seen.has(key)) {
        if (JSON.stringify(seen.get(key)) !== JSON.stringify(event)) console.error("[ExecutionEvent] conflicting duplicate eventId", key);
        continue;
      }
      seen.set(key, event);
      output.push(event);
    }
    return output;
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

  function supplementReplyMessages(message = {}) {
    if (message.role !== "assistant" || message.raw?.replyPart) return [message];
    const originalResult = objectValue(message.raw?.productResult);
    const originalUserId = originalResult.clientMessageId || message.raw?.clientMessageId || originalResult.requestRun?.userMessageId || "";
    const lists = { answerSegments: answerSegmentsFromMessage(message), structuredEvents: structuredEventsFromMessage(message),
      executionLog: executionLogFromMessage(message) };
    const allEvents = Object.values(lists).flat().filter(event => event && typeof event === "object").sort((left, right) => Number(left.turnSequence || left.sequence || 0)
      - Number(right.turnSequence || right.sequence || 0));
    const ownerOf = event => event?.replyToUserMessageId && event.replyToUserMessageId !== originalUserId ? event.replyToUserMessageId : "";
    const owners = [...new Set(["", ...allEvents.map(ownerOf)])];
    if (owners.length === 1) return [message];
    const fullAnswer = lists.answerSegments.map(event => String(event.text || "")).join("");
    const fullText = String(message.text || "");
    if (fullText.trim() && fullText.trim() !== fullAnswer.trim() && !fullText.startsWith(fullAnswer)) return [message];
    const suffix = fullText.trim() === fullAnswer.trim() ? "" : fullText.startsWith(fullAnswer) ? fullText.slice(fullAnswer.length) : "";
    return owners.map((owner, index) => {
      const text = lists.answerSegments.filter(event => ownerOf(event) === owner).map(event => String(event.text || "")).join("")
        + (index === owners.length - 1 ? suffix : "");
      const select = (value, depth = 0) => {
        const selected = { ...objectValue(value) };
        for (const key of Object.keys(lists)) if (Array.isArray(selected[key])) selected[key] = selected[key].filter(event => ownerOf(event) === owner);
        if (Array.isArray(selected.execution_log)) selected.execution_log = selected.execution_log.filter(event => ownerOf(event) === owner);
        for (const key of ["raw", "productResult", "requestRun", "evidence", "taskBrain"]) {
          if (selected[key] && depth < 6) selected[key] = select(selected[key], depth + 1);
        }
        return selected;
      };
      const id = owner ? String(message.id) + ":reply:" + encodeURIComponent(owner) : message.id;
      const raw = { ...select(message.raw), replyPart: true, replyToUserMessageId: owner || originalUserId };
      if (raw.productResult) raw.productResult = { ...raw.productResult, text, responseMessageId: id };
      return { ...message, id, text, raw,
        ...Object.fromEntries(Object.entries(lists).map(([key, events]) => [key, events.filter(event => ownerOf(event) === owner)])) };
    });
  }

  function expandSupplementReplies(messages = []) {
    const userIds = new Set(messages.filter(message => message.role === "user").map(message => message.id));
    const replies = new Map();
    const remaining = [];
    for (const message of messages) {
      const parts = supplementReplyMessages(message);
      if (parts.length === 1) { remaining.push(message); continue; }
      for (const part of parts) {
        const owner = part.raw.replyToUserMessageId;
        if (!userIds.has(owner)) { remaining.push(part); continue; }
        const group = replies.get(owner) || [];
        group.push(part);
        replies.set(owner, group);
      }
    }
    return remaining.flatMap(message => [message, ...(message.role === "user" ? replies.get(message.id) || [] : [])]);
  }

  return {
    supplementReplyMessages,
    expandSupplementReplies,
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
