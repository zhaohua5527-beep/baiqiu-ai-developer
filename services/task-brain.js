"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("./data-root");
const { buildExecutionMetadata } = require("./execution-metadata");

const TASK_LEVELS = Object.freeze({ CHAT: 1, ASSISTED: 2, AGENT: 3 });
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted", "timed_out", "outdated"]);

function cleanText(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanList(value, limit = 20) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 500)).filter(Boolean))].slice(0, limit);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clearRetryTransientFields(task = {}) {
  const cleaned = { ...clone(task) };
  const transientKeys = [
    "result",
    "error",
    "last_step_error",
    "timeline",
    "files",
    "tool_evidence",
    "delegation_results",
    "execution_log",
    "delivery_status",
    "presentation_status",
    "result_history",
    "cancel_audit",
    "cancelAudit",
    "cancelled_at",
    "interrupted_at",
    "interruption_reason",
    "timed_out_at",
    "reopened_from_terminal_status",
    "retry_task_ids"
  ];
  for (const key of transientKeys) delete cleaned[key];
  return cleaned;
}

function normalizeTaskAttachment(item = {}) {
  return {
    id: cleanText(item.id, 300),
    name: cleanText(item.name, 300),
    role: cleanText(item.role || item.attachmentRole, 120),
    ordinal: Math.max(0, Number(item.ordinal || item.attachmentOrdinal || 0)),
    tableAlias: cleanText(item.tableAlias || item.attachmentAlias, 120),
    mimeType: cleanText(item.mimeType, 120),
    sizeBytes: Number(item.sizeBytes || item.size || 0),
    path: cleanText(item.path || item.originalPath || item.filePath, 1200),
    sourcePath: cleanText(item.sourcePath || item.path || item.originalPath || item.filePath, 1200),
    textContent: String(item.textContent || "").slice(0, 12000),
    url: cleanText(item.url, 1200)
  };
}

function mergeTaskAttachments(...groups) {
  const merged = new Map();
  for (const item of groups.flat().filter(Boolean)) {
    const normalized = normalizeTaskAttachment(item);
    const key = normalized.id || normalized.path || `${normalized.name}:${normalized.sizeBytes}`;
    if (!key) continue;
    merged.set(key, { ...(merged.get(key) || {}), ...normalized });
  }
  return [...merged.values()].slice(0, 20).map((item, index) => {
    const ordinal = item.ordinal || index + 1;
    return {
      ...item,
      ordinal,
      tableAlias: item.tableAlias || `表${ordinal}`
    };
  });
}

function attachmentManifest(attachments = []) {
  return mergeTaskAttachments(attachments).map((item) => ({
    ordinal: item.ordinal,
    alias: item.tableAlias,
    name: item.name,
    path: item.path || item.sourcePath,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes
  }));
}


function defaultStore() {
  return { version: 1, tasks: [], updated_at: null };
}

