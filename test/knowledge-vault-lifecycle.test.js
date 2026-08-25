const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { KnowledgeVault } = require("../services/knowledge/knowledge-vault");

function createVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-vault-"));
  let current = new Date("2026-01-01T00:00:00.000Z");
  const vault = new KnowledgeVault({ rootProvider: () => root, now: () => current });
  return {
    root,
    vault,
    setDate(value) { current = new Date(value); },
    dispose() {
      vault.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("knowledge vault stores the collection and independent metadata", () => {
  const fixture = createVault();
  try {
    const result = fixture.vault.create({
      title: "白球表格方案",
      category: "projects",
      type: "plan",
      status: "confirmed",
      project: "白球客户端",
      source: "会话 2026-01-01",
      tags: "表格, 客户端",
      body: "# 白球表格方案\n\n使用真实表格渲染。"
    });
    const note = result.note;
    assert.equal(note.category, "projects");
    assert.equal(note.type, "plan");
    assert.equal(note.status, "confirmed");
    assert.equal(note.project, "白球客户端");
    assert.equal(note.source, "会话 2026-01-01");
    assert.deepEqual(note.tags, ["表格", "客户端"]);
  } finally {
    fixture.dispose();
  }
});

test("automatic summaries expose the model conclusion instead of a raw prefix slice", () => {
  const fixture = createVault();
  try {
    const modelSummary = "核心结论：知识库只在项目任务需要历史决策时调用。";
    const created = fixture.vault.create({
      title: "自动归纳路由结论",
      category: "projects",
      source: "auto-summary/session-1/message-9",
      body: `# 自动归纳路由结论\n\n${modelSummary}\n\n## 后续事项\n\n- 继续验证延迟。`
    });
    assert.equal(created.note.summary, modelSummary);
    assert.equal(created.note.excerpt, modelSummary);
  } finally {
    fixture.dispose();
  }
});

test("inactive knowledge moves to recycle bin and can be restored", () => {
  const fixture = createVault();
  try {
    fixture.vault.create({ title: "临时资料", category: "resources", body: "一条可清理的资料" });
    const temporary = fixture.vault.state().notes[0];
    fixture.vault.update(temporary.id, { status: "draft" });
    fixture.setDate("2026-02-01T00:00:00.000Z");
    const recycledState = fixture.vault.state();
    assert.equal(recycledState.cleanup.movedToRecycle, 1);
    const recycled = recycledState.notes.find((note) => note.category === "recycle-bin");
    assert.ok(recycled);
    assert.equal(recycled.status, "recycled");

    const restored = fixture.vault.restore(recycled.id);
    assert.equal(restored.note.category, "resources");
    assert.equal(restored.note.status, "draft");
    assert.equal(restored.state.notes.some((note) => note.category === "recycle-bin"), false);
  } finally {
    fixture.dispose();
  }
});

test("inactive active knowledge enters recycle after 30 days", () => {
  const fixture = createVault();
  try {
    fixture.vault.create({ title: "Active note", category: "projects", status: "active", body: "Keep this knowledge." });
    fixture.setDate("2026-04-15T00:00:00.000Z");
    const state = fixture.vault.state();
    assert.equal(state.cleanup.movedToRecycle, 1);
    assert.equal(state.notes[0].status, "recycled");
  } finally {
    fixture.dispose();
  }
});

test("confirmed knowledge is protected from automatic 30-day cleanup", () => {
  const fixture = createVault();
  try {
    fixture.vault.create({ title: "已确认决策", category: "projects", status: "confirmed", body: "保留" });
    fixture.setDate("2026-04-15T00:00:00.000Z");
    const state = fixture.vault.state();
    assert.equal(state.cleanup.movedToRecycle, 0);
    assert.equal(state.notes.length, 1);
    assert.equal(state.notes[0].category, "projects");
  } finally {
    fixture.dispose();
  }
});

test("recycled knowledge remains recoverable until the user explicitly deletes it", () => {
  const fixture = createVault();
  try {
    fixture.vault.create({ title: "过期资料", body: "清理" });
    const temporary = fixture.vault.state().notes[0];
    fixture.vault.update(temporary.id, { status: "draft" });
    fixture.setDate("2026-02-01T00:00:00.000Z");
    fixture.vault.state();
    fixture.setDate("2026-03-04T00:00:00.000Z");
    const state = fixture.vault.state();
    assert.equal(state.cleanup.permanentlyDeleted, 0);
    assert.equal(state.total, 1);
    assert.equal(state.notes[0].category, "recycle-bin");
  } finally {
    fixture.dispose();
  }
});

test("confirmed knowledge in recycle bin is protected from permanent deletion", () => {
  const fixture = createVault();
  try {
    const created = fixture.vault.create({ title: "已确认决策", category: "projects", status: "confirmed", body: "保留" });
    fixture.vault.recycle(created.note.id);
    fixture.setDate("2026-03-04T00:00:00.000Z"); // 31 天后
    const state = fixture.vault.state();
    assert.equal(state.cleanup.permanentlyDeleted, 0);
    const recycled = state.notes.find((note) => note.category === "recycle-bin");
    assert.ok(recycled, "confirmed note should remain in recycle bin");
    assert.equal(recycled.originalStatus, "confirmed");
  } finally {
    fixture.dispose();
  }
});

test("pinned knowledge in recycle bin is protected from permanent deletion", () => {
  const fixture = createVault();
  try {
    const created = fixture.vault.create({ title: "置顶资料", category: "resources", pinned: true, body: "保留" });
    fixture.vault.recycle(created.note.id);
    fixture.setDate("2026-03-04T00:00:00.000Z");
    const state = fixture.vault.state();
    assert.equal(state.cleanup.permanentlyDeleted, 0);
    assert.equal(state.notes.some((note) => note.category === "recycle-bin"), true);
  } finally {
    fixture.dispose();
  }
});

test("historical note with no usage record uses updatedAt for activity, not creation time", () => {
  const fixture = createVault();
  try {
    // 直接写一个没有 usage.json 记录的历史笔记（模拟旧版本导入/沉淀，创建时间早）
    const root = fixture.vault.root();
    const file = path.join(root, "inbox", "legacy-note.md");
    fs.writeFileSync(file, "---\ntitle: 历史导入笔记\ncategory: inbox\ncreatedAt: 2025-06-01T00:00:00.000Z\nupdatedAt: 2026-01-15T00:00:00.000Z\n---\n\n旧内容\n", "utf8");
    // 当前 2026-01-20：创建已 7 个月，但 updatedAt 在 30 天内 → 不算 inactive
    fixture.setDate("2026-01-20T00:00:00.000Z");
    const state = fixture.vault.state();
    assert.equal(state.cleanup.movedToRecycle, 0, "recently-updated note should not be recycled");
    assert.ok(state.notes.some((note) => note.category === "inbox"));
  } finally {
    fixture.dispose();
  }
});

test("legacy category names remain readable with the new taxonomy", () => {
  const fixture = createVault();
  try {
    const legacyFolder = path.join(fixture.vault.root(), "core");
    fs.mkdirSync(legacyFolder, { recursive: true });
    fs.writeFileSync(path.join(legacyFolder, "legacy.md"), "---\ntitle: 旧项目\ncategory: core\n---\n\n旧内容\n", "utf8");
    const note = fixture.vault.state().notes.find((item) => item.title === "旧项目");
    assert.ok(note);
    assert.equal(note.category, "projects");
  } finally {
    fixture.dispose();
  }
});

test("knowledge search returns bounded relevant context and records retrieval use", () => {
  const fixture = createVault();
  try {
    const target = fixture.vault.create({
      title: "白球客户端上架方案",
      category: "projects",
      type: "plan",
      status: "confirmed",
      project: "白球AI",
      tags: "上架, 发布",
      body: "先上传完整客户端，再校验下载包完整性并发布更新。"
    }).note;
    fixture.vault.create({ title: "无关资料", category: "resources", body: "这里是另一份资料。" });

    const search = fixture.vault.search("白球上架方案", { limit: 4, project: "白球AI" });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].id, target.id);
    assert.match(search.results[0].content, /完整客户端/);

    const used = fixture.vault.state().notes.find((note) => note.id === target.id);
    assert.equal(used.lastAction, "retrieved");
  } finally {
    fixture.dispose();
  }
});

test("Markdown import is indexed, audited, and exact content is not duplicated", () => {
  const fixture = createVault();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-knowledge-import-"));
  try {
    const first = path.join(external, "route.md");
    const second = path.join(external, "route-copy.markdown");
    const content = "---\ntitle: 项目检索规则\ncategory: projects\nproject: 白球AI\n---\n\n# 项目检索规则\n\n项目知识只能检索当前项目与全局知识。\n";
    fs.writeFileSync(first, content, "utf8");
    fs.writeFileSync(second, content, "utf8");
    const result = fixture.vault.importMarkdown([first, second]);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(fixture.vault.search("当前项目 全局知识", { project: "白球AI" }).results[0]?.title, "项目检索规则");
    assert.equal(fixture.vault.state().recentAudit.some((entry) => entry.action === "imported"), true);
  } finally {
    fixture.dispose();
    fs.rmSync(external, { recursive: true, force: true });
  }
});
