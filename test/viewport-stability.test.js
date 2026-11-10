"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

function scrollFixture(positions = {}, pinned = false) {
  let stored = JSON.stringify(positions);
  let documentTop = 150;
  let anchorAvailable = true;
  const cancelled = [];
  const anchorCalls = [];
  const state = { selectedSessionId: "first", lastRenderedSessionId: "first",
    messageWindowOffsets: new Map(), instructionAnchors: new Map() };
  const messageList = { scrollTop: 20, scrollHeight: 2500, clientHeight: 500,
    style: { scrollBehavior: "smooth" }, getBoundingClientRect: () => ({ top: 0 }) };
  const row = { dataset: { messageId: "reply" }, getBoundingClientRect: () => ({
    top: documentTop - messageList.scrollTop, bottom: documentTop + 2100 - messageList.scrollTop
  }) };
  messageList.querySelectorAll = () => anchorAvailable ? [row] : [];
  messageList.querySelector = () => anchorAvailable ? row : null;
  if (pinned) state.instructionAnchors.set("first", { messageId: "instruction", locked: true, targetOffset: 0 });
  const context = vm.createContext({ state, messageList, SESSION_SCROLL_KEY: "positions",
    localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    CSS: { escape: value => value }, sessionScrollRestoreFrame: 41,
    cancelAnimationFrame: frame => cancelled.push(frame),
    requestAnimationFrame() { throw new Error("Restoration must finish before painting, not schedule another frame"); },
    scheduleReadingControlsUpdate() {}, messageRowForId: () => pinned ? row : null,
    ensureInstructionAnchorSpace() {},
    applyInstructionAnchor(_sessionId, options) {
      anchorCalls.push(options.reposition);
      if (options.reposition) messageList.scrollTop = documentTop;
    }
  });
  vm.runInContext(between("function readSessionScrollPositions(", "function rememberPendingUserMessage("), context);
  return { context, state, messageList, cancelled, anchorCalls,
    saved: () => JSON.parse(stored),
    moveAnchor: offset => { documentTop += offset; },
    removeAnchor: () => { anchorAvailable = false; } };
}

test("each conversation restores its saved offset instead of repinning the old instruction", () => {
  const view = scrollFixture({}, true);
  view.messageList.scrollTop = 430;
  view.state.messageWindowOffsets.set("first", 60);
  view.context.saveSessionScrollPosition("first");
  view.state.selectedSessionId = view.state.lastRenderedSessionId = "second";
  view.messageList.scrollTop = 850;
  view.context.saveSessionScrollPosition("second");
  view.state.selectedSessionId = view.state.lastRenderedSessionId = "first";
  view.messageList.scrollTop = 0;
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, 430);
  assert.equal(view.saved().first.windowOffset, 60);
  assert.equal(view.saved().second.scrollTop, 850);
  assert.equal(view.state.instructionAnchors.get("first").locked, false);
  assert.deepEqual(view.anchorCalls, [false]);
  assert.equal(view.state.followOutput, false);
  assert.deepEqual(view.cancelled, [41]);
  assert.equal(view.messageList.style.scrollBehavior, "smooth");
});

test("a rebuilt message restores its anchor offset and a missing anchor falls back to scrollTop", () => {
  const view = scrollFixture({ first: { scrollTop: 430, anchorId: "reply", anchorOffset: -280 } });
  view.moveAnchor(90);
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, 520);
  view.removeAnchor();
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, 430);
});

test("a stale restore cannot scroll the selected conversation", () => {
  const view = scrollFixture({ first: { scrollTop: 430 } });
  view.state.selectedSessionId = "second";
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, 20);
  assert.deepEqual(view.cancelled, []);
});

test("returning to an old bottom does not follow content added while away", () => {
  const view = scrollFixture({ first: { scrollTop: 1800, atBottom: true, distanceFromBottom: 0 } });
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, 1800);
  assert.equal(view.state.followOutput, false);
  assert.equal(view.state.manualOutputPause, true);
});

test("a first visit without a saved position retains the bottom fallback", () => {
  const view = scrollFixture();
  view.context.restoreSessionScrollPosition("first");
  assert.equal(view.messageList.scrollTop, view.messageList.scrollHeight);
  assert.equal(view.state.followOutput, true);
});

