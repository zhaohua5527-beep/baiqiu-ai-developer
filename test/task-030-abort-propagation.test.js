"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// task-030 深层修复验证：
// 1. 工具执行层用 executeWithSignal 让 abort 贯穿（中断后 web_search/browser 不再继续跑）
// 2. executeHermes 用用户原话而非 taskBrain.prompt（消除污染的 web_search query）
// 3. sendWithHermes 迟到写回保护（abort 后不追加消息到会话）

test("ToolExecutionService races tool execution against abort signal", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "services", "tool-execution-service.js"), "utf8");
  assert.match(mainSource, /async executeWithSignal/);
  assert.match(mainSource, /Promise\.race|new Promise\(\(resolve, reject\)/);
  assert.match(mainSource, /signal\.addEventListener\("abort"/);
  assert.match(mainSource, /TASK_CANCELLED/);
  assert.match(mainSource, /signal\.aborted/);
});

test("aborted tool call rejects before the tool result", async () => {
  const { ToolExecutionService } = require("../services/tool-execution-service");
  const controller = new AbortController();
  // 模拟一个永不结束的工具
  const registry = {
    execute: () => new Promise(() => {}), // 永不 resolve
    list: () => []
  };
  const service = new ToolExecutionService({
    registry,
    selector: { approveToolCall: () => ({ approved: true, reason: "" }) },
    ensureRunActive: () => {},
    formatText: (r) => String(r?.result ?? r?.error ?? "")
  });
  const promise = service.execute({ toolId: "slow_tool", args: {}, context: { signal: controller.signal } });
  // 中断 signal，工具执行应被中断而非挂起
  controller.abort();
  const result = await promise;
  assert.equal(result.response?.success, false);
  assert.match(String(result.response?.error || ""), /TASK_CANCELLED|任务已被用户终止/);
});

test("executeHermes passes user message not taskBrain.prompt", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "services", "product-execution-services.js"), "utf8");
  const hermesStart = mainSource.indexOf("async executeHermes");
  const segment = mainSource.slice(hermesStart, hermesStart + 2000);
  assert.ok(segment.includes("sendWithHermes"));
  // 必须用 effectiveText / 用户原话，不能是 taskBrain.prompt
  assert.match(segment, /text: effectiveText \|\| payload\?\.originalText/);
  assert.ok(!/text: taskBrain\?\.prompt/.test(segment), "must not pass taskBrain.prompt as user message");
});

test("sendWithHermes suppresses late write after abort", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function sendWithHermes");
  const segment = mainSource.slice(start, start + 4000);
  assert.match(segment, /writeSuppressedByAbort/);
  assert.match(segment, /const aborted = Boolean/);
  assert.match(segment, /options\.signal && options\.signal\.aborted/);
  assert.match(segment, /run\?\.controller\?\.signal\?\.aborted/);
  assert.match(segment, /!aborted/);
});
