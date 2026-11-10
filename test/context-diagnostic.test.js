const assert = require("node:assert/strict");
const test = require("node:test");
const { providerDiagnostic } = require("../services/hms-stream-failure");

test("context auditing survives transport without leaking historical contents or file paths", () => {
  const diagnostic = providerDiagnostic({ sessionUpdate: "agent_message_chunk", content: { text: "" }, _meta: { baiqiu_diagnostic: {
    type: "provider_timing", stage: "client_prepare", requestId: "12345678-1234-1234-1234-123456789012",
    contextPolicy: "shadow", contextBeforeChars: 200000, contextCandidateChars: 100000, contextSelectedChars: 200000,
    contextCandidateCount: 4, contextOffloadedCount: 0, contextArchiveFailures: 0,
    toolResultChars: 100000, protocolReplayChars: 30000, toolSchemaChars: 2000,
    secret: "private", archivePath: "private/path", originalContent: "private content", userChars: -1
  } } });
  assert.equal(diagnostic.contextPolicy, "shadow");
  assert.equal(diagnostic.contextSelectedChars, 200000);
  assert.equal(diagnostic.contextCandidateCount, 4);
  assert.equal(diagnostic.contextOffloadedCount, 0);
  assert.equal(diagnostic.protocolReplayChars, 30000);
  assert.equal(diagnostic.userChars, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|archivePath|originalContent/);
});

test("cache accounting is diagnostic and never added twice to total token usage", () => {
  const diagnostic = providerDiagnostic({ sessionUpdate: "agent_message_chunk", content: { text: "" }, _meta: { baiqiu_diagnostic: {
    type: "provider_usage", requestId: "12345678-1234-1234-1234-123456789012",
    inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, cacheWriteTokens: -1
  } } });
  assert.equal(diagnostic.totalTokens, 120);
  assert.equal(diagnostic.cacheReadTokens, 80);
  assert.equal(diagnostic.cacheWriteTokens, undefined);
});
