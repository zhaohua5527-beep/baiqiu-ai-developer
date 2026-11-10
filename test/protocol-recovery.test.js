"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { HmsUpdateStreamDemux } = require("../services/hms-progress");
const { HermesAcpClient } = require("../services/hermes-acp-client");
const { failIncompleteProtocol, finalizePublicProtocol, providerDiagnostic } = require("../services/hms-stream-failure");
const broken = '<baiqiu-progress>{"segmentId":"4","type":"stage_result","status":"completed","message":"第二轮搜索已完成，继续定位。"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const update = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const diagnostic = (phase, attempt = 1) => ({ ...update(""), _meta: { baiqiu_diagnostic: {
  type: "protocol_recovery", phase, attempt, sequence: 1, reason: "unclosed_progress", timestamp: 1000,
  eventId: `protocol-recovery:11111111-1111-1111-1111-${String(attempt).padStart(12, "0")}`
} } });

test("observed DSML tail salvages only complete public JSON at every network split", () => {
  for (let split = 0; split <= broken.length; split++) {
    const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false, segmentPrefix: "turn:" });
    const parts = [demux.consume(update(broken.slice(0, split))), demux.consume(update(broken.slice(split))), demux.flush()];
    const events = parts.flatMap(part => part.progressEvents);
    assert.equal(events.length, 1, `split ${split}`);
    assert.equal(events[0].message, "第二轮搜索已完成，继续定位。");
    assert.equal(events[0].segmentId, "turn:4");
    assert.equal(parts.at(-1).protocolError, true);
    assert.equal(parts.map(part => part.visibleDelta).join(""), "");
    assert.equal(demux.flush().progressEvents.length, 0);
  }
  for (const text of [broken.replace('"stage_result"', '"invented"'), broken.replace('"4"', 'null'),
    broken.replace('"message":', '"message":broken'), broken.replace('</｜｜DSML｜｜ parameter>', 'untrusted prose')]) {
    const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    demux.consume(update(text));
    assert.equal(demux.flush().progressEvents.length, 0);
  }
});

test("partial answer never converts a protocol failure or cancellation to success", () => {
  const event = { eventId: "stage-1", text: "阶段结果" };
  const failed = failIncompleteProtocol({ status: "done", protocolError: true, structuredEvents: [event] }, "已经找到线索。");
  assert.equal(failed.status, "failed");
  assert.equal(failed.stopReason, "invalid_public_protocol");
  assert.equal(failed.text, "已经找到线索。");
  assert.equal(failed.structuredEvents[0], event);
  assert.equal(failIncompleteProtocol({ status: "cancelled", stopReason: "cancelled" }, "保留").status, "cancelled");
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(source, /if \(result\.protocolError\) \{\s+publicFinalMissing = true;\s+result = failIncompleteProtocol/);
});

test("recovery boundary retains old output, salvages the last stage and scopes new segments", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const start = source.indexOf('        if (diagnostic.type === "protocol_recovery")');
  const end = source.indexOf('        if (diagnostic.type === "provider_usage")', start);
  const emitted = [];
  const harness = new Function("HmsUpdateStreamDemux", "emitHmsProgress", `
    const segmentPrefix = "turn:p1:";
    const session = {id:"session"}, streamId="turn", writeCrossReplyTrace=()=>{};
    let streamProtocolError = false, streamProgressProtocolError = false;
    let visibleStream = new HmsUpdateStreamDemux({ requireFinalEnvelope:false, segmentPrefix });
    const onDiagnostic = diagnostic => { ${source.slice(start, end)} };
    return { consume: value=>visibleStream.consume(value), onDiagnostic, failed:()=>streamProtocolError };
  `)(HmsUpdateStreamDemux, events => emitted.push(...events));
  assert.equal(harness.consume(update("已经完成第一步。\n")).visibleDelta, "已经完成第一步。\n");
  harness.consume(update(broken));
  harness.onDiagnostic(providerDiagnostic(diagnostic("retrying")));
  assert.equal(emitted[0].message, "第二轮搜索已完成，继续定位。");
  assert.equal(harness.failed(), false);
  const next = harness.consume(update('<baiqiu-progress>{"type":"stage_result","segmentId":"4","message":"找到了真实项目。"}</baiqiu-progress>'));
  assert.equal(next.progressEvents[0].segmentId, "turn:p1:r1:4");
});

