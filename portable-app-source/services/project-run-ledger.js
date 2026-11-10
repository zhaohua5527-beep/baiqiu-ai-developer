"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const RUN_STATUSES = new Set(["created", "dispatched", "running", "completed", "failed", "cancelled"]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value, limit = 4000) {
  return String(value || "").trim().slice(0, limit);
}

class ProjectRunLedger {
  constructor({ root, file, clock = () => new Date(), idFactory = () => `project-run-${randomUUID()}` } = {}) {
    if (!root && !file) throw new Error("ProjectRunLedger requires a storage root or file.");
    this.file = path.resolve(file || path.join(root, "project-runs.json"));
    this.clock = clock;
    this.idFactory = idFactory;
    this.store = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        version: 1,
        updatedAt: parsed.updatedAt || "",
        runs: Array.isArray(parsed.runs) ? parsed.runs : []
      };
    } catch {
      return { version: 1, updatedAt: "", runs: [] };
    }
  }

  save() {
    const now = this.clock().toISOString();
    this.store.updatedAt = now;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(this.store, null, 2), "utf8");
    fs.renameSync(temp, this.file);
    return this.store;
  }

  begin({ runId = "", projectId, ceoSessionId, taskId = "", goal = "", assignments = [] } = {}) {
    const normalized = (Array.isArray(assignments) ? assignments : []).map((assignment, index) => ({
      assignmentId: text(assignment.assignmentId || assignment.assignment_id || `assignment-${index + 1}`, 240),
      roleSessionId: text(assignment.roleSessionId || assignment.agent_id, 240),
      roleName: text(assignment.roleName || assignment.name || `员工 ${index + 1}`, 240),
      goal: text(assignment.goal || assignment.action, 12000),
      scope: text(assignment.scope || assignment.goal || assignment.action, 4000),
      deliverable: text(assignment.deliverable || "返回本员工负责范围的完整结果", 2000),
      inputFiles: (Array.isArray(assignment.inputFiles) ? assignment.inputFiles : []).map((file) => ({
        name: text(file?.name, 240),
        path: text(file?.path || file?.sourcePath, 4000),
        mimeType: text(file?.mimeType, 160),
        sizeBytes: Number(file?.sizeBytes || 0)
      })).filter((file) => file.name && file.path),
      workingDirectory: text(assignment.workingDirectory, 4000),
      acceptance: (Array.isArray(assignment.acceptance) ? assignment.acceptance : []).map((item) => text(item, 500)).filter(Boolean).slice(0, 12),
      maxToolCalls: Math.max(1, Math.min(30, Number(assignment.maxToolCalls || 8))),
      taskIndex: index,
      status: "created",
      result: "",
      error: "",
      evidence: null,
      startedAt: "",
      completedAt: ""
    }));
    if (!text(projectId, 240) || !text(ceoSessionId, 240)) throw new Error("Project run requires projectId and ceoSessionId.");
    if (!normalized.length) throw new Error("Project run requires at least one assignment.");
    if (normalized.some((item) => !item.assignmentId || !item.roleSessionId || !item.goal)) {
      throw new Error("Every project assignment requires assignmentId, roleSessionId and goal.");
    }
    if (new Set(normalized.map((item) => item.assignmentId)).size !== normalized.length) throw new Error("Project assignment ids must be unique.");
    if (new Set(normalized.map((item) => item.roleSessionId)).size !== normalized.length) throw new Error("A project role cannot receive two assignments in the same run.");

    const id = text(runId, 240) || this.idFactory();
    if (this.store.runs.some((item) => item.runId === id)) throw new Error(`Project run already exists: ${id}`);
    const now = this.clock().toISOString();
    const run = {
      runId: id,
      projectId: text(projectId, 240),
      ceoSessionId: text(ceoSessionId, 240),
      taskId: text(taskId, 240),
      goal: text(goal, 12000),
      status: "created",
      hermesParentSessionId: "",
      delegationId: "",
      error: "",
      assignments: normalized,
      createdAt: now,
      updatedAt: now,
      completedAt: ""
    };
    this.store.runs.push(run);
    this.save();
    return clone(run);
  }

  get(runId = "") {
    return clone(this.store.runs.find((item) => item.runId === runId) || null);
  }

  list({ projectId = "", ceoSessionId = "", limit = 100 } = {}) {
    return this.store.runs
      .filter((run) => !projectId || run.projectId === projectId)
      .filter((run) => !ceoSessionId || run.ceoSessionId === ceoSessionId)
      .slice(-Math.max(1, Number(limit) || 100))
      .reverse()
      .map(clone);
  }

  markStarted(runId) {
    const run = this.require(runId);
    const now = this.clock().toISOString();
    run.status = "running";
    run.updatedAt = now;
    run.assignments.forEach((assignment) => {
      assignment.status = "running";
      assignment.startedAt ||= now;
    });
    this.save();
    return clone(run);
  }

  markDispatched(runId, { hermesParentSessionId, delegationId, bindings = [] } = {}) {
    const run = this.require(runId);
    if (!delegationId) throw new Error("A dispatched project run requires delegationId.");
    const byAssignment = new Map(bindings.map((item) => [item.assignmentId, item]));
    const now = this.clock().toISOString();
    run.status = "running";
    run.hermesParentSessionId = text(hermesParentSessionId, 240);
    run.delegationId = text(delegationId, 240);
    run.updatedAt = now;
    run.assignments.forEach((assignment, index) => {
      const binding = byAssignment.get(assignment.assignmentId) || {};
      assignment.taskIndex = Number.isInteger(binding.taskIndex) ? binding.taskIndex : index;
      assignment.status = "running";
      assignment.startedAt ||= now;
      assignment.evidence = {
        delegationId: run.delegationId,
        hermesParentSessionId: run.hermesParentSessionId,
        taskIndex: assignment.taskIndex
      };
    });
    this.save();
    return clone(run);
  }

  finish(runId, results = []) {
    const run = this.require(runId);
    const byAssignment = new Map((Array.isArray(results) ? results : []).map((item) => [item.assignmentId, item]));
    const now = this.clock().toISOString();
    run.assignments.forEach((assignment) => {
      const result = byAssignment.get(assignment.assignmentId);
      const completed = result?.status === "completed" && Boolean(text(result.summary, 200000));
      assignment.status = completed ? "completed" : "failed";
      assignment.result = text(result?.summary, 200000);
      assignment.error = completed ? "" : text(result?.error || "Hermes Worker did not return a complete result.", 4000);
      assignment.completedAt = now;
      assignment.evidence = { ...(assignment.evidence || {}), ...(clone(result?.evidence) || {}) };
    });
    const complete = run.assignments.every((item) => item.status === "completed");
    run.status = complete ? "completed" : "failed";
    run.error = complete ? "" : run.assignments.filter((item) => item.status === "failed").map((item) => `${item.roleName}: ${item.error}`).join("; ");
    run.completedAt = now;
    run.updatedAt = now;
    this.save();
    return clone(run);
  }

  fail(runId, error = "Project run failed.", partialResults = []) {
    const run = this.require(runId);
    const byAssignment = new Map((Array.isArray(partialResults) ? partialResults : []).map((item) => [item.assignmentId, item]));
    const now = this.clock().toISOString();
    run.status = "failed";
    run.error = text(error, 4000);
    run.completedAt = now;
    run.updatedAt = now;
    run.assignments.forEach((assignment) => {
      const result = byAssignment.get(assignment.assignmentId);
      const completed = result?.status === "completed" && Boolean(text(result.summary, 200000));
      assignment.status = completed ? "completed" : "failed";
      assignment.result = text(result?.summary, 200000);
      assignment.error = completed ? "" : text(result?.error || error, 4000);
      assignment.completedAt = now;
      assignment.evidence = { ...(assignment.evidence || {}), ...(clone(result?.evidence) || {}) };
    });
    this.save();
    return clone(run);
  }

  reconcileInterrupted({ activeRunIds = [], reason = "Application restarted before the project run completed." } = {}) {
    const active = new Set((Array.isArray(activeRunIds) ? activeRunIds : []).map((item) => text(item, 240)).filter(Boolean));
    const now = this.clock().toISOString();
    const repaired = [];
    for (const run of this.store.runs) {
      if (active.has(run.runId) || ["completed", "failed", "cancelled"].includes(run.status)) continue;
      run.status = "failed";
      run.error = text(reason, 4000);
      run.completedAt = now;
      run.updatedAt = now;
      for (const assignment of run.assignments || []) {
        if (["completed", "failed", "cancelled"].includes(assignment.status)) continue;
        assignment.status = "failed";
        assignment.error = text(reason, 4000);
        assignment.completedAt = now;
      }
      repaired.push(clone(run));
    }
    if (repaired.length) this.save();
    return repaired;
  }

  require(runId) {
    const run = this.store.runs.find((item) => item.runId === runId);
    if (!run) throw new Error(`Project run not found: ${runId}`);
    if (!RUN_STATUSES.has(run.status)) throw new Error(`Invalid project run status: ${run.status}`);
    return run;
  }
}

module.exports = { ProjectRunLedger, RUN_STATUSES };
