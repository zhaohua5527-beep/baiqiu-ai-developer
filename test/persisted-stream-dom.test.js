"use strict";

const HARNESS_FLAG = "--persisted-stream-dom-harness";
const RESULT_MARKER = "__PERSISTED_STREAM_DOM_RESULT__";

if (process.argv.includes(HARNESS_FLAG)) {
  void runElectronHarness();
} else {
  registerNodeTests();
}

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`missing source range: ${start}`);
  return source.slice(from, to);
}

function rendererLifecycleSource(source) {
  return [
    sourceBetween(source, "function messageRowForId", "function removeInstructionAnchorSpace"),
    sourceBetween(source, "function ensureLiveSegmentBlock", "function placeLiveActivityBeforeBlock"),
    sourceBetween(source, "function placeLiveActivityBeforeBlock", "function adoptPendingReasoningBlock"),
    sourceBetween(source, "function ensureLiveSegmentCurrentThinking", "function liveAnswerSegmentIsVisible"),
    sourceBetween(source, "function renderSegmentedLiveAnswer", "function revealLiveChatStreamText"),
    sourceBetween(source, "function revealLiveChatStreamText", "function completedActivityHtml"),
    sourceBetween(source, "function executionCurrentThinkingNode", "function hideLiveThinkingLayer"),
    sourceBetween(source, "function appendLiveReasoningDelta", "function setLiveStreamActivity"),
    sourceBetween(source, "function appendLiveFinalAnswerSuffix", "function finalizeLiveChatStream"),
    sourceBetween(source, "function adoptPersistedLiveStreamRow", "function ensureLiveStreamRow"),
    sourceBetween(source, "function ensureLiveStreamRow", "function flushLiveChatStream"),
    sourceBetween(source, "function flushLiveChatStream", "function liveMarkdownBatchInterval"),
    sourceBetween(source, "function handleChatStreamFrame", "function removeSessionExecutionIndicator"),
    sourceBetween(source, "function finalizeLiveChatStream", "function discardLiveChatStreamsForSession"),
    sourceBetween(source, "function discardLiveChatStreamsForSession", "function formatTaskDuration")
  ].join("\n");
}

