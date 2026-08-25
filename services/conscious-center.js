"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createConsciousBackup, readConsciousBackup } = require("./conscious-backup");
const { MemoryDistiller } = require("./memory-distiller");

const COGNITIVE_SNAPSHOT_FIELDS = new Set([
  "background",
  "coreDecisions",
  "decisions",
  "projectConstraints",
  "constraints",
  "explicitRequirements",
  "userPreferences",
  "user_preferences",
  "chatHistorySummary",
  "conversation_summary",
  "distillation",
  "nextPlan",
  "next_actions",
  "sessionMemory",
  "globalPersona",
  "memoryLayer",
  "contextReplacement"
]);

function executionCore(core = {}) {
  if (!core || typeof core !== "object") return {};
  const allowed = ["goal", "current_stage", "completed_tasks", "pending_tasks", "important_files", "agent_state"];
  return Object.fromEntries(allowed.filter((key) => core[key] !== undefined).map((key) => [key, clone(core[key])]));
}

function stripCognitiveSnapshotFields(snapshot, { defaultResponsibility = "" } = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const clean = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (COGNITIVE_SNAPSHOT_FIELDS.has(key)) continue;
    clean[key] = key === "core" ? executionCore(value) : clone(value);
  }
  clean.schemaVersion = Math.max(3, Number(clean.schemaVersion || 0));
  clean.responsibility = clean.responsibility || defaultResponsibility || "execution_state";
  return clean;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeWorkspaceProject(project) {
  if (!project || typeof project !== "object") return project || null;
  const { consciousBackup, ...rest } = project;
  return clone(rest);
}

function sanitizeWorkspaceSession(session) {
  if (!session || typeof session !== "object") return session || null;
  const { messages, ...rest } = session;
  const memory = rest.memory && typeof rest.memory === "object" ? { ...rest.memory } : {};
  delete memory.projectConsciousness;
  delete memory.sessionConsciousness;
  return clone({ ...rest, memory });
}

function sanitizeSnapshotInput(input = {}) {
  const workspace = input.workspaceState && typeof input.workspaceState === "object"
    ? input.workspaceState
    : {};
  return {
    ...input,
    workspaceState: {
      project: sanitizeWorkspaceProject(workspace.project),
      sessions: (workspace.sessions || []).map(sanitizeWorkspaceSession).filter(Boolean)
    },
    project_state: sanitizeWorkspaceProject(input.project_state)
  };
}

function compactConsciousSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const safeSnapshot = stripCognitiveSnapshotFields(snapshot);
  const fields = [
    "schemaVersion", "type", "id", "version", "scope", "sourceId", "projectId", "sessionId",
    "title", "projectName", "projectGoal", "currentTaskGoal", "currentProgress",
    "completedTasks", "pendingTasks", "fileChanges", "sourceStats", "agentStates", "agentRuntimeState", "core",
    "snapshot_id", "user_goal", "current_objective", "current_stage", "completed_tasks", "pending_tasks",
    "important_files", "taskBrainState", "task_brain_state", "agent_state", "timestamp", "status",
    "createdAt", "updatedAt", "important", "archived", "responsibility",
    "extractionMode", "retentionClass", "manualExtractionAt"
  ];
  const compact = {};
  for (const field of fields) {
    if (safeSnapshot[field] !== undefined) compact[field] = clone(safeSnapshot[field]);
  }
  return compact;
}

function cleanText(value, limit = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values, limit = 100) {
  return [...new Set((values || []).map((item) => cleanText(item, 300)).filter(Boolean))].slice(0, limit);
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function summarizeMessages(messages = []) {
  return messages.slice(-60).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: cleanText(message.text || message.content, 800),
    createdAt: message.createdAt || message.at || null
  })).filter((message) => message.text);
}

function collectKeywords(snapshot) {
  const source = [
    snapshot.title,
    snapshot.projectGoal,
    snapshot.currentTaskGoal,
    ...(snapshot.completedTasks || []),
    ...(snapshot.pendingTasks || []),
    ...(snapshot.agentStates || []).flatMap((item) => [item.name, item.role, item.task]),
    ...(snapshot.fileChanges || []).flatMap((item) => [item.name, item.path])
  ].join(" ").toLowerCase();
  return unique(source.split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2), 300);
}

