"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourceRoot = path.join(__dirname, "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-render-test-"));
app.setPath("userData", profile);

async function verifyRenderer() {
  const assert = require("node:assert/strict");
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const root = document.createElement("div");
  root.className = "streaming-activity";
  root.dataset.lifecycle = "running";
  root.dataset.activityExpanded = "0";
  root.innerHTML = '<span class="execution-activity-title"></span><div class="execution-stage-summary"></div>';
  document.body.appendChild(root);
  const events = Array.from({ length: 200 }, (_, index) => ({
    eventId: "event-" + index, turnId: "fixture", sequence: index + 1,
    target: "execution", semanticType: "tool", provenance: "blackball_tool",
    title: "Tool " + index, resultPreview: "测试结果🙂".repeat(80), status: "completed"
  }));
  paintExecutionStageView(root, events, "fixture");
  await nextFrame();
  await nextFrame();
  assert.equal(root.querySelectorAll(".execution-phase-event").length, 200);
  assert.ok(root.querySelectorAll('[data-typing="1"]').length <= 3);
  let first = root.querySelector('[data-event-id="event-0"]');
  const firstText = first.querySelector(".execution-event-text");
  assert.equal(firstText.textContent, "Tool 0\n结果：" + events[0].resultPreview);

  root.dataset.activityExpanded = "1";
  paintExecutionStageView(root, [], "fixture");
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(firstText);
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  const observer = new MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true });
  paintExecutionStageView(root, events, "fixture");
  assert.equal(selection.toString(), selectedText);
  assert.equal(observer.takeRecords().filter(record => record.removedNodes.length).length, 0);

  paintExecutionStageView(root, [{ ...events[0], eventId: "late-earlier", sequence: 0.5 }], "fixture");
  assert.equal(root.querySelectorAll(".execution-phase-event").length, 201);
  first = root.querySelector('[data-event-id="event-0"]');
  assert.equal(root.querySelector(".execution-phase-event").dataset.eventId, "late-earlier");
  await nextFrame();
  await nextFrame();

  const rendered = document.createElement("div");
  const reply = document.createElement("div");
  reply.className = "structured-result-entry";
  reply.dataset.durable = "1";
  reply.dataset.sequence = "250";
  reply.textContent = "阶段性结果：完整保留。";
  rendered.appendChild(reply);
  document.body.appendChild(rendered);
  syncExecutionReplyTimeline(root, rendered);
  const phase = first.closest(".execution-phase-group");
  const timelineOwner = phase.parentElement;
  const timelineObserver = new MutationObserver(() => {});
  timelineObserver.observe(rendered, { subtree: true, childList: true });
  paintExecutionStageView(root, events, "fixture");
  assert.equal(phase.parentElement, timelineOwner);
  assert.equal(timelineObserver.takeRecords().filter(record => record.removedNodes.length).length, 0);

  root.dataset.lifecycle = "interrupted";
  paintExecutionStageView(root, [], "fixture");
  for (const event of events) {
    const text = rendered.querySelector(`[data-event-id="${event.eventId}"] .execution-event-text`);
    assert.equal(text.textContent, `${event.title}\n结果：${event.resultPreview}`);
    assert.notEqual(text.dataset.typing, "1");
    assert.equal(text.__executionResultFrame, null);
  }
  assert.equal(reply.textContent, "阶段性结果：完整保留。");

  chatInput.dispatchEvent(new CompositionEvent("compositionstart"));
  chatInput.value = "wo'o";
  for (let index = 0; index < 6; index++) {
    chatInput.dispatchEvent(new InputEvent("input", { isComposing: true, data: "o" }));
    paintExecutionStageView(root, events, "fixture");
  }
  assert.equal(composerIsComposing, true);
  assert.equal(inputWork, 0);
  assert.equal(chatInput.value, "wo'o");
  chatInput.value = "我正在输入";
  chatInput.dispatchEvent(new CompositionEvent("compositionend", { data: chatInput.value }));
  assert.equal(inputWork, 1);
  assert.equal(composerIsComposing, false);
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.deepEqual(savedDrafts, [["fixture", "我正在输入"]]);
  clearTimeout(state._recommendTimer);
  observer.disconnect();
  timelineObserver.disconnect();
  const live = document.createElement("div");
  live.className = "streaming-activity";
  live.dataset.lifecycle = "running";
  live.dataset.activityExpanded = "0";
  live.innerHTML = '<div class="execution-activity-head"></div><div class="execution-stage-summary"></div>';
  document.body.appendChild(live);
  const startedAt = Date.now() - 18000;
  const call = { eventId: "search-start", turnId: "live", sequence: 1, toolCallId: "search",
    target: "execution", semanticType: "tool", provenance: "blackball_tool", title: "search_files",
    status: "running", publicSummary: "正在搜索 D:/reports，关键词 price", timestamp: startedAt };
  const phaseReply = { eventId: "stage-reply", turnId: "live", sequence: 2, target: "structured",
    semanticType: "stage_result", provenance: "blackball_public", message: "已取得第一份资料。" };
  const command = { ...call, eventId: "command-start", sequence: 3, toolCallId: "command",
    publicSummary: "正在执行：node scan.js", title: "terminal" };
  paintExecutionStageView(live, [call, phaseReply, command], "live");
  assert.equal(live.querySelectorAll(".execution-current-operation").length, 2);
  const runningPhase = [...live.__executionPhaseNodes.values()].find(node => node.dataset.sourceEventIds.includes("search-start"));
  assert.equal(runningPhase.querySelector(".execution-phase-process").hidden, false);
  const processWindow = runningPhase.querySelector(".execution-phase-event-window");
  assert.ok(processWindow.getBoundingClientRect().height <= parseFloat(getComputedStyle(processWindow).lineHeight) * 3 + 1);
  runningPhase.dataset.expanded = "1";
  assert.equal(getComputedStyle(runningPhase.querySelector(".execution-phase-event-window")).maxHeight, "none");
  runningPhase.dataset.expanded = "0";
  updateExecutionOperationClocks(live, startedAt + 18000);
  assert.match(live.__executionOperationPanel.textContent, /距上次更新 18s/);
  const currentObserver = new MutationObserver(() => {});
  currentObserver.observe(live, { subtree: true, childList: true });
  updateExecutionOperationClocks(live, startedAt + 18000);
  assert.equal(currentObserver.takeRecords().length, 0);
  const partial = { ...call, eventId: "search-partial", sequence: 4,
    resultPreview: "D:/reports/price.csv\n第一行\n第二行\n第三行\n第四行\n第五行", timestamp: startedAt + 19000 };
  paintExecutionStageView(live, [partial], "live");
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const scale of [0.85, 1, 1.5, 2]) {
    live.style.setProperty("--chat-font-scale", String(scale));
    for (const width of [260, 800]) {
      live.style.width = width + "px";
      for (const node of live.__executionPhaseNodes.values()) {
        const viewport = node.querySelector(".execution-phase-event-window");
        const style = getComputedStyle(viewport);
        assert.equal(style.overflowY, "hidden");
        assert.ok(viewport.getBoundingClientRect().height <= parseFloat(style.lineHeight) * 3 + 1);
      }
    }
  }
  assert.equal(live.dataset.lifecycle, "running");
  assert.ok(live.__executionStageDetails.some(event => event.eventId === phaseReply.eventId));
  assert.deepEqual([...live.querySelectorAll('.execution-phase-event, .execution-phase-result')].map(node => node.dataset.eventId),
    ["search-start", "command-start", "search-partial"]);
  assert.equal(live.querySelectorAll(".execution-current-operation").length, 2);
  assert.match(live.__executionStageDetails.find(event => event.eventId === partial.eventId).resultPreview, /price.csv/);
  paintExecutionStageView(live, [{ ...call, eventId: "search-end", sequence: 6, status: "completed" }], "live");
  paintExecutionStageView(live, [{ ...call, eventId: "late-search", sequence: 5 }], "live");
  assert.equal(live.querySelectorAll(".execution-current-operation").length, 1);
  assert.match(live.__executionOperationPanel.textContent, /node scan.js/);
  assert.equal(runningPhase.querySelector(".execution-phase-process").hidden, true);
  assert.equal(executionActiveTools([call, { ...call, turnId: "other", sequence: 2, status: "completed" }]).size, 1);
  live.dataset.lifecycle = "interrupted";
  paintExecutionStageView(live, [], "live");
  assert.equal(live.__executionOperationPanel.hidden, true);
  assert.match([...live.__executionPhaseNodes.values()].map(node => node.textContent).join(""), /price.csv/);
  live.dataset.lifecycle = "running";
  paintExecutionStageView(live, [{ ...command, eventId: "command-end", sequence: 7, status: "completed" },
    { eventId: "request", sequence: 8, turnId: "live", kind: "lifecycle", provenance: "blackball_runtime",
      target: "execution", status: "running", message: "模型请求已发出，正在等待接口响应", timestamp: startedAt + 20000 }], "live");
  assert.match(live.__executionOperationPanel.textContent, /等待接口响应/);
  assert.match(live.__executionOperationPanel.textContent, /等待黑球后续事件/);
  live.dataset.lifecycle = "completed";
  paintExecutionStageView(live, [], "live");
  assert.equal(live.__executionOperationPanel.hidden, true);
  currentObserver.disconnect();
  const searches = document.createElement("div");
  searches.className = "streaming-activity";
  searches.dataset.lifecycle = "running";
  searches.innerHTML = '<div class="execution-activity-head"></div><div class="execution-stage-summary"></div>';
  document.body.appendChild(searches);
  const parallel = ["撤销", "中止"].map((pattern, index) => ({
    ...call, eventId: `parallel-${index}`, toolCallId: `parallel-${index}`, sequence: index + 1,
    title: `search: *${pattern}*`, publicSummary: "正在搜索"
  }));
  paintExecutionStageView(searches, parallel, "live");
  assert.deepEqual([...searches.querySelectorAll(".execution-operation-label")].map(node => node.textContent),
    ["search: *撤销*", "search: *中止*"]);
  paintExecutionStageView(searches, [{ ...parallel[1], eventId: "parallel-end", sequence: 3, status: "completed" }], "live");
  assert.deepEqual([...searches.querySelectorAll(".execution-operation-label")].map(node => node.textContent), ["search: *撤销*"]);
  searches.dataset.lifecycle = "completed";
  paintExecutionStageView(searches, [], "live");
  assert.equal(searches.__executionOperationPanel.hidden, true);
  return { checks: 12, events: 201, preserved: true, composition: "passed", activeOperations: "passed" };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  let exitCode = 0;
  try {
    const source = fs.readFileSync(path.join(sourceRoot, "renderer-v2/app.js"), "utf8");
    const between = (start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Missing renderer function: " + start);
      return source.slice(from, to);
    };
    const constants = [...source.matchAll(/^const (ASSISTANT_TYPING_(?:MIN_CHARS_PER_SECOND|MAX_CHARS_PER_SECOND|MAX_SPEED_LENGTH)|EXECUTION_ACTIVITY_VISIBLE_LIMIT|COMPOSER_DRAFT_SAVE_DELAY_MS) = .+;$/gm)]
      .map(match => match[0]).join("\n");
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(sourceRoot, "renderer-v2/styles.css"), "utf8"));
    await window.webContents.executeJavaScript(`
      const eventAggregator = require(${JSON.stringify(path.join(sourceRoot, "renderer-v2/event-aggregator.js"))});
      function scheduleStreamingScroll() {}
      function mutatePreservingMessageViewport(mutation) { mutation(); }
      ${constants}
      ${between("function activityDetailText", "function mergeExecutionNarrativeEntries")}
      ${between("function executionViewModelFromDetails", "function executionActivityViewportIsAtBottom")}
      ${between("function assistantTypingCharsPerSecond", "function startAssistantTyping")}
      const chatInput = document.createElement("textarea");
      document.body.appendChild(chatInput);
      let composerLastInputAt = 0, composerIsComposing = false, composerHeightFrame = 0, draftSaveTimer = 0, inputWork = 0;
      const state = { selectedSessionId: "fixture", pendingSuggestionActions: [] };
      const savedDrafts = [];
      function scheduleComposerHeightAdjust() { inputWork++; }
      function renderSlashCommandMenu() {}
      function saveSessionDraft(...args) { savedDrafts.push(args); }
      function hideRecommendBadge() {}
      function checkAndShowRecommendBadge() {}
      ${between("function handleComposerInput", 'chatInput.addEventListener("focus"')}
    `);
    console.log(JSON.stringify(await window.webContents.executeJavaScript(`(${verifyRenderer.toString()})()`)));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