async function runElectronHarness() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow } = require("electron");
  let window = null;
  try {
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-software-rasterizer");
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      "<!doctype html><html><body><main id=messageList></main></body></html>"
    ));
    const root = path.join(__dirname, "..");
    const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
    const lifecycleSource = rendererLifecycleSource(rendererSource);
    const evaluation = `
      (async () => {
        const messageList = document.getElementById("messageList");
        const state = { selectedSessionId: "session-1", followOutput: false };
        const liveChatStreams = new Map();
        const locallyCompletedSessions = new Set();
        const EXECUTION_ACTIVITY_TRANSITION_MS = 15;
        const PUBLIC_REASONING_MIN_VISIBLE_MS = 40;

        const discardSupersededLiveChatStreams = () => {};
        const removeStaleExecutionRows = () => {};
        const stopExecutionActivityFlow = () => {};
        const executionActivityNodes = (root) => ({ viewport: root?.querySelector?.(".execution-activity-details") || null });
        const clearExecutionActivityDetails = (root) => root?.replaceChildren?.();
        const removeThinkingMessage = (row) => row?.remove?.();
        const removeSessionExecutionIndicator = () => {};
        const streamActivityHtml = () => "<div class=streaming-activity></div>";
        const bindExecutionActivityToggle = () => {};
        const paintExecutionStage = () => {};
        const scrollExecutionActivityToLatest = () => {};
        const ensureExecutionActivityFlow = () => {};
        const scheduleExecutionActivityWhimsy = () => {};
        const filterAssistantExecutionOutput = (value) => String(value || "");
        const blackBallBrandText = (value) => String(value || "");
        const rawBlackBallAnswerText = (value) => String(value || "");
        const hideLiveThinkingLayer = () => {};
        const finishLiveExecutionSurface = () => {};
        const instructionAnchorId = () => "";
        const mutatePreservingMessageViewport = (mutation) => mutation();
        const flushLiveActivityPaint = () => {};
        const renderProgressiveMarkdown = (target, text) => { target.textContent = String(text || ""); };
        const bindRenderedLinks = () => {};
        const classifyRenderedDataLayout = () => {};
        const collapseCompletedExecutionActivity = (activity) => activity;
        const evaluateLongReply = () => {};
        const showFreshComposerSuggestions = () => {};
        const scheduleStreamingScroll = () => {};
        const setLiveStreamStage = () => {};
        const scheduleLiveChatStreamPaint = () => {};
        const liveAnswerSegmentIsVisible = () => true;
        const flushQueuedReasoning = () => {};
        const handleVoiceConversationStreamFrame = () => {};
        const setLiveStreamActivity = () => {};
        const markLiveStreamEventReceived = () => {};
        const filterLiveAssistantDelta = (_entry, delta) => String(delta || "");
        const streamSegmentKey = () => "__default";
        const adoptPendingReasoningBlock = () => null;
        const resetLiveChatStreamReveal = () => {};
        const updateLiveStreamElapsed = () => {};
        const appendLiveStreamNotice = () => {};

        ${lifecycleSource}

        function durableRow(id, text) {
          const row = document.createElement("div");
          row.className = "message assistant";
          row.dataset.messageId = id;
          const bubble = document.createElement("div");
          bubble.className = "bubble";
          const activity = document.createElement("div");
          activity.className = "execution-activity-completed";
          const rendered = document.createElement("div");
          rendered.className = "rendered";
          rendered.textContent = text;
          bubble.append(activity, rendered);
          row.appendChild(bubble);
          messageList.appendChild(row);
          return { row, activity, rendered };
        }

        function adoptableEntry(overrides = {}) {
          return {
            streamId: "run-1",
            sessionId: "session-1",
            responseMessageId: "response-1",
            row: null,
            thinkingRow: null,
            rendered: null,
            activity: null,
            persistedRowAdopted: false,
            backendCompleted: false,
            terminalType: "done",
            timedOut: false,
            text: "final answer",
            streamedAnswerText: "final answer",
            targetText: "final answer",
            targetChars: Array.from("final answer"),
            visibleText: "final",
            visibleChars: Array.from("final"),
            revealedLength: Array.from("final").length,
            segmentOrder: ["answer"],
            segmentCharsById: new Map([["answer", Array.from("final answer")]]),
            segmentBlocks: new Map(),
            segmentNodes: new Map(),
            segmentTargetLengths: new Map(),
            segmentEndLengths: new Map(),
            activeSegmentId: "",
            activityDetails: [],
            startedAt: Date.now() - 20,
            elapsedTimer: null,
            completionTimer: null,
            firstEventTimer: null,
            requestTimeoutTimer: null,
            noProgressTimer: null,
            paintTimer: null,
            paintFrame: null,
            activityPaintFrame: null,
            ...overrides
          };
        }

        const results = {};

        messageList.replaceChildren();
        const phaseRow = document.createElement("div");
        const phaseBubble = document.createElement("div");
        const phaseRendered = document.createElement("div");
        const phaseActivity = document.createElement("div");
        phaseActivity.className = "streaming-activity";
        phaseActivity.textContent = "固定小剧场";
        phaseBubble.append(phaseActivity, phaseRendered);
        phaseRow.appendChild(phaseBubble);
        messageList.appendChild(phaseRow);
        const phaseEntry = {
          row: phaseRow,
          rendered: phaseRendered,
          activity: phaseActivity,
          segmentBlocks: new Map(),
          segmentOrder: [],
          segmentEndLengths: new Map(),
          reasoningSegments: [],
          activeSegmentId: "",
          activityDetails: [{ kind: "tool", message: "真实黑球动作" }],
          activityLabel: { kind: "tool", message: "真实黑球动作" }
        };
        const firstBlock = ensureLiveSegmentBlock(phaseEntry, "1");
        setLiveCurrentThinking(phaseEntry, "真实思考一", { segmentId: "1", blockIndex: 0 });
        const firstThought = firstBlock.currentThinking;
        firstBlock.answer.textContent = "第一段结果";
        retireLiveExecutionPhase(phaseEntry, "1");
        await new Promise((resolve) => setTimeout(resolve, PUBLIC_REASONING_MIN_VISIBLE_MS + 5));
        results.phaseRetireStart = {
          lifecycle: firstThought.dataset.lifecycle,
          answer: firstBlock.answer.textContent,
          answerConnected: firstBlock.answer.isConnected,
          theaterBeforeRendered: phaseActivity.nextElementSibling === phaseRendered
        };
        await new Promise((resolve) => setTimeout(resolve, EXECUTION_ACTIVITY_TRANSITION_MS + 30));
        results.phaseRetireEnd = {
          thoughtConnected: firstThought.isConnected,
          theaterText: phaseActivity.textContent,
          answer: firstBlock.answer.textContent,
          answerConnected: firstBlock.answer.isConnected,
          theaterBeforeRendered: phaseActivity.nextElementSibling === phaseRendered
        };
        const secondBlock = ensureLiveSegmentBlock(phaseEntry, "2");
        setLiveCurrentThinking(phaseEntry, "真实思考二", { segmentId: "2", blockIndex: 1 });
        const secondThought = secondBlock.currentThinking;
        phaseEntry.activityDetails = [{ kind: "tool", message: "第二个真实黑球动作" }];
        showLiveExecutionPhase(phaseEntry, secondBlock);
        results.phaseTwoStart = {
          hidden: phaseActivity.hidden,
          processText: secondThought.textContent,
          theaterBeforeRendered: phaseActivity.nextElementSibling === phaseRendered,
          firstAnswer: firstBlock.answer.textContent
        };
        secondBlock.answer.textContent = "第二段结果";
        retireLiveExecutionPhase(phaseEntry, "2");
        await new Promise((resolve) => setTimeout(resolve, PUBLIC_REASONING_MIN_VISIBLE_MS + EXECUTION_ACTIVITY_TRANSITION_MS + 30));
        results.phaseTwoEnd = {
          thoughtConnected: secondThought.isConnected,
          theaterBeforeRendered: phaseActivity.nextElementSibling === phaseRendered,
          firstAnswer: firstBlock.answer.textContent,
          secondAnswer: secondBlock.answer.textContent,
          answerCount: [firstBlock.answer, secondBlock.answer].filter((node) => node.isConnected).length
        };

        messageList.replaceChildren();
        const mismatch = durableRow("live-response", "已显示的第一段结果");
        mismatch.row.classList.add("streaming-response");
        const mismatchEntry = adoptableEntry({
          streamId: "run-mismatch",
          responseMessageId: "live-response",
          row: mismatch.row,
          rendered: mismatch.rendered,
          activity: mismatch.activity,
          text: "已显示的第一段结果",
          streamedAnswerText: "已显示的第一段结果",
          targetText: "已显示的第一段结果",
          targetChars: Array.from("已显示的第一段结果"),
          visibleText: "已显示的第一段结果",
          visibleChars: Array.from("已显示的第一段结果"),
          revealedLength: Array.from("已显示的第一段结果").length
        });
        liveChatStreams.set(mismatchEntry.streamId, mismatchEntry);
        finalizeLiveChatStream(mismatchEntry.streamId, {
          id: "live-response",
          role: "assistant",
          text: "不兼容的第二份最终答案"
        });
        results.mismatch = {
          text: mismatch.rendered.textContent,
          rowConnected: mismatch.row.isConnected,
          streamReleased: !liveChatStreams.has(mismatchEntry.streamId)
        };

        messageList.replaceChildren();
        const finalized = durableRow("response-1", "final answer");
        const finalizeEntry = adoptableEntry();
        liveChatStreams.set(finalizeEntry.streamId, finalizeEntry);
        adoptPersistedLiveStreamRow(finalizeEntry);
        finalizeLiveChatStream(finalizeEntry.streamId, {
          id: "response-1",
          role: "assistant",
          text: "final answer"
        });
        results.finalize = {
          adopted: finalizeEntry.persistedRowAdopted,
          rowConnected: finalized.row.isConnected,
          segmentCount: finalized.rendered.querySelectorAll(".stream-segment-block").length,
          text: finalized.rendered.textContent
        };

        messageList.replaceChildren();
        const discarded = durableRow("response-1", "durable answer");
        const discardEntry = adoptableEntry({ text: "durable answer", streamedAnswerText: "durable answer" });
        liveChatStreams.set(discardEntry.streamId, discardEntry);
        adoptPersistedLiveStreamRow(discardEntry);
        discardLiveChatStream(discardEntry.streamId);
        results.discardOne = {
          adopted: discardEntry.persistedRowAdopted,
          rowConnected: discarded.row.isConnected,
          streamReleased: !liveChatStreams.has(discardEntry.streamId)
        };

        messageList.replaceChildren();
        const discardedForSession = durableRow("response-1", "durable answer");
        const discardSessionEntry = adoptableEntry({ streamId: "run-session" });
        liveChatStreams.set(discardSessionEntry.streamId, discardSessionEntry);
        adoptPersistedLiveStreamRow(discardSessionEntry);
        discardLiveChatStreamsForSession(discardSessionEntry.sessionId);
        results.discardSession = {
          adopted: discardSessionEntry.persistedRowAdopted,
          rowConnected: discardedForSession.row.isConnected,
          streamReleased: !liveChatStreams.has(discardSessionEntry.streamId)
        };

        messageList.replaceChildren();
        const transientRow = document.createElement("div");
        transientRow.className = "message assistant streaming-response";
        const transientActivity = document.createElement("div");
        transientActivity.className = "streaming-activity";
        transientRow.appendChild(transientActivity);
        messageList.appendChild(transientRow);
        const timed = durableRow("response-1", "persisted answer");
        const timerEntry = adoptableEntry({
          streamId: "run-timer",
          row: transientRow,
          activity: transientActivity,
          text: "",
          streamedAnswerText: "",
          targetText: "",
          targetChars: [],
          visibleText: "",
          visibleChars: [],
          revealedLength: 0,
          terminalType: "",
          backendCompleted: false,
          segmentOrder: []
        });
        liveChatStreams.set(timerEntry.streamId, timerEntry);
        handleChatStreamFrame({
          type: "done",
          streamId: timerEntry.streamId,
          sessionId: timerEntry.sessionId,
          seq: 1
        });
        adoptPersistedLiveStreamRow(timerEntry);
        await new Promise((resolve) => setTimeout(resolve, EXECUTION_ACTIVITY_TRANSITION_MS + 30));
        results.completionTimer = {
          adopted: timerEntry.persistedRowAdopted,
          activityConnected: timed.activity.isConnected,
          rowConnected: timed.row.isConnected
        };

        return results;
      })()
    `;
    const result = await window.webContents.executeJavaScript(evaluation, true);
    const line = `${RESULT_MARKER}${JSON.stringify(result)}\n`;
    process.stdout.write(line, () => app.exit(0));
  } catch (error) {
    const failure = {
      harnessError: String(error?.stack || error?.message || error)
    };
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(failure)}\n`, () => app.exit(1));
  }
}

function registerNodeTests() {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const test = require("node:test");
  const { spawn } = require("node:child_process");
  let probePromise = null;

  function runProbe() {
    if (probePromise) return probePromise;
    probePromise = new Promise((resolve, reject) => {
      const root = path.join(__dirname, "..");
      const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [__filename, HARNESS_FLAG], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron DOM harness timed out.\n${stderr}`));
      }, 20000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
        if (markerIndex < 0) {
          reject(new Error(`Electron DOM harness exited ${code} without a result.\n${stdout}\n${stderr}`));
          return;
        }
        const line = stdout.slice(markerIndex + RESULT_MARKER.length).split(/\r?\n/, 1)[0];
        let result;
        try {
          result = JSON.parse(line);
        } catch (error) {
          reject(new Error(`Invalid Electron DOM harness result: ${line}\n${error.message}`));
          return;
        }
        if (result.harnessError) {
          reject(new Error(result.harnessError));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Electron DOM harness exited ${code}.\n${stderr}`));
          return;
        }
        resolve(result);
      });
    });
    return probePromise;
  }

  test("an adopted durable row finalizes without replaying live segments into its DOM", async () => {
    const result = await runProbe();
    assert.equal(result.finalize.adopted, true);
    assert.equal(result.finalize.rowConnected, true);
    assert.equal(result.finalize.segmentCount, 0);
    assert.equal(result.finalize.text, "final answer");
  });

  test("discarding a stream releases ownership without deleting an adopted durable row", async () => {
    const result = await runProbe();
    assert.deepEqual(result.discardOne, {
      adopted: true,
      rowConnected: true,
      streamReleased: true
    });
    assert.deepEqual(result.discardSession, {
      adopted: true,
      rowConnected: true,
      streamReleased: true
    });
  });

  test("a pre-adoption completion timer cannot remove durable activity", async () => {
    const result = await runProbe();
    assert.deepEqual(result.completionTimer, {
      adopted: true,
      activityConnected: true,
      rowConnected: true
    });
  });

  test("the theater stays fixed while each thought fades and both answer nodes remain", async () => {
    const result = await runProbe();
    assert.deepEqual(result.phaseRetireStart, {
      lifecycle: "exiting",
      answer: "第一段结果",
      answerConnected: true,
      theaterBeforeRendered: true
    });
    assert.deepEqual(result.phaseRetireEnd, {
      thoughtConnected: false,
      theaterText: "固定小剧场",
      answer: "第一段结果",
      answerConnected: true,
      theaterBeforeRendered: true
    });
    assert.deepEqual(result.phaseTwoStart, {
      hidden: false,
      processText: "真实思考二",
      theaterBeforeRendered: true,
      firstAnswer: "第一段结果"
    });
    assert.deepEqual(result.phaseTwoEnd, {
      thoughtConnected: false,
      theaterBeforeRendered: true,
      firstAnswer: "第一段结果",
      secondAnswer: "第二段结果",
      answerCount: 2
    });
  });

  test("a mismatched durable final cannot repaint an answer already shown once", async () => {
    const result = await runProbe();
    assert.deepEqual(result.mismatch, {
      text: "已显示的第一段结果",
      rowConnected: true,
      streamReleased: true
    });
  });
}
