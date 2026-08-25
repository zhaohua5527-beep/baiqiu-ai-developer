const { enrichToolMetadata } = require("./services/tool-selector");

class ToolRegistry {
  constructor({ context = {}, logger = null } = {}) {
    this.context = context;
    this.logger = logger || context.logger || null;
    this.tools = new Map();
    this._mainWindow = null;
  }

  setMainWindow(mainWindow) {
    this._mainWindow = mainWindow || null;
  }

  register(tool) {
    validateTool(tool);
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, enrichToolMetadata({ ...tool, parameters: normalizeParameters(tool.parameters) }));
    return this.get(tool.id);
  }

  unregister(id) {
    return this.tools.delete(String(id || ""));
  }

  get(id) {
    return this.tools.get(String(id || "")) || null;
  }

  list() {
    return [...this.tools.values()].map(({ execute, ...schema }) => enrichToolMetadata({ ...schema }));
  }

  async execute(id, parameters = {}, contextPatch = {}) {
    const toolId = String(id || "");
    const tool = this.get(toolId);
    const startedAt = new Date();
    const startMs = Date.now();
    const entry = {
      startedAt: startedAt.toISOString(),
      endedAt: null,
      toolId,
      toolName: tool?.name || toolId || "unknown",
      parameters: safeSnapshot(parameters),
      result: null,
      error: null,
      duration: 0
    };

    if (!tool) {
      const response = normalizeToolResponse({
        success: false,
        result: null,
        error: `未识别动作：${toolId || "unknown"}`,
        evidence: []
      }, startMs);
      entry.endedAt = new Date().toISOString();
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      return response;
    }

    const toolContext = {
      ...this.context,
      ...contextPatch,
      tool,
      registry: this
    };
    try {
      const output = await tool.execute(parameters, toolContext);
      const response = normalizeToolResponse(output, startMs);
      entry.endedAt = new Date().toISOString();
      entry.result = safeSnapshot(response.result);
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
      return response;
    } catch (error) {
      this.context.auditLogger?.error?.(toolId, error, toolContext);
      const response = normalizeToolResponse({
        success: false,
        result: null,
        error: error?.message || String(error),
        evidence: []
      }, startMs);
      entry.endedAt = new Date().toISOString();
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
      return response;
    }
  }

  log(entry) {
    try {
      this.logger?.log?.(entry);
    } catch {
      // Tool logging must never break tool execution.
    }
  }

  _sanitizeForEvidence(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const copy = { ...obj };
    const sensitive = ["password", "token", "apiKey", "secret", "key"];
    for (const key of sensitive) {
      if (copy[key]) copy[key] = "***REDACTED***";
    }
    return copy;
  }

}

function validateTool(tool) {
  if (!tool || typeof tool !== "object") throw new Error("Tool schema must be an object");
  for (const key of ["id", "name", "description", "parameters", "execute"]) {
    if (!(key in tool)) throw new Error(`Tool schema missing required field: ${key}`);
  }
  if (!String(tool.id || "").trim()) throw new Error("Tool id is required");
  if (typeof tool.execute !== "function") throw new Error(`Tool execute must be a function: ${tool.id}`);
}

function normalizeParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {}, required: [] };
  }
  return {
    ...parameters,
    type: parameters.type || "object",
    properties: parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {},
    required: Array.isArray(parameters.required) ? parameters.required : []
  };
}

function normalizeToolResponse(output, startMs) {
  const duration = Date.now() - startMs;
  if (output && typeof output === "object" && "success" in output) {
    const error = output.error && typeof output.error === "object"
      ? output.error
      : (output.error ? String(output.error) : null);
    return {
      success: Boolean(output.success),
      result: output.result ?? null,
      error,
      evidence: Array.isArray(output.evidence) ? output.evidence : [],
      duration
    };
  }
  return {
    success: true,
    result: output ?? null,
    error: null,
    evidence: [],
    duration
  };
}

function safeSnapshot(value) {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "string" && item.length > 2000) return `${item.slice(0, 2000)}...<truncated>`;
      return item;
    });
    if (!json) return value ?? null;
    return JSON.parse(json);
  } catch {
    return String(value);
  }
}

module.exports = { ToolRegistry };
