const assert = require('node:assert/strict');
const test = require('node:test');
const { HermesAcpClient } = require('../services/hermes-acp-client');
const { providerVerificationMatches, providerCredentialFingerprint } = require('../services/model-route-policy');
const { probeReasoningControl, callChatCompletion } = require('../services/model-adapter');

for (const apiStyle of ['openai', 'anthropic']) {
  test(`${apiStyle} HTTP 200 stream errors are failures, not successful empty replies`, async () => {
    await assert.rejects(callChatCompletion({
      providerId: 'custom-test', provider: { apiStyle, apiKey: 'test-only', model: 'test', baseURL: 'https://example.invalid/v1' },
      body: { stream: true, messages: [{ role: 'user', content: 'test' }] }, onDelta() {},
      fetchImpl: async () => new Response('data: {"type":"error","error":{"message":"upstream overloaded"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }), { code: 'PROVIDER_STREAM_ERROR' });
  });
}

test('stream completion retains length limit instead of claiming normal stop', async () => {
  const result = await callChatCompletion({
    providerId: 'custom-test', provider: { apiKey: 'test-only', model: 'test', baseURL: 'https://example.invalid/v1' },
    body: { stream: true, messages: [] }, onDelta() {},
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(result.choices[0].finish_reason, 'length');
  assert.equal(result.choices[0].message.content, 'partial');
});

test('a protocol change invalidates the matching endpoint verification', () => {
  const provider = { apiKey: 'test-only', model: 'example-model', baseURL: 'https://example.invalid/v1', apiStyle: 'openai', verifiedAt: '2026-09-08', verifiedModel: 'example-model', verifiedBaseURL: 'https://example.invalid/v1', verifiedApiStyle: 'openai' };
  provider.verifiedCredentialFingerprint = providerCredentialFingerprint('custom-test', provider);
  assert.equal(providerVerificationMatches('custom-test', provider), true);
  assert.equal(providerVerificationMatches('custom-test', { ...provider, apiStyle: 'anthropic' }), false);
});

test('HTTP success without text does not verify reasoning support', async () => {
  const result = await probeReasoningControl({
    providerId: 'custom-test',
    provider: { apiKey: 'test-only', baseURL: 'https://example.invalid/v1', model: 'gpt-5-example', apiStyle: 'openai' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) })
  });
  assert.equal(result.reasoningVerified, false);
  assert.equal(result.reasoningMode, 'prompt');
});

for (const [name, response, accepted] of [
  ['matching identity', { _meta: { baiqiuSessionId: 'original' } }, true],
  ['different identity', { _meta: { baiqiuSessionId: 'replacement' } }, false],
  ['missing identity', {}, false],
  ['restore exception', null, false]
]) {
  test(`restoring ${name} never silently replaces history`, async () => {
    const client = new HermesAcpClient();
    client.start = async () => {};
    client.supportsAcpMcp = () => false;
    client.acp = { methods: { agent: { session: { resume: 'session/resume' } } } };
    let attached = false;
    client.connection = { agent: {
      request: async () => { if (!response) throw new Error('restore failed'); return response; },
      attachSession: ({ sessionId }) => { assert.equal(sessionId, 'original'); attached = true; return {}; },
      buildSession: () => { throw new Error('must not create replacement'); }
    } };
    if (accepted) {
      const session = await client.ensureSession('local', { hermesSessionId: 'original' });
      assert.equal(session.hermesSessionId, 'original');
      assert.equal(attached, true);
    } else {
      await assert.rejects(client.ensureSession('local', { hermesSessionId: 'original' }), { code: 'HERMES_SESSION_RESTORE_FAILED' });
      assert.equal(attached, false);
      assert.equal(client.sessions.size, 0);
    }
  });
}
