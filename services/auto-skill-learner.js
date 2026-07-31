"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function clean(value, limit = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function toolIdentity(call = {}) {
  return clean(call.toolId || call.tool_call_id || call.toolCallId || call.name || call.title || "", 160);
}

class AutoSkillLearner {
  constructor(options = {}) {
    this.root = path.resolve(options.userDataPath || process.env.USER_DATA_PATH || process.cwd());
    this.file = path.join(this.root, "observations.json");
    this.minToolCalls = Number(options.learningConfig?.minToolCalls || options.minToolCalls || 3);
    this.minAttempts = Number(options.learningConfig?.minAttempts || 3);
    this.minSuccessRate = Number(options.learningConfig?.minSuccessRate || options.minSuccessRate || 0.8);
    this.store = { version: 2, patterns: [], updatedAt: null };
    this.loadPendingPatterns();
  }

  loadPendingPatterns() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed.patterns)) this.store = { ...this.store, ...parsed };
    } catch {}
    return this.getStats();
  }

  save() {
    this.store.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, this.store);
  }

  onExecutionComplete(execution = {}) {
    const toolCalls = (Array.isArray(execution.toolCalls) ? execution.toolCalls : [])
      .map((call) => ({ toolId: toolIdentity(call), args: call.rawInput || call.args || {} }))
      .filter((call) => call.toolId);
    if (toolCalls.length < this.minToolCalls) return { observed: false, reason: "too_simple" };
    const sequence = toolCalls.map((call) => call.toolId);
    const fingerprint = createHash("sha256").update(sequence.join("\0")).digest("hex").slice(0, 20);
    let pattern = this.store.patterns.find((item) => item.fingerprint === fingerprint);
    if (!pattern) {
      pattern = {
        id: `pattern-${fingerprint}`,
        fingerprint,
        name: clean(execution.userMessage, 80) || `Hermes workflow ${fingerprint.slice(0, 6)}`,
        toolSequence: sequence,
        attempts: 0,
        successes: 0,
        proposedAt: "",
        rejectedAt: "",
        samples: [],
        createdAt: new Date().toISOString()
      };
      this.store.patterns.unshift(pattern);
    }
    pattern.attempts += 1;
    if (execution.success === true) pattern.successes += 1;
    pattern.successRate = pattern.attempts ? pattern.successes / pattern.attempts : 0;
    pattern.updatedAt = new Date().toISOString();
    pattern.samples.unshift({ sessionId: clean(execution.sessionId, 200), traceId: clean(execution.traceId, 200), intent: clean(execution.intent, 120), success: execution.success === true, at: pattern.updatedAt });
    pattern.samples = pattern.samples.slice(0, 10);
    let proposed = false;
    if (!pattern.proposedAt && !pattern.rejectedAt && pattern.attempts >= this.minAttempts && pattern.successRate >= this.minSuccessRate) {
      pattern.proposedAt = pattern.updatedAt;
      proposed = true;
    }
    this.store.patterns = this.store.patterns.slice(0, 100);
    this.save();
    return {
      observed: true,
      proposed,
      patternId: pattern.id,
      name: pattern.name,
      frequency: pattern.attempts,
      successRate: pattern.successRate,
      toolSequence: [...pattern.toolSequence]
    };
  }

  confirmSkill(patternId) {
    const pattern = this.store.patterns.find((item) => item.id === patternId);
    if (!pattern) return { success: false, error: "Pattern not found" };
    return {
      success: true,
      requiresAcquisition: true,
      pattern,
      suggestedRequest: `学习“${pattern.name}”技能，并复用工具流程：${pattern.toolSequence.join(" -> ")}`
    };
  }

  rejectSkill(patternId, reason = "") {
    const pattern = this.store.patterns.find((item) => item.id === patternId);
    if (!pattern) return { success: false, error: "Pattern not found" };
    pattern.rejectedAt = new Date().toISOString();
    pattern.rejectReason = clean(reason, 500);
    this.save();
    return { success: true };
  }

  getStats() {
    return {
      observedPatterns: this.store.patterns.length,
      proposedPatterns: this.store.patterns.filter((item) => item.proposedAt && !item.rejectedAt).length,
      patterns: this.store.patterns.map((item) => ({ ...item, toolSequence: [...item.toolSequence], samples: [...item.samples] }))
    };
  }
}

module.exports = { AutoSkillLearner, toolIdentity };
