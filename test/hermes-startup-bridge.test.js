"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { HermesAcpClient, ensureHermesPythonCompat } = require("../services/hermes-acp-client");

async function cleanup(client, fixture) {
  const child = client.child;
  const closed = child && child.exitCode === null ? once(child, "close") : Promise.resolve();
  await client.stop();
  await closed;
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("startup distribution includes every local Python bridge dependency", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-bridge-distribution-"));
  try {
    ensureHermesPythonCompat({ platform: "win32", pythonCompatPath: fixture });
    for (const file of fs.readdirSync(fixture).filter(name => name.endsWith(".py"))) {
      const source = fs.readFileSync(path.join(fixture, file), "utf8");
      for (const dependency of source.matchAll(/(?:from|import) (baiqiu_[a-z_]+)/g)) {
        assert.ok(fs.existsSync(path.join(fixture, dependency[1] + ".py")), `${file} requires ${dependency[1]}`);
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("bundled Python completes the actual ACP handshake through copied bridges", { skip: !process.env.BAIQIU_TEST_RUNTIME, timeout: 30000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-startup-test-"));
  const client = new HermesAcpClient({
    bundledRuntimePath: process.env.BAIQIU_TEST_RUNTIME,
    hermesHome: path.join(fixture, "home"), pythonCompatPath: path.join(fixture, "compat"),
    cwd: fixture, startRetries: 0
  });
  try {
    const response = await client.start();
    assert.ok(response.agentInfo);
    assert.ok(response.protocolVersion);
    const repeated = await client.start();
    assert.equal(repeated, response);
  } catch (error) {
    throw new Error(`${error.message}\n${error.diagnostic || ""}`);
  } finally {
    await cleanup(client, fixture);
  }
});

test("configured provider answers twice without restarting ACP", { skip: !process.env.BAIQIU_LIVE_HOME, timeout: 100000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-acp-reply-test-"));
  const home = path.join(fixture, "home");
  fs.mkdirSync(home);
  for (const name of ["config.yaml", ".env"]) {
    fs.copyFileSync(path.join(process.env.BAIQIU_LIVE_HOME, name), path.join(home, name));
  }
  let starts = 0;
  const client = new HermesAcpClient({ bundledRuntimePath: process.env.BAIQIU_TEST_RUNTIME,
    hermesHome: home, pythonCompatPath: path.join(fixture, "compat"), cwd: fixture,
    startRetries: 0, onStatus: status => { if (status.state === "starting") starts++; } });
  try {
    for (const [question, expected] of [["7 加 8", "15"], ["8 加 9", "17"]]) {
      const result = await client.prompt("repair-fixture", `这是一条连通性测试。${question}等于多少？只回复答案数字，不调用工具。`, { timeoutMs: 35000 });
      assert.equal(result.status, "done");
      assert.ok(result.text.includes(expected));
      assert.equal(result.toolCalls.length, 0);
    }
    assert.equal(starts, 1);
  } catch (error) {
    throw new Error(`ACP reply verification failed: ${error.code || error.name}; ${error.message}`);
  } finally {
    await cleanup(client, fixture);
  }
});
