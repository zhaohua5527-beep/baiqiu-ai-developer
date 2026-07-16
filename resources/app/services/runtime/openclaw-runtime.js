const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { GatewayClient } = require("../../gateway-client");
const { getOpenClawConfig } = require("../../config");
const { RUNTIME_IDS } = require("./runtime-port");

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

function defaultNodeLikeCommand() {
  const localNode = "C:\\Program Files\\nodejs\\node.exe";
  if (fs.existsSync(localNode)) return { command: localNode, env: {} };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

class OpenClawRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = RUNTIME_IDS.OPENCLAW;
    this.name = "OpenClaw";
    this.options = options;
    this.client = options.client || new GatewayClient();
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
    return { ...this.lastStatus, connected: this.connected, runtimeId: this.id, runtimeName: this.name };
  }

  onStatus(handler) {
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  onEvent(handler) {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  getConfig() {
    return (this.options.getConfig || getOpenClawConfig)();
  }

  bundledEntry() {
    const appRoot = this.options.appRoot || path.join(__dirname, "..", "..");
    const resourcesPath = this.options.resourcesPath || process.resourcesPath || "";
    const roots = [
      path.join(appRoot, "resources", "openclaw"),
      path.join(resourcesPath, "openclaw"),
      path.join(resourcesPath, "app", "resources", "openclaw")
    ];
    for (const root of roots) {
      const entry = path.join(root, "dist", "index.js");
      if (fs.existsSync(entry)) return entry;
    }
    return null;
  }

  bundledRoot() {
    const appRoot = this.options.appRoot || path.join(__dirname, "..", "..");
    const resourcesPath = this.options.resourcesPath || process.resourcesPath || "";
    const getAppDataPath = this.options.getAppDataPath || (() => process.env.APPDATA || "");
    const roots = [
      path.join(appRoot, "resources", "openclaw"),
      path.join(resourcesPath, "openclaw"),
      path.join(resourcesPath, "app", "resources", "openclaw"),
      path.join(getAppDataPath(), "npm", "node_modules", "openclaw")
    ];
    return roots.find((root) => root && fs.existsSync(root)) || null;
  }

  async ensureStarted() {
    const config = this.getConfig();
    const canConnect = this.options.canConnect || defaultCanConnect;
    if (await canConnect(config.port, config.host)) return true;
    if (this.startPromise) return this.startPromise;

    const getHomePath = this.options.getHomePath || (() => require("node:os").homedir());
    const getAppDataPath = this.options.getAppDataPath || (() => process.env.APPDATA || "");
    const gatewayCmd = path.join(getHomePath(), ".openclaw", "gateway.cmd");
    const bundledEntry = this.bundledEntry();
    const openclawEntry = path.join(getAppDataPath(), "npm", "node_modules", "openclaw", "dist", "index.js");
    const nodeLikeCommand = this.options.nodeLikeCommand || defaultNodeLikeCommand;
    const nodeRunner = nodeLikeCommand();

    let command = nodeRunner.command;
    let args = [];
    let cwd = "";
    let extraEnv = nodeRunner.env || {};

    if (bundledEntry) {
      args = [bundledEntry, "gateway", "--port", String(config.port)];
      cwd = path.dirname(bundledEntry);
    } else if (fs.existsSync(openclawEntry)) {
      args = [openclawEntry, "gateway", "--port", String(config.port)];
      cwd = path.dirname(openclawEntry);
    } else if (fs.existsSync(gatewayCmd)) {
      command = "cmd.exe";
      args = ["/c", gatewayCmd];
      cwd = path.dirname(gatewayCmd);
      extraEnv = {};
    } else {
      return false;
    }

    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...extraEnv,
        OPENCLAW_GATEWAY_PORT: String(config.port),
        OPENCLAW_SERVICE_MARKER: "openclaw"
      }
    });
    child.unref();

    this.startPromise = new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        if (await canConnect(config.port, config.host, 800)) {
          clearInterval(timer);
          this.startPromise = null;
          resolve(true);
        } else if (Date.now() - started > 60000) {
          clearInterval(timer);
          this.startPromise = null;
          resolve(false);
        }
      }, 500);
    });
    return this.startPromise;
  }

  connect() {
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
    const root = this.bundledRoot();
    const skillsRoot = root ? path.join(root, "skills") : "";
    if (!skillsRoot || !fs.existsSync(skillsRoot)) return [];
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        source: "OpenClaw",
        path: path.join(skillsRoot, entry.name)
      }));
  }
}

module.exports = {
  OpenClawRuntime,
  defaultCanConnect,
  defaultNodeLikeCommand
};
