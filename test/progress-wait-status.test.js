"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const from = source.indexOf("function updateExecutionOperationClocks(");
const to = source.indexOf("function paintExecutionCurrentOperations(", from);
const update = new Function("mutatePreservingMessageViewport", source.slice(from, to) + "; return updateExecutionOperationClocks;")(mutation => mutation());

test("live transport is distinguished from stale public steps and does not fake tool activity", () => {
  const clock = { textContent: "" };
  const row = { dataset: { updatedAt: "1000", tool: "0" }, querySelector: () => clock };
  const panel = { children: [row], childElementCount: 1 };
  const root = { dataset: { lifecycle: "running" }, __executionOperationPanel: panel, __transportActivityAt: 24000 };
  update(root, 25000);
  assert.equal(clock.textContent, "接口仍在传输数据，等待新的公开内容 · 距上次内容更新 1s");
  update(root, 30000);
  assert.equal(clock.textContent, "接口仍在传输数据，等待新的公开内容 · 距上次内容更新 6s");
  row.dataset.tool = "1";
  update(root, 30000);
  assert.equal(clock.textContent, "等待工具后续事件 · 距上次更新 29s");
  root.dataset.lifecycle = "completed";
  update(root, 31000);
  assert.equal(panel.hidden, true);
});
