const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const {
  ensureBundledHermesHome,
  resolveBundledHermesRuntime,
  resolveHermesHome,
  runtimePythonPath
} = require("./hermes-bundled-runtime");

const DEFAULT_HERMES_RELATIVE_PATH = path.join(
  "hermes",
  "hermes-agent",
  "venv",
  "Scripts",
  "hermes-acp.exe"
);

const WINDOWS_BASH_PREFLIGHT = `try:
    from tools.environments.local import _find_bash
    _find_bash()
except Exception as error:
    import sys
    print(f"Hermes Git Bash preflight failed: {error}", file=sys.stderr)
`;

function firstExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return "";
}

function resolveSpawnCwd(options = {}) {
  const requested = String(options.cwd || "").trim();
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [options.spawnCwd, requested, systemRoot, "C:\\Windows", process.cwd()]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => !/[^\x00-\x7F]/.test(candidate) && fs.existsSync(candidate))
    || candidates.find((candidate) => fs.existsSync(candidate))
    || process.cwd();
}

function resolveHermesAcpLaunch(options = {}) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const explicit = firstExistingPath([
    options.executablePath,
    process.env.HERMES_ACP_PATH
  ]);
  if (explicit) return { executablePath: explicit, args: [], runtime: null };

  const runtime = resolveBundledHermesRuntime(options);
  if (runtime) {
    return {
      executablePath: runtime.pythonPath,
      args: ["-m", "acp_adapter.entry"],
      runtime
    };
  }

  return {
    executablePath: firstExistingPath([
    options.resourcesPath && path.join(options.resourcesPath, "hermes", "hermes-acp.exe"),
    path.join(localAppData, DEFAULT_HERMES_RELATIVE_PATH)
    ]),
    args: [],
    runtime: null
  };
}

function resolveHermesAcpExecutable(options = {}) {
  return resolveHermesAcpLaunch(options).executablePath;
}

function resolveAcpSdkEntry(options = {}) {
  const resourcesPath = String(options.resourcesPath || "").trim();
  return firstExistingPath([
    options.sdkEntryPath,
    resourcesPath && path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@agentclientprotocol",
      "sdk",
      "dist",
      "acp.js"
    )
  ]);
}

function createAcpSdkLoader(options = {}) {
  return async () => {
    const physicalEntry = resolveAcpSdkEntry(options);
    if (physicalEntry) return import(pathToFileURL(physicalEntry).href);
    return import("@agentclientprotocol/sdk");
  };
}

function ensureHermesPythonCompat(options = {}) {
  if ((options.platform || process.platform) !== "win32") return "";
  const directory = path.resolve(options.pythonCompatPath || path.join(os.tmpdir(), "baiqiu-hermes-python-compat"));
  const file = path.join(directory, "sitecustomize.py");
  fs.mkdirSync(directory, { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current !== WINDOWS_BASH_PREFLIGHT) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, WINDOWS_BASH_PREFLIGHT, "utf8");
    fs.renameSync(temp, file);
  }
  return directory;
}

function redactDiagnostic(value = "") {
  return String(value)
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1***")
    .slice(-8000);
}

