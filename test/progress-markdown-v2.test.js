"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { HmsUpdateStreamDemux, stripHmsProgressEnvelopes } = require("../services/hms-progress");
const { HermesAcpClient } = require("../services/hermes-acp-client");

const body = '# 阶段结论\n\n已核对 "原文"，路径 C:\\reports\\result.md。\n\n| 项目 | 数值 |\n|---|---|\n| 库存 | 20% |\n\n```xml\n</baiqiu-progress>\n<baiqiu-answer>只是示例</baiqiu-answer>\n```\n\n1. **第一项**\n2. 第二项';
const envelope = '<baiqiu-progress>{"schemaVersion":2,"segmentId":"one","type":"stage_result","status":"completed","evidenceToolCallIds":["tool-1"]}\n'
  + body + '\n</baiqiu-progress>\n';
const update = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

test("v2 stage preserves raw Markdown at every stream boundary and on history replay", () => {
  const source = envelope + "最终正文。";
  assert.equal(stripHmsProgressEnvelopes(source), "最终正文。");
  for (let split = 0; split <= source.length; split++) {
    const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false, segmentPrefix: "turn:" });
    const parts = [demux.consume(update(source.slice(0, split))), demux.consume(update(source.slice(split))), demux.flush()];
    const events = parts.flatMap(part => part.progressEvents);
    assert.equal(events.length, 1, `split ${split}`);
    assert.equal(events[0].message, body, `split ${split}`);
    assert.equal(events[0].segmentId, "turn:one");
    assert.equal(events[0].semanticType, "stage_result");
    assert.equal(parts.at(-1).protocolError, false, `split ${split}`);
    assert.equal(parts.at(-1).progressProtocolError, false);
    assert.equal(parts.flatMap(part => part.answerDeltas).map(part => part.delta).join("").trim(), "最终正文。");
  }
});

test("truncated v2 is not promoted to a complete stage or a successful turn", () => {
  for (const source of [envelope.slice(0, -22), envelope.replace('"schemaVersion":2,', '"schemaVersion":2,"message":"ambiguous",'),
    envelope.replace('# 阶段结论', '<baiqiu-answer>嵌套正文</baiqiu-answer>'), envelope.replace('"segmentId":"one",', '')]) {
    const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    const parts = [demux.consume(update(source)), demux.flush()];
    assert.equal(parts.flatMap(part => part.progressEvents).length, 0);
    assert.equal(parts.at(-1).protocolError, true);
  }
});

test("bounded legacy warning needs no second model request and preserves completed tools", async () => {
  const client = new HermesAcpClient();
  const frames = [
    { update: update("已交付正文。") },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "done", status: "completed" } },
    { update: { ...update(""), _meta: { baiqiu_diagnostic: { type: "protocol_recovery", phase: "warning",
      reason: "invalid_bounded_progress", attempt: 0, sequence: 1, timestamp: 1000,
      eventId: "protocol-recovery:11111111-1111-1111-1111-111111111111" } } } },
    { kind: "stop", stopReason: "end_turn" }
  ];
  let prompts = 0;
  client.ensureSession = async () => ({ hermesSessionId: "test", active: {
    prompt() { prompts++; }, async nextUpdate() { return frames.shift(); }
  } });
  const result = await client.prompt("local", "fixture");
  assert.equal(result.status, "done");
  assert.equal(result.text, "已交付正文。");
  assert.equal(prompts, 1);
  assert.equal(result.toolCalls[0].status, "completed");
});
