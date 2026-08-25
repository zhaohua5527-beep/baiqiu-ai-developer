const { buildExecutionMetadata, buildExecutionBinding } = require("./execution-metadata");

class ToolExecutionService {
  constructor({ registry, selector, verifier = null, authorizer = null, withTimeout, ensureRunActive, formatText, logger = null, tracer = null } = {}) {
    this.registry = registry;
    this.selector = selector;
    this.verifier = verifier;
    this.authorizer = typeof authorizer === "function" ? authorizer : null;
    this.withTimeout = withTimeout || ((promise) => Promise.resolve(promise));
    this.ensureRunActive = ensureRunActive || (() => {});
    this.formatText = formatText || ((response) => String(response?.result ?? response?.error ?? ""));
    this.logger = typeof logger === "function" ? logger : null;
    this.tracer = tracer;
  }

  async execute({ toolId, args = {}, context = {} } = {}) {
    const startedAt = Date.now();
    const id = String(toolId || "").trim();
    const signal = context.signal || null;
    let approval = { approved: false, reason: "tool execution not started", selectedTools: [] };
    let executionMetadata = null;
    try {
      this.ensureRunActive(signal);
      if (this.authorizer) {
        const authorization = await this.authorizer({ toolId: id, args, context });
        if (authorization?.allowed === false) {
          return this.standardize({
            toolId: id,
            response: {
              success: false,
              result: null,
              error: {
                code: authorization.code || "MEMBERSHIP_REQUIRED",
                message: authorization.message || "此功能需要有效会员。"
              },
              evidence: [{ type: "membership", allowed: false, tool: id, reason: authorization.code || "MEMBERSHIP_REQUIRED" }],
              duration: Date.now() - startedAt
            },
            startedAt,
            approval: { approved: false, reason: authorization.code || "MEMBERSHIP_REQUIRED", selectedTools: [] },
            traceId: context.traceId || "",
            context
          });
        }
      }
      executionMetadata = buildExecutionMetadata(context);
      approval = this.selector.approveToolCall({
        toolId: id,
        params: args,
        intent: context.agentIntent || context.intent || "",
        context,
        availableTools: this.registry.list()
      });
    } catch (error) {
      return this.standardize({
        toolId: id,
        response: this.failureResponse(id, error, startedAt),
        startedAt,
        approval,
        traceId: context.traceId || "",
        context
      });
    }
    this.trace("INFO", "[Execution]", {
      tool: id,
      input: this.safeArgs(args),
      approved: approval.approved,
      reason: approval.reason
    });
    this.tracer?.record?.(context.traceId, "ToolExecutionService", "tool_approve", approval.approved ? "approved" : "blocked", {
      toolId: id,
      args: this.safeArgs(args),
      reason: approval.reason
    });
    if (!approval.approved) {
      return this.standardize({
        toolId: id,
        response: {
          success: false,
          result: null,
          error: approval.reason,
          evidence: [{ type: "tool-selection", approved: false, tool: id, reason: approval.reason }],
          duration: Date.now() - startedAt
        },
        startedAt,
        approval,
        traceId: context.traceId || "",
        context
      });
    }
    this.tracer?.record?.(context.traceId, "ToolExecutionService", "tool_execute", "running", {
      toolId: id,
      args: this.safeArgs(args)
    });
    try {
      const response = await this.executeWithSignal(id, args, context, executionMetadata, approval);
      return this.standardize({ toolId: id, response, startedAt, approval, traceId: context.traceId || "", context: { ...context, executionMetadata } });
    } catch (error) {
      return this.standardize({
        toolId: id,
        response: this.failureResponse(id, error, startedAt),
        startedAt,
        approval,
        traceId: context.traceId || "",
        context
      });
    }
  }