function dataUrlPayload(value = "") {
  const match = String(value).match(/^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? { mimeType: match[1], data: match[2].replace(/\s+/g, "") } : null;
}

function attachmentPath(attachment = {}) {
  return attachment.sourcePath
    || attachment.path
    || attachment.originalPath
    || attachment.filePath
    || "";
}

function promptBlocks(text = "", attachments = []) {
  const blocks = [];
  const normalizedText = String(text || "").trim();
  if (normalizedText) blocks.push({ type: "text", text: normalizedText });

  for (const attachment of attachments || []) {
    const image = String(attachment.mimeType || "").startsWith("image/")
      ? dataUrlPayload(attachment.dataUrl || "")
      : null;
    if (image) {
      blocks.push({ type: "image", ...image });
      continue;
    }

    const file = attachmentPath(attachment);
    if (file && path.isAbsolute(file) && fs.existsSync(file)) {
      const stat = fs.statSync(file);
      blocks.push({
        type: "resource_link",
        uri: pathToFileURL(file).href,
        name: attachment.name || path.basename(file),
        mimeType: attachment.mimeType || undefined,
        size: Number.isFinite(stat.size) ? stat.size : undefined
      });
      continue;
    }

    const fallback = String(attachment.textContent || "").trim();
    if (fallback) {
      blocks.push({
        type: "text",
        text: `[Attachment: ${attachment.name || "file"}]\n${fallback}`
      });
    }
  }

  return blocks.length ? blocks : [{ type: "text", text: " " }];
}

function mergeToolUpdate(current = {}, update = {}) {
  return {
    ...current,
    ...update,
    content: update.content || current.content || [],
    locations: update.locations || current.locations || []
  };
}

function looksLikeHermesFailure(text = "") {
  return /^(?:Internal error\b|Queued for the next turn\b|HTTP\s+[45]\d\d\s*:|API\s+(?:error\s*:|call failed\b)|authentication\s+(?:failed|required)\b|provider\s+error\s*:)/i
    .test(String(text || "").trim());
}

function collectFileEvidence(value, output, seen, depth = 0) {
  if (depth > 7 || value == null) return;
  if (typeof value === "string") {
    const candidate = value.replace(/^file:\/+/i, "");
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      const resolved = path.resolve(candidate);
      const key = resolved.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ name: path.basename(resolved), path: resolved, sourcePath: resolved });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileEvidence(item, output, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(path|file|filePath|outputPath|savedPath|uri)$/i.test(key)) {
      collectFileEvidence(item, output, seen, depth + 1);
    } else if (typeof item === "object") {
      collectFileEvidence(item, output, seen, depth + 1);
    }
  }
}

class HermesAcpClient {
  constructor(options = {}) {
    this.options = options;
    this.spawnImpl = options.spawnImpl || spawn;
    this.sdkEntryPath = resolveAcpSdkEntry(options);
    this.sdkLoader = options.sdkLoader || createAcpSdkLoader(options);
    this.permissionHandler = options.permissionHandler || (async () => ({ outcome: { outcome: "cancelled" } }));
    this.onStatus = options.onStatus || (() => {});
    this.logger = options.logger || console;
    this.defaultCwd = resolveSpawnCwd(options);
    this.launch = resolveHermesAcpLaunch(options);
    this.executablePath = this.launch.executablePath;
    this.child = null;
    this.connection = null;
    this.acp = null;
    this.initialization = null;
    this.startPromise = null;
    this.stderrTail = "";
    this.sessions = new Map();
    this.activePrompts = new Map();
    this.stopping = false;
  }

  status(state, detail = {}) {
    this.onStatus({ state, runtime: "hermes", ...detail });
  }

