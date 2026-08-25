"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ConversationKnowledgeQueue, candidateFromMessages, normalizeDecision } = require("../services/knowledge/conversation-knowledge-queue");

function messages() {
  return [
    { id: "u1", role: "user", text: "知识星球项目必须先实现增量索引，不能阻塞黑球路由。", createdAt: 1 },
    { id: "a1", role: "assistant", text: "已确认方案：SQLite 只做可重建索引，Markdown 是正文真相源。", createdAt: 2 }
  ];
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-summary-queue-"));
  const saved = [];
  const queue = new ConversationKnowledgeQueue({
    dbPath: path.join(root, "knowledge.sqlite"),
    retryDelayMs: 1000,
    autoWake: false,
    summarize: async () => ({
      shouldSave: true,
      action: "create",
      title: "知识星球索引方案",
      summary: "Markdown 是正文真相源，SQLite 是可重建索引。",
      category: "projects",
      type: "decision",
      confidence: 0.95,
      sourceMessageIds: ["u1", "a1"]
    }),
    save: async (decision, candidate) => {
      saved.push({ decision, candidate });
      return { note: { id: "projects/summary.md" }, source: "auto-summary/s1/a1" };
    },
    ...overrides
  });
  return { root, queue, saved, dispose() { queue.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("candidate gate rejects noise, secrets, failures, and generated summaries", () => {
  assert.equal(candidateFromMessages({ sessionId: "s1", messages: [{ id: "u", role: "user", text: "你好" }, { id: "a", role: "assistant", text: "你好" }] }), null);
  assert.equal(candidateFromMessages({ sessionId: "s1", messages: [{ id: "u", role: "user", text: "项目密钥 api_key=secret-secret-123" }, { id: "a", role: "assistant", text: "已完成任务" }] }), null);
  assert.equal(candidateFromMessages({ sessionId: "s1", messages: [{ id: "u", role: "user", text: "修复项目" }, { id: "a", role: "assistant", text: "执行失败：超时", raw: { error: "timeout" } }] }), null);
  assert.equal(candidateFromMessages({ sessionId: "s1", messages: [{ id: "u", role: "user", text: "修复项目" }, { id: "a", role: "assistant", text: "自动归纳", raw: { knowledgeSummary: true } }] }), null);
  assert.equal(candidateFromMessages({
    sessionId: "s1",
    messages: [
      { id: "u", role: "user", text: "生成桌面表格" },
      { id: "a", role: "assistant", text: "已生成桌面表格", raw: { productResult: { taskId: "t1", status: "completed", success: true, verified: false } } }
    ]
  }), null);
});

test("automatic knowledge remains draft even at high confidence", () => {
  const decision = normalizeDecision({ action: "create", confidence: 0.99, summary: "Stable conclusion" }, { messageIds: ["u1", "a1"] });
  assert.equal(decision.candidateStatus, "draft");
  const evidenced = normalizeDecision(
    { action: "create", confidence: 0.99, summary: "Verified conclusion" },
    { messageIds: ["u1", "a1"], verifiedTaskEvidence: true }
  );
  assert.equal(evidenced.candidateStatus, "active");
});

test("a repeated draft from another session stays isolated", async () => {
  const promoted = [];
  const current = fixture({
    promote: async (duplicate, decision, candidate) => {
      promoted.push({ duplicate, decision, candidate });
      return { promoted: true, note: { id: duplicate.noteId } };
    }
  });
  try {
    current.queue.schedule({ sessionId: "s1", messages: messages() });
    await current.queue.drainOnce();
    current.queue.schedule({ sessionId: "s2", messages: messages().map((item) => ({ ...item, id: `repeat-${item.id}` })) });
    await current.queue.drainOnce();
    assert.equal(promoted.length, 0);
    assert.equal(current.saved.length, 2);
  } finally {
    current.dispose();
  }
});

test("queue saves one structured summary and advances its checkpoint", async () => {
  const current = fixture();
  try {
    const scheduled = current.queue.schedule({ sessionId: "s1", projectId: "p1", projectName: "白球AI", messages: messages(), trigger: "task_completed" });
    assert.equal(scheduled.queued, true);
    const result = await current.queue.drainOnce();
    assert.equal(result.processed, true);
    assert.equal(current.saved.length, 1);
    assert.equal(current.saved[0].decision.status, undefined);
    assert.equal(current.queue.checkpoint("s1"), "a1");
    assert.equal(current.queue.schedule({ sessionId: "s1", messages: messages() }).queued, false);
  } finally {
    current.dispose();
  }
});

test("queue pauses while black ball is busy and deduplicates exact knowledge within one session", async () => {
  let busy = true;
  const current = fixture({ isBusy: () => busy });
  try {
    current.queue.schedule({ sessionId: "s1", messages: messages() });
    assert.equal((await current.queue.drainOnce()).reason, "busy");
    busy = false;
    await current.queue.drainOnce();
    assert.equal(current.saved.length, 1);

    current.queue.schedule({ sessionId: "s1", messages: messages().map((item) => ({ ...item, id: `2${item.id}` })) });
    await current.queue.drainOnce();
    assert.equal(current.saved.length, 1, "same normalized knowledge should not be written twice");
  } finally {
    current.dispose();
  }
});

test("task identity separates summaries inside the same session", async () => {
  const current = fixture();
  try {
    const first = current.queue.schedule({ sessionId: "s1", taskId: "task-1", messages: messages() });
    await current.queue.drainOnce();
    const second = current.queue.schedule({
      sessionId: "s1",
      taskId: "task-2",
      messages: messages().map((item) => ({ ...item, id: `task-2-${item.id}` }))
    });
    await current.queue.drainOnce();
    assert.notEqual(first.jobId, second.jobId);
    assert.deepEqual(current.saved.map((item) => item.candidate.taskId), ["task-1", "task-2"]);
  } finally {
    current.dispose();
  }
});
