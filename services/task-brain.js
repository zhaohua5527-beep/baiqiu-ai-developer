"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("./data-root");
const { buildExecutionMetadata } = require("./execution-metadata");

const TASK_LEVELS = Object.freeze({ CHAT: 1, ASSISTED: 2, AGENT: 3 });
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted", "outdated"]);

function cleanText(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanList(value, limit = 20) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 500)).filter(Boolean))].slice(0, limit);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


function defaultStore() {
  return { version: 1, tasks: [], updated_at: null };
}

class TaskBrain {
  constructor({ root = path.join(dataRoot(), "task-brain"), clock = () => new Date(), idFactory = () => `task-${randomUUID()}`, onComplete = null } = {}) {
    this.root = root;
    this.file = path.join(root, "tasks.json");
    this.clock = clock;
    this.idFactory = idFactory;
    this.onComplete = typeof onComplete === "function" ? onComplete : null;
    this.store = this.read();
  }

  now() {
    return this.clock().toISOString();
  }

  read() {
    try {
      if (!fs.existsSync(this.file)) return defaultStore();
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && Array.isArray(parsed.tasks) ? parsed : defaultStore();
    } catch {
      return defaultStore();
    }
  }

  save() {
    fs.mkdirSync(this.root, { recursive: true });
    this.store.tasks = this.store.tasks.slice(-200);
    this.store.updated_at = this.now();
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(this.store, null, 2), "utf8");
    fs.renameSync(temp, this.file);
  }

  prepare({ sessionId = "", understanding = null, attachments = [] } = {}) {
    if (!understanding || typeof understanding !== "object") {
      throw new Error("TaskBrain requires Conversation Understanding output");
    }
    const executionMetadata = buildExecutionMetadata(understanding);
    const intentType = cleanText(understanding.intentType || understanding.intent, 100);
    const conversationIntent = cleanText(understanding.intent || intentType, 100);
    const sourceContext = understanding.context && typeof understanding.context === "object" ? understanding.context : {};
    const spec = sourceContext.taskSpec && typeof sourceContext.taskSpec === "object" ? sourceContext.taskSpec : {};
    const original = cleanText(sourceContext.normalizedInput || understanding.goal, 12000);
    const level = Number(spec.level || TASK_LEVELS.AGENT);
    const agentAssignments = clone(Array.isArray(spec.agentAssignments) ? spec.agentAssignments : []);
    const assignmentPolicy = cleanText(spec.assignmentPolicy || understanding.assignment_policy, 100) || "one_task_one_agent";
    const task = {
      task_id: this.idFactory(),
      session_id: sessionId,
      task_type: cleanText(spec.taskType || "general_execution", 200),
      intent: cleanText(sourceContext.domainIntent || "general.execution", 200),
      intent_type: intentType,
      conversation_intent: conversationIntent,
      decision_id: executionMetadata.decisionId,
      classification: executionMetadata.classification,
      response_mode: executionMetadata.responseMode,
      permissions: clone(executionMetadata.permissions),
      route: executionMetadata.routing,
      execution_metadata: clone(executionMetadata),
      level,
      goal: cleanText(understanding.goal, 1000) || "完成用户请求",
      task_goal: cleanText(understanding.taskGoal || understanding.goal, 1000) || "完成用户请求",
      required_capability: cleanText(understanding.requiredCapability || understanding.classification || "general_execution", 200),
      output: cleanText(spec.output || "经过验证的执行结果", 1000),
      delivery_mode: ["file", "mixed"].includes(cleanText(spec.deliveryMode, 40)) ? cleanText(spec.deliveryMode, 40) : "chat",
      required_tools: cleanList(spec.requiredTools || [], 20),
      acceptance: cleanList(spec.acceptance || [], 20),
      original_input: original,
      understanding_id: cleanText(understanding.understandingId, 200),
      user_expectation: cleanText(understanding.userExpectation, 1000),
      required_action: cleanText(understanding.requiredAction, 200),
      risk_level: cleanText(understanding.riskLevel || "low", 40),
      assigned_role: cleanText(understanding.role || "WORKER", 40),
      capability_context: clone(understanding.capabilityContext || sourceContext.capabilityContext || null),
      current_stage: "understood",
      completed: [],
      pending: [],
      constraints: cleanList(understanding.task_constraints || spec.constraints || [], 20),
      assignment_policy: assignmentPolicy,
      requires_assignment_scope_confirmation: Boolean(spec.requiresAssignmentScopeConfirmation),
      plan: cleanList(spec.plan || [], 40),
      status: "ready",
      requires_confirmation: Boolean(spec.requiresConfirmation),
      attachments: (attachments || []).slice(0, 20).map((item) => ({
        id: item.id || "",
        name: cleanText(item.name, 300),
        mimeType: cleanText(item.mimeType, 120),
        sizeBytes: Number(item.sizeBytes || 0),
        path: cleanText(item.path || item.originalPath || item.filePath, 1200),
        textContent: String(item.textContent || "").slice(0, 12000),
        url: cleanText(item.url, 1200)
      })),
      created_at: this.now(),
      updated_at: this.now()
    };
    task.assignment_id = `assignment-${task.task_id}-primary`;
    task.agent_assignments = agentAssignments.map((assignment, index) => ({
      ...assignment,
      decision_id: executionMetadata.decisionId,
      permissions: clone(executionMetadata.permissions),
      assignment_id: cleanText(assignment.assignment_id || assignment.assignmentId, 200) || `assignment-${task.task_id}-${index + 1}`,
      task_id: cleanText(assignment.task_id || assignment.taskId, 200) || `${task.task_id}:${index + 1}`
    }));
    task.requested_agent_count = task.agent_assignments.length;
    task.delegation_mode = task.agent_assignments.length ? "parallel_agents" : "steps";
    task.pending = [...task.plan];
    if (task.requires_confirmation) {
      task.status = "awaiting_confirmation";
      task.current_stage = "awaiting_confirmation";
    }
    this.store.tasks.push(task);
    this.save();
    return clone(task);
  }

  get(taskId) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    return task ? clone(task) : null;
  }

  reload() {
    this.store = this.read();
    return clone(this.store);
  }

  list(sessionId = "", limit = 20) {
    return this.store.tasks
      .filter((task) => !sessionId || task.session_id === sessionId)
      .slice(-Math.max(1, Math.min(100, Number(limit) || 20)))
      .reverse()
      .map(clone);
  }

  listByStatus(status, limit = 100) {
    const expected = cleanText(status, 100);
    return this.store.tasks
      .filter((task) => task.status === expected)
      .slice(-Math.max(1, Math.min(200, Number(limit) || 100)))
      .reverse()
      .map(clone);
  }

  reopenForConfirmation(taskId, understanding) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) throw new Error("需要重新确认的任务不存在");
    if (task.status !== "needs_user_confirmation") throw new Error("任务状态已经发生变化，请刷新后重试");
    const executionMetadata = buildExecutionMetadata(understanding);
    const sourceContext = understanding.context && typeof understanding.context === "object" ? understanding.context : {};
    const spec = sourceContext.taskSpec && typeof sourceContext.taskSpec === "object" ? sourceContext.taskSpec : {};
    const plan = cleanList(spec.plan || task.plan || [], 40);
    Object.assign(task, {
      decision_id: executionMetadata.decisionId,
      classification: executionMetadata.classification,
      response_mode: executionMetadata.responseMode,
      permissions: clone(executionMetadata.permissions),
      route: executionMetadata.routing,
      execution_metadata: clone(executionMetadata),
      intent: cleanText(sourceContext.domainIntent || task.intent || "general.execution", 200),
      intent_type: cleanText(understanding.intentType || understanding.intent || task.intent_type, 100),
      conversation_intent: cleanText(understanding.intent || task.conversation_intent || task.intent_type, 100),
      understanding_id: cleanText(understanding.understandingId, 200),
      task_type: cleanText(spec.taskType || task.task_type || "general_execution", 200),
      goal: cleanText(understanding.goal || task.goal, 1000) || "完成用户请求",
      task_goal: cleanText(understanding.taskGoal || understanding.goal || task.task_goal || task.goal, 1000) || "完成用户请求",
      required_capability: cleanText(understanding.requiredCapability || task.required_capability || executionMetadata.classification, 200),
      output: cleanText(spec.output || task.output || "经过验证的执行结果", 1000),
      delivery_mode: ["file", "mixed"].includes(cleanText(spec.deliveryMode || task.delivery_mode, 40))
        ? cleanText(spec.deliveryMode || task.delivery_mode, 40)
        : "chat",
      required_tools: cleanList(spec.requiredTools || task.required_tools || [], 20),
      acceptance: cleanList(spec.acceptance || task.acceptance || [], 20),
      constraints: cleanList(understanding.task_constraints || spec.constraints || task.constraints || [], 20),
      plan,
      pending: [...plan],
      status: "awaiting_confirmation",
      current_stage: "awaiting_confirmation",
      requires_confirmation: true,
      reconfirmed_at: this.now(),
      updated_at: this.now()
    });
    this.save();
    return clone(task);
  }

  restoreSnapshot(tasks = [], sessionId = "") {
    const restored = [];
    for (const source of Array.isArray(tasks) ? tasks.slice(-30) : []) {
      const originalId = cleanText(source.task_id, 200);
      const existing = originalId && this.store.tasks.find((item) => item.task_id === originalId);
      if (existing) {
        Object.assign(existing, clone(source), {
          session_id: sessionId || source.session_id || source.sessionId || existing.session_id,
          restored_at: this.now(),
          updated_at: this.now()
        });
        restored.push(clone(existing));
        continue;
      }
      const task = {
        ...clone(source),
        task_id: originalId || this.idFactory(),
        session_id: sessionId || source.session_id || source.sessionId || "",
        restored_at: this.now(),
        updated_at: this.now()
      };
      this.store.tasks.push(task);
      restored.push(clone(task));
    }
    if (restored.length) this.save();
    return restored;
  }

  replaceSessionTasks(sessionIds = [], tasks = [], fallbackSessionId = "") {
    const ids = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).map((item) => cleanText(item, 200)).filter(Boolean));
    this.store.tasks = this.store.tasks.filter((task) => !ids.has(cleanText(task.session_id || task.sessionId, 200)));
    const restored = [];
    for (const source of Array.isArray(tasks) ? tasks.slice(-30) : []) {
      const sourceSessionId = cleanText(source.session_id || source.sessionId, 200);
      const task = {
        ...clone(source),
        task_id: cleanText(source.task_id, 200) || this.idFactory(),
        session_id: ids.has(sourceSessionId) ? sourceSessionId : (fallbackSessionId || sourceSessionId),
        restored_at: this.now(),
        updated_at: this.now()
      };
      this.store.tasks.push(task);
      restored.push(clone(task));
    }
    this.save();
    return restored;
  }

  getAwaitingConfirmation(sessionId) {
    const task = [...this.store.tasks].reverse().find(
      (item) => item.session_id === sessionId && item.status === "awaiting_confirmation"
    );
    if (!task) return null;

    // Historical tasks are migrated in place. Missing metadata never blocks a
    // pending task or changes its status.
    if (!task.execution_metadata || typeof task.execution_metadata !== "object") {
      task.execution_metadata = clone(buildExecutionMetadata(task));
      delete task.uug;
      task.updated_at = this.now();
      this.save();
    }

    return clone(task);
  }

  update(taskId, patch = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    Object.assign(task, patch, { updated_at: this.now() });
    this.save();
    return clone(task);
  }

  confirm(taskId) {
    return this.update(taskId, { status: "ready", current_stage: "confirmed", requires_confirmation: false });
  }

  cancel(taskId) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    task.status = "cancelled";
    task.current_stage = "cancelled";
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  interrupt(taskId, reason = "应用退出时未找到仍在运行的任务上下文") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    const message = cleanText(reason, 2000) || "应用退出时未找到仍在运行的任务上下文";
    task.status = "interrupted";
    task.current_stage = "interrupted";
    task.error = message;
    task.interruption_reason = message;
    task.interrupted_at = this.now();
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  resume(taskId) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    if (task.status !== "interrupted") return clone(task);
    task.status = "ready";
    task.current_stage = "resume_ready";
    task.requires_confirmation = false;
    task.resume_attempt = Number(task.resume_attempt || 0) + 1;
    task.resumed_at = this.now();
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  reconcileInterrupted({ activeTaskIds = [], reason = "应用启动时未找到仍在运行的任务上下文" } = {}) {
    const active = new Set((Array.isArray(activeTaskIds) ? activeTaskIds : [activeTaskIds])
      .map((item) => cleanText(item, 200)).filter(Boolean));
    const staleStatuses = new Set(["executing", "running", "verifying", "planning", "understanding"]);
    const repaired = [];
    for (const task of this.store.tasks) {
      if (!task?.task_id || !staleStatuses.has(String(task.status || "").toLowerCase()) || active.has(task.task_id)) continue;
      const next = this.interrupt(task.task_id, reason);
      if (next) repaired.push(next);
    }
    return repaired;
  }

  retry(taskId, { sessionId = "" } = {}) {
    const source = this.store.tasks.find((item) => item.task_id === taskId);
    if (!source) throw Object.assign(new Error("需要重试的任务不存在。"), { code: "TASK_RETRY_NOT_FOUND" });
    if (sessionId && source.session_id !== sessionId) {
      throw Object.assign(new Error("该任务不属于当前会话。"), { code: "TASK_RETRY_SESSION_MISMATCH" });
    }
    if (source.status !== "failed") {
      throw Object.assign(new Error("只有真实失败的任务可以重试。"), { code: "TASK_RETRY_INVALID_STATE" });
    }
    const retried = {
      ...clone(source),
      task_id: this.idFactory(),
      status: "ready",
      current_stage: "retry_ready",
      current_step: "",
      completed: [],
      pending: [...(source.plan || [])],
      requires_confirmation: false,
      retry_of: source.task_id,
      retry_attempt: Number(source.retry_attempt || 0) + 1,
      created_at: this.now(),
      updated_at: this.now()
    };
    delete retried.result;
    delete retried.error;
    delete retried.last_step_error;
    source.retry_task_ids = [...new Set([...(source.retry_task_ids || []), retried.task_id])];
    source.updated_at = this.now();
    this.store.tasks.push(retried);
    this.save();
    return clone(retried);
  }

  markExecuting(taskId) {
    return this.update(taskId, { status: "executing", current_stage: "executing" });
  }

  beginStep(taskId, title = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    task.status = "executing";
    task.current_stage = "executing";
    task.current_step = cleanText(title, 500);
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  recordStep(taskId, title = "", success = true, error = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    const step = cleanText(title, 500) || task.current_step || "执行步骤";
    task.current_step = step;
    task.current_stage = success ? "step_completed" : "step_failed";
    if (success) {
      if (!task.completed.includes(step)) task.completed.push(step);
      const exact = task.pending.indexOf(step);
      if (exact >= 0) task.pending.splice(exact, 1);
      else if (task.pending.length) task.pending.shift();
    } else {
      task.last_step_error = cleanText(error, 2000);
    }
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  complete(taskId, result = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    const wasCompleted = task.status === "completed";
    task.status = "completed";
    task.current_stage = "completed";
    task.completed = cleanList([...task.completed, ...task.plan], 50);
    task.pending = [];
    task.result = cleanText(result, 2000);
    task.updated_at = this.now();
    this.save();
    if (!wasCompleted) {
      try {
        this.onComplete?.(clone(task));
      } catch (error) {
        console.warn("[TaskBrain] 完成通知处理失败:", error.message || error);
      }
    }
    return clone(task);
  }

  fail(taskId, error = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    task.status = "failed";
    task.current_stage = "failed";
    task.error = cleanText(error, 2000);
    task.updated_at = this.now();
    this.save();
    return clone(task);
  }

  executionContext(taskOrId) {
    const task = typeof taskOrId === "string" ? this.get(taskOrId) : clone(taskOrId);
    if (!task) return null;
    const context = {
      task_id: task.task_id,
      task_type: task.task_type,
      level: task.level,
      route: task.route,
      intent: task.intent,
      intent_type: task.intent_type,
      conversation_intent: task.conversation_intent || task.intent_type,
      response_mode: task.response_mode || "conversation",
      decision_id: task.decision_id || "",
      classification: task.classification || "",
      permissions: clone(task.permissions || {}),
      executionMetadata: clone(task.execution_metadata || buildExecutionMetadata(task)),
      assignment_id: task.assignment_id || "",
      user_expectation: task.user_expectation || "",
      required_action: task.required_action || "execute",
      risk_level: task.risk_level || "low",
      assigned_role: task.assigned_role || "WORKER",
      capability_context: clone(task.capability_context || null),
      understanding_id: task.understanding_id || "",
      original_goal: task.goal,
      task_goal: task.task_goal || task.goal,
      required_capability: task.required_capability || task.classification || "general_execution",
      taskGoal: task.task_goal || task.goal,
      requiredCapability: task.required_capability || task.classification || "general_execution",
      original_input: task.original_input,
      output: task.output,
      current_stage: task.current_stage,
      current_step: task.current_step || "",
      completed: [...task.completed],
      pending: [...task.pending],
      constraints: [...task.constraints],
      acceptance: [...task.acceptance],
      required_tools: [...task.required_tools],
      execution_plan: [...task.plan]
    };
    context.agent_assignments = Array.isArray(task.agent_assignments) ? clone(task.agent_assignments) : [];
    context.requested_agent_count = Number(task.requested_agent_count || 0);
    context.delegation_mode = task.delegation_mode || "steps";
    const capability = context.capability_context || {};
    const workerNames = (Array.isArray(capability.workers) ? capability.workers : [])
      .map((item) => cleanText(item.agent_name, 120))
      .filter(Boolean)
      .slice(0, 12);
    const projectRoleNames = (Array.isArray(capability.projectRoles) ? capability.projectRoles : [])
      .map((item) => cleanText(item.agent_name, 120))
      .filter(Boolean)
      .slice(0, 12);
    const toolNames = (Array.isArray(capability.tools) ? capability.tools : [])
      .filter((item) => item.status === "available")
      .map((item) => cleanText(item.name || item.id, 120))
      .filter(Boolean)
      .slice(0, 20);
    context.prompt = [
      "【Task Brain 固定任务上下文】",
      `原始目标：${context.original_goal}`,
      `交付结果：${context.output}`,
      `当前阶段：${context.current_stage}`,
      `已完成：${context.completed.join("；") || "暂无"}`,
      `下一步：${context.pending.join("；") || "按验收标准检查结果"}`,
      `约束：${context.constraints.join("；") || "无额外约束"}`,
      `验收标准：${context.acceptance.join("；")}`,
      `用户期望：${context.user_expectation}`,
      `允许动作：${context.required_action}`,
      `当前项目：${capability.project?.name || "未进入项目"}`,
      `当前CEO：${capability.ceo?.name || "未检测到"}`,
      `项目岗位入口：${projectRoleNames.length}个${projectRoleNames.length ? `（${projectRoleNames.join("、")}）` : ""}`,
      `可调用Worker：${workerNames.length}个${workerNames.length ? `（${workerNames.join("、")}）` : ""}`,
      `真实工具能力：${toolNames.length ? toolNames.join("、") : "未检测到可用工具"}`,
      "项目岗位只提供职责和对话上下文；可调用 Worker 必须来自 Hermes 的真实临时委派。不得虚构 Agent、权限、工具或执行结果。",
      "执行过程中必须保持以上结构化目标，不得重新解析或直接执行用户原话。"
    ].join("\n");
    return context;
  }

  confirmationText(taskOrId) {
    const task = typeof taskOrId === "string" ? this.get(taskOrId) : taskOrId;
    if (!task) return "";
    return [
      "我理解你的需求：",
      "",
      `目标：${task.goal}`,
      `交付：${task.output}`,
      "",
      "执行计划：",
      ...task.plan.map((item, index) => `${index + 1}.${item}`),
      ...(task.constraints.length ? ["", `约束：${task.constraints.join("；")}`] : []),
      "",
      "是否开始执行？"
    ].join("\n");
  }
}

module.exports = {
  TaskBrain,
  TASK_LEVELS
};
