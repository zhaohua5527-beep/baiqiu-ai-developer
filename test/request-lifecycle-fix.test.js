"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { HermesAcpClient } = require('../services/hermes-acp-client');
const { timeoutFailure } = require('../services/hms-stream-failure');
const { userFacingError } = require('../services/user-facing-error-adapter');
const app = fs.readFileSync(path.join(__dirname, '../renderer-v2/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function watchdog() {
  let now = 10000;
  let nextId = 0;
  const timers = new Map();
  const aborts = [];
  const queries = [];
  const notices = [];
  const context = {
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    api: { signalAbortChat: event => aborts.push(event), queryRunStatus: async event => { queries.push(event); return { status: "running" }; } },
    appendLiveStreamNotice(entry, message) { notices.push(message); },
    reportStartupMetric() {},
    LIVE_STREAM_FIRST_EVENT_TIMEOUT_MS: 30000,
    LIVE_STREAM_NO_PROGRESS_TIMEOUT_MS: 120000,
    LIVE_STREAM_FIRST_PUBLIC_TIMEOUT_MS: 120000,
    LIVE_STREAM_TOTAL_TIMEOUT_MS: 1800000
  };
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('function markLiveStreamEventReceived('), app.indexOf('function appendLiveStreamNotice(')) + app.slice(app.indexOf('function checkLiveStreamProgress('), app.indexOf('function reasoningSegmentKey(')), context);
  const entry = { startedAt: now, sessionId: 'session', streamId: 'turn', firstEventReceived: false };
  context.armLiveStreamFirstEventTimeout(entry, now);
  function advance(duration) {
    now += duration;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    context.checkLiveStreamProgress(entry);
  }
  return { context, entry, advance, timers, aborts, queries, notices };
}

test('active model data survives 30 seconds without pretending public output exists', () => {
  const view = watchdog();
  view.advance(5000);
  view.context.markLiveStreamTransportActivity(view.entry, { kind: 'model_data' });
  view.advance(30000);
  assert.equal(view.aborts.length, 0);
  assert.equal(view.entry.firstEventReceived, false);
  assert.equal(view.timers.size, 0);
  view.context.markLiveStreamEventReceived(view.entry);
  assert.equal(view.entry.firstEventReceived, true);
});

test('silence thresholds query runtime without cancelling an ongoing turn', async () => {
  const connection = watchdog();
  connection.advance(30001);
  assert.equal(connection.aborts.length, 0);
  assert.equal(connection.notices.length, 1);
  connection.advance(1000);
  assert.equal(connection.notices.length, 1);
  connection.context.markLiveStreamTransportActivity(connection.entry, { kind: 'response_data' });
  connection.context.markLiveStreamEventReceived(connection.entry);
  assert.equal(connection.entry.timedOut, undefined);
  const pending = watchdog();
  for (let index = 0; index < 12; index++) {
    pending.context.markLiveStreamTransportActivity(pending.entry, { kind: 'response_data' });
    pending.advance(10000);
  }
  await Promise.resolve();
  assert.equal(pending.queries.length, 1);
  assert.equal(pending.aborts.length, 0);
  assert.equal(pending.entry.timedOut, undefined);
  const stalled = watchdog();
  stalled.context.markLiveStreamEventReceived(stalled.entry);
  stalled.advance(120001);
  assert.equal(stalled.queries.length, 1);
  assert.equal(stalled.aborts.length, 0);
  const total = watchdog();
  total.context.markLiveStreamEventReceived(total.entry);
  for (let index = 0; index < 30; index++) {
    total.context.markLiveStreamTransportActivity(total.entry, { kind: 'tool_event' });
    total.advance(60000);
  }
  assert.equal(total.queries.length, 1);
  assert.equal(total.aborts.length, 0);
  for (const kind of ['connection', 'first_public', 'total']) assert.equal(userFacingError(timeoutFailure({ timeoutKind: kind })), timeoutFailure({ timeoutKind: kind }).message);
});

test('runtime preparation is not mislabeled as model connection timeout', () => {
  const view = watchdog();
  view.context.clearTimeout(view.entry.firstEventTimer);
  view.entry.firstEventTimer = null;
  view.entry.modelRequestDispatchedAt = 0;
  view.advance(120001);
  assert.equal(view.aborts.length, 0);
  view.advance(1800000);
  assert.equal(view.queries.length, 1);
  assert.equal(view.aborts.length, 0);
});

test('terminal turns ignore late activity and activity never enters the event ledger', () => {
  const view = watchdog();
  view.entry.terminalType = 'done';
  view.context.markLiveStreamTransportActivity(view.entry, { kind: 'model_data' });
  assert.equal(view.entry.firstTransportAt, undefined);
  const start = app.indexOf('function handleChatStreamFrame(');
  const end = app.indexOf('const acceptedEvent =', start);
  const handler = app.slice(start, end) + '\n}';
  let observed = 0;
  const context = { handleVoiceConversationStreamFrame() {}, liveChatStreams: new Map([['turn', { sessionId: 'session' }]]), markLiveStreamTransportActivity() { observed++; } };
  vm.createContext(context);
  vm.runInContext(handler, context);
  context.handleChatStreamFrame({ type: 'transport_activity', streamId: 'turn', sessionId: 'other', kind: 'model_data' });
  context.handleChatStreamFrame({ type: 'transport_activity', streamId: 'turn', sessionId: 'session', kind: 'model_data' });
  assert.equal(observed, 1);
});

test('ACP liveness is metadata only and does not count empty setup updates as model response', async () => {
  const client = new HermesAcpClient();
  const data = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private-fixture' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '真实正文' } }
  ];
  client.ensureSession = async () => ({ hermesSessionId: 'native', active: {
    prompt() {}, async nextUpdate() { return data.length ? { update: data.shift() } : { kind: 'stop', stopReason: 'end_turn' }; }
  } });
  const activity = [];
  const result = await client.prompt('session', 'test', { onActivity: event => activity.push(event) });
  assert.equal(result.text, '真实正文');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, 'model_data');
  assert.deepEqual(Object.keys(activity[0]).sort(), ['kind', 'timestamp']);
  assert.doesNotMatch(JSON.stringify(activity), /private|真实正文/);
});

test('transport emission bypasses semantic sequences and strips caller payloads', () => {
  const calls = [];
  const start = main.indexOf('function emitChatStream(');
  const end = main.indexOf('const progress = publicChatProgress', start);
  const context = { mainWindow: { webContents: { send: (...args) => calls.push(args) } } };
  vm.createContext(context);
  vm.runInContext(main.slice(start, end) + '\n}', context);
  context.emitChatStream('session', 'turn', { type: 'transport_activity', kind: 'model_data', text: 'secret', sequence: 99 });
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['kind', 'sessionId', 'streamId', 'timestamp', 'type']);
  assert.doesNotMatch(JSON.stringify(calls), /secret|sequence/);
});

test('ordinary chat no longer injects an unowned working goal', () => {
  assert.match(main, /projectSessionPrompt\(session, \{ includeWorkState: !conversationOnly && Boolean\(options\.taskId \|\| options\.taskBrain\?\.task_id \|\| options\.requireDelegation\) \}\)/);
});
