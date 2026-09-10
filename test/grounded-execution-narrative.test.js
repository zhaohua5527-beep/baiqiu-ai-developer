"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { HmsProgressMapper } = require("../services/hms-progress");
const {
  canonicalTarget: canonicalPublicEventTarget,
  normalizeSemanticType,
  semanticTypeFromEvent,
  targetForSemanticType
} = require("../services/black-ball-public-event-contract");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function toolEvents(...updates) {
  const mapper = new HmsProgressMapper();
  return updates.map((update) => mapper.consume(update)[0]);
}

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

function executionNarrativeHarness() {
  const source = sourceBetween(
    rendererSource,
    "function activityDetailText",
    "function executionActivityProtocolText"
  );
  return vm.runInNewContext(`
    (() => {
      const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3;
      const EXECUTION_NARRATIVE_LONG_ACTION_MS = 1500;
      const document = {
        createElement() { return { className: "", dataset: {}, textContent: "" }; }
      };
      ${source}
      ${sourceBetween(rendererSource, "function executionActivityRenderedDetails", "function executionActivityViewportIsAtBottom")}
      const render = (details, structuredEvents = [], options = {}) => {
        const panel = {
          hidden: true,
          children: [],
          replaceChildren(...nodes) { this.children = nodes; }
        };
        const root = {
          dataset: { activityExpanded: "0" },
          querySelector(selector) { return selector === ".execution-event-narrative" ? panel : null; }
        };
        const entry = {
          activity: root,
          activityDetails: details,
          structuredEvents,
          startedAt: Number(options.startedAt || Date.now()),
          executionStartedAt: Number(options.executionStartedAt || Date.now()),
          executionNarrativeShown: options.executionNarrativeShown === true,
          finalized: false
        };
        paintLiveExecutionNarrative(entry);
        const evidence = structuredEvidenceToolCallIds(structuredEvents);
        const summaries = mergeExecutionNarrativeEntries(details)
          .filter((item) => !evidence.has(String(item.publicActionId || item.toolCallId || "")));
        return {
          hidden: panel.hidden,
          summaries: summaries.map((item) => item.publicSummary),
          actionIds: summaries.map((item) => item.publicActionId || item.toolCallId || "")
        };
      };
      const completion = (details) => {
        const root = { dataset: { lifecycle: "completed", activityExpanded: "0" } };
        const collapsed = executionActivityRenderedDetails(root, details);
        root.dataset.activityExpanded = "1";
        const expanded = executionActivityRenderedDetails(root, details);
        const summaries = completedExecutionNarrativeEntries(details);
        return {
          collapsedCount: collapsed.length,
          expandedCount: expanded.length,
          summaries: summaries.map((item) => item.publicSummary),
          summaryActionIds: summaries.map((item) => item.publicActionId || item.toolCallId || ""),
          rawTexts: expanded.map((item) => item.text),
          rawActionIds: expanded.map((item) => item.publicActionId || item.toolCallId || "")
        };
      };
      return { completedExecutionNarrativeEntries, mergeExecutionNarrativeEntries, structuredEvidenceToolCallIds, executionNarrativeMustStayVisible, render, completion };
    })()
  `);
}

function publicProgressHarness() {
  const source = sourceBetween(mainSource, "function isBlackBallPublicProgress", "function emitBlackBallRunStarted");
  return vm.runInNewContext(`
    (() => {
      const chatStreamProgressSequences = new Map();
      const safeActivitySnippet = (value, maxLength) => String(value || "").slice(0, maxLength);
      const safeReasoningDelta = (value) => String(value || "");
      ${source}
      return publicChatProgress;
    })()
  `, { canonicalPublicEventTarget, normalizeSemanticType, semanticTypeFromEvent, targetForSemanticType });
}

function transportToolEvents(streamId, events) {
  const publicChatProgress = publicProgressHarness();
  return events.map((progress) => publicChatProgress(streamId, { type: "phase", progress }));
}

