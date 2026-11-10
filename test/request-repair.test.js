const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const progress = require('../services/hms-progress');
const { HermesConfigService, HERMES_NATIVE_ROUTES, PROVIDER_BASE_URL_KEYS } = require('../services/hermes-config-service');

const update = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

test('stage JSON retains inline code and action-looking literals at every split boundary', () => {
  for (const message of [
    '**阶段结果 1：库存数量为 17 件。**\n\n文件原文：`测试资料 A：账面库存 17 件。`',
    '原文代码：\n```baiqiu-action\n{"type":"terminal","command":"print(17)"}\n```\n以及 ```json 和 `。'
  ]) {
    const envelope = `<baiqiu-progress>${JSON.stringify({ type: 'stage_result', segmentId: '1', message })}</baiqiu-progress>`;
    const scenarios = [[...envelope], [envelope]];
    for (let offset = 1; offset < envelope.length; offset++) scenarios.push([envelope.slice(0, offset), envelope.slice(offset)]);
    for (const chunks of scenarios) {
      const stream = new progress.HmsUpdateStreamDemux({ requireFinalEnvelope: false });
      const parts = chunks.map(chunk => stream.consume(update(chunk)));
      parts.push(stream.consume(update('<baiqiu-answer segmentId="1">真实答复</baiqiu-answer>')), stream.flush());
      assert.deepEqual(parts.flatMap(part => part.progressEvents).map(event => event.message), [message]);
      assert.equal(parts.map(part => part.visibleDelta + part.answerDeltas.map(delta => delta.delta).join('')).join(''), '真实答复');
      assert.equal(parts.some(part => part.protocolError), false);
    }
  }
});

test('unmarked reasoning envelopes cannot create public progress, answers, or protocol failures', () => {
  for (const contentType of ['thinking', 'reasoning', 'reasoning_content']) {
    const stream = new progress.HmsUpdateStreamDemux({ requireFinalEnvelope: false });
    const mapper = new progress.HmsProgressMapper();
    const item = { sessionUpdate: 'agent_thought_chunk', content: { type: contentType,
      text: '<baiqiu-progress>{"type":"cross","message":"INTERNAL"}</baiqiu-progress><baiqiu-answer>INTERNAL</baiqiu-answer><baiqiu-progress>' } };
    const parsed = stream.consume(item);
    assert.deepEqual(mapper.consume(item, parsed), []);
    assert.deepEqual(parsed.answerDeltas, []);
    assert.equal(stream.consume(update('公开回答')).visibleDelta, '公开回答');
    assert.equal(stream.flush().protocolError, false);
    assert.deepEqual(mapper.consume(item), []);
  }
});

test('native provider credentials, explicit endpoint and API style survive configuration changes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baiqiu-route-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new HermesConfigService({ hermesHome: home });
  for (const [provider, route] of Object.entries(HERMES_NATIVE_ROUTES)) {
    const apiStyle = provider === 'anthropic' ? 'anthropic' : 'openai';
    const configured = service.apply({ provider, model: 'fixture', baseURL: `https://${route.hosts[0]}/v1`, apiKey: 'fixture-key', apiStyle });
    const config = service.read();
    assert.equal(config.model.provider, route.provider);
    assert.equal(config.model.api_mode, apiStyle === 'anthropic' ? 'anthropic_messages' : 'chat_completions');
    const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
    const envKey = PROVIDER_BASE_URL_KEYS[provider];
    if (envKey) assert.ok(env.split('\n').includes(`${envKey}=${configured.baseURL}`));
    if (provider === 'kimi') assert.match(env, /KIMI_CN_API_KEY=fixture-key/);
    if (provider === 'hunyuan') assert.match(env, /TOKENHUB_API_KEY=fixture-key/);
  }
  service.apply({ provider: 'zhipu', model: 'proxy-model', baseURL: 'https://proxy.invalid/v1', apiKey: 'fixture-proxy', apiStyle: 'anthropic' });
  assert.equal(service.read().model.provider, 'custom:baiqiu-zhipu');
  assert.equal(service.read().model.api_mode, 'anthropic_messages');
  assert.equal(service.runtime().providerProtocol, null);
});

test('main completion requires native delivery evidence and retains protocol-degraded results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('    if (result.protocolError)', source.indexOf('  let publicFinalFound ='));
  const end = source.indexOf('    const displayableStatus', start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  const { createHash } = require('node:crypto');
  const { hasCommittedRuntimeDelivery } = require('../services/runtime-outcome');
  const { failIncompleteProtocol } = require('../services/hms-stream-failure');
  const text = '已读到 17 件。';
  const sha256 = createHash('sha256').update(text).digest('hex');
  const stage = { turnId: 'turn', eventId: 'stage:1', semanticType: 'stage_result', nativeSegmentId: 'one', message: text };
  const native = { source: 'black_ball_runtime', turnId: 'turn', eventId: 'runtime:1', sequence: 2,
    status: 'completed', completion: { version: 1, status: 'completed', outputs: [
      { target: 'structured', segmentId: 'one', sha256 }
    ] } };
  const cases = [
    { result: { status: 'done', protocolError: true }, output: text, stages: [], status: 'failed', found: false, delivery: 'degraded' },
    { result: { status: 'done', protocolError: true, runtimeOutcome: native }, output: '', stages: [stage], status: 'done', found: true, delivery: 'degraded' },
    { result: { status: 'done', protocolError: true, runtimeOutcome: native }, output: '', stages: [{ ...stage, message: '错误内容' }], status: 'failed', found: false, delivery: 'degraded' },
    { result: { status: 'done', protocolError: true, runtimeOutcome: { ...native, completion: { ...native.completion,
      outputs: [{ target: 'answer', segmentId: 'one', contentChars: text.length, sha256 }] } } }, output: text, stages: [], status: 'done', found: true, delivery: 'degraded' },
    { result: { status: 'done' }, output: '好', stages: [], status: 'done', found: true, delivery: 'completed' },
    { result: { status: 'done' }, output: '', stages: [], status: 'failed', found: false, delivery: 'degraded' }
  ];
  for (const scenario of cases) {
    const context = vm.createContext({ result: scenario.result, publicFinalMissing: false,
      publicFinalFound: false, publicOutput: { finalFound: false }, streamedPublicText: scenario.output,
      hmsStructuredEvents: scenario.stages, hasCommittedRuntimeDelivery, failIncompleteProtocol });
    vm.runInContext(branch, context);
    assert.equal(context.result.status, scenario.status);
    assert.equal(context.result.text, scenario.output);
    assert.equal(context.publicFinalFound, scenario.found);
    assert.equal(context.result.deliveryStatus, scenario.delivery);
  }
});
