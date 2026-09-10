"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("execution summaries reject answer and final events", () => {
  const helpers = sourceBetween("function activityDetailText", "function executionActivityEntryKey");
  const { executionSummaryEntry } = new Function(`${helpers}; return { executionSummaryEntry };`)();

  assert.equal(executionSummaryEntry({ target: "answer", type: "answer_delta", delta: "最终回答" }), null);
  assert.equal(executionSummaryEntry({ target: "execution_activity", semanticType: "final", message: "最终回答" }), null);
  assert.equal(executionSummaryEntry({ target: "execution_activity", type: "turn_complete", message: "最终回答" }), null);
  assert.equal(executionSummaryEntry({ target: "execution_activity", type: "tool", message: "读取文件" })?.text, "读取文件");
  assert.equal(executionSummaryEntry({ target: "structured", semanticType: "stage_result", message: "阶段完成" })?.text, "阶段完成");
});

test("assistant answer has a result region separate from execution process", () => {
  const addMessage = sourceBetween("function addMessage", "function activityDetailText");
  const liveRow = sourceBetween("function ensureLiveStreamRow", "function flushLiveChatStream");

  assert.match(addMessage, /message\.role === "assistant" \? "rendered result-region" : "rendered"/);
  assert.match(liveRow, /rendered result-region streaming-rendered/);
});

test("execution phases alternate public progress and exact result events", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const event = (sequence, semanticType, extra = {}) => ({
    eventId: `event-${sequence}`,
    sequence,
    turnSequence: sequence,
    semanticType,
    ...extra
  });
  const phases = phasesFor({ events: [
    event(7, "final", { target: "answer", text: "final answer" }),
    event(1, "thinking", { target: "structured", provenance: "blackball_public", message: "Checking the first source" }),
    event(2, "action", { target: "structured", provenance: "blackball_public", message: "Comparing another source" }),
    event(3, "tool", { target: "execution", text: "python command --secret" }),
    event(4, "stage_result", { target: "structured", afterEventId: "event-3", message: "First stage result" }),
    event(5, "thinking", { target: "structured_result", provenance: "blackball_public", message: "Verifying independently" }),
    event(6, "cross", { target: "structured", afterEventId: "event-5", message: "Exact cross message" })
  ] });

  assert.equal(phases.length, 2);
  assert.deepEqual(phases[0].progressEvents.map((item) => item.text), ["Checking the first source", "Comparing another source"]);
  assert.deepEqual(phases[0].resultEvents.map((item) => item.text), ["First stage result"]);
  assert.deepEqual(phases[1].progressEvents.map((item) => item.text), ["Verifying independently"]);
  assert.deepEqual(phases[1].resultEvents.map((item) => item.text), ["Exact cross message"]);
  assert.doesNotMatch(JSON.stringify(phases.flatMap((phase) => phase.progressEvents)), /python command --secret|final answer/);
});

test("running phases exclude lifecycle and retain complete sanitized tool source", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const phases = phasesFor({ events: [
    {
      eventId: "turn:start",
      sequence: 1,
      kind: "lifecycle",
      type: "execution_start",
      target: "execution_activity",
      provenance: "blackball_runtime",
      message: "黑球已接收本次请求"
    },
    {
      eventId: "turn:tool:1",
      sequence: 2,
      semanticType: "tool",
      target: "execution_activity",
      provenance: "blackball_tool",
      publicSummary: "正在读取 package.json",
      sourceText: "python -c \"print('完整命令')\"\nprint('第二行')",
      message: "python -c secret-command",
      inputPreview: "{\"token\":\"secret\"}"
    },
    {
      eventId: "turn:result:1",
      sequence: 3,
      semanticType: "stage_result",
      target: "structured",
      message: "已确认版本信息"
    }
  ] });

  assert.deepEqual(phases[0].progressEvents.map((item) => item.text), [
    "python -c \"print('完整命令')\"\nprint('第二行')"
  ]);
  assert.deepEqual(phases[0].progressEvents.map((item) => item.semanticType), ["tool"]);
  assert.doesNotMatch(JSON.stringify(phases[0].progressEvents), /secret-command|token|正在读取 package\.json/);
});

