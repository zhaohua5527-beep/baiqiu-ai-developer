const path = require("node:path");
const { ProductSDK } = require("./product-sdk");
const { TaskExperience } = require("./task-experience");
const { userFacingError } = require("../user-facing-error-adapter");

function firstText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : "";
}

function structuredResponseEvidence(response = {}) {
  const keys = [
    "ceoOrchestration", "integratedCeoDelivery", "projectRunId", "assignments", "results", "employeeResults",
    "report", "reportStatus", "delegationIds", "delegationResults", "delegationEvidence",
    "hermesSessionId", "traceId"
  ];
  return keys.reduce((result, key) => {
    if (response[key] !== undefined) result[key] = response[key];
    return result;
  }, {});
}

class UIAdapter {
  constructor({ productRoot, dataRoot, taskOrchestrator, planBuilder = null, conversationalResponder = null, chatRunner = null, capabilityRecovery = null } = {}) {
    this.planBuilder = planBuilder;
    this.conversationalResponder = conversationalResponder;
    this.chatRunner = chatRunner;
    this.capabilityRecovery = capabilityRecovery;
    const adapter = taskOrchestrator
      ? new (require("./product-event-adapter").ProductEventAdapter)({ taskOrchestrator })
      : {
          submit: async () => ({
            success: false,
            status: "failed",
            error: "Legacy product execution is disabled; use desktop.chat_runtime"
          })
        };
    this.sdk = new ProductSDK({
      productRoot,
      dataRoot,
      adapter
    });
  }

  async submitUIInput(input = {}) {
    const message = String(input.message || input.text || "");
    const task = input.taskId ? {
      ...this.sdk.queryTask(input.taskId),
      ...input,
      input: input.input || message,
      message
    } : this.sdk.createTask({
      taskId: input.taskId || "",
      productId: input.productId || this.sdk.manifest?.id || "",
      templateId: input.templateId || "desktop.general_task",
      input: message,
      message,
      intent: input.intent || "",
      planObject: input.planObject || null,
      sessionId: input.sessionId || "",
      traceId: input.traceId || "",
      context: {
        ...(input.context || {}),
        ui: true,
        productLayer: true
      }
    });

    this.sdk.updateTaskExperience(task.taskId, "understanding", { message: "正在理解" });

    if (input.context?.chatRuntime || input.templateId === "desktop.chat_runtime") {
      const response = typeof this.chatRunner === "function"
        ? await this.chatRunner({ ...input, message, taskId: task.taskId })
        : { ok: false, text: "聊天运行通道不可用。", error: "chat_runner_missing" };
      return this.completeRuntimeTask(task, response);
    }

    if (input.context?.conversationOnly || input.templateId === "desktop.chat") {
      const response = await this.answerConversation({ ...input, message, taskId: task.taskId });
      return this.completeRuntimeTask(task, response);
    }

    let planObject = input.planObject || await this.buildPlan({ ...input, message, taskId: task.taskId });
    if (planObject?.status === "capability_missing" || planObject?.contentStatus === "capability_missing") {
      const recovery = typeof this.capabilityRecovery === "function"
        ? await this.capabilityRecovery({ input: { ...input, message, taskId: task.taskId }, task, planObject })
        : null;
      if (recovery?.success && recovery.planObject) {
        planObject = recovery.planObject;
      } else if (recovery) {
        return this.completeRuntimeTask(task, {
          ok: false,
          status: "blocked",
          text: recovery.text || "当前缺少完成原始目标所需的能力，我没有生成假结果。",
          error: recovery.technicalError || recovery.error || "capability_recovery_blocked",
          raw: { capabilityRecovery: recovery }
        });
      }
    }
    const planned = this.sdk.updateTaskExperience(task.taskId, "planning", {
      message: "正在规划",
      details: {
        intent: planObject?.primaryIntent || input.intent || "",
        plan: Array.isArray(planObject?.tasks) ? planObject.tasks.map((item) => item.title || item.id || item.toolId).filter(Boolean) : []
      }
    });
    const nextTask = {
      ...(planned || task),
      intent: planObject?.primaryIntent || input.intent || "",
      planObject
    };
    this.sdk.saveTask(nextTask);
    const completed = await this.sdk.submitTask(nextTask);
    return this.toUIResult(completed);
  }

