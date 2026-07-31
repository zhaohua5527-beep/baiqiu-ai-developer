const { getDefaultAgentEventBus, AGENT_EVENTS } = require("../neural-core/agent-event-bus");
const { AgentManager } = require("../neural-core/agent-manager");
const { buildExecutionContext } = require("../execution-metadata");
const { userFacingError } = require("../user-facing-error-adapter");

function executablePlanTasks(planObject = {}) {
  return (Array.isArray(planObject.tasks) ? planObject.tasks : [])
    .filter((item) => item && item.executable !== false && String(item.toolId || "").trim());
}

function capabilityMissingResult({ task = {}, sessionId = "", traceId = "", execution = null } = {}) {
  const planObject = task.planObject || {};
  const missingCapabilities = Array.isArray(planObject.missingCapabilities)
    ? planObject.missingCapabilities.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const incompleteDevelopmentPlan = planObject.planType === "development_change"
    && (planObject.developmentStatus === "capability_missing" || missingCapabilities.length > 0);
  if (!incompleteDevelopmentPlan && executablePlanTasks(planObject).length > 0) return null;
  const planTasks = Array.isArray(planObject.tasks) ? planObject.tasks : [];
  const failureType = incompleteDevelopmentPlan || planTasks.some((item) => item?.executable === false)
    ? "capability_mismatch"
    : "tool_missing";
  const requiredCapability = task.context?.taskBrain?.required_capability
    || task.classification
    || "general_execution";
  const detail = missingCapabilities.length
    ? `缺少能力：${missingCapabilities.join(", ")}`
    : failureType === "tool_missing"
    ? "\u7f3a\u5c11\u5de5\u5177\uff0c\u5f53\u524d\u8ba1\u5212\u672a\u5339\u914d\u5230\u53ef\u6267\u884c\u5de5\u5177"
    : "\u80fd\u529b\u4e0d\u5339\u914d\uff0c\u5f53\u524d\u8ba1\u5212\u6ca1\u6709\u53ef\u6267\u884c\u6b65\u9aa4";
  const technicalMessage = `system_capability_missing: ${detail}\u3002`;
  const message = userFacingError({ code: "system_capability_missing", message: technicalMessage }, {
    classification: task.classification,
    domain: task.context?.conversationUnderstanding?.domain || ""
  });
  const failure = {
    handled: true,
    success: false,
    status: "capability_missing",
    code: "system_capability_missing",
    errorCode: "system_capability_missing",
    failureType,
    requiredCapability,
    missingCapabilities,
    decisionId: execution?.metadata?.decisionId || task.decisionId || "",
    taskGoal: task.context?.taskBrain?.task_goal || task.context?.taskBrain?.original_goal || task.input || task.message || "",
    response: {
      success: false,
      status: "capability_missing",
      code: "system_capability_missing",
      failureType,
      missingCapabilities,
      error: technicalMessage,
      userMessage: message
    },
    normalized: {
      success: false,
      status: "capability_missing",
      result: null,
      error: technicalMessage,
      userMessage: message,
      errorCode: "system_capability_missing",
      failureType,
      requiredCapability,
      missingCapabilities,
      meta: {
        duration: 0,
        evidence: { planObject, verifierStarted: false }
      }
    },
    text: message
  };
  return {
    taskId: task.taskId,
    sessionId,
    traceId,
    success: false,
    status: "capability_missing",
    code: "system_capability_missing",
    error: technicalMessage,
    userMessage: message,
    failureType,
    requiredCapability,
    missingCapabilities,
    result: failure
  };
}

class ProductEventAdapter {
  constructor({ eventBus = null, agentManager = null, taskOrchestrator = null } = {}) {
    this.eventBus = eventBus || getDefaultAgentEventBus();
    this.agentManager = agentManager || new AgentManager({ eventBus: this.eventBus });
    this.taskOrchestrator = taskOrchestrator;
  }

  async submit(task = {}) {
    const execution = buildExecutionContext({
      ...task,
      taskId: task.context?.taskBrain?.task_id || task.taskId,
      assignmentId: task.context?.taskBrain?.assignment_id || "",
      agentId: task.sessionId || ""
    });
    const sessionId = task.sessionId || task.taskId || "product-session";
    const traceId = task.traceId || task.taskId || sessionId;
    this.eventBus.publish(AGENT_EVENTS.INTENT_DETECTED, {
      sessionId,
      traceId,
      taskId: task.taskId,
      intent: task.intent || "",
      userIntent: task.input || task.message || "",
      goal: task.input || task.message || "",
      productId: task.productId || ""
    });

    if (!this.taskOrchestrator) {
      return {
        success: false,
        status: "failed",
        error: "ProductEventAdapter requires taskOrchestrator",
        taskId: task.taskId
      };
    }
    if (!task.planObject) {
      return {
        taskId: task.taskId,
        sessionId,
        traceId,
        success: false,
        status: "failed",
        result: {
          handled: true,
          normalized: {
            success: false,
            error: "Product task requires a Neural Core plan",
            result: null
          },
          text: "请补充具体需求后我再执行。"
        }
      };
    }

    const capabilityFailure = capabilityMissingResult({ task, sessionId, traceId, execution });
    if (capabilityFailure) return capabilityFailure;

    const result = await this.agentManager.dispatchTask({
      taskOrchestrator: this.taskOrchestrator,
      sessionId,
      message: task.input || task.message || "",
      planObject: task.planObject,
      contextPatch: {
        ...(task.context || {}),
        executionMetadata: execution.metadata,
        decisionId: execution.metadata.decisionId,
        permissions: execution.metadata.permissions,
        taskId: execution.binding.taskId,
        assignmentId: execution.binding.assignmentId,
        agentId: execution.binding.agentId,
        traceId,
        productId: task.productId || "",
        productTaskId: task.taskId,
        taskGoal: task.context?.taskBrain?.task_goal || task.context?.taskBrain?.original_goal || task.input || task.message || "",
        requiredCapability: task.context?.taskBrain?.required_capability || task.classification || "general_execution"
      },
      signal: task.signal || null
    });

    return {
      taskId: task.taskId,
      sessionId,
      traceId,
      success: Boolean(result?.normalized?.success ?? result?.success),
      status: (result?.normalized?.success ?? result?.success) ? "success" : "failed",
      result
    };
  }

  getTrace(traceId = "") {
    return this.eventBus.getTrace(traceId);
  }
}

module.exports = { ProductEventAdapter, executablePlanTasks, capabilityMissingResult };
