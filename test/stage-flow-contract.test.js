"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { load } = require("cheerio");
const eventAggregator = require("../renderer-v2/event-aggregator");
const persistedReplay = require("../renderer-v2/persisted-replay");
const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2/app.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2/styles.css"), "utf8");

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

const { executionThreeRowViewModel, completedExecutionHeaderText } = new Function(
  between("function executionThreeRowViewModel", "function paintExecutionPhaseResult")
  + "; return { executionThreeRowViewModel, completedExecutionHeaderText };"
)();
const { executionSummaryEntry, uniqueExecutionActivityEntries } = new Function(
  between("function activityDetailText", "function mergeExecutionNarrativeEntries")
  + "; return { executionSummaryEntry, uniqueExecutionActivityEntries };"
)();
const liveTurnEventFingerprint = new Function(
  between("function liveTurnEventFingerprint", "function reportLiveTurnProtocolError")
  + "; return liveTurnEventFingerprint;"
)();
const mergeSnapshot = new Function("persistedReplay", "liveTurnEventFingerprint",
  between("function mergeSessionSnapshotMessage", "function mergeSessionChangedDb")
  + "; return mergeSessionSnapshotMessage;"
)(persistedReplay, liveTurnEventFingerprint);

function event(eventId, sequence, semanticType, stageId = "", extra = {}) {
  return {
    turnId: "turn-1", eventId, sourceEventId: "source:" + eventId, sequence,
    semanticType, stageId, target: semanticType === "tool" ? "execution" : "structured",
    provenance: semanticType === "tool" ? "blackball_tool" : "blackball_public",
    message: eventId, ...extra
  };
}

function phasesFor(events) {
  return executionThreeRowViewModel(eventAggregator.aggregateExecutionEvents(events, { turnId: "turn-1" }));
}

function stageDom(paintResult = (_root, node, result) => { node.textContent = result.text; }) {
  const dom = load('<main class="streaming-activity"><span class="execution-activity-title"></span><div class="execution-stage-summary"></div></main>');
  const wrappers = new WeakMap();
  function wrap(node) {
    if (!node || node.type !== "tag") return null;
    if (wrappers.has(node)) return wrappers.get(node);
    const element = {
      node,
      dataset: {},
      hidden: false,
      get isConnected() { return dom(node).is("main") || dom(node).parents("main").length > 0; },
      get children() { return dom(node).children().toArray().map(wrap); },
      get parentElement() { return wrap(node.parent); },
      get className() { return dom(node).attr("class") || ""; },
      set className(value) { dom(node).attr("class", value); },
      get textContent() { return dom(node).text(); },
      set textContent(value) { dom(node).text(value); },
      set innerHTML(value) { dom(node).html(value); },
      setAttribute(name, value) { dom(node).attr(name, value); },
      closest(selector) { return wrap(dom(node).closest(selector)[0]); },
      querySelector(selector) {
        const match = selector.startsWith(":scope > ")
          ? dom(node).children(selector.slice(9)).first()
          : dom(node).find(selector).first();
        return wrap(match[0]);
      },
      replaceChildren(...children) {
        dom(node).empty();
        for (const child of children) dom(node).append(child.node);
      },
      remove() { dom(node).remove(); }
    };
    wrappers.set(node, element);
    return element;
  }
  const document = { createElement: (tag) => wrap(dom("<" + tag + "></" + tag + ">")[0]) };
  const paint = new Function("document", "uniqueExecutionActivityEntries", "executionViewModelFromDetails",
    "executionThreeRowViewModel", "completedExecutionHeaderText", "paintExecutionPhaseResult", "EXECUTION_ACTIVITY_VISIBLE_LIMIT",
    between("function paintExecutionStageView", "function executionActivityViewportIsAtBottom") + "; return paintExecutionStageView;"
  )(document, uniqueExecutionActivityEntries,
    (events, turnId) => eventAggregator.aggregateExecutionEvents(events, { turnId }),
    executionThreeRowViewModel, completedExecutionHeaderText,
    paintResult, 3);
  const root = wrap(dom("main")[0]);
  root.dataset.activityExpanded = "0";
  return { root, panel: root.querySelector(".execution-stage-summary"), paint };
}