test("tool events carry deterministic public summaries without exposing commands", () => {
  const [started, completed] = toolEvents(
    {
      sessionUpdate: "tool_call",
      toolCallId: "git-check-1",
      title: "terminal",
      rawInput: { command: "git rev-parse --show-toplevel" }
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "git-check-1",
      status: "completed",
      rawOutput: { success: true }
    }
  );

  assert.equal(started.publicActionId, "git-check-1");
  assert.equal(started.publicSummaryKind, "action");
  assert.match(started.publicSummary, /^正在执行/);
  assert.doesNotMatch(started.publicSummary, /rev-parse|--show-toplevel/);
  assert.equal(completed.publicActionId, "git-check-1");
  assert.equal(completed.publicSummaryKind, "result");
  assert.match(completed.publicSummary, /已完成$/);
});

test("writes, verification, failures and retries are marked as visible facts", () => {
  const [written] = toolEvents({
    sessionUpdate: "tool_call_update",
    toolCallId: "write-1",
    title: "write_file",
    status: "completed",
    rawInput: { path: "C:\\workspace\\report.md" },
    rawOutput: { success: true }
  });
  assert.equal(written.publicSummaryKind, "write");
  assert.equal(written.publicSummarySalient, true);
  assert.match(written.publicSummary, /report\.md/);

  const [verified] = toolEvents({
    sessionUpdate: "tool_call_update",
    toolCallId: "test-1",
    title: "terminal",
    status: "completed",
    rawInput: { command: "node --test test/example.test.js" },
    rawOutput: { success: true, passed: 20, failed: 0 }
  });
  assert.equal(verified.publicSummaryKind, "verification");
  assert.equal(verified.publicSummarySalient, true);
  assert.match(verified.publicSummary, /20 项通过/);

  const [failed] = toolEvents({
    sessionUpdate: "tool_call_update",
    toolCallId: "read-1",
    title: "read_file",
    status: "failed",
    error: "ENOENT: file not found"
  });
  assert.equal(failed.publicSummaryKind, "failure");
  assert.equal(failed.publicSummarySalient, true);
  assert.match(failed.publicSummary, /未完成.*ENOENT/);
  assert.doesNotMatch(failed.publicSummary, /已完成/);

  const [retry] = toolEvents({
    sessionUpdate: "tool_call_update",
    toolCallId: "read-1",
    title: "read_file",
    status: "retrying",
    retryCount: 1
  });
  assert.equal(retry.publicSummaryKind, "retry");
  assert.equal(retry.publicSummarySalient, true);
  assert.match(retry.publicSummary, /重试/);
});

test("the transport preserves only producer-owned public narrative metadata", () => {
  assert.match(mainSource, /publicSummary: safeActivitySnippet\(supplied\.publicSummary \|\| "", 240\)/);
  assert.match(mainSource, /publicSummaryKind: safeActivitySnippet\(supplied\.publicSummaryKind \|\| "", 32\)/);
  assert.match(mainSource, /publicActionId: String\(supplied\.publicActionId \|\| ""\)/);
  assert.match(mainSource, /publicSummarySalient: supplied\.publicSummarySalient === true/);
});

