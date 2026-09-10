"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const rendererStyles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("session refresh preserves an active local typewriter row", () => {
  const renderMessages = rendererSource.slice(
    rendererSource.indexOf("async function renderMessages"),
    rendererSource.indexOf("function renderAttachments()")
  );

  assert.match(rendererSource, /const activeAssistantTypings = new Map\(\);/);
  assert.match(rendererSource, /function liveChatStreamOwnsVisibleRow\(entry\)[\s\S]*?!row\?\.isConnected \|\| !messageList\.contains\(row\) \|\| row\.hidden[\s\S]*?rowStreamId === streamId[\s\S]*?rowMessageId === messageId/);
  assert.match(renderMessages, /const activeTyping = activeAssistantTypingForSession\(session\.id\);/);
  assert.match(renderMessages, /const activeStream = activeLiveChatStreamForSession\(session\.id\);/);
  assert.match(renderMessages, /const activeStreamOwnsVisibleRow = liveChatStreamOwnsVisibleRow\(activeStream\);/);
  assert.match(
    renderMessages,
    /if \(\(activeTyping \|\| activeStreamOwnsVisibleRow\) && !sessionChanged\) \{[\s\S]*?requestAnimationFrame\(updateReadingControls\);[\s\S]*?\} else if \(!sessionChanged && renderedMessageWindowMatches\(visibleMessages\)\)[\s\S]*?mutatePreservingMessageViewport\(\(\) => messageList\.replaceChildren\(fragment\)\);/
  );
});