const firstStage = [
  event("a1", 1, "action", "a", { payload: { text: "真实标题" } }),
  event("a2", 2, "thinking", "a"),
  event("a3", 3, "tool", "a", { status: "failed" }),
  event("a4", 4, "tool", "a", { status: "timeout" }),
  event("ra", 5, "stage_result", "a", { status: "failed" })
];
const secondStage = [event("b1", 6, "action", "b"), event("rb", 7, "stage_result", "b")];

test("interleaved stage IDs retain one owner and exact results", () => {
  const phases = phasesFor([
    event("a1", 1, "action", "a"), event("b1", 2, "action", "b"),
    event("a2", 3, "tool", "a"), event("ra", 4, "stage_result", "a"),
    event("b2", 5, "tool", "b"), event("rb", 6, "stage_result", "b")
  ].reverse());
  assert.deepEqual(phases.map((phase) => [phase.stageId, phase.progressEvents.map((item) => item.eventId), phase.resultEvents.map((item) => item.eventId)]), [
    ["a", ["a1", "a2"], ["ra"]], ["b", ["b1", "b2"], ["rb"]]
  ]);
});

test("real replies separate later tools without removing code or returned content", () => {
  for (const semanticType of ["cross", "stage_result"]) {
    for (const stageId of ["", "shared"]) {
      const firstTool = event("tool-1", 1, "tool", stageId, {
        title: "shell", sourceText: "python first.py\nprint('first')", resultPreview: '{"value":1}'
      });
      const firstReply = event("reply-1", 2, semanticType, stageId, {
        afterEventId: "tool-1", message: "第一段真实回复。"
      });
      const nextTool = event("tool-2", 3, "tool", stageId, {
        afterEventId: "reply-1", sourceText: "python second.py", resultPreview: '{"value":2}'
      });
      const toolReturn = event("tool-return", 4, "tool", stageId, {
        afterEventId: "reply-1", message: "第二次工具返回", status: "completed"
      });
      const nextReply = event("reply-2", 5, semanticType, stageId, {
        afterEventId: "tool-return", message: "第二段真实回复。"
      });
      const input = [firstTool, firstReply, nextTool, toolReturn, nextReply];
      const phases = phasesFor(input.slice().reverse());
      assert.equal(phases.length, 2);
      assert.notEqual(phases[0].id, phases[1].id);
      assert.deepEqual(phases.map((phase) => [
        phase.progressEvents.map((item) => item.eventId), phase.resultEvents.map((item) => item.eventId)
      ]), [[["tool-1"], ["reply-1"]], [["tool-2", "tool-return"], ["reply-2"]]]);
      const { root, panel, paint } = stageDom();
      paint(root, input.slice(0, 2), "turn-1");
      const firstNode = panel.children[0];
      paint(root, input.slice(2), "turn-1");
      assert.equal(panel.children[0], firstNode);
      assert.equal(panel.children.length, 2);
      assert.equal(firstNode.querySelector(".execution-phase-event-list").textContent,
        "shell\npython first.py\nprint('first')\n结果：{\"value\":1}");
      assert.equal(firstNode.querySelector(".execution-phase-results").textContent, firstReply.message);
      assert.equal(panel.children[1].querySelector(".execution-phase-event-list").children[0].textContent,
        "python second.py\n结果：{\"value\":2}");
      assert.equal(panel.children[1].querySelector(".execution-phase-results").textContent, nextReply.message);
      const { root: replayRoot, panel: replayPanel, paint: replayPaint } = stageDom();
      replayPaint(replayRoot, input, "turn-1");
      assert.equal(replayPanel.textContent, panel.textContent);
    }
  }
});

test("tools without a real reply stay together and do not generate a reply", () => {
  const phases = phasesFor([event("tool-1", 1, "tool", "shared"), event("tool-2", 2, "tool", "shared")]);
  assert.equal(phases.length, 1);
  assert.deepEqual(phases[0].progressEvents.map((item) => item.eventId), ["tool-1", "tool-2"]);
  assert.deepEqual(phases[0].resultEvents, []);
});

test("explicit anchors resolve across independently numbered streams", () => {
  const phases = phasesFor([
    event("result", 1, "stage_result", "", { afterEventId: "source:tool" }),
    event("tool", 8, "tool")
  ]);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].progressEvents[0].eventId, "tool");
  assert.equal(phases[0].resultEvents[0].eventId, "result");
});

