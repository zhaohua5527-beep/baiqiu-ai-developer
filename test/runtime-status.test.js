const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { HermesAcpClient } = require("../services/hermes-acp-client");
const { preserveCommittedOutcome, enforceRuntimeOutcome } = require("../services/runtime-outcome");

const outcome = { sessionId: "runtime", turnId: "turn", status: "completed", stopReason: "end_turn",
  eventId: "run-state:test", sequence: 2, source: "black_ball_runtime", eventCount: 1 };
const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "保留正文" },
  _meta: { baiqiuRunEvent: { turnId: "turn", eventId: "event:1", sequence: 1 } } };

test("supplement sends a native request bound to the original runtime turn", async () => {
  const client = new HermesAcpClient();
  const calls = [];
  client.activePrompts.set("local", { turnId: "turn", hermesSessionId: "runtime" });
  client.connection = { agent: { request: async (method, params) => {
    calls.push({ method, params });
    return { ...params, accepted: true, status: "accepted" };
  } } };
  const receipt = await client.supplement("local", "turn", { supplementId: "one", text: "修改需求" });
  assert.equal(receipt.accepted, true);
  assert.equal(calls[0].method, "_baiqiu/supplement");
  assert.equal(calls[0].params.sessionId, "runtime");
  assert.equal(calls[0].params.turnId, "turn");
  assert.equal((await client.supplement("local", "different", { supplementId: "two", text: "不应发送" })).accepted, false);
  assert.equal(calls.length, 1);
});

test("lost supplement receipt is recovered from native state without a second send", async () => {
  const client = new HermesAcpClient();
  let sends = 0;
  client.activePrompts.set("local", { turnId: "turn", hermesSessionId: "runtime" });
  client.connection = { agent: { request: async () => { sends++; throw new Error("receipt lost"); } } };
  client.queryRunStatus = async () => ({ status: "running", turnId: "turn",
    supplements: { one: { text: "修改需求", status: "applied" } } });
  const receipt = await client.supplement("local", "turn", { supplementId: "one", text: "修改需求" });
  assert.equal(receipt.status, "applied");
  assert.equal(sends, 1);
});

test("uncertain old-turn supplement never targets a replacement turn", async () => {
  const client = new HermesAcpClient();
  client.sessions.set("local", { hermesSessionId: "runtime" });
  client.activePrompts.set("local", { turnId: "replacement", hermesSessionId: "runtime" });
  client.connection = { agent: { request: async () => { throw new Error("must not target replacement"); } } };
  client.readRunStatus = async () => ({ turnId: "turn", status: "unknown" });
  const input = { supplementId: "one", text: "保留补充", reconcileOnly: true };
  assert.equal((await client.supplement("local", "turn", input)).accepted, null);
  client.readRunStatus = async () => ({ turnId: "turn", status: "completed",
    supplements: { one: { text: input.text, status: "applied" } } });
  assert.equal((await client.supplement("local", "turn", input)).status, "applied");
});

function fixture(messages, snapshot) {
  const client = new HermesAcpClient();
  const session = { hermesSessionId: "runtime", active: {
    prompt() {}, dispose() {}, nextUpdate: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(() => {})
  } };
  client.ensureSession = async () => session;
  client.connection = { agent: { request: async () => snapshot, notify() {} } };
  return client;
}

test("lost completion replays missing events once and settles original prompt", async () => {
  const client = fixture([{ update }], { ...outcome, updates: [update] });
  const received = [];
  const pending = client.prompt("local", "hello", { turnId: "turn", onUpdate: value => received.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  const status = await client.queryRunStatus("local", "turn");
  assert.equal(status.status, "completed");
  const result = await pending;
  assert.equal(result.status, "done");
  assert.equal(result.text, "保留正文");
  assert.equal(received.length, 1);
  assert.equal(result.runtimeOutcome.updates, undefined);
});

test("background prompt reconciles without an active renderer", async context => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100000 });
  const client = fixture([], { ...outcome, updates: [update] });
  const pending = client.prompt("local", "hello", { turnId: "turn" });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(15000);
  const result = await pending;
  assert.equal(result.status, "done");
  assert.equal(result.text, "保留正文");
  assert.equal(client.hasActivePrompt("local"), false);
});

