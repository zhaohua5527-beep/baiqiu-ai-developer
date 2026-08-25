"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { AgentQuotaManager } = require("../services/resources/agent-quota-manager");
const { AgentBudgetManager } = require("../services/governance/agent-budget-manager");
const { AgentPolicyCenter, DEFAULT_POLICY } = require("../services/governance/agent-policy-center");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-gov-test-"));
}

test("quota manager blocks when quota exceeded", () => {
  const qm = new AgentQuotaManager({ rootDir: tmpRoot() });
  const ok = qm.check("agent-a", { concurrentTasks: 1, dailyTasks: 5, toolCalls: 10 });
  assert.equal(ok.allowed, true, "within quota should pass");
  const exceeded = qm.check("agent-a", { concurrentTasks: 9, dailyTasks: 500, toolCalls: 999 });
  assert.equal(exceeded.allowed, false, "quota exceeded should block");
  assert.ok(exceeded.violations.length > 0, "should report violations");
});

test("budget manager blocks when policy limits exceeded", () => {
  const pc = new AgentPolicyCenter({ rootDir: tmpRoot() });
  const bm = new AgentBudgetManager({ rootDir: tmpRoot(), policyCenter: pc });
  // 模拟超过 maxSteps
  const state = bm.startSession("s1", "t1");
  state.stepCount = 999; // 远超 maxSteps=50
  const check = bm.evaluate(state);
  assert.equal(check.allowed, false, "step limit exceeded should block");
  assert.ok(check.reason, "should have a reason");
});

test("budget block() actually blocks", () => {
  const pc = new AgentPolicyCenter({ rootDir: tmpRoot() });
  const bm = new AgentBudgetManager({ rootDir: tmpRoot(), policyCenter: pc });
  const blocked = bm.block("too_many_retries", "retry limit", {});
  assert.equal(blocked.allowed, false, "explicit block must be allowed=false");
});

test("policy center flags high-risk task as requires confirmation", () => {
  const pc = new AgentPolicyCenter({ rootDir: tmpRoot() });
  const highRisk = pc.checkTask({ goal: "删除所有文件并格式化" }, {});
  assert.equal(highRisk.status, "requires_confirmation", "high-risk should require confirmation");
  assert.equal(highRisk.highRisk, true, "high-risk flag should be true");
  const normal = pc.checkTask({ goal: "生成一份报告" }, {});
  assert.equal(normal.status, "allowed", "normal task should be allowed");
});
