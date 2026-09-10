"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { HermesAcpClient } = require("../services/hermes-acp-client");

test("White Ball tools use the in-process ACP MCP transport", async () => {
  const calls = [];
  const client = new HermesAcpClient();
  client.initialization = {
    agentCapabilities: { mcpCapabilities: { acp: true } }
  };
  assert.equal(client.supportsAcpMcp(), true);

  const server = client.configureMcpServer("session-1", {
    signature: "catalog-v1",
    tools: [{
      name: "knowledge_search",
      description: "Search local knowledge",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }],
    callTool: async (request) => {
      calls.push(request);
      return {
        content: [{ type: "text", text: "matched" }],
        structuredContent: { success: true, result: "matched" },
        isError: false
      };
    }
  });
  const { connectionId } = client.connectMcp({ serverId: server.serverId });

  const initialized = await client.messageMcp({
    connectionId,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");

  const listed = await client.messageMcp({ connectionId, method: "tools/list" });
  assert.deepEqual(listed.tools, server.tools);

  const result = await client.messageMcp({
    connectionId,
    method: "tools/call",
    params: { name: "knowledge_search", arguments: { query: "weather" } }
  });
  assert.equal(result.structuredContent.result, "matched");
  assert.deepEqual(calls, [{ name: "knowledge_search", arguments: { query: "weather" } }]);

  client.disconnectMcp({ connectionId });
  await assert.rejects(
    client.messageMcp({ connectionId, method: "tools/list" }),
    /Unknown Baiqiu MCP connection/
  );
});
