"use strict";

// 集成试验场 · mock 模型调用，验证白球工具路由（不烧 token）
// 原理：callChatCompletion 接受 fetchImpl，mock 成返回固定 JSON 的假模型，
// 验证白球收到工具调用后是否正确执行工具并继续循环。

const assert = require("node:assert/strict");
const test = require("node:test");
const { callChatCompletion } = require("../../services/model-adapter");
const { contentText, publicReasoningDelta } = require("../../services/hms-progress");

// 构造假模型响应（OpenAI 风格）
function fakeModelResponse({ messages = [], toolCalls = [], text = "" } = {}) {
  const message = {};
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (text) message.content = text;
  return {
    choices: [{ message }],
    usage: { total_tokens: 0 }
  };
}

// mock fetchImpl：返回预设响应，并记录收到的请求体（供断言）
function mockFetch(responder) {
  const calls = [];
  return {
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => responder(calls.at(-1)) };
    },
    calls
  };
}

test("callChatCompletion sends tools in request body (no token consumed)", async () => {
  const { fetchImpl, calls } = mockFetch(() => fakeModelResponse({ text: "完成" }));
  const result = await callChatCompletion({
    providerId: "deepseek",
    provider: { baseURL: "http://mock.example/v1", apiStyle: "openai", model: "deepseek-chat", apiKey: "mock-key" },
    body: {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "搜索天气" }],
      tools: [{ type: "function", function: { name: "web_search", description: "搜索", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto"
    },
    fetchImpl
  });
  // 断言：请求体带 tools
  assert.ok(calls.length === 1, "should call fetch once");
  assert.ok(calls[0].body.tools.length === 1, "request should include tools");
  assert.equal(calls[0].body.tools[0].function.name, "web_search");
  // 断言：返回格式正确
  assert.ok(result.choices?.[0]?.message?.content === "完成");
});

test("callChatCompletion handles tool_calls response", async () => {
  const { fetchImpl } = mockFetch(() => fakeModelResponse({
    toolCalls: [{
      id: "call_1",
      type: "function",
      function: { name: "web_search", arguments: JSON.stringify({ query: "今天天气" }) }
    }]
  }));
  const result = await callChatCompletion({
    providerId: "deepseek",
    provider: { baseURL: "http://mock.example/v1", apiStyle: "openai", model: "deepseek-chat", apiKey: "mock-key" },
    body: { messages: [{ role: "user", content: "查天气" }], tools: [] },
    fetchImpl
  });
  assert.ok(result.choices?.[0]?.message?.tool_calls?.length === 1, "should return tool_calls");
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "web_search");
});

test("anthropic style maps tools to input_schema", async () => {
  const { fetchImpl, calls } = mockFetch(() => fakeModelResponse({ text: "ok" }));
  await callChatCompletion({
    providerId: "anthropic",
    provider: { baseURL: "http://mock.example", apiStyle: "anthropic", model: "claude", apiKey: "mock-key" },
    body: {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "web_search", description: "s", parameters: { type: "object", properties: {} } } }]
    },
    fetchImpl
  });
  // Anthropic 风格 tools 应映射成 input_schema
  const sent = calls[0].body;
  assert.ok(Array.isArray(sent.tools), "anthropic should have tools array");
  assert.ok(sent.tools[0].input_schema, "anthropic tools should have input_schema");
  assert.equal(sent.tools[0].name, "web_search");
});

test("streaming reasoning and tool calls are forwarded as live deltas", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先确认目标。"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"test\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"最终回答"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  const deltas = [];
  const result = await callChatCompletion({
    providerId: "deepseek",
    provider: { baseURL: "http://mock.example/v1", apiStyle: "openai", model: "deepseek-chat", apiKey: "mock-key" },
    body: { stream: true, messages: [{ role: "user", content: "test" }] },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body,
      headers: { get: () => "text/event-stream" }
    }),
    onDelta: (delta) => deltas.push(delta)
  });

  assert.equal(deltas[0].reasoningContent, "先确认目标。");
  assert.equal(deltas.some((delta) => delta.toolCall?.name === "web_search"), true);
  assert.equal(deltas.some((delta) => delta.content === "最终回答"), true);
  assert.equal(result.choices[0].message.reasoning_content, "先确认目标。");
  assert.equal(result.choices[0].message.content, "最终回答");
});

test("HMS reasoning preserves only the sanitized public delta", () => {
  assert.equal(contentText({ content: { type: "thinking", thinking: "先判断" } }), "先判断");
  assert.equal(contentText({ content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "B" }] }), "AB");
  assert.equal(contentText({ thought: "C" }), "C");
  assert.equal(publicReasoningDelta("token=secret <baiqiu-final>隐藏</baiqiu-final>"), "token=[已隐藏] 隐藏");
});
