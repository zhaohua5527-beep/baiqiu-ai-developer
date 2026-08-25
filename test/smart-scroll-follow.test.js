"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererPath = path.join(__dirname, "..", "renderer-v2", "app.js");
const htmlPath = path.join(__dirname, "..", "renderer-v2", "index.html");
const cssPath = path.join(__dirname, "..", "renderer-v2", "styles.css");
const rendererSource = fs.readFileSync(rendererPath, "utf8");
const htmlSource = fs.readFileSync(htmlPath, "utf8");
const cssSource = fs.readFileSync(cssPath, "utf8");

test("session entry and explicit bottom navigation do not animate", () => {
  assert.match(rendererSource, /messageList\.style\.scrollBehavior = "auto"/);
  assert.match(rendererSource, /function jumpMessagesToBottom\(\)[\s\S]*?fallbackToBottom: true/);
  assert.doesNotMatch(rendererSource, /pendingResponseAnchor/);
  assert.doesNotMatch(rendererSource, /anchorStart: message\.role === "assistant"/);
  assert.doesNotMatch(cssSource, /body\.session-transitioning \.conversation-stage/);
});

test("bottom proximity owns output following while an upward read pauses it", () => {
  const start = rendererSource.indexOf('messageList?.addEventListener("scroll"');
  const end = rendererSource.indexOf('messageList?.addEventListener("wheel"', start);
  const handler = rendererSource.slice(start, end);

  assert.match(rendererSource, /function pauseOutputFollowing\(\)[\s\S]*?state\.manualOutputPause = true/);
  assert.match(handler, /if \(nearBottom && \(!state\.manualOutputPause \|\| scrollDelta > 1\)\)/);
  assert.match(handler, /state\.followOutput = true/);
  assert.match(handler, /state\.manualOutputPause = false/);
  assert.match(handler, /state\.followOutput = false/);
  assert.match(handler, /state\.manualOutputPause = true/);
  assert.match(handler, /if \(instructionAnchorId\(state\.selectedSessionId\)\)[\s\S]*?return;/);
});

test("streaming bottom anchoring is immediate and tracks composer height", () => {
  const start = rendererSource.indexOf("function scrollMessagesToBottom");
  const end = rendererSource.indexOf("function hasVisibleLiveChatStream", start);
  const scrollToBottom = rendererSource.slice(start, end);

  assert.match(scrollToBottom, /messageList\.style\.scrollBehavior = "auto"/);
  assert.match(scrollToBottom, /messageList\.scrollTop = messageList\.scrollHeight/);
  assert.doesNotMatch(scrollToBottom, /behavior: "smooth"/);
  assert.match(rendererSource, /if \(typeof ResizeObserver === "function" && chatForm\)/);
  assert.match(rendererSource, /state\.followOutput && !state\.manualOutputPause\) requestAnimationFrame\(scrollMessagesToBottom\)/);
  assert.match(rendererSource, /\}\)\.observe\(chatForm\)/);
  assert.match(rendererSource, /function anchorNewInstruction\(row\)[\s\S]*?state\.followOutput = false;[\s\S]*?state\.manualOutputPause = true/);
  assert.match(scrollToBottom, /if \(instructionAnchorId\(state\.selectedSessionId\)\) return;/);
});

test("reader scrolling preserves the current instruction anchor", () => {
  const start = rendererSource.indexOf('messageList?.addEventListener("wheel"');
  const end = rendererSource.indexOf('messageList?.addEventListener("keydown"', start);
  const wheelHandler = rendererSource.slice(start, end);

  assert.doesNotMatch(wheelHandler, /clearInstructionAnchor\(state\.selectedSessionId\)/);
  const pause = rendererSource.slice(rendererSource.indexOf("function pauseOutputFollowing"), rendererSource.indexOf("function jumpMessagesToBottom"));
  assert.doesNotMatch(pause, /clearInstructionAnchor\(/);
  const jump = rendererSource.slice(rendererSource.indexOf("function jumpMessagesToBottom"), rendererSource.indexOf("function scrollMessagesToBottom"));
  assert.match(jump, /clearInstructionAnchor\(state\.selectedSessionId\)/);
});

test("the redundant current-round start arrow is removed", () => {
  assert.doesNotMatch(htmlSource, /currentRoundStartBtn/);
  assert.doesNotMatch(rendererSource, /currentRoundStartBtn/);
  assert.doesNotMatch(cssSource, /currentRoundStartBtn/);
});
