"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const POTENTIALS = Object.freeze([
  { key: "cognition", label: "认知能力" },
  { key: "learning", label: "学习能力" },
  { key: "creation", label: "创造能力" },
  { key: "judgment", label: "判断能力" },
  { key: "adaptation", label: "适应能力" },
  { key: "execution", label: "执行能力" },
  { key: "insight", label: "洞察能力" },
  { key: "leadership", label: "领导能力" }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || 0)));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function potentialLevel(score) {
  if (score >= 92) return "S";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 56) return "C";
  if (score >= 42) return "D";
  return "E";
}

function deterministicBias(sourceId, key) {
  const hex = createHash("sha256").update(`${sourceId}:${key}`).digest("hex").slice(0, 4);
  return parseInt(hex, 16) % 7;
}

function trendFrom(previousScore, score) {
  if (!Number.isFinite(previousScore)) return "new";
  if (score >= previousScore + 2) return "up";
  if (score <= previousScore - 2) return "down";
  return "stable";
}

function scoreMap(potentials) {
  return Object.fromEntries((potentials || []).map((item) => [item.key, Number(item.score) || 0]));
}

function awakeningRecords(potentials, evidenceTotal) {
  const scores = scoreMap(potentials);
  const candidates = [
    { id: "strategic-insight", name: "战略洞察", fields: ["cognition", "judgment", "insight"], threshold: 72 },
    { id: "adaptive-learning", name: "适应学习", fields: ["learning", "adaptation"], threshold: 74 },
    { id: "creative-execution", name: "创造执行", fields: ["creation", "execution"], threshold: 72 },
    { id: "leadership-field", name: "领导场域", fields: ["leadership", "judgment", "cognition"], threshold: 76 }
  ];
  return candidates.map((candidate) => {
    const resonance = clamp(candidate.fields.reduce((sum, key) => sum + scores[key], 0) / candidate.fields.length);
    const state = resonance >= candidate.threshold && evidenceTotal >= 18
      ? "awakened"
      : resonance >= candidate.threshold - 10 ? "pending" : "unknown";
    return { ...candidate, resonance, state };
  });
}

function profileRecommendation(potentials, awakenings) {
  const pending = awakenings.filter((item) => item.state === "pending").sort((a, b) => b.resonance - a.resonance)[0];
  if (pending) return `继续积累高复杂度行为样本，${pending.name}正在形成共鸣`;
  const lowest = [...potentials].sort((a, b) => a.score - b.score)[0];
  return lowest ? `继续挑战需要${lowest.label.replace("能力", "")}的复杂任务` : "继续积累真实任务行为样本";
}

class LifePotentialArchive {
  constructor({ root, clock = () => new Date() } = {}) {
    if (!root) throw new Error("LifePotentialArchive requires root");
    this.root = root;
    this.clock = clock;
    this.profilesRoot = path.join(root, "profiles");
    this.manifestFile = path.join(root, "black-core-manifest.json");
    this.currentFile = path.join(root, "black-core-record.json");
    this.ensureStore();
  }

  now() {
    return this.clock().toISOString();
  }

