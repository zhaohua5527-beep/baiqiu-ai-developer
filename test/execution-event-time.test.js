const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const existing = fs.readFileSync(path.join(__dirname, 'stage-flow-contract.test.js'), 'utf8');
const { stageDom, phasesFor } = new Function('require', '__dirname',
  existing.slice(0, existing.indexOf('const firstStage =')) + '; return { stageDom, phasesFor };')(require, __dirname);
const startedAt = Date.parse('2026-09-14T04:00:00Z');
const start = { turnId: 'turn-1', eventId: 'start', sequence: 1, kind: 'lifecycle', type: 'execution_start',
  provenance: 'blackball_runtime', target: 'execution', timestamp: startedAt, message: '已接收本次请求' };
function event(id, sequence, offset, semanticType = 'tool') {
  return { turnId: 'turn-1', eventId: id, sequence, semanticType, timestamp: startedAt + offset,
    provenance: semanticType === 'tool' ? 'blackball_tool' : 'blackball_public',
    target: semanticType === 'tool' ? 'execution' : 'structured', message: id };
}

test('process timestamps measure from actual request acceptance, including ISO timestamps', () => {
  const tool = event('command', 3, 7800);
  tool.timestamp = new Date(tool.timestamp).toISOString();
  const phases = phasesFor([tool, event('thinking', 2, 2300, 'thinking'), start]);
  assert.deepEqual(phases[0].progressEvents.map(item => item.elapsedMs), [0, 2300, 7800]);
  assert.deepEqual(phases[0].progressEvents.map(item => item.text), [start.message, 'thinking', 'command']);
});

test('missing or inconsistent event times never get a fabricated second count', () => {
  const untimed = event('untimed', 2, 0);
  delete untimed.timestamp;
  const earlier = event('earlier', 3, -500);
  assert.deepEqual(phasesFor([start, untimed, earlier])[0].progressEvents.map(item => item.elapsedMs), [0, null, null]);
  assert.equal(phasesFor([event('without-start', 1, 5000)])[0].progressEvents[0].elapsedMs, null);
});

test('legacy persisted start records use their stored run start timestamp', () => {
  const legacy = { ...start, type: 'lifecycle', action: 'connect', eventId: 'old-turn:execution:0' };
  assert.equal(phasesFor([legacy, event('tool', 2, 6327)])[0].progressEvents[1].elapsedMs, 6327);
  const unrelated = { ...legacy, eventId: 'unrelated-connection' };
  assert.equal(phasesFor([unrelated, event('tool', 2, 6327)])[0].progressEvents[1].elapsedMs, null);
});

test('DOM prefixes stay inline and code/status remain intact during live and replay painting', () => {
  const { root, panel, paint } = stageDom();
  const tool = { ...event('tool', 2, 7300), sourceText: 'python -c "print(42)"', resultPreview: '42', status: 'completed' };
  paint(root, [start, tool], 'turn-1');
  const row = panel.querySelectorAll ? panel.querySelectorAll('.execution-phase-event')[1]
    : panel.children[0].querySelector('.execution-phase-event-list').children[1];
  assert.equal(row.children[0].className, 'execution-event-time');
  assert.equal(row.children[0].textContent, '7s');
  assert.equal(row.querySelector('.execution-event-text').textContent, 'python -c "print(42)"\n结果：42');
  assert.equal(row.querySelector('.execution-event-status').textContent, '✅');
  root.dataset.lifecycle = 'completed';
  root.dataset.activityExpanded = '1';
  paint(root, JSON.parse(JSON.stringify([start, tool])), 'turn-1');
  assert.equal(panel.children[0].querySelector('.execution-phase-event-list').children[1].children[0].textContent, '7s');
});

test('stage replies and cross replies keep their original text without process time prefixes', () => {
  const { root, panel, paint } = stageDom();
  const reply = event('真实阶段结果', 3, 5000, 'stage_result');
  paint(root, [start, event('tool', 2, 3000), reply], 'turn-1');
  const result = panel.children[0].querySelector('.execution-phase-result');
  assert.equal(result, null);
  assert.equal(panel.children[0].querySelector('.execution-phase-results').hidden, true);
  assert.equal(panel.children[0].querySelector('.execution-phase-results').textContent, '');
  assert.equal(phasesFor([start, event('真实交叉回复', 2, 4000, 'cross')])[0].resultEvents[0].text, '真实交叉回复');
});

test('receiving a later event cannot advance timestamps on preceding events', () => {
  const first = [start, event('tool', 2, 7200)];
  const before = phasesFor(first)[0].progressEvents;
  const after = phasesFor([...first, event('later', 3, 30000)])[0].progressEvents;
  assert.deepEqual(after.slice(0, 2), before);
});

test('consecutive events in one second share a visible timestamp without losing event content', () => {
  const { root, panel, paint } = stageDom();
  root.dataset.activityExpanded = '1';
  const events = [start, event('first', 2, 100), event('second', 3, 900), event('next', 4, 1100), event('last', 5, 1800)];
  paint(root, events, 'turn-1');
  const rows = () => panel.children[0].querySelector('.execution-phase-event-list').children;
  assert.deepEqual(rows().map(row => row.children[0].dataset.repeated), ['0', '1', '1', '0', '1']);
  assert.deepEqual(rows().map(row => row.querySelector('.execution-event-text').textContent), events.map(item => item.message));
  root.dataset.activityExpanded = '0';
  paint(root, events, 'turn-1');
  assert.equal(rows()[2].children[0].dataset.repeated, '0');
  root.dataset.activityExpanded = '1';
  paint(root, JSON.parse(JSON.stringify(events)), 'turn-1');
  assert.equal(rows()[2].children[0].dataset.repeated, '1');
});
