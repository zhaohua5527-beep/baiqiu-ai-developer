const { createAgentContext } = require("../core/agent-context");
const { createAgentResult, normalizeAgentStatus } = require("../core/agent-result");
const { getDefaultAgentStateManager } = require("./agent_state_manager");
const { getDefaultAgentEventBus, AGENT_EVENTS } = require("./neural-core/agent-event-bus");
const { buildExecutionContext } = require("./execution-metadata");
const { userFacingError } = require("./user-facing-error-adapter");

class ProductExecutionRouter {
  constructor({ logger = null, tracer = null, stateManager = null, eventBus = null } = {}) {
    this.logger = typeof logger === "function" ? logger : null;
    this.tracer = tracer;
    this.stateManager = stateManager || getDefaultAgentStateManager();
    this.eventBus = eventBus || getDefaultAgentEventBus();
  }

  createContext(input = {}) {
    const context = createAgentContext(input);
    context.taskContext = this.stateManager.getTaskContext(context.conversationId || context.sessionId || context.requestId, {
      taskId: context.requestId,
      userIntent: input.intent || "",
      goal: context.userMessage
    });
    return context;
  }

  async run(inputContext = {}, strategies = []) {
    const execution = buildExecutionContext(inputContext);
    const context = this.createContext(inputContext);
    Object.defineProperties(context, {
      executionMetadata: { value: execution.metadata, enumerable: true, writable: false, configurable: false },
      decisionId: { value: execution.metadata.decisionId, enumerable: true, writable: false, configurable: false },
      permissions: { value: execution.metadata.permissions, enumerable: true, writable: false, configurable: false },
      taskId: { value: execution.binding.taskId, enumerable: true, writable: false, configurable: false },
      assignmentId: { value: execution.binding.assignmentId, enumerable: true, writable: false, configurable: false }
    });
    const stateSessionId = context.conversationId || context.sessionId || context.requestId;
    this.eventBus.publish(AGENT_EVENTS.INTENT_DETECTED, {
      sessionId: stateSessionId,
      taskId: context.requestId,
      userMessage: context.userMessage,
      goal: context.userMessage,
      userIntent: inputContext.intent || ""
    });
    this.trace("INFO", "[ProductExecutionRouter START]", {
      requestId: context.requestId,
      decisionId: context.decisionId,
      taskId: context.taskId,
      assignmentId: context.assignmentId,
      conversationId: context.conversationId,
      provider: context.provider,
      model: context.model,
      userMessage: context.userMessage.slice(0, 500)
    });
    this.record(context.traceId, "ProductExecutionRouter", "start", "running", {
      requestId: context.requestId,
      decisionId: context.decisionId,
      taskId: context.taskId,
      assignmentId: context.assignmentId,
      conversationId: context.conversationId,
      provider: context.provider,
      model: context.model
    });

    for (const strategy of strategies.filter(Boolean)) {
      const name = strategy.name || "unnamed_strategy";
      const canHandle = typeof strategy.canHandle === "function"
        ? await strategy.canHandle(context)
        : true;
      if (!canHandle) continue;

      this.trace("INFO", "[strategy selected]", {
        requestId: context.requestId,
        strategy: name
      });
      this.record(context.traceId, "ProductExecutionRouter", "strategy_selected", "running", {
        requestId: context.requestId,
        strategy: name
      });

      const raw = await strategy.execute(context);
      if (!raw || raw.handled === false) {
        this.trace("DEBUG", "[strategy skipped]", {
          requestId: context.requestId,
          strategy: name
        });
        this.record(context.traceId, "ProductExecutionRouter", "strategy_skipped", "skipped", {
          requestId: context.requestId,
          strategy: name
        });
        continue;
      }

      const result = this.normalizeResult(raw, name);
      this.eventBus.publish(result.success ? AGENT_EVENTS.TASK_COMPLETED : AGENT_EVENTS.TASK_FAILED, {
        sessionId: stateSessionId,
        intent: result.metadata?.intent || inputContext.intent || "",
        plan: result.tasks,
        lastError: result.success ? "" : result.message
      });
      this.trace("INFO", "[ProductExecutionRouter END]", {
        requestId: context.requestId,
        strategy: name,
        status: result.status,
        success: result.success
      });
      this.record(context.traceId, "ProductExecutionRouter", "end", result.status, {
        requestId: context.requestId,
        strategy: name,
        success: result.success
      });
      this.trace("INFO", "[FINAL]", {
        requestId: context.requestId,
        message: String(result.message || "").slice(0, 1000)
      });
      this.record(context.traceId, "ReplyBuilder", "final", result.status, {
        message: String(result.message || "").slice(0, 500)
      });
      return result;
    }

    const technicalMessage = `system_capability_missing：无可用Agent；能力不匹配：${inputContext.requiredCapability || inputContext.taskBrain?.required_capability || "未声明执行能力"}。`;
    const fallback = this.normalizeResult({
      success: false,
      status: "failed",
      message: userFacingError({ code: "system_capability_missing", message: technicalMessage }, {
        classification: inputContext.understanding?.classification,
        domain: inputContext.understanding?.domain
      }),
      tasks: context.tasks,
      toolResults: context.toolCalls,
      verification: null,
      metadata: {
        errorCode: "system_capability_missing",
        technicalError: technicalMessage,
        failureType: "agent_unavailable",
        requiredCapability: inputContext.requiredCapability || inputContext.taskBrain?.required_capability || ""
      }
    }, "no_strategy");
    this.eventBus.publish(AGENT_EVENTS.TASK_FAILED, {
      sessionId: stateSessionId,
      lastError: fallback.message,
      plan: fallback.tasks
    });
    this.trace("ERROR", "[ProductExecutionRouter END]", {
      requestId: context.requestId,
      strategy: "no_strategy",
      status: fallback.status
    });
    this.record(context.traceId, "ProductExecutionRouter", "end", "failed", {
      requestId: context.requestId,
      strategy: "no_strategy"
    });
    return fallback;
  }

  normalizeResult(result = {}, strategy = "") {
    return createAgentResult(result, strategy);
  }

  normalizeStatus(status) {
    return normalizeAgentStatus(status);
  }

  trace(level, message, meta = {}) {
    if (!this.logger) return;
    this.logger("agent", level, message, meta);
  }

  record(traceId, agent, event, status, data = {}) {
    this.tracer?.record?.(traceId, agent, event, status, data);
  }
}

module.exports = { ProductExecutionRouter };
