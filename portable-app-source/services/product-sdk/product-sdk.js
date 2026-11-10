const fs = require("node:fs");
const path = require("node:path");
const { dataRoot } = require("../data-root");
const { randomUUID } = require("node:crypto");
const { TaskExperience } = require("./task-experience");
const { buildExecutionMetadata } = require("../execution-metadata");
const { userFacingError } = require("../user-facing-error-adapter");

const DEFAULT_PRODUCT_DATA_ROOT = path.join(dataRoot(), "products");

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readableError(value, fallback = "这次请求未能完成，我没有生成假结果。") {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  if (value.error) return readableError(value.error, fallback);
  if (value.normalized) return readableError(value.normalized, fallback);
  if (value.result) return readableError(value.result, fallback);
  if (value.response) return readableError(value.response, fallback);
  return fallback;
}

function errorCodeOf(value = {}) {
  return value?.code
    || value?.errorCode
    || value?.result?.code
    || value?.result?.errorCode
    || value?.result?.normalized?.errorCode
    || value?.normalized?.errorCode
    || "";
}

class ProductSDK {
  constructor({ productRoot = "", dataRoot = DEFAULT_PRODUCT_DATA_ROOT, adapter = null } = {}) {
    this.productRoot = productRoot;
    this.dataRoot = dataRoot;
    this.adapter = adapter || {
      submit: async () => ({
        success: false,
        status: "failed",
        error: "ProductSDK requires an explicit runtime adapter"
      })
    };
    this.manifest = productRoot ? this.loadManifest(productRoot) : null;
  }

  loadManifest(productRoot) {
    const manifest = readJson(path.join(productRoot, "product.json"), null);
    if (!manifest || !manifest.id) throw new Error(`Invalid product manifest: ${productRoot}`);
    return manifest;
  }