test("execution phases keep all public rows and tolerate result-only phases", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const publicEvent = (sequence) => ({
    eventId: `public-${sequence}`,
    sequence,
    semanticType: sequence % 2 ? "thinking" : "action",
    target: "structured",
    provenance: "blackball_public",
    message: `Public progress ${sequence}`
  });
  const phases = phasesFor({ events: [
    ...[4, 2, 1, 3].map(publicEvent),
    { eventId: "result", sequence: 5, semanticType: "stage_result", target: "structured", message: "Exact stage result" },
    { eventId: "cross-only", sequence: 6, semanticType: "cross", target: "structured", message: "Cross without invented progress" }
  ] });

  assert.deepEqual(phases[0].progressEvents.map((item) => item.text), [
    "Public progress 1", "Public progress 2", "Public progress 3", "Public progress 4"
  ]);
  assert.deepEqual(phases[0].resultEvents.map((item) => item.text), ["Exact stage result"]);
  assert.deepEqual(phases[1].progressEvents, []);
  assert.deepEqual(phases[1].resultEvents.map((item) => item.text), ["Cross without invented progress"]);
  assert.deepEqual(phasesFor(null), []);
});

test("each real result boundary closes one phase before later public progress", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const publicEvent = (eventId, sequence, semanticType, message) => ({
    eventId,
    sequence,
    semanticType,
    target: "structured",
    provenance: "blackball_public",
    message
  });
  const phases = phasesFor({ events: [
    publicEvent("think-1", 1, "thinking", "Read source one"),
    publicEvent("act-1", 2, "action", "Compare source two"),
    { eventId: "result-1", sequence: 3, semanticType: "stage_result", target: "structured", message: "Current result one" },
    publicEvent("think-2", 4, "thinking", "Check the result"),
    { eventId: "result-2", sequence: 5, semanticType: "cross", target: "structured", message: "Current result two" },
    { eventId: "final", sequence: 6, semanticType: "final", target: "answer", message: "Final answer" }
  ] });

  assert.deepEqual(phases.map((phase) => ({
    process: phase.progressEvents.map((event) => event.text),
    result: phase.resultEvents.map((event) => event.text)
  })), [
    { process: ["Read source one", "Compare source two"], result: ["Current result one"] },
    { process: ["Check the result"], result: ["Current result two"] }
  ]);
});

