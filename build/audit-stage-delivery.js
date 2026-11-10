"use strict";

function auditStageDelivery(records, turnId) {
  const rows = records.filter(row => row.turnId === turnId);
  const produced = rows.filter(row => row.phase === "stage:producer:authored");
  const events = new Map();
  for (const row of rows) {
    if (!/^stage:(parsed|sent|persisted|received|painted)$/.test(row.phase) || !row.eventId) continue;
    if (!events.has(row.eventId)) events.set(row.eventId, []);
    events.get(row.eventId).push(row);
  }
  const deliveries = [...events].map(([eventId, samples]) => {
    const observed = [...new Set(samples.map(row => row.phase.slice(6)))];
    const expected = ["parsed", "sent", "persisted", "received", "painted"];
    const lengths = samples.filter(row => Number.isSafeInteger(row.contentChars)).map(row => row.contentChars);
    return { eventId, segmentId: samples[0].segmentId || "", observed,
      notObserved: expected.filter(stage => !observed.includes(stage)),
      lengthMismatch: new Set(lengths).size > 1 || samples.some(row => row.phase === "stage:painted" && row.displayedChars !== row.contentChars),
      persistenceFailed: samples.some(row => row.phase === "stage:persisted" && row.status === "failed"),
      paintStatus: samples.filter(row => row.phase === "stage:painted").at(-1)?.status || "not_observed" };
  });
  const lastProducer = rows.filter(row => row.phase.startsWith("stage:producer:")).at(-1);
  return { turnId, producedCount: produced.length,
    assessmentMissingChecks: rows.filter(row => row.phase === "stage:producer:assessment_missing").length,
    deliveryMissingChecks: rows.filter(row => row.phase === "stage:producer:delivery_missing").length,
    latestPendingCount: lastProducer?.pendingCount ?? null,
    producerWithoutParsedMatch: produced.filter(producer => !rows.some(row => row.phase === "stage:parsed"
      && row.segmentId && row.segmentId === producer.segmentId && row.contentChars === producer.contentChars))
      .map(row => ({ segmentId: row.segmentId, goalId: row.goalId, contentChars: row.contentChars })),
    deliveries,
    limitation: "未观察到某环节不等于丢失：需确认任务已结束、日志完整、对应会话已显示。证据ID可解析不代表结论语义正确。" };
}

module.exports = { auditStageDelivery };

if (require.main === module) {
  const [turnId, ...files] = process.argv.slice(2);
  if (!turnId || !files.length) throw new Error("Usage: node build/audit-stage-delivery.js TURN_ID TRACE.jsonl [...]");
  const records = files.flatMap(file => require("node:fs").readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  records.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  console.log(JSON.stringify(auditStageDelivery(records, turnId), null, 2));
}
