"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createInterruptedCheckpoint, isInterruptedCheckpoint } = require("./interrupted-session-recovery");
const { repairPolicy } = require("./self-healing/repair-policy");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!["EPERM", "EEXIST", "EBUSY"].includes(error?.code)) throw error;
    try {
      fs.copyFileSync(temp, file);
      fs.rmSync(temp, { force: true });
    } catch (fallbackError) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw new Error(`无法安全写入 ${pathLabel(file)}：${fallbackError?.message || fallbackError}`);
    }
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { exists: true, value: JSON.parse(raw), fingerprint: fingerprint(raw), error: "" };
  } catch (error) {
    return { exists: fs.existsSync(file), value: null, fingerprint: "", error: error?.message || String(error) };
  }
}

function fingerprint(raw) {
  return createHash("sha256").update(String(raw || ""), "utf8").digest("hex");
}

async function readJsonAsync(file) {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return { exists: true, value: JSON.parse(raw), fingerprint: fingerprint(raw), error: "" };
  } catch (error) {
    return { exists: fs.existsSync(file), value: null, fingerprint: "", error: error?.message || String(error) };
  }
}

function safePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function pathLabel(file) {
  return safePath(file).split("/").slice(-3).join("/");
}

function validExecutionMetadata(task) {
  return Boolean(task?.execution_metadata && isObject(task.execution_metadata) && text(task.execution_metadata.decisionId, 200));
}

function projectSessionIds(db, project) {
  const ids = new Set(Array.isArray(project?.sessions) ? project.sessions.filter(Boolean) : []);
  for (const session of db.sessions || []) {
    if (session.projectId === project?.id) ids.add(session.id);
  }
  return ids;
}

function canonicalCeo(db, project) {
  const ids = projectSessionIds(db, project);
  return (db.sessions || [])
    .filter((session) => ids.has(session.id) && session.projectId === project.id && session.type === "CEO")
    .sort((a, b) => String(a.createdAt || a.createdTime || a.id).localeCompare(String(b.createdAt || b.createdTime || b.id)))[0] || null;
}

function issue({ category, label, entityId, detail, fixable = false, confirmationRequired = false, patches = [], proposed = "", before = undefined }) {
  return {
    id: `${category}:${entityId}:${randomUUID().slice(0, 8)}`,
    category,
    label,
    entityId: text(entityId, 240),
    detail: text(detail, 900),
    fixable: Boolean(fixable),
    confirmationRequired: Boolean(confirmationRequired),
    patches,
    proposed: proposed ? text(proposed, 900) : "",
    before: before === undefined ? undefined : clone(before)
  };
}

function patch(target, pathParts, value, description = "") {
  return { target, path: pathParts, value: clone(value), description: text(description, 500) };
}

function removePatch(target, pathParts, description = "") {
  return { target, path: pathParts, op: "remove", description: text(description, 500) };
}

function getAt(root, parts) {
  return parts.reduce((current, part) => current?.[part], root);
}

function setAt(root, parts, value) {
  if (!parts.length) return value;
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (current[parts[index]] === undefined) current[parts[index]] = {};
    current = current[parts[index]];
  }
  current[parts.at(-1)] = clone(value);
  return root;
}

function valueLabel(value) {
  if (value === undefined) return "<不存在>";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  try {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return String(value);
  }
}

function collectDiff(before, after, prefix = "", result = [], limit = 160) {
  if (result.length >= limit) return result;
  if (JSON.stringify(before) === JSON.stringify(after)) return result;
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) collectDiff(before[key], after[key], prefix ? `${prefix}.${key}` : key, result, limit);
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectDiff(before[index], after[index], `${prefix}[${index}]`, result, limit);
      if (result.length >= limit) break;
    }
    return result;
  }
  result.push({ path: prefix || "$", before: clone(before), after: clone(after), beforeText: valueLabel(before), afterText: valueLabel(after) });
  return result;
}