for (const phase of ["retrying", "failed", "recovered"]) {
  test(`ACP stop reflects recovery state ${phase} and keeps tool results`, async () => {
    const client = new HermesAcpClient();
    const queue = [
      { update: update("已完成第一步。") },
      { update: { sessionUpdate: "tool_call", toolCallId: "one", title: "write_file" } },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "one", status: "completed" } },
      { update: diagnostic(phase) }, { kind: "stop", stopReason: "end_turn" }
    ];
    client.ensureSession = async () => ({ hermesSessionId: "same-session", active: { prompt() {}, async nextUpdate() { return queue.shift(); } } });
    const result = await client.prompt("local", "test");
    assert.equal(result.status, phase === "recovered" ? "done" : "failed");
    assert.equal(result.text, "已完成第一步。");
    assert.equal(result.toolCalls[0].status, "completed");
    assert.equal(result.hermesSessionId, "same-session");
  });
}

test("user cancellation wins over a late recovery failure", async () => {
  const client = new HermesAcpClient();
  const queue = [{ update: diagnostic("failed") }, { kind: "stop", stopReason: "cancelled" }];
  client.ensureSession = async () => ({ hermesSessionId: "same", active: { prompt() {}, async nextUpdate() { return queue.shift(); } } });
  assert.equal((await client.prompt("local", "test")).status, "cancelled");
});

test("bounded malformed progress does not fail a completed answer at any stream split", () => {
  const malformed = '<baiqiu-progress>{"segmentId":"1","type":"stage_result","message":"已核对"依据"。"}</baiqiu-progress>';
  const next = '<baiqiu-progress>{"segmentId":"2","type":"action","message":"继续核对。"}</baiqiu-progress>';
  const answer = "# 核对结果\n\n正文已交付。\n\n1. 请补充资料。";
  const source = malformed + next + `<baiqiu-answer segmentId="2">${answer}</baiqiu-answer>`;
  for (let split = 0; split <= source.length; split++) {
    const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    const parts = [demux.consume(update(source.slice(0, split))), demux.consume(update(source.slice(split))), demux.flush()];
    const text = parts.map(part => part.visibleDelta + part.answerDeltas.map(item => item.delta).join("")).join("");
    const parsed = parts.at(-1);
    const result = finalizePublicProtocol({ status: "done", stopReason: "end_turn", toolCalls: [{ status: "completed" }] }, parsed, text);
    assert.equal(parsed.protocolError, false, `split ${split}`);
    assert.equal(parsed.progressProtocolError, true);
    assert.equal(result.status, "done");
    assert.equal(result.text, answer);
    assert.equal(result.progressProtocolWarning, true);
    assert.deepEqual(parts.flatMap(part => part.progressEvents).map(event => event.message), ["继续核对。"]);
  }
});

test("progress warnings cannot conceal failed, cancelled, empty or unfinished turns", () => {
  for (const result of [
    { status: "failed", error: "provider failure" }, { status: "cancelled" },
    { status: "done", protocolError: true }, { status: "done", toolCalls: [{ status: "running" }] }
  ]) {
    const finalized = finalizePublicProtocol(result, { progressProtocolError: true }, "已完成第一步。");
    assert.equal(finalized.status, result.status === "cancelled" ? "cancelled" : "failed");
    assert.equal(finalized.text, "已完成第一步。");
  }
  assert.equal(finalizePublicProtocol({ status: "done" }, { progressProtocolError: true }, "").status, "failed");
  const unrecovered = finalizePublicProtocol({ status: "done" }, { protocolError: true }, "保留正文");
  assert.doesNotMatch(unrecovered.error, /自动恢复未成功/);
  assert.equal(unrecovered.status, "failed");
});