test("unanchored results use real sequence boundaries, never answer text", () => {
  const phases = phasesFor([
    event("action", 1, "action"), event("result", 2, "stage_result"),
    event("next", 3, "action"), event("answer", 4, "answer_delta", "", { target: "answer" }),
    event("final", 5, "final", "", { target: "answer" })
  ]);
  assert.equal(phases.length, 2);
  assert.deepEqual(phases[1].resultEvents, []);
  assert.equal(executionSummaryEntry(event("answer", 1, "answer_delta")), null);
});

test("failure, timeout, empty result, and interruption remain authored statuses", () => {
  for (const status of ["success", "failed", "timeout", "empty", "cancelled", "interrupted"]) {
    const original = event(status, 1, "tool", "a", { message: "", status, payload: { result: null } });
    const normalized = executionSummaryEntry(original, 1);
    assert.equal(normalized.payload, original.payload);
    assert.equal(normalized.sourceEventId, original.sourceEventId);
    assert.equal(phasesFor([normalized])[0].progressEvents[0].status, status);
  }
  assert.equal(executionSummaryEntry(event("no-status", 1, "tool")).status, "");
});

test("normal statuses do not occupy a separate row while exceptions stay visible", () => {
  const normalStatuses = ["", "completed", "success", "succeeded", "done", "running", "in_progress", "pending", "queued"];
  for (const status of [...normalStatuses, "failed", "error", "timeout", "timed_out", "empty", "cancelled", "interrupted", "blocked"]) {
    for (const semanticType of ["tool", "stage_result"]) {
      const { root, panel, paint } = stageDom();
      const original = event("status-event", 1, semanticType, "a", { status });
      paint(root, [original], "turn-1");
      const row = panel.children[0].querySelector(semanticType === "tool" ? ".execution-phase-event" : ".execution-phase-result");
      assert.equal(row.dataset.status, status);
      assert.equal(row.querySelector(".execution-event-status").hidden, normalStatuses.includes(status));
      assert.equal(row.querySelector(".execution-event-text").textContent, original.message);
      assert.equal(root.__executionStageDetails[0].status, status);
    }
  }
  assert.match(styles, /\.execution-event-status\[hidden\]\s*\{\s*display:\s*none;/);
});

test("duplicate deliveries without timestamps remain idempotent", () => {
  const original = event("same", 1, "action");
  const first = executionSummaryEntry(original, 1);
  const second = executionSummaryEntry(original, 9999);
  assert.deepEqual(first, second);
  assert.equal(uniqueExecutionActivityEntries([first, second]).length, 1);
  const changed = { ...original, payload: { text: "changed" } };
  assert.notEqual(liveTurnEventFingerprint(original), liveTurnEventFingerprint(changed));
  assert.equal(eventAggregator.aggregateExecutionEvents([original, changed]).conflicts.length, 1);
});

test("phase DOM keeps all events, results below execution, and one unchanged Cross", () => {
  const { root, panel, paint } = stageDom();
  paint(root, firstStage, "turn-1");
  const first = panel.children[0];
  const list = first.querySelector(".execution-phase-event-list");
  const firstRow = list.children[0];
  assert.equal(list.children.length, 4);
  assert.equal(firstRow.dataset.collapsedHidden, "1");
  assert.equal(list.children[1].dataset.collapsedHidden, "0");
  assert.equal(first.children[0].className, "execution-phase-process");
  assert.equal(first.children[1].className, "execution-phase-results");
  assert.equal(first.children[1].children[0].dataset.eventId, "ra");
  const cross = event("cross", 8, "cross", "b", { message: "真实 Cross 原文" });
  paint(root, [...firstStage, ...secondStage, cross, cross], "turn-1");
  assert.equal(panel.children.length, 2);
  assert.equal(panel.children[0], first);
  assert.equal(list.children[0], firstRow);
  assert.deepEqual(panel.children.flatMap((phase) => [
    phase.querySelector(".execution-phase-event-list").children.map((row) => row.dataset.eventId),
    phase.querySelector(".execution-phase-result").dataset.eventId
  ]), [["a1", "a2", "a3", "a4"], "ra", ["b1"], "rb"]);
  assert.equal(panel.querySelector(".execution-phase-label"), null);
  assert.equal(panel.querySelector(".execution-phase-result-label"), null);
  assert.equal(first.querySelector(".execution-phase-result .execution-event-text").textContent, "ra");
  const crossRows = panel.children.flatMap((phase) => phase.querySelector(".execution-phase-results").children)
    .filter((row) => row.dataset.semanticType === "cross");
  assert.equal(crossRows.length, 1);
  assert.equal(crossRows[0].textContent, cross.message);
  assert.equal(crossRows[0].querySelector(".execution-phase-result-label"), null);
  paint(root, [], "turn-1");
  assert.equal(panel.children.length, 2);
  root.dataset.lifecycle = "completed";
  paint(root, [], "turn-1");
  assert.equal(panel.hidden, true);
  assert.equal(root.querySelector(".execution-activity-title").textContent, "");
  root.dataset.activityExpanded = "1";
  paint(root, [], "turn-1");
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[0], first);
  assert.ok(panel.children.every((phase) => phase.dataset.expanded === "1"));
  assert.equal(root.querySelector(".execution-phase-toggle"), null);
  root.dataset.activityExpanded = "0";
  paint(root, [], "turn-1");
  assert.ok(panel.children.every((phase) => phase.dataset.expanded === "0"));
  assert.equal(list.children[0], firstRow);
});

