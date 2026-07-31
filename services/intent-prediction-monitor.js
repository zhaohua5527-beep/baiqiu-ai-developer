"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dataRoot } = require("./data-root");
const { sanitize } = require("./conversation-trace-logger");

const REASON_LABELS = Object.freeze({
  invalid_json: "模型输出不是有效预测 JSON",
  insufficient_candidates: "候选意图不足",
  candidates_not_distinguished: "选项无法区分候选意图",
  invalid_impact: "阻塞问题缺少有效影响等级",
  platform_before_direction: "产品方向未知时提前询问平台",
  repeated_question: "预测问题与历史问题语义重复",
  invalid_dimension: "预测维度标识无效",
  repeated_dimension: "重复询问已处理维度",
  missing_question: "预测结果缺少关键问题",
  insufficient_options: "可选方向不足",
  duplicate_options: "预测选项重复",
  low_confidence_confirmation: "置信度不足却尝试提前确认",
  model_error: "预测模型调用失败"
});

function clean(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function questionSimilarity(left = "", right = "") {
  const grams = (value) => {
    const chars = [...String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
    if (chars.length < 2) return new Set(chars);
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((item) => b.has(item)).length / Math.max(a.size, b.size);
}

class IntentPredictionMonitor {
  constructor({ root = path.join(dataRoot(), "logs", "intent-prediction"), clock = () => new Date(), maxBytes = 4 * 1024 * 1024, maxFiles = 3 } = {}) {
    this.root = root;
    this.file = path.join(root, "intent-prediction.jsonl");
    this.clock = clock;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
  }

  rotateIfNeeded() {
    if (!fs.existsSync(this.file) || fs.statSync(this.file).size < this.maxBytes) return;
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      const target = `${this.file}.${index}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
  }

  record(event = {}) {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      this.rotateIfNeeded();
      const entry = sanitize({
        schemaVersion: 1,
        time: this.clock().toISOString(),
        event: clean(event.event, 80) || "prediction_event",
        sessionId: clean(event.sessionId, 200),
        requestId: clean(event.requestId, 200),
        round: Number(event.round || 0),
        dimension: clean(event.dimension, 80),
        question: clean(event.question, 500),
        workingGoal: clean(event.workingGoal, 500),
        confidence: Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : 0,
        candidates: Array.isArray(event.candidates) ? event.candidates.slice(0, 4) : [],
        reason: clean(event.reason, 120),
        source: clean(event.source, 80),
        action: clean(event.action, 80),
        selectedValue: clean(event.selectedValue, 300)
      });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    } catch {
      return null;
    }
  }

  readEntries({ limit = 5000 } = {}) {
    const files = [];
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) files.push(`${this.file}.${index}`);
    files.push(this.file);
    const entries = [];
    let malformedLines = 0;
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      let content = "";
      try { content = fs.readFileSync(file, "utf8"); } catch { malformedLines += 1; continue; }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { malformedLines += 1; }
      }
    }
    return { entries: entries.slice(-Math.max(1, limit)), malformedLines };
  }

  scan({ sessions = [], limit = 5000 } = {}) {
    const { entries, malformedLines } = this.readEntries({ limit });
    const anomalyGroups = new Map();
    for (const entry of entries) {
      if (!['model_rejected', 'model_error'].includes(entry?.event)) continue;
      const reason = clean(entry.reason, 120) || (entry.event === "model_error" ? "model_error" : "invalid_json");
      if (!anomalyGroups.has(reason)) anomalyGroups.set(reason, []);
      anomalyGroups.get(reason).push(entry);
    }
    const stateIssues = [];
    for (const session of sessions) {
      const state = session?.clarificationState;
      if (!state || typeof state !== "object") continue;
      const reasons = [];
      if (Number(state.round || 0) < 1 || Number(state.round || 0) > 4) reasons.push("轮次超出 1-4 范围");
      if (!clean(state.requestId, 200) || !clean(state.sessionId, 200) || state.sessionId !== session.id) reasons.push("请求标识或会话归属无效");
      const dimensions = Array.isArray(state.askedDimensions) ? state.askedDimensions.filter(Boolean) : [];
      if (new Set(dimensions).size !== dimensions.length) reasons.push("已问维度存在重复");
      const questions = Array.isArray(state.askedQuestions) ? state.askedQuestions.filter(Boolean) : [];
      for (let left = 0; left < questions.length && !reasons.includes("历史问题语义重复"); left += 1) {
        for (let right = left + 1; right < questions.length; right += 1) {
          if (questionSimilarity(questions[left], questions[right]) >= 0.72) {
            reasons.push("历史问题语义重复");
            break;
          }
        }
      }
      if (reasons.length) stateIssues.push({ sessionId: session.id, sessionName: clean(session.name || session.title, 160), reasons });
    }
    return {
      file: this.file,
      entryCount: entries.length,
      malformedLines,
      anomalyGroups: [...anomalyGroups.entries()].map(([reason, items]) => ({
        reason,
        label: REASON_LABELS[reason] || reason,
        count: items.length,
        latestAt: items.at(-1)?.time || "",
        sessions: [...new Set(items.map((item) => item.sessionId).filter(Boolean))].slice(0, 20),
        samples: items.slice(-3)
      })),
      stateIssues
    };
  }
}

module.exports = { IntentPredictionMonitor, REASON_LABELS, questionSimilarity };
