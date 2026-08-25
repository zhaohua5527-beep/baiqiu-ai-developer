"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 白球只映射项目状态，不按运行时长终止 CEO、Worker 或最终汇总。

test("CEO orchestration uses agent_execution progress with no hard deadline", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  // 第一个 CEO 分支（submitProductWithTaskBrain 内）
  const firstCeo = mainSource.indexOf('routing === "ceo"');
  const segment = mainSource.slice(firstCeo, firstCeo + 1200);
  assert.match(segment, /agent_execution/);
  assert.match(segment, /hard_timeout_ms: 0/);
});

test("both CEO branches disable White Ball hard timing", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const count = (mainSource.match(/hard_timeout_ms: 0/g) || []).length;
  assert.ok(count >= 2, `expected >=2 unbounded CEO timing overrides, got ${count}`);
  assert.doesNotMatch(mainSource, /AbortSignal\.timeout\(10 \* 60 \* 1000\)/);
});

test("timingForTask maps ceo routing to agent_execution", () => {
  const { timingForTask } = require("../services/task-timing");
  const t = timingForTask({ message: "做一个计算器软件", routing: "ceo", executionMode: "delegate" });
  assert.equal(t.profile, "agent_execution");
  assert.equal(t.hardTimeoutMs, 0);
});
