"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { UIAdapter } = require("../services/product-sdk/ui-adapter");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const rendererStyles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");
const rendererHtml = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "index.html"), "utf8");

const presentation = {
  status: "completed",
  summary: "Workbook created",
  facts: [{ label: "12 rows matched" }],
  files: [{ label: "result.xlsx", path: "C:\\result.xlsx" }],
  blockers: [],
  risks: [],
  actions: [{ type: "prompt", label: "Review result", prompt: "Review the generated workbook" }],
  details: "The visible response remains authoritative."
};

test("canonical UI results preserve HMS presentation evidence", async () => {
  const adapter = new UIAdapter({
    conversationalResponder: async () => ({ ok: true, text: "Done", presentation })
  });
  const result = await adapter.submitUIInput({
    canonicalTask: true,
    taskId: "task-presentation",
    message: "Create a workbook"
  });

  assert.deepEqual(result.presentation, presentation);
  assert.deepEqual(result.raw.presentation, presentation);
  assert.equal(result.text, "Done");
});

test("canonical UI results preserve the sanitized HMS execution log", async () => {
  const executionLog = [{ sequence: 1, source: "hms", kind: "thought", status: "running", message: "Check the workbook schema first." }];
  const adapter = new UIAdapter({
    conversationalResponder: async () => ({ ok: true, text: "Done", executionLog })
  });
  const result = await adapter.submitUIInput({
    canonicalTask: true,
    taskId: "task-execution-log",
    message: "Inspect a workbook"
  });

  assert.deepEqual(result.executionLog, executionLog);
  assert.deepEqual(result.raw.executionLog, executionLog);
});

test("SDK-shaped UI results preserve presentation at top level and in raw evidence", () => {
  const adapter = new UIAdapter();
  const result = adapter.toUIResult({
    taskId: "task-sdk-presentation",
    productId: "desktop-assistant",
    status: "success",
    result: { text: "Done", raw: { presentation } }
  });

  assert.deepEqual(result.presentation, presentation);
  assert.deepEqual(result.raw.presentation, presentation);
});