  completeRuntimeTask(task = {}, response = {}) {
    const responseText = firstText(response.text, response.message);
    const ok = response.ok !== false && Boolean(responseText);
    const responseEvidence = structuredResponseEvidence(response);
    const responseRaw = response.raw && typeof response.raw === "object" ? response.raw : {};
    const completed = {
      ...task,
      status: ok ? "success" : response.status === "blocked" ? "blocked" : "failed",
      result: {
        success: ok,
        text: responseText,
        normalized: {
          success: ok,
          result: { text: responseText },
          error: response.error || (ok ? null : "conversation_response_text_invalid")
        },
        raw: Object.keys(responseEvidence).length || Object.keys(responseRaw).length
          ? { ...responseRaw, ...responseEvidence }
          : null
      },
      error: ok ? null : userFacingError(response.error || "conversation_response_text_invalid", {
        classification: task.classification,
        domain: task.context?.conversationUnderstanding?.domain || ""
      }),
      technicalError: ok ? null : (response.error || "conversation_response_text_invalid"),
      updatedAt: new Date().toISOString()
    };
    completed.experience = TaskExperience.advance(completed, ok ? "completed" : "failed", {
      message: ok ? "已完成" : completed.error,
      result: completed.result
    });
    this.sdk.saveTask(completed);
    return this.toUIResult(completed);
  }

  queryTask(taskId = "") {
    return this.sdk.queryTask(taskId);
  }

  getTaskStatus(taskId = "") {
    return this.sdk.getTaskStatus(taskId);
  }

  getTaskResult(taskId = "") {
    return this.sdk.getTaskResult(taskId);
  }

  getTaskHistory(options = {}) {
    return this.sdk.getTaskHistory(options);
  }

  reconcileInterrupted(options = {}) {
    return this.sdk.reconcileInterrupted(options);
  }

  async buildPlan(input = {}) {
    if (typeof this.planBuilder !== "function") return input.planObject || null;
    return this.planBuilder(input);
  }

  async answerConversation(input = {}) {
    if (typeof this.conversationalResponder === "function") {
      const result = await this.conversationalResponder(input);
      if (typeof result === "string" && result.trim()) return { ok: true, text: result.trim() };
      if (result && typeof result === "object") {
        const text = firstText(result.text, result.message);
        if (text) return { ...result, ok: result.ok !== false, text };
        return { ...result, ok: false, text: "响应格式错误：模型没有返回可显示文字。", error: result.error || "conversation_response_text_invalid" };
      }
    }
    return { ok: true, text: "我在。你可以问我有哪些能力，也可以让我创建文件、处理表格、分析图片、打开网页，或执行桌面任务。" };
  }

  toUIResult(task = {}) {
    const result = task.result?.result || task.result || {};
    const normalized = result.normalized || task.result?.normalized || null;
    const raw = result.raw && typeof result.raw === "object" ? result.raw : {};
    return {
      taskId: task.taskId,
      productId: task.productId,
      status: task.status,
      success: task.status === "success",
      text: firstText(result.text, result.userMessage, normalized?.result?.text, task.error),
      result,
      ...(raw.ceoOrchestration !== undefined ? { ceoOrchestration: raw.ceoOrchestration } : {}),
      ...(raw.integratedCeoDelivery !== undefined ? { integratedCeoDelivery: raw.integratedCeoDelivery } : {}),
      ...(raw.projectRunId !== undefined ? { projectRunId: raw.projectRunId } : {}),
      ...(raw.assignments !== undefined ? { assignments: raw.assignments } : {}),
      ...(raw.results !== undefined ? { results: raw.results } : {}),
      ...(raw.employeeResults !== undefined ? { employeeResults: raw.employeeResults } : {}),
      ...(raw.report !== undefined ? { report: raw.report } : {}),
      experience: task.experience || null,
      traceId: task.traceId,
      updatedAt: task.updatedAt
    };
  }

  static desktopAssistantRoot(appRoot = process.cwd()) {
    return path.join(appRoot, "products", "desktop-assistant");
  }
}

module.exports = { UIAdapter };