class BlackBallRepairManager {
  constructor({ dbFile, tasksFile, consciousRoot, intentMonitor = null, clock = () => new Date() } = {}) {
    if (!dbFile || !tasksFile || !consciousRoot) throw new Error("BlackBallRepairManager requires data paths");
    this.dbFile = dbFile;
    this.tasksFile = tasksFile;
    this.consciousRoot = consciousRoot;
    this.indexFile = path.join(consciousRoot, "index.json");
    this.snapshotsRoot = path.join(consciousRoot, "snapshots");
    this.intentMonitor = intentMonitor;
    this.clock = clock;
    this.pending = new Map();
  }

  now() { return this.clock().toISOString(); }

  progress(onProgress, state) {
    if (typeof onProgress !== "function") return;
    try { onProgress(state); } catch {}
  }

  readDocuments() {
    const db = readJson(this.dbFile);
    const tasks = readJson(this.tasksFile);
    const index = readJson(this.indexFile);
    const snapshots = new Map();
    for (const item of index.value?.items || []) {
      if (!item?.id) continue;
      const file = path.join(this.snapshotsRoot, `${encodeURIComponent(item.id)}.json`);
      snapshots.set(item.id, { file, ...readJson(file) });
    }
    return { db, tasks, index, snapshots };
  }

  async readDocumentsAsync() {
    const [db, tasks, index] = await Promise.all([
      readJsonAsync(this.dbFile),
      readJsonAsync(this.tasksFile),
      readJsonAsync(this.indexFile)
    ]);
    const snapshots = new Map();
    const items = Array.isArray(index.value?.items) ? index.value.items : [];
    const entries = await Promise.all(items.filter((item) => item?.id).map(async (item) => {
      const file = path.join(this.snapshotsRoot, `${encodeURIComponent(item.id)}.json`);
      return [item.id, { file, ...(await readJsonAsync(file)) }];
    }));
    for (const [id, document] of entries) snapshots.set(id, document);
    return { db, tasks, index, snapshots };
  }

  filesFingerprint(documents) {
    const files = [documents.db, documents.tasks, documents.index, ...documents.snapshots.values()];
    return files.map((item) => `${item.file || ""}:${item.fingerprint || ""}`).join("|");
  }

  scan({ onProgress = null } = {}) {
    return this.scanDocuments(this.readDocuments(), { onProgress });
  }

  async scanAsync({ onProgress = null } = {}) {
    this.progress(onProgress, { status: "detecting", progress: 0, stepIndex: 0, totalSteps: 5, step: "start", stepLabel: "开始检测", detail: "准备异步读取任务、项目和意识快照数据" });
    const documents = await this.readDocumentsAsync();
    let skippedDuplicateStart = false;
    return this.scanDocuments(documents, {
      onProgress: (state) => {
        if (!skippedDuplicateStart && state?.progress === 0) {
          skippedDuplicateStart = true;
          return;
        }
        this.progress(onProgress, state);
      }
    });
  }