test("HMS presentation is parsed as display semantics and survives message persistence", () => {
  assert.match(mainSource, /function extractHmsPresentationEnvelope\(text = ""\)/);
  assert.match(mainSource, /<baiqiu-presentation>\(\[\\s\\S\]\*\?\)<\\\/baiqiu-presentation>/);
  assert.match(mainSource, /const persistedResult = compactPersistedExecutionPayload\(\{[\s\S]*?\.\.\.result,[\s\S]*?persistedByMain: true/);
  assert.match(mainSource, /productResult: persistedResult/);
});

test("renderer shows only fresh task suggestions without a separate composer button", () => {
  const resultRenderer = rendererSource.slice(
    rendererSource.indexOf("function executablePresentationActions"),
    rendererSource.indexOf("function progressiveSourceUsesWideLayout")
  );

  assert.match(resultRenderer, /function executablePresentationActions/);
  assert.match(resultRenderer, /function presentationSuggestionActions/);
  assert.match(rendererSource, /\["prompt", "reply"\]\.includes\(item\.type\)/);
  assert.match(rendererSource, /function setComposerSuggestionActions/);
  assert.match(rendererSource, /function renderComposerSuggestions/);
  assert.match(rendererSource, /function showFreshComposerSuggestions/);
  assert.match(rendererSource, /suggestionAction:\s*\{/);
  assert.match(rendererSource, /context\.taskAction = \{ taskId, action: option\.action, value \};/);
  assert.match(rendererSource, /context\.recoveryAction = \{ taskId, action: option\.action, value \};/);
  assert.match(rendererSource, /dispatchStructuredCardAction\(option, prompt\)/);
  assert.match(rendererSource, /\^\(\?:待\|等待\|需\|需要\)用户/);
  const addMessage = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );
  assert.match(addMessage, /const suggestionEligible = options\.suggestionEligible === true/);
  assert.match(addMessage, /showFreshComposerSuggestions\(/);
  assert.doesNotMatch(addMessage, /bubble\.appendChild\(presentationActionBar\)|createPresentationActionBar/);
  assert.doesNotMatch(rendererHtml, /id="intentPredictBtn"/);
  assert.match(rendererSource, /suggestionEligible: false/);
  assert.match(rendererSource, /const COMPOSER_SUGGESTION_IDLE_MS = 15000/);
  assert.match(rendererSource, /if \(session\.id === state\.selectedSessionId\) clearComposerSuggestions\(\)/);
  assert.match(rendererSource, /if \(chatInput\.value\.trim\(\)\) pauseComposerSuggestionDismiss\(\)/);
});

test("renderer keeps HMS outcome as hidden state and generated files as supplemental delivery", () => {
  const presentationResolver = rendererSource.slice(
    rendererSource.indexOf("function taskPresentationFromMessage"),
    rendererSource.indexOf("function looksLikeInternalWorklog")
  );
  assert.doesNotMatch(presentationResolver, /hmsOutcome/);
  assert.match(presentationResolver, /requestRun\?\.interactionKind/);
  assert.match(presentationResolver, /=== "chat"\) return null/);
  assert.match(rendererSource, /looksLikeInternalWorklog\(details\) \? "" : details/);
  assert.match(rendererSource, /fileLink\.className = "message-file-link"/);
  assert.match(rendererSource, /fileLink\.addEventListener\("click", \(\) => openAttachmentExternally\(item\)/);
  assert.match(rendererSource, /function structuredPresentationFiles/);
  assert.match(rendererSource, /const deliveredFiles = taskPresentation[\s\S]*?structuredPresentationFiles\(taskPresentation\.files, messageFiles\)/);
  assert.doesNotMatch(rendererSource, /task-result-file-list|task-result-risks/);
  assert.doesNotMatch(
    rendererSource.slice(rendererSource.indexOf("const messageFiles = generatedFilesFromMessage"), rendererSource.indexOf("const actions = document.createElement", rendererSource.indexOf("const messageFiles = generatedFilesFromMessage"))),
    /所在位置|在看板查看|mimeType/
  );
  assert.match(rendererStyles, /\.message-files \{ display: flex; flex-wrap: wrap;/);
  assert.doesNotMatch(rendererStyles, /\.structured-task-result|\.task-result-view/);
  assert.doesNotMatch(rendererStyles, /grid-template-columns: 112px/);
});

test("Black Ball final text is the only visible narrative", () => {
  const addMessageSource = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );
  assert.match(addMessageSource, /rendered\.innerHTML = renderMarkdown\(displayText\);/);
  assert.match(addMessageSource, /bubble\.appendChild\(rendered\);/);
  assert.doesNotMatch(addMessageSource, /supplementalResult|createStructuredTaskResult|presentation\.summary|presentation\.facts|presentation\.risks/);
  assert.match(mainSource, /: result\.text \|\| recoveredText \|\| existing\?\.text/);
  assert.doesNotMatch(mainSource, /const summary = String\(result\.hmsOutcome\?\.summary/);
});

test("inline narrative deliveries bypass the compact result card", () => {
  assert.match(rendererSource, /function messageRequestsInlineTextDelivery\(message = \{\}\)/);
  assert.match(rendererSource, /if \(presentation && messageRequestsInlineTextDelivery\(message\)\) return null;/);
});

test("conversation typography stays compact while data tables can use the wide canvas", () => {
  assert.match(rendererSource, /--chat-font-size/);
  assert.match(rendererSource, /function classifyRenderedDataLayout\(/);
  assert.match(rendererSource, /const wideContent = rendered\.querySelector\("table, pre, img, video, iframe, canvas, svg"\)/);
  assert.match(rendererSource, /function progressiveSourceUsesWideLayout\(/);
  assert.match(rendererSource, /const keepWide = preserveWide && rendered\.dataset\.layout === "wide"/);
  assert.match(rendererSource, /wideContent \|\| keepWide \|\| progressiveSourceUsesWideLayout\(source\)/);
  assert.match(rendererStyles, /\.message\.assistant \.rendered\[data-layout="prose"\]/);
  assert.match(rendererStyles, /\.rendered \.numeric-column/);
  assert.doesNotMatch(rendererStyles, /\.task-result-metrics/);
});
