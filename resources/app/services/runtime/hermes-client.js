const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

/**
 * Lightweight Hermes transport client.
 *
 * Hermes protocol is not vendored in this repo, so the client supports:
 * 1) injected fetch/transport for real HTTP OpenAI-compatible endpoints
 * 2) in-memory sessions for local tests and graceful degradation
 *
 * Shape intentionally mirrors GatewayClient methods used by Baiqiu:
 * connect / waitUntilReady / history / sendChat / abortChat
 */
class HermesClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.connected = false;
    this.sessions = new Map();
    this.aborted = new Set();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.baseURL = String(options.baseURL || "http://127.0.0.1:18791/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.model = options.model || "hermes-default";
    this.timeoutMs = Number(options.timeoutMs || 180000);
  }

  configure(options = {}) {
    if (options.baseURL) this.baseURL = String(options.baseURL).replace(/\/+$/, "");
    if (options.apiKey != null) this.apiKey = options.apiKey;
    if (options.model) this.model = options.model;
    if (options.timeoutMs) this.timeoutMs = Number(options.timeoutMs);
    if (options.fetchImpl) this.fetchImpl = options.fetchImpl;
  }

  connect() {
    this.connected = true;
    this.emit("status", { state: "connected", runtime: "hermes" });
  }

  waitUntilReady(timeoutMs = 60000) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Hermes client connection timed out"));
      }, timeoutMs);
      const onStatus = (status) => {
        if (status?.state === "connected") {
          cleanup();
          resolve();
        } else if (status?.state === "error" || status?.state === "auth_failed") {
          cleanup();
          reject(new Error(status.message || "Hermes connection failed"));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("status", onStatus);
      };
      this.on("status", onStatus);
      this.connect();
    });
  }

  _session(sessionKey) {
    const key = sessionKey || "agent:main:hermes";
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { messages: [], runs: new Map() });
    }
    return this.sessions.get(key);
  }

  history(sessionKey, limit = 80) {
    const session = this._session(sessionKey);
    const messages = session.messages.slice(-Math.max(1, Number(limit) || 80));
    return Promise.resolve({ sessionKey, limit, messages, items: messages });
  }

  async sendChat({
    sessionKey,
    message,
    systemPrompt = "",
    attachments = [],
    tools = [],
    idempotencyKey,
    agentId,
    sessionId
  } = {}) {
    await this.waitUntilReady();
    const key = sessionKey || "agent:main:hermes";
    const session = this._session(key);
    const runId = idempotencyKey || `hermes-${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (this.aborted.has(runId)) {
      const error = new Error("Hermes run aborted before start");
      error.code = "ABORTED";
      throw error;
    }

    const userContent = String(message || "");
    session.messages.push({
      role: "user",
      content: userContent,
      text: userContent,
      runId,
      at: Date.now()
    });

    let assistantText = "";
    let usage = null;
    let transport = "memory";

    if (typeof this.fetchImpl === "function" && this.options.useHttp !== false) {
      try {
        const payload = {
          model: this.model,
          messages: [
            ...(systemPrompt ? [{ role: "system", content: String(systemPrompt) }] : []),
            { role: "user", content: userContent }
          ],
          ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: "auto" } : {})
        };
        const headers = { "Content-Type": "application/json" };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error?.message || body.message || `Hermes HTTP ${response.status}`);
        }
        assistantText = body.choices?.[0]?.message?.content
          || body.output_text
          || body.message
          || "";
        usage = body.usage || null;
        transport = "http";
      } catch (error) {
        if (this.options.requireHttp) throw error;
        // Fall back to local stub so desktop shell remains diagnosable when Hermes HTTP is down.
        assistantText = `Hermes 运行时已连接，但 HTTP 调用失败：${error.message || error}`;
        transport = "memory-fallback";
        this.emit("status", { state: "error", message: error.message || String(error) });
      }
    } else {
      assistantText = this.options.stubReply
        || "Hermes runtime is ready (in-memory transport). Configure hermes.baseURL to use a live Hermes endpoint.";
    }

    const assistantMessage = {
      role: "assistant",
      content: String(assistantText || ""),
      text: String(assistantText || ""),
      runId,
      at: Date.now(),
      transport
    };
    session.messages.push(assistantMessage);
    session.runs.set(runId, {
      runId,
      status: "done",
      sessionKey: key,
      agentId: agentId || null,
      sessionId: sessionId || null,
      attachmentsCount: Array.isArray(attachments) ? attachments.length : 0,
      usage
    });

    this.emit("event", {
      type: "event",
      event: "chat",
      payload: { sessionKey: key, runId, state: "final", text: assistantMessage.text }
    });

    return {
      runId,
      sessionKey: key,
      status: "done",
      text: assistantMessage.text,
      usage,
      transport
    };
  }

  async abortChat({ sessionKey, runId } = {}) {
    if (runId) this.aborted.add(runId);
    const session = this._session(sessionKey);
    if (runId && session.runs.has(runId)) {
      const run = session.runs.get(runId);
      run.status = "aborted";
      session.runs.set(runId, run);
    }
    this.emit("event", {
      type: "event",
      event: "chat",
      payload: { sessionKey, runId, state: "aborted" }
    });
    return { aborted: true, sessionKey, runId };
  }
}

module.exports = { HermesClient };