test("passive metadata after an implicit answer has the same boundary semantics as after plain text", () => {
  for (const kind of ["clarification", "presentation", "outcome", "outline"]) {
    const source = '<baiqiu-progress>{"segmentId":"6","type":"action","message":"核对完成。"}</baiqiu-progress>'
      + `正文已交付。<baiqiu-${kind}>{"question":"补充资料"}</baiqiu-${kind}>`;
    for (let split = 0; split <= source.length; split++) {
      const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
      const parts = [demux.consume(update(source.slice(0, split))), demux.consume(update(source.slice(split))), demux.flush()];
      assert.equal(parts.at(-1).protocolError, false, `${kind}: split ${split}`);
      assert.equal(parts.flatMap(part => part.answerDeltas).map(answer => answer.delta).join(""), "正文已交付。");
      assert.equal(parts.flatMap(part => part.completedSegments).length, 1);
      assert.equal(parts.map(part => part.visibleDelta).join(""), "");
    }
  }
  const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
  demux.consume(update('<baiqiu-answer segmentId="1">保留正文<baiqiu-clarification>{"question":"截断'));
  assert.equal(demux.flush().protocolError, true);
});

test("ACP continuation prompts carry the same White Ball turn identity", async () => {
  const client = new HermesAcpClient();
  const sent = [];
  client.ensureSession = async () => ({ hermesSessionId: "same", active: {
    prompt(blocks) { sent.push(blocks); },
    async nextUpdate() { return { kind: "stop", stopReason: "end_turn" }; }
  } });
  await client.prompt("local", "original", { turnId: "turn-one" });
  await client.prompt("local", "continuation", { turnId: "turn-one" });
  assert.deepEqual(sent.map(blocks => blocks[0]._meta.baiqiuTurnId), ["turn-one", "turn-one"]);
  assert.deepEqual(sent.map(blocks => blocks[0].text), ["original", "continuation"]);
});

test("duplicate recovery delivery is idempotent and missing or conflicting events fail closed", async () => {
  for (const kind of ["duplicate", "conflict", "gap"]) {
    const client = new HermesAcpClient();
    const first = diagnostic("retrying");
    const second = structuredClone(first);
    if (kind === "conflict") second._meta.baiqiu_diagnostic.phase = "failed";
    if (kind === "gap") {
      second._meta.baiqiu_diagnostic.eventId = "protocol-recovery:22222222-2222-2222-2222-222222222222";
      second._meta.baiqiu_diagnostic.sequence = 3;
    }
    const queue = [{ update: update("保留结果") }, { update: first }, { update: second }, { kind: "stop", stopReason: "end_turn" }];
    client.ensureSession = async () => ({ hermesSessionId: "same", active: { prompt() {}, async nextUpdate() { return queue.shift(); } } });
    let notifications = 0;
    const result = client.prompt("local", "test", { onDiagnostic() { notifications++; } });
    if (kind === "duplicate") assert.equal((await result).diagnostics.length, 1);
    else await assert.rejects(result, error => error.hermesResult.text === "保留结果");
    assert.equal(notifications, 1);
  }
});

test("product result retains protocol failure metadata and durable content", async () => {
  const { UIAdapter } = require("../services/product-sdk/ui-adapter");
  const adapter = Object.create(UIAdapter.prototype);
  adapter.chatRunner = async () => ({ ok: false, ...failIncompleteProtocol({ protocolError: true,
    answerSegments: [{ text: "已完成第一步。" }], structuredEvents: [{ eventId: "stage-1", text: "已定位" }] }, "已完成第一步。") });
  const result = await adapter.submitCanonicalUIInput({ templateId: "desktop.chat_runtime", message: "test" });
  assert.equal(result.success, false);
  assert.equal(result.raw.protocolError, true);
  assert.equal(result.stopReason, "invalid_public_protocol");
  assert.match(result.text, /已完成第一步。/);
  assert.match(result.text, /任务未完成/);
});