test("missing event is recovered before native terminal is committed", async () => {
  const client = fixture([{ kind: "stop", stopReason: "end_turn", response: { _meta: { baiqiuRun: outcome } } }],
    { ...outcome, updates: [update] });
  const result = await client.prompt("local", "hello", { turnId: "turn" });
  assert.equal(result.text, "保留正文");
  assert.equal(result.status, "done");
});

test("runtime incomplete cannot become success just because answer exists", async () => {
  const client = fixture([{ update }, { kind: "stop", stopReason: "end_turn",
    response: { _meta: { baiqiuRun: { ...outcome, status: "incomplete" } } } }]);
  const result = await client.prompt("local", "hello", { turnId: "turn" });
  assert.equal(result.status, "failed");
  assert.equal(result.text, "保留正文");
});

test("unreachable status query leaves execution and manual cancellation intact", async () => {
  const controller = new AbortController();
  const client = fixture([], null);
  const pending = client.prompt("local", "hello", { turnId: "turn", signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await client.queryRunStatus("local", "turn")).status, "unknown");
  assert.equal(client.hasActivePrompt("local"), true);
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  assert.equal((await pending).status, "cancelled");
});

test("late timeout cannot replace committed completion or affect another run", () => {
  const previous = { runId: "turn", runtimeOutcome: outcome, status: "completed", text: "正文" };
  assert.equal(preserveCommittedOutcome(previous, { runId: "turn", status: "timed_out" }), previous);
  const another = { runId: "next", status: "timed_out" };
  assert.equal(preserveCommittedOutcome(previous, another), another);
  assert.throws(() => preserveCommittedOutcome(previous, { runId: "turn",
    runtimeOutcome: { ...outcome, status: "failed" } }), /Conflicting/);
});

test("renderer silence only queries runtime and keeps accepting events", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
  const begin = source.indexOf("async function handleLiveStreamTimeout(");
  const end = source.indexOf("function reasoningSegmentKey", begin);
  const notices = [];
  let queries = 0;
  const context = { Date, api: { queryRunStatus: async () => { queries++; return { status: "running" }; },
    signalAbortChat() { assert.fail("silence cannot abort"); } }, appendLiveStreamNotice: (_, text) => notices.push(text) };
  vm.createContext(context);
  vm.runInContext(source.slice(begin, end), context);
  const entry = { sessionId: "local", streamId: "turn" };
  await context.handleLiveStreamTimeout(entry);
  await context.handleLiveStreamTimeout(entry);
  assert.equal(queries, 1);
  assert.equal(entry.timedOut, undefined);
  assert.equal(notices.length, 1);
});

test("model completion text cannot override native incomplete state", () => {
  assert.equal(enforceRuntimeOutcome({ status: "completed", success: true,
    runtimeOutcome: { ...outcome, status: "incomplete" } }).status, "failed");
});

test("unknown runtime remains unknown through both SDK routes and conversation fallback", async () => {
  const { UIAdapter } = require("../services/product-sdk/ui-adapter");
  const { conversationResultStatus } = require("../services/response-router");
  const { executionOutcomeFromResult } = require("../services/request-run-contract");
  const response = { ok: true, status: "unknown", text: "已生成的阶段结果", executionOutcome: "unknown" };
  let saved;
  const adapter = Object.create(UIAdapter.prototype);
  adapter.sdk = { saveTask: value => { saved = value; } };
  adapter.chatRunner = async () => response;
  const legacy = adapter.completeRuntimeTask({ taskId: "task" }, response);
  const canonical = await adapter.submitCanonicalUIInput({ context: { chatRuntime: true } });
  for (const result of [legacy, canonical]) {
    assert.equal(result.status, "unknown");
    assert.equal(result.success, undefined);
    assert.equal(result.text, response.text);
    assert.equal(executionOutcomeFromResult(result), "unknown");
    assert.equal(conversationResultStatus(result, { hasTask: true }), "unknown");
  }
  assert.equal(saved.status, "unknown");
  assert.equal(saved.error, null);
  assert.equal(canonical.error, null);
  assert.equal(conversationResultStatus({ runtimeOutcome: outcome }, { hasTask: true }), "completed");
});