  scanDocuments(documents, { onProgress = null } = {}) {
    this.progress(onProgress, { status: "detecting", progress: 0, stepIndex: 0, totalSteps: 5, step: "start", stepLabel: "开始检测", detail: "准备读取任务、项目和意识快照数据" });
    const categories = new Map();
    const add = (item) => {
      if (!categories.has(item.category)) categories.set(item.category, []);
      categories.get(item.category).push(item);
    };
    const db = isObject(documents.db.value) ? documents.db.value : { sessions: [], projects: [] };
    const taskStore = isObject(documents.tasks.value) ? documents.tasks.value : { tasks: [] };
    const sessions = Array.isArray(db.sessions) ? db.sessions : [];
    const projects = Array.isArray(db.projects) ? db.projects : [];
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const projectById = new Map(projects.map((project) => [project.id, project]));

    this.progress(onProgress, { status: "detecting", progress: 20, stepIndex: 1, totalSteps: 5, step: "tasks", stepLabel: "扫描历史任务", detail: "检查 tasks.json 中的执行元数据" });

    if ((documents.tasks.exists && documents.tasks.error) || !Array.isArray(taskStore.tasks)) {
      add(issue({ category: "unreadable-data", label: "Task Brain 数据文件", entityId: "tasks.json", detail: `tasks.json 无法读取：${documents.tasks.error || "tasks 不是数组"}`, confirmationRequired: true }));
    } else {
      taskStore.tasks.forEach((task, index) => {
        if (task?.status === "cancelled") return;
        if (validExecutionMetadata(task)) return;
        const rebuilt = {
          decisionId: text(task?.decision_id || task?.task_id || `task-${index}`, 200),
          classification: text(task?.classification || "development_task", 100),
          responseMode: text(task?.response_mode || "execute", 100),
          permissions: isObject(task?.permissions) ? clone(task.permissions) : {
            allowTaskCreation: true,
            allowAgent: true,
            allowTools: true,
            allowVerifier: true,
            allowFileWrite: true
          },
          routing: text(task?.route || "task_brain", 100)
        };
        const changes = [
          patch("tasks", ["tasks", index, "execution_metadata"], rebuilt, "从任务自身字段补齐执行元数据"),
          removePatch("tasks", ["tasks", index, "uug"], "删除旧门禁字段")
        ];
        add(issue({
          category: "task-execution-metadata",
          label: "Task Brain 缺少执行元数据",
          entityId: task?.task_id || `tasks[${index}]`,
          detail: `任务 ${task?.task_id || index} 缺少执行元数据，可从当前任务字段直接补齐。`,
          fixable: true,
          confirmationRequired: false,
          patches: changes,
          proposed: `execution_metadata.decisionId = ${rebuilt.decisionId}`,
          before: task?.execution_metadata || task?.uug
        }));
      });
    }

    if (documents.db.error || !isObject(documents.db.value)) {
      add(issue({ category: "unreadable-data", label: "主数据库", entityId: "heiqiu-db.json", detail: `主数据库无法读取：${documents.db.error || "JSON 根节点不是对象"}`, confirmationRequired: true }));
    } else {
      this.progress(onProgress, { status: "detecting", progress: 40, stepIndex: 2, totalSteps: 5, step: "project-tree", stepLabel: "检查项目结构", detail: "核对项目、黑球和内部执行会话的归属关系" });
      const seen = new Set();
      const addTreeIssue = (item) => {
        const key = `${item.category}:${item.entityId}:${item.patches.map((entry) => `${entry.target}:${entry.path.join(".")}`).join("|")}`;
        if (seen.has(key)) return;
        seen.add(key);
        add(item);
      };
      for (const project of projects) {
        const projectIndex = projects.indexOf(project);
        const ids = projectSessionIds(db, project);
        const ceo = canonicalCeo(db, project);
        const listed = Array.isArray(project.sessions) ? project.sessions : [];
        const cleanListed = listed.filter((id) => sessionById.has(id));
        if (cleanListed.length !== listed.length) {
          addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: project.id, detail: `项目 ${project.name} 的 sessions 列表包含不存在的会话引用。`, fixable: true, patches: [patch("db", ["projects", projectIndex, "sessions"], cleanListed, "移除不存在的会话引用")], proposed: `sessions: ${listed.length} -> ${cleanListed.length}` }));
        }
        for (const sessionId of ids) {
          const session = sessionById.get(sessionId);
          if (!session) continue;
          const sessionIndex = sessions.indexOf(session);
          if (session.projectId !== project.id) {
            const belongsElsewhere = session.projectId && projectById.has(session.projectId) && session.projectId !== project.id;
            addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: belongsElsewhere ? `会话同时被项目 ${project.name} 引用，但自身归属为另一个项目，不能自动猜测归属。` : `会话已被项目 ${project.name} 引用，但缺少正确 projectId。`, fixable: !belongsElsewhere, confirmationRequired: belongsElsewhere, patches: belongsElsewhere ? [] : [patch("db", ["sessions", sessionIndex, "projectId"], project.id, "按项目 sessions 关联补齐 projectId")], proposed: belongsElsewhere ? "需要用户确认项目归属" : `projectId = ${project.id}` }));
          }
          if (session.type === "CEO" && session.parentSessionId) {
            addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: `黑球会话 ${session.id} 不应再挂在其他会话下。`, fixable: true, patches: [patch("db", ["sessions", sessionIndex, "parentSessionId"], "", "黑球置于项目根层")], proposed: "parentSessionId = 空" }));
          }
          if (session.type === "Agent" && ceo && session.parentSessionId !== ceo.id) {
            addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: `内部执行会话 ${session.id} 的父级不是本项目黑球，当前项目应保持扁平层级。`, fixable: true, patches: [patch("db", ["sessions", sessionIndex, "parentSessionId"], ceo.id, "挂回本项目黑球")], proposed: `parentSessionId = ${ceo.id}` }));
          }
          if (session.type === "CEO" && ceo && session.id !== ceo.id) {
            addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: `项目 ${project.name} 出现多个黑球工作会话，非主会话将按既有迁移规则转为内部执行会话。`, fixable: true, patches: [
              patch("db", ["sessions", sessionIndex, "type"], "Agent", "保留项目唯一主黑球会话"),
              patch("db", ["sessions", sessionIndex, "parentSessionId"], ceo.id, "挂到主黑球会话下"),
              patch("db", ["sessions", sessionIndex, "role"], session.role || "执行人员", "保留现有角色或补齐执行角色")
            ], proposed: `type = Agent; parentSessionId = ${ceo.id}` }));
          }
        }
        for (const session of sessions.filter((item) => item.projectId === project.id)) {
          if (listed.includes(session.id)) continue;
          addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: `会话 ${session.id} 有 projectId，但未列入项目 sessions，项目树会漏显示。`, fixable: true, patches: [patch("db", ["projects", projectIndex, "sessions"], [...listed, session.id], "补齐项目 sessions 关联")], proposed: `sessions 追加 ${session.id}` }));
        }
      }
      for (const session of sessions) {
        if (!session.parentSessionId) continue;
        const parent = sessionById.get(session.parentSessionId);
        const parentProject = parent?.projectId || "";
        if (!parent || parent.type !== "CEO" || parentProject !== session.projectId) {
          const project = projectById.get(session.projectId);
          const ceo = project ? canonicalCeo(db, project) : null;
          const sessionIndex = sessions.indexOf(session);
          addTreeIssue(issue({ category: "project-tree", label: "项目树层级与归属", entityId: session.id, detail: `会话 ${session.id} 指向了不属于本项目的父级，会造成内部执行会话挂到其他项目下。`, fixable: Boolean(ceo), confirmationRequired: !ceo, patches: ceo ? [patch("db", ["sessions", sessionIndex, "parentSessionId"], ceo.id, "按本项目重建父级黑球会话")] : [], proposed: ceo ? `parentSessionId = ${ceo.id}` : "缺少可确认的本项目黑球会话" }));
        }
      }
    }

    this.scanInterruptedSessions({ db, sessions, add });
    this.progress(onProgress, { status: "detecting", progress: 60, stepIndex: 3, totalSteps: 5, step: "snapshots", stepLabel: "分析意识快照", detail: "核对 snapshot 的 sourceId、sessionId、projectId 和工作区成员" });
    this.scanSnapshots({ documents, db, sessionById, projectById, add });
    this.progress(onProgress, { status: "detecting", progress: 80, stepIndex: 4, totalSteps: 5, step: "intent-prediction", stepLabel: "审计意图预测", detail: "读取真实预测日志，检查模型回退、重复提问、轮次和会话状态" });
    this.scanIntentPrediction({ sessions, add });
    const grouped = [...categories.entries()].map(([id, findings]) => ({
      id,
      label: findings[0]?.label || id,
      count: findings.length,
      fixableCount: findings.filter((item) => item.fixable).length,
      confirmationRequiredCount: findings.filter((item) => item.confirmationRequired).length,
      findings: findings.map(({ patches: _patches, ...item }) => item)
    }));
    const allFindings = [...categories.values()].flat();
    const report = {
      schemaVersion: 1,
      scanId: `black-ball-${randomUUID()}`,
      generatedAt: this.now(),
      summary: {
        totalIssues: allFindings.length,
        fixableIssues: allFindings.filter((item) => item.fixable).length,
        confirmationRequired: allFindings.filter((item) => item.confirmationRequired).length,
        categoryCount: grouped.length
      },
      categories: grouped,
      sourceFiles: {
        db: pathLabel(this.dbFile),
        tasks: pathLabel(this.tasksFile),
        conscious: pathLabel(this.consciousRoot),
        intentPrediction: this.intentMonitor?.file ? pathLabel(this.intentMonitor.file) : ""
      },
      hasRepairableChanges: allFindings.some((item) => item.fixable),
      hasConfirmationOnly: allFindings.some((item) => item.confirmationRequired && !item.fixable),
      repairPolicy: repairPolicy(),
      status: allFindings.length ? "issues_found" : "clean"
    };
    this.pending.set(report.scanId, { report, findings: allFindings, fingerprint: this.filesFingerprint(documents) });
    while (this.pending.size > 5) this.pending.delete(this.pending.keys().next().value);
    this.progress(onProgress, { status: "completed", completed: true, progress: 100, stepIndex: 5, totalSteps: 5, step: "completed", stepLabel: "检测完成", detail: `发现 ${report.summary.totalIssues} 项已知问题，${report.summary.fixableIssues} 项存在确定性处理计划` });
    return report;
  }

  scanInterruptedSessions({ db, sessions, add }) {
    const messages = isObject(db.messages) ? db.messages : {};
    for (const session of sessions) {
      if (!session?.id || String(session.status || "").toLowerCase() !== "aborted") continue;
      const sessionIndex = sessions.indexOf(session);
      const patches = [];
      const staleRuntime = Boolean(session.hermesSessionId || session.lastRunId);
      if (staleRuntime) {
        if (session.hermesSessionId) patches.push(patch("db", ["sessions", sessionIndex, "hermesSessionId"], null, "清除已中断的 Hermes 会话引用"));
        if (session.lastRunId) patches.push(patch("db", ["sessions", sessionIndex, "lastRunId"], null, "清除已中断的运行 ID"));
      }
      const checkpoint = session.interruptedCheckpoint;
      let rebuilt = null;
      if (!isInterruptedCheckpoint(checkpoint)) {
        rebuilt = createInterruptedCheckpoint({ session, messages: messages[session.id] || [] });
        if (rebuilt) patches.push(patch("db", ["sessions", sessionIndex, "interruptedCheckpoint"], rebuilt, "按本地会话记录重建中断恢复点"));
      }
      if (!patches.length) continue;
      add(issue({
        category: "session-recovery",
        label: "中断会话恢复状态",
        entityId: session.id,
        detail: staleRuntime
          ? `会话 ${session.id} 已中断，但仍保留 Hermes 运行引用，继续操作可能复用失效会话。`
          : `会话 ${session.id} 缺少有效的中断恢复点，已按现有本地记录检查可重建内容。`,
        fixable: true,
        patches,
        proposed: rebuilt ? "清理失效运行引用并重建本地恢复点" : "清理失效运行引用"
      }));
    }
  }

  scanIntentPrediction({ sessions, add }) {
    if (!this.intentMonitor?.scan) return;
    let audit;
    try {
      audit = this.intentMonitor.scan({ sessions });
    } catch (error) {
      add(issue({
        category: "intent-prediction",
        label: "意图预测审计",
        entityId: "audit-log",
        detail: `意图预测审计日志无法读取：${error?.message || error}`
      }));
      return;
    }
    for (const group of audit.anomalyGroups || []) {
      add(issue({
        category: "intent-prediction",
        label: "意图预测审计",
        entityId: group.reason,
        detail: `${group.label}。审计日志中共发生 ${group.count} 次，涉及 ${group.sessions.length} 个会话，最近时间 ${group.latestAt || "未知"}。`,
        proposed: "已由本地规则拦截并回退；日志用于定位模型提示词、接口或预测规则问题。",
        before: group.samples
      }));
    }
    if (Number(audit.malformedLines || 0) > 0) {
      add(issue({
        category: "intent-prediction",
        label: "意图预测审计",
        entityId: "malformed-audit-lines",
        detail: `意图预测日志中发现 ${audit.malformedLines} 行无法解析，可能存在异常中断或外部写入。`
      }));
    }
    for (const stateIssue of audit.stateIssues || []) {
      const sessionIndex = sessions.findIndex((session) => session.id === stateIssue.sessionId);
      add(issue({
        category: "intent-prediction",
        label: "意图预测审计",
        entityId: stateIssue.sessionId,
        detail: `会话 ${stateIssue.sessionName || stateIssue.sessionId} 的预测状态损坏：${stateIssue.reasons.join("；")}。`,
        fixable: sessionIndex >= 0,
        patches: sessionIndex >= 0
          ? [removePatch("db", ["sessions", sessionIndex, "clarificationState"], "清除损坏的意图预测状态，下次输入重新建立")]
          : [],
        proposed: sessionIndex >= 0 ? "清除损坏状态并在下一次输入时重新预测" : "会话不存在，无法处理"
      }));
    }
  }

  scanSnapshots({ documents, db, sessionById, projectById, add }) {
    if (!documents.index.exists) return;
    if (documents.index.error || !isObject(documents.index.value) || !Array.isArray(documents.index.value.items)) {
      add(issue({ category: "unreadable-data", label: "意识快照索引", entityId: "index.json", detail: `意识快照索引无法读取：${documents.index.error || "items 不是数组"}`, confirmationRequired: true }));
      return;
    }
    documents.index.value.items.forEach((item, index) => {
      const snapshotDoc = documents.snapshots.get(item.id);
      if (!snapshotDoc?.exists || snapshotDoc.error || !isObject(snapshotDoc.value)) {
        add(issue({ category: "conscious-cross-scope", label: "意识快照跨会话/跨项目数据", entityId: item.id, detail: `索引项 ${item.id} 对应的快照文件缺失或无法读取，不能自动猜测内容。`, confirmationRequired: true }));
        return;
      }
      const snapshot = snapshotDoc.value;
      const scope = snapshot.scope || item.scope;
      const sourceId = snapshot.sourceId || snapshot.sessionId || item.sourceId || item.sessionId;
      const entity = scope === "project" ? projectById.get(sourceId) || projectById.get(snapshot.projectId || item.projectId) : sessionById.get(sourceId) || sessionById.get(snapshot.sessionId || item.sessionId);
      if (!entity) {
        add(issue({
          category: "conscious-cross-scope",
          label: "意识快照跨会话/跨项目数据",
          entityId: item.id,
          detail: `快照 ${item.id} 找不到已存在的 ${scope === "project" ? "项目" : "会话"}，确认后将从意识索引和 snapshots 目录一并清理。`,
          fixable: true,
          patches: [
            removePatch("index", ["items", index], "移除已不存在实体对应的意识索引记录"),
            removePatch("snapshot-file", [item.id], "删除已不存在实体对应的意识快照文件")
          ],
          proposed: "删除孤儿快照索引记录和 JSON 文件"
        }));
        return;
      }
      const targetId = entity.id;
      const targetProjectId = scope === "project" ? targetId : entity.projectId || "";
      const targetSnapshotPath = ["snapshots", item.id];
      const patches = [];
      const indexPatches = [];
      if (snapshot.sourceId !== targetId) patches.push(patch("snapshot", [...targetSnapshotPath, "sourceId"], targetId, "按可确认的关联实体修正 sourceId"));
      if (scope === "session" && snapshot.sessionId !== targetId) patches.push(patch("snapshot", [...targetSnapshotPath, "sessionId"], targetId, "按可确认的会话修正 sessionId"));
      if (scope === "session" && snapshot.projectId !== targetProjectId) patches.push(patch("snapshot", [...targetSnapshotPath, "projectId"], targetProjectId, "按会话真实 projectId 修正快照归属"));
      if (scope === "project" && snapshot.projectId !== targetProjectId) patches.push(patch("snapshot", [...targetSnapshotPath, "projectId"], targetProjectId, "按项目真实 id 修正快照归属"));
      if (item.sourceId !== targetId) indexPatches.push(patch("index", ["items", index, "sourceId"], targetId, "同步索引 sourceId"));
      if (scope === "session" && item.sessionId !== targetId) indexPatches.push(patch("index", ["items", index, "sessionId"], targetId, "同步索引 sessionId"));
      if (item.projectId !== targetProjectId) indexPatches.push(patch("index", ["items", index, "projectId"], targetProjectId, "同步索引 projectId"));
      const workspaceSessions = Array.isArray(snapshot.workspaceState?.sessions) ? snapshot.workspaceState.sessions : [];
      const expectedIds = scope === "project" ? projectSessionIds(db, entity) : new Set([targetId]);
      const keptSessions = workspaceSessions.filter((session) => expectedIds.has(session?.id) && (scope !== "project" || !session.projectId || session.projectId === targetProjectId));
      if (workspaceSessions.length !== keptSessions.length) {
        patches.push(patch("snapshot", [...targetSnapshotPath, "workspaceState", "sessions"], keptSessions, "移除快照中属于其他会话或项目的工作区成员"));
      }
      const agentStates = Array.isArray(snapshot.agentStates) ? snapshot.agentStates : [];
      const keptAgentStates = agentStates.filter((state) => expectedIds.has(state?.sessionId));
      if (agentStates.length !== keptAgentStates.length) patches.push(patch("snapshot", [...targetSnapshotPath, "agentStates"], keptAgentStates, "移除快照中属于其他会话或项目的内部执行状态"));
      if (patches.length || indexPatches.length) {
        add(issue({ category: "conscious-cross-scope", label: "意识快照跨会话/跨项目数据", entityId: item.id, detail: `快照 ${item.id} 的归属字段或工作区成员与当前 ${scope === "project" ? "项目" : "会话"} 不一致。`, fixable: true, patches: [...patches, ...indexPatches], proposed: `${patches.length + indexPatches.length} 个字段按当前实体关联修正` }));
      }
    });
  }

  repair(scanId, { onProgress = null } = {}) {
    this.progress(onProgress, { status: "repairing", progress: 0, stepIndex: 0, totalSteps: 3, step: "repair-start", stepLabel: "准备修复", detail: "重新读取并校验检测结果是否仍然有效" });
    const pending = this.pending.get(scanId);
    if (!pending) throw new Error("检测结果已过期，请重新检测");
    const current = this.readDocuments();
    if (this.filesFingerprint(current) !== pending.fingerprint) {
      return { ok: false, conflict: true, message: "检测后数据已发生变化，请重新检测后再确认修复。", scan: this.scan({ onProgress }) };
    }
    const allPatches = pending.findings.filter((finding) => finding.fixable).flatMap((finding) => finding.patches || []);
    const plannedTargets = new Set(allPatches.map((entry) => entry.target === "snapshot" ? `snapshot:${entry.path[1]}` : entry.target === "snapshot-file" ? `snapshot-file:${entry.path[0]}` : entry.target));
    const before = {
      db: plannedTargets.has("db") ? clone(current.db.value) : undefined,
      tasks: plannedTargets.has("tasks") ? clone(current.tasks.value) : undefined,
      index: plannedTargets.has("index") ? clone(current.index.value) : undefined,
      snapshots: new Map([...current.snapshots.entries()]
        .filter(([id]) => plannedTargets.has(`snapshot:${id}`) || plannedTargets.has(`snapshot-file:${id}`))
        .map(([id, doc]) => [id, clone(doc.value)]))
    };
    const changedTargets = new Set();
    const deletedSnapshotFiles = new Set();
    this.progress(onProgress, { status: "repairing", progress: 33, stepIndex: 1, totalSteps: 3, step: "repair-write", stepLabel: "按规则写入修复", detail: "只执行检测报告中列出的确定性字段补丁" });
    for (const entry of allPatches) {
      if (entry.target === "snapshot-file") {
        const file = path.join(this.snapshotsRoot, `${encodeURIComponent(entry.path[0])}.json`);
        if (fs.existsSync(file)) {
          deletedSnapshotFiles.add(file);
          changedTargets.add(`snapshot-file:${entry.path[0]}`);
        }
        continue;
      }
      const document = entry.target === "db" ? current.db.value : entry.target === "tasks" ? current.tasks.value : entry.target === "index" ? current.index.value : current.snapshots.get(entry.path[1])?.value;
      if (!document) continue;
      const actualPath = entry.target === "snapshot" ? entry.path.slice(2) : entry.path;
      if (entry.op === "remove") {
        const parent = getAt(document, actualPath.slice(0, -1));
        const key = actualPath.at(-1);
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else if (parent && Object.prototype.hasOwnProperty.call(parent, key)) delete parent[key];
        else continue;
      } else {
        if (JSON.stringify(getAt(document, actualPath)) === JSON.stringify(entry.value)) continue;
        setAt(document, actualPath, entry.value);
      }
      changedTargets.add(entry.target === "snapshot" ? `snapshot:${entry.path[1]}` : entry.target);
    }
    if (changedTargets.has("db")) atomicWrite(this.dbFile, current.db.value);
    if (changedTargets.has("tasks")) atomicWrite(this.tasksFile, current.tasks.value);
    if (changedTargets.has("index")) atomicWrite(this.indexFile, current.index.value);
    for (const target of changedTargets) {
      if (!target.startsWith("snapshot:")) continue;
      const id = target.slice("snapshot:".length);
      const doc = current.snapshots.get(id);
      if (doc?.value) atomicWrite(doc.file, doc.value);
    }
    for (const file of deletedSnapshotFiles) fs.rmSync(file, { force: true });
    this.progress(onProgress, { status: "repairing", progress: 66, stepIndex: 2, totalSteps: 3, step: "repair-read", stepLabel: "重新读取修复结果", detail: "重新读取已修改文件，生成真实字段 diff" });
    const after = this.readDocuments();
    const diffs = [];
    if (changedTargets.has("db")) diffs.push(...collectDiff(before.db, after.db.value).map((item) => ({ file: pathLabel(this.dbFile), ...item })));
    if (changedTargets.has("tasks")) diffs.push(...collectDiff(before.tasks, after.tasks.value).map((item) => ({ file: pathLabel(this.tasksFile), ...item })));
    if (changedTargets.has("index")) diffs.push(...collectDiff(before.index, after.index.value).map((item) => ({ file: pathLabel(this.indexFile), ...item })));
    for (const [id, oldValue] of before.snapshots.entries()) {
      if (changedTargets.has(`snapshot:${id}`)) {
        const doc = after.snapshots.get(id);
        diffs.push(...collectDiff(oldValue, doc?.value).map((item) => ({ file: pathLabel(doc?.file || id), ...item })));
      }
      if (changedTargets.has(`snapshot-file:${id}`)) {
        diffs.push(...collectDiff(oldValue, undefined).map((item) => ({ file: pathLabel(path.join(this.snapshotsRoot, `${encodeURIComponent(id)}.json`)), ...item })));
      }
    }
    const verified = this.scanDocuments(after);
    this.pending.delete(scanId);
    this.progress(onProgress, { status: "completed", completed: true, progress: 100, stepIndex: 3, totalSteps: 3, step: "repair-completed", stepLabel: "修复完成并已复核", detail: `重新读取后剩余 ${verified.summary.totalIssues} 项已知问题` });
    return {
      ok: true,
      completedAt: this.now(),
      changedFiles: [...changedTargets],
      changedCount: diffs.length,
      diffs,
      verification: {
        remainingIssues: verified.summary.totalIssues,
        remainingFixable: verified.summary.fixableIssues,
        remainingConfirmationRequired: verified.summary.confirmationRequired,
        categories: verified.categories
      }
    };
  }
}

module.exports = { BlackBallRepairManager, collectDiff, validExecutionMetadata };
