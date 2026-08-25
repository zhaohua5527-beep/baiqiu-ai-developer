"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { classifyTiming, timingForTask, TIMING_PROFILES } = require("../services/task-timing");

test("large/complex tasks get the agent_execution progress profile", () => {
  assert.equal(classifyTiming("写一篇论文"), "agent_execution");
  assert.equal(classifyTiming("开发一个项目管理系统"), "agent_execution");
  assert.equal(classifyTiming("分析这份数据并给出建议"), "agent_execution");
  assert.equal(classifyTiming("帮我写小说"), "agent_execution");
  assert.equal(classifyTiming("研究一下市场行情"), "agent_execution");
});

test("local deterministic tasks keep their progress profiles", () => {
  assert.equal(classifyTiming("打开计算器"), "local_launch");
  assert.equal(classifyTiming("帮我生成一份表格"), "local_create");
});

test("real routing wins over text classification for HMS-bound work", () => {
  // 走 Hermes（task_brain + execute）→ agent_execution 展示节奏，即使文本像本地任务
  const hermesBound = timingForTask({
    message: "帮我做一个计算器软件",
    intent: "execute",
    routing: "task_brain",
    executionMode: "execute"
  });
  assert.equal(hermesBound.profile, "agent_execution", "task_brain+execute should get agent_execution");
  assert.equal(hermesBound.hardTimeoutMs, 0, "White Ball must not terminate HMS work by duration");

  // 纯本地确定性任务（无 routing 信息）→ 保持短超时
  const local = timingForTask({ message: "打开计算器", intent: "open" });
  assert.equal(local.profile, "local_launch", "plain open stays local_launch");
});

test("delegate mode gets the agent progress profile regardless of text", () => {
  const delegated = timingForTask({ message: "让几个 agent 一起做", routing: "ceo", executionMode: "delegate" });
  assert.equal(delegated.profile, "agent_execution");
});

test("agent_execution has no White Ball hard timeout", () => {
  const timing = timingForTask({ message: "开发一个项目" });
  assert.equal(timing.profile, "agent_execution");
  assert.equal(timing.hardTimeoutMs, 0);
});

test("task profiles are unbounded while update download keeps its transport timeout", () => {
  for (const key of ["local_launch", "local_create", "model_response", "agent_execution"]) {
    assert.equal(TIMING_PROFILES[key].hardTimeoutMs, 0, key);
  }
  assert.ok(TIMING_PROFILES.update_download.hardTimeoutMs > 0);
});

test("making calculator software is a dev task, not a 90s local create", () => {
  // "做一个计算器软件"含"软件"，属于开发任务，应走 agent_execution 展示节奏。
  assert.equal(classifyTiming("做一个计算器软件并打开"), "agent_execution");
  assert.equal(classifyTiming("帮我做一个软件"), "agent_execution");
  // 空 route 时（前端未传 conversationUnderstanding）也走 agent_execution
  assert.equal(timingForTask({ message: "做一个计算器软件并打开" }).profile, "agent_execution");
  // 但"做表格"仍是本地短操作
  assert.equal(classifyTiming("做一个会员数据表格"), "local_create");
});
