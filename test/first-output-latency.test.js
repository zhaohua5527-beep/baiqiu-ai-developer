"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { HermesAcpClient } = require("../services/hermes-acp-client");
const { HmsProgressMapper, buildExecutionLog } = require("../services/hms-progress");

function generationUpdate(eventId = "generation-1") {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
    _meta: { baiqiu_execution: {
      type: "tool_generating", eventId, timestamp: 1788800000000,
      toolName: "terminal", message: "正在生成 terminal 调用参数"
    } }
  };
}

function promptClient(updates) {
  const client = new HermesAcpClient();
  client.ensureSession = async () => ({
    hermesSessionId: "latency-session",
    active: {
      prompt() {},
      async nextUpdate() {
        return updates.length ? { update: updates.shift() } : { kind: "stop", stopReason: "end_turn" };
      }
    }
  });
  client.cancel = async () => true;
  return client;
}

test("native generation keeps its identity in live and replay without inventing execution", () => {
  const update = generationUpdate();
  const live = new HmsProgressMapper().consume(update);
  const replay = buildExecutionLog([{ ...update, receivedAt: update._meta.baiqiu_execution.timestamp + 50 }], { runId: "turn-1" });
  assert.equal(live.length, 1);
  assert.equal(live[0].type, "tool_generating");
  assert.equal(live[0].toolCallId, undefined);
  assert.equal(live[0].resultPreview, undefined);
  for (const key of ["eventId", "timestamp", "message", "type", "semanticType"]) {
    assert.equal(replay[0][key], live[0][key]);
  }
  assert.deepEqual(new HmsProgressMapper().consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } }), []);
  assert.deepEqual(new HmsProgressMapper().consume({ ...update, _meta: {} }), []);
});

test("generation, original command and result retain real event order and payloads", () => {
  const updates = [generationUpdate(), {
    sessionUpdate: "tool_call", toolCallId: "tool-1", title: "terminal", status: "in_progress",
    rawInput: { command: "python -c 'print(42)'" }
  }, {
    sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed",
    rawOutput: { output: "42", exit_code: 0 }
  }];
  const mapper = new HmsProgressMapper();
  const events = updates.flatMap((update) => mapper.consume(update));
  assert.deepEqual(events.map((event) => event.type), ["tool_generating", "tool_call", "tool_result"]);
  assert.match(events[1].sourceText + events[1].inputPreview, /print\(42\)/);
  assert.match(events[2].resultPreview, /42/);
  assert.match(events[2].resultPreview, /exit_code/);
  assert.equal(events.some((event) => ["cross", "cross_check", "stage_result"].includes(event.type)), false);
});

test("metadata neither becomes answer text nor counts as a tool call", async () => {
  const timings = [];
  const result = await promptClient([
    generationUpdate(), generationUpdate("generation-2"),
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "真实答案" } }
  ]).prompt("local-1", "request", { onTiming: (stage) => timings.push(stage), maxToolCalls: 1 });
  assert.equal(result.text, "真实答案");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(timings.filter((stage) => stage === "firstToolGenerationUpdate").length, 1);
  assert.ok(timings.indexOf("firstThoughtTextUpdate") < timings.indexOf("firstMessageTextUpdate"));
  assert.equal(timings.includes("firstToolExecutionUpdate"), false);
});

test("generation cannot reset the tool-without-answer budget", async () => {
  const client = promptClient([
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "read_file", rawInput: { path: "one" } },
    generationUpdate(),
    { sessionUpdate: "tool_call", toolCallId: "tool-2", title: "read_file", rawInput: { path: "two" } }
  ]);
  await assert.rejects(client.prompt("local-1", "request", { maxToolCallsWithoutAnswer: 1 }),
    (error) => error.code === "HERMES_TOOL_LOOP_LIMIT");
});

test("first DOM text timing excludes hidden, empty, detached and repeated paints", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
  const calls = [];
  const context = { reportStartupMetric: (name, meta) => calls.push({ name, meta }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function reportLiveOutputTiming"), source.indexOf('reportStartupMetric("renderer:script-start")')), context);
  const entry = { turnId: "turn-1", sessionId: "session-1", requestStartedAt: Date.now() - 100 };
  const node = { isConnected: false, textContent: "", closest: () => null, getClientRects: () => [] };
  const paint = () => context.reportLiveOutputTiming(entry, "firstProcessDomText", { eventId: "generation-1" }, node);
  paint();
  node.isConnected = true;
  paint();
  node.textContent = "正";
  paint();
  node.getClientRects = () => [{}];
  node.closest = () => ({});
  paint();
  assert.equal(calls.length, 0);
  node.closest = () => null;
  paint();
  paint();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.eventId, "generation-1");
  assert.ok(calls[0].meta.elapsedMs >= 100);
  assert.equal(JSON.stringify(calls).includes("正在"), false);
});