  async start() {
    if (this.connection && this.child && this.child.exitCode == null) return this.initialization;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async _start() {
    this.launch = resolveHermesAcpLaunch(this.options);
    this.executablePath = this.launch.executablePath;
    if (!this.executablePath) {
      const error = new Error("Hermes ACP executable was not found. Install Hermes Agent or set HERMES_ACP_PATH.");
      error.code = "HERMES_ACP_NOT_FOUND";
      this.status("failed", { error: error.message });
      throw error;
    }

    this.status("starting", { executablePath: this.executablePath });
    this.stopping = false;
    this.stderrTail = "";
    const pythonCompatPath = ensureHermesPythonCompat(this.options);
    const prepared = ensureBundledHermesHome(this.options);
    const pythonPath = runtimePythonPath(this.launch.runtime, [pythonCompatPath, process.env.PYTHONPATH]);
    const child = this.spawnImpl(this.executablePath, this.launch.args, {
      cwd: this.defaultCwd,
      env: {
        ...process.env,
        HERMES_HOME: prepared.home || resolveHermesHome(this.options),
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    const childError = new Promise((_, reject) => child.once?.("error", reject));
    child.stderr?.on?.("data", (chunk) => {
      this.stderrTail = redactDiagnostic(`${this.stderrTail}${chunk.toString("utf8")}`);
    });
    child.once?.("exit", (code, signal) => this._handleExit(child, code, signal));

    try {
      this.acp = await this.sdkLoader();
      const app = this.acp.client({ name: this.options.clientName || "baiqiu-ai" })
        .onRequest(this.acp.methods.client.session.requestPermission, (context) => this.permissionHandler(context.params));
      const stream = this.acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout)
      );
      this.connection = app.connect(stream);
      const initializationTimeout = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("Hermes ACP initialize timed out after 15000ms.");
          error.code = "HERMES_ACP_INITIALIZE_TIMEOUT";
          reject(error);
        }, 15000);
        timer.unref?.();
      });
      this.initialization = await Promise.race([
        this.connection.agent.request(this.acp.methods.agent.initialize, {
          protocolVersion: this.acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: this.options.clientName || "baiqiu-ai",
            version: this.options.clientVersion || "3.0.0"
          }
        }),
        childError.then((error) => {
          const wrapped = new Error(`Hermes ACP process failed to start: ${error.message}`);
          wrapped.code = error.code || "HERMES_ACP_PROCESS_ERROR";
          throw wrapped;
        }),
        initializationTimeout
      ]);
      this.status("ready", {
        protocolVersion: this.initialization.protocolVersion,
        agentInfo: this.initialization.agentInfo,
        capabilities: this.initialization.agentCapabilities
      });
      return this.initialization;
    } catch (error) {
      this._closeTransport(error);
      const wrapped = new Error(`Hermes ACP failed to start: ${error.message}`);
      wrapped.code = error.code || "HERMES_ACP_START_FAILED";
      wrapped.diagnostic = this.stderrTail;
      this.status("failed", { error: wrapped.message });
      throw wrapped;
    }
  }

  _handleExit(child, code, signal) {
    if (child !== this.child) return;
    const expected = this.stopping;
    this.child = null;
    this.connection = null;
    this.initialization = null;
    for (const session of this.sessions.values()) session.active?.dispose?.();
    this.sessions.clear();
    this.activePrompts.clear();
    this.status(expected ? "stopped" : "failed", {
      exitCode: code,
      signal: signal || null,
      error: expected ? "" : "Hermes ACP process exited unexpectedly.",
      diagnostic: expected ? "" : this.stderrTail
    });
  }

  _closeTransport(error) {
    try { this.connection?.close?.(error); } catch {}
    try { this.child?.kill?.(); } catch {}
    this.connection = null;
    this.child = null;
    this.initialization = null;
  }

  async ensureSession(localSessionId, options = {}) {
    if (!localSessionId) throw new Error("A local session id is required.");
    await this.start();
    const cached = this.sessions.get(localSessionId);
    if (cached?.active) return cached;

    const cwd = path.resolve(options.cwd || this.defaultCwd);
    let active;
    let hermesSessionId = String(options.hermesSessionId || "").trim();
    if (hermesSessionId) {
      try {
        await this.connection.agent.request(this.acp.methods.agent.session.resume, {
          sessionId: hermesSessionId,
          cwd,
          mcpServers: []
        });
        active = this.connection.agent.attachSession({ sessionId: hermesSessionId });
      } catch (error) {
        this.logger.warn?.(`[HermesACP] Could not resume ${hermesSessionId}; creating a new session: ${error.message}`);
        hermesSessionId = "";
      }
    }

    if (!active) {
      active = await this.connection.agent.buildSession(cwd).start();
      hermesSessionId = active.sessionId;
    }

    const session = { localSessionId, hermesSessionId, cwd, active };
    this.sessions.set(localSessionId, session);
    return session;
  }

  async prompt(localSessionId, text, options = {}) {
    if (this.activePrompts.has(localSessionId)) {
      const error = new Error("This Hermes session already has an active prompt.");
      error.code = "HERMES_SESSION_BUSY";
      throw error;
    }

    const session = await this.ensureSession(localSessionId, options);
    const signal = options.signal || null;
    if (signal?.aborted) {
      const error = new Error("Hermes prompt was cancelled before it started.");
      error.name = "AbortError";
      throw error;
    }

    const tools = new Map();
    const updates = [];
    let output = "";
    let rejectAbort;
    let timeoutTimer = null;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || this.options.promptTimeoutMs || 90000));
    const abortUpdate = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const timeoutUpdate = new Promise((resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        void this.cancel(localSessionId);
        const error = new Error(`Hermes prompt timed out after ${timeoutMs}ms.`);
        error.code = "HERMES_PROMPT_TIMEOUT";
        reject(error);
      }, timeoutMs);
    });
    const onAbort = () => {
      void this.cancel(localSessionId);
      const error = new Error("Hermes prompt was cancelled locally.");
      error.name = "AbortError";
      error.code = "HERMES_CANCELLED";
      rejectAbort(error);
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    this.activePrompts.set(localSessionId, { hermesSessionId: session.hermesSessionId });

    try {
      session.active.prompt(promptBlocks(text, options.attachments || []));
      for (;;) {
        let message;
        try {
          message = await Promise.race([session.active.nextUpdate(), abortUpdate, timeoutUpdate]);
        } catch (error) {
          if (error?.code === "HERMES_PROMPT_TIMEOUT") {
            session.active?.dispose?.();
            this.sessions.delete(localSessionId);
          }
          if (error?.name !== "AbortError") throw error;
          session.active?.dispose?.();
          this.sessions.delete(localSessionId);
          return {
            status: "cancelled",
            text: output,
            stopReason: "cancelled",
            response: null,
            hermesSessionId: session.hermesSessionId,
            toolCalls: [...tools.values()],
            files: [],
            updates
          };
        }
        if (message.kind === "stop") {
          const files = [];
          collectFileEvidence([...tools.values()], files, new Set());
          const status = message.stopReason === "cancelled"
            ? "cancelled"
            : (message.stopReason === "refusal" || looksLikeHermesFailure(output) ? "failed" : "done");
          return {
            status,
            text: output,
            stopReason: message.stopReason,
            response: message.response,
            hermesSessionId: session.hermesSessionId,
            toolCalls: [...tools.values()],
            files,
            updates
          };
        }

        const update = message.notification?.update || message.update;
        if (!update) continue;
        updates.push(update);
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          output += update.content.text || "";
        } else if (update.sessionUpdate === "tool_call") {
          tools.set(update.toolCallId, mergeToolUpdate({}, update));
        } else if (update.sessionUpdate === "tool_call_update") {
          tools.set(update.toolCallId, mergeToolUpdate(tools.get(update.toolCallId), update));
        }
        options.onUpdate?.(update, {
          text: output,
          hermesSessionId: session.hermesSessionId,
          toolCalls: [...tools.values()]
        });
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener?.("abort", onAbort);
      this.activePrompts.delete(localSessionId);
    }
  }

  async cancel(localSessionId) {
    const session = this.sessions.get(localSessionId);
    if (!session || !this.connection || !this.acp) return false;
    this.connection.agent.notify(this.acp.methods.agent.session.cancel, {
      sessionId: session.hermesSessionId
    });
    return true;
  }

  sessionIdFor(localSessionId) {
    const id = String(localSessionId || "").trim();
    return this.sessions.get(id)?.hermesSessionId
      || this.activePrompts.get(id)?.hermesSessionId
      || "";
  }

  hasActivePrompt(localSessionId) {
    return this.activePrompts.has(localSessionId);
  }

  releaseSession(localSessionId) {
    const id = String(localSessionId || "").trim();
    const session = this.sessions.get(id);
    if (!session || this.activePrompts.has(id)) return false;
    session.active?.dispose?.();
    this.sessions.delete(id);
    return true;
  }

  async deleteSession(localSessionId) {
    const session = this.sessions.get(localSessionId);
    if (!session) return false;
    await this.cancel(localSessionId);
    session.active?.dispose?.();
    this.sessions.delete(localSessionId);
    const canDelete = this.initialization?.agentCapabilities?.sessionCapabilities?.delete;
    if (canDelete) {
      await this.connection.agent.request(this.acp.methods.agent.session.delete, {
        sessionId: session.hermesSessionId
      });
    }
    return true;
  }

  async stop() {
    this.stopping = true;
    for (const localSessionId of this.activePrompts.keys()) await this.cancel(localSessionId);
    for (const session of this.sessions.values()) session.active?.dispose?.();
    this.sessions.clear();
    this.activePrompts.clear();
    this._closeTransport();
    this.status("stopped");
  }

  health() {
    return {
      runtime: "hermes",
      executablePath: this.executablePath,
      bundled: Boolean(this.launch?.runtime),
      hermesHome: resolveHermesHome(this.options),
      sdkEntryPath: this.sdkEntryPath,
      installed: Boolean(this.executablePath),
      connected: Boolean(this.connection && this.child && this.child.exitCode == null),
      agentInfo: this.initialization?.agentInfo || null,
      capabilities: this.initialization?.agentCapabilities || null,
      activeSessions: this.sessions.size,
      activePrompts: this.activePrompts.size,
      diagnostic: this.connection ? "" : this.stderrTail
    };
  }
}

module.exports = {
  HermesAcpClient,
  collectFileEvidence,
  createAcpSdkLoader,
  ensureHermesPythonCompat,
  looksLikeHermesFailure,
  promptBlocks,
  redactDiagnostic,
  resolveAcpSdkEntry,
  resolveHermesAcpLaunch,
  resolveHermesAcpExecutable,
  resolveSpawnCwd
};
