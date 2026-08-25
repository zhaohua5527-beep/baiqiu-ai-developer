"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { KnowledgeSearchIndex } = require("../services/knowledge/knowledge-search-index");
const { knowledgeRetrievalDecision } = require("../services/knowledge/knowledge-retrieval-policy");
const { KnowledgeVault } = require("../services/knowledge/knowledge-vault");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-index-"));
  const index = new KnowledgeSearchIndex({ dbPath: path.join(root, "index.sqlite") });
  return {
    root,
    index,
    dispose() {
      index.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function add(index, id, { title, project = "", source = "", body, status = "active", category = "projects" }) {
  index.upsert({
    id,
    filePath: path.join(path.dirname(index.dbPath), id.replaceAll("/", "-")),
    title,
    project,
    source,
    body,
    status,
    category,
    updatedAt: "2026-08-03T00:00:00.000Z"
  });
}

test("FTS index retrieves Chinese knowledge and isolates other projects", () => {
  const current = fixture();
  try {
    add(current.index, "projects/whiteball.md", {
      title: "知识星球路由方案",
      project: "白球AI",
      source: "会话/whiteball/消息/1",
      body: "知识库先经过调用门禁，再使用增量索引检索。"
    });
    add(current.index, "projects/other.md", {
      title: "另一个项目的知识库路由",
      project: "其他项目",
      source: "会话/other/消息/1",
      body: "这份内容不能泄漏给白球项目。"
    });

    const result = current.index.search("知识库路由", { project: "白球AI", limit: 4 });
    assert.deepEqual(result.results.map((item) => item.id), ["projects/whiteball.md"]);
    assert.equal(current.index.findBySource("会话/whiteball/消息/1").id, "projects/whiteball.md");
  } finally {
    current.dispose();
  }
});

test("index mutations replace stale text and remove deleted documents", () => {
  const current = fixture();
  try {
    add(current.index, "inbox/note.md", { title: "旧方案", body: "旧的路由规则" });
    assert.equal(current.index.search("旧的路由").results.length, 1);
    add(current.index, "inbox/note.md", { title: "新方案", body: "新的项目门禁" });
    assert.equal(current.index.search("旧的路由").results.length, 0);
    assert.equal(current.index.search("项目门禁").results.length, 1);
    current.index.remove("inbox/note.md");
    assert.equal(current.index.search("项目门禁").results.length, 0);
  } finally {
    current.dispose();
  }
});

test("runtime retrieval excludes draft candidates", () => {
  const current = fixture();
  try {
    add(current.index, "projects/approved.md", { title: "Approved route", body: "project routing decision", status: "active" });
    add(current.index, "projects/candidate.md", { title: "Candidate route", body: "project routing decision", status: "draft" });
    const result = current.index.search("project routing decision", { retrievalOnly: true });
    assert.deepEqual(result.results.map((item) => item.id), ["projects/approved.md"]);
  } finally {
    current.dispose();
  }
});

test("runtime retrieval without a project is closed unless global scope is explicit", () => {
  const current = fixture();
  try {
    add(current.index, "projects/private.md", { title: "Private project route", project: "Private", body: "shared routing keyword" });
    add(current.index, "resources/global.md", { title: "Global route", project: "", category: "resources", body: "shared routing keyword" });
    add(current.index, "inbox/session-summary.md", {
      title: "Another session summary",
      project: "",
      source: "auto-summary/session-other/assistant-1",
      body: "shared routing keyword"
    });
    add(current.index, "inbox/current-session-summary.md", {
      title: "Current session summary",
      project: "",
      source: "auto-summary/session-current/assistant-2",
      body: "shared routing keyword"
    });
    const result = current.index.search("shared routing keyword", { retrievalOnly: true, projectScope: true });
    assert.deepEqual(result.results.map((item) => item.id), []);
    const explicit = current.index.search("shared routing keyword", { retrievalOnly: true, projectScope: true, allowGlobal: true, excludeAutoSummaries: true });
    assert.deepEqual(explicit.results.map((item) => item.id), ["resources/global.md"]);
    const scopedAutomatic = current.index.search("shared routing keyword", {
      retrievalOnly: true,
      projectScope: true,
      allowGlobal: true,
      sessionId: "session-current",
      excludeAutoSummaries: false
    });
    assert.deepEqual(scopedAutomatic.results.map((item) => item.id).sort(), ["inbox/current-session-summary.md", "resources/global.md"]);
  } finally {
    current.dispose();
  }
});

test("entity scoped retrieval ignores unscoped automatic conversation summaries", () => {
  const current = fixture();
  try {
    add(current.index, "projects/chengbei.md", {
      title: "城北店活动方案",
      project: "城北店",
      source: "manual/chengbei",
      body: "城北店 活动 方案"
    });
    add(current.index, "inbox/old-auto.md", {
      title: "城北店旧会话",
      project: "",
      source: "auto-summary/session-a/assistant-a",
      body: "城北店 活动 方案"
    });
    const result = current.index.search("城北店 活动 方案", { retrievalOnly: true, projectScope: true, entity: "城北店" });
    assert.deepEqual(result.results.map((item) => item.id), ["projects/chengbei.md"]);
  } finally {
    current.dispose();
  }
});

test("retrieval gate skips foreground noise and retrieves substantive scoped conversations", () => {
  assert.equal(knowledgeRetrievalDecision({ message: "你好", hasProject: true }).retrieve, false);
  assert.equal(knowledgeRetrievalDecision({ message: "2 + 2", hasProject: true }).retrieve, false);
  assert.equal(knowledgeRetrievalDecision({ message: "查一下今天最新新闻", hasProject: true }).retrieve, false);
  assert.equal(knowledgeRetrievalDecision({ message: "继续优化项目的知识库路由", hasProject: true }).retrieve, true);
  assert.equal(knowledgeRetrievalDecision({ message: "同事能否具体描述他的工作表现？", hasProject: true }).scope, "project");
  assert.equal(knowledgeRetrievalDecision({ message: "我们上次确认了什么方案？", hasProject: false }).retrieve, true);
  assert.deepEqual(knowledgeRetrievalDecision({ message: "查一下城北店之前的活动方案", hasProject: false }).entities, ["城北店"]);
  assert.equal(knowledgeRetrievalDecision({ message: "查一下城北店之前的活动方案", hasProject: false }).retrieve, true);
  assert.equal(knowledgeRetrievalDecision({ message: "介绍一下量子力学", hasProject: false }).retrieve, true);
  assert.equal(knowledgeRetrievalDecision({ message: "介绍一下量子力学", hasProject: false }).scope, "global");
});

test("background worker reconciles Markdown created outside the application", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-worker-"));
  const vault = new KnowledgeVault({ rootProvider: () => root });
  try {
    const folder = path.join(vault.root(), "projects");
    fs.writeFileSync(path.join(folder, "external.md"), [
      "---",
      "title: 外部 Obsidian 笔记",
      "category: projects",
      "status: active",
      "project: 白球AI",
      "tags: [增量索引]",
      "---",
      "",
      "外部编辑的 Markdown 也必须由后台 Worker 纳入检索。"
    ].join("\n"), "utf8");
    const reconciled = await vault.initializeIndex();
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.upserted, 1);
    assert.equal(vault.search("外部编辑 Markdown", { project: "白球AI" }).results[0]?.title, "外部 Obsidian 笔记");
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
