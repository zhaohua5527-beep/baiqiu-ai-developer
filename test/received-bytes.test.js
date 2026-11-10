"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const renderer = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const counter = fs.readFileSync(path.join(__dirname, "../renderer-v2/token-usage.js"), "utf8");

function sourceBetween(start, end) {
  const from = renderer.indexOf(start);
  const to = renderer.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return renderer.slice(from, to);
}

function fixture() {
  let now = 10000;
  let timerId = 0;
  let created = 0;
  const timers = new Map();
  const value = { textContent: "", style: {}, isConnected: true };
  const badge = { parentElement: null, setAttribute() {}, querySelector: () => value };
  const row = () => ({
    dataset: {},
    querySelector: () => null,
    insertBefore(node) { node.parentElement = this; }
  });
  const root = { dataset: { lifecycle: "running" }, isConnected: true,
    __executionOperationPanel: { firstElementChild: row(), appendChild(node) { this.firstElementChild = node; } } };
  const context = vm.createContext({
    Date: { now: () => now },
    performance: { now: () => now },
    document: { hidden: false, createElement(tag) { if (tag === "div") return row(); created++; return badge; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    updateExecutionOperationClocks() {}
  });
  vm.runInContext(counter, context);
  vm.runInContext(sourceBetween("function paintExecutionReceivedBytes(", "function paintExecutionCurrentOperations(")
    + sourceBetween("function markLiveStreamTransportActivity(", "function armLiveStreamFirstEventTimeout("), context);
  const paint = bytes => context.paintExecutionReceivedBytes(root, bytes);
  const advance = elapsed => {
    now += elapsed;
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(callback => callback());
  };
  return { context, root, row, badge, value, timers, paint, advance, created: () => created };
}

test("KB counts in one fixed text node and stops at the observed value", () => {
  const view = fixture();
  view.paint(0);
  view.paint(5120);
  const samples = [];
  for (let index = 0; index < 5; index++) {
    view.advance(32);
    samples.push(view.value.textContent);
    view.paint(5120);
  }
  assert.deepEqual(samples, ["1", "2", "3", "4", "5"]);
  assert.equal(view.created(), 1);
  assert.equal(view.root.__receivedBytesBadge, view.badge);
  assert.equal(view.badge.parentElement, view.root.__executionOperationPanel.firstElementChild);
  assert.equal(view.timers.size, 0);
  view.advance(10000);
  assert.equal(view.value.textContent, "5");
  assert.match(view.badge.title, /非 Token/);
});

test("counter survives status row changes without restarting, decreasing or duplicating", () => {
  const view = fixture();
  view.paint(0);
  view.paint(102400);
  view.advance(160);
  const before = Number(view.value.textContent);
  const width = view.value.style.minWidth;
  view.root.__executionOperationPanel.firstElementChild = view.row();
  view.paint(204800);
  view.advance(160);
  assert.ok(Number(view.value.textContent) > before);
  view.paint(1024);
  view.advance(600);
  assert.equal(view.value.textContent, "200");
  assert.equal(view.badge.parentElement, view.root.__executionOperationPanel.firstElementChild);
  assert.equal(view.created(), 1);
  assert.equal(view.value.style.minWidth, width);
  assert.equal(view.timers.size, 0);
});

test("KB remains visible when temporary status rows retire", () => {
  const view = fixture();
  view.paint(5120);
  view.root.__executionOperationPanel.firstElementChild = null;
  view.paint(6144);
  view.advance(600);
  const row = view.root.__executionOperationPanel.firstElementChild;
  assert.equal(row.dataset.metricsOnly, "1");
  assert.equal(view.badge.parentElement, row);
  assert.equal(view.value.textContent, "6");
  assert.equal(view.created(), 1);
});

test("KB label, digits and unit remain compact without a reserved numeric gap", () => {
  const view = fixture();
  view.paint(1024000);
  view.advance(1000);
  assert.equal(view.value.textContent, "1000");
  assert.equal(view.value.style.minWidth, undefined);
  assert.match(view.badge.innerHTML, /已接收<span class="execution-received-value"><\/span>KB/);
});

test("unknown bytes stay absent and fractional KB never overstate actual bytes", () => {
  const view = fixture();
  for (const invalid of [undefined, -1, 1.5, NaN, Infinity, "1024"]) view.paint(invalid);
  assert.equal(view.created(), 0);
  view.paint(1023);
  assert.equal(view.value.textContent, "0");
  view.root.dataset.lifecycle = "completed";
  view.paint(2047);
  assert.equal(view.value.textContent, "1");
  assert.equal(view.timers.size, 0);
});

test("background, detached and reduced-motion counters settle without ongoing timers", () => {
  for (const mode of ["background", "detached", "reduced-motion", "completed"]) {
    const view = fixture();
    view.paint(102400);
    assert.equal(view.timers.size, 1);
    if (mode === "background") view.context.document.hidden = true;
    if (mode === "detached") view.root.isConnected = false;
    if (mode === "reduced-motion") view.context.matchMedia = () => ({ matches: true });
    if (mode === "completed") view.root.dataset.lifecycle = "completed";
    view.paint(102400);
    assert.equal(view.value.textContent, "100");
    assert.equal(view.timers.size, 0);
  }
});

test("received telemetry cannot become meaningful progress or revive stopped turns", () => {
  const view = fixture();
  const entry = { activity: view.root, firstEventReceived: false, lastMeaningfulEventAt: 12 };
  view.context.markLiveStreamTransportActivity(entry, { kind: "response_data", bytesReceived: 2048 });
  assert.equal(entry.receivedBytes, 2048);
  assert.equal(entry.firstEventReceived, false);
  assert.equal(entry.lastMeaningfulEventAt, 12);
  view.context.markLiveStreamTransportActivity(entry, { kind: "response_data", bytesReceived: 1024 });
  assert.equal(entry.receivedBytes, 2048);
  for (const status of ["timedOut", "backendCompleted", "terminalType", "finalized", "finalizing"]) {
    view.context.markLiveStreamTransportActivity({ ...entry, [status]: true },
      { kind: "response_data", bytesReceived: 4096 });
    assert.equal(view.root.__receivedBytes, 2048);
  }
  view.context.markLiveStreamTransportActivity(entry, { kind: "tool_event", bytesReceived: 4096 });
  assert.equal(entry.receivedBytes, 2048);
});

test("transport frames remain session-bound and never enter the answer reducer", () => {
  let accepted = 0;
  const entry = { sessionId: "session" };
  const context = vm.createContext({
    liveChatStreams: new Map([["turn", entry]]),
    handleVoiceConversationStreamFrame() {},
    markLiveStreamTransportActivity() { accepted++; },
    acceptLiveTurnEvent() { throw new Error("telemetry entered semantic event reducer"); }
  });
  vm.runInContext(sourceBetween("function handleChatStreamFrame(", "function removeSessionExecutionIndicator("), context);
  const frame = { type: "transport_activity", kind: "response_data", bytesReceived: 2048,
    sessionId: "session", streamId: "turn" };
  context.handleChatStreamFrame({ ...frame, sessionId: "other" });
  context.handleChatStreamFrame({ ...frame, streamId: "other" });
  assert.equal(accepted, 0);
  context.handleChatStreamFrame(frame);
  assert.equal(accepted, 1);
  entry.terminalType = "done";
  context.handleChatStreamFrame(frame);
  assert.equal(accepted, 1);
});
