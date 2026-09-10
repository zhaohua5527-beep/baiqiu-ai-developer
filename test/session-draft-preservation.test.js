"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("session switching saves the previous draft and restores the target draft before rendering", () => {
  const selectStart = source.indexOf("async function selectSessionById");
  const selectEnd = source.indexOf("function statusText", selectStart);
  const select = source.slice(selectStart, selectEnd);

  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  assert.ok(select.indexOf("saveSessionDraft(state.selectedSessionId") < select.indexOf("api.selectSession"));
  assert.ok(select.indexOf("state.selectedSessionId = resolvedSessionId") < select.indexOf("restoreSessionDraft(resolvedSessionId)"));
  assert.ok(select.indexOf("restoreSessionDraft(resolvedSessionId)") < select.indexOf("await renderMessages"));
});

test("session switching paints an existing target snapshot before waiting for IPC history", () => {
  const selectStart = source.indexOf("async function selectSessionById");
  const selectEnd = source.indexOf("function statusText", selectStart);
  const select = source.slice(selectStart, selectEnd);

  assert.match(select, /const localHistory = Array\.isArray\(state\.db\?\.messages\?\.\[resolvedSessionId\]\)/);
  assert.match(select, /immediateMessages\.forEach\(\(message\) => rememberAuthoritativeMessage\(resolvedSessionId, message\)\)/);
  assert.ok(select.indexOf("const historyRequest = api.messages") < select.indexOf("await renderMessages"));
  assert.match(select, /!restoredCachedDom && immediateHistory/);
  assert.match(select, /history: immediateHistory/);
});

test("restored session DOM becomes authoritative before a delayed snapshot can replace it", () => {
  const restoreStart = source.indexOf("function restoreSessionMessageDom");
  const restoreEnd = source.indexOf("async function renderMessages", restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);

  assert.ok(restore.indexOf("rememberAuthoritativeMessage(sessionId, message)") < restore.indexOf("messageList.replaceChildren(cached.fragment)"));
});

test("session-changed refreshes restore the newly selected session draft", () => {
  const start = source.indexOf("api.onSessionChanged((db) =>");
  const end = source.indexOf("function startMembershipCountdown", start);
  const listener = source.slice(start, end > start ? end : start + 4000);

  assert.match(listener, /saveSessionDraft\(previousSessionId, chatInput\?\.value \|\| \"\"\)/);
  assert.match(listener, /state\.selectedSessionId = state\.db\.selectedSessionId;[\s\S]*?restoreSessionDraft\(state\.selectedSessionId\)/);
});

test("new sessions save the current draft before clearing the composer", () => {
  const start = source.indexOf('$(\"newSessionBtn\").addEventListener');
  const end = source.indexOf('$(\"newProjectBtn\")', start);
  const block = source.slice(start, end);

  assert.ok(block.indexOf("saveSessionDraft(state.selectedSessionId") < block.indexOf("api.createSession"));
  assert.match(source, /case \"new\": \{[\s\S]*?saveSessionDraft\(state\.selectedSessionId, chatInput\?\.value \|\| \"\"\)/);
});
