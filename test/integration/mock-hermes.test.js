"use strict";

// 集成试验场 · mock Hermes 会话，验证白球处理 Hermes 工具调用（不烧 token）
// 原理：HermesAcpClient 的 prompt 依赖 session.nextUpdate()，mock 成返回
// 预设的 tool_call / 文本更新，验证白球如何消费 Hermes 的工具调用流。

const assert = require("node:assert/strict");
const test = require("node:test");
const { HermesAcpClient } = require("../../services/hermes-acp-client");

// 构造一个 mock Hermes 会话，按序返回 updates
// 注意：prompt 从 message.update 取 update（hermes-acp-client.js:482），
// 所以 nextUpdate 必须返回 {update: {...}} 包装。
function mockHermesSession({ updates = [], result = null }) {
  let index = 0;
  return {
    hermesSessionId: "hermes-mock-session",
    active: {
      prompt() {},
      nextUpdate() {
        if (index < updates.length) return Promise.resolve({ update: updates[index++] });
        return Promise.resolve({ kind: "stop", stopReason: "end_turn", response: result });
      },
      dispose() {}
    }
  };
}

test("HermesAcpClient collects tool_call updates from a mocked session", async () => {
  const client = new HermesAcpClient({});
  client.ensureSession = async () => mockHermesSession({
    updates: [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "我准备搜索" }
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        toolCall: { title: "web_search", rawInput: { query: "今天天气" } }
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        result: { success: true, result: "晴天 25 度" }
      }
    ],
    result: { output: "搜索完成：晴天 25 度" }
  });

  const result = await client.prompt("local-session", "查天气", { timeoutMs: 5000 });
  assert.equal(result.status, "done", "should complete");
  assert.ok(result.text.includes("我准备搜索"), "should collect agent text");
  assert.ok(result.toolCalls.length >= 1, "should collect tool calls");
  const call = result.toolCalls.find((c) => c.toolCallId === "tool-1");
  assert.ok(call, "should find tool-1");
  assert.equal(call.toolCall?.title || call.title, "web_search", "tool title should be web_search");
});

test("HermesAcpClient returns files from tool evidence", async () => {
  const tmpFile = require("node:path").join(require("node:os").tmpdir(), `hermes-mock-out-${Date.now()}.txt`);
  require("node:fs").writeFileSync(tmpFile, "mock output");
  const client = new HermesAcpClient({});
  client.ensureSession = async () => {
    let index = 0;
    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
        toolCall: { title: "write_file", rawInput: { path: tmpFile, content: "hello" } }
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-2",
        result: { success: true, output: `saved: ${tmpFile}` }
      }
    ];
    return {
      hermesSessionId: "hermes-mock-session",
      active: {
        prompt() {},
        nextUpdate() {
          if (index < updates.length) return Promise.resolve({ update: updates[index++] });
          return Promise.resolve({ kind: "stop", stopReason: "end_turn", response: { output: "文件已写入" } });
        },
        dispose() {}
      }
    };
  };
  const result = await client.prompt("local-session-2", "写文件", { timeoutMs: 5000 });
  assert.ok(result.files.length >= 1, "should collect file evidence");
  assert.equal(result.files[0].path, tmpFile, "file path should match");
});
