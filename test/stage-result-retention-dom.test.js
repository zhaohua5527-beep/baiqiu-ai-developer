"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const harnessFlag = "--stage-retention-harness";

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing renderer source: ${start}`);
  return source.slice(from, to);
}

async function runHarness() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-stage-retention-")));
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } });
  await window.loadURL("data:text/html;charset=utf-8,<html><body></body></html>");
  const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
  const helpers = [
    between(source, "function progressiveMarkdownStableBoundary", "function softenProgressiveTail"),
    between(source, "function isCrossStructuredEvent", "function mergeAnswerSegmentLists"),
    between(source, "function supplementReplySurface", "function placeLiveActivityBeforeBlock"),
    between(source, "function ensureLiveStructuredResultPanel", "function structuredEventDisplayText"),
    between(source, "function structuredEventDisplayText", "function ensureLiveProcessBlock"),
    between(source, "function restoreLiveStreamSegments", "function executionSurfaceIsVisible"),
    between(source, "function hideLiveThinkingLayer", "function appendLiveReasoningDelta"),
    between(source, "function executionToolKey", "function executionActivityViewportIsAtBottom"),
    between(source, "function renderPersistedSegmentPairs", "function snapshotMessageIdentity"),
    between(source, "function activityDetailText", "function mergeExecutionNarrativeEntries")
  ].join("\n");
  const reconciliation = between(source,
    "  const durableStructuredEvents = persistedReplay.mergeStructuredEventLists(",
    "  answerSegmentsFromMessage(message).forEach");
  const liveEvents = [];
  if (process.env.BAIQIU_STAGE_LIVE_REPORT) {
    const reports = JSON.parse(fs.readFileSync(process.env.BAIQIU_STAGE_LIVE_REPORT, "utf8"));
    const { HmsMessageStreamDemux } = require("../services/hms-progress");
    for (const report of reports) {
      if (!report.passed) throw new Error(`Live task failed: ${report.case}`);
      const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false, segmentPrefix: report.case + ':' });
      for (const message of report.assistantMessages) {
        for (let offset = 0; offset < message.length; offset += 11) {
          liveEvents.push(...demux.consume(message.slice(offset, offset + 11)).progressEvents
            .filter(event => event.semanticType === 'stage_result'));
        }
      }
    }
    if (liveEvents.length < 1) throw new Error('No actual model stage results to replay');
  }
  const result = await window.webContents.executeJavaScript(`(async () => {
    ${fs.readFileSync(path.join(root, "renderer-v2/persisted-replay.js"), "utf8")}
    ${fs.readFileSync(path.join(root, "renderer-v2/event-aggregator.js"), "utf8")}
    const persistedReplay = globalThis.BaiqiuPersistedReplay;
    const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3;
    let typingSpeed = 100000;
    const assistantTypingCharsPerSecond = () => typingSpeed;
    let manualFrames = null;
    let manualFrameId = 0;
    let manualNow = performance.now();
    const requestAnimationFrame = callback => manualFrames
      ? (manualFrames.set(--manualFrameId, callback), manualFrameId)
      : window.requestAnimationFrame(callback);
    const cancelAnimationFrame = id => id < 0 ? manualFrames?.delete(id) : window.cancelAnimationFrame(id);
    const advanceTyping = elapsed => {
      manualNow += elapsed;
      const callbacks = [...manualFrames.values()];
      manualFrames.clear();
      callbacks.forEach(callback => callback(manualNow));
    };
    const executionViewModelFromDetails = (events, turnId) => globalThis.BaiqiuEventAggregator.aggregateExecutionEvents(events, { turnId });
    const publicExecutionDetailsFromMessage = message => [...(message.executionLog || []), ...persistedReplay.structuredEventsFromMessage(message)];
    const replaceExecutionActivityLines = () => {};
    const renderMarkdown = text => text;
    const bindRenderedLinks = () => {};
    const classifyRenderedDataLayout = () => {};
    const decorateAnswerResult = () => {};
    const answerSegmentsFromMessage = persistedReplay.answerSegmentsFromMessage;
    const STRUCTURED_RESULT_VISIBLE_LIMIT = 3;
    const STRUCTURED_RESULT_TRANSITION_MS = 1;
    const STRUCTURED_THOUGHT_FADE_MS = 60000;
    const PUBLIC_REASONING_MIN_VISIBLE_MS = 0;
    const ensureLiveStreamRow = () => {};
    const acceptLiveTurnEvent = (_entry, event) => event;
    const scheduleStreamingScroll = () => {};
    const mutatePreservingMessageViewport = mutation => mutation();
    const stageTraces = [];
    const reportStartupMetric = (name, meta) => stageTraces.push({name, ...meta});
    const paintLiveExecutionNarrative = () => {};
    const placeLiveActivityBeforeBlock = () => {};
    const renderSegmentedLiveAnswer = () => {};
    const completeLiveReasoningSegment = () => {};
    const clearExecutionCurrentThinking = () => {};
    const structuredEventsFromMessage = persistedReplay.structuredEventsFromMessage;
    ${helpers}
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const settle = async () => {
      if (manualFrames) for (let frame = 0; frame < 5; frame += 1) advanceTyping(20);
      await new Promise(resolve => setTimeout(resolve, 60));
    };
    const liveEvents = ${JSON.stringify(liveEvents)};
    if (liveEvents.length) {
      const liveRendered = document.createElement('div');
      document.body.appendChild(liveRendered);
      const liveEntry = { rendered: liveRendered, activity: document.createElement('div'),
        segmentOrder: [], structuredEvents: [], structuredNodes: new Map(), turnId: 'actual-model-replay' };
      liveEvents.forEach((event, index) => appendLiveStructuredResult(liveEntry, {
        ...event, target: 'structured', eventId: 'actual-model-' + index, sequence: index + 1,
        turnId: liveEntry.turnId
      }));
      await new Promise(resolve => setTimeout(resolve, 150));
      const displayed = [...liveRendered.querySelectorAll('.structured-result-entry')].map(node => node.textContent);
      check(JSON.stringify(displayed) === JSON.stringify(liveEvents.map(event => event.message)), 'Actual model content lost during display');
      restoreLiveStreamSegments(liveEntry);
      check(liveEntry.structuredEvents.length === liveEvents.length, 'Actual model events lost during restore');
    }
    const rendered = document.createElement('div');
    document.body.appendChild(rendered);
    const entry = {
      rendered, activity: document.createElement('div'), segmentOrder: [],
      structuredEvents: [], structuredNodes: new Map()
    };
    entry.activity.innerHTML = '<div class="execution-stage-summary"></div>';
    entry.activity.__executionTimelineRendered = rendered;
    document.body.prepend(entry.activity);
    const nodes = () => [...rendered.querySelectorAll('.structured-result-entry')];
    const durableNodes = () => nodes().filter(node => node.dataset.durable === '1');
    const makeEvent = (sequence, semanticType) => ({
      eventId: 'fixture-' + sequence, turnId: 'fixture-turn', sequence,
      segmentId: 'stage-' + sequence, target: 'structured', type: semanticType,
      semanticType, kind: 'public_progress', message: '验收数据 ' + sequence + '\\n' + '正文保持完整。'.repeat(80)
    });
    const typingRendered = document.createElement('div');
    document.body.appendChild(typingRendered);
    const typingEntry = { rendered: typingRendered, activity: document.createElement('div'),
      segmentOrder: [], structuredEvents: [], structuredNodes: new Map() };
    typingSpeed = 105;
    manualFrames = new Map();
    for (const [index, kind] of ['stage_result', 'cross'].entries()) {
      const event = { ...makeEvent(100 + index, kind), message: '黑球🙂核实内容。'.repeat(100) };
      const node = appendLiveStructuredResult(typingEntry, event);
      check(node.textContent.length === 0, 'A newly received reply was pasted in full');
      advanceTyping(20);
      const first = node.textContent;
      check(first.length > 0 && first.length < event.message.length, 'Typing did not reveal a partial reply');
      appendLiveStructuredResult(typingEntry, event);
      check(node.textContent === first, 'Duplicate delivery restarted or completed typing');
      advanceTyping(20);
      check(node.textContent.startsWith(first) && node.textContent.length > first.length, 'Typing failed to advance monotonically');
      check(event.message.startsWith(node.textContent), 'Typing corrupted a Unicode character');
      check(typingEntry.structuredEvents.at(-1).message === event.message, 'Display cadence altered stored content');
      advanceTyping(5000);
      check(node.textContent.length < event.message.length, 'A delayed frame pasted the remaining reply');
    }
    restoreLiveStreamSegments(typingEntry);
    check(stageTraces.some(trace => trace.name === 'cross-reply:stage:painted' && trace.eventId === 'fixture-100'
      && trace.displayedChars === trace.contentChars), 'Restored result missing full paint audit');
    for (const node of typingEntry.structuredNodes.values()) {
      check(node.textContent === node.__structuredTargetText, 'History restoration lost pending text');
      check(!node.__structuredPaintFrame, 'History restoration replayed the animation');
    }
    typingSpeed = 100000;
    const finalTypingEvent = makeEvent(103, 'stage_result');
    const finalTypingNode = appendLiveStructuredResult(typingEntry, finalTypingEvent);
    typingEntry.finalized = true;
    advanceTyping(20);
    check(finalTypingNode.textContent === finalTypingEvent.message, 'Task completion stranded partially typed text');
    check(stageTraces.some(trace => trace.name === 'cross-reply:stage:received' && trace.eventId === finalTypingEvent.eventId), 'Missing stage receive audit');
    check(stageTraces.some(trace => trace.name === 'cross-reply:stage:painted' && trace.eventId === finalTypingEvent.eventId && trace.displayedChars === finalTypingEvent.message.length), 'Missing full paint audit');
    typingRendered.remove();
    manualFrames.clear();
    trimLiveStructuredResultWindow(entry);
    restoreLiveStreamSegments(entry);
    check(nodes().length === 0, 'An empty stream fabricated a result');
    const results = [2, 4, 6, 8, 10].map(sequence => makeEvent(sequence, 'stage_result'));
    results.push(makeEvent(12, 'cross'));
    for (const event of [results[2], results[0], results[1], ...results.slice(3)]) {
      appendLiveStructuredResult(entry, event);
      appendLiveStructuredResult(entry, { ...makeEvent(event.sequence + 1, 'thinking'), transient: true });
    }
    paintExecutionStageView(entry.activity, entry.structuredEvents, 'fixture-turn');
    appendLiveStructuredResult(entry, results[0]);
    await settle();
    check(durableNodes().length === 6, 'Later results removed earlier stage/cross results');
    check(nodes().filter(node => node.dataset.durable !== '1').length === 3, 'Temporary rolling window no longer contains three entries');
    check(durableNodes().every((node, index) => node.textContent === results[index].message), 'Result order or full text changed');
    check(entry.structuredEvents.length === 12, 'Events were discarded or duplicate delivery was appended');
    for (const node of durableNodes()) {
      const style = getComputedStyle(node.parentElement);
      check(style.maxHeight === 'none' && style.overflowY === 'visible', 'Stage result is clipped to the process window');
      check(node.getBoundingClientRect().height > 0, 'Stage result is invisible');
    }
    entry.structuredEvents[0].__retired = true;
    restoreLiveStreamSegments(entry);
    await settle();
    check(durableNodes().length === 6, 'Session restoration lost stage results');
    check(entry.structuredEvents.length === 12, 'Restoration discarded stored events');
    check(durableNodes().every((node, index) => node.textContent === results[index].message), 'Restored content changed');
    hideLiveThinkingLayer(entry, { allStructured: true, respectMinimum: false });
    await settle();
    check(nodes().length === 6, 'Terminal cleanup removed durable results or retained temporary content');
    check(entry.structuredEvents.filter(event => isDurableStructuredEvent(event)).every(event => !event.__retired), 'Terminal cleanup retired durable events');
    let message = { text: '最终答案', structuredEvents: [results[5]] };
    ${reconciliation}
    check(message.structuredEvents.filter(isDurableStructuredEvent).length === 6, 'Partial final snapshot overwrote earlier stage results');
    const replay = persistedReplay.replaySegmentModel(message);
    check(replay.structuredEvents.filter(isDurableStructuredEvent).length === 6, 'History replay lost stage results');
    const tools = [1, 3, 5, 7, 9, 11, 13].map(sequence => ({
      eventId: 'tool-' + sequence, turnId: 'fixture-turn', sequence,
      semanticType: 'tool', target: 'execution', provenance: 'blackball_tool',
      sourceText: 'print(' + sequence + ')', message: '工具 ' + sequence, status: 'completed'
    }));
    const final = document.createElement('div');
    final.className = 'stream-segment-answer';
    final.dataset.sequence = '14';
    final.innerHTML = '<p>最终答案</p>';
    rendered.appendChild(final);
    const finalNode = final.firstChild;
    entry.activity.dataset.activityExpanded = '1';
    paintExecutionStageView(entry.activity, [...tools, ...results], 'fixture-turn');
    await settle();
    const timelineKinds = () => [...entry.activity.__executionTimeline.children].map(node => node.dataset.timelineKind);
    const expectedKinds = ['execution', 'structured', 'execution', 'structured', 'execution', 'structured',
      'execution', 'structured', 'execution', 'structured', 'execution', 'structured', 'execution', 'answer'];
    check(JSON.stringify(timelineKinds()) === JSON.stringify(expectedKinds), 'Tools and replies do not alternate in DOM sequence: ' + JSON.stringify(timelineKinds()));
    check(rendered.querySelectorAll('.execution-phase-event').length === 7, 'Tool process lost or duplicated');
    entry.activity.dataset.activityExpanded = '0';
    entry.activity.dataset.lifecycle = 'completed';
    paintExecutionStageView(entry.activity, [], 'fixture-turn');
    check(rendered.querySelector('.execution-phase-event .execution-event-text').textContent.includes('print(1)'), 'Raw tool code lost');
    check([...entry.activity.__executionTimeline.children].filter(node=>node.dataset.timelineKind==='execution').every(node=>node.hidden), 'Completed process fails to collapse');
    check(durableNodes().every(node=>!node.closest('[hidden]')), 'Collapsed process hides replies');
    check(final.firstChild === finalNode, 'Process repaint replaces final answer DOM');
    entry.activity.dataset.activityExpanded = '1';
    paintExecutionStageView(entry.activity, [], 'fixture-turn');
    check([...entry.activity.__executionTimeline.children].every(node=>!node.hidden), 'Expand does not restore process beside results');
    message = {text:'最终答案', structuredEvents:results, executionLog:tools,
      answerSegments:[{eventId:'answer-14',turnId:'fixture-turn',sequence:14,segmentId:'final',text:'最终答案'}]};
    renderPersistedSegmentPairs(message, rendered);
    syncExecutionReplyTimeline(entry.activity, rendered);
    check(JSON.stringify(timelineKinds()) === JSON.stringify(expectedKinds), 'History replay loses interleaving');
    check(durableNodes().length === 6, 'History replay duplicates or loses results');
    const answerRoot = document.createElement('div');
    answerRoot.innerHTML = '<div class="execution-stage-summary"></div>';
    const answerRendered = document.createElement('div');
    document.body.append(answerRoot, answerRendered);
    answerRoot.dataset.lifecycle = 'completed';
    answerRoot.dataset.activityExpanded = '1';
    answerRoot.__executionTimelineRendered = answerRendered;
    answerRoot.__executionAnswerBoundaries = [2,4].map(sequence=>({
      eventId:'prose-'+sequence, sequence, target:'answer', type:'answer_segment', segmentId:'prose-'+sequence
    }));
    for(const boundary of answerRoot.__executionAnswerBoundaries) {
      const answer=document.createElement('div');
      answer.className='stream-segment-answer';
      answer.dataset.sequence=String(boundary.sequence);
      answer.textContent='阶段正文'+boundary.sequence;
      answerRendered.appendChild(answer);
    }
    paintExecutionStageView(answerRoot, tools.slice(0,2), 'fixture-turn');
    check([...answerRoot.__executionTimeline.children].map(node=>node.dataset.timelineKind).join(',') === 'execution,answer,execution,answer', 'Multiple authored answer segments lost their execution boundaries');
    return { stageResults: 5, crossResults: 1, storedEvents: entry.structuredEvents.length,
      restoredResults: durableNodes().length, unclipped: true, snapshotMerged: true };
  })()`);
  console.log("STAGE_RETENTION_RESULT=" + JSON.stringify(result));
  window.destroy();
  app.quit();
}

if (process.argv.includes(harnessFlag)) {
  runHarness().catch(error => { console.error(error.stack); require("electron").app.exit(1); });
} else {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  test("long-task results survive rolling progress, remount, terminal cleanup and partial final snapshots", () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = require("node:child_process").spawnSync(require("electron"), [__filename, harnessFlag], {
      cwd: root, env, encoding: "utf8", timeout: 20000, windowsHide: true
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
    const match = run.stdout.match(/STAGE_RETENTION_RESULT=(.+)/);
    assert.ok(match, run.stdout);
    assert.deepEqual(JSON.parse(match[1]), {
      stageResults: 5, crossResults: 1, storedEvents: 12,
      restoredResults: 6, unclipped: true, snapshotMerged: true
    });
  });
  test("fragmented model progress retains every independent stage result without manufacturing cross", () => {
    const { HmsMessageStreamDemux } = require('../services/hms-progress');
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
    const expected = Array.from({length:5}, (_, index)=>({segmentId:String(index+1),type:'stage_result',
      status:'completed',message:'已核实的阶段成果 '+(index+1)}));
    const input = expected.map(event=>'<baiqiu-progress>'+JSON.stringify(event)+'</baiqiu-progress>').join('');
    const events = [];
    for (let offset=0;offset<input.length;offset+=7) events.push(...demux.consume(input.slice(offset,offset+7)).progressEvents);
    assert.equal(events.length,5);
    assert.deepEqual(events.map(event=>event.message),expected.map(event=>event.message));
    assert.ok(events.every(event=>event.semanticType==='stage_result'));
  });
}
