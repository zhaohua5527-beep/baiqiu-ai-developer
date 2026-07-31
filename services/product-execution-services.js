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
      agentId: input.session?.id || ""
    };
  }

  canExecuteTask(input = {}) {
    const understanding = input.understanding || {};
    return Boolean(understanding);
  }

  canUseLocalRouting(input) {
    return this.canExecuteTask(input) && !input.skipLocalToolRouting;
  }

  canUseHermes(input) {
    return this.canExecuteTask(input);
  }

  intentFor(input = {}) {
    return input.understanding?.context?.domainIntent
      || input.taskBrain?.intent
      || "general.chat";
  }

  async executeImageGuard(input) {
    const { session, attachments, settings, personaPrefix } = input;
    const { appendMessage, updateSession, recordAgentState, imageUnsupportedReply } = this.deps;
    const finalText = this.finalText(personaPrefix, imageUnsupportedReply(settings, attachments));
    appendMessage(session.id, { role: "assistant", text: finalText, raw: { localImageUnsupported: true, productExecutionRouter: true } });
    updateSession(session.id, { status: "done" });
    recordAgentState(session.id, "completed", { intent: "image.unsupported", logicalTool: "local_guard" });
    this.sendSessionChanged();
    return {
      success: true,
      status: "success",
      message: finalText,
      clientResponse: { ok: true, sessionId: session.id, imageUnsupported: true, productExecutionRouter: true }
    };
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
    const { session, effectiveText, personaPrefix } = input;
    const { appendMessage, updateSession, recordAgentState, tryHandleSkillShortcut } = this.deps;
    const intent = this.intentFor(input);
    recordAgentState(session.id, "tool_selected", { intent, logicalTool: "skill_shortcut", currentAgent: "tool_selector", goal: input.understanding?.goal || effectiveText });
    recordAgentState(session.id, "executing", { intent, logicalTool: "skill_shortcut", currentAgent: "executor", goal: input.understanding?.goal || effectiveText });
    const skillShortcutText = await tryHandleSkillShortcut(effectiveText, { ...this.executionContext(input), sessionId: session.id });
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
    const { loadDb, recordAgentState, sendWithHermes } = this.deps;
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
      { ...payload, text: taskBrain?.prompt || effectiveText },
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
    return {
      success: ok,
      status: ok ? "success" : (result?.status === "cancelled" ? "cancelled" : "failed"),
      message: result?.text || "",
      toolResults: result?.toolCalls || [],
      raw: result,
      clientResponse: { ok, sessionId: session.id, ...result, productExecutionRouter: true, runtime: "hermes" }
    };
  }

  async executeLlmTool(input) {
    const { session, originalText, effectiveText, attachments, settings, personaPrefix, controller, traceId, taskBrain } = input;
    const { appendMessage, updateSession, recordAgentState, directProviderChat, applyBaiqiuActions, onPersonaPrefix } = this.deps;
    const intent = this.intentFor(input);
    recordAgentState(session.id, "intent_detected", { intent, logicalTool: "llm_agent_loop", currentAgent: "supervisor", goal: input.understanding?.goal || effectiveText });
    recordAgentState(session.id, "executing", { intent, logicalTool: "llm_agent_loop", currentAgent: "executor", goal: input.understanding?.goal || effectiveText });
    const direct = await directProviderChat(settings, taskBrain?.prompt || effectiveText, attachments, session.id, {
      ...this.executionContext(input),
      signal: controller.signal,
      traceId,
      originalUserMessage: originalText,
      agentIntent: intent
    });
    recordAgentState(session.id, "validating", { intent, logicalTool: "llm_agent_loop", currentAgent: "verifier" });
    const actioned = await applyBaiqiuActions(direct.text, { ...this.executionContext(input), originalUserMessage: originalText, traceId, sessionId: session.id });
    const toolResults = mergeToolResults(direct.raw?.baiqiuActions || [], actioned.results || []);
    const finalText = this.finalText(personaPrefix, actioned.text);
    if (personaPrefix) onPersonaPrefix?.();
    appendMessage(session.id, { role: "assistant", text: finalText, raw: { ...direct.raw, baiqiuActions: toolResults, productExecutionRouter: true } });
    updateSession(session.id, { status: "done" });
    recordAgentState(session.id, "completed", { intent, logicalTool: "llm_agent_loop" });
    this.sendSessionChanged();
    return {
      success: true,
      status: "success",
      message: finalText,
      toolResults,
      raw: direct.raw,
      clientResponse: { ok: true, direct: true, sessionId: session.id, productExecutionRouter: true }
    };
  }
}

module.exports = { ProductExecutionServices };
