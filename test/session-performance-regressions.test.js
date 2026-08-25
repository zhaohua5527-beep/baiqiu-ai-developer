"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

test("session history IPC is lightweight and windowed", () => {
  assert.match(mainSource, /function rendererDbSnapshot\(db = null\)/);
  assert.match(mainSource, /ipcMain\.handle\("session:messages", async \(_event, id, query = null\)/);
  assert.match(mainSource, /hasEarlier: start > 0/);
  assert.match(mainSource, /hasNewer: end < messages\.length/);
  assert.match(preloadSource, /messages: \(id, query = null\) => ipcRenderer\.invoke\("session:messages", id, query\)/);
  assert.match(mainSource, /return rendererDbSnapshot\(saved\);/);
});

test("message cache warming removes synchronous session-switch fallback reads", () => {
  const ensureStart = mainSource.indexOf("function ensureSessionMsgs");
  const ensureEnd = mainSource.indexOf("function writeJson", ensureStart);
  const ensureBody = mainSource.slice(ensureStart, ensureEnd);
  assert.doesNotMatch(ensureBody, /fs\.readFileSync/);
  assert.match(mainSource, /scheduleMessagesCacheWarm\(raw, file, stat\.mtimeMs\)/);
  assert.match(mainSource, /scheduleMessagesCacheWarm\(raw \|\| _messagesRawCache, file, dbCacheMtimeMs\)/);
});

test("app initialization preloads disk only once and cannot overwrite pending message writes", () => {
  assert.match(mainSource, /let dbPreloadComplete = false;/);
  assert.match(mainSource, /async function preloadDbAsync\(\) \{\s*if \(dbPreloadComplete\) return dbCache \|\| dbCacheLight \|\| loadDb\(\);/);
  assert.match(mainSource, /function ensureDbFile\(file = dbPath\(\)\)/);
  assert.match(mainSource, /const file = ensureDbFile\(\);/);
  assert.match(mainSource, /flag: "wx"/);
  assert.match(mainSource, /dbPreloadComplete = true;\s*return dbCacheLight;/);
});

test("every database flush preserves authoritative cached session messages", () => {
  assert.match(mainSource, /function mergeCachedMessagesIntoDb\(db\)/);
  assert.match(mainSource, /function saveDb\(db(?:, [^)]*)?\) \{\s*mergeCachedMessagesIntoDb\(db\);/);
  const asyncFlush = mainSource.slice(mainSource.indexOf("function scheduleFlushDb"), mainSource.indexOf("function flushDbSync"));
  const syncFlush = mainSource.slice(mainSource.indexOf("function flushDbSync"), mainSource.indexOf("function ensureIntentAgent"));
  assert.match(asyncFlush, /mergeCachedMessagesIntoDb\(db\);/);
  assert.match(syncFlush, /mergeCachedMessagesIntoDb\(db\);/);
});

test("message append promotes the live session array into the authoritative cache before saving", () => {
  const append = mainSource.slice(mainSource.indexOf("function appendMessage"), mainSource.indexOf("function assistantCompletesUserMessage"));
  assert.match(mainSource, /function compactAssistantExecutionLog\(raw = \{\}\)/);
  assert.match(mainSource, /function productResultWithoutExecutionLog\(productResult = null\)/);
  assert.match(append, /compactAssistantExecutionLog\(message\.role === "assistant" \? message\.raw : \{\}\)/);
  assert.match(append, /_messagesCache\.get\(sessionId\) !== db\.messages\[sessionId\]/);
  assert.match(append, /_messagesCache\.set\(sessionId, db\.messages\[sessionId\]\);/);
  assert.ok(append.indexOf("_messagesCache.set") < append.indexOf("db.messages[sessionId].push(item)"));
  assert.match(append, /saveDb\(db, \{ immediate: message\.role === "assistant" \|\| requireCommit, requireCommit \}\);/);
});

test("session activity never changes the user-controlled sidebar order", () => {
  const sortStart = mainSource.indexOf("function sortedSessions");
  const sortEnd = mainSource.indexOf("function createSessionRecord", sortStart);
  const sortBody = mainSource.slice(sortStart, sortEnd);

  assert.match(sortBody, /Boolean\(a\.pinned\) !== Boolean\(b\.pinned\)/);
  assert.match(sortBody, /Number\(a\.order\)/);
  assert.match(sortBody, /return left\.index - right\.index/);
  assert.doesNotMatch(sortBody, /updatedAt/);
});

test("startup recovery prefers completed conversation traces and stays asynchronous", () => {
  assert.match(mainSource, /function recoverCompletedConversationTrace\(sessionId = "", userMessage = \{\}\)/);
  assert.match(mainSource, /const recovered = recoverCompletedConversationTrace\(session\.id, message\);/);
  assert.match(mainSource, /if \(recovered\) \{[\s\S]*?appendMessage\(session\.id, \{[\s\S]*?recovered\.text/s);
  assert.match(mainSource, /void reconcileInterruptedMessageDeliveries\(\)/);
  assert.doesNotMatch(mainSource, /await reconcileInterruptedMessageDeliveries\(\);/);
});

test("renderer bounds long conversations and preserves session drafts", () => {
  assert.match(rendererSource, /const MESSAGE_WINDOW_SIZE = 60/);
  assert.match(rendererSource, /api\.messages\(session\.id, \{ limit: MESSAGE_WINDOW_SIZE, offset: requestedOffset \}\)/);
  assert.match(rendererSource, /function shiftMessageWindow\(action\)/);
  assert.match(rendererSource, /function saveSessionDraft\(sessionId/);
  assert.match(rendererSource, /saveSessionDraft\(state\.selectedSessionId, chatInput\?\.value \|\| ""\)/);
  assert.match(rendererSource, /restoreSessionDraft\(session\.id\)/);
  assert.doesNotMatch(rendererSource, /resetComposerLayout\(\{ clearDraft: Boolean\(state\.lastRenderedSessionId\) \}\)/);
});

test("session switching paints selection and messages before selection persistence completes", () => {
  const start = rendererSource.indexOf("async function selectSessionById");
  const end = rendererSource.indexOf("function statusText", start);
  const select = rendererSource.slice(start, end);

  assert.ok(select.indexOf("state.selectedSessionId = resolvedSessionId") < select.indexOf("const historyRequest = api.messages"));
  assert.ok(select.indexOf("await renderMessages") < select.indexOf("const prefetchedHistory = await historyRequest"));
  assert.ok(select.indexOf("const historyRequest = api.messages") < select.indexOf("const selectionRequest = api.selectSession"));
  assert.ok(select.indexOf("await renderMessages") < select.indexOf("await selectionRequest"));
  assert.match(select, /prefetchedMessages: \{ sessionId: resolvedSessionId, history: prefetchedHistory \}/);
  assert.doesNotMatch(select, /await Promise\.all/);
  assert.match(select, /currentChatTitle\.textContent = session \? projectSessionDisplayName\(session\) : "新对话"/);
  assert.doesNotMatch(select, /session-transitioning/);
});

test("visited sessions paint from a bounded renderer cache while fresh history loads", () => {
  const start = rendererSource.indexOf("async function selectSessionById");
  const end = rendererSource.indexOf("function statusText", start);
  const select = rendererSource.slice(start, end);

  assert.match(rendererSource, /sessionMessageHistoryCache: new Map\(\)/);
  assert.match(rendererSource, /function cacheSessionMessageHistory\(sessionId, offset, history\)/);
  assert.match(rendererSource, /state\.sessionMessageHistoryCache\.size > 24/);
  assert.match(select, /const cachedHistory = cachedSessionMessageHistory\(resolvedSessionId, requestedOffset\)/);
  assert.ok(select.indexOf("if (cachedHistory)") < select.indexOf("const prefetchedHistory = await historyRequest"));
});

test("recent sessions restore live message DOM instead of rebuilding long markdown", () => {
  const start = rendererSource.indexOf("async function selectSessionById");
  const end = rendererSource.indexOf("function statusText", start);
  const select = rendererSource.slice(start, end);

  assert.match(rendererSource, /sessionMessageDomCache: new Map\(\)/);
  assert.match(rendererSource, /function cacheCurrentSessionMessageDom\(sessionId\)/);
  assert.match(rendererSource, /function restoreSessionMessageDom\(sessionId\)/);
  assert.match(rendererSource, /state\.sessionMessageDomCache\.size > 6/);
  assert.match(rendererSource, /sessionTaskQueue\.isActive\(sessionId\)[\s\S]*?activeLiveChatStreamForSession\(sessionId\)[\s\S]*?activeAssistantTypingForSession\(sessionId\)/);
  assert.ok(select.indexOf("cacheCurrentSessionMessageDom(previousSessionId)") < select.indexOf("state.selectedSessionId = resolvedSessionId"));
  assert.ok(select.indexOf("restoreSessionMessageDom(resolvedSessionId)") < select.indexOf("await historyRequest"));
});

test("session switching defers auxiliary panels until after the conversation frame", () => {
  const renderStart = rendererSource.indexOf("async function renderMessages");
  const renderEnd = rendererSource.indexOf("function renderAttachments", renderStart);
  const renderMessages = rendererSource.slice(renderStart, renderEnd);

  assert.match(rendererSource, /function scheduleSessionAuxiliaryRender\(sessionId, messages = \[\]\)/);
  assert.match(rendererSource, /requestIdleCallback\(render, \{ timeout: 120 \}\)/);
  assert.match(renderMessages, /scheduleSessionAuxiliaryRender\(session\.id, messages\);/);
  assert.doesNotMatch(renderMessages, /renderTaskProgressRail\(\);\s*renderTaskBoard\(\);/);
});

test("task writes remain bound to the originating session", () => {
  assert.match(rendererSource, /const isVisible = \(\) => state\.selectedSessionId === session\.id/);
  assert.match(rendererSource, /api\.appendMessage\(session\.id, userMessage\)/);
  assert.match(mainSource, /const requestedSessionId = String\(payload\.sessionId \|\| ""\)\.trim\(\)/);
  assert.match(mainSource, /原会话已不存在，本次结果没有写入其他会话/);
  assert.match(mainSource, /persistedSessionId: sessionId/);
});

test("startup starts both chat and execution ACP lanes but keeps voice on-demand", () => {
  const preparation = mainSource.slice(
    mainSource.indexOf("async function prepareBundledHmsRuntime"),
    mainSource.indexOf("function trayIconSourcePath")
  );
  assert.doesNotMatch(preparation, /prewarmVoiceStt\(\)/);
  assert.match(preparation, /ensureHermesClient\(\)\.start\(\)/);
  assert.match(preparation, /ensureHermesForegroundClient\(\)\.start\(\)/);
  assert.doesNotMatch(preparation, /prewarmForegroundSession\(\)/);
  const selectHandler = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("session:select"'),
    mainSource.indexOf('ipcMain.handle("session:rename"')
  );
  assert.doesNotMatch(selectHandler, /prewarmForegroundSession/);
});

test("HMS runtime deployment starts after the initial desktop frame", () => {
  const startup = mainSource.slice(mainSource.indexOf("app.whenReady().then(async () => {"));
  assert.match(mainSource, /function ensureHmsRuntimePreparation\(\)/);
  assert.ok(startup.indexOf("createWindow();") < startup.indexOf("void ensureHmsRuntimePreparation()"));
  assert.match(startup, /void ensureHmsRuntimePreparation\(\)\.catch/s);
});

test("foreground chat prewarms asynchronously after render, focus and session selection", () => {
  assert.match(mainSource, /ipcMain\.handle\("chat:prewarm", async \(_event, sessionId = ""\)/);
  assert.match(preloadSource, /prewarmChat: \(sessionId = ""\) => ipcRenderer\.invoke\("chat:prewarm", sessionId\)/);
  assert.match(rendererSource, /function scheduleForegroundChatPrewarm\(sessionId = state\.selectedSessionId, delayMs = 500\)/);
  assert.match(rendererSource, /chatInput\.addEventListener\("focus", \(\) => \{\s*scheduleForegroundChatPrewarm\(state\.selectedSessionId, 0\);/);
  assert.match(rendererSource, /scheduleForegroundChatPrewarm\(resolvedSessionId, 0\);/);
  assert.match(rendererSource, /scheduleForegroundChatPrewarm\(state\.selectedSessionId, 0\);/);
  assert.doesNotMatch(rendererSource, /await scheduleForegroundChatPrewarm/);
});

test("startup CPU work is measurable, serialized and idle-aware", () => {
  assert.match(mainSource, /app\.getAppMetrics\(\)/);
  assert.match(mainSource, /startup-performance\.json/);
  assert.match(preloadSource, /startupMetric: \(name, meta = \{\}\) => ipcRenderer\.send\("startup:metric"/);
  assert.match(mainSource, /function queueStartupMaintenance\(name, task, fallbackMs = 60000\)/);
  assert.match(mainSource, /startupMaintenanceChain = startupMaintenanceChain/);
  assert.match(mainSource, /backgroundThrottling: true/);
});

test("idle sessions do not poll the conversation DOM", () => {
  assert.doesNotMatch(rendererSource, /setInterval\(ensureSelectedSessionExecutionPresence, 750\)/);
  assert.match(rendererSource, /function hasActiveSessionExecution\(\)/);
  assert.match(rendererSource, /function scheduleExecutionPresenceCheck\(delayMs = 250\)/);
  assert.match(rendererSource, /if \(executionPresenceTimer \|\| !hasActiveSessionExecution\(\)\) return/);
});

test("tray popup renderer is created on first use", () => {
  const createTrayBlock = mainSource.slice(mainSource.indexOf("function createTray()"), mainSource.indexOf("function pathInside"));
  assert.doesNotMatch(createTrayBlock, /createTrayPopupWindow\(\)/);
  const showPopupBlock = mainSource.slice(mainSource.indexOf("function showTrayPopup()"), mainSource.indexOf("function createTrayPopupWindow"));
  assert.match(showPopupBlock, /createTrayPopupWindow\(\)/);
});

test("persisted HMS streams are compacted and not stored twice", () => {
  assert.match(mainSource, /function compactPersistedExecutionPayload\(value\)/);
  assert.match(mainSource, /if \(Array\.isArray\(output\.updates\)\) delete output\.updates/);
  assert.match(mainSource, /if \(productResult\?\.raw && raw\.raw/);
  assert.match(mainSource, /delete existingRaw\.raw/);
});
