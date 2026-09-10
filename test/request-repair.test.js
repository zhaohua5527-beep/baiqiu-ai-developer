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

test('completion preserves real answers despite progress format errors and rejects missing answers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('    if (result.protocolError &&', source.indexOf('  let publicFinalFound ='));
  const end = source.indexOf('    const displayableStatus', start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  for (const text of ['', '已读到 17 件。']) {
    const context = vm.createContext({ result: { status: 'done', text, protocolError: true }, publicFinalMissing: false,
      publicFinalFound: false, publicOutput: { finalFound: false }, streamedPublicText: text });
    vm.runInContext(branch, context);
    assert.equal(context.result.status, text ? 'done' : 'failed');
    assert.equal(context.result.text, text);
    assert.equal(context.publicFinalFound, Boolean(text));
    assert.equal(context.result.deliveryStatus, text ? 'completed' : 'degraded');
  }
  const context = vm.createContext({ result: { status: 'done', text: '好' }, publicFinalMissing: false,
    publicFinalFound: false, publicOutput: { finalFound: false }, streamedPublicText: '好' });
  vm.runInContext(branch, context);
  assert.equal(context.result.deliveryStatus, 'completed');
  assert.equal(context.result.text, '好');
});
