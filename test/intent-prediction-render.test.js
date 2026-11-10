"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("operational actions and Black Ball guidance share the composer entry", () => {
  const render = rendererSource.slice(
    rendererSource.indexOf("function renderComposerClarification"),
    rendererSource.indexOf("function renderSessions")
  );
  const taskConfirmation = render.indexOf("taskConfirmPredictOptions(message)");
  const errorRecovery = render.indexOf("errorPredictOptions(message)");
  const clarification = render.indexOf("clarificationOptionsFromMessage(message)");

  assert.match(render, /setComposerSuggestionActions\(actions,/);
  assert.match(render, /taskId: operationalPrompt\.taskId,/);
  assert.ok(taskConfirmation >= 0 && taskConfirmation < clarification, "task confirmation must map to suggestions before guidance");
  assert.ok(errorRecovery >= 0 && errorRecovery < clarification, "error recovery must map to suggestions before guidance");
  assert.match(render, /任务引导/);
});

test("suggestion actions preserve lifecycle semantics and enforce session ownership", () => {
  const contextBuilder = rendererSource.slice(
    rendererSource.indexOf("function structuredCardContext"),
    rendererSource.indexOf("function dispatchStructuredCardAction")
  );
  assert.match(contextBuilder, /suggestionAction:\s*\{/);
  assert.match(contextBuilder, /context\.taskAction = \{ taskId, action: option\.action, value \};/);
  assert.match(contextBuilder, /context\.recoveryAction = \{ taskId, action: option\.action, value \};/);
  assert.match(rendererSource, /\["intent_clarification", "task_guidance", "suggestion_actions"\]\.includes\(prompt\.cardType\)/);
});

test("structured suggestions open directly without the retired intent control", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "index.html"), "utf8");
  const messageRenderer = rendererSource.slice(
    rendererSource.indexOf("async function renderMessages"),
    rendererSource.indexOf("function renderAttachments")
  );

  assert.doesNotMatch(rendererSource, /\bintentPredictBtn\b/);
  assert.doesNotMatch(indexSource, /id="intentPredictBtn"/);
  assert.match(rendererSource, /const INTENT_PREDICTION_EXTERNAL_ENABLED = false;/);
  assert.match(messageRenderer, /state\.pendingSuggestionActions\.length[\s\S]*?renderComposerSuggestions\(\);/);
  assert.match(rendererSource, /function clearComposerSuggestions\(\)[\s\S]*?clearComposerClarification\(\);/);
});

test("HMS noSuggestion result never renders a local fallback card", () => {
  const parser = rendererSource.slice(
    rendererSource.indexOf("function clarificationOptionsFromMessage"),
    rendererSource.indexOf("function clarificationCardKey")
  );

  assert.match(parser, /if \(structured\.noSuggestion === true\) return null;/);
});

test("protocol recovery guidance cannot be overwritten by result suggestions", () => {
  const start = rendererSource.indexOf("function showFreshComposerSuggestions");
  const end = rendererSource.indexOf("function ensureComposerClarificationDrag", start);
  const block = rendererSource.slice(start, end);
  assert.match(block, /guidanceSource === "protocol_recovery"/);
  assert.match(block, /function renderComposerSuggestions[\s\S]*guidanceSource === "protocol_recovery"/);
});
