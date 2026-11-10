const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const contract = require('../services/black-ball-public-event-contract');
const aggregator = require('../renderer-v2/event-aggregator');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer-v2/app.js'), 'utf8');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const phasesFor = new Function(between(renderer, 'function executionToolKey', 'function executionActiveTools')
  + between(renderer, 'function executionThreeRowViewModel', 'function paintExecutionStageView')
  + '; return executionThreeRowViewModel;')();
function harness() {
  const frames = [];
  const context = vm.createContext({ Date, Number, String, Boolean, Map, Set, Math,
    activeRuns: new Map(),
    chatStreamStarted: new Map(), chatStreamProgressSequences: new Map(), chatStreamFrameSequences: new Map(),
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, frame) => frames.push(frame) } },
    canonicalPublicEventTarget: contract.canonicalTarget,
    normalizeSemanticType: contract.normalizeSemanticType,
    semanticTypeFromEvent: contract.semanticTypeFromEvent,
    targetForSemanticType: contract.targetForSemanticType,
    safeActivitySnippet: value => String(value || ''), safeReasoningDelta: value => String(value || '') });
  vm.runInContext(between(main, 'function isBlackBallPublicProgress', 'function safeReasoningDelta'), context);
  return { context, frames };
}

test('actual acceptance is displayed immediately even when runtime preparation is blocked', async () => {
  const { context, frames } = harness();
  let releaseRuntime;
  let releaseClient;
  const runtimeGate = new Promise(resolve => { releaseRuntime = resolve; });
  const clientGate = new Promise(resolve => { releaseClient = resolve; });
  Object.assign(context, {
    hermesUsesConversationSession: () => false,
    ensureRunActive: signal => signal?.throwIfAborted(),
    waitForHmsRuntimeReady: () => runtimeGate,
    syncHermesRuntimeConfig: async () => {},
    ensureHermesClient: () => ({ start: () => clientGate }),
    isHermesUnavailableError: () => false
  });
  const preparation = between(main, 'async function runHermesSessionPrompt(', '  const workspace = hermesWorkspaceForSession(')
    + 'return runtimeExecutionEvents;\n}';
  vm.runInContext(preparation, context);
  const start = performance.now();
  const pending = context.runHermesSessionPrompt({ id: 'session' }, 'test', [], {}, { streamId: 'turn' });
  const initial = phasesFor(aggregator.aggregateExecutionEvents(frames.map(frame => frame.progress), { turnId: 'turn' }));
  assert.deepEqual(initial[0].progressEvents.map(event => event.text), ['已接收本次请求']);
  assert.equal(frames.at(-1).progress.message, '正在检查黑球运行时是否就绪');
  assert.ok(performance.now() - start < 1000);
  assert.equal(frames.some(frame => frame.progress.phase === 'request_context'), false);
  releaseRuntime();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.at(-1).progress.phase, 'client_start');
  assert.equal(frames.some(frame => frame.progress.phase === 'request_context'), false);
  releaseClient();
  const history = await pending;
  assert.equal(frames.at(-1).progress.phase, 'request_context');
  assert.deepEqual(JSON.parse(JSON.stringify(history)), JSON.parse(JSON.stringify(frames.map(frame => frame.progress))));
  assert.equal(new Set(frames.map(frame => frame.eventId)).size, frames.length);
  assert.deepEqual(frames.map(frame => frame.sequence), [1, 2, 3, 4, 5]);
});

test('repeated acceptance retains exactly the original event and timestamp', () => {
  const { context, frames } = harness();
  const first = context.emitBlackBallRunStarted('session', 'turn', 1000);
  const second = context.emitBlackBallRunStarted('session', 'turn', 2000);
  assert.equal(frames.length, 1);
  assert.equal(first, second);
  assert.equal(second.progress.timestamp, 1000);
});

test('runtime startup failure preserves only events actually emitted before the failure', async () => {
  const { context, frames } = harness();
  const failure = new Error('runtime unavailable');
  Object.assign(context, {
    hermesUsesConversationSession: () => false,
    ensureRunActive: () => {},
    waitForHmsRuntimeReady: async () => { throw failure; },
    isHermesUnavailableError: () => false
  });
  vm.runInContext(between(main, 'async function runHermesSessionPrompt(', '  const workspace = hermesWorkspaceForSession(')
    + 'return runtimeExecutionEvents;\n}', context);
  await assert.rejects(context.runHermesSessionPrompt({ id: 'session' }, 'test', [], {}, { streamId: 'turn' }), error => {
    assert.equal(error, failure);
    const history = error.hermesResult.executionLog;
    assert.equal(history.length, 2);
    assert.deepEqual(Array.from(history, event => event.eventId), frames.map(frame => frame.eventId));
    assert.equal(history[1].phase, 'runtime_wait');
    return true;
  });
});

test('runtime progress maps only actual known stages without claiming task reasoning or completion', () => {
  const { context } = harness();
  assert.equal(context.blackBallRuntimeProgress('unknown', { message: 'fake activity' }), null);
  assert.equal(context.blackBallRuntimeProgress('stream_activity', {}), null);
  const firstByte = context.blackBallRuntimeProgress('first_byte', { timestamp: 12345 });
  assert.equal(firstByte.timestamp, 12345);
  assert.equal(firstByte.kind, 'lifecycle');
  assert.equal(firstByte.target, 'execution_activity');
  assert.match(firstByte.message, /接口数据/);
  assert.doesNotMatch(firstByte.message, /思考|已完成|交叉/);
  const denied = context.blackBallRuntimeProgress('http_headers', { httpStatus: 401 });
  assert.equal(denied.status, 'failed');
  assert.match(denied.message, /HTTP 401/);
});

