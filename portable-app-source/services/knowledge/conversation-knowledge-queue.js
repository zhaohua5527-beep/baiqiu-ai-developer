"use strict";

const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { meaningfulMessages, isWorkMessage } = require("../memory-distiller");

const CATEGORY_IDS = new Set(["inbox", "projects", "resources", "templates"]);
const TYPE_IDS = new Set(["note", "decision", "plan", "task-record", "data", "resource", "method", "template", "idea"]);
const ACTION_IDS = new Set(["create", "skip", "merge", "conflict"]);
const MAX_ATTEMPTS = 3;

function clean(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function json(value, fallback) {
  try { return JSON.parse(String(value || "")); }
  catch { return fallback; }
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function unique(values, limit = 20, itemLimit = 500) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = clean(value, itemLimit);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function containsSensitiveText(value) {
  const source = String(value || "");
  return /(api[_-]?key|token|secret|password|密码|密钥)\s*[:=：]\s*\S{8,}/i.test(source)
    || /\bsk-[a-z0-9_-]{12,}\b/i.test(source)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(source);
}

function verifiedTaskMessage(message = {}) {
  if (message.role !== "assistant") return true;
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const product = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : null;
  const taskBound = Boolean(raw.taskBrain || raw.hmsNativeProject || product?.taskBrain || product?.taskId);
  if (!taskBound) return true;
  const status = clean(product?.status || raw.status, 80).toLowerCase();
  const verifiedProject = Boolean(
    (raw.hmsNativeProject || product?.hmsNativeProject)
    && (product?.success === true || raw.success === true)
    && ["completed", "success"].includes(status)
  );
  return verifiedProject || Boolean(product?.verified === true && ["completed", "success"].includes(status));
}

function eligibleMessages(messages = []) {
  return messages.filter((message) => {
    if (!message || !message.id) return false;
    if (message.raw?.knowledgeSummary || message.raw?.autoKnowledge) return false;
    if (!verifiedTaskMessage(message)) return false;
    if (message.role === "assistant" && (message.raw?.error || /^(执行失败|任务失败|发生错误|连接失败)/.test(clean(message.text, 120)))) return false;
    return !containsSensitiveText(message.text);
  });
}

function candidateFromMessages({ sessionId, projectId = "", projectName = "", taskId = "", messages = [], checkpointId = "", trigger = "idle" } = {}) {
  const checkpointIndex = checkpointId ? messages.findIndex((item) => String(item?.id || "") === checkpointId) : -1;
  const delta = eligibleMessages(messages.slice(checkpointIndex + 1).slice(-60));
  const verifiedTaskEvidence = delta.some((message) => {
    if (message?.role !== "assistant" || !verifiedTaskMessage(message)) return false;
    const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
    const product = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : null;
    return Boolean(raw.taskBrain || raw.hmsNativeProject || product?.taskBrain || product?.taskId);
  });
  const normalized = meaningfulMessages(delta).map((item) => {
    const source = delta.find((message) => message.role === item.role && clean(message.text, 4000) === item.text);
    return { ...item, id: source?.id || "", createdAt: source?.createdAt || 0 };
  }).filter((item) => item.id);
  const work = normalized.filter(isWorkMessage);
  const hasUser = work.some((item) => item.role === "user");
  const hasAssistant = normalized.some((item) => item.role === "assistant");
  if (!hasUser || !hasAssistant) return null;
  const selected = normalized.slice(-30);
  const messageIds = selected.map((item) => item.id);
  const transcript = selected.map((item) => `${item.role === "assistant" ? "黑球/白球" : "用户"}：${clean(item.text, 4000)}`).join("\n\n").slice(0, 28000);
  if (transcript.length < 40) return null;
  return {
    id: `knowledge-summary:${hash(`${sessionId}\n${taskId}\n${messageIds.join("\n")}`)}`,
    sessionId: clean(sessionId, 200),
    projectId: clean(projectId, 200),
    projectName: clean(projectName, 300),
    taskId: clean(taskId, 200),
    trigger: clean(trigger, 40) || "idle",
    verifiedTaskEvidence,
    messageIds,
    lastMessageId: messageIds.at(-1) || "",
    searchText: work.slice(-4).map((item) => item.text).join(" ").slice(0, 2400),
    transcript
  };
}

function normalizeDecision(value = {}, candidate = {}) {
  const sourceIds = new Set(candidate.messageIds || []);
  const action = ACTION_IDS.has(clean(value.action, 30)) ? clean(value.action, 30) : (value.shouldSave === false ? "skip" : "create");
  const shouldSave = value.shouldSave !== false && action !== "skip";
  const confidence = Math.max(0, Math.min(1, Number(value.confidence || 0)));
  const candidateStatus = confidence >= 0.82 && candidate.verifiedTaskEvidence === true && action !== "conflict"
    ? "active"
    : "draft";
  return {
    shouldSave,
    action,
    targetNoteId: clean(value.targetNoteId, 1000),
    title: clean(value.title, 64) || clean(candidate.projectName, 64) || "会话知识归纳",
    summary: clean(value.summary, 12000),
    category: CATEGORY_IDS.has(clean(value.category, 80)) ? clean(value.category, 80) : (candidate.projectId ? "projects" : "inbox"),
    type: TYPE_IDS.has(clean(value.type, 80)) ? clean(value.type, 80) : "note",
    projectId: clean(candidate.projectId, 200),
    projectName: clean(candidate.projectName, 300),
    tags: unique(value.tags, 12, 80),
    decisions: unique(value.decisions, 12, 600),
    constraints: unique(value.constraints, 12, 600),
    nextSteps: unique(value.nextSteps, 12, 600),
    importance: Math.max(0, Math.min(1, Number(value.importance || 0))),
    confidence,
    candidateStatus,
    sourceMessageIds: unique(value.sourceMessageIds, 30, 200).filter((id) => sourceIds.has(id))
  };
}

class ConversationKnowledgeQueue {
  constructor({ dbPath, summarize, save, promote = null, isBusy = () => false, now = () => Date.now(), retryDelayMs = 60000, autoWake = true, DatabaseClass = Database } = {}) {
    if (!dbPath) throw new Error("Knowledge queue database path is required");
    if (typeof summarize !== "function" || typeof save !== "function") throw new Error("Knowledge queue summarize and save handlers are required");
    this.db = new DatabaseClass(dbPath);
    this.db.pragma("busy_timeout = 75");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.summarize = summarize;
    this.save = save;
    this.promote = typeof promote === "function" ? promote : null;
    this.isBusy = isBusy;
    this.now = now;
    this.retryDelayMs = Math.max(1000, Number(retryDelayMs) || 60000);
    this.autoWake = autoWake !== false;
    this.running = false;
    this.timer = null;
    this.closed = false;
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_summary_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_summary_jobs_ready
        ON knowledge_summary_jobs(state, not_before, created_at);
      CREATE TABLE IF NOT EXISTS knowledge_summary_checkpoints (
        session_id TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_summary_fingerprints (
        content_hash TEXT PRIMARY KEY,
        note_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    this.db.prepare("UPDATE knowledge_summary_jobs SET state = 'retry', error = '应用退出时中断' WHERE state = 'processing'").run();
  }

  checkpoint(sessionId) {
    return this.db.prepare("SELECT last_message_id FROM knowledge_summary_checkpoints WHERE session_id = ?").pluck().get(clean(sessionId, 200)) || "";
  }

  schedule(input = {}) {
    const sessionId = clean(input.sessionId, 200);
    if (!sessionId) return { queued: false, reason: "missing_session" };
    const candidate = candidateFromMessages({ ...input, sessionId, checkpointId: this.checkpoint(sessionId) });
    if (!candidate) return { queued: false, reason: "no_knowledge_candidate" };
    const now = Number(this.now());
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_summary_jobs
        (id, session_id, project_id, payload_json, state, attempts, not_before, created_at, updated_at, error)
      VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?, '')
    `).run(candidate.id, candidate.sessionId, candidate.projectId, JSON.stringify(candidate), now, now);
    if (result.changes && this.autoWake) this.wake(0);
    return { queued: Boolean(result.changes), jobId: candidate.id, candidate };
  }

  nextJob() {
    const row = this.db.prepare(`
      SELECT * FROM knowledge_summary_jobs
      WHERE state IN ('pending', 'retry') AND not_before <= ?
      ORDER BY created_at ASC LIMIT 1
    `).get(Number(this.now()));
    if (!row) return null;
    return { ...row, payload: json(row.payload_json, {}) };
  }

  completeCheckpoint(candidate) {
    this.db.prepare(`
      INSERT INTO knowledge_summary_checkpoints(session_id, last_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_message_id=excluded.last_message_id, updated_at=excluded.updated_at
    `).run(candidate.sessionId, candidate.lastMessageId, Number(this.now()));
  }

  async drainOnce() {
    if (this.closed || this.running) return { processed: false, reason: this.closed ? "closed" : "running" };
    if (await this.isBusy()) return { processed: false, reason: "busy" };
    const job = this.nextJob();
    if (!job) return { processed: false, reason: "empty" };
    this.running = true;
    const now = Number(this.now());
    this.db.prepare("UPDATE knowledge_summary_jobs SET state='processing', attempts=attempts+1, updated_at=?, error='' WHERE id=?").run(now, job.id);
    try {
      const rawDecision = await this.summarize(job.payload);
      const decision = normalizeDecision(rawDecision, job.payload);
      if (decision.shouldSave && (!decision.summary || decision.confidence < 0.55)) {
        decision.shouldSave = false;
        decision.action = "skip";
      }
      let saved = { skipped: true, reason: "model_skipped" };
      const contentHash = hash([
        job.payload.projectId,
        job.payload.sessionId,
        job.payload.taskId,
        decision.title,
        decision.summary,
        ...decision.decisions,
        ...decision.constraints,
        ...decision.nextSteps
      ].join("\n").toLowerCase());
      const duplicate = decision.shouldSave
        ? this.db.prepare("SELECT note_id AS noteId, source FROM knowledge_summary_fingerprints WHERE content_hash = ?").get(contentHash)
        : null;
      if (decision.shouldSave && !duplicate) saved = await this.save(decision, job.payload);
      else if (decision.shouldSave && duplicate && decision.confidence >= 0.82 && this.promote) {
        saved = await this.promote(duplicate, decision, job.payload);
      }
      this.db.transaction(() => {
        if (decision.shouldSave && !duplicate) {
          this.db.prepare("INSERT OR IGNORE INTO knowledge_summary_fingerprints(content_hash, note_id, source, created_at) VALUES (?, ?, ?, ?)")
            .run(contentHash, clean(saved?.note?.id || saved?.noteId, 1000), clean(saved?.source, 1200), Number(this.now()));
        }
        this.completeCheckpoint(job.payload);
        this.db.prepare("UPDATE knowledge_summary_jobs SET state='completed', updated_at=?, error='' WHERE id=?").run(Number(this.now()), job.id);
      })();
      return { processed: true, jobId: job.id, decision, saved, duplicate: duplicate || null };
    } catch (error) {
      const attempts = Number(this.db.prepare("SELECT attempts FROM knowledge_summary_jobs WHERE id=?").pluck().get(job.id) || 1);
      const state = attempts >= MAX_ATTEMPTS ? "failed" : "retry";
      const notBefore = state === "retry" ? Number(this.now()) + this.retryDelayMs * attempts : 0;
      this.db.prepare("UPDATE knowledge_summary_jobs SET state=?, not_before=?, updated_at=?, error=? WHERE id=?")
        .run(state, notBefore, Number(this.now()), clean(error?.message || String(error), 2000), job.id);
      return { processed: true, jobId: job.id, error: error?.message || String(error), state };
    } finally {
      this.running = false;
    }
  }

  start() {
    this.closed = false;
    this.wake(0);
  }

  wake(delayMs = 0) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const result = await this.drainOnce();
      const pending = this.status().pending > 0;
      if (pending) this.wake(result.reason === "busy" ? 30000 : 1000);
    }, Math.max(0, Number(delayMs) || 0));
    this.timer.unref?.();
  }

  status() {
    const counts = Object.fromEntries(this.db.prepare("SELECT state, count(*) AS total FROM knowledge_summary_jobs GROUP BY state").all().map((row) => [row.state, Number(row.total)]));
    return {
      running: this.running,
      pending: Number(counts.pending || 0) + Number(counts.retry || 0),
      completed: Number(counts.completed || 0),
      failed: Number(counts.failed || 0),
      states: counts
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.db?.close?.();
    this.db = null;
  }
}

module.exports = {
  ConversationKnowledgeQueue,
  candidateFromMessages,
  normalizeDecision,
  containsSensitiveText,
  verifiedTaskMessage
};
