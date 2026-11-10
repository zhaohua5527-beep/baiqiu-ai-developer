"use strict";

const CONTEXT_AUTO_EXTRACT_REMAIN_PERCENT = 10;

function messagesAfterContextCheckpoint(session, messages = []) {
  const items = Array.isArray(messages) ? messages : [];
  const checkpointId = String(session?.contextArchivedThroughMessageId || "").trim();
  if (!checkpointId) return items;
  const checkpointIndex = items.findIndex((item) => String(item?.id || "") === checkpointId);
  if (checkpointIndex >= 0) return items.slice(checkpointIndex + 1);
  const compactedAt = Number(session?.contextCompactedAt) || 0;
  return compactedAt > 0
    ? items.filter((item) => Number(item?.createdAt) > compactedAt)
    : items;
}

function shouldAutoExtractContext(remainPercent) {
  const remaining = Number(remainPercent);
  return Number.isFinite(remaining) && remaining <= CONTEXT_AUTO_EXTRACT_REMAIN_PERCENT;
}

function contextResetPatch(session, visibleMessages = [], { snapshotId = "", compactedAt = Date.now() } = {}) {
  const messages = Array.isArray(visibleMessages) ? visibleMessages : [];
  return {
    contextEpoch: Math.max(0, Number(session?.contextEpoch) || 0) + 1,
    contextArchivedThroughMessageId: String(messages.at(-1)?.id || ""),
    contextCompactedAt: Number(compactedAt) || Date.now(),
    contextLastSnapshotId: String(snapshotId || ""),
    contextAutoExtractPending: null,
    hermesSessionId: null,
    lastRunId: null
  };
}

module.exports = {
  CONTEXT_AUTO_EXTRACT_REMAIN_PERCENT,
  messagesAfterContextCheckpoint,
  shouldAutoExtractContext,
  contextResetPatch
};
