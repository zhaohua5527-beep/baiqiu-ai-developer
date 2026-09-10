"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { HmsUpdateStreamDemux, HmsProgressMapper, buildExecutionLog } = require("../services/hms-progress");
const replay = require("../renderer-v2/persisted-replay");

function update(text, channel = "message", extra = {}) {
  return { sessionUpdate: `agent_${channel}_chunk`, content: { type: "text", text }, ...extra };
}

function progress(type, message, segmentId = "stage-1") {
  return `<baiqiu-progress>${JSON.stringify({ type, message, segmentId })}</baiqiu-progress>`;
}

function outputText(parts) {
  return parts.map(part => (part.visibleDelta || "")
    + part.answerDeltas.map(answer => answer.delta).join("")).join("");
}

test("a progress segment never promotes the next native reasoning update to an answer", () => {
  for (const type of ["action", "cross", "stage_result"]) {
    for (const size of [1, 7, 4096]) {
      const stream = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
      const parts = [];
      const authored = progress(type, "已读取第一份数据");
      for (let offset = 0; offset < authored.length; offset += size) parts.push(stream.consume(update(authored.slice(offset, offset + size))));
      parts.push(stream.consume(update("INTERNAL_CHANNEL_MARKER", "thought")));
      parts.push(stream.consume(update("真实阶段答复。")));
      parts.push(stream.flush());
      assert.equal(outputText(parts), "真实阶段答复。");
      assert.equal(parts.flatMap(part => part.progressEvents).length, 1);
    }
  }
});

test("reasoning cannot inherit an open answer, final envelope or partial protocol tag", () => {
  for (const [opening, closing] of [
    ['<baiqiu-answer segmentId="first">', "</baiqiu-answer>"],
    ["<baiqiu-final>", "</baiqiu-final>"]
  ]) {
    const stream = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    const parts = [stream.consume(update(opening + "第一段")),
      stream.consume(update("INTERNAL_CHANNEL_MARKER", "thought")),
      stream.consume(update("回复" + closing)), stream.flush()];
    assert.equal(outputText(parts), "第一段回复");
  }
  const stream = new HmsUpdateStreamDemux();
  const parts = [stream.consume(update("<baiqiu-ans")),
    stream.consume(update('wer segmentId="wrong">INTERNAL_CHANNEL_MARKER', "thought")),
    stream.consume(update('wer segmentId="right">真实答复</baiqiu-answer>')), stream.flush()];
  assert.equal(outputText(parts), "真实答复");
});

test("public thought envelopes remain public without promoting their following unmarked text", () => {
  const stream = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
  const mapper = new HmsProgressMapper();
  const parts = [];
  const events = [];
  for (const item of [
    update(progress("stage_result", "真实阶段结果"), "thought", { visibility: "public" }),
    update("INTERNAL_CHANNEL_MARKER", "thought"),
    update('<baiqiu-answer segmentId="explicit">明确的公开答复</baiqiu-answer>', "thought", { visibility: "public" }),
    update("普通回答")
  ]) {
    const parsed = stream.consume(item);
    parts.push(parsed);
    events.push(...mapper.consume(item, parsed));
  }
  parts.push(stream.flush());
  assert.equal(outputText(parts), "明确的公开答复普通回答");
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "真实阶段结果");
});

test("provider reasoning content types use the same isolated channel", () => {
  for (const type of ["thinking", "reasoning", "reasoning_content"]) {
    const stream = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    const parts = [stream.consume(update(progress("action", "开始读取"))),
      stream.consume({ sessionUpdate: "agent_message_chunk", content: { type, text: "INTERNAL_CHANNEL_MARKER" } }),
      stream.consume(update("数据已读取。")), stream.flush()];
    assert.equal(outputText(parts), "数据已读取。");
  }
});

test("unlabelled explicit answers retain distinct identities across channels", () => {
  const stream = new HmsUpdateStreamDemux({ segmentPrefix: "turn:" });
  const first = stream.consume(update('<baiqiu-answer>公开答复一</baiqiu-answer>', "thought", { visibility: "public" }));
  const second = stream.consume(update('<baiqiu-answer>公开答复二</baiqiu-answer>'));
  assert.notEqual(first.answerDeltas[0].segmentId, second.answerDeltas[0].segmentId);
  assert.equal(outputText([first, second]), "公开答复一公开答复二");
});