class TaskBrain {
  constructor({ root = path.join(dataRoot(), "task-brain"), clock = () => new Date(), idFactory = () => `task-${randomUUID()}`, onComplete = null, onChange = null } = {}) {
    this.root = root;
    this.file = path.join(root, "tasks.json");
    this.clock = clock;
    this.idFactory = idFactory;
    this.onComplete = typeof onComplete === "function" ? onComplete : null;
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.store = this.read();
    this.releaseConfirmationGates();
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

  notify(task) {
    if (!task) return;
    try {
      this.onChange?.(clone(task));
    } catch (error) {
      console.warn("[TaskBrain] task change notification failed:", error.message || error);
    }
  }

  recordEvent(task, stage, detail = "") {
    task.timeline = Array.isArray(task.timeline) ? task.timeline : [];
    task.timeline.push({
      stage: cleanText(stage, 100) || task.current_stage || "updated",
      detail: cleanText(detail, 1000),
      at: this.now()
    });
    task.timeline = task.timeline.slice(-80);
    task.last_heartbeat_at = this.now();
  }

  commit(task, stage = "", detail = "") {
    if (stage) this.recordEvent(task, stage, detail);
    this.save();
    this.notify(task);
    return clone(task);
  }

  submit({ sessionId = "", input = "", attachments = [], clientMessageId = "", timing = {} } = {}) {
    const now = this.now();
    const normalizedAttachments = mergeTaskAttachments(attachments);
    const task = {
      task_id: this.idFactory(),
      session_id: sessionId,
      task_type: "pending_classification",
      intent: "",
      intent_type: "",
      conversation_intent: "",
      decision_id: "",
      classification: "",
      response_mode: "",
      permissions: {},
      route: "",
      execution_metadata: {},
      level: TASK_LEVELS.CHAT,
      goal: cleanText(input, 1000),
      task_goal: cleanText(input, 1000),
      required_capability: "",
      output: "",
      delivery_mode: "chat",
      required_tools: [],
      acceptance: [],
      original_input: cleanText(input, 12000),
      client_message_id: cleanText(clientMessageId, 200),
      current_stage: "submitted",
      current_step: "",
      completed: [],
      pending: [],
      constraints: [],
      plan: [],
      timeline: [],
      status: "submitted",
      requires_confirmation: false,
      attachments: normalizedAttachments,
      followups: [],
      workset: {
        original_goal: cleanText(input, 12000),
        attachments: normalizedAttachments,
        attachment_manifest: attachmentManifest(normalizedAttachments),
        confirmations: [],
        output_location: ""
      },
      timing: {
        profile: cleanText(timing.profile, 100) || "model_response",
        expected_ms: Number(timing.expectedMs || 0),
        soft_timeout_ms: Number(timing.softTimeoutMs || 0),
        hard_timeout_ms: Number(timing.hardTimeoutMs || 0),
        heartbeat_ms: Number(timing.heartbeatMs || 0),
        started_at: now,
        soft_deadline_at: Number(timing.softTimeoutMs || 0) ? new Date(Date.now() + Number(timing.softTimeoutMs)).toISOString() : "",
        hard_deadline_at: Number(timing.hardTimeoutMs || 0) ? new Date(Date.now() + Number(timing.hardTimeoutMs)).toISOString() : ""
      },
      created_at: now,
      started_at: now,
      updated_at: now,
      last_heartbeat_at: now
    };
    this.store.tasks.push(task);
    return this.commit(task, "submitted", "Task persisted before execution starts");
  }

  prepare({ sessionId = "", understanding = null, attachments = [], taskId = "", clientMessageId = "" } = {}) {
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
    const existing = taskId ? this.store.tasks.find((item) => item.task_id === taskId) : null;
    if (existing && TERMINAL_STATES.has(existing.status)) return clone(existing);
    const normalizedAttachments = mergeTaskAttachments(existing?.attachments || [], attachments);
    const task = {
      ...(existing || {}),
      task_id: existing?.task_id || this.idFactory(),
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
      original_input: existing?.original_input || original,
      client_message_id: existing?.client_message_id || cleanText(clientMessageId, 200),
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
      requires_confirmation: false,
      attachments: normalizedAttachments,
      followups: Array.isArray(existing?.followups) ? clone(existing.followups).slice(-20) : [],
      workset: {
        original_goal: cleanText(existing?.workset?.original_goal || existing?.original_input || original, 12000),
        attachments: normalizedAttachments,
        attachment_manifest: attachmentManifest(normalizedAttachments),
        confirmations: Array.isArray(existing?.workset?.confirmations) ? clone(existing.workset.confirmations).slice(-20) : [],
        output_location: cleanText(existing?.workset?.output_location, 1200)
      },
      created_at: existing?.created_at || this.now(),
      started_at: existing?.started_at || this.now(),
      updated_at: this.now(),
      last_heartbeat_at: this.now(),
      timing: existing?.timing || {}
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
    if (existing) Object.assign(existing, task);
    else this.store.tasks.push(task);
    return this.commit(existing || task, "planning", "Task classified and planned");
  }

  get(taskId) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    return task ? clone(task) : null;
  }

  releaseConfirmationGates() {
    let changed = false;
    for (const task of this.store.tasks) {
      if (task?.status !== "awaiting_confirmation" && task?.requires_confirmation !== true) continue;
      task.status = task.status === "awaiting_confirmation" ? "ready" : task.status;
      task.current_stage = task.current_stage === "awaiting_confirmation" ? "ready" : task.current_stage;
      task.requires_confirmation = false;
      task.updated_at = this.now();
      changed = true;
    }
    if (changed) this.save();
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
      status: "ready",
      current_stage: "ready",
      requires_confirmation: false,
      reconfirmed_at: this.now(),
      updated_at: this.now()
    });
    this.save();
    return clone(task);
  }

  // 快照/会话恢复时，把"无活动运行却标执行中"的任务归一到 interrupted。
  // 恢复不会重建 activeRuns/controller，原样保留 executing 会让任务永久卡住
  // （reconcileInterrupted 只在启动时跑，运行时恢复不触发）。awaiting_* 与
  // 已终态任务保留原样，确认流程可接续、终态不复活。
  normalizeRestoredStatus(task) {
    const status = String(task?.status || "").toLowerCase();
    const nonTerminalInFlight = new Set([
      "submitted", "executing", "running", "verifying", "planning",
      "understanding", "delayed", "awaiting_authorization"
    ]);
    if (nonTerminalInFlight.has(status)) {
      return {
        ...task,
        status: "interrupted",
        current_stage: "interrupted",
        interruption_reason: task.interruption_reason || "恢复快照时仍在运行的任务已中断",
        interrupted_at: task.interrupted_at || this.now(),
        updated_at: this.now()
      };
    }
    return task;
  }

  restoreSnapshot(tasks = [], sessionId = "") {
    const restored = [];
    for (const source of Array.isArray(tasks) ? tasks.slice(-30) : []) {
      const normalized = this.normalizeRestoredStatus(source);
      const originalId = cleanText(normalized.task_id, 200);
      const existing = originalId && this.store.tasks.find((item) => item.task_id === originalId);
      if (existing) {
        Object.assign(existing, clone(normalized), {
          session_id: sessionId || normalized.session_id || normalized.sessionId || existing.session_id,
          restored_at: this.now(),
          updated_at: this.now()
        });
        restored.push(clone(existing));
        continue;
      }
      const task = {
        ...clone(normalized),
        task_id: originalId || this.idFactory(),
        session_id: sessionId || normalized.session_id || normalized.sessionId || "",
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
      const normalized = this.normalizeRestoredStatus(source);
      const sourceSessionId = cleanText(normalized.session_id || normalized.sessionId, 200);
      const task = {
        ...clone(normalized),
        task_id: cleanText(normalized.task_id, 200) || this.idFactory(),
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

  getAwaitingInput(sessionId) {
    const task = [...this.store.tasks].reverse().find(
      (item) => item.session_id === sessionId && item.status === "awaiting_input"
    );
    return task ? clone(task) : null;
  }

  continueWorkset(taskId, { input = "", attachments = [], reopenCompleted = false, reopenTerminal = false } = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    if (TERMINAL_STATES.has(task.status)) {
      if (!reopenTerminal && (!reopenCompleted || task.status !== "completed")) return clone(task);
      const previousStatus = task.status;
      task.result_history = Array.isArray(task.result_history) ? task.result_history : [];
      task.result_history.push({
        result: clone(task.result || ""),
        error: clone(task.error || ""),
        status: previousStatus,
        completed_at: task.completed_at || task.updated_at || this.now()
      });
      task.result_history = task.result_history.slice(-5);
      delete task.result;
      delete task.error;
      delete task.completed_at;
      task.reopened_from_completed_at = this.now();
      task.reopened_from_terminal_status = previousStatus;
    }
    const followup = cleanText(input, 12000);
    task.followups = Array.isArray(task.followups) ? task.followups : [];
    if (followup) task.followups.push({ text: followup, at: this.now() });
    task.followups = task.followups.slice(-20);
    task.attachments = mergeTaskAttachments(task.attachments || [], attachments);
    task.workset = task.workset && typeof task.workset === "object" ? task.workset : {};
    task.workset.original_goal = cleanText(task.workset.original_goal || task.original_input || task.goal, 12000);
    task.workset.attachments = mergeTaskAttachments(task.workset.attachments || [], task.attachments);
    task.workset.attachment_manifest = attachmentManifest(task.workset.attachments);
    task.workset.confirmations = Array.isArray(task.workset.confirmations) ? task.workset.confirmations : [];
    if (followup) task.workset.confirmations.push({ text: followup, at: this.now() });
    task.workset.confirmations = task.workset.confirmations.slice(-20);
    task.status = "ready";
    task.current_stage = "input_received";
    task.current_step = followup;
    task.updated_at = this.now();
    return this.commit(task, "input_received", followup || "User supplied requested input");
  }

  resumeAwaitingInput(taskId, { input = "", attachments = [] } = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || task.status !== "awaiting_input") return task ? clone(task) : null;
    return this.continueWorkset(taskId, { input, attachments });
  }

  updateTiming(taskId, timing = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    const current = task.timing && typeof task.timing === "object" ? task.timing : {};
    const startedAt = current.started_at || task.started_at || this.now();
    const parsedStartedAt = Date.parse(startedAt);
    const startedMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
    const expectedMs = Math.max(0, Number(timing.expectedMs || current.expected_ms || 0));
    const softTimeoutMs = Math.max(0, Number(timing.softTimeoutMs || current.soft_timeout_ms || 0));
    const hardTimeoutMs = Math.max(0, Number(timing.hardTimeoutMs || current.hard_timeout_ms || 0));
    const heartbeatMs = Math.max(0, Number(timing.heartbeatMs || current.heartbeat_ms || 0));
    task.timing = {
      ...current,
      profile: cleanText(timing.profile || current.profile, 100) || "model_response",
      expected_ms: expectedMs,
      soft_timeout_ms: softTimeoutMs,
      hard_timeout_ms: hardTimeoutMs,
      heartbeat_ms: heartbeatMs,
      started_at: new Date(startedMs).toISOString(),
      soft_deadline_at: softTimeoutMs ? new Date(startedMs + softTimeoutMs).toISOString() : "",
      hard_deadline_at: hardTimeoutMs ? new Date(startedMs + hardTimeoutMs).toISOString() : ""
    };
    task.updated_at = this.now();
    return this.commit(task, "timing_updated", `${task.timing.profile}:${hardTimeoutMs}ms`);
  }

  update(taskId, patch = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    Object.assign(task, patch, { updated_at: this.now() });
    return this.commit(task, patch.current_stage || patch.status || "updated", patch.current_step || "");
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
    return this.commit(task, "cancelled", "Task cancelled");
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
    return this.commit(task, "interrupted", message);
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
    return this.commit(task, "resume_ready", "Task resumed");
  }

  reconcileInterrupted({ activeTaskIds = [], reason = "应用启动时未找到仍在运行的任务上下文" } = {}) {
    const active = new Set((Array.isArray(activeTaskIds) ? activeTaskIds : [activeTaskIds])
      .map((item) => cleanText(item, 200)).filter(Boolean));
    const staleStatuses = new Set(["submitted", "executing", "running", "verifying", "planning", "understanding", "delayed", "awaiting_authorization"]);
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
      ...clearRetryTransientFields(source),
      task_id: this.idFactory(),
      status: "ready",
      current_stage: "retry_ready",
      current_step: "",
      completed: [],
      pending: [...(source.plan || [])],
      timeline: [],
      requires_confirmation: false,
      retry_of: source.task_id,
      retry_attempt: Number(source.retry_attempt || 0) + 1,
      created_at: this.now(),
      updated_at: this.now()
    };
    source.retry_task_ids = [...new Set([...(source.retry_task_ids || []), retried.task_id])];
    source.updated_at = this.now();
    this.store.tasks.push(retried);
    this.save();
    return clone(retried);
  }

  markExecuting(taskId) {
    return this.update(taskId, { status: "executing", current_stage: "executing" });
  }

  heartbeat(taskId, { stage = "", step = "", detail = "" } = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    if (stage) task.current_stage = cleanText(stage, 100);
    if (step) task.current_step = cleanText(step, 500);
    task.updated_at = this.now();
    return this.commit(task, task.current_stage || "heartbeat", detail || task.current_step || "");
  }

  markDelayed(taskId, reason = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    task.status = "delayed";
    task.current_stage = "delayed";
    task.delay_reason = cleanText(reason, 1000) || "Task exceeded its expected duration";
    task.updated_at = this.now();
    return this.commit(task, "delayed", task.delay_reason);
  }

  markTimedOut(taskId, reason = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    task.status = "timed_out";
    task.current_stage = "timed_out";
    task.error = cleanText(reason, 2000) || "Task exceeded its maximum duration";
    task.updated_at = this.now();
    return this.commit(task, "timed_out", task.error);
  }

  beginStep(taskId, title = "") {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task || TERMINAL_STATES.has(task.status)) return task ? clone(task) : null;
    task.status = "executing";
    task.current_stage = "executing";
    task.current_step = cleanText(title, 500);
    task.updated_at = this.now();
    return this.commit(task, "executing", task.current_step);
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
    return this.commit(task, task.current_stage, task.current_step);
  }

  // 完成。默认拒绝覆盖终态；但当任务已被硬超时标记为 timed_out、而执行链
  // 在超时后返回了携带真实产物证据的成功结果时（absorbAfterTimeout=true），
  // 应吸收为完成——否则"产物已生成但任务定格超时"会造成假失败。
  // 只有显式传入产物证据的迟到成功才被吸收，不会掩盖真正的超时。
  complete(taskId, result = "", options = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    const absorbTimeout = options.absorbAfterTimeout === true && task.status === "timed_out";
    if (TERMINAL_STATES.has(task.status) && task.status !== "completed" && !absorbTimeout) return clone(task);
    const wasCompleted = task.status === "completed";
    task.status = "completed";
    task.current_stage = "completed";
    task.completed = cleanList([...task.completed, ...task.plan], 50);
    task.pending = [];
    task.result = cleanText(result, 2000);
    this.applyExecutionEvidence(task, options.evidence);
    if (absorbTimeout) {
      // 记录超时后被真实结果修正，供审计
      task.absorbed_after_timeout = cleanText(result, 2000);
      delete task.error;
    }
    task.updated_at = this.now();
    const completed = this.commit(task, absorbTimeout ? "absorbed_after_timeout" : "completed", task.result);
    if (!wasCompleted) {
      try {
        this.onComplete?.(clone(task));
      } catch (error) {
        console.warn("[TaskBrain] 完成通知处理失败:", error.message || error);
      }
    }
    return completed;
  }

  fail(taskId, error = "", options = {}) {
    const task = this.store.tasks.find((item) => item.task_id === taskId);
    if (!task) return null;
    if (TERMINAL_STATES.has(task.status) && task.status !== "failed") return clone(task);
    task.status = "failed";
    task.current_stage = "failed";
    task.error = cleanText(error, 2000);
    this.applyExecutionEvidence(task, options.evidence);
    task.updated_at = this.now();
    return this.commit(task, "failed", task.error);
  }

  applyExecutionEvidence(task, evidence = null) {
    if (!task || !evidence || typeof evidence !== "object") return task;
    const copyList = (value, limit) => Array.isArray(value) ? clone(value.slice(-limit)) : [];
    const files = copyList(evidence.files, 50);
    const tools = copyList(evidence.tool_evidence || evidence.toolCalls, 120);
    const delegations = copyList(evidence.delegation_results || evidence.delegationResults, 50);
    const executionLog = copyList(evidence.execution_log || evidence.executionLog, 120);
    if (files.length) task.files = files;
    if (tools.length) task.tool_evidence = tools;
    if (delegations.length) task.delegation_results = delegations;
    if (executionLog.length) task.execution_log = executionLog;
    if (evidence.delivery_status) task.delivery_status = cleanText(evidence.delivery_status, 80);
    if (evidence.presentation_status) task.presentation_status = cleanText(evidence.presentation_status, 80);
    return task;
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
      followups: clone(Array.isArray(task.followups) ? task.followups : []),
      attachments: clone(Array.isArray(task.attachments) ? task.attachments : []),
      workset: clone(task.workset || {
        original_goal: task.original_input || task.goal,
        attachments: task.attachments || [],
        attachment_manifest: attachmentManifest(task.attachments || []),
        confirmations: [],
        output_location: ""
      }),
      output: task.output,
      status: task.status,
      current_stage: task.current_stage,
      current_step: task.current_step || "",
      completed: [...task.completed],
      pending: [...task.pending],
      constraints: [...task.constraints],
      acceptance: [...task.acceptance],
      required_tools: [...task.required_tools],
      execution_plan: [...task.plan],
      timing: clone(task.timing || {}),
      files: clone(Array.isArray(task.files) ? task.files : []),
      tool_evidence: clone(Array.isArray(task.tool_evidence) ? task.tool_evidence : []),
      delegation_results: clone(Array.isArray(task.delegation_results) ? task.delegation_results : []),
      execution_log: clone(Array.isArray(task.execution_log) ? task.execution_log : []),
      delivery_status: task.delivery_status || "",
      presentation_status: task.presentation_status || ""
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
  TASK_LEVELS,
  attachmentManifest
};
