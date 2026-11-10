"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildHermesDelegationTasks } = require("./hermes-worker-runtime");
const {
  ensureBundledHermesHome,
  resolveBundledHermesRuntime,
  resolveHermesHome,
  runtimePythonPath
} = require("./hermes-bundled-runtime");

function resolveHermesRoot(options = {}) {
  return resolveHermesHome(options);
}

function resolveDirectHermesLaunch(options = {}) {
  const runtime = resolveBundledHermesRuntime(options);
  const hermesHome = ensureBundledHermesHome(options).home;
  if (runtime) {
    return {
      hermesHome,
      agentRoot: runtime.agentRoot,
      pythonPath: runtime.pythonPath,
      runtime
    };
  }
  const root = resolveHermesRoot(options);
  return {
    hermesHome: root,
    agentRoot: path.join(root, "hermes-agent"),
    pythonPath: "",
    runtime: null
  };
}

function resolvePython(options = {}) {
  const launch = resolveDirectHermesLaunch(options);
  const candidates = [
    options.pythonPath,
    launch.pythonPath,
    path.join(launch.agentRoot, "venv", "Scripts", "python.exe"),
    "python.exe",
    "python"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "python.exe" || candidate === "python" || fs.existsSync(candidate)) || "python";
}

function resolveBridgePath(options = {}) {
  const source = options.resourcesPath
    ? path.join(options.resourcesPath, "app.asar.unpacked", "services", "hermes-direct-delegation.py")
    : "";
  const local = path.join(__dirname, "hermes-direct-delegation.py");
  const candidates = [options.bridgePath, source, local].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Hermes direct delegation bridge was not packaged.");
  return found;
}

function resolveXlsxHelperPath(options = {}) {
  const source = options.resourcesPath
    ? path.join(options.resourcesPath, "app.asar.unpacked", "services", "hms-xlsx-writer.py")
    : "";
  const local = path.join(__dirname, "hms-xlsx-writer.py");
  const candidates = [options.xlsxHelperPath, source, local].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Baiqiu XLSX backend was not packaged.");
  return found;
}

function abortError() {
  const error = new Error("Hermes direct delegation was cancelled.");
  error.name = "AbortError";
  error.code = "HERMES_CANCELLED";
  return error;
}

async function runDirectHermesDelegation({
  assignments = [],
  projectId = "",
  runId = "",
  workspace = "",
  signal = null,
  onUpdate = null,
  onDelegationDiscovered = null,
  options = {}
} = {}) {
  const launch = resolveDirectHermesLaunch(options);
  const python = resolvePython(options);
  const bridge = resolveBridgePath(options);
  const xlsxHelper = resolveXlsxHelperPath(options);
  const hermesRoot = launch.hermesHome;
  const agentRoot = launch.agentRoot;
  const tasks = buildHermesDelegationTasks(assignments, {
    projectId,
    runId,
    workspace,
    xlsxBackend: { pythonPath: python, helperPath: xlsxHelper }
  });
  const parentSessionId = `project-dispatch:${runId}`;
  if (signal?.aborted) throw abortError();
  const request = JSON.stringify({
    hermesRoot,
    agentRoot,
    parentSessionId,
    workspace,
    tasks
  });
  const pythonPath = runtimePythonPath(launch.runtime, [process.env.PYTHONPATH]);

  return await new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl || spawn;
    const child = spawnImpl(python, ["-u", bridge], {
      cwd: options.spawnCwd || process.env.SystemRoot || "C:\\Windows",
      env: {
        ...process.env,
        HERMES_HOME: hermesRoot,
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        BAIQIU_HMS_PYTHON: python,
        BAIQIU_XLSX_HELPER: xlsxHelper
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutBuffer = "";
    const payloads = [];
    let stderr = "";
    let lastProgressAt = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch {}
      finish(reject, abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const consumeProtocolLine = (line) => {
      const value = String(line || "").trim();
      if (!value) return;
      let payload;
      try { payload = JSON.parse(value); } catch { return; }
      payloads.push(payload);
      if (payload.type === "delegation" && payload.delegationId) {
        void onDelegationDiscovered?.({
          hermesParentSessionId: parentSessionId,
          delegationId: String(payload.delegationId),
          bindings: assignments.map((assignment, taskIndex) => ({ assignmentId: assignment.assignmentId, taskIndex }))
        });
      }
    };
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(consumeProtocolLine);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16000);
      if (Date.now() - lastProgressAt >= 2000) {
        lastProgressAt = Date.now();
        onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hermes 员工正在真实执行..." } });
      }
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      consumeProtocolLine(stdoutBuffer);
      const payload = [...payloads].reverse().find((item) => Object.prototype.hasOwnProperty.call(item, "ok")) || null;
      if (!payload?.ok) {
        const error = new Error(payload?.error || `Hermes direct delegation exited with code ${code}.`);
        error.code = "HERMES_DIRECT_DELEGATION_FAILED";
        error.diagnostic = stderr;
        return finish(reject, error);
      }
      const delegationId = String(payload.delegationId || "").trim();
      const results = (Array.isArray(payload.results) ? payload.results : []).map((item, index) => ({
        taskIndex: Number.isInteger(item.task_index) ? item.task_index : index,
        status: String(item.status || "failed"),
        summary: String(item.summary || ""),
        model: String(item.model || ""),
        apiCalls: Number(item.api_calls || 0),
        tokens: item.tokens || null,
        durationSeconds: item.duration_seconds ?? null,
        exitReason: String(item.exit_reason || ""),
        liveTranscript: String(item.live_transcript || ""),
        error: String(item.error || ""),
        delegationId
      }));
      return finish(resolve, {
        hermesSessionId: String(payload.hermesSessionId || parentSessionId),
        delegationIds: [delegationId],
        delegationCompletions: [{
          delegationId,
          status: results.every((item) => item.status === "completed") ? "completed" : "failed",
          event: { goals: tasks.map((task) => task.goal), results }
        }],
        delegationResults: results,
        directHermes: true,
        diagnostic: stderr
      });
    });
    child.stdin.end(request);
  });
}

module.exports = { resolveBridgePath, resolveDirectHermesLaunch, resolveHermesRoot, resolvePython, resolveXlsxHelperPath, runDirectHermesDelegation };
