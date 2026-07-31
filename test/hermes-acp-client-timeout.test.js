"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { HermesAcpClient } = require("../services/hermes-acp-client");

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
