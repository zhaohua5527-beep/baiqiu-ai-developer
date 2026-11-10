"use strict";

function clean(value, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedStatus(context = {}) {
  const state = context.knowledge?.status?.() || {};
  const index = state.index && typeof state.index === "object" ? state.index : {};
  return {
    available: state.available !== false,
    noteCount: Math.max(0, Number(state.noteTotal ?? state.total ?? 0) || 0),
    indexStatus: clean(index.status || "unknown", 80),
    indexAvailable: index.available === true,
    indexedNotes: Math.max(0, Number(index.total || 0) || 0),
    searchAvailable: state.available !== false && index.available !== false
  };
}

function normalizeReferences(search = {}) {
  return (Array.isArray(search.results) ? search.results : []).slice(0, 8).map((item) => ({
    id: clean(item?.id, 240),
    title: clean(item?.title, 240),
    type: clean(item?.typeLabel || item?.type || "知识笔记", 120),
    rawType: clean(item?.type || "note", 80),
    status: clean(item?.statusLabel || item?.status || "使用中", 120),
    rawStatus: clean(item?.status || "active", 80),
    project: clean(item?.project, 240),
    createdAt: clean(item?.createdAt, 80),
    updatedAt: clean(item?.updatedAt, 80),
    score: Number(item?.score || 0),
    snippet: clean(item?.snippet, 1200)
  })).filter((item) => item.id && item.title);
}

function createTools(context = {}) {
  return [
    {
      id: "knowledge_status",
      name: "知识星球状态",
      description: "读取白球本机知识星球的脱敏状态。用户询问知识星球是否存在、是否可调用或是否已索引时必须调用，不得用技能列表代替。",
      parameters: { type: "object", properties: {}, required: [] },
      permission: { level: "read", scope: "local.knowledge" },
      async execute() {
        const result = normalizedStatus(context);
        return {
          success: true,
          result,
          error: null,
          evidence: [{ type: "knowledge-status", available: result.available, noteCount: result.noteCount, indexStatus: result.indexStatus }]
        };
      }
    },
    {
      id: "knowledge_search",
      name: "搜索知识星球",
      description: "只读搜索白球本机知识星球。由黑球决定何时检索；零命中只代表没有相关笔记，不能解释为知识星球不存在。",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "要检索的事实、方案或项目关键词" },
          limit: { type: "number", description: "返回数量，1 到 8，默认 4" },
          scope: { type: "string", enum: ["all", "current_project"], description: "检索全部知识或当前项目" }
        }
      },
      permission: { level: "read", scope: "local.knowledge" },
      async execute(params = {}, toolContext = {}) {
        const query = clean(params.query, 1000);
        if (query.length < 2) {
          return { success: false, result: null, error: { code: "KNOWLEDGE_QUERY_REQUIRED", message: "知识搜索至少需要 2 个字符" }, evidence: [] };
        }
        const limit = Math.max(1, Math.min(8, Number(params.limit || 4) || 4));
        const scope = params.scope === "current_project" ? "current_project" : "all";
        const search = await context.knowledge?.search?.({ query, limit, scope, sessionId: toolContext.sessionId || "" });
        if (!search || typeof search !== "object") {
          return { success: false, result: null, error: { code: "KNOWLEDGE_UNAVAILABLE", message: "知识星球当前不可用" }, evidence: [] };
        }
        const references = normalizeReferences(search);
        const result = {
          available: true,
          query,
          scope,
          count: references.length,
          degraded: search.degraded === true,
          reason: clean(search.reason, 120),
          references
        };
        return {
          success: true,
          result,
          error: null,
          evidence: [{ type: "knowledge-search", query, scope, count: references.length, noteIds: references.map((item) => item.id) }]
        };
      }
    }
  ];
}

module.exports = { createTools, normalizedStatus, normalizeReferences };
