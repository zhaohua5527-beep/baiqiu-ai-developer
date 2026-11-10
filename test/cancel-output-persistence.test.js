"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createRequestRun } = require("../services/request-run-contract");
const { preserveFailedOutput } = require("../services/hms-stream-failure");
const { preserveCommittedOutcome } = require("../services/runtime-outcome");
const replay = require("../renderer-v2/persisted-replay");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const persistSource = source.slice(source.indexOf("function persistProductResult("), source.indexOf("function canConnect("));

function harness(partial, options = {}) {
  const aborted = options.aborted !== false;
  let stored = JSON.stringify({ sessions: [{ id: "session" }], messages: { session: [] } });
  const loadDb = () => JSON.parse(stored);
  const saveDb = (db) => { stored = JSON.stringify(db); };
  const activeRuns = new Map([["session", {
    runId: "turn", userAborted: true,
    userAborted: aborted,
    cancelAudit: aborted ? { requested: true, requestedBy: "user", proven: true } : null,
    executionViewState: { expanded: true },
    capturePartialOutput: () => partial
  }]]);
  const context = vm.createContext({
    loadDb, saveDb, activeRuns, createRequestRun, preserveFailedOutput, preserveCommittedOutcome,
    userFacingError: (value) => String(value || ""),
    isDevMode: true, compactPersistedExecutionPayload: (value) => value,
    appendMessage: (session, message) => {
      const db = loadDb(); db.messages[session].push(message); saveDb(db);
    },
    assistantCompletesUserMessage: () => false,
    verifyProductResultCommit: (session, id) => loadDb().messages[session].some((message) => message.id === id),
    verifyProductUserTurnCommit: () => true,
    finalizeDeliveredProductResult: () => {}, removeProductResultOutbox: () => {},
    safeMainWindowSend: () => {},
    mergePermanentHmsAnswer: (previous, next) => next.startsWith(previous) ? next : previous,
    console
  });
  vm.runInContext(persistSource, context);
  return { activeRuns, load: loadDb, persist: (result = {}) => context.persistProductResult({
    sessionId: "session", clientMessageId: "user", result: {
      status: aborted ? "cancelled" : "failed", runId: "turn", text: aborted ? "任务已终止。" : "执行失败。",
      success: false,
      cancelAudit: { requested: true, requestedBy: "user", proven: true }, ...result
    }
  }) };
}

test("failed result retains partial answer and events after an empty replay", () => {
  const answer = "已经完成第一部分\n\n| 列 | 值 |\n|---|---|\n| 模型在回复末尾吐 `";
  const event = (eventId, sequence, target) => ({ turnId: "turn", eventId, sequence, turnSequence: sequence, target });
  const partial = {
    executionLog: [{ ...event("tool-1", 1, "execution"), type: "tool", message: "正在核对源码" }],
    structuredEvents: [{ ...event("cross-1", 2, "structured_result"), semanticType: "cross", message: "已核到下半段" }],
    answerSegments: [{ ...event("answer-1", 3, "answer"), segmentId: "one", text: answer }]
  };
  const probe = harness(partial, { aborted: false });
  probe.persist({ status: "failed", success: false, text: answer, error: "本地收尾失败" });
  probe.activeRuns.clear();
  probe.persist({ status: "failed", success: false, text: "执行失败。" });
  const message = probe.load().messages.session[0];
  assert.match(message.text, /已经完成第一部分/);
  assert.deepEqual(replay.executionLogFromMessage(message), partial.executionLog);
  assert.equal(replay.structuredEventsFromMessage(message)[0].message, "已核到下半段");
  assert.equal(replay.answerSegmentsFromMessage(message).map((segment) => segment.text).join(""), answer);
  assert.equal(message.raw.productResult.status, "failed");
  assert.equal(message.raw.productResult.failureNotice, "本次任务未完整完成，已保留已经生成的内容。");
});

for (const answer of ["", "已经完成第一部分\n\n```python\nprint('半句"]) {
  test(`cancel commit and JSON reload preserve all emitted channels (${answer ? "partial answer" : "process only"})`, () => {
    const event = (eventId, sequence, target) => ({ turnId: "turn", eventId, sequence, turnSequence: sequence, target });
    const partial = {
      executionLog: [{ ...event("tool-1", 1, "execution"), type: "tool", message: "python task.py" }],
      structuredEvents: [{ ...event("cross-1", 2, "structured_result"), semanticType: "cross", message: "第一阶段结果" }],
      answerSegments: answer ? [{ ...event("answer-1", 3, "answer"), segmentId: "one", text: answer }] : []
    };
    const probe = harness(partial);
    const tokenUsage = { source: "provider", inputTokens: 800, outputTokens: 200, totalTokens: 1000 };
    probe.activeRuns.get("session").tokenUsage = tokenUsage;
    probe.persist();
    probe.activeRuns.clear();
    probe.persist({ executionLog: [], structuredEvents: [], answerSegments: [] });
    const message = probe.load().messages.session[0];
    assert.equal(probe.load().messages.session.length, 1);
    assert.equal(message.text, answer);
    assert.equal(message.raw.productResult.terminationNotice, undefined);
    assert.deepEqual(replay.executionLogFromMessage(message), partial.executionLog);
    assert.equal(replay.structuredEventsFromMessage(message)[0].message, "第一阶段结果");
    assert.equal(replay.answerSegmentsFromMessage(message).map((segment) => segment.text).join(""), answer);
    assert.equal(message.raw.productResult.executionViewState.expanded, true);
    assert.equal(message.raw.productResult.status, "cancelled");
    assert.deepEqual(message.raw.productResult.tokenUsage, tokenUsage);
  });
}

test("cancel merges a partial final payload with the snapshot taken before abort", () => {
  const event = (eventId, sequence, message) => ({ eventId, sequence, turnId: "turn", target: "execution", type: "tool", message });
  const first = event("first", 1, "已读取文件");
  const second = event("second", 2, "正在核对结果");
  const probe = harness({ executionLog: [] });
  probe.activeRuns.get("session").interruptedOutput = { executionLog: [first, second] };
  probe.persist({ executionLog: [second] });
  probe.activeRuns.clear();
  probe.persist({ executionLog: [] });
  const message = probe.load().messages.session[0];
  assert.deepEqual(replay.executionLogFromMessage(message), [first, second]);
  assert.equal(message.text, "");
  assert.equal(message.raw.productResult.status, "cancelled");
});
