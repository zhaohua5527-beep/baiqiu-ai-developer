"use strict";

const { AGENT_RUNTIME_STATES, normalizeAgentRuntimeState } = require("./agent-runtime-status");

const ACTIVE_TASK_STATES = new Set(["ready", "awaiting_confirmation", "executing", "running", "waiting"]);

function cleanText(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function taskSummary(task = {}) {
  return {
    taskId: cleanText(task.task_id || task.taskId, 200),
    sessionId: cleanText(task.session_id || task.sessionId, 200),
    goal: cleanText(task.goal || task.original_input, 240),
    status: cleanText(task.status || task.current_stage, 80),
    updatedAt: cleanText(task.updated_at || task.updatedAt, 80)
  };
}

function toolSummary(tool = {}) {
  return {
    id: cleanText(tool.id || tool.name, 160),
    name: cleanText(tool.name || tool.id, 160),
    status: cleanText(tool.status || "available", 40),
    type: cleanText(tool.type || tool.category || "tool", 80)
  };
}

function permissionsFor(session = {}) {
  if (session.projectId && session.type !== "Agent") {
    return [
      "conversation",
      "read_project_context",
      "read_task_repository",
      "capability_query",
      "status_query",
      "submit_to_hermes",
      "use_tools",
      "use_skills",
      "write_project_files",
      "verify_results",
      "delegate_ephemeral_tasks"
    ];
  }
  if (session.type === "CEO") {
    return ["delegate_ephemeral_tasks", "read_task_repository", "report_hermes_results"];
  }
  if (session.type === "Agent") {
    return ["conversation", "submit_to_hermes", "capability_query", "status_query"];
  }
  return ["conversation", "capability_query", "status_query"];
}

function projectRoleSummary(session = {}) {
  return {
    agent_id: cleanText(session.roleEntryId || session.id, 200),
    conversation_id: cleanText(session.conversationId || session.sessionId || session.id, 200),
    agent_name: cleanText(session.name || session.title || "执行岗位", 160),
    role: cleanText(session.role || "执行人员", 160),
    capability: cleanText(session.capability || session.task || "通用任务执行", 240),
    task: cleanText(session.task, 240),
    status: normalizeAgentRuntimeState(session.status, AGENT_RUNTIME_STATES.WAITING),
    agent_class: "PROJECT_EXECUTION_SLOT",
    runtime: "hermes",
    execution_mode: "hermes_ephemeral_binding",
    persistent_role: true,
    ephemeral: false
  };
}

function delegationSummary(item = {}, index = 0) {
  return {
    agent_id: cleanText(item.delegationId || `delegation-${index + 1}`, 200),
    agent_name: cleanText(item.roleName || "Hermes Worker", 160),
    role_session_id: cleanText(item.roleSessionId, 200),
    assignment_id: cleanText(item.assignmentId, 200),
    role: "Hermes Worker 绑定",
    capability: "执行已绑定的内部项目任务",
    status: cleanText(item.status || "completed", 40),
    agent_class: "HERMES_WORKER_BINDING",
    runtime: "hermes",
    ephemeral: true
  };
}

class AgentCapabilityContext {
  constructor({
    taskRepository,
    loadSessions = () => [],
    loadProjects = () => [],
    loadTools = () => [],
    loadCapabilities = () => [],
    runtimeAvailability = () => ({}),
    clock = () => new Date()
  } = {}) {
    this.taskRepository = taskRepository;
    this.loadSessions = loadSessions;
    this.loadProjects = loadProjects;
    this.loadTools = loadTools;
    this.loadCapabilities = loadCapabilities;
    this.runtimeAvailability = runtimeAvailability;
    this.clock = clock;
  }

  snapshot({ sessionId = "", projectId = "", sessionType = "" } = {}) {
    const loadedSessions = this.loadSessions();
    const loadedProjects = this.loadProjects();
    const sessions = Array.isArray(loadedSessions) ? loadedSessions : [];
    const projects = Array.isArray(loadedProjects) ? loadedProjects : [];
    const current = sessions.find((item) => item.id === sessionId) || { id: sessionId, type: sessionType };
    const resolvedProjectId = cleanText(projectId || current.projectId, 200);
    const project = projects.find((item) => item.id === resolvedProjectId) || null;
    const projectSessions = sessions.filter((item) => resolvedProjectId && item.projectId === resolvedProjectId);
    const projectOwner = resolvedProjectId && current.projectId === resolvedProjectId && current.type !== "Agent"
      ? current
      : null;
    const ceo = current.type === "CEO"
      ? current
      : projectSessions.find((item) => item.type === "CEO" && (!current.parentSessionId || item.id === current.parentSessionId))
        || projectSessions.find((item) => item.type === "CEO")
        || projectOwner
        || null;
    const projectRoles = resolvedProjectId
      ? projectSessions.filter((item) => item.type === "Agent").map(projectRoleSummary)
      : [];
    const workers = resolvedProjectId
      ? (Array.isArray(ceo?.lastExecution?.employeeResults) ? ceo.lastExecution.employeeResults : []).map(delegationSummary)
      : [];
    const projectSessionIds = new Set(projectSessions.map((item) => item.id));
    const allTasks = this.taskRepository?.list ? this.taskRepository.list("", 100) : [];
    const projectTasks = allTasks
      .filter((task) => !resolvedProjectId || projectSessionIds.has(task.session_id || task.sessionId))
      .slice(0, 20)
      .map(taskSummary);
    const loadedCapabilities = this.loadCapabilities();
    const loadedTools = this.loadTools();
    const capabilities = (Array.isArray(loadedCapabilities) ? loadedCapabilities : [])
      .map(toolSummary)
      .slice(0, 80);
    const tools = (Array.isArray(loadedTools) ? loadedTools : [])
      .map(toolSummary)
      .filter((item) => item.id)
      .slice(0, 80);
    const runtime = this.runtimeAvailability() || {};
    const snapshot = {
      version: "agent-capability-context/1.0",
      generatedAt: this.clock().toISOString(),
      session: {
        id: cleanText(current.id, 200),
        type: cleanText(current.type || sessionType || "chat", 40),
        name: cleanText(current.name || current.title || "", 160),
        role: cleanText(current.role || "", 160)
      },
      project: {
        id: resolvedProjectId,
        name: cleanText(project?.name || project?.title || "", 200),
        description: cleanText(project?.description || "", 800),
        workspacePath: cleanText(project?.workspacePath || project?.rootPath || project?.path || "", 600),
        workspaceMode: cleanText(project?.workspaceMode || "managed", 40),
        available: Boolean(project)
      },
      ceo: {
        agentId: cleanText(ceo?.agentId || ceo?.id, 200),
        conversationId: cleanText(ceo?.conversationId || ceo?.id, 200),
        name: cleanText(ceo?.name || ceo?.title || "", 160),
        role: cleanText(ceo?.role || "黑球", 160),
        status: normalizeAgentRuntimeState(ceo?.status, AGENT_RUNTIME_STATES.CREATED)
      },
      projectRoles,
      workers,
      counts: {
        projectAgents: (ceo ? 1 : 0) + projectRoles.length,
        projectRoles: projectRoles.length,
        assignableRoles: projectRoles.length,
        callableWorkers: projectRoles.length,
        globalWorkers: 0,
        activeTasks: projectTasks.filter((item) => ACTIVE_TASK_STATES.has(item.status.toLowerCase())).length,
        knownTasks: projectTasks.length,
        tools: tools.filter((item) => item.status === "available").length,
        capabilities: capabilities.filter((item) => item.status === "available").length
      },
      permissions: permissionsFor(current),
      tools,
      capabilities,
      tasks: projectTasks,
      availability: {
        taskRepository: Boolean(this.taskRepository?.list),
        hermesAcp: runtime.hermesAcp === true,
        hermesDelegation: runtime.hermesDelegation === true,
        hermesSkills: runtime.hermesSkills === true
      }
    };
    return deepFreeze(snapshot);
  }
}

module.exports = { AgentCapabilityContext, permissionsFor, projectRoleSummary, taskSummary, toolSummary };
