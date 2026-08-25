"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

class WechatGatewayWorker {
  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess || spawn;
    this.scriptPath = path.resolve(options.scriptPath || path.join(__dirname, "wechat-gateway-worker.py"));
    this.child = null;
    this.runtimeKey = "";
    this.readyPromise = null;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.nextRequestId = 0;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  }

  async qr(runtime = {}) { return this._request(runtime, { action: "qr" }); }
  async qrStatus(runtime = {}) { return this._request(runtime, { action: "qr-status" }); }
  async status(runtime = {}) { return this._request(runtime, { action: "status" }); }
  async history(runtime = {}) { return this._request(runtime, { action: "history" }); }
  async unbind(runtime = {}) { return this._request(runtime, { action: "unbind" }); }
  async send(runtime = {}, payload = {}) { return this._request(runtime, { action: "send", ...payload }); }

  stop() {
    const child = this.child;
    this.child = null;
    this.runtimeKey = "";
    this.readyPromise = null;
    this.stdoutBuffer = "";
    for (const pending of this.pending.values()) pending.reject(new Error("微信网关进程已停止"));
    this.pending.clear();
    if (!child || child.killed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish();
      }, 1500);
      child.once("close", finish);
      try { child.stdin?.end(); } catch {}
    });
  }

  _runtimeKey(runtime = {}) {
    return [runtime.pythonPath, runtime.agentRoot, runtime.hermesHome].map((value) => String(value || "")).join("|");
  }

  async _ensureStarted(runtime = {}) {
    const pythonPath = String(runtime.pythonPath || "").trim();
    const agentRoot = String(runtime.agentRoot || "").trim();
    if (!pythonPath || !agentRoot) throw new Error("HMS 微信运行时不完整");
    const key = this._runtimeKey(runtime);
    if (this.child && this.runtimeKey === key && this.readyPromise) return this.readyPromise;
    await this.stop();
    this.runtimeKey = key;
    const child = this.spawnProcess(pythonPath, [this.scriptPath], {
      cwd: agentRoot,
      env: { ...process.env, ...(runtime.env || {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => this._handleStdout(chunk));
    child.stderr?.on("data", (chunk) => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000); });
    child.once("error", (error) => this._handleExit(child, error));
    child.once("close", (code) => this._handleExit(child, new Error(this.stderrTail.trim() || `微信网关进程退出 (${code})`)));
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("微信网关启动超时")), 15000);
      this.pending.set("__ready__", {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    }).catch(async (error) => {
      if (this.child === child) await this.stop();
      throw error;
    });
    return this.readyPromise;
  }

  async _request(runtime, payload) {
    await this._ensureStarted(runtime);
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error("微信网关进程没有就绪");
    const id = `wechat-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("微信网关请求超时"));
      }, 45000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  _handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || "");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame?.type === "ready") {
        const pending = this.pending.get("__ready__");
        this.pending.delete("__ready__");
        pending?.resolve(frame);
      } else if (frame?.type === "event") {
        try { this.onEvent(frame.event || frame); } catch {}
      } else {
        const pending = this.pending.get(String(frame?.id || ""));
        if (!pending) continue;
        this.pending.delete(String(frame.id));
        pending.resolve(frame.result || frame);
      }
    }
  }

  _handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.readyPromise = null;
    this.runtimeKey = "";
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

module.exports = { WechatGatewayWorker };
