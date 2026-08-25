"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

test("attachment-only turns have one visible and durable user instruction", () => {
  const sendStart = rendererSource.indexOf("async function sendCurrentTask(");
  const sendEnd = rendererSource.indexOf("async function processQueue", sendStart);
  const send = rendererSource.slice(sendStart, sendEnd);
  assert.match(send, /const visibleText = text \|\| \(!quote && attachments\.length \? "请分析附件内容。" : ""\)/);
  assert.match(send, /role: "user",\s*text: visibleText,/);
  assert.match(send, /clientMessageCreatedAt: userMessage\.createdAt/);
});

test("product results cannot become orphan assistant messages", () => {
  const appendStart = mainSource.indexOf("function appendMessage");
  const appendEnd = mainSource.indexOf("function assistantCompletesUserMessage", appendStart);
  const append = mainSource.slice(appendStart, appendEnd);
  const persistStart = mainSource.indexOf("function persistProductResult");
  const persistEnd = mainSource.indexOf("function canConnect", persistStart);
  const persist = mainSource.slice(persistStart, persistEnd);
  const submitStart = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const submitEnd = mainSource.indexOf('ipcMain.handle("product:query-task"', submitStart);
  const submit = mainSource.slice(submitStart, submitEnd);

  assert.match(append, /function canonicalProductUserTurn\(payload = \{\}\)/);
  assert.match(append, /function ensureProductUserTurn\(sessionId, turn = \{\}/);
  assert.match(append, /immediate: message\.role === "assistant" \|\| requireCommit/);
  assert.match(append, /if \(changed \|\| requireCommit\)/);
  assert.match(submit, /ensureProductUserTurn\(sessionId, productUserTurn, \{ requireCommit: true \}\)/);
  assert.match(submit, /userTurn: productUserTurn/);
  assert.match(persist, /ensureProductUserTurn\(sessionId, \{ \.\.\.userTurn, clientMessageId \}, \{ requireCommit: true \}\)/);
  assert.match(persist, /verifyProductUserTurnCommit\(sessionId, String\(clientMessageId \|\| ""\)\)/);
});

test("White Ball does not execute natural-language self-test tasks locally", () => {
  const productStart = mainSource.indexOf("async function submitProductWithTaskBrain");
  const productEnd = mainSource.indexOf("function ensureProductExecutionRouter", productStart);
  const product = mainSource.slice(productStart, productEnd);
  const chatStart = mainSource.indexOf('ipcMain.handle("chat:send"');
  const chatEnd = mainSource.indexOf("devLogError(\"chat:send\"", chatStart);
  const chat = mainSource.slice(chatStart, chatEnd);

  assert.doesNotMatch(product, /ensureQaAgent\(\)\.run\(/);
  assert.doesNotMatch(chat, /ensureQaAgent\(\)\.run\(/);
  assert.match(mainSource, /ipcMain\.handle\("debug-center:run"/);
});

test("active turns queue later submissions without text-based rejection gates", () => {
  const sendStart = rendererSource.indexOf("async function sendCurrentTask(");
  const sendEnd = rendererSource.indexOf("async function processQueue", sendStart);
  const send = rendererSource.slice(sendStart, sendEnd);
  assert.match(send, /if \(existingStreamId\) \{[\s\S]*?sessionTaskQueue\.enqueue/);
  assert.doesNotMatch(send, /taskFingerprint|activeSendFingerprints|避免重复提交/);
});

test("ordinary text belongs to Black Ball without White Ball semantic inspection", () => {
  const envelopeStart = mainSource.indexOf("function blackBallOwnedUnderstanding");
  const envelopeEnd = mainSource.indexOf("function internalExecutionContext", envelopeStart);
  const envelope = mainSource.slice(envelopeStart, envelopeEnd);
  const submitStart = mainSource.indexOf("async function submitProductWithTaskBrain");
  const submitEnd = mainSource.indexOf("function ensureProductExecutionRouter", submitStart);
  const submit = mainSource.slice(submitStart, submitEnd);

  assert.match(envelope, /semanticOwner: "black_ball"/);
  assert.match(envelope, /blackBallOwnsDecision: true/);
  assert.match(envelope, /^function blackBallOwnedUnderstanding\(\{ context = \{\} \} = \{\}\)/);
  assert.doesNotMatch(envelope, /sanitizeText|isSkillLearningRequest|requestNeedsHmsToolDecision|ConversationUnderstandingLayer/);
  assert.match(submit, /whiteBallLifecycleTurn[\s\S]*?blackBallOwnedUnderstanding\(\{ context: understandingContext \}\)/);
  assert.doesNotMatch(submit, /learnSkillDirectReply/);
});

test("skill advice and explicit install requests are both decided by Black Ball", () => {
  const productStart = mainSource.indexOf("async function submitProductWithTaskBrain");
  const productEnd = mainSource.indexOf("function ensureProductExecutionRouter", productStart);
  const product = mainSource.slice(productStart, productEnd);
  assert.doesNotMatch(product, /structuredTaskType.*skill_management|isSkillLearningRequest|learnSkillDirectReply/);
  assert.match(mainSource, /blackBallOwnedUnderstanding/);
  assert.match(mainSource, /blackBallOwnsDecision/);
});
