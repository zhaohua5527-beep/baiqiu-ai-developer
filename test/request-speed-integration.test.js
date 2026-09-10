"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HermesAcpClient } = require("../services/hermes-acp-client");
const { HermesConfigService, HERMES_NATIVE_ROUTES, resolveHermesProviderConfig, resolveHermesProtocol } = require("../services/hermes-config-service");
const { publicResponseStreamPrompt } = require("../services/public-response-protocol");
const { HmsMessageStreamDemux } = require("../services/hms-progress");
const { providerDiagnostic } = require("../services/hms-stream-failure");

test("wire protocol evidence retains only bounded settings and character counts", () => {
  const diagnostic = providerDiagnostic({ sessionUpdate: "agent_message_chunk", content: { text: "" }, _meta: { baiqiu_diagnostic: {
    type: "provider_timing", stage: "http_request", requestId: "12345678-1234-1234-1234-123456789012",
    reasoningEffort: "max", replayedReasoningChars: 234, thinkingEnabled: true, preservedThinking: true, toolStream: true,
    reasoning_content: "private", apiKey: "secret"
  } } });
  assert.equal(diagnostic.reasoningEffort, "max");
  assert.equal(diagnostic.replayedReasoningChars, 234);
  assert.equal(diagnostic.toolStream, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret/);
});

test("submit joins cold prewarm and replaces only its placeholder callback", async () => {
  const client = new HermesAcpClient();
  let startRuntime;
  const started = new Promise(resolve => { startRuntime = resolve; });
  client.start = async () => { await started; client.initialization = { agentCapabilities: { mcpCapabilities: { acp: true } } }; };
  let builds = 0;
  client.connection = { agent: { buildSession: () => ({ start: async () => ({ sessionId: `native-${++builds}` }) }) } };
  const tools = [{ name: "read", inputSchema: { type: "object" } }];
  const prewarm = { tools, prewarm: true, callTool: async () => "placeholder" };
  const first = client.ensureSession("local", { mcpServer: prewarm });
  const submitted = client.ensureSession("local", { mcpServer: { tools, callTool: async () => "real result" } });
  startRuntime();
  assert.equal(await first, await submitted);
  assert.equal(builds, 1);
  const serverId = [...client.mcpServers.keys()][0];
  const { connectionId } = client.connectMcp({ serverId });
  const call = () => client.messageMcp({ connectionId, method: "tools/call", params: { name: "read" } });
  assert.equal(await call(), "real result");
  await client.ensureSession("local", { mcpServer: prewarm });
  assert.equal(await call(), "real result");
  assert.equal(builds, 1);
});

test("changed tool capabilities rebuild instead of reusing incompatible prewarm", async () => {
  const client = new HermesAcpClient();
  client.start = async () => {};
  client.initialization = { agentCapabilities: { mcpCapabilities: { acp: true } } };
  let builds = 0;
  client.connection = { agent: { buildSession: () => ({ start: async () => ({ sessionId: `native-${++builds}`, dispose() {} }) }) } };
  const first = client.ensureSession("local", { mcpServer: { tools: [{ name: "read" }], callTool() {} } });
  const second = client.ensureSession("local", { mcpServer: { tools: [{ name: "write" }], callTool() {} } });
  assert.notEqual((await first).hermesSessionId, (await second).hermesSessionId);
  assert.equal(builds, 2);
});

for (const [provider, route] of Object.entries(HERMES_NATIVE_ROUTES)) {
  test(`${provider} keeps native protocol and isolates custom endpoint overrides`, () => {
    const apiStyle = provider === "anthropic" ? "anthropic" : "openai";
    assert.equal(resolveHermesProviderConfig({ provider, apiStyle, baseURL: `https://${route.hosts[0]}/v1` }).provider, route.provider);
    for (const baseURL of ["https://proxy.invalid/v1", `https://${route.hosts[0]}.invalid/v1`]) {
      const config = { provider, apiStyle, baseURL, model: "glm-5.3-flash", reasoning: "maximum" };
      const custom = resolveHermesProviderConfig(config);
      assert.match(custom.provider, /^custom:/);
      assert.equal(custom.apiMode, apiStyle === "anthropic" ? "anthropic_messages" : "chat_completions");
      assert.equal(resolveHermesProtocol(config), null);
    }
  });
}

test("explicit Messages protocol is not silently overridden by the provider host", () => {
  const route = resolveHermesProviderConfig({ provider: "zhipu", baseURL: "https://open.bigmodel.cn/api/anthropic", apiStyle: "anthropic" });
  assert.equal(route.apiMode, "anthropic_messages");
  assert.match(route.provider, /^custom:/);
});

test("GLM max uses documented fields and switching suppliers clears its protocol", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-protocol-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new HermesConfigService({ hermesHome: home });
  service.apply({ provider: "zhipu", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash", reasoning: "maximum", nativeReasoning: true });
  const protocol = service.runtime().providerProtocol;
  assert.equal(protocol.reasoningEffort, "max");
  assert.deepEqual(protocol.extraBody, { thinking: { type: "enabled", clear_thinking: false }, tool_stream: true });
  assert.equal(service.read().agent.reasoning_effort, undefined);
  service.apply({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-chat", reasoning: "maximum" });
  assert.equal(service.runtime().providerProtocol, null);
  assert.equal(resolveHermesProtocol({ provider: "zhipu", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "unknown-model" }), null);
});

test("shared progress contract retains stage bodies and ordinary final Markdown", () => {
  const prompt = publicResponseStreamPrompt();
  assert.match(prompt, /工具能力和当前推理等级保持不变/);
  assert.match(prompt, /没有核对就没有 cross/);
  const stream = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const stages = ["第一份数据为 17。", "第二份数据为 29。"];
  const parts = stages.map((message, index) => stream.consume(`<baiqiu-progress>${JSON.stringify({ segmentId: String(index + 1), type: "stage_result", stage: "analyze", status: "completed", message })}</baiqiu-progress>`));
  const final = stream.consume("最终比较：**相差 12**。");
  const tail = stream.flush();
  assert.deepEqual(parts.flatMap(part => part.progressEvents.map(event => event.message)), stages);
  assert.match(JSON.stringify([final, tail]), /相差 12/);
  assert.equal(parts.flatMap(part => part.progressEvents).some(event => event.type === "cross"), false);
});
