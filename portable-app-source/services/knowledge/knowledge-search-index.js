"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 8;
const MAX_QUERY_TERMS = 24;

function clean(value, limit = 4000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values, limit = MAX_QUERY_TERMS) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = clean(value, 80).toLowerCase();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function chineseBigrams(value) {
  const result = [];
  for (const sequence of String(value || "").match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 2) result.push(sequence);
    else for (let index = 0; index < sequence.length - 1; index += 1) result.push(sequence.slice(index, index + 2));
  }
  return result;
}

function searchTerms(value) {
  const source = clean(value, 2400).toLowerCase();
  const latin = source.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || [];
  return unique([...latin, ...chineseBigrams(source)]);
}

function gramsForDocument(value) {
  return unique([
    ...(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []),
    ...chineseBigrams(value)
  ], 12000).join(" ");
}

function ftsExpression(value) {
  const terms = searchTerms(value);
  if (!terms.length) return "";
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

function tagsArray(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 120)).filter(Boolean).slice(0, 20);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => clean(item, 120)).filter(Boolean).slice(0, 20) : [];
  } catch {
    return [];
  }
}

class KnowledgeSearchIndex {
  constructor({ dbPath, readonly = false, DatabaseClass = Database } = {}) {
    if (!dbPath) throw new Error("Knowledge index path is required");
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseClass(this.dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
    this.db.pragma("busy_timeout = 75");
    this.db.pragma("foreign_keys = ON");
    if (!readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.ensureSchema();
    }
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'inbox',
        type TEXT NOT NULL DEFAULT 'note',
        status TEXT NOT NULL DEFAULT 'active',
        project TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        original_category TEXT NOT NULL DEFAULT '',
        original_status TEXT NOT NULL DEFAULT '',
        recycled_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        byte_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        knowledge_units INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_project ON knowledge_documents(project);
      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_source ON knowledge_documents(source);
      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents(status, category);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
        id UNINDEXED,
        title,
        project,
        tags,
        source,
        body,
        grams,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    this.setMeta("schema_version", String(INDEX_SCHEMA_VERSION));
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO knowledge_index_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value));
  }

  getMeta(key, fallback = "") {
    return this.db.prepare("SELECT value FROM knowledge_index_meta WHERE key = ?").pluck().get(String(key)) ?? fallback;
  }

  signature(id) {
    return this.db.prepare("SELECT id, file_path AS filePath, mtime_ms AS mtimeMs, byte_size AS byteSize, content_hash AS contentHash FROM knowledge_documents WHERE id = ?").get(String(id || "")) || null;
  }

  ids() {
    return this.db.prepare("SELECT id FROM knowledge_documents").pluck().all();
  }

  count() {
    return Number(this.db.prepare("SELECT count(*) FROM knowledge_documents").pluck().get() || 0);
  }

  documents() {
    return this.db.prepare("SELECT * FROM knowledge_documents ORDER BY updated_at DESC").all();
  }

  upsert(document = {}) {
    const id = clean(document.id, 1000);
    const filePath = path.resolve(String(document.filePath || ""));
    if (!id || !filePath) throw new Error("Knowledge document id and path are required");
    const tags = tagsArray(document.tags);
    const body = String(document.body || "");
    const record = {
      id,
      filePath,
      title: clean(document.title, 300),
      category: clean(document.category, 80) || "inbox",
      type: clean(document.type, 80) || "note",
      status: clean(document.status, 80) || "active",
      project: clean(document.project, 300),
      source: clean(document.source, 1200),
      tagsJson: JSON.stringify(tags),
      pinned: document.pinned ? 1 : 0,
      originalCategory: clean(document.originalCategory, 80),
      originalStatus: clean(document.originalStatus, 80),
      recycledAt: clean(document.recycledAt, 80),
      createdAt: clean(document.createdAt, 80),
      updatedAt: clean(document.updatedAt, 80),
      byteSize: Math.max(0, Number(document.byteSize || 0)),
      mtimeMs: Math.max(0, Number(document.mtimeMs || 0)),
      contentHash: clean(document.contentHash, 128),
      knowledgeUnits: Math.max(0, Number(document.knowledgeUnits || 0)),
      excerpt: clean(document.excerpt, 1200),
      body
    };
    const searchable = [record.title, record.project, tags.join(" "), record.source, body].join("\n");
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO knowledge_documents (
          id, file_path, title, category, type, status, project, source, tags_json, pinned,
          original_category, original_status, recycled_at, created_at, updated_at, byte_size,
          mtime_ms, content_hash, knowledge_units, excerpt, body
        ) VALUES (
          @id, @filePath, @title, @category, @type, @status, @project, @source, @tagsJson, @pinned,
          @originalCategory, @originalStatus, @recycledAt, @createdAt, @updatedAt, @byteSize,
          @mtimeMs, @contentHash, @knowledgeUnits, @excerpt, @body
        ) ON CONFLICT(id) DO UPDATE SET
          file_path=excluded.file_path, title=excluded.title, category=excluded.category,
          type=excluded.type, status=excluded.status, project=excluded.project, source=excluded.source,
          tags_json=excluded.tags_json, pinned=excluded.pinned, original_category=excluded.original_category,
          original_status=excluded.original_status, recycled_at=excluded.recycled_at,
          created_at=excluded.created_at, updated_at=excluded.updated_at, byte_size=excluded.byte_size,
          mtime_ms=excluded.mtime_ms, content_hash=excluded.content_hash,
          knowledge_units=excluded.knowledge_units, excerpt=excluded.excerpt, body=excluded.body
      `).run(record);
      this.db.prepare("DELETE FROM knowledge_documents_fts WHERE id = ?").run(id);
      this.db.prepare(`
        INSERT INTO knowledge_documents_fts(id, title, project, tags, source, body, grams)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, record.title, record.project, tags.join(" "), record.source, body, gramsForDocument(searchable));
    })();
    return id;
  }

  remove(id) {
    const value = String(id || "");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM knowledge_documents_fts WHERE id = ?").run(value);
      this.db.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(value);
    })();
  }

  findBySource(source) {
    const row = this.db.prepare("SELECT * FROM knowledge_documents WHERE source = ? ORDER BY updated_at DESC LIMIT 1").get(clean(source, 1200));
    return row ? this.rowToResult(row) : null;
  }

  findByContentHash(contentHash) {
    const row = this.db.prepare("SELECT * FROM knowledge_documents WHERE content_hash = ? ORDER BY updated_at DESC LIMIT 1").get(clean(contentHash, 128));
    return row ? this.rowToResult(row) : null;
  }

  search(query = "", { limit = DEFAULT_LIMIT, project = "", category = "", includeRecycled = false, retrievalOnly = false, projectScope = false, includeGlobal = false, allowGlobal = false, entity = "", sessionId = "", excludeAutoSummaries = false, budgetMs = 1000 } = {}) {
    const expression = ftsExpression(query);
    const startedAt = Date.now();
    if (!expression) return { query: clean(query, 2400), total: 0, results: [], elapsedMs: 0 };
    const selectedLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const conditions = ["knowledge_documents_fts MATCH @expression"];
    const params = { expression, limit: selectedLimit };
    if (!includeRecycled) conditions.push("d.status <> 'recycled'", "d.category <> 'recycle-bin'");
    if (retrievalOnly) conditions.push("d.status IN ('active', 'confirmed')");
    const scopedSession = clean(sessionId, 200);
    if (excludeAutoSummaries) conditions.push("d.source NOT LIKE 'auto-summary/%'");
    else if (scopedSession) {
      conditions.push("(d.source NOT LIKE 'auto-summary/%' OR d.source LIKE @sessionAutoSummary)");
      params.sessionAutoSummary = `auto-summary/${scopedSession}/%`;
    }
    const scopedProject = clean(project, 300);
    const scopedEntity = clean(entity, 120);
    if (scopedProject) {
      conditions.push(includeGlobal
        ? "(d.project = @project COLLATE NOCASE OR d.project = '')"
        : "d.project = @project COLLATE NOCASE");
      params.project = clean(project, 300);
    } else if (scopedEntity) {
      conditions.push("(d.project = @entity COLLATE NOCASE OR (d.project = '' AND d.source NOT LIKE 'auto-summary/%' AND d.source NOT LIKE '会话/%'))");
      params.entity = scopedEntity;
    } else if (projectScope) {
      conditions.push(allowGlobal ? "d.project = ''" : "0 = 1");
    }
    if (clean(category, 80)) {
      conditions.push("d.category = @category");
      params.category = clean(category, 80);
    }
    const rows = this.db.prepare(`
      SELECT d.*, bm25(knowledge_documents_fts, 0.0, 8.0, 6.0, 5.0, 3.0, 1.0, 2.0) AS fts_rank,
             snippet(knowledge_documents_fts, 5, '', '', ' … ', 48) AS matched_snippet
      FROM knowledge_documents_fts
      JOIN knowledge_documents d ON d.id = knowledge_documents_fts.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY fts_rank ASC, d.pinned DESC, d.updated_at DESC
      LIMIT @limit
    `).all(params);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > Math.max(50, Number(budgetMs) || 1000)) {
      return { query: clean(query, 2400), total: 0, results: [], elapsedMs, degraded: true, reason: "search_budget_exceeded" };
    }
    const results = rows.map((row) => this.rowToResult(row));
    return { query: clean(query, 2400), total: results.length, results, elapsedMs };
  }

  rowToResult(row) {
    const tags = tagsArray(row.tags_json);
    const rank = Number(row.fts_rank || 0);
    const body = String(row.body || "");
    return {
      id: row.id,
      filePath: row.file_path,
      pathLabel: row.file_path,
      title: row.title,
      category: row.category,
      type: row.type,
      status: row.status,
      project: row.project,
      source: row.source,
      tags,
      pinned: Boolean(row.pinned),
      originalCategory: row.original_category,
      originalStatus: row.original_status,
      recycledAt: row.recycled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      byteSize: Number(row.byte_size || 0),
      knowledgeUnits: Number(row.knowledge_units || 0),
      excerpt: row.excerpt,
      score: Math.round(Math.max(0, -rank) * 10000) / 100,
      snippet: clean(row.matched_snippet || row.excerpt || body, 700),
      content: clean(row.matched_snippet || row.excerpt || body, 1200)
    };
  }

  close() {
    this.db?.close?.();
    this.db = null;
  }
}

module.exports = {
  KnowledgeSearchIndex,
  INDEX_SCHEMA_VERSION,
  searchTerms,
  gramsForDocument,
  ftsExpression
};
