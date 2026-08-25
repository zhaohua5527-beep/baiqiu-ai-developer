"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("./healing-safeguard");

// 错误采集与自愈台账：白球把运行中真实失败（工具/任务/执行链）记录到
// dataRoot/self-healing/incidents.jsonl，供自愈引擎诊断与学习。
// 只做记录与查询，不执行任何修改——修改决策全部交给引擎 + 护栏。

const MAX_INCIDENTS = 200;
const FINGERPRINT_WINDOW_MS = 5 * 60 * 1000;

class HealingMonitor {
  constructor(options = {}) {
    this.dataRoot = options.dataRoot || "";
    this.filePath = "";
    this.incidents = [];
    if (this.dataRoot) {
      this.filePath = path.join(this.dataRoot, "self-healing", "incidents.jsonl");
    }
  }

  _ensureDir() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  _load() {
    if (!this.filePath || this.incidents.length) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
        for (const line of lines.slice(-MAX_INCIDENTS)) {
          try { this.incidents.push(JSON.parse(line)); } catch {}
        }
      }
    } catch {}
  }

  record({ kind = "tool", source = "", message = "", code = "", context = {}, fatal = false } = {}) {
    this._load();
    const text = String(message || context?.error || "").slice(0, 4000);
    const fingerprint = sha256(`${kind}|${source}|${String(text).slice(0, 300)}`).slice(0, 16);
    const now = Date.now();
    const recent = this.incidents
      .filter((item) => item.fingerprint === fingerprint && item.fatal === Boolean(fatal))
      .filter((item) => now - (item.timestamp || 0) < FINGERPRINT_WINDOW_MS);
    if (recent.length >= 3) {
      return { recorded: false, suppressed: true, fingerprint, count: recent.length };
    }
    const incident = {
      id: `${fingerprint}-${now.toString(36)}`,
      fingerprint,
      kind: String(kind || "tool").slice(0, 40),
      source: String(source || "").slice(0, 200),
      message: text,
      code: String(code || "").slice(0, 80),
      fatal: Boolean(fatal),
      timestamp: now,
      context: {
        sessionId: String(context?.sessionId || "").slice(0, 80),
        taskId: String(context?.taskId || "").slice(0, 120),
        toolId: String(context?.toolId || "").slice(0, 120),
        stage: String(context?.stage || "").slice(0, 80)
      }
    };
    this.incidents.push(incident);
    if (this.incidents.length > MAX_INCIDENTS) this.incidents = this.incidents.slice(-MAX_INCIDENTS);
    this._ensureDir();
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(incident)}\n`, "utf8");
    } catch {}
    return { recorded: true, suppressed: false, incident, fingerprint, count: 1 };
  }

  list({ fatalOnly = false, limit = 50 } = {}) {
    this._load();
    let items = [...this.incidents];
    if (fatalOnly) items = items.filter((item) => item.fatal);
    return items.slice(-Math.max(1, Math.min(100, Number(limit) || 50))).reverse();
  }

  summary() {
    this._load();
    const byKind = {};
    for (const item of this.incidents) {
      byKind[item.kind || "other"] = (byKind[item.kind || "other"] || 0) + 1;
    }
    const fatal = this.incidents.filter((item) => item.fatal).length;
    return {
      total: this.incidents.length,
      fatal,
      byKind,
      lastAt: this.incidents.at(-1)?.timestamp || null
    };
  }

  clear() {
    this.incidents = [];
    if (this.filePath) {
      try { fs.rmSync(this.filePath, { force: true }); } catch {}
    }
    return { ok: true };
  }
}

module.exports = { HealingMonitor, MAX_INCIDENTS, FINGERPRINT_WINDOW_MS };
