"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("switching sessions saves the current viewport before selection", () => {
  const start = source.indexOf("async function selectSessionById");
  const end = source.indexOf("function statusText", start);
  const selectSession = source.slice(start, end);

  assert.ok(selectSession.indexOf("saveSessionScrollPosition(state.selectedSessionId)") < selectSession.indexOf("api.selectSession"));
});

test("session scroll positions persist an anchor and message window offset", () => {
  assert.match(source, /const SESSION_SCROLL_KEY = "baiqiu\.sessionScrollPositions"/);
  assert.match(source, /atBottom: !instructionAnchorId\(sessionId\) && isNearBottom\(messageList\)/);
  assert.match(source, /anchorId: anchor\?\.dataset\.messageId \|\| ""/);
  assert.match(source, /windowOffset: Math\.max\(0, Number\(state\.messageWindowOffsets\.get\(sessionId\) \|\| 0\)\)/);
  assert.match(source, /localStorage\.setItem\(SESSION_SCROLL_KEY, JSON\.stringify\(positions\)\)/);
});

test("first entry jumps to the bottom and returning restores the saved viewport", () => {
  const start = source.indexOf("async function renderMessages");
  const end = source.indexOf("function renderAttachments", start);
  const renderMessages = source.slice(start, end);

  assert.match(renderMessages, /if \(sessionChanged && !hasInstructionAnchor\) \{\s*restoreSessionScrollPosition\(session\.id\);/);
  assert.match(source, /applyMessageScrollPosition\(position, \{ fallbackToBottom: !position \}\)/);
  assert.match(source, /const restoreBottom = !keepInstructionAnchor && \(fallbackToBottom \|\| position\?\.atBottom === true\)/);
  assert.match(source, /messageList\.style\.scrollBehavior = "auto"/);
  assert.doesNotMatch(renderMessages, /scrollMessagesToBottom\(\{ resume: true \}\)/);
});

test("message restoration and follow-output use one scroll write per layout pass", () => {
  const restoreStart = source.indexOf("function restoreSessionScrollPosition");
  const restoreEnd = source.indexOf("function instructionAnchorId", restoreStart);
  const restoreBody = source.slice(restoreStart, restoreEnd);
  assert.equal((restoreBody.match(/applyMessageScrollPosition\(position/g) || []).length, 1);
  assert.match(restoreBody, /if \(sessionScrollRestoreFrame\) cancelAnimationFrame\(sessionScrollRestoreFrame\)/);
  assert.match(restoreBody, /state\.selectedSessionId !== sessionId \|\| state\.lastRenderedSessionId !== sessionId/);
  assert.match(restoreBody, /sessionScrollRestoreFrame = requestAnimationFrame\(\(\) => \{/);

  const bottomStart = source.indexOf("function scrollMessagesToBottom");
  const bottomEnd = source.indexOf("function hasVisibleLiveChatStream", bottomStart);
  const bottomBody = source.slice(bottomStart, bottomEnd);
  assert.doesNotMatch(bottomBody, /scrollNow\(\);/);
  assert.match(bottomBody, /if \(messageBottomScrollFrame\) return/);
  assert.match(bottomBody, /messageBottomScrollFrame = requestAnimationFrame\(scrollNow\);/);

  const jumpStart = source.indexOf("function jumpMessagesToBottom");
  const jumpEnd = source.indexOf("function scrollMessagesToBottom", jumpStart);
  const jumpBody = source.slice(jumpStart, jumpEnd);
  assert.equal((jumpBody.match(/applyMessageScrollPosition\(/g) || []).length, 1);
});
