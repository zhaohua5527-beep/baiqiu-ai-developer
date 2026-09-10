"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { HmsMessageStreamDemux } = require("../services/hms-progress");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const projectRuntimeSource = fs.readFileSync(path.join(root, "services", "hms-project-runtime.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("continuation answer segments are unique while progress and answer remain bound", () => {
  const decode = (prefix, text) => {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false, segmentPrefix: prefix });
    return demux.consume(text);
  };
  const first = decode("turn-1:p1:", '<baiqiu-progress>{"segmentId":"1","stage":"read","status":"running","message":"已读取请求"}</baiqiu-progress><baiqiu-answer segmentId="1">第一段</baiqiu-answer>');
  const second = decode("turn-1:p2:", '<baiqiu-progress>{"segmentId":"1","stage":"verify","status":"running","message":"已核对结果"}</baiqiu-progress><baiqiu-answer segmentId="1">第二段</baiqiu-answer>');

  const firstSegment = first.answerDeltas[0].segmentId;
  const secondSegment = second.answerDeltas[0].segmentId;
  assert.notEqual(firstSegment, secondSegment);
  assert.equal(first.progressEvents[0].segmentId, firstSegment);
  assert.equal(second.progressEvents[0].segmentId, secondSegment);
});

test("main stream envelope declares the authoritative event identity and output roles", () => {
  assert.match(mainSource, /snapshotSequence:\s*\+\+rendererSnapshotSequence/);
  assert.match(mainSource, /const suppliedTurnSequence = Number\(frame\.turnSequence \|\| 0\)/);
  assert.match(mainSource, /sequence,\s*turnSequence,\s*target/);
  assert.match(mainSource, /const suppliedSequence = Number\(frame\.sequence \|\| progress\?\.sequence \|\| 0\)/);
  assert.match(mainSource, /target,\s*outputType,\s*eventType/);
  assert.match(mainSource, /target === "structured_result"/);
  assert.match(mainSource, /target === "answer" \? "result"/);
  assert.match(mainSource, /segmentPrefix/);
});

test("Black Ball and White Ball share native tool and turn events", () => {
  const hermesSource = fs.readFileSync(path.join(root, "services", "hermes-acp-client.js"), "utf8");
  const progressSource = fs.readFileSync(path.join(root, "services", "hms-progress.js"), "utf8");
  assert.match(hermesSource, /mcp\/connect/);
  assert.match(hermesSource, /mcp\/message/);
  assert.match(hermesSource, /buildSession\(\{ cwd, mcpServers \}\)/);
  assert.match(mainSource, /provider: "hermes-native-mcp"/);
  assert.match(mainSource, /const nativeWhiteBallTools = hmsToolCatalog\.length > 0 && client\.supportsAcpMcp\(\)/);
  assert.match(mainSource, /answer_delta/);
  assert.match(mainSource, /turn_complete/);
  assert.match(progressSource, /"tool_call"[\s\S]*?"tool_result"/);
  assert.match(rendererSource, /acceptedEvent\.type === "turn_complete"/);
});

