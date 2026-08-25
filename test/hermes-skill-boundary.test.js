"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HermesSkillService } = require("../services/hermes-skill-service");
const { VerifierCenter } = require("../services/verifier-center");
const { ToolExecutionService } = require("../services/tool-execution-service");

function writeSkill(home, name, platforms = ["windows"]) {
  const directory = path.join(home, "skills", "bundled", name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    "description: HMS test skill",
    `platforms: [${platforms.join(", ")}]`,
    "---",
    "",
    "# Test skill"
  ].join("\n"), "utf8");
}

test("an HMS-discovered skill remains routable without Baiqiu proof", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-skills-"));
  try {
    writeSkill(home, "xlsx");
    const service = new HermesSkillService({ hermesHome: home, platform: "win32" });
    const initial = service.get("xlsx");
    assert.equal(initial.status, "READY");
    assert.equal(initial.enabled, true);
    assert.equal(initial.runnable, true);
    assert.equal(initial.executionAuthority, "hermes");
    assert.equal(initial.verification.status, "not_run");

    service.recordVerification("xlsx", { success: false, error: "diagnostic failed" });
    const afterDiagnostic = service.get("xlsx");
    assert.equal(afterDiagnostic.status, "READY");
    assert.equal(afterDiagnostic.runnable, true);
    assert.equal(afterDiagnostic.verification.status, "failed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a platform-incompatible HMS skill stays visible but is not claimed callable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-skills-"));
  try {
    writeSkill(home, "mac-only", ["macos"]);
    const skill = new HermesSkillService({ hermesHome: home, platform: "win32" }).get("mac-only");
    assert.equal(skill.status, "DISABLED");
    assert.equal(skill.enabled, false);
    assert.equal(skill.runnable, false);
    assert.equal(skill.availability, "platform_incompatible");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a successful skill response is not downgraded by missing local evidence", () => {
  const verifier = new VerifierCenter();
  const result = verifier.verify({
    toolId: "skill_get_current_time",
    result: { success: true, result: "2026-08-01 10:00", evidence: [] }
  });
  assert.equal(result.verified, true);
  assert.equal(result.status, "passed_with_diagnostics");
  assert.equal(result.checks.find((item) => item.name === "runtime_evidence").passed, false);
});

test("tool execution preserves a successful HMS skill result with advisory diagnostics", async () => {
  const service = new ToolExecutionService({
    registry: {
      list: () => [{ id: "skill_get_current_time" }],
      execute: async () => ({ success: true, result: "2026-08-01 10:00", evidence: [] })
    },
    selector: {
      approveToolCall: () => ({ approved: true, reason: "selected", selectedTools: [{ id: "skill_get_current_time" }] })
    },
    verifier: new VerifierCenter(),
    ensureRunActive: () => {}
  });
  const result = await service.execute({ toolId: "skill_get_current_time" });
  assert.equal(result.success, true);
  assert.equal(result.verification.status, "passed_with_diagnostics");
});

test("installed skill checks use the local skill list instead of registry inspection", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-local-check-"));
  const calls = [];
  try {
    writeSkill(home, "local-check");
    const service = new HermesSkillService({
      hermesHome: home,
      platform: "win32",
      executablePath: process.execPath,
      execFileImpl(_file, args, _options, callback) {
        calls.push(args);
        callback(null, "Installed Skills\nlocal-check  local  enabled", "");
      }
    });
    const result = await service.check("local-check");
    assert.equal(result.success, true);
    assert.deepEqual(calls[0], ["skills", "list", "--source", "all", "--enabled-only"]);
    assert.equal(calls.some((args) => args.includes("inspect")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("local skill installation keeps a manifest that Hermes can enumerate", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-local-install-"));
  try {
    const service = new HermesSkillService({
      hermesHome: home,
      platform: "win32",
      executablePath: process.execPath,
      execFileImpl(_file, _args, _options, callback) {
        callback(null, "Installed Skills\nqa-local-install  local  enabled", "");
      }
    });
    const result = await service.installLocal("qa-local-install", [
      "# Local test skill",
      "",
      "1. Read the input.",
      "2. Apply the workflow.",
      "3. Return a checked result."
    ].join("\n"), { category: "learned" });
    assert.equal(result.success, true);
    assert.equal(result.item.id, "qa-local-install");
    assert.equal(fs.existsSync(result.item.path), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