function snapshotStatus(snapshot) {
  if ((snapshot.pendingTasks || []).length === 0 && (snapshot.completedTasks || []).length > 0) return "已完成";
  if ((snapshot.agentStates || []).some((item) => ["running", "executing"].includes(item.status))) return "开发中";
  return snapshot.scope === "project" ? "暂停" : "已保存";
}

function applyWorkStateContract(snapshot) {
  const core = snapshot.core || {};
  const completed = snapshot.completedTasks?.length ? snapshot.completedTasks : core.completed_tasks || [];
  const pending = snapshot.pendingTasks?.length ? snapshot.pendingTasks : core.pending_tasks || [];
  const files = core.important_files?.length ? core.important_files : snapshot.fileChanges || [];
  const agents = snapshot.agentRuntimeState?.length ? snapshot.agentRuntimeState : core.agent_state?.length ? core.agent_state : snapshot.agentStates || [];
  return {
    ...snapshot,
    snapshot_id: snapshot.id,
    user_goal: cleanText(snapshot.projectGoal || core.goal || snapshot.currentTaskGoal || snapshot.title, 2000),
    current_objective: cleanText(snapshot.currentTaskGoal || core.goal || snapshot.projectGoal || snapshot.title, 2000),
    current_stage: cleanText(core.current_stage || snapshot.currentProgress?.summary || "待继续", 500),
    completed_tasks: clone(completed),
    pending_tasks: clone(pending),
    important_files: clone(files),
    project_state: sanitizeWorkspaceProject(snapshot.workspaceState?.project || {}),
    task_brain_state: clone(snapshot.taskBrainState || []),
    agent_state: clone(agents),
    timestamp: snapshot.updatedAt || snapshot.createdAt
  };
}

const MAX_SNAPSHOTS_PER_SOURCE = 5;
const MAX_SNAPSHOT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_DELETE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOTS = 50;

class ConsciousCenter {
  constructor({ root, clock = () => new Date(), distiller = null } = {}) {
    if (!root) throw new Error("ConsciousCenter requires root");
    this.root = root;
    this.clock = clock;
    this.distiller = distiller || new MemoryDistiller();
    this.snapshotsRoot = path.join(root, "snapshots");
    this.indexFile = path.join(root, "index.json");
    this.ensureStore();
    this.migrateStoredSnapshots();
  }

  now() {
    return this.clock().toISOString();
  }

  ensureStore() {
    fs.mkdirSync(this.snapshotsRoot, { recursive: true });
    if (!fs.existsSync(this.indexFile)) writeJsonAtomic(this.indexFile, {
      schemaVersion: 2,
      items: [],
      lastManualExtractionAt: null,
      updatedAt: this.now()
    });
  }