test("each reply finishes before its process folds and the top toggle can restore it", () => {
  for (const semanticType of ["stage_result", "cross"]) {
    const frames = new Map();
    let nextFrame = 0;
    const paintResult = new Function("requestAnimationFrame", "cancelAnimationFrame", "performance",
      "assistantTypingCharsPerSecond", "scheduleStreamingScroll", "EXECUTION_ACTIVITY_VISIBLE_LIMIT",
      between("function paintExecutionPhaseResult", "function paintExecutionStageView")
      + "; return paintExecutionPhaseResult;"
    )((callback) => { frames.set(++nextFrame, callback); return nextFrame; },
      (frame) => frames.delete(frame), { now: () => 0 }, () => 10, () => {}, 3);
    const advance = (now) => {
      for (const [frame, callback] of [...frames]) {
        frames.delete(frame);
        callback(now);
      }
    };
    const { root, panel, paint } = stageDom(paintResult);
    const tool = event("tool", 1, "tool", "a", { sourceText: "print('code')", resultPreview: "123" });
    const reply = event("reply", 2, semanticType, "a", { message: "这是完整的真实阶段回复正文。" });
    paint(root, [tool], "turn-1");
    const phase = panel.children[0];
    const process = phase.querySelector(".execution-phase-process");
    const toolNode = process.querySelector(".execution-phase-event");
    assert.equal(process.hidden, false);
    paint(root, [reply], "turn-1");
    advance(100);
    assert.equal(process.hidden, false);
    assert.notEqual(phase.querySelector(".execution-phase-results").textContent, reply.message);
    paint(root, [event("next-tool", 3, "tool", "b")], "turn-1");
    advance(10000);
    assert.equal(process.hidden, true);
    assert.equal(phase.querySelector(".execution-phase-results").hidden, false);
    assert.equal(phase.querySelector(".execution-phase-results").textContent, reply.message);
    assert.equal(toolNode.querySelector(".execution-event-text").textContent, "print('code')\n结果：123");
    assert.equal(panel.children[1].querySelector(".execution-phase-process").hidden, false);
    root.dataset.activityExpanded = "1";
    paint(root, [], "turn-1");
    assert.equal(process.hidden, false);
    assert.equal(process.querySelector(".execution-phase-event"), toolNode);
    root.dataset.activityExpanded = "0";
    paint(root, [], "turn-1");
    assert.equal(process.hidden, true);
    paint(root, [event("next-reply", 4, semanticType, "b", { message: "下一段真实回复正文。" })], "turn-1");
    assert.equal(panel.children[1].querySelector(".execution-phase-process").hidden, false);
    advance(20000);
    assert.equal(panel.children[1].querySelector(".execution-phase-process").hidden, true);
    assert.equal(phase.querySelector(".execution-phase-results").textContent, reply.message);
    assert.equal(root.__executionStageDetails.find((item) => item.eventId === tool.eventId).sourceText, tool.sourceText);
  }
});

