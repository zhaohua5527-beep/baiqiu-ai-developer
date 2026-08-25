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

const WINDOWS_BASH_PREFLIGHT = `import sys

try:
    from tools.environments.local import _find_bash
    _find_bash()
except Exception as error:
    print(f"Hermes Git Bash preflight failed: {error}", file=sys.stderr)

try:
    from agent import prompt_builder
    prompt_builder.DEVELOPER_ROLE_MODELS = ()
except Exception as error:
    print(f"Hermes message-role compatibility failed: {error}", file=sys.stderr)
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

function toolCallSignature(update = {}) {
  const tool = update.toolCall && typeof update.toolCall === "object" ? update.toolCall : {};
  const name = String(update.title || update.name || tool.title || tool.name || "tool").trim().toLowerCase();
  const input = update.rawInput || update.input || tool.rawInput || tool.input || {};
  let serialized = "";
  try {
    serialized = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    serialized = String(input || "");
  }
  return `${name}|${serialized.replace(/\s+/g, " ").trim().slice(0, 1200)}`;
}

function looksLikeHermesFailure(text = "") {
  const value = String(text || "").trim();
  if (/^(?:Internal error\b|Queued for the next turn\b|HTTP\s+[45]\d\d\s*:|API\s+(?:error\s*:|call failed\b)|authentication\s+(?:failed|required)\b|provider\s+error\s*:)/i.test(value)) {
    return true;
  }
  return /^(?:billing|credits?).{0,80}(?:exhausted|insufficient|balance)|\bHTTP\s*402\b|\binsufficient\s+(?:account\s+)?balance\b/i
    .test(value.slice(0, 600));
}

const OUTPUT_FILE_PATH_PATTERN = /[A-Za-z]:[\\/][^\r\n|<>"?*]+?\.(?:xlsx|xls|csv|docx|doc|pdf|pptx|ppt|txt|md|json|zip|png|jpe?g|webp)/gi;

function sensitiveEvidencePath(filePath = "") {
  const value = path.resolve(String(filePath || "")).replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)(?:credentials?|secrets?|private[_ -]?keys?|api[_ -]?keys?|auth[_ -]?tokens?)(?:[\/._ -]|$)|\.(?:pem|pfx|p12|key)$|\/runtime\/(?:hermes-home|hms-[^/]+)\/(?:config\.ya?ml|\.env)$|(?:^|\/)(?:membership|license|activation|entitlement)(?:[\/._ -]|$)/i.test(value);
}

function insideAllowedRoots(filePath = "", roots = []) {
  if (!Array.isArray(roots) || !roots.length) return true;
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const allowed = path.resolve(String(root || ""));
    return resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`);
  });
}

function fileProducingTool(tool = {}) {
  const descriptor = `${tool.kind || ""} ${tool.title || ""} ${tool.name || ""} ${tool.toolCall?.title || ""} ${tool.toolCall?.name || ""}`.toLowerCase();
  if (/(?:write|create|save|export|generate|render|download|copy|move|edit|写入|创建|保存|导出|生成|下载|复制|移动|编辑)/i.test(descriptor)) return true;
  const status = String(tool.status || tool.state || "").toLowerCase();
  const outputText = JSON.stringify(tool.rawOutput || tool.output || tool.result || tool.response || "");
  return /^(?:completed|complete|success|done)$/i.test(status)
    && /(?:saved|created|written|exported|generated|downloaded|已保存|已创建|已写入|已导出|已生成)/i.test(outputText);
}

