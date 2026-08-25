"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

test("foreground knowledge references include same-session summaries, recent user facts, and time evidence", () => {
  const retrieval = mainSource.slice(
    mainSource.indexOf("function knowledgeReferencesForMessage"),
    mainSource.indexOf("function rememberIntentClarificationDecision")
  );
  assert.match(retrieval, /sessionId: session\?\.id \|\| ""/);
  assert.match(retrieval, /excludeAutoSummaries: false/);
  assert.match(retrieval, /recentUserKnowledgeContext/);
  assert.match(retrieval, /禁止再次询问同一问题/);
  assert.match(retrieval, /createdAt: note\.createdAt \|\| ""/);
  assert.match(retrieval, /updatedAt: note\.updatedAt \|\| ""/);
  assert.match(retrieval, /updatedAt: \$\{item\.updatedAt\}/);
});

test("automatic summaries are scheduled and sourced by task identity", () => {
  assert.match(mainSource, /function knowledgeMessagesForTask\(messages = \[\], taskId = ""\)/);
  assert.match(mainSource, /const timerKey = `\$\{sessionId\}:\$\{taskId \|\| "idle"\}`/);
  assert.match(mainSource, /enqueueConversationKnowledge\(sessionId, terminalResult \? "task_completed" : "idle", \{ taskId \}\)/);
  assert.match(mainSource, /auto-summary\/\$\{candidate\.sessionId\}\/\$\{candidate\.taskId \? `task\/\$\{candidate\.taskId\}\/` : ""\}/);
});

test("the knowledge planet refreshes after a background knowledge revision", () => {
  assert.match(mainSource, /safeMainWindowSend\("knowledge:changed"/);
  assert.match(preloadSource, /onKnowledgeChanged: \(handler\) => ipcRenderer\.on\("knowledge:changed"/);
  assert.match(rendererSource, /api\.onKnowledgeChanged\?\.\(\(\) => \{/);
  assert.match(rendererSource, /knowledgeVaultCache = null;[\s\S]*?renderKnowledgeCenter\(true\)/);
});