test("the renderer merges one action, reveals complex work, and keeps raw details separate", () => {
  assert.match(rendererSource, /function mergeExecutionNarrativeEntries\(/);
  assert.match(rendererSource, /entry\.publicActionId \|\| entry\.toolCallId/);
  assert.match(rendererSource, /existingIndex >= 0[\s\S]*?merged\[existingIndex\] = entry/);
  assert.match(rendererSource, /function executionNarrativeMustStayVisible\(/);
  assert.match(rendererSource, /actionIds\.size >= 2/);
  assert.match(rendererSource, /publicSummarySalient/);
  assert.match(rendererSource, /EXECUTION_NARRATIVE_LONG_ACTION_MS/);
  assert.match(rendererSource, /execution-event-narrative/);
  assert.match(rendererSource, /structuredEvidenceToolCallIds/);
  assert.match(rendererSource, /activityDetailDisplayText\(entry\)/);
  assert.match(rendererSource, /root\?\.dataset\?\.lifecycle === "completed"[\s\S]*?return \[\]/);
});

test("one action advances in place while two real actions trigger the narrative", () => {
  const { mergeExecutionNarrativeEntries, executionNarrativeMustStayVisible } = executionNarrativeHarness();
  const started = {
    eventId: "event-1",
    publicActionId: "tool-1",
    publicSummary: "正在读取文件",
    message: "read_file started",
    publicSummaryKind: "action",
    status: "running",
    sequence: 1,
    timestamp: 1
  };
  const completed = {
    ...started,
    eventId: "event-2",
    publicSummary: "已读取文件",
    message: "read_file completed",
    publicSummaryKind: "result",
    status: "completed",
    sequence: 2,
    timestamp: 2
  };
  const second = {
    eventId: "event-3",
    publicActionId: "tool-2",
    publicSummary: "正在检查结果",
    message: "check started",
    publicSummaryKind: "action",
    status: "running",
    sequence: 3,
    timestamp: 3
  };

  const one = mergeExecutionNarrativeEntries([started, completed]);
  assert.equal(one.length, 1);
  assert.equal(one[0].publicSummary, "已读取文件");
  assert.equal(executionNarrativeMustStayVisible({ startedAt: Date.now() }, one), false);

  const two = mergeExecutionNarrativeEntries([started, completed, second]);
  assert.equal(two.length, 2);
  assert.equal(executionNarrativeMustStayVisible({ startedAt: Date.now() }, two), true);
});

test("structured evidence suppresses only the execution fallback for the same tool", () => {
  const { structuredEvidenceToolCallIds } = executionNarrativeHarness();
  const evidence = structuredEvidenceToolCallIds([
    { evidenceToolCallIds: ["tool-1"] },
    { evidenceToolCallIds: ["tool-1", "tool-2"] }
  ]);
  assert.deepEqual([...evidence], ["tool-1", "tool-2"]);
});

test("mapper to transport to renderer produces two merged user-readable actions", () => {
  const mapper = new HmsProgressMapper();
  const mapped = [
    mapper.consume({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal",
      rawInput: { command: "git rev-parse --show-toplevel" }
    })[0],
    mapper.consume({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { success: true, stdout: "C:\\workspace" }
    })[0],
    mapper.consume({
      sessionUpdate: "tool_call",
      toolCallId: "tool-2",
      title: "read_file",
      rawInput: { path: "C:\\workspace\\package.json" }
    })[0]
  ];
  const transported = transportToolEvents("turn-two-tools", mapped);
  const rendered = executionNarrativeHarness().render(transported);

  assert.equal(rendered.hidden, true);
  assert.deepEqual([...rendered.actionIds], ["tool-1", "tool-2"]);
  assert.deepEqual([...rendered.summaries], ["目录检查已完成", "正在读取“package.json”"]);
  assert.doesNotMatch(rendered.summaries.join(" "), /rev-parse|--show-toplevel|stdout|C:\\workspace/);
  assert.match(transported[1].message, /rev-parse/);
  assert.match(transported[1].resultPreview, /workspace/);
});

test("visibility policy distinguishes quick, complex, salient and long execution", () => {
  const mapper = new HmsProgressMapper();
  const started = mapper.consume({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "read_file",
    rawInput: { path: "C:\\workspace\\one.txt" }
  })[0];
  const completed = mapper.consume({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: { success: true }
  })[0];
  const quick = transportToolEvents("turn-quick", [started, completed]);
  const harness = executionNarrativeHarness();
  assert.equal(harness.render(quick).hidden, true);

  const long = transportToolEvents("turn-long", [started]);
  assert.equal(harness.executionNarrativeMustStayVisible(
    { executionStartedAt: Date.now() - 2000 },
    harness.mergeExecutionNarrativeEntries(long)
  ), true);

  const written = transportToolEvents("turn-write", [new HmsProgressMapper().consume({
    sessionUpdate: "tool_call_update",
    toolCallId: "write-1",
    title: "write_file",
    status: "completed",
    rawInput: { path: "C:\\workspace\\report.md" },
    rawOutput: { success: true }
  })[0]]);
  assert.deepEqual([...harness.render(written).summaries], ["已写入“report.md”"]);
});

test("failure, retry, test and build facts survive the full public path", () => {
  const scenarios = [
    {
      id: "failure",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "failure-1",
        title: "read_file",
        status: "failed",
        error: "ENOENT: file not found"
      },
      expected: /文件读取未完成：.*ENOENT/,
      forbidden: /已完成/
    },
    {
      id: "retry",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "retry-1",
        title: "read_file",
        status: "retrying",
        retryCount: 2
      },
      expected: /第 2 次重试/,
      forbidden: /已完成/
    },
    {
      id: "test",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "test-1",
        title: "terminal",
        status: "completed",
        rawInput: { command: "node --test test/example.test.js" },
        rawOutput: { success: true, passed: 20, failed: 0 }
      },
      expected: /^测试完成：20 项通过$/,
      forbidden: /node --test/
    },
    {
      id: "build",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "build-1",
        title: "terminal",
        status: "completed",
        rawInput: { command: "electron-builder --win --dir" },
        rawOutput: { success: true, outputPath: "E:\\builds\\r20" }
      },
      expected: /^构建完成$/,
      forbidden: /electron-builder|E:\\builds/
    }
  ];
  const harness = executionNarrativeHarness();
  for (const scenario of scenarios) {
    const event = new HmsProgressMapper().consume(scenario.update)[0];
    const transported = transportToolEvents(`turn-${scenario.id}`, [event]);
    const rendered = harness.render(transported);
    assert.equal(rendered.hidden, true, scenario.id);
    assert.equal(rendered.summaries.length, 1, scenario.id);
    assert.match(rendered.summaries[0], scenario.expected, scenario.id);
    assert.doesNotMatch(rendered.summaries[0], scenario.forbidden, scenario.id);
  }
});