test("live parsing and saved replay retain interleaved tools, code, results and public answers", () => {
  const stream = new HmsUpdateStreamDemux({ requireFinalEnvelope: false, segmentPrefix: "turn:" });
  const mapper = new HmsProgressMapper({ segmentPrefix: "turn:" });
  const parts = [];
  const liveTools = [];
  const structured = [];
  const updates = [];
  for (const stage of [1, 2]) {
    updates.push(update(progress("action", `读取文件${stage}`, `stage-${stage}`)),
      { sessionUpdate: "tool_call", toolCallId: `tool-${stage}`, title: "terminal", status: "in_progress", rawInput: { command: `python file${stage}.py` } },
      { sessionUpdate: "tool_call_update", toolCallId: `tool-${stage}`, status: "completed", rawOutput: { stdout: `value-${stage}`, exit_code: 0 } },
      update("INTERNAL_CHANNEL_MARKER", "thought"),
      update(progress("stage_result", `真实阶段结果${stage}`, `stage-${stage}`)
        + `<baiqiu-answer segmentId="stage-${stage}">答复${stage}\n\n\`\`\`python\nprint(${stage})\n\`\`\`</baiqiu-answer>`));
  }
  for (const item of updates) {
    const parsed = /agent_/.test(item.sessionUpdate) ? stream.consume(item) : null;
    if (parsed) parts.push(parsed);
    for (const event of mapper.consume(item, parsed)) {
      if (event.kind === "tool") liveTools.push(event);
      else if (event.semanticType === "stage_result") structured.push(event);
    }
  }
  parts.push(stream.flush());
  const savedTools = buildExecutionLog(updates, { runId: "turn" });
  assert.deepEqual(savedTools.map(event => event.type), ["tool_call", "tool_result", "tool_call", "tool_result"]);
  assert.deepEqual(savedTools.map(event => [event.type, event.message, event.inputPreview, event.resultPreview]),
    liveTools.map(event => [event.type, event.message, event.inputPreview, event.resultPreview]));
  assert.match(JSON.stringify(savedTools), /python file1\.py/);
  assert.match(JSON.stringify(savedTools), /value-2/);
  const answers = new Map();
  for (const answer of parts.flatMap(part => part.answerDeltas)) answers.set(answer.segmentId, (answers.get(answer.segmentId) || "") + answer.delta);
  const message = { raw: { executionLog: savedTools, productResult: {
    structuredEvents: structured.map((event, index) => ({ ...event, eventId: `stage-${index}`, target: "structured" })),
    answerSegments: [...answers].map(([segmentId, text], index) => ({ segmentId, text, eventId: `answer-${index}` }))
  } } };
  const restored = replay.replaySegmentModel(JSON.parse(JSON.stringify(message)));
  assert.equal(restored.orderedSegments.length, 2);
  assert.equal(restored.structuredEvents.length, 2);
  assert.equal(restored.processDetails.length, 4);
  assert.equal(restored.orderedSegments.map(segment => segment.text).join(""), outputText(parts));
  assert.match(outputText(parts), /```python\nprint\(1\)\n```/);
  assert.doesNotMatch(JSON.stringify(message), /INTERNAL_CHANNEL_MARKER/);
});

test("standalone history reconstruction isolates partial envelopes and resets at prompt boundaries", () => {
  const mapper = new HmsProgressMapper();
  mapper.consume(update('<baiqiu-progress>{"type":"action",'));
  assert.deepEqual(mapper.consume(update('"message":"wrong"}</baiqiu-progress>', "thought")), []);
  const events = mapper.consume(update('"message":"真实动作","segmentId":"first"}</baiqiu-progress>'));
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "真实动作");
  mapper.consume(update("<baiqiu-progress>", "thought"));
  mapper.consume({ sessionUpdate: "prompt_boundary" });
  assert.deepEqual(mapper.consume(update('{"type":"action","message":"wrong"}</baiqiu-progress>', "thought")), []);
  assert.deepEqual(mapper.flush(), []);
});

test("both native main-process lanes consume channel-bearing updates", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.equal((main.match(/const visibleStream = new HmsUpdateStreamDemux\(/g) || []).length, 2);
  assert.equal((main.match(/visibleStream\.consume\(update\)/g) || []).length, 2);
  assert.doesNotMatch(main, /visibleStream\.consume\(hmsProgressContentText\(update\)\)/);
});