function collectFileEvidence(value, output, seen, depth = 0, options = {}) {
  if (depth > 7 || value == null) return;
  if (typeof value === "string") {
    const candidates = [
      value.replace(/^file:\/+/i, ""),
      ...[...value.matchAll(OUTPUT_FILE_PATH_PATTERN)].map((match) => match[0])
    ];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
      const resolved = path.resolve(candidate);
      // 过滤非产物路径：Hermes 技能定义（SKILL.md 目录）、Python 运行时、
      // Hermes 内部目录等。白球只应把 HMS 真正生成的产物当附件展示，
      // 不该把技能/运行时文件误收集成"交付文件"。
      const lower = resolved.toLowerCase();
      if (/[\\/](?:skills|plugins|hooks|lsp|bin|venv|site-packages|node_modules|__pycache__)[\\/]/.test(lower)) continue;
      if (/[\\/]\.baiqiu-tmp[\\/]/.test(lower)) continue;
      if (sensitiveEvidencePath(resolved)) continue;
      if (!insideAllowedRoots(resolved, options.allowedRoots)) continue;
      if (Number(options.runStartedAt) > 0) {
        try {
          if (fs.statSync(resolved).mtimeMs + 2000 < Number(options.runStartedAt)) continue;
        } catch {
          continue;
        }
      }
      const key = resolved.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ name: path.basename(resolved), path: resolved, sourcePath: resolved });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileEvidence(item, output, seen, depth + 1, options);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(path|file|filePath|outputPath|savedPath|uri)$/i.test(key) && options.outputSide !== false) {
      collectFileEvidence(item, output, seen, depth + 1, options);
    } else if (/^(?:rawOutput|output|result|response|content)$/i.test(key)) {
      // Only traverse output-side payloads. Input/arguments frequently contain
      // source attachments and must not be presented as generated files.
      collectFileEvidence(item, output, seen, depth + 1, { ...options, outputSide: true });
    } else if (/^locations$/i.test(key) && options.fileProducing === true) {
      collectFileEvidence(item, output, seen, depth + 1, { ...options, outputSide: true });
    }
  }
}

function collectToolFileEvidence(tools = [], options = {}) {
  const files = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!fileProducingTool(tool)) continue;
    collectFileEvidence(tool, files, seen, 0, {
      ...options,
      fileProducing: true,
      outputSide: false
    });
  }
  return files;
}