test('sending to ACP does not claim the provider has connected', () => {
  const { context, frames } = harness();
  const queued = context.blackBallRuntimeProgress('promptDispatched');
  assert.match(queued.message, /请求已提交黑球/);
  assert.doesNotMatch(queued.message, /已连接模型|接口请求已开始/);
  context.emitBlackBallModelRequestDispatched('session', 'turn', 5000);
  assert.match(frames[0].progress.message, /模型接口请求已开始/);
  assert.doesNotMatch(frames[0].progress.message, /已连接模型/);
});

test('context and live transport activity expose only observed facts', () => {
  const { context } = harness();
  assert.match(context.blackBallRuntimeProgress('context_prepare').message, /上下文/);
  assert.match(context.blackBallRuntimeProgress('context_ready', { messageCount: 7 }).message, /7/);
  assert.equal(context.blackBallRuntimeProgress('stream_activity', { bytesReceived: 0 }), null);
  const activity = context.blackBallRuntimeProgress('stream_activity', { bytesReceived: 2048 });
  assert.equal(activity, null);
  assert.equal(context.blackBallRuntimeProgress('stream_closed', { bytesReceived: 2048 }), null);
  assert.match(context.blackBallRuntimeProgress('answer_stream_started').message, /输出回答/);
});

test('received bytes use transport telemetry without becoming execution or answer events', async () => {
  const { context, frames } = harness();
  vm.runInContext(between(main, 'async function runHermesSessionPrompt(',
    '  const understanding = options.conversationUnderstanding || options.understanding || {};')
    + 'return { publishRuntimeProgress, runtimeExecutionEvents };\n}', context);
  const controller = new AbortController();
  const run = await context.runHermesSessionPrompt({ id: 'session' }, '', [], {},
    { streamId: 'turn', signal: controller.signal });
  const sequence = context.chatStreamFrameSequences.get('turn');
  const report = (requestId, bytesReceived, stage = 'stream_activity') =>
    run.publishRuntimeProgress(stage, { requestId, bytesReceived });
  report('first', 1024);
  report('first', 1024);
  report('first', 512);
  report('first', 3072);
  report('second', 512);
  report('first', 4096, 'stream_closed');
  report('first', 4096, 'stream_closed');
  for (const invalid of [-1, 0.5, NaN, Infinity, '2048']) report('invalid', invalid);
  report('', 2048);
  const transport = frames.filter(frame => frame.type === 'transport_activity');
  assert.deepEqual(transport.map(frame => frame.bytesReceived), [1024, 3072, 3584, 4608]);
  assert.ok(transport.every(frame => frame.turnId === 'turn' && frame.streamId === 'turn'
    && frame.sessionId === 'session' && !frame.progress && !frame.delta));
  assert.equal(context.chatStreamFrameSequences.get('turn'), sequence);
  assert.equal(run.runtimeExecutionEvents.length, 1);
  run.publishRuntimeProgress('answer_stream_started');
  report('second', 1024);
  assert.equal(frames.at(-1).bytesReceived, 5120);
  const count = frames.length;
  controller.abort();
  report('second', 2048);
  assert.equal(frames.length, count);
  const next = await context.runHermesSessionPrompt({ id: 'session' }, '', [], {}, { streamId: 'next' });
  next.publishRuntimeProgress('stream_activity', { requestId: 'next-request', bytesReceived: 256 });
  assert.equal(frames.at(-1).bytesReceived, 256);
  assert.equal(frames.at(-1).turnId, 'next');
});

test('live and replay include the same runtime events, exact tool code and stage result', () => {
  const { context, frames } = harness();
  context.emitBlackBallRunStarted('session', 'turn', 1000);
  const events = [...frames.map(frame => frame.progress), {
    turnId: 'turn', eventId: 'tool-1', sequence: 2, turnSequence: 2, semanticType: 'tool', target: 'execution',
    provenance: 'blackball_tool', sourceText: 'python -c "print(17)"', message: 'tool', status: 'completed'
  }, {
    turnId: 'turn', eventId: 'stage-1', sequence: 3, turnSequence: 3, semanticType: 'stage_result', target: 'structured',
    provenance: 'blackball_public', message: '文件里记录了 17 件。'
  }];
  const live = phasesFor(aggregator.aggregateExecutionEvents(events, { turnId: 'turn' }));
  const replay = phasesFor(aggregator.aggregateExecutionEvents(JSON.parse(JSON.stringify(events)), { turnId: 'turn' }));
  assert.deepEqual(replay, live);
  assert.deepEqual(live[0].progressEvents.map(event => event.text), ['已接收本次请求', 'python -c "print(17)"']);
  assert.deepEqual(live[0].resultEvents.map(event => event.text), ['文件里记录了 17 件。']);
  assert.equal(live.some(phase => phase.resultEvents.some(event => event.semanticType === 'cross')), false);
  assert.deepEqual(phasesFor(aggregator.aggregateExecutionEvents([])), []);
});

test('runtime rows paint directly and cannot retire the model-output timeout as model content', () => {
  const painter = between(renderer, 'function paintExecutionStageView', 'function executionActivityViewportIsAtBottom');
  assert.match(painter, /item\.semanticType === "lifecycle"\) textNode\.textContent = item\.text/);
  const activity = between(renderer, 'function setLiveStreamActivity', 'function adoptPersistedLiveStreamRow');
  assert.match(activity, /source === "hms" && kind !== "lifecycle"/);
  const noInventedHistory = between(main, '  const executionRunId = String(options.runId', '  executionLog.push(...buildExecutionLog');
  assert.doesNotMatch(noInventedHistory, /message:|timestamp:/);
});
