"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("./data-root");

function clean(value, limit = 100) {
  return String(value || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanName(value) {
  return clean(value, 60)
    .replace(/^(?:你叫|我叫|我是|叫我|称呼我|名字是|名称是)\s*/u, "")
    .replace(/(?:不要|别|不准|禁止|不能|不要再).*/u, "")
    .replace(/[。！？!?；;，,：:\s]+$/u, "")
    .trim();
}

function compactSingleName(value) {
  const cleaned = cleanName(value);
  if (!cleaned) return "";
  const [first] = cleaned.split(/\s+/u);
  return cleanName(first);
}

function firstCapture(value, patterns = []) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const captured = cleanName(match?.[1] || "");
    if (captured) return captured;
  }
  return "";
}

function captureLabel(value, labelPatterns = []) {
  const text = clean(value, 500);
  for (const pattern of labelPatterns) {
    const match = text.match(pattern);
    const captured = cleanName(match?.[1] || "");
    if (captured) return captured;
  }
  return "";
}

function extractForbiddenAddresses(value) {
  const forbidden = [];
  const patterns = [
    /(?:不要|别|不准|禁止|不能)(?:再)?叫我\s*([^，,。；;！!？?\s]+)/gu,
    /(?:不要|别|不准|禁止|不能)(?:再)?称呼我(?:为|成)?\s*([^，,。；;！!？?\s]+)/gu
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const name = cleanName(match[1]);
      if (name && !forbidden.includes(name)) forbidden.push(name);
    }
  }
  return forbidden;
}

function extractIdentityUpdate(text = "") {
  void text;
  return null;
}

function identityAnswer(profile, text = "") {
  void profile;
  void text;
  return "";
}

class UserProfileService {
  constructor({ root = path.join(dataRoot(), "user-profile"), clock = () => new Date() } = {}) {
    this.root = root;
    this.profileFile = path.join(root, "profile.json");
    this.eventFile = path.join(root, "memory-events.jsonl");
    this.clock = clock;
  }

  defaultProfile(seed = {}) {
    return {
      schemaVersion: 1,
      userName: compactSingleName(seed.userName || seed.userAddress || "BOSS") || "BOSS",
      assistantName: compactSingleName(seed.assistantName || seed.name || "黑球") || "黑球",
      preferences: seed.preferences && typeof seed.preferences === "object" ? seed.preferences : {},
      workHabits: seed.workHabits && typeof seed.workHabits === "object" ? seed.workHabits : {},
      updatedAt: null
    };
  }

  normalize(profile = {}) {
    const base = this.defaultProfile(profile);
    const preferences = profile.preferences && typeof profile.preferences === "object" ? { ...profile.preferences } : {};
    const forbidden = Array.isArray(preferences.forbiddenAddresses) ? preferences.forbiddenAddresses.map((item) => compactSingleName(item)).filter(Boolean) : [];
    if (forbidden.length) preferences.forbiddenAddresses = forbidden;
    else delete preferences.forbiddenAddresses;
    return {
      ...base,
      userName: compactSingleName(profile.userName || base.userName) || base.userName,
      assistantName: compactSingleName(profile.assistantName || base.assistantName) || base.assistantName,
      preferences,
      workHabits: profile.workHabits && typeof profile.workHabits === "object" ? { ...profile.workHabits } : base.workHabits,
      updatedAt: profile.updatedAt || base.updatedAt
    };
  }

  load(seed = {}) {
    return this.defaultProfile(seed);
  }

  initialize(seed = {}) {
    return this.defaultProfile(seed);
  }

  writeProfile(profile) {
    fs.mkdirSync(this.root, { recursive: true });
    const temp = `${this.profileFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(profile, null, 2), "utf8");
    if (fs.existsSync(this.profileFile)) fs.rmSync(this.profileFile, { force: true });
    fs.renameSync(temp, this.profileFile);
  }

  appendEvent(event = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    const record = {
      eventId: `memory-${randomUUID()}`,
      type: event.type || "USER_PROFILE_UPDATE",
      time: this.clock().toISOString(),
      source: clean(event.source || "unknown", 120),
      sessionId: clean(event.sessionId || "", 160),
      projectId: clean(event.projectId || "", 160),
      before: event.before ?? null,
      after: event.after ?? null,
      changedFields: Array.isArray(event.changedFields) ? event.changedFields : []
    };
    fs.appendFileSync(this.eventFile, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  save(changes = {}, context = {}) {
    void changes;
    void context;
    const profile = this.defaultProfile();
    return { saved: false, unchanged: true, profile, event: null, storagePath: this.profileFile, applied: [] };
  }

  updateFromText(text, context = {}) {
    void text;
    void context;
    return null;
  }

  context(profile = this.load()) {
    void profile;
    return "";
  }
}

module.exports = { UserProfileService, extractIdentityUpdate, identityAnswer };