test("structured evidence removes only its matching execution fallback", () => {
  const mapper = new HmsProgressMapper();
  const transported = transportToolEvents("turn-evidence", [
    mapper.consume({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "read_file", rawInput: { path: "one.txt" } })[0],
    mapper.consume({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { success: true } })[0],
    mapper.consume({ sessionUpdate: "tool_call", toolCallId: "tool-2", title: "read_file", rawInput: { path: "two.txt" } })[0]
  ]);
  const rendered = executionNarrativeHarness().render(transported, [{
    target: "structured",
    evidenceToolCallIds: ["tool-1"],
    message: "已确认第一个文件可读取"
  }], { executionNarrativeShown: true });

  assert.deepEqual([...rendered.actionIds], ["tool-2"]);
  assert.deepEqual([...rendered.summaries], ["正在读取“two.txt”"]);
});

test("completion collapses the main view and expands merged summaries plus raw facts", () => {
  const mapper = new HmsProgressMapper();
  const transported = transportToolEvents("turn-complete", [
    mapper.consume({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal",
      rawInput: { command: "git rev-parse --show-toplevel" }
    })[0],
    mapper.consume({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { success: true, stdout: "C:\\workspace" }
    })[0]
  ]);
  const completion = executionNarrativeHarness().completion(transported);

  assert.equal(completion.collapsedCount, 0);
  assert.equal(completion.expandedCount, 2);
  assert.deepEqual([...completion.summaries], ["目录检查已完成"]);
  assert.deepEqual([...completion.summaryActionIds], ["tool-1"]);
  assert.deepEqual([...completion.rawActionIds], ["tool-1", "tool-1"]);
  assert.match(completion.rawTexts.join(" "), /rev-parse/);
});

test("lifecycle transport remains absent from the legacy tool-narrative lane", () => {
  const lifecycle = publicProgressHarness()("turn-chat", {
    type: "start",
    progress: {
      source: "hms",
      actor: "黑球",
      provenance: "blackball_runtime",
      kind: "lifecycle",
      type: "execution_start",
      target: "execution_activity",
      message: "黑球已接收本次请求"
    }
  });
  const harness = executionNarrativeHarness();
  assert.equal(harness.render([]).hidden, true);
  assert.equal(harness.render([lifecycle]).hidden, true);
  assert.deepEqual([...harness.render([lifecycle]).summaries], []);
});

test("ordinary chat and connection lifecycle do not manufacture action narration", () => {
  assert.match(mainSource, /Answer directly without baiqiu-progress or process blocks/);
  assert.match(rendererSource, /if \(!String\(entry\?\.publicSummary \|\| ""\)\.trim\(\)\) continue/);
  assert.doesNotMatch(mainSource, /model_request_dispatched[\s\S]{0,500}publicSummary/);
});
