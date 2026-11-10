const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const YAML = require("yaml");
const { summarize } = require("./knowledge-keyline");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INACTIVE_DAYS = 30;
const DEFAULT_RECYCLE_RETENTION_DAYS = 30;

// Collections answer where a knowledge object belongs. Type, status, and source
// remain independent metadata so a decision is never forced into one flat bucket.
const CATEGORIES = Object.freeze([
  { id: "inbox", label: "收件箱" },
  { id: "projects", label: "项目" },
  { id: "my-skills", label: "我的技能", system: true },
  { id: "online-skills", label: "网上技能" },
  { id: "resources", label: "资料库" },
  { id: "templates", label: "方法与模板" },
  { id: "recycle-bin", label: "回收站", system: true }
]);

const KNOWLEDGE_TYPES = Object.freeze([
  { id: "note", label: "知识笔记" },
  { id: "decision", label: "决策" },
  { id: "plan", label: "方案" },
  { id: "task-record", label: "任务记录" },
  { id: "data", label: "数据与表格" },
  { id: "resource", label: "资料链接" },
  { id: "method", label: "方法" },
  { id: "template", label: "模板" },
  { id: "idea", label: "灵感" },
  { id: "online-skill", label: "网上技能" }
]);

const KNOWLEDGE_STATUSES = Object.freeze([
  { id: "active", label: "使用中" },
  { id: "draft", label: "待整理" },
  { id: "confirmed", label: "已确认" },
  { id: "archived", label: "已归档" },
  { id: "recycled", label: "已回收" }
]);

const LEGACY_CATEGORY_MAP = Object.freeze({
  core: "projects",
  assets: "resources",
  resources: "resources",
  archive: "resources",
  ideas: "inbox",
  templates: "templates"
});

function text(value) {
  return String(value ?? "").trim();
}

function listId(value, collection, fallback) {
  const id = text(value).toLowerCase();
  return collection.some((item) => item.id === id) ? id : fallback;
}

function categoryId(value) {
  const id = text(value).toLowerCase();
  if (LEGACY_CATEGORY_MAP[id]) return LEGACY_CATEGORY_MAP[id];
  return listId(id, CATEGORIES, "inbox");
}

function typeId(value) {
  return listId(value, KNOWLEDGE_TYPES, "note");
}

function statusId(value, fallback = "active") {
  return listId(value, KNOWLEDGE_STATUSES, fallback);
}

function tags(value) {
  const list = Array.isArray(value) ? value : text(value).split(/[,，\n]/);
  return [...new Set(list.map((item) => text(item)).filter(Boolean))].slice(0, 20);
}

function safeName(value) {
  return text(value).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").slice(0, 64) || "未命名知识";
}

function asIso(value, fallback = "") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseMarkdown(raw) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(String(raw || ""));
  if (!match) return { meta: {}, body: String(raw || "") };
  try { return { meta: YAML.parse(match[1]) || {}, body: match[2] || "" }; }
  catch { return { meta: {}, body: match[2] || "" }; }
}

function noteMetadata(input = {}, { now = new Date(), fallback = {} } = {}) {
  const rawCategory = text(input.category ?? fallback.category);
  const category = categoryId(rawCategory);
  const rawStatus = input.status ?? fallback.status;
  const legacyArchive = rawCategory.toLowerCase() === "archive";
  const status = category === "recycle-bin"
    ? "recycled"
    : statusId(rawStatus, legacyArchive ? "archived" : "active");
  const createdAt = asIso(input.createdAt ?? fallback.createdAt, now.toISOString());
  const updatedAt = asIso(input.updatedAt ?? fallback.updatedAt, now.toISOString());
  const recycledAt = category === "recycle-bin"
    ? asIso(input.recycledAt ?? fallback.recycledAt, now.toISOString())
    : "";
  return {
    title: text(input.title ?? fallback.title) || "未命名知识",
    category,
    type: typeId(input.type ?? fallback.type),
    status,
    project: text(input.project ?? fallback.project).slice(0, 120),
    source: text(input.source ?? fallback.source).slice(0, 500),
    tags: tags(input.tags ?? fallback.tags),
    pinned: input.pinned === undefined ? Boolean(fallback.pinned) : input.pinned === true || input.pinned === "true",
    createdAt,
    updatedAt,
    ...(text(input.originalCategory ?? fallback.originalCategory) ? { originalCategory: categoryId(input.originalCategory ?? fallback.originalCategory) } : {}),
    ...(text(input.originalStatus ?? fallback.originalStatus) ? { originalStatus: statusId(input.originalStatus ?? fallback.originalStatus) } : {}),
    ...(recycledAt ? { recycledAt } : {})
  };
}

