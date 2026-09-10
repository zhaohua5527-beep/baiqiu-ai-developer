"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ensureBundledHermesHome,
  syncApplicationBundledSkills
} = require("../services/hermes-bundled-runtime");

function writeSkill(root, body = "bundled") {
  const directory = path.join(root, "software-development", "critical-engineering-auditor");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), body);
  fs.writeFileSync(path.join(root, ".bundled_manifest"), "critical-engineering-auditor:test-hash\n");
}

function createRuntime(root) {
  const runtime = path.join(root, "runtime");
  const agent = path.join(runtime, "hermes", "hermes-agent");
  fs.mkdirSync(path.join(runtime, "python"), { recursive: true });
  fs.mkdirSync(path.join(agent, "venv", "Lib", "site-packages"), { recursive: true });
  fs.mkdirSync(path.join(agent, "acp_adapter"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "hermes", "skills"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "python", "python.exe"), "runtime");
  fs.writeFileSync(path.join(agent, "acp_adapter", "entry.py"), "entry");
  fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), "{\"version\":\"one\"}");
  fs.writeFileSync(path.join(runtime, "hermes", "skills", ".bundled_manifest"), "runtime-skill:runtime-hash\n");
  return runtime;
}

test("application-bundled Skills copy when missing and merge the HMS manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-app-skills-"));
  try {
    const source = path.join(root, "application-skills");
    const home = path.join(root, "home");
    writeSkill(source);
    fs.mkdirSync(path.join(home, "skills"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", ".bundled_manifest"), "runtime-skill:runtime-hash\n");
    const result = syncApplicationBundledSkills(home, { applicationSkillsPath: source });
    assert.ok(result.copied > 0);
    assert.equal(fs.readFileSync(path.join(home, "skills", "software-development", "critical-engineering-auditor", "SKILL.md"), "utf8"), "bundled");
    assert.deepEqual(fs.readFileSync(path.join(home, "skills", ".bundled_manifest"), "utf8").trim().split(/\r?\n/), [
      "runtime-skill:runtime-hash",
      "critical-engineering-auditor:test-hash"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("application synchronization never overwrites a customer Skill or duplicates its manifest entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-app-skills-existing-"));
  try {
    const source = path.join(root, "application-skills");
    const home = path.join(root, "home");
    writeSkill(source, "bundled");
    const customerDirectory = path.join(home, "skills", "software-development", "critical-engineering-auditor");
    fs.mkdirSync(customerDirectory, { recursive: true });
    fs.writeFileSync(path.join(customerDirectory, "SKILL.md"), "customer version");
    syncApplicationBundledSkills(home, { applicationSkillsPath: source });
    syncApplicationBundledSkills(home, { applicationSkillsPath: source });
    assert.equal(fs.readFileSync(path.join(customerDirectory, "SKILL.md"), "utf8"), "customer version");
    assert.equal(fs.existsSync(path.join(customerDirectory, "agents", "openai.yaml")), false);
    assert.equal(fs.existsSync(path.join(home, "skills", ".bundled_manifest")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("application Skills are staged even when the HMS runtime is temporarily unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-app-skills-offline-"));
  try {
    const source = path.join(root, "application-skills");
    const home = path.join(root, "home");
    writeSkill(source);
    const result = ensureBundledHermesHome({
      bundledRuntimePath: path.join(root, "missing-runtime"),
      hermesHome: home,
      applicationSkillsPath: source
    });
    assert.equal(result.available, false);
    assert.equal(fs.existsSync(path.join(home, "skills", "software-development", "critical-engineering-auditor", "SKILL.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cached Hermes Home still receives a newly shipped application Skill", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-app-skills-cached-"));
  try {
    const runtime = createRuntime(root);
    const source = path.join(root, "application-skills");
    const home = path.join(root, "home");
    const options = { bundledRuntimePath: runtime, hermesHome: home, applicationSkillsPath: source };
    assert.equal(ensureBundledHermesHome(options).cached, false);
    writeSkill(source);
    const cached = ensureBundledHermesHome(options);
    assert.equal(cached.cached, true);
    assert.equal(fs.existsSync(path.join(home, "skills", "software-development", "critical-engineering-auditor", "SKILL.md")), true);
    assert.match(fs.readFileSync(path.join(home, "skills", ".bundled_manifest"), "utf8"), /runtime-skill:runtime-hash/);
    assert.match(fs.readFileSync(path.join(home, "skills", ".bundled_manifest"), "utf8"), /critical-engineering-auditor:test-hash/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