test("persisted session refreshes cannot discard a locally owned response reveal", () => {
  const handler = rendererSource.slice(
    rendererSource.indexOf("api.onSessionChanged((db) =>"),
    rendererSource.indexOf("api.init().then", rendererSource.indexOf("api.onSessionChanged((db) =>"))
  );
  const preservation = handler.slice(
    handler.indexOf("const preservesLiveConversation"),
    handler.indexOf("if (preservesLiveConversation)")
  );
  assert.match(handler, /sessionTaskQueue\.isActive\(session\.id\)/);
  assert.match(handler, /activeLiveChatStreamForSession\(session\.id\)/);
  assert.match(handler, /activeAssistantTypingForSession\(session\.id\)/);
  assert.match(handler, /if \(selectedLiveStream && !liveStreamOwnsCurrentView\) \{[\s\S]*?discardLiveChatStream\(selectedLiveStream\.streamId, \{ reason: "detached_session_row" \}\);/);
  assert.match(preservation, /liveStreamOwnsCurrentView/);
  assert.doesNotMatch(preservation, /activeSendOwners/);
});

test("final answer commit never waits for decorative execution animation", () => {
  const finalize = rendererSource.slice(
    rendererSource.indexOf("function finalizeLiveChatStream"),
    rendererSource.indexOf("function discardLiveChatStreamsForSession")
  );

  assert.doesNotMatch(rendererSource, /function executionActivityFlowIsPending/);
  assert.doesNotMatch(finalize, /executionActivityFlowIsPending|setTimeout\(applyCompletedRow, 80\)/);
  assert.match(finalize, /const applyCompletedRow = \(\) => \{[\s\S]*?entry\.finalized = true;/);
});

test("a direct assistant reply reconciles in place without a completion render", () => {
  assert.match(rendererSource, /typingSessionId: message\.role === "assistant" \? session\.id : ""/);
  assert.match(rendererSource, /activeAssistantTypings\.set\(typingSessionId, typingEntry\);/);
  assert.match(rendererSource, /if \(typingEntry\) completeAssistantTyping\(typingSessionId, typingEntry\);/);
  const completeTyping = rendererSource.slice(
    rendererSource.indexOf("function completeAssistantTyping"),
    rendererSource.indexOf("function appendTypingCharacters")
  );
  assert.match(completeTyping, /state\.lastMessageSignature = entry\.pendingSignature/);
  assert.doesNotMatch(completeTyping, /renderAll|requestAnimationFrame/);
});

test("Black Ball final is the only visible narrative while presentation stays semantic", () => {
  assert.match(rendererSource, /const useTypingAnimation = message\.role === "assistant" && options\.progressive === true && Boolean\(displayText\);/);
  assert.match(rendererSource, /rendered\.innerHTML = renderMarkdown\(displayText\);/);
  assert.match(rendererSource, /const deliveredFiles = taskPresentation[\s\S]*?structuredPresentationFiles\(taskPresentation\.files, messageFiles\)/);
  assert.doesNotMatch(rendererSource, /createStructuredTaskResult|task-result-supplement/);
  assert.match(rendererSource, /actions: presentation \? presentationSuggestionActions\(presentation\) : \[\]/);
  const addMessage = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );
  assert.match(addMessage, /const suggestionEligible = options\.suggestionEligible === true;/);
  assert.match(addMessage, /showFreshComposerSuggestions\(message/);
  assert.match(rendererSource, /suggestionEligible: false/);
  assert.doesNotMatch(addMessage, /bubble\.appendChild\(presentationActionBar\)|task-result-actions/);
  const finalize = rendererSource.slice(
    rendererSource.indexOf("function finalizeLiveChatStream"),
    rendererSource.indexOf("function discardLiveChatStreamsForSession")
  );
  assert.doesNotMatch(finalize, /!hasStructuredPresentation/);
});

test("live replies bind persisted response identity to the originating client message", () => {
  assert.match(rendererSource, /clientMessageId: userMessage\.id,[\s\S]*?responseMessageId: `product-result:\$\{userMessage\.id\}`/);
  assert.match(rendererSource, /message\?\.raw\?\.productResult\?\.responseMessageId/);
});

test("local typewriter output never forces the saved reading position", () => {
  assert.doesNotMatch(rendererSource, /anchorStart: message\.role === "assistant"/);
  assert.match(rendererSource, /followOutput: false,[\s\S]*?manualOutputPause: true/);
  assert.match(rendererSource, /if \(options\.follow !== false && state\.followOutput\) scrollMessagesToBottom\(\);/);
  assert.match(rendererSource, /onProgress:\s*\(\) => \{\s*if \(target === messageList && state\.followOutput\) scheduleStreamingScroll\(\);/);
});

test("manual upward scrolling pauses output following until the reader returns to the bottom", () => {
  assert.match(rendererSource, /manualOutputPause: true/);
  assert.match(rendererSource, /function pauseOutputFollowing\(\)/);
  assert.match(rendererSource, /state\.followOutput = false;\s*state\.manualOutputPause = true;/s);
  assert.match(rendererSource, /messageList\?\.addEventListener\("wheel", \(event\) => \{[\s\S]*?if \(event\.deltaY < 0\) pauseOutputFollowing\(\);/s);
  assert.match(rendererSource, /messageList\?\.addEventListener\("scroll", \(\) => \{[\s\S]*?if \(nearBottom && \(!state\.manualOutputPause \|\| scrollDelta > 1\)\) \{[\s\S]*?state\.followOutput = true;[\s\S]*?state\.manualOutputPause = false;/);
  assert.match(rendererSource, /\} else \{\s*state\.followOutput = false;\s*state\.manualOutputPause = true;/);
});

test("automatic scrolling runs only while bottom-anchored and the new-output action restores that anchor", () => {
  assert.match(rendererSource, /function scrollMessagesToBottom\(\)/);
  assert.match(rendererSource, /if \(!state\.followOutput \|\| state\.manualOutputPause\) return;/);
  assert.match(rendererSource, /if \(!messageList \|\| !state\.followOutput \|\| state\.manualOutputPause \|\| streamingScrollFrame\) return;/);
  assert.match(rendererSource, /function jumpMessagesToBottom\(\)[\s\S]*?state\.followOutput = true;[\s\S]*?state\.manualOutputPause = false;[\s\S]*?applyMessageScrollPosition\(null, \{ fallbackToBottom: true \}\);/);
});

test("directory focus persists until manual scrolling has been idle for two seconds", () => {
  assert.match(rendererSource, /function focusLongReplySection\(row, heading\)/);
  assert.match(rendererSource, /anchorElement\.classList\.add\("long-reply-section-focus"\)/);
  assert.doesNotMatch(rendererSource, /section\.forEach\(\(node\) => node\.classList\.add\("long-reply-section-focus"\)\)/);
  assert.match(rendererSource, /function clearLongReplySectionFocus\(\)/);
  assert.match(rendererSource, /focusLongReplySection\(row, heading\);[\s\S]*?messageList\.scrollTo\(/);
  assert.match(rendererSource, /LONG_REPLY_FOCUS_SCROLL_SETTLE_MS = 2000/);
  assert.match(rendererSource, /function scheduleLongReplySectionFocusClear\(\)[\s\S]*?setTimeout\([\s\S]*?LONG_REPLY_FOCUS_SCROLL_SETTLE_MS/);
  assert.match(rendererSource, /state\.programmaticScrollUntil = Date\.now\(\) \+ 1200;[\s\S]*?messageList\.scrollTo\(/);
  assert.match(rendererSource, /if \(state\.longReplyFocusRow && Math\.abs\(scrollDelta\) > 0\.5\) \{\s*scheduleLongReplySectionFocusClear\(\);/);
  const wheelHandler = rendererSource.slice(
    rendererSource.indexOf('messageList?.addEventListener("wheel"'),
    rendererSource.indexOf('messageList?.addEventListener("touchmove"')
  );
  assert.doesNotMatch(wheelHandler, /clearLongReplySectionFocus\(\)/);
  assert.match(wheelHandler, /noteLongReplyManualScroll\(\)/);
  assert.match(rendererSource, /messageList\?\.addEventListener\("touchmove", noteLongReplyManualScroll/);
  const focusStyles = rendererStyles.match(/\.long-reply-section-focus\s*\{[^}]*\}/)?.[0] || "";
  assert.match(focusStyles, /--section-focus-color:\s*#c77a18;/);
  assert.match(focusStyles, /background:\s*linear-gradient/);
  assert.doesNotMatch(focusStyles, /outline:/);
  assert.match(rendererStyles, /\.long-reply-section-focus::before\s*\{[\s\S]*?left: -14px;[\s\S]*?width: 3px;/);
  const focusFunction = rendererSource.slice(
    rendererSource.indexOf("function focusLongReplySection"),
    rendererSource.indexOf("function scheduleLongReplySectionFocusClear")
  );
  assert.doesNotMatch(focusFunction, /setTimeout|longReplyFocusUntil/);
});

test("execution details stay neutral while the theater uses its own non-blue character palette", () => {
  assert.match(rendererStyles, /\.execution-activity-details\s*\{[\s\S]*?color: #5f6368;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?--theater-ink: #56525b;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?--theater-friend: #2f7658;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?--theater-comedy: #c94f5a;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?text-shadow: none;/);
  assert.doesNotMatch(rendererStyles.match(/\.execution-activity-inline-theater\s*\{[\s\S]*?\n\}/)?.[0] || "", /var\(--accent\)/);
  assert.match(rendererStyles, /body\[data-color-scheme="dark"\] \.execution-activity-inline-theater/);
  assert.doesNotMatch(rendererStyles, /body:not\(\[data-skin="white"\]\) \.execution-activity-inline-theater/);
  assert.match(rendererSource, /document\.body\.dataset\.colorScheme = browserTheme\.scheme;/);
  assert.match(rendererStyles, /\.execution-activity-whimsy\s*\{[\s\S]*?color: inherit;/);
  assert.match(rendererStyles, /\.execution-activity-flow\[data-activity-state="waiting"\] \.execution-activity-line:last-child \.execution-activity-line-text::after\s*\{[\s\S]*?color: #8a8e94;/);
  assert.match(rendererStyles, /\.streaming-activity\s*\{[\s\S]*?color: #111;/);
  assert.match(rendererStyles, /\.streaming-elapsed\s*\{\s*color: #111;/);
  assert.match(rendererSource, /lastExecutionActivityWhimsyIndex/);
  assert.match(rendererSource, /index !== lastExecutionActivityWhimsyIndex/);
});

test("composing preserves the reading position and sending anchors the new instruction", () => {
  const inputHandler = rendererSource.slice(
    rendererSource.indexOf('chatInput.addEventListener("input"'),
    rendererSource.indexOf("async function checkAndShowRecommendBadge")
  );
  assert.doesNotMatch(inputHandler, /scrollMessagesToBottom/);
  const sendCurrentTask = rendererSource.slice(
    rendererSource.indexOf("async function sendCurrentTask"),
    rendererSource.indexOf("async function processQueue")
  );
  assert.doesNotMatch(sendCurrentTask, /taskShouldStayAtBottom/);
  assert.match(sendCurrentTask, /const userRow = addVisibleMessage\(userMessage\);/);
  assert.match(sendCurrentTask, /anchorNewInstruction\(userRow\);/);
  assert.match(sendCurrentTask, /const userRow = addVisibleMessage\(userMessage\);[\s\S]*?adjustComposerHeight\(\);[\s\S]*?anchorNewInstruction\(userRow\);[\s\S]*?await api\.appendMessage\(session\.id, userMessage\);/);
  assert.match(rendererSource, /instructionAnchors: new Map\(\)/);
  assert.match(rendererSource, /pendingUserMessages: new Map\(\)/);
  assert.match(rendererSource, /function mergePendingUserMessages\(sessionId, messages = \[\]\)/);
  assert.match(sendCurrentTask, /rememberPendingUserMessage\(session\.id, userMessage\);/);
  assert.match(rendererSource, /function messageRowForId\(messageId = ""\)/);
  assert.match(rendererSource, /function applyInstructionAnchor\(sessionId = state\.selectedSessionId, \{ reposition = false \} = \{\}\)[\s\S]*?ensureInstructionAnchorSpace\(row\);[\s\S]*?if \(reposition\) positionInstructionAnchor\(row, anchor\.targetOffset\);/);
  assert.match(rendererSource, /function anchorNewInstruction\(row\)[\s\S]*?state\.instructionAnchors\.set\(sessionId, \{[\s\S]*?targetOffset: INSTRUCTION_ANCHOR_TOP_GAP,[\s\S]*?locked: true,[\s\S]*?state\.followOutput = false;[\s\S]*?state\.manualOutputPause = true;[\s\S]*?ensureInstructionAnchorSpace\(anchorRow\);[\s\S]*?animateInstructionAnchor\(anchorRow, INSTRUCTION_ANCHOR_TOP_GAP\);[\s\S]*?scheduleInstructionAnchor\(sessionId\);/);
  assert.doesNotMatch(rendererSource, /animateInstructionToStart|instructionScrollAnimationFrame/);
  assert.match(rendererSource, /function scrollMessageToStart\(row, behavior = "auto"[\s\S]*?if \(behavior === "auto"\) \{[\s\S]*?messageList\.style\.scrollBehavior = "auto";[\s\S]*?messageList\.scrollTop = targetTop;/);
  assert.match(rendererSource, /messageList\.dataset\.instructionAnchored = "1";/);
  assert.match(rendererSource, /delete messageList\.dataset\.instructionAnchored;/);
  assert.match(rendererStyles, /\.message-list\[data-instruction-anchored="1"\]\s*\{[\s\S]*?overflow-anchor: none;[\s\S]*?scroll-behavior: auto;/);
  assert.match(rendererSource, /function ensureInstructionAnchorSpace\(row, \{ minimumScrollTop = 0 \} = \{\}\)[\s\S]*?instruction-anchor-space[\s\S]*?messageList\.lastElementChild !== spacer\) messageList\.appendChild\(spacer\);/);
  const spacerBody = rendererSource.slice(
    rendererSource.indexOf("function ensureInstructionAnchorSpace"),
    rendererSource.indexOf("function clearInstructionAnchor")
  );
  assert.doesNotMatch(spacerBody, /messageList\.scrollTop\s*=/);
  assert.match(rendererSource, /function clearInstructionAnchor\(sessionId = state\.selectedSessionId\)/);
  const renderMessages = rendererSource.slice(
    rendererSource.indexOf("async function renderMessages"),
    rendererSource.indexOf("function renderAttachments")
  );
  assert.match(renderMessages, /if \(hasInstructionAnchor\) \{[\s\S]*?const anchorLocked = instructionAnchorPositionLocked\(session\.id\);[\s\S]*?const anchorLayoutChanged = sessionChanged \|\| messagesReplaced;[\s\S]*?applyInstructionAnchor\(session\.id, \{ reposition: anchorLocked && anchorLayoutChanged \}\);/);
  assert.match(renderMessages, /const visibleMessages = mergePendingUserMessages\(session\.id, messages\);/);
  assert.match(rendererSource, /function scheduleInstructionAnchor\(sessionId = state\.selectedSessionId\)/);
  assert.match(rendererSource, /function mutatePreservingMessageViewport\(mutation\)/);
  assert.match(rendererSource, /const anchorOffset = anchor\?\.isConnected \? anchor\.getBoundingClientRect\(\)\.top - listTop : null;/);
  assert.match(rendererSource, /const targetScrollTop = Math\.max\(0, messageList\.scrollTop \+ anchorDelta\);[\s\S]*?messageList\.scrollTop = targetScrollTop;/);
  assert.match(rendererSource, /if \(messageLayoutTransactionDepth > 0\) \{\s*mutation\(\);\s*return;\s*\}/);
  assert.match(rendererSource, /if \(instructionAnchorPositionLocked\(state\.selectedSessionId\)\) applyInstructionAnchor\(state\.selectedSessionId\);/);
  assert.match(rendererSource, /new MutationObserver\(\(\) => \{[\s\S]*?scheduleInstructionAnchor\(state\.selectedSessionId\);[\s\S]*?\}\)\.observe\(messageList, \{ childList: true, subtree: true, characterData: true \}\);/);
  assert.match(rendererSource, /function clearInstructionAnchor\(sessionId = state\.selectedSessionId\)[\s\S]*?removeInstructionAnchorSpace\(\);/);
  assert.match(rendererSource, /let messageRenderEpoch = 0;/);
  assert.match(rendererSource, /async function renderMessages\([^)]*\)[\s\S]*?const renderEpoch = \+\+messageRenderEpoch;[\s\S]*?renderEpoch !== messageRenderEpoch/);
  assert.match(rendererSource, /const hasInstructionAnchor = Boolean\(instructionAnchorId\(session\.id\)\);[\s\S]*?if \(sessionChanged && !hasInstructionAnchor\) \{[\s\S]*?restoreSessionScrollPosition\(session\.id\);[\s\S]*?messagesReplaced && renderPosition && !hasInstructionAnchor/);
  assert.match(renderMessages, /const anchoredPosition = renderPosition \|\| \(sessionChanged \? savedSessionPosition : null\);[\s\S]*?messagesReplaced && anchoredPosition && !anchorLocked[\s\S]*?applyMessageScrollPosition\(anchoredPosition, \{ keepInstructionAnchor: true \}\);/);
  assert.match(rendererSource, /function releaseInstructionAnchorPosition\(sessionId = state\.selectedSessionId\)[\s\S]*?anchor\.locked = false;/);
  assert.match(rendererSource, /messageList\?\.addEventListener\("wheel", \(event\) => \{[\s\S]*?releaseInstructionAnchorPosition\(state\.selectedSessionId\);/);
  assert.match(rendererSource, /function createThinkingMessage\(_label = "", options = \{\}\)[\s\S]*?const instructionIsAnchored = Boolean\(instructionAnchorId\(state\.selectedSessionId\)\);[\s\S]*?if \(instructionIsAnchored\)[\s\S]*?state\.followOutput = false;[\s\S]*?state\.manualOutputPause = true;[\s\S]*?else if \(options\.follow !== false\) \{[\s\S]*?scrollMessagesToBottom\(\);/);
});

test("a running request persists its user message before waiting for a result", () => {
  const sendCurrentTask = rendererSource.slice(
    rendererSource.indexOf("async function sendCurrentTask"),
    rendererSource.indexOf("async function processQueue")
  );
  assert.match(sendCurrentTask, /id: globalThis\.crypto\?\.randomUUID\?\.\(\)/);
  assert.match(sendCurrentTask, /createdAt: Date\.now\(\)/);
  assert.match(sendCurrentTask, /addVisibleMessage\(userMessage\);[\s\S]*?await api\.appendMessage\(session\.id, userMessage\);/);
  assert.equal((sendCurrentTask.match(/await api\.appendMessage\(session\.id, userMessage\);/g) || []).length, 1);
  assert.match(sendCurrentTask, /clientMessageId: userMessage\.id/);
});

test("a running session without a live renderer stream still shows an execution indicator", () => {
  const motion = rendererSource.slice(
    rendererSource.indexOf("function ensureSessionExecutionMotion"),
    rendererSource.indexOf("function finalizeLiveChatStream")
  );
  assert.match(motion, /createThinkingMessage\("", \{/);
  assert.doesNotMatch(motion, /createThinkingMessage\("任务仍在执行"/);
  assert.doesNotMatch(motion, /切换到其他会话/);
  assert.match(motion, /sessionExecutionIndicators\.set\(session\.id, indicator\);/);
});

test("active response headers keep all real execution events behind a compact three-line view", () => {
  assert.match(rendererSource, /const EXECUTION_STAGE_LABELS = Object\.freeze\(\{[\s\S]*?understanding: "\u6b63\u5728\u7406\u89e3"[\s\S]*?executing: "\u6b63\u5728\u6267\u884c"[\s\S]*?typing: "\u6b63\u5728\u8f93\u5165"[\s\S]*?completed: "\u6267\u884c\u5b8c\u6bd5"/);
  assert.match(rendererSource, /root\.dataset\.executionStage = normalized;/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_QUEUE_LIMIT = 32;/);
  assert.doesNotMatch(rendererSource, /EXECUTION_ACTIVITY_HISTORY_LIMIT/);
  assert.match(rendererSource, /flow\.queue = \[\.\.\.flow\.queue, detail\]\.slice\(-EXECUTION_ACTIVITY_QUEUE_LIMIT\);/);
  assert.match(rendererSource, /function uniqueExecutionActivityEntries\(details = \[\], fallbackTimestamp = Date\.now\(\)\)/);
  assert.match(rendererSource, /Number\.POSITIVE_INFINITY/);
  assert.doesNotMatch(rendererSource, /黑球仍在运行 ·/);
  assert.match(rendererSource, /function activityIsTransient\(activity = ""\)/);
  assert.match(rendererSource, /const transient = activityIsTransient\(activity\);/);
  assert.match(rendererSource, /entry\.activityTransient = transient;/);
});

test("real execution uses deterministic action narration and keeps raw details expandable", () => {
  assert.match(rendererSource, /function activityDetailText\(activity = ""\)[\s\S]*?return value\.slice\(0, 20000\);/);
  assert.match(rendererSource, /function mergeExecutionNarrativeEntries\(details = \[\]\)/);
  assert.match(rendererSource, /String\(entry\.publicActionId \|\| entry\.toolCallId \|\| ""\)/);
  assert.match(rendererSource, /if \(existingIndex >= 0\) merged\[existingIndex\] = entry;/);
  assert.match(rendererSource, /function executionNarrativeMustStayVisible\(entry, summaries = \[\]\)/);
  assert.match(rendererSource, /actionIds\.size >= 2/);
  assert.match(rendererSource, /summaries\.some\(\(item\) => item\.publicSummarySalient === true\)/);
  assert.match(rendererSource, /function completedExecutionNarrativeEntries\(details = \[\]\)/);
  assert.match(rendererSource, /execution-completed-narrative/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3;/);
  assert.doesNotMatch(rendererSource, /const expanded = \{/);
  assert.match(rendererSource, /function paintExecutionActivityFrame\(root, now = performance\.now\(\)\)/);
  assert.match(rendererSource, /flow\.activeChars = Array\.from\(activityDetailDisplayText\(next\)\);/);
  assert.match(rendererSource, /flow\.activeTextNode\?\.replaceChildren\(\);/);
  assert.match(rendererSource, /appendTypingCharacters\(flow\.activeTextNode, nextChars\);/);
  assert.match(rendererSource, /assistantTypingCharsPerSecond\(flow\.activeChars\.length\)/);
  assert.doesNotMatch(rendererSource, /while \(beginNextExecutionActivity\(flow, root, now\)\)/);
  assert.match(rendererSource, /scrollExecutionActivityToLatest\(flow\.viewport\)/);
  assert.match(rendererStyles, /\.execution-activity-details\s*\{[\s\S]*?max-height: 51px;[\s\S]*?overflow-y: hidden;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?height: 24px;[\s\S]*?overflow: visible;[\s\S]*?white-space: nowrap;/);
  assert.match(rendererStyles, /\.thinking-label,[\s\S]*?\.streaming-elapsed\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/);
  assert.match(rendererStyles, /\.streaming-activity\s*\{[\s\S]*?width: min\(680px, 100%\);/);
  assert.match(rendererSource, /function textTheaterTinyInlineParts\(event\)/);
  assert.match(rendererSource, /return textTheaterTinyInlineParts\(event\);/);
  assert.match(rendererStyles, /\[data-activity-expanded="1"\] \.execution-activity-details\s*\{[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
  assert.match(rendererSource, /function bindExecutionActivityToggle\(root\)/);
  assert.match(rendererSource, /detailCount \|\| 0\) > 0/);
  const thinkingMessage = rendererSource.slice(
    rendererSource.indexOf("function createThinkingMessage"),
    rendererSource.indexOf("function removeThinkingMessage")
  );
  const runningHeader = rendererSource.slice(
    rendererSource.indexOf("function streamActivityHtml"),
    rendererSource.indexOf("function updateLiveStreamElapsed")
  );
  assert.match(rendererSource, /function executionActivityEntry\(activity = "", fallbackTimestamp = Date\.now\(\)\)/);
  assert.match(rendererSource, /function activityDetailDisplayText\(activity = ""\)/);
  assert.match(rendererSource, /function executionActivityEntry\(activity = "", fallbackTimestamp = Date\.now\(\)\)/);
  assert.match(rendererSource, /publicSummary: String\(progress\.publicSummary \|\| ""\)/);
  assert.match(thinkingMessage, /streamActivityHtml\(executionStage/);
  assert.match(runningHeader, /executionActivityDetailsHtml\(visibleDetails,/);
  assert.match(rendererSource, /function executionActivityDetailsHtml\(details = \[\], options = \{\}\)[\s\S]*?EXECUTION_ACTIVITY_VISIBLE_LIMIT[\s\S]*?executionActivityToggleHtml\(history\.length, options\.expanded === true\)[\s\S]*?execution-activity-shell[\s\S]*?execution-activity-details[\s\S]*?execution-activity-flow/);
  assert.match(runningHeader, /execution-activity-head[\s\S]*?executionActivityToggleHtml\(visibleDetails\.length, false\)[\s\S]*?streaming-elapsed/);
  assert.match(runningHeader, /execution-activity-narrative streaming-structured-result/);
  assert.match(rendererSource, /execution-activity-shell[\s\S]*?execution-reasoning-flow/);
  assert.match(rendererSource, /function executionActivityToggleHtml\(detailCount = 0, expanded = false\)/);
  assert.match(rendererSource, /root\.dataset\.activityExpanded = expanded \? "1" : "0"/);
  assert.match(rendererSource, /root\.dataset\.activityToggleBound === "1"/);
  assert.match(rendererSource, /root\.addEventListener\("click", \(event\) => \{[\s\S]*?event\.target\?\.closest\?\.\("\.execution-activity-toggle"\)/);
  assert.match(rendererSource, /toggle\.closest\("\.streaming-activity, \.thinking-message"\) !== root/);
  assert.match(rendererSource, /mutatePreservingMessageViewport\(\(\) => \{[\s\S]*?root\.dataset\.activityExpanded = expanded \? "1" : "0";/);
  assert.doesNotMatch(rendererSource, /const toggle = index === 0/);
  assert.match(rendererSource, /function executionActivityToggleHtml\(detailCount = 0, expanded = false\)/);
  assert.match(rendererSource, /<span aria-hidden="true"><\/span>/);
  assert.match(rendererSource, /收回执行过程/);
  assert.match(rendererSource, /execution-activity-line-text/);
  assert.match(rendererStyles, /\.execution-activity-bars\s*\{[\s\S]*?flex: 0 0 18px;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?font-weight: 550;/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_THEATER_ENABLED = false;/);
  assert.doesNotMatch(rendererSource, /execution-activity-divider|｜|✨/);
  const executionToggleStyles = rendererStyles.slice(
    rendererStyles.indexOf(".execution-activity-toggle {"),
    rendererStyles.indexOf(".execution-activity-toggle:hover")
  );
  assert.doesNotMatch(executionToggleStyles, /margin-left: auto;/);
  assert.match(executionToggleStyles, /width: 17px;/);
  assert.match(executionToggleStyles, /height: 17px;/);
  assert.match(rendererStyles, /\.execution-activity-toggle > span\s*\{[\s\S]*?width: 6px;[\s\S]*?height: 6px;[\s\S]*?clip-path: polygon\(0 0, 0 100%, 100% 50%\);/);
  assert.match(rendererStyles, /\.execution-activity-toggle\[aria-expanded="true"\] > span\s*\{[\s\S]*?clip-path: polygon\(0 0, 100% 0, 50% 100%\);/);
  assert.match(rendererSource, /function executionActivityViewportIsAtBottom\(viewport, threshold = 2\)/);
  assert.match(rendererSource, /event\.deltaY < 0[\s\S]*?root\.dataset\.activityFollowLatest = "0"/);
  assert.match(rendererSource, /if \(expanded && options\.force !== true && root\.dataset\.activityFollowLatest === "0"\) return;/);
  assert.match(rendererStyles, /\.execution-activity-shell\s*\{[\s\S]*?position: relative;/);
  assert.match(executionToggleStyles, /position: absolute;/);
  assert.match(rendererStyles, /\.execution-activity-line\s*\{[\s\S]*?grid-template-columns: 17px 48px minmax\(0, 1fr\);/);
  assert.match(rendererStyles, /\[data-activity-expanded="1"\] \.execution-activity-line,[\s\S]*?\.execution-activity-line:first-child\s*\{[\s\S]*?grid-template-columns: 34px 48px minmax\(0, 1fr\);/);
  assert.match(rendererSource, /execution-activity-line-time/);
  assert.match(rendererSource, /execution-activity-line-text/);
  assert.match(rendererStyles, /padding-top: 0;/);
  assert.match(rendererStyles, /white-space: pre-wrap/);
  assert.match(rendererStyles, /mask-image: none/);
  assert.doesNotMatch(rendererStyles, /execution-activity-shift-up/);
  assert.doesNotMatch(rendererStyles, /execution-activity-enter/);
});

test("local theater is enabled but cannot become the action narrative", () => {
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_THEATER_ENABLED = true;/);
  const whimsyScheduler = rendererSource.slice(
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy"),
    rendererSource.indexOf("function scrollExecutionActivityToLatest")
  );
  assert.match(whimsyScheduler, /if \(!EXECUTION_ACTIVITY_THEATER_ENABLED\) return;/);
  assert.match(rendererSource, /function paintLiveExecutionNarrative\(entry\)/);
  assert.match(rendererSource, /node\.textContent = item\.publicSummary;/);
  assert.doesNotMatch(rendererSource.slice(
    rendererSource.indexOf("function paintLiveExecutionNarrative"),
    rendererSource.indexOf("function executionActivityProtocolText")
  ), /Math\.random|nextExecutionActivityWhimsy|renderExecutionActivityWhimsyScene/);
  assert.match(rendererSource, /function textTheaterContinuity\(memory = \[\], target = \{\}\)/);
  assert.match(rendererSource, /function chooseTextTheaterRelationship\(target, modeId, context, recentRelationships = \[\], continuity = \{\}\)/);
  const relationshipRules = rendererSource.slice(
    rendererSource.indexOf("const TEXT_THEATER_RELATIONSHIP_RULES"),
    rendererSource.indexOf("const TEXT_THEATER_EXTENSION_CONTRACT")
  );
  assert.match(relationshipRules, /enemy-escape[\s\S]*?behavior: "escape"[\s\S]*?action: "chase"/);
  assert.match(relationshipRules, /enemy-help[\s\S]*?behavior: "request-help"[\s\S]*?action: "assist"/);
  assert.match(relationshipRules, /partner-cooperate[\s\S]*?relation: "cooperate"/);
  assert.match(relationshipRules, /partner-help[\s\S]*?relation: "support"/);
  const userRelationshipRules = relationshipRules.slice(
    relationshipRules.indexOf("user: ["),
    relationshipRules.indexOf("\n  ]\n});", relationshipRules.indexOf("user: ["))
  );
  assert.doesNotMatch(userRelationshipRules, /hostile|enemy-|action: "collision"/);
  assert.match(rendererSource, /function textTheaterLeadCharacter\(\)/);
  assert.match(rendererSource, /function createTextTheaterEntity\(role, entity\)/);
  assert.match(rendererSource, /data-theater-entity="actor"/);
  assert.match(rendererSource, /data-theater-entity="target"/);
  assert.match(rendererSource, /text-theater-live-line/);
  assert.match(rendererSource, /execution-activity-inline-theater/);
  assert.match(rendererSource, /flow\.whimsyNode = whimsy;/);
  assert.match(rendererSource, /flow\.inlineTheater\.replaceChildren\(whimsy\);/);
  assert.match(rendererSource, /flow\.whimsyText = scene\.summary;/);
  assert.doesNotMatch(rendererSource, /flow\.rendered\?\.replaceChildren\(whimsy\)/);
  assert.doesNotMatch(rendererSource.slice(
    rendererSource.indexOf("function renderAnimatedTextTheaterScene"),
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy")
  ), /text-theater-stage|text-theater-caption|grid-template-columns/);
  assert.match(rendererSource, /function startTextTheaterStateMachine\(node, event\)/);
  assert.match(rendererSource, /function applyTextTheaterPhase\(node, phase\)/);
  assert.match(rendererSource, /function stopTextTheaterStateMachine\(node\)/);
  assert.match(rendererSource.slice(
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy"),
    rendererSource.indexOf("function scrollExecutionActivityToLatest")
  ), /renderExecutionActivityWhimsyScene\(root, scene/);
  assert.match(rendererStyles, /\.execution-activity-flow\s*\{[\s\S]*?min-height: 17px;/);
  assert.match(rendererStyles, /\.execution-activity-flow \.text-theater-live-line\s*\{[\s\S]*?display: inline;/);
  assert.match(rendererStyles, /\.execution-activity-flow \.text-theater-entity/);
  assert.match(rendererStyles, /\.execution-activity-flow \.text-theater-effect/);
  assert.doesNotMatch(rendererStyles.slice(
    rendererStyles.indexOf(".execution-activity-flow .text-theater-scene {"),
    rendererStyles.indexOf(".long-reply-section-focus")
  ), /grid-template-columns|minmax\(160px|display:\s*(?:flex|grid)|left:\s*var\(--theater-entity-position/);
  assert.match(rendererStyles, /\.text-theater-motion-layer\s*\{[\s\S]*?position: absolute;/);
  assert.match(rendererStyles, /translate3d\(\s*calc\(var\(--motion-origin-x/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-run/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-hit/);
  assert.match(rendererStyles, /@keyframes text-theater-particle-one/);
  assert.match(rendererStyles, /@keyframes text-theater-entity-impact/);
  assert.match(rendererStyles, /@keyframes text-theater-smoke/);
  assert.match(rendererStyles, /@keyframes text-theater-stars/);
  assert.match(rendererStyles, /@keyframes text-theater-impact-lines/);
  const theaterRender = rendererSource.slice(
    rendererSource.indexOf("function renderAnimatedTextTheaterScene"),
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy")
  );
  assert.doesNotMatch(theaterRender, /text-theater-label|趣味小剧场|【|】/);
  assert.match(theaterRender, /node\.replaceChildren\(line\)/);
  assert.match(rendererSource, /function createTextTheaterMotionLayer\(node\)/);
  assert.match(rendererSource, /function syncTextTheaterMotionLayer\(node\)/);
  assert.match(rendererSource, /function textTheaterMotionPosition\(node, role, state\)/);
  assert.match(rendererSource, /className = "text-theater-motion-effect"/);
  assert.match(rendererSource, /--motion-impact-x/);
  assert.match(rendererSource, /path: paths\.actor\[index\]/);
  assert.match(rendererSource, /path: paths\.target\[index\]/);
  assert.match(rendererSource, /glyph\.textContent = source\.textContent/);
  assert.match(rendererSource, /const TEXT_THEATER_SUMMARY_MAX_CHARS = 48/);
  assert.match(rendererSource, /function textTheaterShortInlineParts\(event\)/);
  assert.match(rendererSource, /function selectTextTheaterInlineParts\(event, availableWidth = 0\)/);
  assert.match(rendererSource, /const parts = selectTextTheaterInlineParts\(event, availableWidth\)/);
  assert.doesNotMatch(rendererSource, /function compactTextTheaterInlineParts/);
  assert.doesNotMatch(theaterRender, /\.slice\(0, textBudget\)/);
  assert.match(rendererSource, /offsetX: 0,[\s\S]*?offsetY: verticalOffsets\[index\]\[0\]/);
  assert.match(rendererSource, /const y = Math\.max\(-2, Math\.min\(2, Number\(state\?\.offsetY \|\| 0\)\)\)/);
  assert.match(rendererStyles, /\.thinking-status > \.execution-activity-head,[\s\S]*?\.streaming-activity > \.execution-activity-head[\s\S]*?display: flex;[\s\S]*?height: 24px;[\s\S]*?min-height: 24px;/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?flex: 0 1 auto;[\s\S]*?width: auto;[\s\S]*?height: 24px;[\s\S]*?max-width: calc\(100% - 30px\);/);
  assert.match(rendererStyles, /\.execution-activity-inline-theater\[data-theater-visible="1"\] \{ visibility: visible; \}/);
  assert.doesNotMatch(rendererStyles, /\.execution-activity-inline-theater\s*\{[\s\S]*?max-width: 280px;/);
  assert.match(rendererSource, /function textTheaterInteraction\(relationship, actor, target\)/);
  assert.match(rendererSource, /flow\.whimsyShownCount \+= 1/);
  assert.match(rendererSource, /whimsyHistory: \[\]/);
  assert.match(rendererSource, /recentSceneIds = memory\.slice\(-4\)/);
  assert.match(rendererSource, /const nonRepeatingFallback = eligible\.filter/);
  assert.match(rendererSource, /nonRepeatingFallback\.length \? nonRepeatingFallback : eligible/);
  assert.match(rendererSource, /profile\.recent = \[/);
  assert.match(rendererSource, /const TEXT_THEATER_ACTION_TIMINGS = Object\.freeze\(/);
  assert.match(rendererSource, /const baseTimings = TEXT_THEATER_ACTION_TIMINGS\[action\]/);
  assert.match(rendererSource, /const tempoBase = modeId === "rest" \? 1\.08 : modeId === "chase" \? 0\.92 : 1;/);
  assert.match(rendererSource, /function executionActivityLineNode\(activity = "", index = 0\)/);
  assert.match(rendererSource, /function replaceExecutionActivityLines\(rendered, details = \[\], options = \{\}\)/);
  assert.match(rendererSource, /function restoreExecutionActivityText\(flow\)[\s\S]*?replaceExecutionActivityLines\(flow\.rendered, details, \{ detailCount:/);
  assert.match(rendererSource, /const flow = root\.__executionActivityFlow;\s*if \(flow\) flow\.renderedDetails = \[\.\.\.visible\];/);
  assert.match(rendererStyles, /\.text-theater-live-line\s*\{[\s\S]*?white-space: nowrap;/);
  assert.match(rendererSource, /Bug方块/);
  assert.match(rendererSource, /黑球越过文字冲向\{target\}，标点弹了一地/);
  assert.doesNotMatch(rendererSource, /马斯克|铁血战士|奥特曼|赛亚人|唐僧|哪吒|宙斯|齐天大圣/);
  assert.match(rendererSource, /function scheduleExecutionActivityWhimsy\(root\)/);
  assert.match(rendererSource, /const summary = compactTextTheaterEvent\(event\.summary \|\| scene\.theater\?\.story \|\| scene\.label \|\| "黑球正在处理任务。", TEXT_THEATER_SUMMARY_MAX_CHARS\);/);
  assert.match(rendererSource, /function chooseWeightedWhimsyScene\(candidates, profile, context\)/);
  assert.match(rendererSource, /function executionWhimsyPhase\(flow\)/);
  assert.match(rendererStyles, /\.execution-activity-line::before\s*\{[\s\S]*?font-size: 11px;[\s\S]*?line-height: 17px;[\s\S]*?content: "├─";/);
  assert.match(rendererStyles, /\.execution-activity-line:last-child::before\s*\{[\s\S]*?content: "└─";/);
  assert.match(rendererStyles, /@keyframes execution-theater-fade-in/);
  assert.match(rendererSource, /relationship:\s*\{[\s\S]*?behavior: relationship\.behavior/);
  assert.match(rendererSource, /continuity,/);
  assert.match(rendererSource, /position:\s*"inline",[\s\S]*?state:\s*"idle"/);
  assert.match(rendererSource, /phases: buildTextTheaterPhases\(eventAction, relationship, mode\.id\)/);
  assert.match(rendererSource, /\{ id: "idle", at: 0 \}/);
  assert.match(rendererSource, /\{ id: "spawn", at: 80 \}/);
  assert.match(rendererSource, /\{ id: "move", at: 700 \}/);
  assert.match(rendererSource, /\{ id: "interaction", at: 1500 \}/);
  assert.match(rendererSource, /\{ id: "effect", at: 2200 \}/);
  assert.match(rendererSource, /\{ id: "restore", at: 3400 \}/);
  assert.match(rendererSource, /\{ id: "finished", at: 4500 \}/);
  assert.match(rendererSource, /approach: \[0, 120, 940, 1820, 2520, 3650, 4740\]/);
  assert.match(rendererSource, /chase: \[0, 60, 520, 1120, 1680, 2780, 3880\]/);
  assert.doesNotMatch(rendererSource.slice(
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy"),
    rendererSource.indexOf("function scrollExecutionActivityToLatest")
  ), /theaterPhase !== "finished"/);
  const compactTheater = rendererSource.slice(
    rendererSource.indexOf("function renderAnimatedTextTheaterScene"),
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy")
  );
  assert.doesNotMatch(compactTheater, /api\.|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(rendererStyles, /\.text-theater-compact\s*\{[\s\S]*?position: absolute;/);
  assert.match(rendererSource, /function clearExecutionActivityWhimsy\(root\)/);
  assert.match(rendererSource, /localStorage\.setItem\(EXECUTION_ACTIVITY_WHIMSY_PROFILE_KEY/);
  assert.doesNotMatch(rendererSource.slice(
    rendererSource.indexOf("function scheduleExecutionActivityWhimsy"),
    rendererSource.indexOf("function scrollExecutionActivityToLatest")
  ), /api\.|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(rendererSource, /root\.__executionActivityDetails\.push\(line\)/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-scout/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-sprint/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-share/);
  assert.match(rendererStyles, /@keyframes text-theater-motion-drift/);
  assert.match(rendererSource, /const TEXT_THEATER_PARTICLE_GLYPHS = Object\.freeze\(/);
  assert.doesNotMatch(rendererSource.slice(
    rendererSource.indexOf("function createTextTheaterMotionLayer"),
    rendererSource.indexOf("function syncTextTheaterMotionLayer")
  ), /nodeParticle\.textContent = "\*"/);
});

test("user abort preserves the originating instruction with a bound terminal notice", () => {
  assert.match(mainSource, /const interruptedUserMessage = \[\.\.\.currentMessages\]\.reverse\(\)\.find\(\(item\) => item\?\.role === "user"\)/);
  assert.match(mainSource, /id: `product-result:\$\{interruptedUserMessage\.id\}`/);
  assert.match(mainSource, /text: "本轮任务已中断，原任务指令已保留。"/);
  assert.match(mainSource, /interruptionNotice: true/);
  assert.match(mainSource, /productSubmission: true/);
  assert.match(mainSource, /const productCancellationWillPersist = run\?\.productSubmission === true;/);
  assert.match(mainSource, /!productCancellationWillPersist && !currentMessages\.some/);
});

test("local lifecycle details stay synchronized when the thinking row becomes a stream row", () => {
  const thinkingMessage = rendererSource.slice(
    rendererSource.indexOf("function createThinkingMessage"),
    rendererSource.indexOf("function removeThinkingMessage")
  );
  assert.match(thinkingMessage, /const initialThinkingText = String\(_label \|\| ""\)\.trim\(\);/);
  assert.match(thinkingMessage, /if \(options\.waiting === true\)[\s\S]*?waiting\.textContent = String\(_label \|\| "等待黑球真实执行事件"\)/);
  assert.doesNotMatch(thinkingMessage, /pushExecutionActivityDetail/);
  assert.match(rendererSource, /thinkingRow = createThinkingMessage\("", \{[\s\S]*?startedAt: taskStartedAt,[\s\S]*?waiting: true/);
  assert.match(rendererSource, /registerLiveChatStream\(streamId, session\.id, thinkingRow/);
  assert.match(rendererSource, /message: frame\.progress\.message \|\| frame\.label \|\| ""/);
  assert.match(rendererSource, /stopExecutionActivityFlow\(entry\.activity/);
});

test("live response stages advance from understanding through execution and typing to completion", () => {
  assert.match(rendererSource, /setLiveStreamStage\(entry, "understanding", \{ force: true \}\)/);
  assert.match(rendererSource, /setLiveStreamStage\(entry, executionStageForActivity\(activity\)\)/);
  assert.match(rendererSource, /setLiveStreamStage\(entry, "typing"\)/);
  assert.match(rendererSource, /entry\.backendCompleted = true/);
  assert.match(rendererSource, /setLiveStreamStage\(entry, "completed"\)/);
  assert.match(rendererSource, /EXECUTION_STAGE_ORDER\[next\] < EXECUTION_STAGE_ORDER\[current\]/);
  const activityStage = rendererSource.slice(
    rendererSource.indexOf("function executionStageForActivity"),
    rendererSource.indexOf("function paintExecutionStage")
  );
  assert.doesNotMatch(activityStage, /status === "completed"/);
  assert.doesNotMatch(activityStage, /return "completed"/);
  assert.match(rendererSource, /entry\.completionTimer = setTimeout\(applyCompletedRow, 80\)/);
  assert.match(rendererSource, /else if \(entry\.backendCompleted\) \{[\s\S]*?setLiveStreamStage\(entry, "completed"\);[\s\S]*?entry\.finalizeWhenDrained\?\.\(\);/);
  assert.match(rendererSource, /entry\.completionTimer = null;[\s\S]*?liveChatStreams\.delete\(streamId\);/);
});

test("the live grounded narrative is mounted before the growing response body", () => {
  const ensureRow = rendererSource.slice(
    rendererSource.indexOf("function ensureLiveStreamRow"),
    rendererSource.indexOf("function flushLiveChatStream")
  );
  assert.match(ensureRow, /const thinkingRow = entry\.thinkingRow\?\.isConnected \? entry\.thinkingRow : null;/);
  assert.match(ensureRow, /mutatePreservingMessageViewport\(\(\) => \{/);
  assert.match(ensureRow, /activityRoot\.classList\.remove\("thinking-status"\);[\s\S]*?activityRoot\.classList\.add\("streaming-activity"\);/);
  assert.doesNotMatch(ensureRow, /removeThinkingMessage\(entry\.thinkingRow\)/);
  const streamActivity = rendererSource.slice(
    rendererSource.indexOf("function streamActivityHtml"),
    rendererSource.indexOf("function updateLiveStreamElapsed")
  );
  assert.match(streamActivity, /execution-activity-head[\s\S]*?executionActivityToggleHtml\(visibleDetails\.length, false\)[\s\S]*?execution-activity-narrative streaming-structured-result[\s\S]*?execution-activity-shell[\s\S]*?execution-reasoning-flow[\s\S]*?executionActivityDetailsHtml\(visibleDetails/);
  assert.match(rendererSource, /function createThinkingMessage[\s\S]*?streamActivityHtml\(executionStage/);
  assert.match(rendererStyles, /\.message\.streaming-response > \.bubble \{[\s\S]*?grid-template-rows: auto minmax\(0, auto\)/);
  assert.match(rendererStyles, /\.thinking-status > \.execution-activity-head,[\s\S]*?\.streaming-activity > \.execution-activity-head[\s\S]*?display: flex;[\s\S]*?height: 24px;[\s\S]*?min-height: 24px;/);
  assert.match(rendererStyles, /\.execution-activity-narrative,[\s\S]*?\.execution-event-narrative\s*\{[\s\S]*?font-family: var\(--font-structured-result\);[\s\S]*?font-size: 11px;/);
  assert.match(rendererStyles, /\.streaming-activity:not\(\[data-activity-expanded="1"\]\) \.execution-activity-details\s*\{[\s\S]*?display: none;/);
});

test("completed responses retain duration and the expandable execution timeline", () => {
  const completionCollapse = rendererSource.slice(
    rendererSource.indexOf("function collapseCompletedExecutionActivity"),
    rendererSource.indexOf("function streamActivityHtml")
  );
  assert.match(rendererSource, /function collapseCompletedExecutionActivity\(root, elapsedMs = 0, details = \[\]\)/);
  assert.match(completionCollapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(completionCollapse, /root\.dataset\.lifecycle = "completed"/);
  assert.doesNotMatch(completionCollapse, /execution-completion-count/);
  assert.match(completionCollapse, /streaming-elapsed/);
  assert.match(completionCollapse, /executionActivityRenderedDetails\(root, history\)/);
  assert.doesNotMatch(completionCollapse, /execution-activity-duration-only/);
  assert.match(rendererSource, /collapseCompletedExecutionActivity\(entry\.activity, completedDurationMs, \[[\s\S]*?entry\.activityDetails[\s\S]*?entry\.structuredEvents/);
  assert.doesNotMatch(completionCollapse, /replaceChildren|replaceWith/);
});

test("completed progress still clears the running indicator", () => {
  assert.match(rendererSource, /setLiveStreamStage\(entry, "completed"\)/);
  assert.match(rendererSource, /entry\.finalizeWhenDrained = applyCompletedRow/);
  assert.match(rendererSource, /stopExecutionActivityFlow\(entry\.activity\)/);
  assert.doesNotMatch(rendererStyles, /completed-execution-activity/);
});

test("persisted assistant replies rebuild the real execution timeline", () => {
  const addMessage = rendererSource.slice(
    rendererSource.indexOf("function addMessage"),
    rendererSource.indexOf("function activityDetailText")
  );
  assert.match(addMessage, /const persistedExecution = renderPersistedExecutionTimeline\(message\);/);
  assert.match(addMessage, /renderPersistedSegmentPairs\(message, rendered\);[\s\S]*?if \(persistedExecution\) bubble\.appendChild\(persistedExecution\);/);
  assert.match(rendererSource, /function renderPersistedExecutionTimeline\(message = \{\}\)/);
  const persist = rendererSource.slice(
    rendererSource.indexOf("const persistAssistantResult"),
    rendererSource.indexOf("try {", rendererSource.indexOf("const persistAssistantResult"))
  );
  assert.match(persist, /durationMs: Math\.max\(1, Date\.now\(\) - taskStartedAt, messageDurationMs\(message\)\)/);
});

test("send preflight failures persist a stable terminal response for the originating user message", () => {
  const sendCurrentTask = rendererSource.slice(
    rendererSource.indexOf("async function sendCurrentTask"),
    rendererSource.indexOf("async function processQueue")
  );
  assert.match(sendCurrentTask, /try \{[\s\S]*?addVisibleMessage\(userMessage\);[\s\S]*?createThinkingMessage[\s\S]*?await api\.appendMessage\(session\.id, userMessage\);/);
  assert.match(sendCurrentTask, /const existingStreamId = activeSendOwners\.get\(session\.id\);[\s\S]*?if \(existingStreamId\) \{/);
  assert.match(sendCurrentTask, /sessionTaskQueue\.enqueue\(session\.id, \{[\s\S]*?autoStart: false/);
  assert.doesNotMatch(sendCurrentTask, /taskFingerprint|activeSendFingerprints|避免重复提交/);
  assert.match(sendCurrentTask, /thinkingRow = createThinkingMessage\("", \{[\s\S]*?startedAt: taskStartedAt,[\s\S]*?waiting: true/);
  assert.match(sendCurrentTask, /const message = taskFailureText\(error\);/);
  assert.match(sendCurrentTask, /appendLiveStreamNotice\(liveEntry, `客户端传输失败：\$\{message\}`\)/);
  assert.match(sendCurrentTask, /updateVisibleProgress\("执行失败", 0\)/);
  assert.match(sendCurrentTask, /discardLiveChatStream\(streamId\)/);
  assert.match(sendCurrentTask, /releaseActiveSendOwner\(session\.id, streamId\)/);
});

test("startup reconciliation gives interrupted user requests a visible non-replayed terminal result", () => {
  assert.match(mainSource, /async function reconcileInterruptedMessageDeliveries/);
  assert.match(mainSource, /activeRuns\.has\(session\.id\)/);
  assert.match(mainSource, /id: `product-result:\$\{message\.id\}`/);
  assert.match(mainSource, /APPLICATION_PROCESS_INTERRUPTED/);
  assert.match(mainSource, /void reconcileInterruptedMessageDeliveries\(\)/);
  assert.match(mainSource, /recoveredFromTrace/);
  assert.match(mainSource, /const interruptionEligible =/);
  assert.doesNotMatch(mainSource, /reconcileInterruptedMessageDeliveries[\s\S]{0,120}submitProductWithTaskBrain/);
});

test("assistant code remains visible by default with an explicit collapse control", () => {
  const codeCard = rendererSource.slice(
    rendererSource.indexOf("function enhanceHiddenCodeBlocks"),
    rendererSource.indexOf("function selectedSession")
  );
  assert.match(codeCard, /data-code-toggle aria-expanded="true" aria-label="收起代码" title="收起代码"/);
  assert.match(codeCard, /data-code-copy aria-label="复制代码" title="复制代码"/);
  assert.match(codeCard, /<pre><code><\/code><\/pre>/);
  assert.match(codeCard, /pre\.hidden = !pre\.hidden/);
  assert.match(codeCard, /card\.classList\.toggle\("is-collapsed", pre\.hidden\)/);
});

test("activity copy prefers native Hermes progress and does not infer thought from request keywords", () => {
  assert.match(mainSource, /function initialHmsActivityLabel\(\)/);
  assert.match(mainSource, /const hmsProgressMapper = new HmsProgressMapper\(\{ segmentPrefix \}\);/);
  assert.match(mainSource, /const mappedProgress = hmsProgressMapper\.consume\(receivedUpdate, separated\);[\s\S]*?emitHmsProgress\(mappedProgress\);/);
  assert.match(mainSource, /executionLog: buildExecutionLog\(hmsExecutionUpdates\)/);
  assert.match(mainSource, /<baiqiu-progress>/);
  assert.match(mainSource, /new HmsMessageStreamDemux\(\{[\s\S]{0,180}requireFinalEnvelope: false[\s\S]{0,40}\}\)/);
  assert.match(mainSource, /stripHmsProgressEnvelopes\(promptResult\?\.text/);
  assert.match(mainSource, /只要已经发送过 baiqiu-answer，就直接结束，不要再用 baiqiu-final 重复全文/);
  assert.match(mainSource, /只有完全没有使用 baiqiu-answer 时，才允许用唯一的 baiqiu-final/);
  assert.match(mainSource, /missing_public_final_envelope/);
  const runtimeBody = mainSource.slice(
    mainSource.indexOf("async function runHermesSessionPrompt"),
    mainSource.indexOf("async function sendWithHermes")
  );
  const toolLoop = runtimeBody.indexOf("const localBaiqiuToolCalls = []");
  const publicBoundary = runtimeBody.indexOf("let publicFinalFound", toolLoop);
  assert.ok(toolLoop >= 0 && publicBoundary > toolLoop, "public final is parsed after the tool loop");
  assert.doesNotMatch(runtimeBody.slice(0, toolLoop), /result = applyHmsResponseEnvelopes\(result\)\.result/);
  assert.match(runtimeBody, /delegationStoreOptions = \{ hermesHome: baiqiuDataRoot\("runtime", "hermes-home"\) \}/);
  assert.doesNotMatch(runtimeBody, /result\.text = completion\.text \|\| result\.text/);
  assert.match(runtimeBody, /hasDurableHermesExecutionEvidence\(result\)/);
  assert.doesNotMatch(
    runtimeBody,
    /return runDirectConversation\(/
  );
  assert.doesNotMatch(mainSource, /function requestAnalysisActivityLabel/);
  assert.doesNotMatch(mainSource, /正在判断表格问题来自文件编码/);
});

test("HMS final text uses the shared progressive typewriter", () => {
  assert.match(rendererSource, /const useTypingAnimation = message\.role === "assistant" && options\.progressive === true/);
  assert.match(rendererSource, /const ASSISTANT_TYPING_MIN_CHARS_PER_SECOND = 150;/);
  assert.match(rendererSource, /const ASSISTANT_TYPING_MAX_CHARS_PER_SECOND = 500;/);
  assert.match(rendererSource, /const charactersPerSecond = assistantTypingCharsPerSecond\(chars\.length\);/);
  assert.match(rendererSource, /renderProgressiveMarkdown\(rendered, source, \{ final: true \}\);/);
  assert.match(rendererSource, /rendered\.innerHTML = renderMarkdown\(displayText\);/);
  assert.match(rendererSource, /bindRenderedLinks\(rendered\);/);
});

test("live final chunks incrementally render Markdown without rebuilding the response row", () => {
  assert.match(rendererSource, /function revealLiveChatStreamText\(entry\)/);
  assert.match(rendererSource, /const LIVE_MARKDOWN_BATCH_MS = 32;/);
  assert.match(rendererSource, /const LIVE_MARKDOWN_INPUT_BATCH_MS = 48;/);
  assert.match(rendererSource, /renderSegmentedLiveAnswer\(entry\)/);
  assert.match(rendererSource, /progressive-markdown-stable/);
  assert.match(rendererSource, /progressive-markdown-tail/);
  assert.match(rendererSource, /const alreadyRendered = rendered\.classList\.contains\("progressive-markdown"\)/);
  assert.match(rendererSource, /if \(!alreadyRendered\) rendered\.innerHTML = renderMarkdown\(source\);/);
  assert.match(rendererSource, /classifyRenderedDataLayout\(rendered, \{ preserveWide: true, source \}\)/);
  assert.match(rendererSource, /if \(frame\.type === "reset"\)/);
  assert.match(mainSource, /if \(!isReasoningUpdate[\s\S]*?!options\.internalStructuredResponse[\s\S]*?!promptOptions\.silent[\s\S]*?&& separated\.visibleDelta\)/);
  assert.doesNotMatch(mainSource, /!promptOptions\.silent && !hmsToolCatalog\.length && separated\.visibleDelta/);
  assert.match(mainSource, /streamedPublicText \+= visibleDelta/);
  assert.match(mainSource, /streamedPublicText = "";/);
});

test("live HMS chunks render immediately and never force a reader back to the bottom", () => {
  assert.match(rendererSource, /(?:const|let) streamId = createChatStreamId\(session\.id\);/);
  assert.match(rendererSource, /function revealLiveChatStreamText\(entry\)/);
  assert.match(rendererSource, /entry\.revealedLength = entry\.targetChars\.length/);
  assert.match(rendererSource, /if \(state\.followOutput\) scrollMessagesToBottom\(\);\s*else setNewOutputAvailable\(true\);/);
  assert.match(rendererSource, /state\.forceScrollBottom = false;/);
});

test("final stream reconciliation keeps the live row and never repaints a mismatched durable final", () => {
  const finalize = rendererSource.slice(
    rendererSource.indexOf("function finalizeLiveChatStream"),
    rendererSource.indexOf("function discardLiveChatStreamsForSession")
  );
  assert.match(finalize, /entry\.finalizeWhenDrained = applyCompletedRow/);
  assert.match(finalize, /entry\.elapsedTimer = null;[\s\S]*?hideLiveThinkingLayer\(entry, \{ allStructured: true, respectMinimum: false \}\)/);
  assert.match(finalize, /const currentRow = entry\.row\?\.isConnected \? entry\.row : ensureLiveStreamRow\(entry\)/);
  assert.match(finalize, /watchVisibleDrain\(\)/);
  assert.match(finalize, /currentRow\.classList\.remove\("streaming-response"\)/);
  assert.match(finalize, /finalTextDiffers/);
  assert.match(finalize, /if \(rendered && !hasStreamedAnswer\)/);
  assert.doesNotMatch(finalize, /rendered && \(!hasStreamedAnswer \|\| finalTextDiffers\)/);
  assert.match(finalize, /const committedText = hasStreamedAnswer && !finalExtendsStream[\s\S]*?streamedDisplayText/);
  assert.match(mainSource, /protocolFinalMismatch: true/);
  assert.match(finalize, /entry\.activity = collapseCompletedExecutionActivity\(entry\.activity, completedDurationMs, \[[\s\S]*?entry\.activityDetails[\s\S]*?entry\.structuredEvents/);
  assert.match(finalize, /if \(responseMessageId\) currentRow\.dataset\.messageId = responseMessageId/);
  assert.doesNotMatch(finalize, /replaceWith\(/);
  assert.doesNotMatch(finalize, /messageList\.scrollTop = previousScrollTop/);
  assert.match(finalize, /entry\.visibleText = finalDisplayText;/);
  assert.match(rendererSource, /entry\.revealedLength = entry\.targetChars\.length;/);
  const liveReveal = rendererSource.slice(
    rendererSource.indexOf("function revealLiveChatStreamText"),
    rendererSource.indexOf("function completedActivityHtml")
  );
  assert.match(liveReveal, /assistantTypingCharsPerSecond|typingPauseFor|revealCarry/);
  assert.match(rendererSource, /entry\.finalizeWhenDrained\?\.\(\);/);
  const restoreSegments = rendererSource.slice(
    rendererSource.indexOf("function restoreLiveStreamSegments"),
    rendererSource.indexOf("function ensureSessionExecutionMotion")
  );
  assert.doesNotMatch(restoreSegments, /segmentCharsById\?\.clear/);
});

test("final stream reconciliation preserves the running instruction anchor and natural reading position", () => {
  const finalize = rendererSource.slice(
    rendererSource.indexOf("function finalizeLiveChatStream"),
    rendererSource.indexOf("function discardLiveChatStreamsForSession")
  );
  assert.match(finalize, /const followAtFinalize = !instructionAnchorId\(entry\.sessionId\) && state\.followOutput;/);
  assert.doesNotMatch(finalize, /clearInstructionAnchor\(entry\.sessionId\)/);
  assert.match(finalize, /if \(followAtFinalize && !instructionAnchorId\(entry\.sessionId\)\) scheduleStreamingScroll\(\)/);
  assert.doesNotMatch(finalize, /messageList\.scrollTop =/);
});

test("messages sent while a reply is running remain queued for explicit manual delivery", () => {
  const enqueue = rendererSource.slice(
    rendererSource.indexOf("async function enqueueCurrentTask"),
    rendererSource.indexOf("async function abortCurrentTask")
  );
  const processQueue = rendererSource.slice(
    rendererSource.indexOf("async function processQueue"),
    rendererSource.indexOf("attachBtn.addEventListener", rendererSource.indexOf("async function processQueue"))
  );
  assert.match(enqueue, /sessionTaskQueue\.enqueue\(session\.id, \{ text, attachments: \[\.\.\.state\.attachments\], quote, autoStart: false \}\);/);
  assert.match(enqueue, /已加入队列，需手动启动/);
  assert.match(processQueue, /if \(!nextTask\?\.autoStart\) return;[\s\S]*?await sendCurrentTask\(task, sessionId\);/);
});

test("main process treats Black Ball final text as authoritative without White Ball content review", () => {
  assert.doesNotMatch(mainSource, /function normalizeInlineTextDelivery/);
  assert.doesNotMatch(mainSource, /inline_text_delivery_missing/);
  assert.doesNotMatch(mainSource, /minimumChars|requestedChars/);
  assert.doesNotMatch(mainSource, /function looksLikeHmsInternalWorklog/);
  assert.match(mainSource, /if \(result\?\.success\) \{\s*const deliveredResult = result;/);
});