function formatMarkdown(meta, body) {
  const normalized = noteMetadata(meta, { fallback: meta });
  const frontMatter = YAML.stringify(normalized).trimEnd();
  const content = text(body) || `# ${normalized.title}\n\n`;
  return `---\n${frontMatter}\n---\n\n${content}\n`;
}

function usageRecord(value = {}) {
  return {
    lastUsedAt: asIso(value.lastUsedAt, ""),
    usedCount: Math.max(0, Number(value.usedCount || 0)),
    lastAction: text(value.lastAction).slice(0, 40)
  };
}

function searchableText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function searchTerms(value) {
  const normalized = searchableText(value);
  const terms = new Set();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_.-]{1,}|[\u3400-\u9fff]{2,}/g) || []) {
    terms.add(token);
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      for (let index = 0; index < token.length - 1 && terms.size < 36; index += 1) terms.add(token.slice(index, index + 2));
    }
    if (terms.size >= 36) break;
  }
  return [...terms].filter((item) => item.length >= 2);
}

function compactExcerpt(value, terms = [], limit = 560) {
  const source = String(value || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const normalized = source.toLowerCase();
  const offset = terms.reduce((best, term) => {
    const index = normalized.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const start = offset > 100 ? Math.max(0, offset - 100) : 0;
  const prefix = start > 0 ? "..." : "";
  const excerpt = source.slice(start, start + limit);
  return `${prefix}${excerpt}${start + limit < source.length ? "..." : ""}`;
}

function knowledgeContentHash(title, body) {
  return crypto.createHash("sha256").update(`${text(title).toLowerCase()}\n${String(body || "").replace(/\s+/g, " ").trim()}`).digest("hex");
}

function knowledgeDisplaySummary(meta = {}, body = "") {
  const explicit = text(meta.summary);
  if (explicit) return explicit.slice(0, 240);
  const content = String(body || "")
    .replace(/^\s*#\s+.*(?:\r?\n|$)/, "")
    .replace(/<!--[^]*?-->/g, "")
    .trim();
  if (!content) return "";
  if (/^auto-summary\//i.test(text(meta.source))) {
    const modelSummary = content.split(/\r?\n\s*\r?\n|\r?\n(?=##\s)/)[0]?.replace(/^#+\s*/, "").trim();
    if (modelSummary) return modelSummary.slice(0, 240);
  }
  return summarize(content, { maxSentences: 3, maxLength: 240 });
}

class KnowledgeVault {
  constructor({
    rootProvider,
    now = () => new Date(),
    inactiveDays = DEFAULT_INACTIVE_DAYS,
    recycleRetentionDays = DEFAULT_RECYCLE_RETENTION_DAYS,
    enableSearchIndex = true,
    SearchIndexClass = null
  }) {
    this.rootProvider = rootProvider;
    this.now = now;
    this.inactiveDays = Math.max(1, Number(inactiveDays) || DEFAULT_INACTIVE_DAYS);
    this.recycleRetentionDays = Math.max(1, Number(recycleRetentionDays) || DEFAULT_RECYCLE_RETENTION_DAYS);
    this.lastCleanup = null;
    this.enableSearchIndex = enableSearchIndex !== false;
    this.SearchIndexClass = SearchIndexClass;
    this.searchIndexInstance = null;
    this.searchIndexDbPath = "";
    this.searchIndexError = null;
    this.indexReconcilePromise = null;
    this.indexReconcileState = { status: "idle", completedAt: "", error: "" };
  }

  nowDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  root() {
    const root = path.resolve(this.rootProvider());
    const knowledgeRoot = path.join(root, "knowledge");
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    for (const item of CATEGORIES) fs.mkdirSync(path.join(knowledgeRoot, item.id), { recursive: true });
    return knowledgeRoot;
  }

  systemRoot() {
    const systemRoot = path.join(this.root(), ".baiqiu");
    fs.mkdirSync(systemRoot, { recursive: true });
    return systemRoot;
  }

  indexDbPath() {
    return path.join(this.systemRoot(), "knowledge-index.sqlite");
  }

  ensureSearchIndex() {
    if (!this.enableSearchIndex) return null;
    const currentDbPath = this.indexDbPath();
    if (this.searchIndexInstance && this.searchIndexDbPath === currentDbPath) return this.searchIndexInstance;
    if (this.searchIndexInstance) {
      try { this.searchIndexInstance.close?.(); }
      catch {}
      this.searchIndexInstance = null;
    }
    this.searchIndexError = null;
    try {
      const SearchIndex = this.SearchIndexClass || require("./knowledge-search-index").KnowledgeSearchIndex;
      this.searchIndexInstance = new SearchIndex({ dbPath: currentDbPath });
      this.searchIndexDbPath = currentDbPath;
      return this.searchIndexInstance;
    } catch (error) {
      this.searchIndexError = error;
      return null;
    }
  }

  indexFile(file) {
    const index = this.ensureSearchIndex();
    if (!index || !fs.existsSync(file)) return false;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const stat = fs.statSync(file);
      const note = this.digest(file);
      index.upsert({
        ...note,
        body: parseMarkdown(raw).body || "",
        mtimeMs: stat.mtimeMs,
        contentHash: knowledgeContentHash(note.title, parseMarkdown(raw).body || "")
      });
      return true;
    } catch {
      return false;
    }
  }

  removeFromIndex(id) {
    try { this.ensureSearchIndex()?.remove(id); }
    catch {}
  }

  initializeIndex() {
    if (!this.enableSearchIndex) return Promise.resolve({ ok: false, skipped: true, reason: "disabled" });
    if (this.indexReconcilePromise) return this.indexReconcilePromise;
    this.ensureSearchIndex();
    if (this.searchIndexError) {
      return Promise.resolve({ ok: false, skipped: true, reason: "index_unavailable", error: this.searchIndexError.message || String(this.searchIndexError) });
    }
    this.indexReconcileState = { status: "initializing", completedAt: "", error: "" };
    this.indexReconcilePromise = new Promise((resolve) => {
      const worker = new Worker(path.join(__dirname, "knowledge-index-worker.js"), {
        workerData: { storageRoot: path.dirname(this.root()), dbPath: this.indexDbPath(), cleanup: false }
      });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.indexReconcileState = result?.ok
          ? { status: "ready", completedAt: result.completedAt || new Date().toISOString(), error: "", ...result }
          : { status: "degraded", completedAt: "", error: result?.error || "索引初始化失败" };
        this.indexReconcilePromise = null;
        resolve(result);
      };
      worker.once("message", (message) => {
        if (message?.type === "complete") finish(message.result);
        else finish({ ok: false, error: message?.error || "索引 Worker 返回异常" });
      });
      worker.once("error", (error) => finish({ ok: false, error: error?.message || String(error) }));
      worker.once("exit", (code) => {
        if (!settled) finish({ ok: code === 0, error: code === 0 ? "" : `索引 Worker 退出码 ${code}` });
      });
      worker.unref?.();
    });
    return this.indexReconcilePromise;
  }

  indexStatus() {
    const index = this.ensureSearchIndex();
    return {
      ...this.indexReconcileState,
      available: Boolean(index),
      total: index ? index.count() : 0,
      error: this.indexReconcileState.error || this.searchIndexError?.message || ""
    };
  }

  usageFile() {
    return path.join(this.systemRoot(), "knowledge-usage.json");
  }

  auditFile() {
    return path.join(this.systemRoot(), "knowledge-audit.jsonl");
  }

  audit(action, details = {}) {
    try {
      fs.appendFileSync(this.auditFile(), `${JSON.stringify({
        at: this.nowDate().toISOString(),
        action: text(action).slice(0, 60),
        ...details
      })}\n`, "utf8");
    } catch {}
  }

  recentAudit(limit = 30) {
    try {
      return fs.readFileSync(this.auditFile(), "utf8").split(/\r?\n/).filter(Boolean)
        .slice(-Math.max(1, Math.min(100, Number(limit) || 30)))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  readUsageStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usageFile(), "utf8"));
      return { version: 1, entries: parsed && typeof parsed.entries === "object" ? parsed.entries : {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  writeUsageStore(store) {
    const target = this.usageFile();
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: store.entries || {} }, null, 2), "utf8");
    fs.renameSync(temporary, target);
  }

  usageFor(id, store = this.readUsageStore()) {
    return usageRecord(store.entries?.[id]);
  }

  recordUse(id, action = "opened", { now = this.nowDate(), increment = true } = {}) {
    const store = this.readUsageStore();
    const current = this.usageFor(id, store);
    store.entries[id] = {
      lastUsedAt: now.toISOString(),
      usedCount: current.usedCount + (increment ? 1 : 0),
      lastAction: action
    };
    this.writeUsageStore(store);
    return store.entries[id];
  }

  moveUsage(previousId, nextId, action = "moved") {
    if (!previousId || previousId === nextId) return;
    const store = this.readUsageStore();
    const previous = this.usageFor(previousId, store);
    const current = this.usageFor(nextId, store);
    store.entries[nextId] = {
      lastUsedAt: current.lastUsedAt || previous.lastUsedAt,
      usedCount: Math.max(current.usedCount, previous.usedCount),
      lastAction: action
    };
    delete store.entries[previousId];
    this.writeUsageStore(store);
  }

  removeUsage(id) {
    const store = this.readUsageStore();
    if (!store.entries?.[id]) return;
    delete store.entries[id];
    this.writeUsageStore(store);
  }

  idFor(file) {
    return path.relative(this.root(), file).replace(/\\/g, "/");
  }

  fileFor(id) {
    const root = this.root();
    const file = path.resolve(root, String(id || "").replace(/^[/\\]+/, ""));
    if (!/\.md$/i.test(file) || (file !== root && !file.startsWith(`${root}${path.sep}`))) throw new Error("知识条目路径无效");
    return file;
  }

  digest(file, { usageStore = this.readUsageStore() } = {}) {
    const stat = fs.statSync(file);
    const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
    const relative = this.idFor(file).split("/");
    const rawCategory = parsed.meta.category || relative[0];
    const meta = noteMetadata(parsed.meta, {
      now: new Date(stat.mtimeMs),
      fallback: {
        category: rawCategory,
        status: String(rawCategory).toLowerCase() === "archive" ? "archived" : "active",
        createdAt: new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs).toISOString(),
        updatedAt: stat.mtime.toISOString()
      }
    });
    const body = String(parsed.body || "");
    const summary = knowledgeDisplaySummary(meta, body);
    const knowledgeUnits = body.replace(/\s+/g, "").length;
    const level = Math.min(9, Math.floor(knowledgeUnits / 400) + 1);
    const progress = level >= 9 ? 100 : Math.round((knowledgeUnits % 400) / 4);
    const usage = this.usageFor(this.idFor(file), usageStore);
    return {
      id: this.idFor(file),
      title: meta.title,
      category: meta.category,
      categoryLabel: CATEGORIES.find((item) => item.id === meta.category)?.label || "收件箱",
      type: meta.type,
      typeLabel: KNOWLEDGE_TYPES.find((item) => item.id === meta.type)?.label || "知识笔记",
      status: meta.status,
      statusLabel: KNOWLEDGE_STATUSES.find((item) => item.id === meta.status)?.label || "使用中",
      project: meta.project,
      source: meta.source,
      pinned: meta.pinned,
      originalCategory: meta.originalCategory || "",
      originalStatus: meta.originalStatus || "",
      recycledAt: meta.recycledAt || "",
      tags: meta.tags,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastUsedAt: usage.lastUsedAt,
      usedCount: usage.usedCount,
      lastAction: usage.lastAction,
      filePath: file,
      pathLabel: file,
      byteSize: stat.size,
      knowledgeUnits,
      level,
      progress,
      summary,
      excerpt: summary
    };
  }

  files() {
    const result = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(file);
      }
    };
    walk(this.root());
    return result;
  }

  notes() {
    const usageStore = this.readUsageStore();
    const scanErrors = [];
    const notes = this.files().map((file) => {
      try { return this.digest(file, { usageStore }); }
      catch (error) {
        scanErrors.push({ filePath: file, error: error.message || String(error) });
        return null;
      }
    }).filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { notes, scanErrors };
  }

  indexState() {
    const index = this.ensureSearchIndex();
    if (!index) return null;
    const usageStore = this.readUsageStore();
    const notes = index.documents().map((row) => {
      const category = categoryId(row.category);
      const status = statusId(row.status, "active");
      const knowledgeUnits = Math.max(0, Number(row.knowledge_units || 0));
      const level = Math.min(9, Math.floor(knowledgeUnits / 400) + 1);
      const usage = this.usageFor(row.id, usageStore);
      return {
        id: row.id,
        title: row.title || "未命名知识",
        category,
        categoryLabel: CATEGORIES.find((item) => item.id === category)?.label || category,
        type: typeId(row.type),
        typeLabel: KNOWLEDGE_TYPES.find((item) => item.id === typeId(row.type))?.label || "知识笔记",
        status,
        statusLabel: KNOWLEDGE_STATUSES.find((item) => item.id === status)?.label || status,
        project: row.project || "",
        source: row.source || "",
        pinned: Boolean(row.pinned),
        originalCategory: row.original_category || "",
        originalStatus: row.original_status || "",
        recycledAt: row.recycled_at || "",
        tags: tags(row.tags_json),
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || "",
        lastUsedAt: usage.lastUsedAt,
        usedCount: usage.usedCount,
        lastAction: usage.lastAction,
        filePath: row.file_path,
        pathLabel: row.file_path,
        byteSize: Math.max(0, Number(row.byte_size || 0)),
        knowledgeUnits,
        level,
        progress: level >= 9 ? 100 : Math.round((knowledgeUnits % 400) / 4),
        summary: row.excerpt || "",
        excerpt: row.excerpt || ""
      };
    });
    const counts = Object.fromEntries(CATEGORIES.map((item) => [item.id, 0]));
    for (const note of notes) counts[note.category] = (counts[note.category] || 0) + 1;
    return {
      root: this.root(),
      total: notes.length,
      totalKnowledgeUnits: notes.reduce((sum, note) => sum + note.knowledgeUnits, 0),
      totalBytes: notes.reduce((sum, note) => sum + note.byteSize, 0),
      scanErrors: [],
      latestUpdatedAt: notes[0]?.updatedAt || "",
      cleanup: this.lastCleanup || { movedToRecycle: 0, permanentlyDeleted: 0, inactiveDays: this.inactiveDays, recycleRetentionDays: this.recycleRetentionDays },
      categories: CATEGORIES.map((item) => ({ ...item, count: counts[item.id] || 0 })),
      types: KNOWLEDGE_TYPES,
      statuses: KNOWLEDGE_STATUSES,
      recentAudit: this.recentAudit(),
      notes,
      indexed: true,
      indexPending: this.indexReconcileState.status !== "ready"
    };
  }

  search(query = "", { limit = 4, project = "", includeRecycled = false, retrievalOnly = false, projectScope = false, includeGlobal = false, allowGlobal = false, entity = "", sessionId = "", excludeAutoSummaries = false, budgetMs = 80 } = {}) {
    const normalizedQuery = searchableText(query);
    const terms = searchTerms(normalizedQuery);
    if (normalizedQuery.length < 2 || !terms.length) return { query: text(query), total: 0, results: [] };
    const index = this.ensureSearchIndex();
    if (!index) return { query: text(query), total: 0, results: [], degraded: true, reason: "index_unavailable" };
    if (index.count() === 0 && this.indexReconcileState.status === "idle") void this.initializeIndex();
    try {
      const result = index.search(query, { limit, project, includeRecycled, retrievalOnly, projectScope, includeGlobal, allowGlobal, entity, sessionId, excludeAutoSummaries, budgetMs });
      for (const note of result.results || []) this.recordUse(note.id, "retrieved");
      if (result.results?.length) this.audit("retrieved", { ids: result.results.map((note) => note.id), project: text(project).slice(0, 120) });
      return result;
    } catch (error) {
      return { query: text(query), total: 0, results: [], degraded: true, reason: "index_query_failed", error: error?.message || String(error) };
    }
  }

  findBySource(source) {
    try { return this.ensureSearchIndex()?.findBySource(source) || null; }
    catch { return null; }
  }

  importMarkdown(files = [], { category = "inbox" } = {}) {
    const imported = [];
    const skipped = [];
    const errors = [];
    const root = this.root();
    const index = this.ensureSearchIndex();
    for (const input of Array.isArray(files) ? files.slice(0, 100) : []) {
      const sourceFile = path.resolve(String(input || ""));
      try {
        if (!/\.(?:md|markdown)$/i.test(sourceFile) || !fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) throw new Error("只支持存在的 Markdown 文件");
        if (sourceFile.startsWith(`${root}${path.sep}`)) {
          this.indexFile(sourceFile);
          imported.push(this.digest(sourceFile));
          continue;
        }
        const raw = fs.readFileSync(sourceFile, "utf8");
        const parsed = parseMarkdown(raw);
        const bodyTitle = String(parsed.body || "").match(/^\s*#\s+(.+)$/m)?.[1] || "";
        const title = text(parsed.meta.title || bodyTitle || path.basename(sourceFile, path.extname(sourceFile)));
        const duplicate = index?.findByContentHash?.(knowledgeContentHash(title, parsed.body || ""));
        if (duplicate) {
          skipped.push({ filePath: sourceFile, reason: "duplicate_content", existingId: duplicate.id });
          continue;
        }
        const now = this.nowDate();
        const meta = noteMetadata({
          ...parsed.meta,
          title,
          category: parsed.meta.category || category,
          status: parsed.meta.status || "active",
          source: parsed.meta.source || `导入/${sourceFile}`,
          createdAt: parsed.meta.createdAt || now.toISOString(),
          updatedAt: now.toISOString()
        }, { now, fallback: parsed.meta });
        const target = this.unique(path.join(root, meta.category, `${now.toISOString().replace(/[T:-]/g, "").slice(0, 15)}-${safeName(title)}.md`));
        this.writeNote(target, meta, parsed.body || `# ${title}\n\n`);
        const id = this.idFor(target);
        this.recordUse(id, "imported", { now });
        this.indexFile(target);
        this.audit("imported", { id, sourceFile, category: meta.category, type: meta.type, status: meta.status });
        imported.push(this.digest(target));
      } catch (error) {
        errors.push({ filePath: sourceFile, error: error?.message || String(error) });
      }
    }
    return { imported, skipped, errors, state: this.state() };
  }

  buildState({ cleanup = null, scanned = null } = {}) {
    const snapshot = scanned || this.notes();
    const { notes, scanErrors } = snapshot;
    const counts = Object.fromEntries(CATEGORIES.map((item) => [item.id, 0]));
    for (const note of notes) counts[note.category] = (counts[note.category] || 0) + 1;
    return {
      root: this.root(),
      total: notes.length,
      totalKnowledgeUnits: notes.reduce((sum, note) => sum + Number(note.knowledgeUnits || 0), 0),
      totalBytes: notes.reduce((sum, note) => sum + Number(note.byteSize || 0), 0),
      scanErrors,
      latestUpdatedAt: notes[0]?.updatedAt || "",
      cleanup: cleanup || this.lastCleanup || { movedToRecycle: 0, permanentlyDeleted: 0, inactiveDays: this.inactiveDays, recycleRetentionDays: this.recycleRetentionDays },
      categories: CATEGORIES.map((item) => ({ ...item, count: counts[item.id] || 0 })),
      types: KNOWLEDGE_TYPES,
      statuses: KNOWLEDGE_STATUSES,
      recentAudit: this.recentAudit(),
      notes
    };
  }

  state({ preferIndex = false } = {}) {
    if (preferIndex) {
      const indexed = this.indexState();
      if (indexed) return indexed;
    }
    return this.buildState({ scanned: this.notes() });
  }

  unique(file) {
    if (!fs.existsSync(file)) return file;
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    let index = 2;
    while (fs.existsSync(`${base}-${index}${ext}`)) index += 1;
    return `${base}-${index}${ext}`;
  }

  writeNote(file, meta, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatMarkdown(meta, body), "utf8");
  }

  create(payload = {}) {
    const now = this.nowDate();
    const category = categoryId(payload.category);
    const title = text(payload.title) || "未命名知识";
    const stamp = now.toISOString().replace(/[T:-]/g, "").slice(0, 15);
    const file = this.unique(path.join(this.root(), category, `${stamp}-${safeName(title)}.md`));
    const meta = noteMetadata({ ...payload, title, category, createdAt: now.toISOString(), updatedAt: now.toISOString() }, { now });
    this.writeNote(file, meta, payload.body || `# ${title}\n\n`);
    const id = this.idFor(file);
    this.recordUse(id, "created", { now });
    this.indexFile(file);
    this.audit("created", { id, category: meta.category, type: meta.type, status: meta.status, source: meta.source });
    return { note: this.digest(file), state: this.state() };
  }

  read(id, { trackUsage = true } = {}) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw new Error("知识条目不存在");
    const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
    if (trackUsage) this.recordUse(this.idFor(file), "opened");
    return { note: this.digest(file), body: parsed.body || "", content: fs.readFileSync(file, "utf8"), meta: parsed.meta || {} };
  }

  update(id, payload = {}) {
    const file = this.fileFor(id);
    const current = this.read(id, { trackUsage: false });
    const now = this.nowDate();
    const category = categoryId(payload.category ?? current.note.category);
    const status = category === "recycle-bin"
      ? "recycled"
      : statusId(payload.status ?? current.note.status, current.note.status || "active");
    const meta = noteMetadata({
      ...current.meta,
      ...payload,
      title: text(payload.title) || current.note.title,
      category,
      status,
      createdAt: current.note.createdAt,
      updatedAt: now.toISOString(),
      recycledAt: category === "recycle-bin" ? (payload.recycledAt || current.note.recycledAt || now.toISOString()) : ""
    }, { now, fallback: current.meta });
    const target = category === current.note.category ? file : this.unique(path.join(this.root(), category, path.basename(file)));
    this.writeNote(target, meta, payload.body ?? current.body);
    if (target !== file && fs.existsSync(file)) fs.unlinkSync(file);
    const nextId = this.idFor(target);
    if (nextId !== id) this.removeFromIndex(id);
    this.indexFile(target);
    this.moveUsage(id, nextId, "updated");
    this.recordUse(nextId, "updated", { now });
    this.audit("updated", { id: nextId, previousId: id !== nextId ? id : "", category: meta.category, type: meta.type, status: meta.status });
    return { note: this.digest(target), state: this.state() };
  }

  recycle(id, { reason = "manual", includeState = true } = {}) {
    const file = this.fileFor(id);
    const current = this.read(id, { trackUsage: false });
    if (current.note.category === "recycle-bin") return { note: current.note, action: "already-recycled", state: includeState ? this.state() : null };
    const now = this.nowDate();
    const target = this.unique(path.join(this.root(), "recycle-bin", path.basename(file)));
    const meta = noteMetadata({
      ...current.meta,
      category: "recycle-bin",
      status: "recycled",
      originalCategory: current.note.category,
      originalStatus: current.note.status,
      recycledAt: now.toISOString(),
      updatedAt: now.toISOString()
    }, { now, fallback: current.meta });
    this.writeNote(target, meta, current.body);
    fs.unlinkSync(file);
    const nextId = this.idFor(target);
    this.removeFromIndex(id);
    this.indexFile(target);
    this.moveUsage(id, nextId, reason === "inactive" ? "auto-recycled" : "recycled");
    this.audit(reason === "inactive" ? "auto_recycled" : "recycled", { id: nextId, previousId: id, originalCategory: current.note.category, originalStatus: current.note.status });
    return { note: this.digest(target), action: "recycled", state: includeState ? this.state() : null };
  }

  restore(id) {
    const file = this.fileFor(id);
    const current = this.read(id, { trackUsage: false });
    if (current.note.category !== "recycle-bin") throw new Error("只有回收站中的知识可以恢复");
    const now = this.nowDate();
    const category = categoryId(current.note.originalCategory || "inbox");
    const target = this.unique(path.join(this.root(), category, path.basename(file)));
    const status = statusId(current.note.originalStatus || "active");
    const meta = noteMetadata({
      ...current.meta,
      category,
      status,
      originalCategory: "",
      originalStatus: "",
      recycledAt: "",
      updatedAt: now.toISOString()
    }, { now, fallback: current.meta });
    delete meta.originalCategory;
    delete meta.originalStatus;
    delete meta.recycledAt;
    this.writeNote(target, meta, current.body);
    fs.unlinkSync(file);
    const nextId = this.idFor(target);
    this.removeFromIndex(id);
    this.indexFile(target);
    this.moveUsage(id, nextId, "restored");
    this.recordUse(nextId, "restored", { now });
    this.audit("restored", { id: nextId, previousId: id, category, status });
    return { note: this.digest(target), action: "restored", state: this.state() };
  }

  remove(id) {
    const current = this.read(id, { trackUsage: false });
    if (current.note.category !== "recycle-bin") return this.recycle(id);
    const file = this.fileFor(id);
    fs.unlinkSync(file);
    this.removeFromIndex(id);
    this.removeUsage(id);
    this.audit("deleted", { id, previousCategory: current.note.category, previousStatus: current.note.status });
    return { ok: true, action: "deleted", state: this.state() };
  }

  protectedFromCleanup(note) {
    if (Boolean(note.pinned)) return true;
    // 回收站条目以 originalStatus/originalCategory 为准（status 被 recycle 改写为 recycled）
    const status = note.status === "recycled" ? (note.originalStatus || "recycled") : note.status;
    const category = note.category === "recycle-bin" ? (note.originalCategory || "recycle-bin") : note.category;
    return status === "confirmed" || category === "my-skills";
  }

  cleanupInactive({ permanentlyDelete = false, scanned = null } = {}) {
    const now = this.nowDate();
    const report = {
      completedAt: now.toISOString(),
      movedToRecycle: 0,
      permanentlyDeleted: 0,
      inactiveDays: this.inactiveDays,
      recycleRetentionDays: this.recycleRetentionDays
    };
    const { notes } = scanned || this.notes();
    for (const note of notes) {
      if (note.category === "recycle-bin") {
        // 受保护项（confirmed/pinned/my-skills）即使进了回收站也不自动永久删除，
        // 只能由用户手动 remove() 或 restore() 处理。
        if (this.protectedFromCleanup(note)) continue;
        const recycledAt = new Date(note.recycledAt || note.updatedAt || note.createdAt).getTime();
        if (permanentlyDelete && Number.isFinite(recycledAt) && now.getTime() - recycledAt >= this.recycleRetentionDays * DAY_MS) {
          try {
            fs.unlinkSync(this.fileFor(note.id));
            this.removeFromIndex(note.id);
            this.removeUsage(note.id);
            report.permanentlyDeleted += 1;
          } catch {}
        }
        continue;
      }
      if (this.protectedFromCleanup(note)) continue;
      // 活性判定只认 lastUsedAt/updatedAt；从未使用（两者皆空，如历史导入笔记）
      // 不按创建时间老化，避免"刚沉淀就被清理"。
      const inactiveAt = new Date(note.lastUsedAt || note.updatedAt).getTime();
      if (!Number.isFinite(inactiveAt)) continue;
      if (now.getTime() - inactiveAt < this.inactiveDays * DAY_MS) continue;
      try {
        this.recycle(note.id, { reason: "inactive", includeState: false });
        report.movedToRecycle += 1;
      } catch {}
    }
    this.lastCleanup = report;
    return report;
  }

  close() {
    try { this.searchIndexInstance?.close?.(); }
    catch {}
    this.searchIndexInstance = null;
    this.searchIndexDbPath = "";
  }
}

module.exports = {
  KnowledgeVault,
  parseMarkdown,
  knowledgeContentHash,
  KNOWLEDGE_VAULT_CATEGORIES: CATEGORIES,
  KNOWLEDGE_VAULT_TYPES: KNOWLEDGE_TYPES,
  KNOWLEDGE_VAULT_STATUSES: KNOWLEDGE_STATUSES,
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_RECYCLE_RETENTION_DAYS
};