function emitPromptTiming(client, options, phase, startedAt, detail = {}) {
  const event = {
    phase,
    at: Date.now(),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...detail
  };
  try { options.onTiming?.(phase, event); } catch {}
  try { client.options.onTiming?.(phase, event); } catch {}
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
    this.sessionBuilds = new Map();
    this.activePrompts = new Map();
    this.stopping = false;
  }

  status(state, detail = {}) {
    this.onStatus({ state, runtime: "hermes", ...detail });
  }

  async start() {
    if (this.connection && this.child && this.child.exitCode == null) return this.initialization;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._startWithRetry().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async _startWithRetry() {
    const retries = Math.max(0, Number(this.options.startRetries ?? 1));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this._start(attempt + 1);
      } catch (error) {
        lastError = error;
        if (attempt >= retries) throw error;
        this.status("retrying", { attempt: attempt + 1, error: error.message, diagnostic: error.diagnostic || "" });
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async _start(attempt = 1) {
    this.launch = resolveHermesAcpLaunch(this.options);
    this.executablePath = this.launch.executablePath;
    if (!this.executablePath) {
      const error = new Error("Hermes ACP executable was not found. Install Hermes Agent or set HERMES_ACP_PATH.");
      error.code = "HERMES_ACP_NOT_FOUND";
      this.status("failed", { error: error.message });
      throw error;
    }

    this.status("starting", { executablePath: this.executablePath, attempt });
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
        .onRequest(this.acp.methods.client.session.requestPermission, (context) => {
          const hermesSessionId = String(context.params?.sessionId || "");
          const activePrompt = [...this.activePrompts.values()]
            .find((item) => item.hermesSessionId === hermesSessionId);
          return this.permissionHandler(context.params, activePrompt?.permissionContext || {});
        });
      const stream = this.acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout)
      );
      this.connection = app.connect(stream);
      let initializationTimer = null;
      const initializationTimeout = new Promise((_, reject) => {
        initializationTimer = setTimeout(() => {
          const error = new Error("Hermes ACP initialize timed out after 15000ms.");
          error.code = "HERMES_ACP_INITIALIZE_TIMEOUT";
          reject(error);
        }, 15000);
        initializationTimer.unref?.();
      });
      try {
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
      } finally {
        if (initializationTimer) clearTimeout(initializationTimer);
      }
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
    const pending = this.sessionBuilds.get(localSessionId);
    if (pending) {
      const timingStartedAt = Number(options.timingStartedAt || Date.now());
      emitPromptTiming(this, options, "sessionBuildWaitStart", timingStartedAt, { localSessionId });
      const session = await pending;
      emitPromptTiming(this, options, "sessionBuildWaitEnd", timingStartedAt, {
        localSessionId,
        hermesSessionId: session.hermesSessionId
      });
      return session;
    }

    const build = this._ensureSession(localSessionId, options);
    this.sessionBuilds.set(localSessionId, build);
    try {
      return await build;
    } finally {
      if (this.sessionBuilds.get(localSessionId) === build) this.sessionBuilds.delete(localSessionId);
    }
  }

  async _ensureSession(localSessionId, options = {}) {
    const timingStartedAt = Number(options.timingStartedAt || Date.now());
    await this.start();
    const cached = this.sessions.get(localSessionId);
    if (cached?.active) return cached;

    const cwd = path.resolve(options.cwd || this.defaultCwd);
    let active;
    const persistedHermesSessionId = String(options.hermesSessionId || "").trim();
    const resumePersistedSessions = options.resumePersistedSession !== false
      && this.options.resumePersistedSession !== false;
    let hermesSessionId = resumePersistedSessions ? persistedHermesSessionId : "";
    if (persistedHermesSessionId && !resumePersistedSessions) {
      emitPromptTiming(this, options, "sessionResumeSkipped", timingStartedAt, {
        localSessionId,
        hermesSessionId: persistedHermesSessionId
      });
    }
    if (hermesSessionId) {
      emitPromptTiming(this, options, "sessionResumeStart", timingStartedAt, { localSessionId, hermesSessionId });
      try {
        await this.connection.agent.request(this.acp.methods.agent.session.resume, {
          sessionId: hermesSessionId,
          cwd,
          mcpServers: []
        });
        active = this.connection.agent.attachSession({ sessionId: hermesSessionId });
        emitPromptTiming(this, options, "sessionResumeEnd", timingStartedAt, { localSessionId, hermesSessionId, resumed: true });
      } catch (error) {
        emitPromptTiming(this, options, "sessionResumeEnd", timingStartedAt, { localSessionId, hermesSessionId, resumed: false });
        this.logger.warn?.(`[HermesACP] Could not resume ${hermesSessionId}; creating a new session: ${error.message}`);
        hermesSessionId = "";
      }
    }

    if (!active) {
      emitPromptTiming(this, options, "sessionBuildStart", timingStartedAt, { localSessionId });
      active = await this.connection.agent.buildSession(cwd).start();
      hermesSessionId = active.sessionId;
      emitPromptTiming(this, options, "sessionBuildEnd", timingStartedAt, { localSessionId, hermesSessionId });
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

    const timingStartedAt = Date.now();
    emitPromptTiming(this, options, "clientStart", timingStartedAt, { localSessionId });
    const session = await this.ensureSession(localSessionId, { ...options, timingStartedAt });
    const signal = options.signal || null;
    if (signal?.aborted) {
      const error = new Error("Hermes prompt was cancelled before it started.");
      error.name = "AbortError";
      throw error;
    }

    const tools = new Map();
    const toolSignatures = new Map();
    const maxToolCalls = Math.max(0, Number(options.maxToolCalls ?? this.options.maxToolCalls ?? 0) || 0);
    const maxToolCallsWithoutAnswer = Math.max(0, Number(
      options.maxToolCallsWithoutAnswer ?? this.options.maxToolCallsWithoutAnswer ?? 0
    ) || 0);
    const maxRepeatedToolCalls = Math.max(0, Number(
      options.maxRepeatedToolCalls ?? this.options.maxRepeatedToolCalls ?? 0
    ) || 0);
    let newToolCallCount = 0;
    let toolCallsSinceAnswer = 0;
    const updates = [];
    let output = "";
    let rejectAbort;
    let timeoutTimer = null;
    const configuredTimeout = options.timeoutMs === undefined
      ? Number(this.options.promptTimeoutMs || 0)
      : Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.max(1000, configuredTimeout)
      : 0;
    const abortUpdate = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const timeoutUpdate = new Promise((resolve, reject) => {
      if (!timeoutMs) return;
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
    this.activePrompts.set(localSessionId, {
      hermesSessionId: session.hermesSessionId,
      permissionContext: options.permissionContext || {}
    });

    try {
      session.active.prompt(promptBlocks(text, options.attachments || []));
      emitPromptTiming(this, options, "promptDispatched", timingStartedAt, {
        localSessionId,
        hermesSessionId: session.hermesSessionId
      });
      let firstUpdateSeen = false;
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
        if (!firstUpdateSeen) {
          firstUpdateSeen = true;
          emitPromptTiming(this, options, "firstUpdate", timingStartedAt, {
            localSessionId,
            hermesSessionId: session.hermesSessionId
          });
        }
        if (message.kind === "stop") {
          const files = collectToolFileEvidence([...tools.values()], {
            runStartedAt: timingStartedAt,
            allowedRoots: options.deliveryRoots || []
          });
          const status = message.stopReason === "cancelled"
            ? "cancelled"
            : (message.stopReason === "refusal" || looksLikeHermesFailure(output) ? "failed" : "done");
          emitPromptTiming(this, options, "final", timingStartedAt, {
            localSessionId,
            hermesSessionId: session.hermesSessionId,
            status,
            stopReason: message.stopReason || ""
          });
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
          if (String(update.content.text || "").trim()) toolCallsSinceAnswer = 0;
        } else if (update.sessionUpdate === "tool_call") {
          const toolCallId = String(update.toolCallId || update.tool_call_id || "").trim();
          const signature = toolCallSignature(update);
          newToolCallCount += 1;
          toolCallsSinceAnswer += 1;
          const repeated = (toolSignatures.get(signature) || 0) + 1;
          toolSignatures.set(signature, repeated);
          tools.set(toolCallId || `anonymous-${newToolCallCount}`, mergeToolUpdate({}, update));
          if ((maxToolCalls > 0 && newToolCallCount > maxToolCalls)
            || (maxToolCallsWithoutAnswer > 0 && toolCallsSinceAnswer > maxToolCallsWithoutAnswer)
            || (maxRepeatedToolCalls > 0 && repeated >= maxRepeatedToolCalls)) {
            const reason = maxRepeatedToolCalls > 0 && repeated >= maxRepeatedToolCalls
              ? "模型重复调用了相同工具"
              : maxToolCallsWithoutAnswer > 0 && toolCallsSinceAnswer > maxToolCallsWithoutAnswer
                ? "模型连续调用工具但没有生成新的回答"
                : "模型调用工具次数超过安全上限";
            const error = new Error(`${reason}，本轮已自动停止。`);
            error.code = "HERMES_TOOL_LOOP_LIMIT";
            error.reason = reason;
            error.toolCallCount = newToolCallCount;
            error.toolCalls = [...tools.values()];
            await this.cancel(localSessionId).catch(() => false);
            throw error;
          }
        } else if (update.sessionUpdate === "tool_call_update") {
          const toolCallId = String(update.toolCallId || update.tool_call_id || "").trim();
          const current = tools.get(toolCallId) || {};
          tools.set(toolCallId || `anonymous-${tools.size + 1}`, mergeToolUpdate(current, update));
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

  hasSession(localSessionId) {
    return Boolean(this.sessions.get(String(localSessionId || "").trim())?.active);
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
    this.sessionBuilds.clear();
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
  collectToolFileEvidence,
  createAcpSdkLoader,
  ensureHermesPythonCompat,
  looksLikeHermesFailure,
  sensitiveEvidencePath,
  promptBlocks,
  redactDiagnostic,
  resolveAcpSdkEntry,
  resolveHermesAcpLaunch,
  resolveHermesAcpExecutable,
  resolveSpawnCwd
};
