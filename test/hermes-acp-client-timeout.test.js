"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectFileEvidence,
  collectToolFileEvidence,
  HermesAcpClient,
  ensureHermesPythonCompat,
  sensitiveEvidencePath
} = require("../services/hermes-acp-client");

test("generated files are collected from output text without treating input attachments as outputs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-files-"));
  try {
    const source = path.join(directory, "source.xlsx");
    const generated = path.join(directory, "result.xlsx");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(generated, "generated");
    const files = [];
    collectFileEvidence([{
      rawInput: { path: source },
      rawOutput: { output: `saved -> ${generated}` }
    }], files, new Set());
    assert.deepEqual(files.map((item) => item.path), [generated]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("read locations and sensitive runtime files never become delivery evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-sensitive-"));
  try {
    const source = path.join(directory, "source.xlsx");
    const env = path.join(directory, ".env");
    const runtime = path.join(directory, "runtime", "hermes-home");
    const config = path.join(runtime, "config.yaml");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(source, "source");
    fs.writeFileSync(env, "redacted");
    fs.writeFileSync(config, "redacted");
    const files = collectToolFileEvidence([{
      title: "read_file",
      status: "completed",
      locations: [{ path: source }, { path: env }, { path: config }],
      rawOutput: { path: source }
    }], { allowedRoots: [directory] });
    assert.deepEqual(files, []);
    assert.equal(sensitiveEvidencePath(env), true);
    assert.equal(sensitiveEvidencePath(config), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legitimate generated workbook remains delivery evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-delivery-"));
  try {
    const generated = path.join(directory, "result.xlsx");
    fs.writeFileSync(generated, "generated");
    const files = collectToolFileEvidence([{
      title: "write_xlsx",
      status: "completed",
      rawOutput: { outputPath: generated },
      locations: [{ path: generated }]
    }], { allowedRoots: [directory], runStartedAt: Date.now() - 1000 });
    assert.deepEqual(files.map((item) => item.path), [generated]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows Python compatibility shim only performs the Hermes Git Bash preflight", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-hermes-compat-"));
  try {
    const generated = ensureHermesPythonCompat({ platform: "win32", pythonCompatPath: directory });
    const source = fs.readFileSync(path.join(generated, "sitecustomize.py"), "utf8");
    assert.match(source, /Hermes Git Bash preflight failed/);
    assert.doesNotMatch(source, /BAIQIU_HMS_ALLOWED_TOOLSETS|enabled_toolsets|disabled_toolsets|os\._exit/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a stalled Hermes update times out and frees the local session", async () => {
  let disposed = false;
  const client = new HermesAcpClient({ promptTimeoutMs: 25 });
  const session = {
    hermesSessionId: "hermes-test-session",
    active: {
      prompt() {},
      nextUpdate() { return new Promise(() => {}); },
      dispose() { disposed = true; }
    }
  };
  client.ensureSession = async () => session;
  client.cancel = async () => true;

  await assert.rejects(
    () => client.prompt("local-test-session", "hello", { timeoutMs: 25 }),
    (error) => error?.code === "HERMES_PROMPT_TIMEOUT"
  );
  assert.equal(client.hasActivePrompt("local-test-session"), false);
  assert.equal(client.sessions.has("local-test-session"), false);
  assert.equal(disposed, true);
});

test("timeoutMs zero waits for Hermes until Hermes returns", async () => {
  let release;
  let updates = 0;
  const client = new HermesAcpClient({ promptTimeoutMs: 25 });
  const session = {
    hermesSessionId: "hermes-unbounded-session",
    active: {
      prompt() {},
      nextUpdate() {
        updates += 1;
        if (updates === 1) return new Promise((resolve) => { release = resolve; });
        return Promise.resolve({ kind: "stop", stopReason: "end_turn", response: {} });
      },
      dispose() {}
    }
  };
  client.ensureSession = async () => session;
  client.cancel = async () => true;

  const pending = client.prompt("local-unbounded-session", "hello", { timeoutMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.hasActivePrompt("local-unbounded-session"), true);
  release({ notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
  const result = await pending;
  assert.equal(result.status, "done");
  assert.equal(result.text, "done");
});

test("ACP startup retries once after a transient initialization failure", async () => {
  const client = new HermesAcpClient({ startRetries: 1 });
  let attempts = 0;
  client._start = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient ACP startup failure");
    return { protocolVersion: "1.0" };
  };

  const result = await client.start();
  assert.equal(attempts, 2);
  assert.equal(result.protocolVersion, "1.0");
});
