"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("session refresh preserves an active local typewriter row", () => {
  const renderMessages = rendererSource.slice(
    rendererSource.indexOf("async function renderMessages()"),
    rendererSource.indexOf("function renderAttachments()")
  );

  assert.match(rendererSource, /const activeAssistantTypings = new Map\(\);/);
  assert.match(renderMessages, /const activeTyping = activeAssistantTypingForSession\(session\.id\);/);
  assert.match(
    renderMessages,
    /if \(activeTyping\) \{[\s\S]*?requestAnimationFrame\(updateReadingControls\);[\s\S]*?\} else \{[\s\S]*?messageList\.replaceChildren\(fragment\);/
  );
});

test("a direct assistant reply registers its typing session and reconciles after completion", () => {
  assert.match(rendererSource, /typingSessionId: message\.role === "assistant" \? session\.id : ""/);
  assert.match(rendererSource, /activeAssistantTypings\.set\(typingSessionId, typingEntry\);/);
  assert.match(rendererSource, /if \(typingEntry\) completeAssistantTyping\(typingSessionId, typingEntry\);/);
  assert.match(rendererSource, /state\.lastMessageSignature = "";/);
});

test("local typewriter output follows the viewport until the user scrolls away", () => {
  assert.match(rendererSource, /function scrollMessageToStart\(row, behavior = "auto", \{ keepFollowing = false \} = \{\}\)/);
  assert.match(rendererSource, /scrollMessageToStart\(row, "auto", \{ keepFollowing: useTypingAnimation \}\);/);
  assert.match(rendererSource, /onProgress:\s*\(\) => \{\s*if \(target === messageList && state\.followOutput\) scheduleStreamingScroll\(\);/);
});

test("local typewriter uses a consistent eighty-character-per-second cadence", () => {
  assert.match(rendererSource, /const ASSISTANT_TYPING_CHARS_PER_SECOND = 80;/);
  assert.match(rendererSource, /const ASSISTANT_TYPING_INTERVAL_MS = 1000 \/ ASSISTANT_TYPING_CHARS_PER_SECOND;/);
  assert.match(rendererSource, /index = Math\.min\(chars\.length, index \+ 1\);/);
  assert.match(rendererSource, /timer = setTimeout\(paint, ASSISTANT_TYPING_INTERVAL_MS \+ punctuationPause\);/);
});
