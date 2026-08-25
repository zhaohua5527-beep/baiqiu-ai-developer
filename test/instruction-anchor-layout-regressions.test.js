"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");

test("a pinned instruction cannot be mistaken for bottom-following state", () => {
  const captureStart = rendererSource.indexOf("function captureMessageScrollPosition");
  const captureEnd = rendererSource.indexOf("function saveSessionScrollPosition", captureStart);
  const capture = rendererSource.slice(captureStart, captureEnd);
  const applyStart = rendererSource.indexOf("function applyMessageScrollPosition");
  const applyEnd = rendererSource.indexOf("function restoreSessionScrollPosition", applyStart);
  const apply = rendererSource.slice(applyStart, applyEnd);

  assert.match(capture, /atBottom: !instructionAnchorId\(sessionId\) && isNearBottom\(messageList\)/);
  assert.match(apply, /const restoreBottom = !keepInstructionAnchor &&/);
  assert.match(apply, /state\.followOutput = keepInstructionAnchor \? false/);
  assert.match(apply, /state\.manualOutputPause = keepInstructionAnchor \|\| !state\.followOutput/);
});

test("sending settles composer geometry before locking the instruction at one stable coordinate", () => {
  const sendStart = rendererSource.indexOf("async function sendCurrentTask");
  const sendEnd = rendererSource.indexOf("async function processQueue", sendStart);
  const send = rendererSource.slice(sendStart, sendEnd);
  const anchorStart = rendererSource.indexOf("function anchorNewInstruction");
  const anchorEnd = rendererSource.indexOf("function countLongReplyChars", anchorStart);
  const anchor = rendererSource.slice(anchorStart, anchorEnd);

  assert.ok(send.indexOf("adjustComposerHeight();") < send.indexOf("anchorNewInstruction(userRow);"));
  assert.ok(send.indexOf("anchorNewInstruction(userRow);") < send.indexOf("await api.appendMessage(session.id, userMessage);"));
  assert.equal((anchor.match(/applyInstructionAnchor\(sessionId, \{ reposition: true \}\)/g) || []).length, 1);
  assert.match(anchor, /targetOffset: 0,[\s\S]*?locked: true/);
  assert.doesNotMatch(rendererSource, /animateInstructionToStart|instructionScrollAnimationFrame/);
});

test("persistence refreshes keep the locked instruction coordinate without repositioning twice", () => {
  const transaction = rendererSource.slice(
    rendererSource.indexOf("function mutatePreservingMessageViewport"),
    rendererSource.indexOf("function clearSessionTransientState")
  );
  const renderMessages = rendererSource.slice(
    rendererSource.indexOf("async function renderMessages"),
    rendererSource.indexOf("function renderAttachments")
  );

  assert.match(transaction, /instructionState = instructionAnchorState\(state\.selectedSessionId\)/);
  assert.match(transaction, /currentInstructionRow && instructionState\?\.locked !== false/);
  assert.match(transaction, /positionInstructionAnchor\(currentInstructionRow, instructionState\.targetOffset\)/);
  assert.match(renderMessages, /renderedMessageWindowMatches\(visibleMessages\)[\s\S]*?state\.lastMessageSignature = signature/);
  assert.match(renderMessages, /mutatePreservingMessageViewport\(\(\) => messageList\.replaceChildren\(fragment\)\)/);
  assert.match(renderMessages, /const anchorLayoutChanged = sessionChanged \|\| messagesReplaced/);
  assert.match(renderMessages, /applyInstructionAnchor\(session\.id, \{ reposition: anchorLocked && anchorLayoutChanged \}\)/);
  assert.match(renderMessages, /messagesReplaced && anchoredPosition && !anchorLocked/);
});

test("explicit reader input detaches the coordinate lock without resuming bottom following", () => {
  assert.match(rendererSource, /function releaseInstructionAnchorPosition[\s\S]*?anchor\.locked = false/);
  assert.match(rendererSource, /addEventListener\("wheel"[\s\S]*?releaseInstructionAnchorPosition/);
  assert.match(rendererSource, /addEventListener\("touchstart"[\s\S]*?releaseInstructionAnchorPosition/);
  assert.match(rendererSource, /addEventListener\("keydown"[\s\S]*?releaseInstructionAnchorPosition/);
  assert.match(rendererSource, /if \(instructionAnchorId\(state\.selectedSessionId\)\) \{\s*state\.followOutput = false;\s*state\.manualOutputPause = true;/);
});

test("two consecutive layout expansions converge to the same instruction pixel", () => {
  const start = rendererSource.indexOf("function positionInstructionAnchor");
  const end = rendererSource.indexOf("function applyInstructionAnchor", start);
  const source = rendererSource.slice(start, end);
  let documentTop = 800;
  const messageList = {
    scrollTop: 700,
    style: { scrollBehavior: "smooth" },
    getBoundingClientRect: () => ({ top: 100 })
  };
  const row = {
    getBoundingClientRect: () => ({ top: documentTop - messageList.scrollTop })
  };
  const context = {
    messageList,
    state: { programmaticScrollUntil: 0, lastMessageScrollTop: 0 },
    Date,
    Math,
    result: null
  };
  vm.runInNewContext(`${source}\nglobalThis.position = positionInstructionAnchor;`, context);

  assert.equal(context.position(row, 0), false);
  documentTop += 180;
  assert.equal(context.position(row, 0), true);
  assert.equal(row.getBoundingClientRect().top, 100);
  documentTop += 220;
  assert.equal(context.position(row, 0), true);
  assert.equal(row.getBoundingClientRect().top, 100);
  assert.equal(messageList.style.scrollBehavior, "smooth");
});

test("wide response content shares a responsive conversation shell", () => {
  assert.match(rendererSource, /querySelector\("table, pre, img, video, iframe, canvas, svg"\)/);
  assert.match(rendererSource, /row\.dataset\.contentLayout = "wide"/);
  assert.match(styles, /--content-width:\s*1360px/);
  assert.match(styles, /--prose-width:\s*920px/);
  assert.match(styles, /--wide-content-width:\s*1280px/);
  assert.match(styles, /\.message\.assistant \.bubble\s*\{\s*width: min\(100%, var\(--wide-content-width\)\);\s*\}/);
  assert.match(styles, /\.message\.assistant \.rendered\[data-layout="prose"\]\s*\{\s*width: min\(100%, var\(--prose-width\)\);\s*\}/);
  assert.match(styles, /\.message\.assistant:has\(\.rendered\[data-layout="wide"\]\) \.bubble/);
  assert.match(styles, /@media \(max-width: 1600px\)[\s\S]*?--content-width:\s*1180px/);
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?--wide-content-width:\s*100%/);
});
