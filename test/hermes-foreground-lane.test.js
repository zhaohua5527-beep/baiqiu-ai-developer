"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { HermesAcpClient } = require("../services/hermes-acp-client");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function stubSession(sessionId, updates) {
  return {
    hermesSessionId: sessionId,
    active: {
      prompt() {},
      nextUpdate() { return updates.shift(); },
      dispose() {}
    }
  };
}

test("foreground chat owns a separate ACP process and retains its conversation identity", () => {
  assert.match(mainSource, /let hermesForegroundClient;/);
  assert.match(mainSource, /clientName: "baiqiu-foreground-chat"/);
  assert.match(mainSource, /clientName: "baiqiu-foreground-chat",\s*resumePersistedSession: false/);
  assert.match(mainSource, /client = conversationOnly \? ensureHermesForegroundClient\(\) : ensureHermesClient\(\);/);
  assert.match(mainSource, /conversationOnly \? `foreground-chat:\$\{session\.id\}` : session\.id/);
  assert.match(mainSource, /conversationOnly\s*\? session\.conversationHermesSessionId\s*:\s*session\.hermesSessionId/);
  assert.match(mainSource, /boundedVisibleConversationContext\(session\.id\)/);
  assert.match(mainSource, /conversationHermesSessionId: result\.hermesSessionId/);
  assert.match(mainSource, /prewarmForegroundSession/);
  assert.match(mainSource, /client\.ensureSession\(runtimeSessionId/);
});

test("foreground chat skips persisted ACP history replay while execution keeps resume by default", async () => {
  let resumeRequests = 0;
  let buildCount = 0;
  const phases = [];
  const client = new HermesAcpClient({ resumePersistedSession: false });
  client.start = async () => {};
  client.connection = {
    agent: {
      request: async () => { resumeRequests += 1; },
      attachSession: () => { throw new Error("foreground must not attach replayed history"); },
      buildSession: () => ({
        start: async () => {
          buildCount += 1;
          return { sessionId: "fresh-foreground", dispose() {} };
        }
      })
    }
  };

  const session = await client.ensureSession("foreground-chat:one", {
    hermesSessionId: "persisted-with-long-history",
    onTiming: (phase) => phases.push(phase)
  });
  assert.equal(session.hermesSessionId, "fresh-foreground");
  assert.equal(resumeRequests, 0);
  assert.equal(buildCount, 1);
  assert.deepEqual(phases, ["sessionResumeSkipped", "sessionBuildStart", "sessionBuildEnd"]);
});

test("concurrent foreground prewarm and first prompt share one session build", async () => {
  let releaseBuild;
  let buildCount = 0;
  const client = new HermesAcpClient();
  client.start = async () => {};
  client.connection = {
    agent: {
      buildSession() {
        buildCount += 1;
        return {
          start: () => new Promise((resolve) => {
            releaseBuild = () => resolve({ sessionId: "shared-session", dispose() {} });
          })
        };
      }
    }
  };

  const prewarm = client.ensureSession("foreground-chat:one");
  const firstPrompt = client.ensureSession("foreground-chat:one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(buildCount, 1);
  releaseBuild();
  const [warmed, reused] = await Promise.all([prewarm, firstPrompt]);
  assert.equal(warmed, reused);
  assert.equal(warmed.hermesSessionId, "shared-session");
});

test("a blocked execution client does not delay a foreground client prompt", async () => {
  let releaseExecution;
  const execution = new HermesAcpClient();
  execution.ensureSession = async () => stubSession("execution", [
    new Promise((resolve) => { releaseExecution = resolve; }),
    Promise.resolve({ kind: "stop", stopReason: "end_turn", response: {} })
  ]);
  const foreground = new HermesAcpClient();
  foreground.ensureSession = async () => stubSession("foreground", [
    Promise.resolve({ notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } } } }),
    Promise.resolve({ kind: "stop", stopReason: "end_turn", response: {} })
  ]);

  const longTask = execution.prompt("task-session", "long task", { timeoutMs: 0 });
  const chat = await foreground.prompt("chat-session", "hello", { timeoutMs: 0 });
  assert.equal(chat.text, "你好");
  releaseExecution({ notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
  assert.equal((await longTask).text, "done");
});

test("ACP timing identifies session build, dispatch, first update, and final", async () => {
  const phases = [];
  const client = new HermesAcpClient();
  client.start = async () => {};
  client.connection = {
    agent: {
      buildSession() {
        return { start: async () => stubSession("fresh-session", []).active };
      }
    }
  };
  client.connection.agent.buildSession = () => ({
    start: async () => ({
      sessionId: "fresh-session",
      prompt() {},
      nextUpdate: (() => {
        const updates = [
          Promise.resolve({ notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }),
          Promise.resolve({ kind: "stop", stopReason: "end_turn", response: {} })
        ];
        return () => updates.shift();
      })(),
      dispose() {}
    })
  });
  const result = await client.prompt("fresh-local", "hello", {
    timeoutMs: 0,
    onTiming: (phase) => phases.push(phase)
  });
  assert.equal(result.text, "ok");
  assert.deepEqual(phases, ["clientStart", "sessionBuildStart", "sessionBuildEnd", "promptDispatched", "firstUpdate", "final"]);
});