test("renderer rejects stale snapshots, deduplicates events, and merges authoritative messages", () => {
  assert.match(rendererSource, /const staleSnapshot = incomingSequence > 0[\s\S]*?incomingSequence < Number\(state\.lastSessionChangedSequence/);
  assert.match(rendererSource, /entry\.eventLedger\.get\(eventId\)/);
  assert.match(rendererSource, /conflicting_event_id/);
  assert.match(rendererSource, /entry\.eventsByTarget\.set\(target, orderedTargetEvents\)/);
  assert.match(rendererSource, /function mergeAuthoritativeMessageHistory\(/);
  assert.match(rendererSource, /messages are authoritative for the active turn/);
  assert.match(rendererSource, /rememberAuthoritativeMessage\(session\.id, message\)/);
  assert.match(rendererSource, /historyCount\(history\) === 0 && historyCount\(cachedHistory\) > 0/);
  assert.match(rendererSource, /if \(history == null\) \{[\s\S]*?authoritativeMessagesBySession/);
});

test("result and structured_result use distinct font roles", () => {
  assert.match(stylesSource, /--font-result:/);
  assert.match(stylesSource, /--font-structured-result:/);
  assert.match(stylesSource, /\.stream-segment-answer[\s\S]*font-family: var\(--font-result\)/);
  assert.match(stylesSource, /\.stream-segment-reasoning[\s\S]*font-family: var\(--font-structured-result\)/);
  assert.match(stylesSource, /\.execution-activity-line-reasoning[\s\S]*font-family: var\(--font-structured-result\)/);
  assert.match(stylesSource, /\.execution-activity-head \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(stylesSource, /\.streaming-structured-result[\s\S]*max-height: calc\(3 \* 1\.6em \+ 14px\)/);
  assert.match(rendererSource, /const STRUCTURED_RESULT_VISIBLE_LIMIT = 3/);
  assert.match(rendererSource, /scheduleLiveStructuredEntryFade/);
});

test("public protocol is shared by provider upload/chat and Black Ball execution prompts", () => {
  const occurrences = (source, value) => source.split(value).length - 1;
  assert.ok(occurrences(mainSource, "structured_result") >= 3);
  const protocol = require("../services/public-response-protocol").publicResponseStreamPrompt();
  assert.match(mainSource, /require\("\.\/services\/public-response-protocol"\)/);
  assert.ok(occurrences(mainSource, "publicResponseStreamPrompt()") >= 3);
  assert.match(protocol, /Public structured progress protocol/);
  assert.match(protocol, /无需工具和阶段输出时直接回答/);
  assert.match(mainSource, /evidenceToolCallIds/);
  assert.match(protocol, /cross 仅在已取得并实际比较至少两个独立证据源或工具结果后发出/);
  assert.match(protocol, /没有独立阶段结论就没有 stage_result/);
  assert.doesNotMatch(mainSource, /false && !options\.internalStructuredResponse \? \[\s*"\[Public response channel protocol\]"/);
  assert.match(projectRuntimeSource, /BLACK_BALL_PUBLIC_EVENT_PROTOCOL/);
  assert.match(projectRuntimeSource, /require\("\.\/public-response-protocol"\)\.publicResponseStreamPrompt\(\)/);
});

test("progress targets remain separate from the execution theater", () => {
  assert.match(mainSource, /function publicProgressTarget\(/);
  assert.match(mainSource, /target === "execution_activity"/);
  assert.match(rendererSource, /function progressTarget\(/);
  assert.match(rendererSource, /function ensureLiveStructuredResultPanel\(/);
  assert.match(rendererSource, /function appendLiveStructuredResult\(/);
  assert.match(rendererSource, /streaming-structured-result/);
  assert.match(rendererSource, /if \(\["structured_result", "structured", "reasoning"\]\.includes\(explicit\)\) return "structured_result"/);
  assert.match(rendererSource, /target: "structured"/);
  assert.match(rendererSource, /canonicalLiveEventTarget/);
});

test("live turns close only after a durable answer has drained from the view", () => {
  assert.match(rendererSource, /CREATED:\s*"CREATED"/);
  assert.match(rendererSource, /ANSWER_COMMITTED:\s*"ANSWER_COMMITTED"/);
  assert.match(rendererSource, /VIEW_DRAINED:\s*"VIEW_DRAINED"/);
  assert.match(rendererSource, /if \(!force && entry\.turnState !== LIVE_TURN_STATES\.VIEW_DRAINED\) return false/);
  assert.equal((rendererSource.match(/liveChatStreams\.delete\(streamId\)/g) || []).length, 1);
});

test("renderer transport failures never become fabricated assistant answers", () => {
  const send = rendererSource.slice(
    rendererSource.indexOf("async function sendCurrentTask"),
    rendererSource.indexOf("async function processQueue")
  );
  assert.doesNotMatch(send, /没有发送成功|操作已完成|任务完成|本次请求没有取得有效结果/);
  assert.doesNotMatch(send, /api\.appendMessage\(session\.id, failureMessage\)/);
  assert.match(send, /客户端传输失败/);
});

test("HMS project prompts forward live Black Ball progress and answer segments", () => {
  assert.match(mainSource, /const progressMapper = new HmsProgressMapper\(\{ segmentPrefix \}\)/);
  assert.match(mainSource, /const visibleStream = new HmsUpdateStreamDemux\(\{[\s\S]*?requireFinalEnvelope: false/);
  assert.match(mainSource, /emitHmsProgress\(mappedProgress\)/);
  assert.match(mainSource, /const separated = isMessageUpdate[\s\S]*?visibleStream\.consume\(update\)/);
  assert.match(mainSource, /if \(isMessageUpdate\) emitAnswerParts\(separated\)/);
  assert.match(mainSource, /const publishAnswer = phase === "summary"/);
  assert.match(mainSource, /if \(!String\(streamedSummaryAnswer \|\| ""\)\.trim\(\)\)/);
  assert.match(mainSource, /target: "answer",[\s\S]*?outputType: "result",[\s\S]*?eventType: "result_delta"/);
});

test("complete final results cannot be replaced by shorter streamed text", () => {
  assert.match(mainSource, /The final envelope is the Black Ball authority/);
  assert.doesNotMatch(mainSource, /text: streamedPublicText,\s*stopReason: "segmented_public_answer"/);
  assert.match(rendererSource, /finalExtendsStream/);
});
