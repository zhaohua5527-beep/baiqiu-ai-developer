"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { aggregateExecutionEvents } = require("../renderer-v2/event-aggregator");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const start = source.indexOf("function executionThreeRowViewModel(");
const end = source.indexOf("function completedExecutionHeaderText(", start);
const toolKey = source.slice(source.indexOf("function executionToolKey("), source.indexOf("function executionActiveTools("));
const project = new Function(toolKey + source.slice(start, end) + "; return executionStageViewPhases;")();
const stages = ["client_prepare", "client_ready", "http_request", "connection_connect_tcp_started",
  "connection_start_tls_started", "http11_send_request_body_complete", "http_headers", "first_byte"];
const connection = (phase, sequence, status = "running") => ({
  turnId: "test-turn", eventId: "test-event-" + sequence, sequence, timestamp: 1000 + sequence * 100,
  kind: "lifecycle", type: "runtime_status", provenance: "blackball_runtime",
  target: "execution_activity", phase, status, message: phase
});
const rows = events => project(aggregateExecutionEvents(events)).flatMap(phase => phase.progressEvents);

test("normal connection hints do not occupy durable execution rows", () => {
  const events = stages.map((phase, index) => connection(phase, index + 1));
  for (let count = 1; count <= events.length; count++) {
    const shown = rows(events.slice(0, count));
    assert.equal(shown.length, 0);
  }
  assert.deepEqual(rows([]), []);
});

test("later normal requests do not repeat; tool code, errors and structured replies remain intact", () => {
  const events = stages.map((phase, index) => connection(phase, index + 1));
  const tool = { turnId: "test-turn", eventId: "tool", sequence: 9, semanticType: "tool",
    target: "execution", provenance: "blackball_tool", sourceText: "terminal: printf 17",
    resultPreview: '{"total_count":0}', status: "completed" };
  events.push(tool, { turnId: "test-turn", eventId: "stage", sequence: 10, semanticType: "stage_result",
    target: "structured", provenance: "blackball_public", message: "第一部分已完成" });
  events.push(...stages.map((phase, index) => connection(phase, index + 11)));
  events.push(connection("http_headers", 19, "failed"), connection("retry", 20, "retrying"),
    connection("reconnect", 21, "running"));
  const before = JSON.stringify(events);
  const view = aggregateExecutionEvents(events);
  const displayed = project(view).flatMap(phase => phase.progressEvents);
  assert.deepEqual(displayed.map(row => row.eventId), ["tool", "test-event-19", "test-event-20", "test-event-21"]);
  assert.equal(displayed[0].text, 'terminal: printf 17\n结果：{"total_count":0}');
  assert.equal(displayed[1].status, "failed");
  assert.equal(view.events.find(event => event.eventId === "stage").message, "第一部分已完成");
  assert.ok(project(view).some(phase => phase.hasStructuredResult));
  assert.deepEqual(project(aggregateExecutionEvents(JSON.parse(before))), project(view));
  assert.equal(view.rawEvents.length, events.length);
  assert.equal(JSON.stringify(events), before);
});

test("partial first requests stop updating on tool output or a new request", () => {
  const first = connection("http_request", 1);
  const tool = { eventId: "tool", sequence: 2, semanticType: "tool", provenance: "blackball_tool",
    target: "execution", sourceText: "client_prepare", status: "running" };
  assert.deepEqual(rows([first, tool, connection("http_headers", 3)]).map(row => row.eventId), ["tool"]);
  assert.deepEqual(rows([first, connection("client_prepare", 2), connection("client_ready", 3)]).map(row => row.eventId), []);
});

test("only known normal runtime connection events are compacted", () => {
  const acceptance = connection("blackball-start", 1);
  const startup = connection("runtime_wait", 2);
  const request = connection("client_prepare", 3);
  const denied = connection("http_headers", 4, "failed");
  const spoof = { ...connection("client_ready", 5), provenance: "blackball_public",
    semanticType: "action", target: "execution" };
  assert.deepEqual(rows([acceptance, startup, request, denied, spoof]).map(row => row.eventId),
    [acceptance, denied, spoof].map(event => event.eventId));
});

test("context preparation stays in raw history but not in the progress timeline", () => {
  const events = [connection("context_prepare", 1), connection("context_ready", 2)];
  const before = JSON.stringify(events);
  assert.deepEqual(rows(events), []);
  assert.equal(aggregateExecutionEvents(events).rawEvents.length, 2);
  assert.equal(JSON.stringify(events), before);
  assert.equal(rows([{ ...events[1], status: "failed" }]).length, 1);
});