test("status response for a different turn cannot settle the current prompt", async () => {
  const controller = new AbortController();
  const client = fixture([], { ...outcome, turnId: "other", updates: [update] });
  const pending = client.prompt("local", "hello", { turnId: "turn", signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await client.queryRunStatus("local", "turn")).status, "unknown");
  assert.equal(client.hasActivePrompt("local"), true);
  controller.abort();
  assert.equal((await pending).status, "cancelled");
});

test("connection closure restores a durable terminal without rerunning tools", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-run-state-"));
  try {
    const client = fixture([]);
    client.options.hermesHome = directory;
    const identity = createHash("sha256").update(JSON.stringify(["runtime", "turn"])).digest("hex");
    fs.mkdirSync(path.join(directory, "baiqiu-runs"));
    const { eventCount, ...archived } = outcome;
    fs.writeFileSync(path.join(directory, "baiqiu-runs", identity + ".json"), JSON.stringify({ ...archived, updates: [update] }));
    client.ensureSession = async () => ({ hermesSessionId: "runtime", active: {
      prompt() {}, dispose() {}, nextUpdate: () => Promise.reject(new Error("ACP connection closed"))
    } });
    const result = await client.prompt("local", "test", { turnId: "turn" });
    assert.equal(result.status, "done");
    assert.equal(result.text, "保留正文");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("connection closure without a completion record remains unknown", async () => {
  const client = fixture([]);
  client.ensureSession = async () => ({ hermesSessionId: "missing", active: {
    prompt() {}, nextUpdate: () => Promise.reject(new Error("ACP connection closed"))
  } });
  await assert.rejects(client.prompt("local", "test", { turnId: "missing" }),
    error => error.code === "HERMES_RUN_STATUS_UNKNOWN");
});

test("out of order events are replayed in producer order", async () => {
  const second = { ...update, content: { type: "text", text: "后续" },
    _meta: { baiqiuRunEvent: { turnId: "turn", eventId: "event:2", sequence: 2 } } };
  const client = fixture([{ update: second }], { ...outcome, eventCount: 2, updates: [update, second] });
  const result = await client.prompt("local", "test", { turnId: "turn" });
  assert.equal(result.text, "保留正文后续");
});

test("conflicting duplicate delivery is rejected rather than silently overwritten", async () => {
  const conflict = { ...update, content: { type: "text", text: "不同" } };
  const client = fixture([{ update }, { update: conflict }]);
  await assert.rejects(client.prompt("local", "test", { turnId: "turn" }), /Conflicting/);
});

test("hard deadline respects a committed runtime terminal and cannot cancel a replacement run", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const begin = source.indexOf("function startActiveRunDeadline(");
  const end = source.indexOf("function needsDesktopAction", begin);
  for (const replacement of [false, true]) {
    let callback;
    const controller = new AbortController();
    const activeRuns = new Map();
    const run = { controller, queryRuntimeStatus: async () => {
      if (replacement) activeRuns.set("local", { controller: new AbortController() });
      return { status: replacement ? "running" : "completed" };
    } };
    activeRuns.set("local", run);
    const context = { activeRuns, setTimeout: action => { callback = action; return {}; }, clearTimeout() {},
      ensureTaskBrain() { assert.fail("terminal completion cannot time out"); } };
    vm.createContext(context);
    vm.runInContext(source.slice(begin, end), context);
    context.startActiveRunDeadline({ sessionId: "local", controller, timeoutMs: 1 });
    await callback();
    assert.equal(controller.signal.aborted, false);
    assert.equal(run.timedOut, undefined);
  }
});
