"use strict";

const AGENT_ROLES = Object.freeze({
  CEO: "CEO",
  WORKER: "WORKER",
  QA: "QA",
  ASSISTANT: "ASSISTANT"
});

const ROLE_PROTOCOL = Object.freeze({
  [AGENT_ROLES.CEO]: Object.freeze({
    responsibility: "understand_decide_schedule_report",
    canExecuteWorkerTask: false,
    personalityScope: "tone_only",
    reportSections: Object.freeze(["任务接收", "任务拆解", "人员分配", "执行状态", "验证结果", "最终交付"])
  }),
  [AGENT_ROLES.WORKER]: Object.freeze({ responsibility: "execute_assigned_task", canExecuteWorkerTask: true }),
  [AGENT_ROLES.QA]: Object.freeze({ responsibility: "verify_execution", canExecuteWorkerTask: false }),
  [AGENT_ROLES.ASSISTANT]: Object.freeze({ responsibility: "communicate_and_answer", canExecuteWorkerTask: false })
});

function roleForIntent({ intent = "conversation", intentType = "conversation", sessionType = "" } = {}) {
  if (intentType === "system_test") return AGENT_ROLES.QA;
  if (intentType === "execution" || ["dispatch_task", "project_management", "agent_dispatch"].includes(intent)) {
    return String(sessionType || "").toUpperCase() === "CEO" ? AGENT_ROLES.CEO : AGENT_ROLES.WORKER;
  }
  return AGENT_ROLES.ASSISTANT;
}

function selectedPathFor({ intent = "conversation", intentType = "conversation", role = AGENT_ROLES.ASSISTANT } = {}) {
  if (intentType === "capability_query") return "capability_read";
  if (intentType === "status_query") return "status_read";
  if (intentType === "configuration") return "configuration_flow";
  if (intentType === "system_test") return "qa_validation";
  if (intent === "project_management" && role === AGENT_ROLES.CEO) return "ceo_orchestration";
  if (["dispatch_task", "agent_dispatch"].includes(intent) && role === AGENT_ROLES.CEO) return "ceo_orchestration";
  if (role === AGENT_ROLES.CEO) return "ceo_orchestration";
  if (role === AGENT_ROLES.WORKER) return "worker_execution";
  return "assistant_response";
}

module.exports = { AGENT_ROLES, ROLE_PROTOCOL, roleForIntent, selectedPathFor };
