"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HmsProjectRuntime,
  compactWorkerResult,
  extractDelegatedWorkerSpecs,
  projectPlanningPrompt
} = require("../services/hms-project-runtime");

test("CEO summary input excludes live transcripts and keeps structured evidence", () => {
  const compact = compactWorkerResult({
    delegationId: "deleg-1",
    taskIndex: 2,
    status: "completed",
    summary: "已完成库存分析",
    artifacts: [{ path: "D:\\workspace\\inventory.xlsx", type: "spreadsheet" }],
    validation: { passed: true },
    liveTranscript: "very large internal transcript"
  });
  assert.equal(compact.summary, "已完成库存分析");
  assert.equal(compact.artifacts[0].path, "D:\\workspace\\inventory.xlsx");
  assert.equal(compact.liveTranscript, undefined);
});

test("HMS project runtime owns dynamic planning and CEO summary", async () => {
  const prompts = [];
  const phases = [];
  const projected = [];
  const runtime = new HmsProjectRuntime({
    idFactory: () => "hms-project-run-1",
    prompt: async (prompt, options) => {
      prompts.push({ prompt, options });
      if (options.phase === "planning") {
        return {
          status: "done",
          text: "delegated",
          hermesSessionId: "hms-parent-1",
          toolCalls: [{
            toolCallId: "tool-1",
            title: "delegate_task",
            status: "completed",
            rawInput: {
              tasks: [
                { name: "库存分析", role: "分析员", goal: "检查库存" },
                { name: "价格分析", role: "分析员", goal: "检查价格" },
                { name: "交付核验", role: "核验员", goal: "核验文件" }
              ]
            },
            rawOutput: { delegation_id: "deleg_native123" }
          }]
        };
      }
      return { status: "done", text: "CEO 最终交付", hermesSessionId: "hms-parent-1", toolCalls: [] };
    },
    waitForDelegation: async (ids) => {
      assert.deepEqual(ids, ["deleg_native123"]);
      return {
        status: "completed",
        completions: [{
          delegationId: "deleg_native123",
          status: "completed",
          task: { tasks: [
            { name: "库存分析", role: "分析员", goal: "检查库存" },
            { name: "价格分析", role: "分析员", goal: "检查价格" },
            { name: "交付核验", role: "核验员", goal: "核验文件" }
          ] },
          event: { results: [] }
        }],
        results: [0, 1, 2].map((taskIndex) => ({
          delegationId: "deleg_native123",
          taskIndex,
          status: "completed",
          summary: `结果 ${taskIndex + 1}`,
          apiCalls: 1,
          liveTranscript: `transcript ${taskIndex + 1}`
        }))
      };
    }
  });

  const result = await runtime.run({
    project: { id: "project-1", name: "测试项目", description: "完成分析" },
    goal: "并行完成三项工作",
    workspace: "D:\\workspace",
    roleTemplates: [{ id: "template-1", name: "通用模板", role: "通用人员" }],
    onPhase: (event) => phases.push(event.phase),
    onDelegation: (event) => projected.push({ stage: "delegated", count: event.workers.length }),
    onWorkers: (event) => projected.push({ stage: "completed", count: event.workers.length })
  });

  assert.equal(result.success, true);
  assert.equal(result.text, "CEO 最终交付");
  assert.equal(result.workers.length, 3);
  assert.deepEqual(phases, ["planning", "workers", "summary"]);
  assert.deepEqual(projected, [
    { stage: "delegated", count: 3 },
    { stage: "completed", count: 3 }
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].options.phase, "planning");
  assert.equal(prompts[1].options.phase, "summary");
  assert.match(prompts[0].prompt, /不限制你创建更多 Worker/);
  assert.match(prompts[1].prompt, /来自黑球 state\.db/);
});

test("HMS project runtime fails closed without real delegation evidence", async () => {
  let waitCalls = 0;
  const runtime = new HmsProjectRuntime({
    prompt: async () => ({ status: "done", text: "我已经委派并完成", toolCalls: [] }),
    waitForDelegation: async () => {
      waitCalls += 1;
      return { status: "completed", results: [] };
    }
  });

  await assert.rejects(
    runtime.run({ project: { id: "project-1" }, goal: "完成项目", workspace: "D:\\workspace" }),
    (error) => error.code === "HMS_PROJECT_DELEGATION_REQUIRED" && /不会回退/.test(error.message)
  );
  assert.equal(waitCalls, 0);
});

test("delegated Worker specs come from HMS tool input rather than role templates", () => {
  const specs = extractDelegatedWorkerSpecs([{
    title: "delegate_task",
    rawInput: { tasks: [
      { name: "A", role: "研究", goal: "搜索" },
      { name: "B", role: "写作", goal: "汇总" }
    ] },
    rawOutput: "delegation_id=deleg_abc123"
  }]);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((item) => item.name), ["A", "B"]);
  assert.ok(specs.every((item) => item.delegationId === "deleg_abc123"));

  const prompt = projectPlanningPrompt({
    project: { id: "p1", name: "P" },
    goal: "目标",
    runId: "r1",
    workspace: "D:\\workspace",
    roleTemplates: [{ name: "唯一模板" }]
  });
  assert.match(prompt, /岗位模板（只作为能力偏好/);
  assert.doesNotMatch(prompt, /任务数不能超过/);
});
