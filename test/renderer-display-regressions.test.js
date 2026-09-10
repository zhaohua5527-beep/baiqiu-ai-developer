"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");

test("conversation messages render user documents and images from one attachment set", () => {
  const assetSource = rendererSource.slice(
    rendererSource.indexOf("function messageAssetIdentity"),
    rendererSource.indexOf("function addMessage")
  );
  const addMessageSource = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );

  assert.match(assetSource, /for \(const item of generatedFilesFromMessage\(message\)\)/);
  assert.match(assetSource, /if \(isTaskBoardImage\(item\)\)/);
  assert.match(assetSource, /for \(const image of Array\.isArray\(message\.images\) \? message\.images : \[\]\)/);
  assert.match(addMessageSource, /const \{ images: messageImages, files: messageFiles \} = messageAssetsFromMessage\(message\);/);
  assert.match(addMessageSource, /for \(const imageItem of messageImages\)/);
  assert.match(addMessageSource, /const deliveredFiles = taskPresentation[\s\S]*?structuredPresentationFiles\(taskPresentation\.files, messageFiles\)/);
  assert.match(addMessageSource, /if \(deliveredFiles\.length\)/);
  assert.doesNotMatch(addMessageSource, /const messageFiles = message\.role === "assistant"/);
});

test("image attachments are removed from file cards after deduplication", () => {
  const assetSource = rendererSource.slice(
    rendererSource.indexOf("function messageAssetIdentity"),
    rendererSource.indexOf("function addMessage")
  );

  assert.match(assetSource, /const imageKeys = new Set\(\);/);
  assert.match(assetSource, /if \(imageKeys\.has\(key\)\) return;/);
  assert.match(assetSource, /if \(isTaskBoardImage\(item\)\) \{[\s\S]*?continue;[\s\S]*?\}\s*const key = messageAssetIdentity\(item\);/);
});

test("task board uses intrinsic grid rows instead of a calculated body height", () => {
  assert.match(styles, /\.task-board-drawer\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.task-board-body\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*0;/);
});