  createTask(input = {}) {
    const executionMetadata = buildExecutionMetadata(input);
    const productId = input.productId || this.manifest?.id || "product";
    const taskId = input.taskId || `product-task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const task = {
      taskId,
      productId,
      productName: this.manifest?.name || input.productName || productId,
      templateId: input.templateId || "",
      input: input.input || input.message || "",
      message: input.message || input.input || "",
      intent: input.intent || "",
      planObject: input.planObject || null,
      context: input.context || {},
      sessionId: input.sessionId || taskId,
      traceId: input.traceId || taskId,
      decisionId: executionMetadata.decisionId,
      classification: executionMetadata.classification,
      responseMode: executionMetadata.responseMode,
      permissions: executionMetadata.permissions,
      routing: executionMetadata.routing,
      executionMetadata,
      status: "created",
      result: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    task.experience = TaskExperience.create(task, "received");
    this.saveTask(task);
    return task;
  }

  async submitTask(taskOrInput = {}) {
    const task = taskOrInput.taskId ? { ...this.queryTask(taskOrInput.taskId), ...taskOrInput } : this.createTask(taskOrInput);
    if (!task.taskId) throw new Error("submitTask requires a task");
    const running = this.updateTaskExperience(task.taskId, "executing", {
      message: "正在执行",
      details: { productId: task.productId || this.manifest?.id || "" }
    }) || { ...task, status: "running", updatedAt: nowIso() };
    this.saveTask(running);

    const response = await this.adapter.submit(running);
    const capabilityMissing = errorCodeOf(response) === "system_capability_missing";
    const verifying = capabilityMissing
      ? running
      : this.updateTaskExperience(task.taskId, "verifying", {
        message: "正在验证",
        details: { success: Boolean(response.success) }
      }) || running;
    const completed = {
      ...verifying,
      status: response.success ? "success" : (capabilityMissing ? "blocked" : "failed"),
      result: response.result || response,
      error: response.success ? null : userFacingError({
        code: errorCodeOf(response),
        message: readableError(response.error || response.result?.error || response.result?.normalized?.error)
      }, {
        classification: task.classification,
        domain: task.context?.conversationUnderstanding?.domain || ""
      }),
      technicalError: response.success ? null : readableError(response.error || response.result?.error || response.result?.normalized?.error),
      updatedAt: nowIso()
    };
    completed.experience = TaskExperience.advance(completed, response.success ? "completed" : "failed", {
      message: response.success ? "已完成" : completed.error,
      result: completed.result,
      details: this.detailsFromResult(completed.result)
    });
    this.saveTask(completed);
    return completed;
  }

  queryTask(taskId = "") {
    return readJson(this.taskFile(taskId), null);
  }

  getTaskStatus(taskId = "") {
    const task = this.queryTask(taskId);
    return task ? { taskId, status: task.status, updatedAt: task.updatedAt, error: task.error || null, experience: TaskExperience.output(task) } : null;
  }

  getTaskResult(taskId = "") {
    return this.getResult(taskId);
  }

  getResult(taskId = "") {
    const task = this.queryTask(taskId);
    return task ? task.result : null;
  }

  getTaskHistory(options = {}) {
    return this.getHistory(options);
  }

  getHistory({ productId = "", limit = 50 } = {}) {
    const root = productId ? path.join(this.dataRoot, productId, "tasks") : this.dataRoot;
    const files = this.listTaskFiles(root);
    return files
      .map((file) => readJson(file, null))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Number(limit) || 50));
  }

  reconcileInterrupted({ activeTaskIds = [], reason = "应用启动时未找到仍在运行的任务上下文" } = {}) {
    const active = new Set((Array.isArray(activeTaskIds) ? activeTaskIds : [activeTaskIds])
      .map((item) => String(item || "").trim()).filter(Boolean));
    const inFlight = new Set(["created", "understanding", "planning", "running", "verifying"]);
    const repaired = [];
    for (const file of this.listTaskFiles(this.dataRoot)) {
      const task = readJson(file, null);
      if (!task || !task.taskId || !inFlight.has(String(task.status || "").toLowerCase()) || active.has(task.taskId)) continue;
      const interruptionReason = String(reason || "应用启动时未找到仍在运行的任务上下文").trim();
      const next = {
        ...task,
        status: "interrupted",
        error: task.error || interruptionReason,
        technicalError: task.technicalError || interruptionReason,
        interruptionReason,
        interruptedAt: nowIso(),
        updatedAt: nowIso()
      };
      next.experience = TaskExperience.advance(next, "interrupted", {
        message: interruptionReason,
        progress: Number(task.experience?.progress || 0),
        result: task.result || null,
        details: { ...(task.experience?.details || {}), interruptionReason }
      });
      writeJson(file, next);
      repaired.push(next);
    }
    return repaired;
  }

  saveTask(task = {}) {
    writeJson(this.taskFile(task.taskId, task.productId), task);
    return task;
  }

  updateTaskExperience(taskId = "", stage = "received", patch = {}) {
    const task = this.queryTask(taskId);
    if (!task) return null;
    const next = {
      ...task,
      status: patch.status || TaskExperience.statusForStage(stage),
      experience: TaskExperience.advance(task, stage, patch),
      updatedAt: nowIso()
    };
    this.saveTask(next);
    return next;
  }

  detailsFromResult(result = {}) {
    const plan = result?.normalized?.meta?.evidence?.planObject || result?.planObject || {};
    return {
      intent: plan.primaryIntent || result.intent || "",
      strategy: plan.strategyResult?.mode || plan.strategyResult?.strategyId || "",
      decision: plan.strategyDecision?.decision || "",
      plan: Array.isArray(plan.tasks) ? plan.tasks.map((task) => task.title || task.id || task.toolId).filter(Boolean) : [],
      agentTeam: Array.isArray(plan.agentTeam?.assignments) ? plan.agentTeam.assignments.map((item) => item.role).filter(Boolean) : [],
      tool: result.toolId || result.logicalTool || "",
      verification: result.response?.verification?.status || result.verification?.status || "",
      experience: Array.isArray(plan.experienceMemoryHints) ? plan.experienceMemoryHints.length : 0
    };
  }

  taskFile(taskId = "", productId = "") {
    const id = productId || this.manifest?.id || "product";
    return path.join(this.dataRoot, id, "tasks", `${taskId}.json`);
  }

  listTaskFiles(root) {
    if (!fs.existsSync(root)) return [];
    const found = [];
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, item.name);
      if (item.isDirectory()) found.push(...this.listTaskFiles(full));
      else if (item.isFile() && item.name.endsWith(".json")) found.push(full);
    }
    return found;
  }
}

module.exports = { ProductSDK, DEFAULT_PRODUCT_DATA_ROOT, errorCodeOf };