  ensureStore() {
    fs.mkdirSync(this.profilesRoot, { recursive: true });
    if (fs.existsSync(this.manifestFile)) return;
    const now = this.now();
    writeJsonAtomic(this.manifestFile, {
      schemaVersion: 1,
      type: "black-core-manifest",
      subjectId: `HUMAN-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      revision: 0,
      recordCount: 0,
      sources: {},
      createdAt: now,
      updatedAt: now,
      lastAppVersion: ""
    });
  }

  readManifest() {
    const manifest = readJson(this.manifestFile, null);
    if (!manifest?.subjectId) {
      fs.rmSync(this.manifestFile, { force: true });
      this.ensureStore();
      return this.readManifest();
    }
    manifest.sources = manifest.sources && typeof manifest.sources === "object" ? manifest.sources : {};
    return manifest;
  }

  writeManifest(manifest) {
    manifest.updatedAt = this.now();
    writeJsonAtomic(this.manifestFile, manifest);
  }

  sourceKey(scope, sourceId) {
    return createHash("sha256").update(`${scope}:${sourceId}`).digest("hex").slice(0, 24);
  }

  profileFile(scope, sourceId) {
    return path.join(this.profilesRoot, `${this.sourceKey(scope, sourceId)}.json`);
  }

  get(scope, sourceId) {
    const value = readJson(this.profileFile(scope, sourceId), null);
    return value?.type === "life-potential-profile" ? value : null;
  }

  latest() {
    const value = readJson(this.currentFile, null);
    return value?.type === "life-potential-profile" ? value : null;
  }

  removeForSnapshot(scope, sourceId, snapshotId) {
    const normalizedScope = clean(scope, 40) || "session";
    const normalizedSourceId = clean(sourceId, 300);
    const normalizedSnapshotId = clean(snapshotId, 300);
    if (!normalizedSourceId || !normalizedSnapshotId) return { removed: false };
    const profile = this.get(normalizedScope, normalizedSourceId);
    if (!profile || profile.snapshotId !== normalizedSnapshotId) return { removed: false };

    const file = this.profileFile(normalizedScope, normalizedSourceId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const manifest = this.readManifest();
    delete manifest.sources[`${normalizedScope}:${normalizedSourceId}`];
    manifest.recordCount = Object.keys(manifest.sources).length;
    this.writeManifest(manifest);

    const current = this.latest();
    if (current?.scope === normalizedScope && current?.sourceId === normalizedSourceId) {
      const replacement = Object.values(manifest.sources)
        .map((entry) => this.get(entry.scope, entry.sourceId))
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
      if (replacement) writeJsonAtomic(this.currentFile, replacement);
      else if (fs.existsSync(this.currentFile)) fs.unlinkSync(this.currentFile);
    }
    return { removed: true, recordId: profile.recordId, sourceId: normalizedSourceId, scope: normalizedScope };
  }

  analyze(snapshot, previous = null) {
    if (!snapshot || snapshot.type !== "conscious-snapshot") throw new Error("意识快照无效，无法解析生命潜能");
    const sourceId = clean(snapshot.sourceId || snapshot.projectId || snapshot.sessionId, 300);
    const stats = snapshot.sourceStats || {};
    const messages = Number(stats.messages || 0);
    const completed = array(snapshot.completed_tasks || snapshot.completedTasks).length;
    const pending = array(snapshot.pending_tasks || snapshot.pendingTasks).length;
    const files = array(snapshot.important_files || snapshot.fileChanges || snapshot.core?.important_files).length;
    const agents = Math.max(array(snapshot.agent_state || snapshot.agentStates || snapshot.core?.agent_state).length, Number(stats.sessions || 0));
    const tasks = Math.max(Number(stats.taskBrainTasks || 0), completed + pending, array(snapshot.taskBrainState).length);
    const version = Math.max(1, Number(snapshot.version || 1));
    const progress = clamp(snapshot.currentProgress?.percent || 0);
    const messageDepth = Math.min(24, Math.log2(messages + 1) * 5.2);
    const taskDepth = Math.min(22, tasks * 2.8);
    const evidenceTotal = messages + tasks + completed + pending + files + agents;
    const previousScores = scoreMap(previous?.potentials || []);

    const definitions = {
      cognition: { raw: 38 + messageDepth * 0.8 + taskDepth * 0.55, evidence: messages + tasks },
      learning: { raw: 36 + messageDepth * 0.75 + version * 2.3 + completed * 0.8, evidence: messages + version + completed },
      creation: { raw: 34 + messageDepth * 0.45 + files * 4.5 + completed * 2.5, evidence: messages + files + completed },
      judgment: { raw: 37 + taskDepth * 0.8 + completed * 2.1 + progress * 0.08, evidence: completed + tasks },
      adaptation: { raw: 39 + version * 3.2 + Math.min(18, (completed + pending) * 1.8) + messageDepth * 0.35, evidence: version + completed + pending + messages },
      execution: { raw: 36 + completed * 4.2 + taskDepth * 0.55 + progress * 0.16, evidence: completed + tasks },
      insight: { raw: 35 + files * 2.8 + taskDepth * 0.55 + messageDepth * 0.55, evidence: files + tasks + messages },
      leadership: { raw: 29 + agents * 8.5 + completed * 2.2 + (snapshot.scope === "project" ? 6 : 0), evidence: agents + completed }
    };

    const potentials = POTENTIALS.map((potential) => {
      const definition = definitions[potential.key];
      const score = clamp(definition.raw + deterministicBias(sourceId, potential.key), 22, 98);
      return {
        ...potential,
        score,
        level: potentialLevel(score),
        trend: trendFrom(previousScores[potential.key], score),
        evidenceCount: Math.max(0, Number(definition.evidence) || 0)
      };
    });
    const awakenings = awakeningRecords(potentials, evidenceTotal);
    const confidence = evidenceTotal >= 45 ? "HIGH" : evidenceTotal >= 16 ? "MEDIUM" : "LOW";
    const growthStage = clamp(1 + Math.floor(Math.log2(evidenceTotal + 1)) + Math.floor(version / 3), 1, 9);
    return {
      sourceId,
      title: clean(snapshot.title || snapshot.projectName || "意识主体", 200),
      scope: snapshot.scope || "session",
      snapshotId: snapshot.id,
      snapshotVersion: version,
      growthStage,
      confidence,
      evidenceTotal,
      potentials,
      awakenings,
      discoveredPotential: potentials.filter((item) => item.score >= 56).length,
      pendingAwakening: awakenings.filter((item) => item.state === "pending").length,
      awakenedCount: awakenings.filter((item) => item.state === "awakened").length,
      unknownDomains: awakenings.filter((item) => item.state === "unknown").length,
      recommendation: profileRecommendation(potentials, awakenings)
    };
  }

  persist(snapshot) {
    const scope = snapshot.scope || "session";
    const sourceId = clean(snapshot.sourceId || snapshot.projectId || snapshot.sessionId, 300);
    if (!sourceId) throw new Error("意识快照缺少来源标识");
    const previous = this.get(scope, sourceId);
    if (previous?.snapshotId === snapshot.id) return clone(previous);
    const manifest = this.readManifest();
    const analysis = this.analyze(snapshot, previous);
    const revision = Number(manifest.revision || 0) + 1;
    const now = this.now();
    const history = array(previous?.history).concat(previous ? [{
      revision: previous.revision,
      snapshotId: previous.snapshotId,
      updatedAt: previous.updatedAt,
      growthStage: previous.growthStage,
      potentials: previous.potentials.map((item) => ({ key: item.key, score: item.score, level: item.level })),
      awakenings: previous.awakenings.map((item) => ({ id: item.id, state: item.state, resonance: item.resonance }))
    }] : []).slice(-30);
    const knownSnapshotIds = Array.from(new Set([
      ...array(previous?.knownSnapshotIds),
      ...array(previous?.history).map((item) => item.snapshotId),
      previous?.snapshotId,
      snapshot.id
    ].filter(Boolean))).slice(-500);
    const profile = {
      schemaVersion: 1,
      type: "life-potential-profile",
      recordId: previous?.recordId || `potential-${randomUUID()}`,
      subjectId: manifest.subjectId,
      revision,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      ...analysis,
      history,
      knownSnapshotIds,
      evolutionState: history.length ? "EVOLUTION" : "INITIAL STATE",
      sync: { state: "local-ready", revision, updatedAt: now }
    };
    profile.signature = createHash("sha256").update(JSON.stringify({
      subjectId: profile.subjectId,
      revision: profile.revision,
      sourceId: profile.sourceId,
      potentials: profile.potentials,
      awakenings: profile.awakenings
    })).digest("hex");
    profile.sync.hash = profile.signature;
    writeJsonAtomic(this.profileFile(scope, sourceId), profile);
    writeJsonAtomic(this.currentFile, profile);
    manifest.revision = revision;
    manifest.recordCount = Object.keys(manifest.sources).length + (manifest.sources[`${scope}:${sourceId}`] ? 0 : 1);
    manifest.sources[`${scope}:${sourceId}`] = {
      scope,
      sourceId,
      recordId: profile.recordId,
      title: profile.title,
      revision,
      updatedAt: now,
      signature: profile.signature
    };
    this.writeManifest(manifest);
    return clone(profile);
  }

  syncSnapshots(snapshots = []) {
    const ordered = snapshots
      .filter((snapshot) => snapshot?.type === "conscious-snapshot")
      .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
    let imported = 0;
    for (const snapshot of ordered) {
      const current = this.get(snapshot.scope || "session", snapshot.sourceId || snapshot.projectId || snapshot.sessionId);
      const knownSnapshotIds = new Set([
        current?.snapshotId,
        ...array(current?.knownSnapshotIds),
        ...array(current?.history).map((item) => item.snapshotId)
      ].filter(Boolean));
      if (knownSnapshotIds.has(snapshot.id)) continue;
      this.persist(snapshot);
      imported += 1;
    }
    return { imported, status: this.status() };
  }

  status({ appVersion = "" } = {}) {
    const manifest = this.readManifest();
    const previousAppVersion = manifest.lastAppVersion || "";
    const upgraded = Boolean(appVersion && previousAppVersion && previousAppVersion !== appVersion && manifest.recordCount > 0);
    if (appVersion && previousAppVersion !== appVersion) {
      manifest.lastAppVersion = appVersion;
      this.writeManifest(manifest);
    }
    return {
      schemaVersion: manifest.schemaVersion,
      subjectId: manifest.subjectId,
      revision: Number(manifest.revision || 0),
      recordCount: Number(manifest.recordCount || 0),
      recognized: Number(manifest.recordCount || 0) > 0,
      upgraded,
      previousAppVersion,
      appVersion,
      updatedAt: manifest.updatedAt,
      storageRoot: this.root,
      current: this.latest()
    };
  }
}

module.exports = { LifePotentialArchive, POTENTIALS, potentialLevel };