function completionFixture() {
  let title = null;
  let theatre = { remove() { theatre = null; } };
  const elapsed = { textContent: "2s" };
  const face = {};
  const phase = { dataset: { expanded: "1" } };
  const viewport = {};
  const head = { classList: { add() {} },
    querySelector: selector => selector === ".streaming-elapsed" ? elapsed
      : selector === ".execution-activity-title" ? title
        : selector === ".execution-activity-toggle" ? face : theatre,
    insertBefore(node, before) { assert.equal(before, elapsed); title = node; },
    replaceWith() { throw new Error("The existing completion header must survive"); } };
  const root = { dataset: { lifecycle: "running", activityExpanded: "1" }, style: {},
    querySelector: selector => selector === ":scope > .execution-activity-head" ? head : {},
    querySelectorAll: () => [phase], setAttribute() {}, removeAttribute() {},
    replaceChildren() { throw new Error("The existing activity subtree must survive"); } };
  let transactions = 0;
  const context = vm.createContext({ document: { createElement: () => ({ content: {} }) },
    mutatePreservingMessageViewport(mutation) { transactions++; mutation(); },
    stopExecutionActivityFlow() {}, clearTimeout() {},
    uniqueExecutionActivityEntries: entries => [...new Map(entries.map(entry => [entry.eventId, entry])).values()],
    formatTaskDuration: milliseconds => String(milliseconds / 1000) + "s",
    escapeHtml: value => value, executionActivityToggleHtml: () => "",
    executionActivityNodes: () => ({ viewport, rendered: {} }),
    executionActivityRenderedDetails: (_root, history) => history,
    replaceExecutionActivityLines() {},
    paintExecutionStageView(activity, history) { activity.__executionStageDetails = history; },
    paintCompletedExecutionNarrative() {}, bindExecutionActivityToggle() {}, updateExecutionActivityToggle() {},
    BaiqiuTokenUsage: { paint() {} } });
  vm.runInContext(between("function collapseCompletedExecutionActivity(", "function streamActivityHtml("), context);
  return { context, root, head, elapsed, face, phase, transactions: () => transactions };
}

test("retiring a process above a visible paragraph preserves the paragraph coordinate", () => {
  let paragraphTop = 500;
  const messageList = { scrollTop: 400, scrollHeight: 2000, clientHeight: 500,
    style: {}, dataset: {}, getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
  const paragraph = { isConnected: true, getBoundingClientRect: () => ({
    top: paragraphTop - messageList.scrollTop, bottom: paragraphTop - messageList.scrollTop + 40, height: 40
  }) };
  const row = { isConnected: true, querySelectorAll: () => [paragraph],
    getBoundingClientRect: () => ({ top: 100 - messageList.scrollTop, bottom: 1500 - messageList.scrollTop }) };
  messageList.querySelectorAll = () => [row];
  const context = vm.createContext({ messageList, state: { selectedSessionId: "first" },
    messageRowForId: () => null, instructionAnchorId: () => "", instructionAnchorState: () => null,
    messageLayoutTransactionDepth: 0, messageLayoutTransactionEpoch: 0,
    messageLayoutReleaseFrame: 0, instructionAnchorFrame: 0,
    scheduleMessageLayoutTransactionRelease() {} });
  vm.runInContext(between("function messageViewportAnchor(", "function clearSessionTransientState("), context);
  assert.equal(context.messageViewportAnchor(), paragraph);
  context.mutatePreservingMessageViewport(() => { paragraphTop -= 80; });
  assert.equal(messageList.scrollTop, 320);
  assert.equal(paragraph.getBoundingClientRect().top, 100);
  assert.equal(context.messageLayoutTransactionDepth, 0);
});

test("completion reuses the header, face and counter and preserves late expanded history", () => {
  const view = completionFixture();
  const first = { eventId: "first", message: "保留阶段性结果" };
  view.context.collapseCompletedExecutionActivity(view.root, 2000, [first]);
  assert.equal(view.root.dataset.lifecycle, "completed");
  assert.equal(view.root.dataset.activityExpanded, "0");
  view.root.dataset.activityExpanded = "1";
  view.phase.dataset.expanded = "1";
  const late = { eventId: "late", message: "保留补到的真实事件" };
  view.context.collapseCompletedExecutionActivity(view.root, 2000, [late]);
  assert.equal(view.root.querySelector(":scope > .execution-activity-head"), view.head);
  assert.equal(view.head.querySelector(".execution-activity-toggle"), view.face);
  assert.equal(view.head.querySelector(".streaming-elapsed"), view.elapsed);
  assert.equal(view.root.dataset.activityExpanded, "1");
  assert.equal(view.phase.dataset.expanded, "1");
  assert.equal(view.root.__executionActivityDetails.length, 2);
  assert.equal(view.root.__executionActivityDetails[0].message, first.message);
  assert.equal(view.transactions(), 2);
});

test("terminal frames do not collapse before the visible answer drains", () => {
  const handler = between("function handleChatStreamFrame(", "function removeSessionExecutionIndicator(");
  const finalize = between("function finalizeLiveChatStream(", "function releaseLiveChatStreamRow(");
  assert.doesNotMatch(handler, /collapseCompletedExecutionActivity/);
  assert.match(finalize, /entry\.finalizeWhenDrained = applyCompletedRow/);
  assert.match(finalize, /mutatePreservingMessageViewport\(\(\) => \{\s*hideLiveThinkingLayer/);
});
