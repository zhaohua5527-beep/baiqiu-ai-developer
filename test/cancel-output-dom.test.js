"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const marker = "CANCEL_DOM_RESULT:";

if (process.argv.includes("--cancel-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadURL("data:text/html,<main></main>");
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const lifecycle = source.slice(source.indexOf("function discardLiveChatStreamsForSession("), source.indexOf("function formatTaskDuration("));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const liveChatStreams = new Map();
      const state = { abortRequestedSessions: new Set(), abortedStreamIds: new Set() };
      const LIVE_TURN_STATES = { CLOSED: "closed", VIEW_DRAINED: "drained" };
      const activeSendOwners = new Map();
      const transitionLiveTurn = () => {};
      const miniTheatre = { finish: () => {} };
      const sessionTaskQueue = { setActive: () => {}, isPending: () => false };
      const reportStartupMetric = () => {};
      const removeSessionExecutionIndicator = () => {};
      const releaseActiveSendOwner = () => {};
      const removeThinkingMessage = (row) => row?.remove();
      const filterAssistantExecutionOutput = (text) => text;
      const ensureAssistantCopyAction = () => {};
      const ensureLiveStreamRow = (entry) => entry.row;
      const stopExecutionActivityFlow = () => {};
      const freezeLiveStreamElapsed = (entry) => { entry.completedAt = 1000; };
      ${lifecycle}
      const results = [];
      for (const expanded of ["0", "1"]) for (const text of ["", "正文写到半句"]) {
        const row = document.createElement("div");
        row.innerHTML = '<div class="bubble"><div class="streaming-activity"><pre>python task.py</pre><div>第一阶段回复</div></div><div class="rendered"></div></div>';
        document.querySelector("main").appendChild(row);
        const activity = row.querySelector(".streaming-activity");
        activity.dataset.activityExpanded = expanded;
        const stage = activity.lastElementChild;
        const answer = row.querySelector(".rendered");
        answer.textContent = text;
        const entry = { streamId: "run", sessionId: "session", responseMessageId: "response", row, activity,
          rendered: answer, text, streamedAnswerText: text, structuredNodes: new Map([["stage", stage]]) };
        entry.elapsedTimer = setInterval(() => { row.dataset.ticked = "1"; }, 10);
        stage.__structuredFadeTimer = setTimeout(() => stage.remove(), 20);
        liveChatStreams.set(entry.streamId, entry);
        preserveCancelledLiveChatStream(entry);
        preserveCancelledLiveChatStream(entry);
        discardLiveChatStreamsForSession("session", { force: true });
        await new Promise(resolve => setTimeout(resolve, 40));
        results.push({ connected: row.isConnected, stageConnected: stage.isConnected,
          process: activity.textContent, answer: answer.textContent, expanded: activity.dataset.activityExpanded,
          notices: row.querySelectorAll(".execution-live-notice").length,
          streamReleased: !liveChatStreams.size, timerStopped: !row.dataset.ticked });
      }
      return results;
    })()`);
    process.stdout.write(marker + JSON.stringify(result) + "\n", () => app.exit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const assert = require("node:assert/strict");
  const test = require("node:test");
  const { spawn } = require("node:child_process");
  test("stop retains exact process and partial answer nodes, expansion, and stops timers", async () => {
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require("electron"), [__filename, "--cancel-dom"], { cwd: root, env, windowsHide: true });
      let output = ""; let errors = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("cancel DOM test timed out")); }, 15000);
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { errors += data; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => {
        clearTimeout(timer);
        if (code || !output.includes(marker)) return reject(new Error(errors || output));
        resolve(JSON.parse(output.split(marker).at(-1).trim()));
      });
    });
    assert.deepEqual(result, ["0", "1"].flatMap(expanded => ["", "正文写到半句"].map(answer => ({
      connected: true, stageConnected: true, process: "python task.py第一阶段回复", answer,
      expanded, notices: 0, streamReleased: true, timerStopped: true
    }))));
  });
}
