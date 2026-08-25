const path = require("node:path");
const { spawn } = require("node:child_process");

class VoiceSttWorker {
  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess || spawn;
    this.scriptPath = path.resolve(options.scriptPath || path.join(__dirname, "voice-stt-worker.py"));
    this.readyTimeoutMs = Math.max(1000, Number(options.readyTimeoutMs || 180000));
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs || 300000));
    this.child = null;
    this.runtimeKey = "";
    this.readyPromise = null;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.nextRequestId = 0;
    this.stopping = false;
  }

  async warm(runtime = {}) {
    await this._ensureStarted(runtime);
    return true;
  }

  async transcribe(audioPath, runtime = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this._ensureStarted(runtime);
        return await this._request({ action: "transcribe", audioPath: path.resolve(audioPath) });
      } catch (error) {
        lastError = error;
        this.stop();
      }
    }
    throw lastError || new Error("语音识别进程不可用");
  }

  stop() {
    const child = this.child;
    this.stopping = true;
    this.child = null;
    this.runtimeKey = "";
    this.readyPromise = null;
    this.stdoutBuffer = "";
    this._rejectPending(new Error("语音识别进程已停止"));
    let closed = Promise.resolve();
    if (child && !child.killed) {
      closed = new Promise((resolve) => child.once("close", resolve));
      try { child.stdin?.end(); } catch {}
      try { child.kill(); } catch {}
    }
    this.stopping = false;
    return closed;
  }

  _runtimeKey(runtime = {}) {
    return [runtime.pythonPath, runtime.agentRoot, runtime.fingerprint].map((value) => String(value || "")).join("|");
  }

  async _ensureStarted(runtime = {}) {
    const pythonPath = String(runtime.pythonPath || "").trim();
    const agentRoot = String(runtime.agentRoot || "").trim();
    if (!pythonPath || !agentRoot) throw new Error("HMS 语音运行时不完整");
    const runtimeKey = this._runtimeKey(runtime);
    if (this.child && this.runtimeKey === runtimeKey && this.readyPromise) return this.readyPromise;
    this.stop();
    this.runtimeKey = runtimeKey;

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
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000);
    });
    child.once("error", (error) => this._handleExit(child, error));
    child.once("close", (code) => this._handleExit(child, new Error(this.stderrTail.trim() || `语音识别进程已退出 (${code})`)));

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("本地语音模型预热超时")), this.readyTimeoutMs);
      this.pending.set("__ready__", {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
    }).catch((error) => {
      if (this.child === child) this.stop();
      throw error;
    });
    return this.readyPromise;
  }

  _request(payload) {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("语音识别进程没有就绪"));
    const id = `voice-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("语音识别超时"));
        if (this.child === child) this.stop();
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  _handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || "");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.type === "ready") {
        const pending = this.pending.get("__ready__");
        this.pending.delete("__ready__");
        pending?.resolve(message);
        continue;
      }
      const id = String(message?.id || "");
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.resolve(message.result || message);
    }
  }

  _handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.readyPromise = null;
    this.runtimeKey = "";
    this._rejectPending(error);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

module.exports = { VoiceSttWorker };
