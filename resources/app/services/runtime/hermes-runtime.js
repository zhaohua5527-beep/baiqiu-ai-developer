const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { RUNTIME_IDS } = require("./runtime-port");
const { HermesClient } = require("./hermes-client");

function defaultCanConnect(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

function defaultHermesConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return {
    homePath: process.env.HERMES_HOME || path.join(home, ".hermes"),
    host: "127.0.0.1",
    port: Number(process.env.HERMES_PORT || 18791),
    baseURL: process.env.HERMES_BASE_URL || "http://127.0.0.1:18791/v1",
    model: process.env.HERMES_MODEL || "hermes-default",
    apiKey: process.env.HERMES_API_KEY || "",
    command: process.env.HERMES_COMMAND || "",
    args: [],
    autoStart: true,
    requireHttp: false
  };
}

class HermesRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = RUNTIME_IDS.HERMES;
    this.name = "Hermes";
    this.options = options;
    this.config = { ...defaultHermesConfig(), ...(options.config || {}) };
    this.client = options.client || new HermesClient({
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      model: this.config.model,
      fetchImpl: options.fetchImpl,
      requireHttp: this.config.requireHttp,
      useHttp: options.useHttp,
      stubReply: options.stubReply
    });
    this.startPromise = null;
    this.lastStatus = { state: "idle" };
    this._boundStatus = (status) => {
      this.lastStatus = status || this.lastStatus;
      this.emit("status", status);
    };
    this._boundEvent = (frame) => this.emit("event", frame);
    this.client.on("status", this._boundStatus);
    this.client.on("event", this._boundEvent);
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  getClient() {
    return this.client;
  }

  getStatus() {
    return {
      ...this.lastStatus,
      connected: this.connected,
      runtimeId: this.id,
      runtimeName: this.name,
      baseURL: this.config.baseURL,
      port: this.config.port
    };
  }

  onStatus(handler) {
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  onEvent(handler) {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  updateConfig(config = {}) {
    this.config = { ...this.config, ...config };
    if (typeof this.client.configure === "function") {
      this.client.configure({
        baseURL: this.config.baseURL,
        apiKey: this.config.apiKey,
        model: this.config.model
      });
    }
  }

  resolveHomePath() {
    if (this.options.getHomePath) {
      return path.join(this.options.getHomePath(), ".hermes");
    }
    return this.config.homePath || path.join(os.homedir(), ".hermes");
  }

  resolveLaunchCommand() {
    if (this.config.command) {
      return {
        command: this.config.command,
        args: Array.isArray(this.config.args) ? this.config.args : [],
        cwd: this.resolveHomePath()
      };
    }

    const home = this.resolveHomePath();
    const candidates = [
      path.join(home, "bin", "hermes.exe"),
      path.join(home, "bin", "hermes"),
      path.join(home, "hermes.exe"),
      path.join(home, "hermes"),
      path.join(home, "agent.exe"),
      path.join(home, "agent")
    ];
    for (const file of candidates) {
      if (file && fs.existsSync(file)) {
        return {
          command: file,
          args: Array.isArray(this.config.args) && this.config.args.length
            ? this.config.args
            : ["serve", "--host", this.config.host, "--port", String(this.config.port)],
          cwd: home
        };
      }
    }
    return null;
  }

  async ensureStarted() {
    const canConnect = this.options.canConnect || defaultCanConnect;
    const host = this.config.host || "127.0.0.1";
    const port = Number(this.config.port || 18791);

    // Prefer already-running Hermes endpoint.
    if (await canConnect(port, host)) {
      this.emit("status", { state: "connected", message: "Hermes port is reachable" });
      return true;
    }

    if (this.config.autoStart === false) {
      this.emit("status", { state: "unavailable", message: "Hermes is not running and autoStart is disabled" });
      return false;
    }

    if (this.startPromise) return this.startPromise;

    const launch = this.resolveLaunchCommand();
    if (!launch) {
      // HTTP-only / remote Hermes still counts as startable; client will surface live errors later.
      if (this.config.baseURL && !/127\.0\.0\.1|localhost/i.test(this.config.baseURL)) {
        this.emit("status", { state: "idle", message: "Using remote Hermes baseURL without local process" });
        return true;
      }
      this.emit("status", {
        state: "unavailable",
        message: "Hermes binary not found. Install Hermes or set settings.hermes.command / HERMES_COMMAND."
      });
      return false;
    }

    try {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          HERMES_HOME: this.resolveHomePath(),
          HERMES_PORT: String(port),
          ...(this.options.extraEnv || {})
        }
      });
      child.unref();
    } catch (error) {
      this.emit("status", { state: "error", message: error.message || String(error) });
      return false;
    }

    this.startPromise = new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        if (await canConnect(port, host, 800)) {
          clearInterval(timer);
          this.startPromise = null;
          this.emit("status", { state: "connected", message: "Hermes started" });
          resolve(true);
        } else if (Date.now() - started > 60000) {
          clearInterval(timer);
          this.startPromise = null;
          this.emit("status", { state: "error", message: "Hermes start timed out" });
          resolve(false);
        }
      }, 500);
    });
    return this.startPromise;
  }

  connect() {
    this.client.configure?.({
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      model: this.config.model
    });
    this.client.connect();
  }

  waitUntilReady(timeoutMs = 60000) {
    return this.client.waitUntilReady(timeoutMs);
  }

  async startAndConnect() {
    await this.ensureStarted();
    if (!this.connected) this.connect();
    try {
      await this.waitUntilReady();
      return true;
    } catch {
      return false;
    }
  }

  history(sessionKey, limit = 80) {
    return this.client.history(sessionKey, limit);
  }

  sendChat(input = {}) {
    return this.client.sendChat(input);
  }

  abortChat(input = {}) {
    return this.client.abortChat(input);
  }

  listSkillFolders() {
    const home = this.resolveHomePath();
    const skillsRoot = path.join(home, "skills");
    if (!fs.existsSync(skillsRoot)) return [];
    try {
      return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          source: "Hermes",
          path: path.join(skillsRoot, entry.name)
        }));
    } catch {
      return [];
    }
  }
}

module.exports = {
  HermesRuntime,
  defaultHermesConfig,
  defaultCanConnect
};