test("Cross-only phases do not add numbered process or result labels", () => {
  const { root, panel, paint } = stageDom();
  paint(root, [
    ...firstStage,
    event("cross-only", 6, "cross", "", { message: "真实 Cross" }),
    event("b1", 7, "tool", "b"), event("rb", 8, "stage_result", "b")
  ], "turn-1");
  assert.equal(panel.children.length, 3);
  assert.equal(panel.children[1].querySelector(".execution-phase-process").hidden, true);
  assert.equal(panel.children[1].querySelector(".execution-phase-result-label"), null);
  assert.equal(panel.children[2].querySelector(".execution-phase-event").dataset.eventId, "b1");
  assert.equal(panel.children[2].querySelector(".execution-phase-result").dataset.eventId, "rb");
  assert.equal(panel.querySelector(".execution-phase-label"), null);
  assert.equal(panel.querySelector(".execution-phase-result-label"), null);
});

test("process and results use typography and spacing without generated headings or boxes", () => {
  assert.match(styles, /\.execution-stage-summary\s*\{[^}]*gap:\s*20px;/);
  const processStyles = styles.match(/\.execution-phase-process\s*\{[^}]*\}/)?.[0];
  assert.ok(processStyles);
  assert.doesNotMatch(processStyles, /border|background|padding/);
  const painter = between("function paintExecutionStageView", "function executionActivityViewportIsAtBottom");
  assert.doesNotMatch(painter, /execution-phase-label|execution-phase-result-label|stageNumber/);
  assert.match(styles, /\.execution-phase-result\s*\{[^}]*color:\s*var\(--text\);[^}]*font-size:\s*14px;/);
  assert.match(styles, /\.execution-stage-summary-row\s*\{[^}]*color:\s*var\(--muted\);[^}]*font-size:\s*13px;/);
});

test("an empty final phase does not erase the last real action title", () => {
  const phases = phasesFor([...firstStage, event("cross", 8, "cross")]);
  assert.equal(completedExecutionHeaderText(phases), "真实标题");
});

test("old and empty snapshots preserve stage structure, raw payloads, and final answer", () => {
  const current = {
    id: "message", role: "assistant", text: "最终答案", raw: {
      executionLog: [...firstStage, ...secondStage].filter((item) => item.semanticType === "tool"),
      structuredEvents: [...firstStage, ...secondStage].filter((item) => item.semanticType !== "tool")
    }
  };
  const stale = { id: "message", role: "assistant", text: "", raw: { executionLog: [], structuredEvents: [] } };
  const merged = mergeSnapshot(mergeSnapshot(current, stale), current);
  assert.equal(merged.text, current.text);
  const execution = uniqueExecutionActivityEntries(persistedReplay.executionLogFromMessage(merged));
  const phases = phasesFor([...execution, ...persistedReplay.structuredEventsFromMessage(merged)]);
  assert.deepEqual(phases.map((phase) => phase.stageId), ["a", "b"]);
  assert.equal(phases[0].progressEvents.length, 4);
  assert.equal(phases[0].resultEvents[0].text, "ra");
});

test("completed collapse keeps stage DOM and responsive CSS has no fixed content width", () => {
  const collapse = between("function collapseCompletedExecutionActivity", "function streamActivityHtml");
  assert.match(collapse, /currentHead\.replaceWith/);
  assert.doesNotMatch(collapse, /root\.innerHTML\s*=/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.execution-phase-group\[data-expanded="1"\] \.execution-phase-event-window/);
});

test("real final collapses execution without clearing the answer owner", () => {
  const start = source.indexOf('  if (!["error", "cancelled"].includes(frame.type)');
  const end = source.indexOf('  if (frame.type === "start")', start);
  assert.ok(start >= 0 && end > start);
  const final = source.slice(start, end);
  assert.match(final, /acceptedEvent\.semanticType === "final"/);
  assert.match(final, /collapseCompletedExecutionActivity/);
  assert.doesNotMatch(final, /answer_delta|entry\.rendered|entry\.text\s*=/);
});
