"use strict";

const { AGENT_ROLES, selectedPathFor } = require("./agent-role-protocol");

const MANAGED_INTENTS = new Set(["dispatch_task", "project_management", "agent_dispatch"]);

function capabilityFailure(capabilityContext = {}, intent = "", requiredCapability = "") {
  const availability = capabilityContext.availability || {};
  if (availability.hermesAcp === false && MANAGED_INTENTS.has(intent)) {
    return "黑球运行时不可用";
  }
  if (availability.taskRepository === false) return "Task Repository 不可用";
  if (availability.hermesDelegation === false && MANAGED_INTENTS.has(intent)) {
    return "黑球任务委派不可用";
  }
  if (MANAGED_INTENTS.has(intent)
    && capabilityContext.session?.type === AGENT_ROLES.CEO
    && capabilityContext.project?.available === false) {
    return "当前项目根会话未绑定有效项目";
  }
  return "";
}

function capabilityWarning(capabilityContext = {}, requiredCapability = "") {
  const exactCapability = (Array.isArray(capabilityContext.capabilities) ? capabilityContext.capabilities : [])
    .find((item) => [item.id, item.name, item.source]
      .some((value) => String(value || "").toLowerCase() === String(requiredCapability || "").toLowerCase()));
  return exactCapability && exactCapability.status !== "available"
    ? `专用能力未就绪，已使用黑球通用执行能力：${requiredCapability}`
    : "";
}

class TaskDispatchRouter {
  route({ intent = "conversation", intentType = "conversation", role = AGENT_ROLES.ASSISTANT, needExecution = false, capabilityContext = {}, taskGoal = "", requiredCapability = "" } = {}) {
    const route = selectedPathFor({ intent, intentType, role });
    const warning = needExecution ? capabilityWarning(capabilityContext, requiredCapability) : "";
    return Object.freeze({
      allowed: true,
      execute: Boolean(needExecution),
      route,
      reason: "",
      warning,
      taskGoal,
      requiredCapability
    });
  }
}

module.exports = { TaskDispatchRouter, MANAGED_INTENTS, capabilityFailure, capabilityWarning };
