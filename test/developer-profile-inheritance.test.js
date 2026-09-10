"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { EXCLUDED_AREAS, inheritDeveloperProfile } = require("../services/developer-profile-inheritance");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

test("developer profile inherits model configuration without copying protected customer data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-developer-profile-"));
  const sourceDbFile = path.join(root, "production", "heiqiu-db.json");
  const targetDbFile = path.join(root, "developer", "heiqiu-db.json");
  const manifestFile = path.join(root, "developer", "data", "developer-profile-inheritance.json");
  const backupRoot = path.join(root, "developer", "data", "developer-profile-backups");
  const target = {
    sessions: [{ id: "developer-session" }],
    messages: { "developer-session": [{ role: "user", text: "keep developer chat" }] },
    settings: {
      defaultProvider: "deepseek",
      reasoning: "maximum",
      providers: { deepseek: { enabled: true, apiKey: "", model: "deepseek-chat" } },
      license: { unlocked: false },
      customerProfile: { name: "developer" },
      update: { autoCheck: false }
    }
  };
  writeJson(sourceDbFile, {
    sessions: [{ id: "production-session" }],
    projects: [{ id: "production-project" }],
    messages: { "production-session": [{ role: "user", text: "private production chat" }] },
    settings: {
      defaultProvider: "openai",
      reasoning: "high",
      providers: {
        openai: {
          enabled: true,
          apiKey: "production-key",
          baseURL: "https://api.example/v1",
          model: "gpt-test",
          verifiedAt: "2026-08-28T00:00:00.000Z",
          verifiedModel: "gpt-test",
          verifiedBaseURL: "https://api.example/v1"
        }
      },
      license: { unlocked: true, code: "must-not-copy" },
      customerProfile: { name: "production customer" },
      update: { updatePackagePath: "production-installer.exe" }
    }
  });
  writeJson(targetDbFile, target);

  try {
    const result = inheritDeveloperProfile({
      sourceDbFile,
      targetDbFile,
      targetTemplate: {},
      manifestFile,
      backupRoot,
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    assert.equal(result.applied, true);
    assert.equal(fs.existsSync(result.backupFile), true);

    const inherited = JSON.parse(fs.readFileSync(targetDbFile, "utf8"));
    assert.equal(inherited.settings.defaultProvider, "openai");
    assert.equal(inherited.settings.providers.openai.apiKey, "production-key");
    assert.equal(inherited.settings.providers.openai.verifiedModel, "gpt-test");
    assert.deepEqual(inherited.sessions, target.sessions);
    assert.deepEqual(inherited.messages, target.messages);
    assert.deepEqual(inherited.settings.license, target.settings.license);
    assert.deepEqual(inherited.settings.customerProfile, target.settings.customerProfile);
    assert.deepEqual(inherited.settings.update, target.settings.update);

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.deepEqual(manifest.excludedAreas, EXCLUDED_AREAS);
    assert.equal(JSON.stringify(manifest).includes("production-key"), false);
    assert.equal(JSON.stringify(manifest).includes("private production chat"), false);

    const second = inheritDeveloperProfile({ sourceDbFile, targetDbFile, targetTemplate: {}, manifestFile, backupRoot });
    assert.equal(second.applied, false);
    assert.equal(second.reason, "already_inherited");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("developer model changes are preserved when the production model later changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-developer-profile-custom-"));
  const sourceDbFile = path.join(root, "production", "heiqiu-db.json");
  const targetDbFile = path.join(root, "developer", "heiqiu-db.json");
  const manifestFile = path.join(root, "developer", "data", "developer-profile-inheritance.json");
  const backupRoot = path.join(root, "developer", "data", "developer-profile-backups");
  const source = {
    settings: {
      defaultProvider: "openai",
      reasoning: "high",
      providers: { openai: { enabled: true, apiKey: "first", model: "gpt-first" } }
    }
  };
  writeJson(sourceDbFile, source);

  try {
    inheritDeveloperProfile({
      sourceDbFile,
      targetDbFile,
      targetTemplate: { sessions: [], messages: {}, settings: {} },
      manifestFile,
      backupRoot
    });
    const developer = JSON.parse(fs.readFileSync(targetDbFile, "utf8"));
    developer.settings.providers.openai.model = "developer-choice";
    writeJson(targetDbFile, developer);
    source.settings.providers.openai.model = "production-later";
    writeJson(sourceDbFile, source);

    const result = inheritDeveloperProfile({ sourceDbFile, targetDbFile, targetTemplate: {}, manifestFile, backupRoot });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "developer_model_modified");
    assert.equal(JSON.parse(fs.readFileSync(targetDbFile, "utf8")).settings.providers.openai.model, "developer-choice");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a later production model change is inherited while the developer copy remains untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-developer-profile-sync-"));
  const sourceDbFile = path.join(root, "production", "heiqiu-db.json");
  const targetDbFile = path.join(root, "developer", "heiqiu-db.json");
  const manifestFile = path.join(root, "developer", "data", "developer-profile-inheritance.json");
  const backupRoot = path.join(root, "developer", "data", "developer-profile-backups");
  const source = {
    settings: {
      defaultProvider: "openai",
      reasoning: "high",
      providers: { openai: { enabled: true, apiKey: "first", model: "gpt-first" } }
    }
  };
  writeJson(sourceDbFile, source);

  try {
    inheritDeveloperProfile({
      sourceDbFile,
      targetDbFile,
      targetTemplate: { sessions: [], messages: {}, settings: {} },
      manifestFile,
      backupRoot
    });
    source.settings.providers.openai = { enabled: true, apiKey: "second", model: "gpt-second" };
    writeJson(sourceDbFile, source);

    const result = inheritDeveloperProfile({ sourceDbFile, targetDbFile, targetTemplate: {}, manifestFile, backupRoot });
    assert.equal(result.applied, true);
    assert.equal(JSON.parse(fs.readFileSync(targetDbFile, "utf8")).settings.providers.openai.model, "gpt-second");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("developer inheritance rejects the production database as its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-developer-profile-boundary-"));
  const file = path.join(root, "heiqiu-db.json");
  try {
    assert.throws(() => inheritDeveloperProfile({
      sourceDbFile: file,
      targetDbFile: file,
      manifestFile: path.join(root, "manifest.json"),
      backupRoot: path.join(root, "backups")
    }), /cannot target production data/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main only enables production inheritance behind an explicit non-E2E developer flag", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(main, /const inheritProductionProfile = isDevMode\s*&& !isE2ETest\s*&& process\.argv\.includes\("--inherit-production-profile"\)/);
  assert.match(main, /processArgumentValue\("--baiqiu-production-user-data-root"\)/);
  assert.match(main, /function loadDb\(\) \{\s*ensureDeveloperProfileInheritance\(\);\s*migrateLegacyData\(\);/);
  assert.match(main, /candidates\.push\(path\.join\(productionRoot, "data"\), path\.join\(productionRoot, "data", "workspace"\)\)/);
});
