"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForValue(probe, { timeoutMs = 20_000, intervalMs = 80, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data || "{}"));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "CDP request failed"));
      else resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    await this.call("Runtime.enable");
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "renderer evaluation failed";
      throw new Error(description);
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function rendererTarget(port) {
  return waitForValue(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && /renderer-v2[\\/]index\.html/i.test(item.url));
  }, { label: "Electron renderer target" });
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    delay(timeoutMs).then(() => null)
  ]);
}

test("full Electron conversation streams, persists, aborts, and restores in isolated user data", { timeout: 120_000 }, async () => {
  assert.equal(fs.existsSync(electron), true, "Electron runtime is required for the full interaction test");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-full-e2e-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const storageRoot = path.join(tempRoot, "storage");
  const desktopRoot = path.join(tempRoot, "desktop");
  fs.mkdirSync(desktopRoot, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env,
    BAIQIU_E2E_TEST: "1",
    BAIQIU_USER_DATA_ROOT: userDataRoot,
    BAIQIU_STORAGE_ROOT: storageRoot,
    BAIQIU_DESKTOP_ROOT: desktopRoot,
    BAIQIU_DISABLE_LEGACY_MIGRATION: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [`--remote-debugging-port=${port}`, root, "--dev", "--baiqiu-e2e-test"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const remember = (chunk) => {
    output = `${output}${String(chunk || "")}`.slice(-16_000);
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  let cdp = null;
  try {
    const target = await rendererTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await waitForValue(() => cdp.evaluate(`Boolean(
      document.readyState === "complete"
      && window.heiqiu
      && document.querySelector("#chatInput")
      && document.querySelector("#sendBtn")
      && !document.querySelector(".fatal-error-overlay")
    )`), { label: "Baiqiu conversation UI" });

    const sessionId = await cdp.evaluate(`window.heiqiu.init().then((db) => db.selectedSessionId)`);
    assert.ok(sessionId, "the isolated app should create a selected session");

    await cdp.evaluate(`(() => {
      const input = document.querySelector("#chatInput");
      input.value = "运行完整 E2E 对话";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#chatForm").requestSubmit();
      return true;
    })()`);

    let publicReasoning;
    try {
      publicReasoning = await waitForValue(() => cdp.evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.structured-result-entry-thinking:not([data-lifecycle="exiting"])')];
        return nodes.map((node) => node.textContent).find((text) => text.includes("公开事件")) || "";
      })()`), { label: "public reasoning typewriter", timeoutMs: 5_000 });
    } catch (error) {
      const snapshot = await cdp.evaluate(`(() => ({
        body: document.body.innerText.slice(-4000),
        inputDisabled: document.querySelector("#chatInput")?.disabled,
        sendDisabled: document.querySelector("#sendBtn")?.disabled,
        sendTitle: document.querySelector("#sendBtn")?.title,
        thinkingRows: document.querySelectorAll(".thinking-message, .streaming-response").length,
        thoughtNodes: [...document.querySelectorAll(".structured-result-entry-thinking")].map((node) => ({
          hidden: node.closest(".stream-segment-structured")?.hidden || false,
          text: node.textContent,
          lifecycle: node.dataset.lifecycle || ""
        })),
        live: typeof liveChatStreams === "undefined" ? [] : [...liveChatStreams.values()].map((entry) => ({
          streamId: entry.streamId,
          terminalType: entry.terminalType,
          lastFrameSequence: entry.lastFrameSequence,
          lastActivitySequence: entry.lastActivitySequence,
          reasoningCount: entry.reasoningDetails?.length || 0,
          currentThoughtText: entry.currentThoughtText,
          currentThoughtVisibleText: entry.currentThoughtVisibleText,
          revealTimer: Boolean(entry.reasoningRevealTimer),
          seenEvents: [...(entry.seenEventIds || [])],
          seenActivityEvents: [...(entry.seenActivityEventIds || [])]
        })),
        fatal: document.querySelector(".fatal-error-overlay")?.innerText || ""
      }))()`);
      throw new Error(`${error.message}\nRenderer snapshot: ${JSON.stringify(snapshot)}\nProcess output:\n${output}`);
    }
    assert.match(publicReasoning, /公开事件/);

    await waitForValue(() => cdp.evaluate(`document.body.textContent.includes("第一段真实答案已经输出")`), {
      label: "first permanent answer segment"
    });
    let secondReasoning;
    try {
      secondReasoning = await waitForValue(() => cdp.evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.structured-result-entry-thinking:not([data-lifecycle="exiting"])')];
        return nodes.map((node) => node.textContent).find((text) => text.includes("第二段表格与代码")) || "";
      })()`), { label: "second public reasoning typewriter", timeoutMs: 5_000 });
    } catch (error) {
      const snapshot = await cdp.evaluate(`(() => ({
        thoughtNodes: [...document.querySelectorAll(".structured-result-entry-thinking")].map((node) => ({
          hidden: node.closest(".stream-segment-structured")?.hidden || false,
          text: node.textContent,
          lifecycle: node.dataset.lifecycle || ""
        })),
        streams: [...liveChatStreams.values()].map((entry) => ({
          activeSegmentId: entry.activeSegmentId,
          segmentOrder: entry.segmentOrder,
          revealedLength: entry.revealedLength,
          targetLength: entry.targetChars?.length || 0,
          currentThoughtText: entry.currentThoughtText,
          currentThoughtVisibleText: entry.currentThoughtVisibleText,
          queuedReasoning: entry.queuedReasoningDeltas,
          reasoningDetails: entry.reasoningDetails
        }))
      }))()`);
      throw new Error(`${error.message}\nSecond reasoning snapshot: ${JSON.stringify(snapshot)}\nOutput:\n${output}`);
    }
    assert.match(secondReasoning, /第二段表格与代码/);

    let structuredWindow;
    try {
      structuredWindow = await waitForValue(async () => {
        const value = await cdp.evaluate(`(() => {
          const nodes = [...document.querySelectorAll(".structured-result-entry")]
            .filter((node) => !node.__structuredRecycling);
          return nodes.map((node) => node.textContent);
        })()`);
        return Array.isArray(value) && value.at(-1)?.includes("4") ? value : null;
      }, { label: "three-entry structured window" });
    } catch (error) {
      const snapshot = await cdp.evaluate(`(() => ({
        nodes: [...document.querySelectorAll(".structured-result-entry")].map((node) => ({
          text: node.textContent,
          sequence: node.dataset.sequence,
          lifecycle: node.dataset.lifecycle || "",
          connected: node.isConnected
        })),
        streams: [...liveChatStreams.values()].map((entry) => ({
          structuredEvents: (entry.structuredEvents || []).map((event) => ({
            eventId: event.eventId,
            sequence: event.sequence,
            message: event.message,
            retired: event.__retired === true
          })),
          ledger: [...(entry.eventLedger?.values?.() || [])].map((item) => ({
            eventId: item.event?.eventId,
            sequence: item.event?.sequence,
            target: item.event?.target,
            type: item.event?.type
          }))
        }))
      }))()`);
      const messages = await cdp.evaluate(`window.heiqiu.messages(${JSON.stringify(sessionId)})`);
      const counts = messages.filter((message) => message.role === "assistant").map((message) => ({
        id: message.id,
        structuredCount: message.raw?.productResult?.structuredEvents?.length || 0,
        sequences: message.raw?.productResult?.structuredEvents?.map((event) => event.sequence) || []
      }));
      throw new Error(`${error.message}\nStructured snapshot: ${JSON.stringify(snapshot)}\nPersisted counts: ${JSON.stringify(counts)}\nOutput:\n${output}`);
    }
    assert.deepEqual(structuredWindow.slice(-3), ["真实结构化事件 2", "真实结构化事件 3", "真实结构化事件 4"]);
    assert.ok([3, 4].includes(structuredWindow.length));

    try {
      await waitForValue(() => cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll(".message.assistant")]
          .find((item) => item.textContent.includes("E2E 最终答案"));
        return Boolean(row && !row.classList.contains("streaming-response"));
      })()`), { label: "durable streamed answer" });
    } catch (error) {
      const snapshot = await cdp.evaluate(`(() => ({
        body: document.body.innerText.slice(-5000),
        streams: [...liveChatStreams.values()].map((entry) => ({
          streamId: entry.streamId,
          finalizing: entry.finalizing,
          finalized: entry.finalized,
          terminalType: entry.terminalType,
          backendCompleted: entry.backendCompleted,
          persistedRowAdopted: entry.persistedRowAdopted,
          rowConnected: Boolean(entry.row?.isConnected),
          revealedLength: entry.revealedLength,
          targetLength: entry.targetChars?.length || 0,
          textLength: entry.text?.length || 0,
          visibleText: entry.visibleText,
          hasFinalizeCallback: typeof entry.finalizeWhenDrained === "function"
        }))
      }))()`);
      const messages = await cdp.evaluate(`window.heiqiu.messages(${JSON.stringify(sessionId)})`);
      throw new Error(`${error.message}\nRenderer snapshot: ${JSON.stringify(snapshot)}\nMessages: ${JSON.stringify(messages)}\nOutput:\n${output}`);
    }
    await waitForValue(() => cdp.evaluate(`!document.querySelector('.structured-result-entry-thinking:not([data-lifecycle="exiting"])')`), {
      label: "public reasoning fade completion",
      timeoutMs: 5_000
    });
    const markdown = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll(".message.assistant")]
        .find((item) => item.textContent.includes("E2E 最终答案"));
      return {
        heading: row?.querySelector("h1")?.textContent || "",
        table: Boolean(row?.querySelector("table")),
        code: row?.querySelector("pre code")?.textContent || "",
        answerSegments: row?.querySelectorAll(".stream-segment-answer").length || 0,
        reasoningVisible: Boolean(row?.querySelector('.structured-result-entry-thinking:not([data-lifecycle="exiting"])'))
      };
    })()`);
    assert.deepEqual(markdown, {
      heading: "E2E 最终答案",
      table: true,
      code: "answer-persisted\n",
      answerSegments: 2,
      reasoningVisible: false
    });

    const completionHistory = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll(".message.assistant")]
        .find((item) => item.textContent.includes("E2E 最终答案"));
      const toggle = row?.querySelector(".execution-activity-toggle");
      const details = () => [...(row?.querySelectorAll(
        ".stream-segment-process, .stream-segment-structured, .stream-segment-reasoning"
      ) || [])].filter((node) => node.textContent.trim());
      const collapsed = details().every((node) => node.hidden);
      toggle?.click();
      const expanded = details().every((node) => !node.hidden);
      const structuredCount = row?.querySelectorAll(".stream-segment-structured .structured-result-entry").length || 0;
      const finalVisible = Boolean(row?.querySelector(".stream-segment-answer h1"));
      toggle?.click();
      const recollapsed = details().every((node) => node.hidden);
      return { hasToggle: Boolean(toggle), collapsed, expanded, recollapsed, structuredCount, finalVisible };
    })()`);
    assert.deepEqual(completionHistory, {
      hasToggle: true,
      collapsed: true,
      expanded: true,
      recollapsed: true,
      structuredCount: 4,
      finalVisible: true
    });

    const completedMessages = await cdp.evaluate(`window.heiqiu.messages(${JSON.stringify(sessionId)})`);
    const completedAnswer = completedMessages.find((message) => message.role === "assistant" && message.text.includes("E2E 最终答案"));
    assert.ok(completedAnswer, "the completed answer must be persisted");
    assert.equal(completedAnswer.raw?.productResult?.deliveryStatus, "delivered");
    assert.deepEqual(completedAnswer.raw?.productResult?.structuredEvents?.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(completedAnswer.raw?.productResult?.answerSegments?.map((event) => event.sequence), [1, 2]);

    await cdp.evaluate(`(() => {
      const input = document.querySelector("#chatInput");
      input.value = "[e2e:abort] 验证停止按钮";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#chatForm").requestSubmit();
      return true;
    })()`);
    await waitForValue(() => cdp.evaluate(`Boolean(document.querySelector(".streaming-response, .thinking-message"))`), {
      label: "running abort scenario"
    });
    await cdp.evaluate(`document.querySelector("#sendBtn").click()`);
    const cancelledMessages = await waitForValue(async () => {
      const messages = await cdp.evaluate(`window.heiqiu.messages(${JSON.stringify(sessionId)})`);
      const cancelled = [...messages].reverse().find((message) => (
        message.role === "assistant"
        && (message.raw?.productResult?.status === "cancelled" || /终止|中断/.test(message.text))
      ));
      return cancelled ? messages : null;
    }, { label: "persisted cancellation result" });
    const cancelled = [...cancelledMessages].reverse().find((message) => message.role === "assistant");
    assert.equal(cancelled.raw?.productResult?.status, "cancelled");
    assert.match(cancelled.text, /终止|中断/);

    await cdp.evaluate(`location.reload()`);
    await waitForValue(() => cdp.evaluate(`Boolean(
      document.readyState === "complete"
      && document.body.textContent.includes("E2E 最终答案")
      && /终止|中断/.test(document.body.textContent)
      && !document.querySelector(".fatal-error-overlay")
    )`), { label: "restored answers after reload" });

    const dbFile = path.join(userDataRoot, "heiqiu-db.json");
    assert.equal(fs.existsSync(dbFile), true, "the test database must stay under the isolated user-data root");
    const persistedDb = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    const persistedMessages = persistedDb.messages?.[sessionId] || [];
    assert.equal(persistedMessages.some((message) => message.role === "assistant" && message.text.includes("E2E 最终答案")), true);
    assert.equal(persistedMessages.some((message) => message.raw?.productResult?.status === "cancelled"), true);
    assert.equal(fs.readdirSync(desktopRoot).length, 0, "E2E startup must not create or alter desktop shortcuts");

    await cdp.evaluate(`window.heiqiu.windowControl("close-quit")`);
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0, `Electron exited unexpectedly. Output:\n${output}`);
  } finally {
    cdp?.close();
    if (child.exitCode === null) child.kill();
    await waitForExit(child, 5_000);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("five semantic event scenarios traverse the real renderer stream reducer", { timeout: 120_000 }, async () => {
  assert.equal(fs.existsSync(electron), true, "Electron runtime is required for semantic event E2E");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-semantic-e2e-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const storageRoot = path.join(tempRoot, "storage");
  const desktopRoot = path.join(tempRoot, "desktop");
  fs.mkdirSync(desktopRoot, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env,
    BAIQIU_E2E_TEST: "1",
    BAIQIU_USER_DATA_ROOT: userDataRoot,
    BAIQIU_STORAGE_ROOT: storageRoot,
    BAIQIU_DESKTOP_ROOT: desktopRoot,
    BAIQIU_DISABLE_LEGACY_MIGRATION: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [`--remote-debugging-port=${port}`, root, "--dev", "--baiqiu-e2e-test"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const remember = (chunk) => { output = `${output}${String(chunk || "")}`.slice(-16_000); };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  let cdp = null;
  const scenarios = [
    ["thinking_tool_final", ["thinking", "tool", "final"]],
    ["thinking_cross_tool_final", ["thinking", "cross", "tool", "final"]],
    ["thinking_cross_stage_result_thinking_tool_final", ["thinking", "cross", "stage_result", "thinking", "tool", "final"]],
    ["thinking_thinking_thinking_tool_final", ["thinking", "thinking", "thinking", "tool", "final"]],
    ["stage_result_final", ["stage_result", "final"]]
  ];
  try {
    const target = await rendererTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await waitForValue(() => cdp.evaluate(`Boolean(
      document.readyState === "complete"
      && window.heiqiu
      && document.querySelector("#chatInput")
      && !document.querySelector(".fatal-error-overlay")
    )`), { label: "semantic E2E renderer" });
    const sessionId = await cdp.evaluate(`window.heiqiu.init().then((db) => db.selectedSessionId)`);
    assert.ok(sessionId);
    await cdp.evaluate(`(() => {
      window.__baiqiuSemanticSnapshots = new Map();
      const contract = window.BaiqiuBlackBallPublicEvents;
      const originalReduce = contract.reduceEventState;
      contract.reduceEventState = (previous, event) => {
        const next = originalReduce(previous, event);
        if (next.finalReceived) {
          window.__baiqiuSemanticSnapshots.set(next.turnId, JSON.parse(JSON.stringify(next)));
        }
        return next;
      };
      return true;
    })()`);

    for (let index = 0; index < scenarios.length; index += 1) {
      const [scenarioId, expectedTypes] = scenarios[index];
      const streamId = `semantic-e2e-${index + 1}`;
      await cdp.evaluate(`(() => {
        void sendCurrentTask({
          text: ${JSON.stringify(`运行语义事件场景 ${index + 1}`)},
          attachments: [],
          context: { e2eEventScenario: ${JSON.stringify(scenarioId)} }
        }, ${JSON.stringify(sessionId)}, { streamId: ${JSON.stringify(streamId)} });
        return true;
      })()`);
      let snapshot;
      try {
        snapshot = await waitForValue(() => cdp.evaluate(`(() => {
          const entry = liveChatStreams.get(${JSON.stringify(streamId)});
          const protocol = entry?.publicEventState
            || window.__baiqiuSemanticSnapshots?.get(${JSON.stringify(streamId)});
          if (!protocol?.finalReceived) return null;
          return {
            types: protocol.events.map((event) => event.semanticType),
            hasCross: protocol.hasCross,
            stageResultCount: protocol.stageResultCount,
            violations: protocol.violations,
            rowConnected: Boolean(entry?.row?.isConnected
              || [...document.querySelectorAll(".message.assistant")].some((row) => row.textContent.includes(${JSON.stringify(`E2E ${scenarioId} 最终结果`)})))
          };
        })()`), { label: `semantic scenario ${scenarioId}`, timeoutMs: 10_000, intervalMs: 20 });
      } catch (error) {
        const diagnostic = await cdp.evaluate(`(() => ({
          streamIds: [...liveChatStreams.keys()],
          activeOwners: [...activeSendOwners.entries()],
          protocol: liveChatStreams.get(${JSON.stringify(streamId)})?.publicEventState
            || window.__baiqiuSemanticSnapshots?.get(${JSON.stringify(streamId)})
            || null,
          fatal: document.querySelector(".fatal-error-overlay")?.textContent || "",
          bodyTail: document.body.innerText.slice(-1200)
        }))()`);
        throw new Error(`${error.message}\nDiagnostic: ${JSON.stringify(diagnostic)}\nOutput:\n${output}`);
      }
      assert.deepEqual(snapshot.types, expectedTypes, scenarioId);
      assert.equal(snapshot.hasCross, expectedTypes.includes("cross"), scenarioId);
      assert.equal(snapshot.stageResultCount, expectedTypes.filter((type) => type === "stage_result").length, scenarioId);
      assert.deepEqual(snapshot.violations, [], scenarioId);
      assert.equal(snapshot.rowConnected, true, scenarioId);
      await waitForValue(() => cdp.evaluate(`!liveChatStreams.has(${JSON.stringify(streamId)})`), {
        label: `semantic scenario cleanup ${scenarioId}`,
        timeoutMs: 15_000
      });
    }

    assert.equal(fs.readdirSync(desktopRoot).length, 0, "semantic E2E must not touch the desktop");
    await cdp.evaluate(`window.heiqiu.windowControl("close-quit")`);
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0, `Electron exited unexpectedly. Output:\n${output}`);
  } finally {
    cdp?.close();
    if (child.exitCode === null) child.kill();
    await waitForExit(child, 5_000);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