test("conversation prose separates reading text from data and delivery surfaces", () => {
  assert.match(styles, /\.message\.assistant \.rendered\[data-layout="prose"\]\s*\{[\s\S]*?line-height:\s*1\.78;/);
  assert.match(styles, /\.rendered :is\(ul, ol\)\s*\{[\s\S]*?padding-left:\s*1\.55em;/);
  assert.match(styles, /\.rendered blockquote\s*\{[\s\S]*?border-left:\s*3px/);
  assert.match(styles, /\.rendered table\s*\{[\s\S]*?border-top:\s*2px/);
  assert.match(styles, /\.rendered \.numeric-column\s*\{[\s\S]*?text-align:\s*right/);
  assert.match(styles, /\.message-files::before\s*\{[\s\S]*?content:\s*"交付文件"/);
  assert.match(styles, /\.task-result-actions\s*\{[\s\S]*?border-top:\s*1px solid var\(--line\)/);
  assert.match(styles, /\.streaming-rendered\s*\{[\s\S]*?contain:\s*layout style/);
});

test("completed answers retain one collapsed execution timeline independent of the answer", () => {
  const addMessageSource = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );

  const collapseSource = rendererSource.slice(
    rendererSource.indexOf("function collapseCompletedExecutionActivity"),
    rendererSource.indexOf("function streamActivityHtml")
  );
  assert.doesNotMatch(addMessageSource, /execution-activity-completed/);
  assert.match(collapseSource, /root\.dataset\.lifecycle = "completed"/);
  assert.doesNotMatch(collapseSource, /execution-completion-count/);
  assert.match(collapseSource, /streaming-elapsed/);
  assert.doesNotMatch(collapseSource, /execution-activity-duration-only/);
  assert.match(collapseSource, /return root/);
});

test("completed public summaries stay visible while execution details retire", () => {
  const persistedSource = rendererSource.slice(
    rendererSource.indexOf("function renderPersistedSegmentPairs"),
    rendererSource.indexOf("function snapshotMessageIdentity")
  );
  const toggleSource = rendererSource.slice(
    rendererSource.indexOf("function bindExecutionActivityToggle"),
    rendererSource.indexOf("function updateExecutionActivityToggle")
  );
  const finalizeSource = rendererSource.slice(
    rendererSource.indexOf("const hasSegmentedDetails = Boolean(rendered?.querySelector?.(\".stream-segment-block\"))"),
    rendererSource.indexOf("const committedText", rendererSource.indexOf("const hasSegmentedDetails"))
  );

  assert.match(persistedSource, /structured\.hidden = structuredItems\.length === 0/);
  assert.match(toggleSource, /\.stream-segment-process, \.stream-segment-reasoning/);
  assert.doesNotMatch(toggleSource, /\.stream-segment-process, \.stream-segment-structured/);
  assert.match(toggleSource, /detail\.hidden = !expanded \|\| !String\(detail\.textContent \|\| \"\"\)\.trim\(\)/);
  assert.match(finalizeSource, /rendered\.querySelectorAll\([\s\S]*?detail\.hidden = true/);
  assert.doesNotMatch(finalizeSource, /\.stream-segment-process, \.stream-segment-structured/);
  assert.match(finalizeSource, /bubble\?\.appendChild\(entry\.activity\)/);
});

test("session execution presence suppresses a stale duplicate after completion", () => {
  const presenceSource = rendererSource.slice(
    rendererSource.indexOf("function ensureSessionExecutionMotion"),
    rendererSource.indexOf("function ensureSelectedSessionExecutionPresence")
  );

  assert.match(rendererSource, /if \(locallyCompletedSessions\.has\(session\.id\)\) return false/);
  assert.match(presenceSource, /hasExecutionLease/);
  assert.match(presenceSource, /!hasExecutionLease && \(!activeStream \|\| activeStream\.backendCompleted\)/);
});

test("live stream registration removes every stale active execution row", () => {
  const cleanupSource = rendererSource.slice(
    rendererSource.indexOf("function removeStaleExecutionRows"),
    rendererSource.indexOf("function createChatStreamId")
  );
  const registerSource = rendererSource.slice(
    rendererSource.indexOf("function registerLiveChatStream"),
    rendererSource.indexOf("function resetLiveChatStreamReveal")
  );

  assert.match(cleanupSource, /querySelectorAll\("\.message\.thinking-message, \.message\.streaming-response"\)/);
  assert.match(cleanupSource, /if \(row !== keepRow && !drainingRows\.has\(row\)\) removeThinkingMessage\(row\)/);
  assert.match(registerSource, /discardSupersededLiveChatStreams\(sessionId, streamId\);[\s\S]*?removeSessionExecutionIndicator\(sessionId\);[\s\S]*?removeStaleExecutionRows\(thinkingRow\)/);
});

test("foreground sidebar refresh acknowledges the selected session revision", () => {
  const presentationSource = rendererSource.slice(
    rendererSource.indexOf("function updateProjectTreePresentation"),
    rendererSource.indexOf("function buildProjectOrganizationTree")
  );
  const renderSessionsSource = rendererSource.slice(
    rendererSource.indexOf("function renderSessions"),
    rendererSource.indexOf("const TASK_PHASES")
  );

  assert.match(presentationSource, /markSessionRead\(state\.selectedSessionId\);/);
  assert.match(renderSessionsSource, /markSessionRead\(state\.selectedSessionId\);/);
});

test("session read revisions only depend on stable execution identity and terminal state", () => {
  const revisionSource = rendererSource.slice(
    rendererSource.indexOf("function sessionRevision"),
    rendererSource.indexOf("function sessionNoticeRevision")
  );

  assert.match(revisionSource, /const executionIdentity = execution\.taskId/);
  assert.match(revisionSource, /return `result-v2:\$\{tone\}:\$\{String\(executionIdentity\)\}`/);
  assert.doesNotMatch(revisionSource, /session\.updatedAt|execution\.finishedAt|execution\.completedAt|state\.db\?\.messages|session\.messages|messages\.length/);
  const unreadSource = rendererSource.slice(
    rendererSource.indexOf("function sessionHasUnreadResult"),
    rendererSource.indexOf("function readSessionDrafts")
  );
  assert.match(unreadSource, /if \(!recordedRevision\.startsWith\("result-v2:"\)\)/);
  assert.match(unreadSource, /sessionReadRevisions\[session\.id\] = revision/);
  assert.match(unreadSource, /return recordedRevision !== revision/);
});

test("narrow screens expose a single-column task workspace and wrapping composer", () => {
  const mobileStart = styles.lastIndexOf("@media (max-width: 700px)");
  const mobileEnd = styles.indexOf("@media (max-height: 720px)", mobileStart);
  const mobile = styles.slice(mobileStart, mobileEnd);
  assert.match(mobile, /\.task-board-file-workspace,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(mobile, /\.task-board-resource-grid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(mobile, /\.task-board-reader,[\s\S]*?min-height:\s*340px;/);
  assert.match(mobile, /\.composer-tools\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
});

test("desktop startup does not collapse the conversation sidebar into icon mode", () => {
  assert.match(styles, /@media \(max-width: 760px\) \{\s*\.app \{ grid-template-columns: 72px minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(styles, /@media \(max-width: 900px\) \{\s*\.app \{ grid-template-columns: 72px minmax\(0, 1fr\); \}/);
});

test("short screens reduce fixed chrome and keep spreadsheets usable", () => {
  const shortScreen = styles.slice(styles.lastIndexOf("@media (max-height: 720px)"));
  assert.match(shortScreen, /\.composer\s*\{[\s\S]*?max-height:\s*210px;/);
  assert.match(shortScreen, /\.task-board-file-workspace,[\s\S]*?min-height:\s*0;/);
  assert.match(shortScreen, /\.spreadsheet-workspace\s*\{[\s\S]*?height:\s*clamp\(300px, calc\(100dvh - 185px\), 620px\);/);
});
