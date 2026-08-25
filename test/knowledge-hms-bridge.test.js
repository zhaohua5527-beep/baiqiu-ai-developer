"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTools } = require("../tools/knowledge");
const {
  buildHmsToolCatalog,
  buildHmsToolProtocolPrompt,
  toolsForHmsMode,
  knowledgeReferencesFromToolCalls
} = require("../services/hms-tool-protocol");

function context() {
  return {
    knowledge: {
      status: () => ({ available: true, noteTotal: 3, index: { status: "idle", available: true, total: 3 }, root: "C:/private" }),
      search: async ({ query, limit, scope, sessionId }) => ({
        query, limit, scope, sessionId,
        results: [{
          id: "note-1",
          title: "活动方案",
          type: "decision",
          typeLabel: "决策",
          status: "active",
          statusLabel: "使用中",
          project: "促销项目",
          source: "C:/private/secret.md",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
          score: 0.91,
          snippet: "活动商品必须排除可退换商品。"
        }]
      })
    }
  };
}

test("conversation mode exposes only read-only knowledge tools", () => {
  const knowledgeTools = createTools(context());
  const allTools = [...knowledgeTools, { id: "write_xlsx" }, { id: "system_command" }];
  assert.deepEqual(toolsForHmsMode(allTools, { conversationOnly: true }).map((tool) => tool.id), ["knowledge_status", "knowledge_search"]);
  assert.equal(toolsForHmsMode(allTools, { conversationOnly: false }).length, 4);
});

test("knowledge status returns a redacted deterministic capability snapshot", async () => {
  const statusTool = createTools(context()).find((tool) => tool.id === "knowledge_status");
  const response = await statusTool.execute();
  assert.equal(response.success, true);
  assert.deepEqual(response.result, {
    available: true,
    noteCount: 3,
    indexStatus: "idle",
    indexAvailable: true,
    indexedNotes: 3,
    searchAvailable: true
  });
  assert.doesNotMatch(JSON.stringify(response), /C:\/private/);
});

test("knowledge search returns references without local paths or credentials", async () => {
  const searchTool = createTools(context()).find((tool) => tool.id === "knowledge_search");
  const response = await searchTool.execute({ query: "活动方案", limit: 4, scope: "current_project" }, { sessionId: "session-1" });
  assert.equal(response.success, true);
  assert.equal(response.result.count, 1);
  assert.equal(response.result.references[0].title, "活动方案");
  assert.equal(response.result.references[0].updatedAt, "2026-08-17T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(response), /secret\.md|C:\/private|cookie|token/i);
});

test("knowledge bridge instructs Black Ball to distinguish zero hits from missing capability", () => {
  const catalog = buildHmsToolCatalog(createTools(context()));
  const prompt = buildHmsToolProtocolPrompt(catalog);
  assert.match(prompt, /零命中只表示没有相关笔记/);
  assert.match(prompt, /不得根据 skills list/);
  assert.match(prompt, /不得索取 cookie/);
});

test("successful knowledge tool results become clickable conversation references", () => {
  const references = knowledgeReferencesFromToolCalls([{
    title: "knowledge_search",
    rawOutput: {
      result: {
        references: [{ id: "note-1", title: "活动方案", type: "决策", snippet: "活动口径" }]
      }
    }
  }]);
  assert.deepEqual(references.map((item) => item.id), ["note-1"]);
  assert.equal(references[0].snippet, "活动口径");
});