test("phase-owned events stay out of the legacy main paragraph lane", () => {
  const persisted = sourceBetween("function renderPersistedSegmentPairs", "function snapshotMessageIdentity");
  const live = sourceBetween("function appendLiveStructuredResult", "function isPublicStructuredThought");
  const helpers = sourceBetween("function isCrossStructuredEvent", "function mergeAnswerSegmentLists");
  const { isPrimaryExecutionSummaryEvent } = new Function(`${helpers}; return { isPrimaryExecutionSummaryEvent };`)();

  assert.match(persisted, /filter\(\(event\) => !isPrimaryExecutionSummaryEvent\(event\)\)/);
  assert.match(persisted, /segmentStructuredEvents\.filter\(isStageResultStructuredEvent\)/);
  assert.equal(isPrimaryExecutionSummaryEvent({
    semanticType: "thinking",
    target: "structured",
    provenance: "blackball_public",
    message: "Locating files"
  }), true);
  assert.equal(isPrimaryExecutionSummaryEvent({
    semanticType: "action",
    target: "structured_result",
    provenance: "blackball_public",
    message: "Reading files"
  }), true);
  assert.equal(isPrimaryExecutionSummaryEvent({
    semanticType: "thinking",
    target: "structured",
    message: "Unowned compatibility text"
  }), false);
  assert.equal(isPrimaryExecutionSummaryEvent({
    semanticType: "tool",
    target: "execution",
    provenance: "blackball_public",
    message: "search"
  }), false);
  assert.match(live, /if \(isPrimaryExecutionSummaryEvent\(progress\)\) \{\s*if \(entry\.activity\) entry\.activity\.hidden = false;\s*return null;/);
});

test("the main view uses only the stage tool flow and never duplicates the raw activity lane", () => {
  const liveNarrative = sourceBetween("function paintLiveExecutionNarrative", "function scheduleExecutionNarrativeReveal");
  const liveTemplate = sourceBetween("function streamActivityHtml", "function updateLiveStreamElapsed");

  assert.match(liveNarrative, /panel\.replaceChildren\(\);[\s\S]*panel\.hidden = true;/);
  assert.match(liveTemplate, /executionActivityDetailsHtml\(visibleDetails, \{[^}]*hidden: true/);
  assert.match(styles, /\.message\.assistant \.streaming-activity \.execution-activity-details,[\s\S]*\.message\.assistant \.stream-segment-process\.execution-activity-details,[\s\S]*display:\s*none !important;/);
});

test("the header toggle expands the canonical tool stage flow without revealing a duplicate raw lane", () => {
  const toggle = sourceBetween("function bindExecutionActivityToggle", "function updateExecutionActivityToggle");

  assert.match(toggle, /replaceExecutionActivityLines\(rendered, \[\]\)/);
  assert.match(toggle, /if \(viewport\) viewport\.hidden = true/);
  assert.match(toggle, /paintExecutionStageView\(root, details/);
  assert.doesNotMatch(toggle, /segmentedDetails/);
  assert.match(toggle, /if \(expanded && viewport\) viewport\.scrollTop = 0/);
  assert.doesNotMatch(toggle, /scrollExecutionActivityToLatest\([^\n]*force:\s*true/);
  assert.match(styles, /\.execution-phase-event-window\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(styles, /\.execution-phase-group\[data-expanded="1"\] \.execution-phase-event-window\s*\{[\s\S]*?justify-content:\s*flex-start;/);
  assert.match(styles, /\[data-activity-expanded="1"\] \.execution-activity-details\s*\{[\s\S]*?transform-origin:\s*top;/);
});

test("each phase retains all progress DOM before its own result container", () => {
  const painter = sourceBetween("function paintExecutionStageView", "function executionActivityViewportIsAtBottom");
  assert.match(painter, /const nodes = phases\.map/);
  assert.match(painter, /const rows = phase\.progressEvents\.map/);
  assert.match(painter, /node\.dataset\.collapsedHidden = index < phase\.progressEvents\.length - EXECUTION_ACTIVITY_VISIBLE_LIMIT/);
  assert.match(painter, /list\.replaceChildren\(\.\.\.rows\)/);
  assert.match(painter, /results\.replaceChildren\(\.\.\.phase\.resultEvents\.map/);
  assert.match(painter, /phaseNode\.className = "execution-phase-group"/);
  assert.doesNotMatch(painter, /processEvents\.slice|visibleEvents|execution-flow-group/);
});

test("main preserves complete sanitized tool source and output for the renderer", () => {
  assert.match(mainSource, /sourceText:\s*safeReasoningDelta\(supplied\.sourceText \|\| "", Number\.MAX_SAFE_INTEGER\)/);
  assert.match(mainSource, /inputPreview:\s*safeReasoningDelta\(supplied\.inputPreview \|\| "", Number\.MAX_SAFE_INTEGER\)/);
  assert.match(mainSource, /resultPreview:\s*safeReasoningDelta\(supplied\.resultPreview \|\| "", Number\.MAX_SAFE_INTEGER\)/);
  assert.doesNotMatch(mainSource, /inputPreview:\s*safeActivitySnippet\(supplied\.inputPreview \|\| "", 720\)/);
});

test("tool event state retains source, input, result, and error without renderer truncation", () => {
  const helpers = sourceBetween("function activityDetailText", "function activityIsTransient");
  assert.doesNotMatch(helpers, /return value\.slice/);
  assert.match(helpers, /\[entry\.sourceText, entry\.text, entry\.inputPreview, entry\.resultPreview, entry\.errorPreview\]/);
  assert.match(helpers, /\.join\("\\n"\)/);
});

test("completed header uses only the last real action payload text", () => {
  const helpers = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const { completedExecutionHeaderText } = new Function(`${helpers}; return { completedExecutionHeaderText };`)();

  assert.equal(completedExecutionHeaderText([
    { progressEvents: [{ semanticType: "action", payloadText: "Earlier phase action" }] },
    { progressEvents: [
      { semanticType: "action", payloadText: "Last real action" },
      { semanticType: "thinking", payloadText: "Not a title" }
    ] }
  ]), "Last real action");
  assert.equal(completedExecutionHeaderText([
    { progressEvents: [{ semanticType: "action", text: "message fallback is forbidden", payloadText: "" }] }
  ]), "");
  assert.equal(completedExecutionHeaderText([{ progressEvents: [] }]), "");
  assert.equal(completedExecutionHeaderText([]), "");
});

test("action payload text survives repeated renderer normalization", () => {
  const helpers = sourceBetween("function activityDetailText", "function executionSummaryEntry");
  const { executionActivityEntry } = new Function(`${helpers}; return { executionActivityEntry };`)();
  const first = executionActivityEntry({
    eventId: "action-1",
    semanticType: "action",
    target: "structured",
    provenance: "blackball_public",
    message: "Public action",
    payload: { text: "Real completed header" }
  }, 1);
  const second = executionActivityEntry(first, 1);

  assert.equal(first.payloadText, "Real completed header");
  assert.equal(second.payloadText, "Real completed header");
});

test("running and completed visibility follow the root header toggle", () => {
  const painter = sourceBetween("function paintExecutionStageView", "function executionActivityViewportIsAtBottom");
  const toggle = sourceBetween("function bindExecutionActivityToggle", "function updateExecutionActivityToggle");
  const completedMarkup = sourceBetween("function completedActivityHtml", "function executionCurrentThinkingNode");
  const runningMarkup = sourceBetween("function streamActivityHtml", "function updateLiveStreamElapsed");

  assert.match(painter, /const completedCollapsed = root\.dataset\.lifecycle === "completed"[\s\S]*root\.dataset\.activityExpanded !== "1"/);
  assert.match(painter, /panel\.setAttribute\("aria-hidden", completedCollapsed \? "true" : "false"\)/);
  assert.match(toggle, /stagePanel\.setAttribute\("aria-hidden", root\.dataset\.lifecycle === "completed" && !expanded \? "true" : "false"\)/);
  assert.match(completedMarkup, /data-lifecycle="completed" data-activity-expanded="\$\{expanded \? "1" : "0"\}"/);
  assert.match(completedMarkup, /executionActivityToggleHtml\(history\.length, expanded, \{ alwaysVisible: true \}\)/);
  assert.match(runningMarkup, /data-activity-expanded="0"/);
  assert.match(runningMarkup, /executionActivityToggleHtml\(visibleDetails\.length, false, \{ alwaysVisible: true \}\)/);
  assert.match(styles, /\.execution-activity-completed:not\(\[data-activity-expanded="1"\]\) \.execution-activity-shell\s*\{[\s\S]*?height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.doesNotMatch(styles, /\.streaming-activity:not\(\[data-activity-expanded="1"\]\) \.execution-activity-shell\s*\{[\s\S]*?height:\s*0;/);
});

test("a duration-only completed header keeps its empty toggle interactive", () => {
  const persisted = sourceBetween("function renderPersistedExecutionTimeline", "function executionActivityNodes");

  assert.match(persisted, /root\.__executionActivityDetails = \[\]/);
  assert.match(persisted, /bindExecutionActivityToggle\(root\)/);
  assert.match(persisted, /updateExecutionActivityToggle\(root, 0\)/);
});

test("main-view progress accepts only authoritative public or sanitized execution rows", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const events = [
    { eventId: "think", sequence: 1, semanticType: "thinking", target: "structured", provenance: "blackball_public", message: "Think" },
    { eventId: "tool", sequence: 2, semanticType: "tool", target: "execution", provenance: "blackball_public", message: "Exit code 0 JSON command" },
    { eventId: "action", sequence: 3, semanticType: "action", target: "structured", provenance: "blackball_public", message: "Act", payload: { text: "Action title" } },
    { eventId: "safe-tool", sequence: 3.1, semanticType: "tool", target: "execution", provenance: "blackball_tool", title: "shell", publicSummary: "已读取配置文件", sourceText: "node scripts/check.js\nconsole.log('完整代码')", resultPreview: "检查通过", message: "Exit code 0 JSON command" },
    { eventId: "stage", sequence: 4, semanticType: "stage_result", target: "structured", message: "Stage result" },
    { eventId: "cross", sequence: 5, semanticType: "cross", target: "structured", message: "Cross result" },
    { eventId: "final", sequence: 6, semanticType: "final", target: "answer", message: "Final answer" }
  ];
  const phases = phasesFor({ events });
  const progress = phases.flatMap((phase) => phase.progressEvents);
  const results = phases.flatMap((phase) => phase.resultEvents);

  assert.deepEqual(progress.map((event) => event.semanticType), ["thinking", "action", "tool"]);
  assert.equal(progress.find((event) => event.semanticType === "tool")?.text, "shell\nnode scripts/check.js\nconsole.log('完整代码')\n结果：检查通过");
  assert.equal(progress.find((event) => event.semanticType === "action")?.payloadText, "Action title");
  assert.deepEqual(results.map((event) => event.semanticType), ["stage_result", "cross"]);
  assert.doesNotMatch(JSON.stringify({ progress, results }), /Exit code|JSON command|Final answer|已读取配置文件/);
});

test("live phase results type exact event text while completed results paint immediately", () => {
  const painter = sourceBetween("function paintExecutionPhaseResult", "function paintExecutionStageView");

  assert.match(painter, /const text = String\(result\.text \|\| ""\)/);
  assert.match(painter, /node\.dataset\.typing = "1"/);
  assert.match(painter, /requestAnimationFrame\(paint\)/);
  assert.match(painter, /if \(completed \|\| !text\) \{[\s\S]*node\.textContent = text/);
  assert.doesNotMatch(painter, /result\.message|answer|tool/);
  assert.match(styles, /\.execution-phase-result\[data-typing="1"\]::after\s*\{[\s\S]*content:\s*"\|"/);
});

test("live public progress retains its typewriter and three-event visual limit", () => {
  const painter = sourceBetween("function paintExecutionStageView", "function executionActivityViewportIsAtBottom");
  assert.match(painter, /paintExecutionPhaseResult\(root, textNode, item\)/);
  assert.match(styles, /\.execution-event-text\[data-typing="1"\]::after/);
  assert.match(styles, /\.execution-phase-event-window\[data-overflow="1"\][\s\S]*mask-image:\s*linear-gradient/);
  assert.match(styles, /\.execution-phase-event-window\s*\{[\s\S]*max-height:\s*62px;/);
  assert.match(styles, /\.execution-phase-group:not\(\[data-expanded="1"\]\) \.execution-phase-event\[data-collapsed-hidden="1"\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(painter, /progress\.text\.slice|substring\(|substr\(|getBoundingClientRect/);
  assert.match(sourceBetween("function paintExecutionPhaseResult", "function paintExecutionStageView"), /if \(!node\.closest\(".execution-phase-event"\)\) scheduleStreamingScroll\(\)/);
  assert.doesNotMatch(source, /function replaceExecutionPhaseRows|execution-phase-event-exiting/);
});

test("real knowledge references move into the completed header before elapsed time", () => {
  const helpers = sourceBetween("function createMessageKnowledgeReferences", "function structuredPresentationItems");
  const persisted = sourceBetween("function addMessage", "function activityDetailText");
  const finalized = sourceBetween("function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");

  assert.match(helpers, /knowledgeReferencesFromMessage\(message\)/);
  assert.match(helpers, /label\.textContent = "参考知识"/);
  assert.match(helpers, /head\.insertBefore\(references, elapsed \|\| null\)/);
  assert.match(persisted, /placeKnowledgeReferencesInExecutionHeader\(persistedExecution, knowledgeReferences\)/);
  assert.match(finalized, /placeKnowledgeReferencesInExecutionHeader\(entry\.activity, knowledgeReferences\)/);
  assert.match(styles, /\.execution-activity-head > \.message-knowledge-references\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow:\s*hidden;/);
});

test("one header control expands all execution above corresponding results", () => {
  const painter = sourceBetween("function paintExecutionStageView", "function executionActivityViewportIsAtBottom");
  const toggle = sourceBetween("function bindExecutionActivityToggle", "function updateExecutionActivityToggle");
  assert.match(painter, /execution-phase-process[\s\S]*execution-phase-event-list[\s\S]*execution-phase-results/);
  assert.match(painter, /phaseNode\.dataset\.expanded = root\.dataset\.activityExpanded === "1" \? "1" : "0"/);
  assert.match(toggle, /root\.querySelectorAll\?\.\(".execution-phase-group"\)\.forEach\(\(phase\) => \{\s*phase\.dataset\.expanded = expanded \? "1" : "0"/);
  assert.doesNotMatch(painter + toggle, /execution-phase-toggle|phaseToggle/);
  assert.match(painter, /node\.dataset\.sourceEventId = item\.sourceEventId \|\| item\.eventId/);
  assert.match(painter, /node\.dataset\.semanticType = item\.semanticType/);
  assert.match(painter, /paintExecutionPhaseResult\(root, node, item\)/);
  assert.doesNotMatch(painter, /className = .*execution-cross-summary/);
  assert.match(styles, /\.execution-stage-summary\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*400;/);
  assert.match(styles, /\.execution-phase-process\s*\{[\s\S]*?align-items:\s*start;/);
  assert.match(styles, /\.execution-stage-summary-row\s*\{[\s\S]*?color:\s*var\(--muted\);[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*400;/);
  assert.match(styles, /\.message\.assistant \.rendered\[data-layout="prose"\]\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*400;/);
  assert.match(styles, /\.streaming-activity\s*\{[\s\S]*?gap:\s*0;/);
  assert.doesNotMatch(painter, /交叉核验结论|阶段结果已生成|交叉核验已完成/);
});