  migrateStoredSnapshots() {
    const index = this.readIndex();
    const indexById = new Map(index.items.map((item) => [item.id, item]));
    let changed = false;
    for (const file of fs.readdirSync(this.snapshotsRoot).filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(this.snapshotsRoot, file);
      const stored = readJson(filePath, null);
      if (stored?.type !== "conscious-snapshot") continue;
      const legacyManual = stored.auto === false;
      const migrated = stripCognitiveSnapshotFields({
        ...stored,
        extractionMode: stored.extractionMode || (legacyManual ? "manual" : "execution"),
        responsibility: legacyManual ? "manual_consciousness" : (stored.responsibility || "execution_state"),
        retentionClass: stored.retentionClass || (legacyManual ? (stored.scope === "project" ? "project" : "short_term") : "execution_state"),
        manualExtractionAt: legacyManual ? (stored.manualExtractionAt || stored.updatedAt || stored.createdAt || null) : null
      });
      if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
        writeJsonAtomic(filePath, migrated);
        changed = true;
      }
      const item = indexById.get(migrated.id);
      if (!item) continue;
      const keywords = collectKeywords(migrated);
      const nextActions = (migrated.pending_tasks || migrated.pendingTasks || []).slice(0, 3);
      const searchText = [migrated.title, migrated.projectName, migrated.projectGoal, migrated.currentTaskGoal, ...keywords]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (JSON.stringify(item.keywords || []) !== JSON.stringify(keywords)
        || JSON.stringify(item.nextActions || []) !== JSON.stringify(nextActions)
        || item.searchText !== searchText
        || item.extractionMode !== migrated.extractionMode
        || item.responsibility !== migrated.responsibility
        || item.retentionClass !== migrated.retentionClass) {
        item.keywords = keywords;
        item.nextActions = nextActions;
        item.searchText = searchText;
        item.extractionMode = migrated.extractionMode;
        item.responsibility = migrated.responsibility;
        item.retentionClass = migrated.retentionClass;
        item.manualExtractionAt = migrated.manualExtractionAt || null;
        changed = true;
      }
      if (legacyManual && migrated.manualExtractionAt && (!index.lastManualExtractionAt || String(migrated.manualExtractionAt) > String(index.lastManualExtractionAt))) {
        index.lastManualExtractionAt = migrated.manualExtractionAt;
        changed = true;
      }
    }
    if (changed) this.writeIndex(index);
  }

  readIndex() {
    const value = readJson(this.indexFile, { schemaVersion: 2, items: [], lastManualExtractionAt: null, updatedAt: null });
    if (!Array.isArray(value.items)) value.items = [];
    value.schemaVersion = Math.max(2, Number(value.schemaVersion || 0));
    if (!Object.hasOwn(value, "lastManualExtractionAt")) value.lastManualExtractionAt = null;
    return value;
  }

  writeIndex(index) {
    index.updatedAt = this.now();
    writeJsonAtomic(this.indexFile, index);
  }

  snapshotFile(id) {
    return path.join(this.snapshotsRoot, `${encodeURIComponent(id)}.json`);
  }

  get(id) {
    const value = readJson(this.snapshotFile(id), null);
    return value?.type === "conscious-snapshot" ? stripCognitiveSnapshotFields(value) : null;
  }

  remove(id) {
    const snapshotId = cleanText(id, 300);
    if (!snapshotId) throw new Error("意识快照标识不能为空");
    const index = this.readIndex();
    const item = index.items.find((entry) => entry.id === snapshotId);
    const snapshot = this.get(snapshotId);
    if (!item && !snapshot) throw new Error("意识快照不存在");
    const file = this.snapshotFile(snapshotId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    index.items = index.items.filter((entry) => entry.id !== snapshotId);
    this.writeIndex(index);
    return clone(snapshot || item);
  }

  list({ query = "", includeArchived = true, includeExecutionState = false, limit = 200 } = {}) {
    const needle = cleanText(query, 200).toLowerCase();
    return this.readIndex().items
      .filter((item) => includeArchived || !item.archived)
      .filter((item) => includeExecutionState || item.responsibility !== "execution_state")
      .filter((item) => !needle || item.searchText.includes(needle) || (item.keywords || []).some((word) => word.includes(needle)))
      .sort((a, b) => Number(Boolean(b.important)) - Number(Boolean(a.important)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
      .map(clone);
  }

  latestFor(scope, sourceId) {
    return this.list({ includeArchived: true, includeExecutionState: true, limit: 500 })
      .find((item) => item.scope === scope && item.sourceId === sourceId) || null;
  }

  hasSnapshot(scope, sourceId) {
    return Boolean(this.latestFor(scope, sourceId));
  }

  migrateLegacyProject(projectId) {
    if (!projectId || this.hasSnapshot("project", projectId)) return null;
    const legacy = readConsciousBackup(this.root, projectId);
    if (!legacy) return null;
    return this.persist({
      ...legacy,
      scope: "project",
      sourceId: projectId,
      title: legacy.projectName || "项目意识",
      createdAt: legacy.createdAt || this.now(),
      updatedAt: legacy.createdAt || this.now(),
      auto: false,
      extractionMode: "manual",
      responsibility: "manual_consciousness",
      retentionClass: "project",
      legacyImported: true
    });
  }

  buildProjectSnapshot({ project, sessions, messagesBySession, tasks, queue, settings, memoryState, agentRuntimeState = [], auto = false, trigger = "manual", extractionMode = "" }) {
    const safeProject = sanitizeWorkspaceProject(project);
    const safeSessions = sessions.map(sanitizeWorkspaceSession).filter(Boolean);
    const base = createConsciousBackup({ project: safeProject, sessions: safeSessions, messagesBySession, tasks, queue, settings });
    const linked = safeSessions.filter((session) => session.projectId === safeProject.id || (safeProject.sessions || []).includes(session.id));
    const linkedIds = new Set(linked.map((session) => session.id));
    const linkedMessages = linked.flatMap((session) => messagesBySession[session.id] || []);
    const taskBrainState = tasks.filter((task) => linkedIds.has(task.session_id || task.sessionId));
    const ceo = linked.find((session) => session.type === "CEO");
    const distilled = this.distiller.distill({ scope: "project", project: safeProject, sessions: linked, messages: linkedMessages, tasks: taskBrainState, settings });
    const completedFromBrain = unique(taskBrainState.flatMap((task) => task.completed?.length ? task.completed : task.status === "completed" ? [task.goal] : []), 80);
    const pendingFromBrain = unique(taskBrainState.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).flatMap((task) => task.pending?.length ? task.pending : [task.current_step || task.goal]), 80);
    return stripCognitiveSnapshotFields({
      ...base,
      scope: "project",
      sourceId: safeProject.id,
      title: safeProject.name,
      currentTaskGoal: cleanText(taskBrainState.find((task) => !["completed", "failed", "cancelled"].includes(task.status))?.goal || ceo?.task || safeProject.description, 2000),
      completedTasks: completedFromBrain.length ? completedFromBrain : base.completedTasks,
      pendingTasks: pendingFromBrain.length ? pendingFromBrain : base.pendingTasks,
      sessionMemory: clone(ceo?.memory?.sessionMemory || {}),
      globalPersona: clone(ceo?.memory?.globalPersona || settings.personaMemory || {}),
      memoryLayer: clone(memoryState || {}),
      core: distilled.core,
      distillation: distilled.metrics,
      taskBrainState: distilled.relevantTasks,
      ceoState: base.agentStates.find((item) => item.type === "CEO") || null,
      agentRuntimeState: clone(agentRuntimeState),
      auto: Boolean(auto),
      trigger,
      extractionMode: extractionMode || (auto ? "execution" : "manual"),
      responsibility: auto ? "execution_state" : "manual_consciousness",
      retentionClass: auto ? "execution_state" : "project",
      workspaceState: { project: safeProject, sessions: linked }
    }, { defaultResponsibility: auto ? "execution_state" : "manual_consciousness" });
  }

  buildSessionSnapshot({ session, project, messages, tasks, settings, memoryState, agentRuntimeState = [], auto = false, trigger = "manual", extractionMode = "" }) {
    const safeSession = sanitizeWorkspaceSession(session);
    const safeProject = sanitizeWorkspaceProject(project);
    const sessionTasks = tasks.filter((task) => (task.session_id || task.sessionId) === session.id);
    const distilled = this.distiller.distill({ scope: "session", project: safeProject, sessions: [safeSession], messages, tasks: sessionTasks, settings });
    const completedTasks = unique(sessionTasks.flatMap((task) => task.completed?.length ? task.completed : task.status === "completed" ? [task.goal] : []), 80);
    const pendingTasks = unique(sessionTasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).flatMap((task) => task.pending?.length ? task.pending : [task.current_step || task.goal]), 80);
    const userRequirements = unique(messages.filter((message) => message.role === "user").map((message) => message.text || message.content), 40);
    return stripCognitiveSnapshotFields({
      schemaVersion: 2,
      type: "conscious-snapshot",
      scope: "session",
      sourceId: session.id,
      sessionId: session.id,
      projectId: session.projectId || "",
      projectName: project?.name || "",
      title: session.title || session.name || "会话意识",
      projectGoal: cleanText(project?.description || session.task || session.title, 2000),
      currentTaskGoal: cleanText(sessionTasks.find((task) => !["completed", "failed", "cancelled"].includes(task.status))?.goal || session.task || session.title, 2000),
      background: userRequirements.slice(0, 12),
      currentProgress: {
        percent: sessionTasks.length ? Math.round((sessionTasks.filter((task) => task.status === "completed").length / sessionTasks.length) * 100) : 0,
        summary: cleanText(session.status || "已保存当前会话状态", 300),
        currentStages: unique(sessionTasks.map((task) => task.current_stage), 20)
      },
      agentStates: [session].filter((item) => ["CEO", "Agent"].includes(item.type)).map((item) => ({
        sessionId: item.id, name: item.name || item.title, type: item.type, role: item.role || "", task: item.task || "", status: item.status || "waiting"
      })),
      ceoState: safeSession.type === "CEO" ? clone(safeSession) : null,
      agentRuntimeState: clone(agentRuntimeState),
      auto: Boolean(auto),
      trigger,
      extractionMode: extractionMode || (auto ? "execution" : "manual"),
      responsibility: auto ? "execution_state" : "manual_consciousness",
      retentionClass: auto ? "execution_state" : "short_term",
      completedTasks,
      pendingTasks,
      sessionMemory: clone(session.memory?.sessionMemory || {}),
      globalPersona: clone(session.memory?.globalPersona || settings.personaMemory || {}),
      memoryLayer: clone(memoryState || {}),
      core: distilled.core,
      distillation: distilled.metrics,
      taskBrainState: distilled.relevantTasks,
      fileChanges: [],
      sourceStats: { sessions: 1, messages: messages.length, taskBrainTasks: sessionTasks.length, queuedTasks: 0, files: 0 },
      workspaceState: { project: safeProject, sessions: [safeSession] },
      createdAt: this.now()
    }, { defaultResponsibility: auto ? "execution_state" : "manual_consciousness" });
  }

  persist(input) {
    const now = this.now();
    const previous = this.latestFor(input.scope, input.sourceId);
    const safeInput = sanitizeSnapshotInput(input);
    const isManual = safeInput.extractionMode === "manual"
      || safeInput.responsibility === "manual_consciousness"
      || safeInput.auto === false;
    const extractionMode = isManual ? "manual" : "execution";
    const responsibility = isManual ? "manual_consciousness" : "execution_state";
    let snapshot = {
      ...clone(safeInput),
      schemaVersion: 2,
      type: "conscious-snapshot",
      id: `conscious-${randomUUID()}`,
      version: Number(previous?.version || 0) + 1,
      createdAt: input.createdAt || now,
      updatedAt: now,
      important: Boolean(input.important),
      archived: false,
      extractionMode,
      responsibility,
      retentionClass: safeInput.retentionClass || (isManual ? (input.scope === "project" ? "project" : "short_term") : "execution_state"),
      manualExtractionAt: isManual ? (safeInput.manualExtractionAt || now) : null
    };
    snapshot = stripCognitiveSnapshotFields(applyWorkStateContract(snapshot), { defaultResponsibility: responsibility });
    snapshot.status = snapshotStatus(snapshot);
    snapshot.keywords = collectKeywords(snapshot);
    writeJsonAtomic(this.snapshotFile(snapshot.id), snapshot);
    const index = this.readIndex();
    const item = {
      id: snapshot.id,
      version: snapshot.version,
      scope: snapshot.scope,
      sourceId: snapshot.sourceId,
      projectId: snapshot.projectId || "",
      sessionId: snapshot.sessionId || "",
      title: snapshot.title,
      status: snapshot.status,
      progress: Number(snapshot.currentProgress?.percent || 0),
      userGoal: snapshot.user_goal,
      currentObjective: snapshot.current_objective,
      currentStage: snapshot.current_stage,
      reductionPercent: Number(snapshot.distillation?.reductionPercent || 0),
      recentlyCompleted: snapshot.completed_tasks.slice(-3),
      nextActions: snapshot.pending_tasks.slice(0, 3),
      auto: Boolean(snapshot.auto),
      trigger: snapshot.trigger || "manual",
      extractionMode: snapshot.extractionMode,
      responsibility: snapshot.responsibility,
      retentionClass: snapshot.retentionClass,
      manualExtractionAt: snapshot.manualExtractionAt || null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      important: snapshot.important,
      archived: snapshot.archived,
      keywords: snapshot.keywords,
      searchText: [snapshot.title, snapshot.projectName, snapshot.projectGoal, snapshot.currentTaskGoal, ...snapshot.keywords].join(" ").toLowerCase()
    };
    index.items.unshift(item);
    if (isManual) index.lastManualExtractionAt = snapshot.manualExtractionAt || snapshot.updatedAt;
    index.items = index.items.slice(0, 1000);
    this.writeIndex(index);
    this.autoPrune(input.scope, input.sourceId);
    return clone(snapshot);
  }

  pruneExpiredShortTerm({ inactivityDays = 30 } = {}) {
    const index = this.readIndex();
    const lastManual = Date.parse(index.lastManualExtractionAt || "");
    const now = Date.parse(this.now());
    const inactivityMs = Math.max(1, Number(inactivityDays) || 30) * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(lastManual) || !Number.isFinite(now) || now - lastManual < inactivityMs) {
      return {
        deleted: 0,
        skipped: true,
        reason: "manual_extraction_recent_or_unknown",
        lastManualExtractionAt: index.lastManualExtractionAt || null
      };
    }

    const cutoff = now - inactivityMs;
    const expired = index.items.filter((item) => {
      if (item.important || item.responsibility !== "manual_consciousness" || item.retentionClass !== "short_term") return false;
      const updatedAt = Date.parse(item.updatedAt || item.createdAt || "");
      return Number.isFinite(updatedAt) && updatedAt <= cutoff;
    });
    if (!expired.length) {
      return {
        deleted: 0,
        skipped: false,
        reason: "nothing_expired",
        lastManualExtractionAt: index.lastManualExtractionAt || null
      };
    }

    for (const item of expired) {
      try { fs.unlinkSync(this.snapshotFile(item.id)); } catch {}
    }
    const expiredIds = new Set(expired.map((item) => item.id));
    index.items = index.items.filter((item) => !expiredIds.has(item.id));
    this.writeIndex(index);
    return {
      deleted: expired.length,
      deletedIds: expired.map((item) => item.id),
      skipped: false,
      lastManualExtractionAt: index.lastManualExtractionAt || null
    };
  }

  autoPrune(scope, sourceId) {
    try {
      const index = this.readIndex();
      const sameSource = index.items.filter(
        (item) => item.scope === scope && item.sourceId === sourceId && !item.important
      );
      if (sameSource.length <= MAX_SNAPSHOTS_PER_SOURCE) {
        if (index.items.length <= MAX_TOTAL_SNAPSHOTS) return;
      }
      const toRemove = [];
      const bySource = {};
      for (const item of index.items) {
        if (item.important) continue;
        const key = `${item.scope}:${item.sourceId}`;
        if (!bySource[key]) bySource[key] = [];
        bySource[key].push(item);
      }
      for (const [key, items] of Object.entries(bySource)) {
        items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        if (items.length > MAX_SNAPSHOTS_PER_SOURCE) {
          toRemove.push(...items.slice(MAX_SNAPSHOTS_PER_SOURCE));
        }
      }
      const keepIds = new Set(toRemove.map((item) => item.id));
      for (const item of toRemove) {
        const file = this.snapshotFile(item.id);
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      }
      index.items = index.items.filter((item) => !keepIds.has(item.id));
      while (index.items.length > MAX_TOTAL_SNAPSHOTS) {
        const oldest = index.items
          .filter((item) => !item.important)
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
        if (!oldest) break;
        const file = this.snapshotFile(oldest.id);
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
        index.items = index.items.filter((item) => item.id !== oldest.id);
      }
      this.writeIndex(index);
    } catch (error) {
      console.warn('[ConsciousCenter] autoPrune failed:', error.message);
    }
  }

  pruneOversizedSnapshots() {
    let cleaned = 0;
    let freedBytes = 0;
    let deleted = 0;
    const files = fs.readdirSync(this.snapshotsRoot).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(this.snapshotsRoot, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_DELETE_SIZE_BYTES) {
          // 超大快照直接删除（超过50MB不可恢复）
          fs.unlinkSync(filePath);
          freedBytes += stat.size;
          deleted++;
          cleaned++;
          continue;
        }
        if (stat.size > MAX_SNAPSHOT_SIZE_BYTES) {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const compact = compactConsciousSnapshot(content);
          if (compact) {
            compact._pruned = true;
            compact._prunedAt = this.now();
            compact._originalSize = stat.size;
            delete compact.workspaceState;
            delete compact.contextReplacement;
            delete compact.sessionMemory;
            delete compact.memoryLayer;
            delete compact.project_state;
            delete compact.agent_state;
            delete compact.task_brain_state;
            delete compact.taskBrainState;
            // 截断所有超长文本字段
            for (const key of Object.keys(compact)) {
              if (typeof compact[key] === 'string' && compact[key].length > 2000) {
                compact[key] = compact[key].slice(0, 2000) + '...[已截断]';
              }
              if (Array.isArray(compact[key])) {
                compact[key] = compact[key].slice(0, 20).map((item) => {
                  if (typeof item === 'string' && item.length > 1000) return item.slice(0, 1000) + '...';
                  if (item && typeof item === 'object') {
                    for (const k of Object.keys(item)) {
                      if (typeof item[k] === 'string' && item[k].length > 1000) item[k] = item[k].slice(0, 1000) + '...';
                    }
                  }
                  return item;
                });
              }
            }
            const compactJson = JSON.stringify(compact, null, 2);
            fs.writeFileSync(filePath, compactJson, 'utf8');
            freedBytes += stat.size - compactJson.length;
            cleaned++;
          }
        }
      } catch {}
    }
    // 更新索引：删除已移除文件的条目
    if (deleted > 0) {
      try {
        const index = this.readIndex();
        const remaining = new Set(fs.readdirSync(this.snapshotsRoot).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
        index.items = index.items.filter((item) => remaining.has(item.id));
        this.writeIndex(index);
      } catch {}
    }
    return { cleaned, deleted, freedBytes };
  }

  removeSources({ projectIds = [], sessionIds = [] } = {}) {
    const projects = new Set((Array.isArray(projectIds) ? projectIds : [projectIds]).map((id) => cleanText(id, 300)).filter(Boolean));
    const sessions = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).map((id) => cleanText(id, 300)).filter(Boolean));
    if (!projects.size && !sessions.size) return { removed: 0, snapshotIds: [] };

    const index = this.readIndex();
    const matches = (item = {}) => {
      const sourceId = cleanText(item.sourceId, 300);
      const projectId = cleanText(item.projectId, 300);
      const sessionId = cleanText(item.sessionId, 300);
      if (item.scope === "project" && (projects.has(sourceId) || projects.has(projectId))) return true;
      if (item.scope === "session" && (sessions.has(sourceId) || sessions.has(sessionId))) return true;
      return item.scope === "session" && projects.has(projectId);
    };
    const removed = index.items.filter(matches);
    if (!removed.length) return { removed: 0, snapshotIds: [] };

    index.items = index.items.filter((item) => !matches(item));
    this.writeIndex(index);
    for (const item of removed) {
      const file = this.snapshotFile(item.id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    return { removed: removed.length, snapshotIds: removed.map((item) => item.id) };
  }

  saveProject(input) {
    return this.persist(this.buildProjectSnapshot(input));
  }

  saveSession(input) {
    return this.persist(this.buildSessionSnapshot(input));
  }

  updateMetadata(id, patch = {}) {
    const snapshot = this.get(id);
    if (!snapshot) throw new Error("意识快照不存在");
    if (patch.important !== undefined) snapshot.important = Boolean(patch.important);
    if (patch.archived !== undefined) snapshot.archived = Boolean(patch.archived);
    snapshot.updatedAt = this.now();
    writeJsonAtomic(this.snapshotFile(id), snapshot);
    const index = this.readIndex();
    const item = index.items.find((entry) => entry.id === id);
    if (item) Object.assign(item, { important: snapshot.important, archived: snapshot.archived, updatedAt: snapshot.updatedAt });
    this.writeIndex(index);
    return clone(snapshot);
  }
}

module.exports = {
  ConsciousCenter,
  summarizeMessages,
  collectKeywords,
  applyWorkStateContract,
  compactConsciousSnapshot,
  stripCognitiveSnapshotFields,
  sanitizeWorkspaceProject,
  sanitizeWorkspaceSession
};
