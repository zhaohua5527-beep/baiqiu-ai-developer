"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("./data-root");

const DEFAULT_QA_ROOT = path.join(dataRoot(), "qa-agent");

function safeClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value || ""); }
}

function errorMessage(value, fallback = "探针未返回成功证据") {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value?.message === "string" && value.message.trim()) return value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

class QaAgent {
  constructor({ probes = {}, rootDir = DEFAULT_QA_ROOT, clock = () => new Date() } = {}) {
    this.probes = probes;
    this.rootDir = rootDir;
    this.clock = clock;
    this.latestFile = path.join(rootDir, "latest-report.json");
    this.historyFile = path.join(rootDir, "report-history.json");
  }

  async run({ onProgress = null } = {}) {
    const report = {
      id: `qa-${randomUUID()}`,
      startedAt: this.clock().toISOString(),
      status: "RUNNING",
      checks: []
    };
    const entries = Object.entries(this.probes);
    for (let index = 0; index < entries.length; index += 1) {
      const [id, definition] = entries[index];
      const label = definition?.label || id;
      const probe = typeof definition === "function" ? definition : definition?.run;
      const startedAt = Date.now();
      onProgress?.({ reportId: report.id, id, label, status: "RUNNING", index, total: entries.length });
      let check;
      try {
        if (typeof probe !== "function") {
          check = {
            id,
            label,
            status: "SKIPPED",
            durationMs: Date.now() - startedAt,
            evidence: null,
            error: "",
            detail: "真实探针未配置，已跳过"
          };
          report.checks.push(check);
          onProgress?.({ reportId: report.id, ...check, index: index + 1, total: entries.length });
          continue;
        }
        const result = await probe();
        const skipped = result?.skipped === true || String(result?.status || "").toUpperCase() === "SKIPPED";
        const success = result?.success === true;
        check = {
          id,
          label,
          status: skipped ? "SKIPPED" : success ? "SUCCESS" : "FAILED",
          durationMs: Date.now() - startedAt,
          evidence: safeClone(result?.evidence ?? result ?? null),
          error: skipped || success ? "" : errorMessage(result?.error || result?.message),
          detail: result?.detail || ""
        };
      } catch (error) {
        check = {
          id,
          label,
          status: "FAILED",
          durationMs: Date.now() - startedAt,
          evidence: null,
          error: error?.message || String(error)
        };
      }
      report.checks.push(check);
      onProgress?.({ reportId: report.id, ...check, index: index + 1, total: entries.length });
    }
    report.finishedAt = this.clock().toISOString();
    report.status = report.checks.some((item) => item.status === "FAILED") ? "FAILED" : "SUCCESS";
    report.summary = {
      total: report.checks.length,
      passed: report.checks.filter((item) => item.status === "SUCCESS").length,
      failed: report.checks.filter((item) => item.status === "FAILED").length,
      skipped: report.checks.filter((item) => item.status === "SKIPPED").length
    };
    this.persist(report);
    return report;
  }

  latest() {
    return this.readJson(this.latestFile, null);
  }

  history() {
    return this.readJson(this.historyFile, { reports: [] }).reports || [];
  }

  persist(report) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.latestFile, JSON.stringify(report, null, 2), "utf8");
    const history = this.readJson(this.historyFile, { reports: [] });
    history.reports = [...(history.reports || []), report].slice(-30);
    fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2), "utf8");
  }

  readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
  }
}

module.exports = { QaAgent, DEFAULT_QA_ROOT };
