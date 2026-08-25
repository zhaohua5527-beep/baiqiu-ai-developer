"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("message menu is vertical with quote above knowledge capture", () => {
  assert.match(cssSource, /\.message-context-menu\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.ok(rendererSource.indexOf("messageQuoteBtn?.addEventListener") < rendererSource.indexOf("messageKnowledgeBtn?.addEventListener"));
  assert.match(rendererSource, /function setMessageKnowledgeButtonLabel/);
  assert.match(rendererSource, /button\.replaceChildren\(icon, text\)/);
  assert.doesNotMatch(rendererSource, /messageKnowledgeBtn\.textContent\s*=\s*"沉淀"/);
});

test("knowledge capture sends a selection when present and otherwise stores the exchange", () => {
  assert.match(rendererSource, /selectionText:\s*selectedTextFromMessageRow/);
  assert.match(rendererSource, /captureKnowledgeMessage\(\{ sessionId, messageId, selectionText \}\)/);
  assert.match(mainSource, /const captureMode = selectionText \? "selection" : "exchange"/);
  assert.match(mainSource, /entitySignals\(captureTextForScope\)/);
  assert.match(mainSource, /project:\s*knowledgeProject/);
  assert.match(mainSource, /## \u9009\u4e2d\u5185\u5bb9|## 选中内容/);
  assert.match(mainSource, /## \u9ed1\u7403\u56de\u590d|## 黑球回复/);
});

test("renderer clears quote and attachment transients when the selected session changes", () => {
  assert.match(rendererSource, /function clearSessionTransientState/);
  assert.match(rendererSource, /state\.attachments\s*=\s*\[\]/);
  assert.match(rendererSource, /clearComposerQuote\(\)/);
  assert.match(rendererSource, /if \(state\.db\.selectedSessionId && state\.db\.selectedSessionId !== previousSessionId\)/);
});

test("long reply directory keeps its compact original position with high-priority blue buttons", () => {
  assert.match(cssSource, /\.composer-reply-nav\s*\{[\s\S]*?right:\s*calc\(50% \+ 24px\)/);
  assert.match(cssSource, /\.composer-reply-nav\s*\{[\s\S]*?bottom:\s*calc\(100% - 1px\)/);
  assert.match(cssSource, /\.composer-reply-nav\s*\{[\s\S]*?z-index:\s*40/);
  assert.match(cssSource, /\.composer-reply-nav\s*\{[\s\S]*?height:\s*28px/);
  assert.doesNotMatch(cssSource, /\.composer-reply-nav\s*\{[^}]*?background:/);
  assert.match(cssSource, /\.composer-reply-nav-item,[\s\S]*?background:\s*var\(--accent\)/);
  assert.match(cssSource, /\.composer-reply-nav-item,[\s\S]*?color:\s*#fff/);
});
