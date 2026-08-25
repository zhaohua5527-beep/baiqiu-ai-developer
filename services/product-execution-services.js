function mergeToolResults(...groups) {
  const results = [];
  const seen = new Set();
  for (const item of groups.flat().filter(Boolean)) {
    const normalized = typeof item === "string"
      ? { toolId: "legacy_tool", success: false, status: "unverified", result: item, error: "缺少结构化工具证据" }
      : item;
    const key = JSON.stringify([normalized.toolId || "", normalized.success, normalized.result || normalized.text || "", normalized.error || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
  }
  return results;
}

class ProductExecutionServices {
  constructor(deps = {}) {
    this.deps = deps;
  }

  finalText(prefix, text) {
    return [prefix, text].filter(Boolean).join("\n\n");
  }

  sendSessionChanged() {
    this.deps.sendSessionChanged?.();
  }

  executionContext(input = {}) {
    const taskBrain = input.taskBrain || {};
    const understanding = input.understanding || {};
    return {
      conversationUnderstanding: understanding,
      taskBrain,
      executionMetadata: understanding.executionMetadata || taskBrain.execution_metadata || {},
      decisionId: understanding.decisionId || taskBrain.decision_id || "",
      taskId: taskBrain.task_id || "",
      assignmentId: taskBrain.assignment_id || "",
      agentId: input.session?.id || "",
      knowledgeContext: input.knowledgeContext || "",
      knowledgeReferences: Array.isArray(input.knowledgeReferences) ? input.knowledgeReferences : []
    };
  }

  canExecuteTask(input = {}) {
    const understanding = input.understanding || {};
    return Boolean(understanding);
  }

  canUseLocalRouting(input) {
    // File-analysis context must not suppress deterministic local commands.
    // Those commands can decide for themselves whether they handle the request.
    // skipLocalToolRouting 不抑制本地命令——本地策略自己判断是否处理，
    // 且 executeSkillShortcut 等会使用 originalText（用户原话）而非替换后的
    // effectiveText（file-analysis message），避免误触发。
    return this.canExecuteTask(input);
  }

  canUseHermes(input) {
    return this.canExecuteTask(input);
  }

  intentFor(input = {}) {
    return input.understanding?.context?.domainIntent
      || input.taskBrain?.intent
      || "general.chat";
  }

  async executeDirectCommand(input) {
    const { session, effectiveText, personaPrefix, controller, traceId } = input;
    const { appendMessage, updateSession, recordAgentState, tryHandleDirectToolCommand } = this.deps;
    const intent = this.intentFor(input);
    recordAgentState(session.id, "tool_selected", { intent, logicalTool: "direct_command", currentAgent: "tool_selector", goal: input.understanding?.goal || effectiveText });
    recordAgentState(session.id, "executing", { intent, logicalTool: "direct_command", currentAgent: "executor", goal: input.understanding?.goal || effectiveText });
    const directToolText = await tryHandleDirectToolCommand(effectiveText, { ...this.executionContext(input), sessionId: session.id, provider: "direct-command", signal: controller.signal, traceId });
    if (!directToolText) return { handled: false };
    const finalText = this.finalText(personaPrefix, directToolText);
    appendMessage(session.id, { role: "assistant", text: finalText, raw: { directTool: true, productExecutionRouter: true } });
    updateSession(session.id, { status: "done" });
    recordAgentState(session.id, "completed", { intent, logicalTool: "direct_command" });
    this.sendSessionChanged();
    return {
      success: true,
      status: "success",
      message: finalText,
      clientResponse: { ok: true, direct: true, sessionId: session.id, directTool: true, productExecutionRouter: true }
    };
  }

  async executeSkillShortcut(input) {
    const { session, originalText, effectiveText, personaPrefix } = input;
    const { appendMessage, updateSession, recordAgentState, tryHandleSkillShortcut } = this.deps;
    const intent = this.intentFor(input);
    recordAgentState(session.id, "tool_selected", { intent, logicalTool: "skill_shortcut", currentAgent: "tool_selector", goal: input.understanding?.goal || effectiveText });
    recordAgentState(session.id, "executing", { intent, logicalTool: "skill_shortcut", currentAgent: "executor", goal: input.understanding?.goal || effectiveText });
    const skillShortcutText = await tryHandleSkillShortcut(originalText || effectiveText, { ...this.executionContext(input), sessionId: session.id });
    if (!skillShortcutText) return { handled: false };
    const finalText = this.finalText(personaPrefix, skillShortcutText);
    appendMessage(session.id, { role: "assistant", text: finalText, raw: { skillShortcut: true, productExecutionRouter: true } });
    updateSession(session.id, { status: "done" });
    recordAgentState(session.id, "completed", { intent, logicalTool: "skill_shortcut" });
    this.sendSessionChanged();
    return {
      success: true,
      status: "success",
      message: finalText,
      clientResponse: { ok: true, direct: true, sessionId: session.id, skillShortcut: true, productExecutionRouter: true }
    };
  }

  async executeRealtimeWeb(input) {
    const { session, effectiveText, personaPrefix, controller, traceId } = input;
    const { appendMessage, updateSession, recordAgentState, tryHandleRealtimeWebQuestion } = this.deps;
    recordAgentState(session.id, "tool_selected", { intent: "realtime.web", logicalTool: "web_search", currentAgent: "tool_selector", goal: effectiveText });
    recordAgentState(session.id, "executing", { intent: "realtime.web", logicalTool: "web_search", currentAgent: "executor", goal: effectiveText });
    const realtimeText = await tryHandleRealtimeWebQuestion(effectiveText, { ...this.executionContext(input), sessionId: session.id, provider: "realtime-web", signal: controller.signal, traceId });
    if (!realtimeText) return { handled: false };
    const finalText = this.finalText(personaPrefix, realtimeText);
    appendMessage(session.id, { role: "assistant", text: finalText, raw: { realtimeWeb: true, productExecutionRouter: true } });
    updateSession(session.id, { status: "done" });
    recordAgentState(session.id, "completed", { intent: "realtime.web", logicalTool: "web_search" });
    this.sendSessionChanged();
    return {
      success: true,
      status: "success",
      message: finalText,
      clientResponse: { ok: true, direct: true, sessionId: session.id, realtimeWeb: true, productExecutionRouter: true }
    };
  }

  async executeHermes(input) {
    const { session, payload, effectiveText, attachments, settings, personaPrefix, controller, traceId, taskBrain } = input;
    const { appendMessage, updateSession, loadDb, recordAgentState, sendWithHermes } = this.deps;
    const modelSession = loadDb().sessions.find((item) => item.id === session.id) || session;
    const intent = this.intentFor(input);
    recordAgentState(session.id, "intent_detected", {
      intent,
      logicalTool: "hermes_agent",
      currentAgent: "hermes",
      goal: input.understanding?.goal || effectiveText
    });
    recordAgentState(session.id, "executing", {
      intent,
      logicalTool: "hermes_agent",
      currentAgent: "hermes",
      goal: input.understanding?.goal || effectiveText
    });
    const result = await sendWithHermes(
      modelSession,
      // 必须传用户真实消息，不能用 taskBrain.prompt 顶替——否则 HMS 收到的是
      // "Task Brain 固定任务上下文"而非用户原话，web_search 等工具会用污染文本
      // 作为 query（task-015/030 根因之一）。
      { ...payload, text: effectiveText || payload?.originalText || payload?.text || "" },
      attachments,
      settings,
      personaPrefix,
      { ...this.executionContext(input), signal: controller.signal, traceId }
    );
    const ok = result?.status === "done" || result?.status === "success";
    recordAgentState(session.id, ok ? "completed" : (result?.status === "cancelled" ? "cancelled" : "failed"), {
      intent,
      logicalTool: "hermes_agent"
    });
    // 写回会话：executeDirectCommand/executeSkillShortcut 都 appendMessage，
    // Hermes 策略此前漏了——任务路径的 result 只 complete TaskBrain 不写回，
    // 并发场景 A 的"结果被吃掉"（用户界面看不到）正是这条漏写（task-041 rc.8）。
    const replyText = result?.text || (ok ? "任务已完成。" : "任务执行未完成。");
    if (ok) {
      appendMessage(session.id, { role: "assistant", text: replyText, raw: { productExecutionRouter: true, runtime: "hermes", hermes: true, raw: result } });
      updateSession(session.id, { status: "done" });
    } else {
      appendMessage(session.id, { role: "assistant", text: replyText, raw: { productExecutionRouter: true, runtime: "hermes", error: true, raw: result } });
      updateSession(session.id, { status: "failed" });
    }
    this.sendSessionChanged?.();
    return {
      success: ok,
      status: ok ? "success" : (result?.status === "cancelled" ? "cancelled" : "failed"),
      message: replyText,
      toolResults: result?.toolCalls || [],
      raw: result,
      clientResponse: { ok, sessionId: session.id, ...result, productExecutionRouter: true, runtime: "hermes" }
    };
  }
}

module.exports = { ProductExecutionServices };
