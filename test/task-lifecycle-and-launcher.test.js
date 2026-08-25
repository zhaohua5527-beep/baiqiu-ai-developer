"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { TaskBrain } = require("../services/task-brain");
const { launchWindowsApplication, wpsCandidates } = require("../services/windows-app-launcher");
const { normalizeManifest } = require("../services/online-update-checker");

test("TaskBrain persists immediately and a late completion cannot overwrite a timeout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-lifecycle-"));
  try {
    const changes = [];
    const brain = new TaskBrain({ root, onChange: (task) => changes.push(task.status) });
    const task = brain.submit({
      sessionId: "session-1",
      input: "open calculator",
      timing: { profile: "local_launch", softTimeoutMs: 10, hardTimeoutMs: 20 }
    });
    assert.equal(task.status, "submitted");
    assert.equal(fs.existsSync(path.join(root, "tasks.json")), true);
    brain.markDelayed(task.task_id, "still working");
    brain.markTimedOut(task.task_id, "deadline reached");
    const afterLateCompletion = brain.complete(task.task_id, "late success");
    assert.equal(afterLateCompletion.status, "timed_out");
    assert.equal(afterLateCompletion.error, "deadline reached");
    assert.deepEqual(changes.slice(-3), ["submitted", "delayed", "timed_out"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launcher starts calculator and uses a discovered WPS executable", async () => {
  const launches = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = 321;
    child.unref = () => {};
    launches.push({ command, args });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const calculator = await launchWindowsApplication("calculator", { spawn });
  assert.equal(calculator.executable, "calc.exe");
  const env = { ProgramFiles: "C:\\Program Files" };
  const wpsPath = wpsCandidates(env)[0];
  const wps = await launchWindowsApplication("wps", { spawn, environment: env, exists: (file) => file === wpsPath });
  assert.equal(wps.executable, wpsPath);
  assert.deepEqual(launches.map((item) => item.command), ["calc.exe", wpsPath]);
});

test("online manifest keeps installer delivery metadata separate from hot-update ZIP metadata", () => {
  const info = normalizeManifest({
    version: "3.0.7",
    downloadUrl: "https://example.test/baiqiu-3.0.7.zip",
    sha256: "a".repeat(64),
    size: 42,
    packageType: "full-client",
    installerUrl: "https://example.test/BaiqiuAI-Setup-3.0.7.exe",
    installerSha256: "b".repeat(64),
    installerSize: 84
  }, { currentVersion: "3.0.6" });
  assert.equal(info.downloadUrl.endsWith(".zip"), true);
  assert.equal(info.installerUrl.endsWith(".exe"), true);
  assert.equal(info.installerSha256, "b".repeat(64));
  assert.equal(info.installerSize, 84);
});
