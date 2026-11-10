"use strict";

const { DevelopmentCapabilityRegistry } = require("./development-capability-registry");

const DEVELOPMENT_WORKER_CAPABILITIES = Object.freeze([
  "code_search",
  "code_read",
  "code_modify",
  "test_execute"
]);

const DEVELOPMENT_CHANGE_SEQUENCE = Object.freeze([
  Object.freeze({ id: "development.analyze", action: "analyze", capability: "code_search", title: "Analyze and locate the update module" }),
  Object.freeze({ id: "development.inspect", action: "inspect", capability: "code_read", title: "Inspect the current update implementation" }),
  Object.freeze({ id: "development.modify", action: "modify", capability: "code_modify", title: "Apply the bounded update-module change" }),
  Object.freeze({ id: "development.test", action: "test", capability: "test_execute", title: "Run focused update-module tests" })
]);

function argsForStep(step = {}, taskGoal = "", appRoot = "") {
  if (step.capability === "code_search") {
    return { command: 'rg -n "update|updater|更新" . -g "*.js"', cwd: appRoot, taskGoal };
  }
  if (step.capability === "code_read") {
    return { command: 'rg -n -C 4 "update|updater|更新" . -g "*.js"', cwd: appRoot, taskGoal };
  }
  if (step.capability === "code_modify") {
    return { taskGoal, requiresPreparedPatch: true };
  }
  if (step.capability === "test_execute") {
    return { command: "node --test tests/updater.test.js tests/updater-security.test.js", cwd: appRoot, taskGoal };
  }
  return { taskGoal };
}

class DevelopmentPlanner {
  constructor({ capabilityRegistry = null } = {}) {
    this.capabilityRegistry = capabilityRegistry || new DevelopmentCapabilityRegistry();
  }

  createPlan({ taskGoal = "", permissions = {}, tools = [], appRoot = "" } = {}) {
    const requiredCapabilities = DEVELOPMENT_CHANGE_SEQUENCE.map((step) => step.capability);
    const resolution = this.capabilityRegistry.resolveRequired(requiredCapabilities, { permissions, tools });
    const byId = new Map(resolution.capabilities.map((item) => [item.capabilityId, item]));
    const steps = DEVELOPMENT_CHANGE_SEQUENCE.map((definition, index) => {
      const capability = byId.get(definition.capability);
      const previous = index > 0 ? DEVELOPMENT_CHANGE_SEQUENCE[index - 1].id : "";
      return {
        ...definition,
        intent: "development_task",
        type: "development_capability",
        requiredPermission: capability?.requiredPermission || "",
        toolId: capability?.tools?.[0] || "",
        args: argsForStep(definition, taskGoal, appRoot),
        dependsOn: previous ? [previous] : [],
        verifier: definition.action === "test" ? "tool_success" : "development_step",
        retryLimit: 0,
        executable: capability?.status === "available",
        reason: capability?.reason || ""
      };
    });
    return Object.freeze({
      planType: "development_change",
      taskGoal: String(taskGoal || "").trim(),
      requiredCapabilities: Object.freeze(requiredCapabilities),
      missingCapabilities: resolution.missing,
      status: resolution.available ? "ready" : "capability_missing",
      workerRequirement: Object.freeze({
        role: "developer",
        capabilities: DEVELOPMENT_WORKER_CAPABILITIES
      }),
      steps: Object.freeze(steps.map(Object.freeze))
    });
  }
}

module.exports = {
  DEVELOPMENT_CHANGE_SEQUENCE,
  DEVELOPMENT_WORKER_CAPABILITIES,
  DevelopmentPlanner,
  argsForStep
};
