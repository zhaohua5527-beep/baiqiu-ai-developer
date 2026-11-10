"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { auditStageDelivery } = require("../build/audit-stage-delivery");

test("delivery audit distinguishes producer gaps, transport evidence and offscreen paint", () => {
  const base = { turnId: "one", segmentId: "first", contentChars: 120 };
  const records = [{ ...base, phase: "stage:producer:authored", evidenceResolved: true },
    ...["parsed", "sent", "persisted", "received", "painted"].map(stage => ({ ...base,
      phase: `stage:${stage}`, eventId: "event-1", displayedChars: 120, status: stage === "painted" ? "offscreen" : "ok" })),
    { ...base, phase: "stage:producer:assessment_missing", pendingCount: 0 },
    { ...base, phase: "stage:producer:authored", segmentId: "second" },
    { ...base, phase: "stage:producer:authored", turnId: "other" }];
  const report = auditStageDelivery(records, "one");
  assert.equal(report.producedCount, 2);
  assert.equal(report.assessmentMissingChecks, 1);
  assert.equal(report.producerWithoutParsedMatch[0].segmentId, "second");
  assert.deepEqual(report.deliveries[0].notObserved, []);
  assert.equal(report.deliveries[0].paintStatus, "offscreen");
  assert.equal(report.deliveries[0].lengthMismatch, false);
  records.push({ ...base, phase: "stage:painted", eventId: "event-1", contentChars: 80, displayedChars: 80 });
  assert.equal(auditStageDelivery(records, "one").deliveries[0].lengthMismatch, true);
});
