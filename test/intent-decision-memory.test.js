"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { KnowledgeVault } = require("../services/knowledge/knowledge-vault");
const {
  buildIntentDecisionNote,
  parseIntentDecisionBody,
  selectReusableIntentDecision,
  executionTextForIntentDecision,
  applyIntentDecisionReuse
} = require("../services/knowledge/intent-decision-memory");

function fixture(overrides = {}) {
  return buildIntentDecisionNote({
    sessionId: "session-1",
    requestId: "request-1",
    project: "Baiqiu",
    state: {
      originalRequest: "Build me a desktop application",
      confirmedOrder: ["product_direction"],
      dimensionLabels: { product_direction: "Product direction" },
      confirmedDimensions: { product_direction: "Desktop work assistant" }
    },
    executionText: "Build me a desktop application\n\n- Product direction: Desktop work assistant",
    now: new Date("2026-08-04T00:00:00.000Z"),
    ...overrides
  });
}

test("confirmed intent writeback uses protected decision metadata and a parseable body", () => {
  const built = fixture();
  assert.equal(built.source, "intent-confirmation/session-1/request-1");
  assert.equal(built.payload.type, "decision");
  assert.equal(built.payload.status, "confirmed");
  assert.equal(built.payload.project, "Baiqiu");
  assert.deepEqual(built.payload.tags, ["\u610f\u56fe\u786e\u8ba4", "\u81ea\u52a8\u590d\u7528", "Baiqiu"]);
  assert.deepEqual(parseIntentDecisionBody(built.payload.body), built.memory);
});

test("only a real FTS result with exact source, type, status, project, and strong similarity is reusable", () => {
  const built = fixture();
  const note = { id: "note-1", ...built.payload, body: undefined, updatedAt: "2026-08-04T00:00:00.000Z" };
  const hit = selectReusableIntentDecision({
    query: "Please build me a desktop application",
    project: "Baiqiu",
    searchResults: [note],
    readBody: () => built.payload.body
  });
  assert.equal(hit?.note.id, "note-1");
  assert.ok(hit.similarity >= 0.78);
});

test("drafts, ordinary notes, foreign sources, cross-project records, and weak matches never bypass clarification", () => {
  const built = fixture();
  const base = { id: "note-1", ...built.payload, body: built.payload.body };
  const cases = [
    { ...base, status: "draft" },
    { ...base, type: "note" },
    { ...base, source: "auto-summary/session-1/message-1" },
    { ...base, project: "Other" }
  ];
  for (const note of cases) {
    assert.equal(selectReusableIntentDecision({ query: "Build me a desktop application", project: "Baiqiu", searchResults: [note] }), null);
  }
  assert.equal(selectReusableIntentDecision({ query: "Create a pricing spreadsheet", project: "Baiqiu", searchResults: [base] }), null);
});

test("Chinese punctuation and polite wording variations remain a strong match", () => {
  const built = fixture({
    project: "\u767d\u7403AI",
    state: {
      originalRequest: "\u5e2e\u6211\u505a\u4e00\u4e2a\u8f6f\u4ef6",
      confirmedOrder: ["product_direction"],
      dimensionLabels: { product_direction: "\u4ea7\u54c1\u65b9\u5411" },
      confirmedDimensions: { product_direction: "\u684c\u9762\u5de5\u4f5c\u52a9\u624b" }
    },
    executionText: "\u5e2e\u6211\u505a\u4e00\u4e2a\u8f6f\u4ef6\n\n- \u4ea7\u54c1\u65b9\u5411: \u684c\u9762\u5de5\u4f5c\u52a9\u624b"
  });
  const note = { id: "note-cn", ...built.payload, body: built.payload.body };
  const hit = selectReusableIntentDecision({
    query: "\u8bf7\u5e2e\u6211\u505a\u4e00\u4e2a\u8f6f\u4ef6\u5427\uff01",
    project: "\u767d\u7403AI",
    searchResults: [note]
  });
  assert.equal(hit?.note.id, "note-cn");
});

test("the reusable decision must come through the real local FTS index", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-intent-memory-"));
  const vault = new KnowledgeVault({ rootProvider: () => root });
  try {
    const built = fixture();
    const created = vault.create(built.payload).note;
    vault.create({
      title: "Desktop application draft",
      category: "projects",
      type: "note",
      status: "draft",
      project: "Baiqiu",
      source: "auto-summary/session-2/message-2",
      body: "Build me a desktop application with a different draft direction."
    });
    const search = vault.search("Please build me a desktop application", { project: "Baiqiu", limit: 12 });
    assert.ok(search.results.some((note) => note.id === created.id));
    const hit = selectReusableIntentDecision({
      query: "Please build me a desktop application",
      project: "Baiqiu",
      searchResults: search.results,
      readBody: (note) => vault.read(note.id, { trackUsage: false }).body
    });
    assert.equal(hit?.note.id, created.id);
    assert.equal(hit?.note.type, "decision");
    assert.equal(hit?.note.status, "confirmed");
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reuse keeps the current request and can promote an execution clarification without changing multi-agent routing", () => {
  const built = fixture();
  const executionText = executionTextForIntentDecision("Build the application again", built.memory);
  assert.match(executionText, /^Build the application again/);
  assert.match(executionText, /Desktop work assistant/);
  const promoted = applyIntentDecisionReuse({
    understanding: {
      responseMode: "clarify",
      intentType: "execution",
      workers: 0,
      context: { normalizedInput: "Build the application again" }
    },
    executionText,
    memory: { ...built.memory, source: built.source },
    permissions: { allowTaskCreation: true, allowAgent: true, allowTools: true }
  });
  assert.equal(promoted.responseMode, "execute");
  assert.equal(promoted.shouldCreateTask, true);
  assert.equal(promoted.context.normalizedInput, executionText);

  const multiAgent = applyIntentDecisionReuse({
    understanding: { responseMode: "clarify", intentType: "execution", workers: 2, context: {} },
    executionText,
    permissions: { allowTaskCreation: true }
  });
  assert.equal(multiAgent, null);
});