  // 执行工具并让 abort signal 贯穿：工具发起后若 signal 被中断（用户取消/超时），
  // 用 Promise.race 中断等待并抛 TASK_CANCELLED。否则 web_search/browser 等耗时工具
  // 在任务被中断后仍会继续跑，结果迟到写回会话（task-030 迟到污染根因）。
  async executeWithSignal(id, args, context, executionMetadata, approval) {
    const signal = context.signal || null;
    const runTool = () => this.registry.execute(id, args, {
      ...context,
      executionMetadata,
      decisionId: executionMetadata.decisionId,
      permissions: executionMetadata.permissions,
      toolSelection: approval
    });
    if (!signal) return runTool();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const error = new Error("任务已被用户终止，工具执行已中断。");
        error.code = "TASK_CANCELLED";
        reject(error);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      runTool().then((value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  async executeActions(actions = [], context = {}) {
    const results = [];
    for (const action of actions) {
      this.ensureRunActive(context.signal || null);
      const type = String(action?.type || action?.name || "").trim();
      const { type: _type, name: _name, toolId: _toolId, ...args } = action || {};
      const item = await this.execute({ toolId: type, args, context });
      results.push({
        type,
        action,
        response: item.response,
        text: this.formatText(item.response),
        execution: item
      });
    }
    return results;
  }

  async executeVirtual({ toolId, args = {}, context = {}, handler } = {}) {
    const startedAt = Date.now();
    const id = String(toolId || "").trim();
    if (typeof handler !== "function") throw new Error(`Virtual tool missing handler: ${id}`);
    this.ensureRunActive(context.signal || null);
    const executionMetadata = buildExecutionMetadata(context);
    this.trace("INFO", "[Execution]", {
      tool: id,
      input: this.safeArgs(args),
      virtual: true,
      reason: "virtual verified task"
    });
    this.tracer?.record?.(context.traceId, "ToolExecutionService", "tool_execute", "running", {
      toolId: id,
      args: this.safeArgs(args),
      virtual: true
    });
    try {
      const output = await handler(args, context);
      return this.standardize({
        toolId: id,
        response: {
          success: Boolean(output?.success),
          result: output ?? null,
          error: output?.success ? null : (output?.error || "Virtual execution failed"),
          evidence: output?.evidence || [],
          duration: Date.now() - startedAt
        },
        startedAt,
        approval: { approved: true, reason: "virtual verified task", selectedTools: [{ id, virtual: true }] },
        traceId: context.traceId || "",
        context: { ...context, executionMetadata }
      });
    } catch (error) {
      return this.standardize({
        toolId: id,
        response: {
          success: false,
          result: null,
          error: error?.message || String(error),
          evidence: [],
          duration: Date.now() - startedAt
        },
        startedAt,
        approval: { approved: true, reason: "virtual verified task", selectedTools: [{ id, virtual: true }] },
        traceId: context.traceId || "",
        context: { ...context, executionMetadata }
      });
    }
  }

  standardize({ toolId, response = {}, startedAt, approval, traceId = "", context = {} }) {
    const duration = Date.now() - startedAt;
    let executionMetadata = null;
    let binding = { taskId: "", assignmentId: "", agentId: "" };
    try {
      executionMetadata = buildExecutionMetadata(context);
      binding = buildExecutionBinding(context);
    } catch {}
    const normalized = response && typeof response === "object" ? response : { success: true, result: response };
    normalized.meta = {
      ...(normalized.meta || {}),
      traceId: normalized.meta?.traceId || traceId,
      duration: normalized.meta?.duration ?? normalized.duration ?? duration,
      stdout: normalized.result?.stdout || normalized.stdout || normalized.meta?.stdout || "",
      stderr: normalized.result?.stderr || normalized.stderr || normalized.meta?.stderr || "",
      exitCode: normalized.result?.exitCode ?? normalized.exitCode ?? normalized.meta?.exitCode ?? null,
      returnValue: normalized.result?.returnValue ?? normalized.returnValue ?? normalized.meta?.returnValue ?? null
    };
    if (!("result" in normalized)) normalized.result = normalized.success ? normalized.message || "" : null;
    if (!("error" in normalized)) normalized.error = normalized.success ? null : (normalized.message || "Tool execution failed");
    let verification = { verified: true, status: normalized.success ? "skipped" : "failed", checks: [], reason: normalized.success ? "未配置验证中心" : "工具执行失败，跳过验证" };
    if (this.verifier && normalized.success) {
      executionMetadata ||= buildExecutionMetadata(context);
      verification = executionMetadata.permissions.allowVerifier
        ? this.verifier.verify({ toolId, result: normalized, context: { ...context, approval, executionMetadata } })
        : { verified: true, status: "skipped", checks: [], reason: "UnderstandingDecision未授权Verifier" };
    }
    normalized.verification = verification;
    if (normalized.success && verification && verification.verified === false) {
      // The tool already returned its real result. A generic verifier may
      // record missing supplemental evidence, but cannot turn a completed
      // operation into a user-visible failure.
      normalized.meta.verificationDiagnostic = verification.reason || "工具结果缺少附加验证证据";
    }
    normalized.meta = {
      ...normalized.meta,
      verification
    };
    const result = {
      success: Boolean(normalized.success),
      toolId,
      decisionId: executionMetadata?.decisionId || "",
      taskId: binding.taskId,
      assignmentId: binding.assignmentId,
      agentId: binding.agentId,
      status: normalized.success ? "success" : "failed",
      result: normalized.result,
      error: normalized.success ? null : normalized.error,
      timestamp: new Date().toISOString(),
      duration: normalized.meta.duration,
      verification,
      response: normalized,
      approval
    };
    this.trace(result.success ? "INFO" : "WARN", "[Execution Result]", {
      tool: toolId,
      status: result.status,
      duration: result.duration,
      error: result.error || null
    });
    this.tracer?.record?.(traceId || normalized?.meta?.traceId || "", "ToolExecutionService", "tool_result", result.status, {
      toolId,
      duration: result.duration,
      status: result.status,
      error: result.error || null,
      verificationStatus: verification?.status || ""
    });
    try {
      require("./neural-core/agent-event-bus").recordRuntimeMetric?.("ToolExecutionService", {
        duration: result.duration,
        success: result.success
      });
    } catch {}
    return result;
  }

  safeArgs(args) {
    try {
      const clone = JSON.parse(JSON.stringify(args || {}));
      for (const key of Object.keys(clone)) {
        if (/apiKey|authorization|token|secret|password/i.test(key)) clone[key] = "***REDACTED***";
      }
      return clone;
    } catch {
      return {};
    }
  }

  failureResponse(toolId, error, startedAt) {
    let code = "NC3001";
    try { code = require("./neural-core/agent-event-bus").ERROR_CODES.TOOL_FAILURE; } catch {}
    const message = error?.message || String(error || "Tool execution failed");
    // 保留原始错误码（如 TASK_HARD_TIMEOUT / PERMISSION_DENIED / EACCES），
    // 供 userFacingError 精确分类；NC3001 只是工具失败的兜底前缀，不能吞掉真实原因。
    const originalCode = String(error?.code || error?.errorCode || "").trim();
    const wrappedCode = originalCode && !/^NC\d{3,5}$/i.test(originalCode)
      ? `${originalCode} (${code})`
      : code;
    return {
      success: false,
      result: null,
      error: `${code} Tool Failure: ${message}`,
      evidence: [{ type: "tool-execution", tool: toolId, errorCode: code, message }],
      duration: Date.now() - startedAt,
      meta: { errorCode: wrappedCode, originalErrorCode: originalCode, recoverable: true }
    };
  }

  trace(level, message, meta = {}) {
    if (this.logger) this.logger("agent", level, message, meta);
  }
}

module.exports = { ToolExecutionService };
