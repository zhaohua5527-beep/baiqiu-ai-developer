(function exposeSessionTaskQueue(root, factory) {
  const SessionTaskQueue = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = SessionTaskQueue;
  if (root) root.BaiqiuSessionTaskQueue = SessionTaskQueue;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const MAX_SESSION_QUEUE_SIZE = 20;

  function taskFingerprint(task = {}) {
    const text = String(task.text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const attachments = (Array.isArray(task.attachments) ? task.attachments : [])
      .map((item) => String(item?.id || item?.path || `${item?.name || ""}:${item?.sizeBytes || item?.size || 0}`))
      .sort();
    const quote = task.quote && typeof task.quote === "object"
      ? JSON.stringify([task.quote.sessionId || "", task.quote.messageId || "", task.quote.selectionText || "", task.quote.text || ""])
      : "";
    const context = task.context && typeof task.context === "object" ? JSON.stringify(task.context) : "";
    return JSON.stringify([text, attachments, quote, context]);
  }

  class SessionTaskQueue {
    constructor() {
      this.queues = new Map();
      this.activeSessions = new Set();
      this.pendingRuns = new Map();
      this.pausedSessions = new Set();
      this.sequence = 0;
    }

    list(sessionId) {
      return this.queues.get(String(sessionId || "")) || [];
    }

    enqueue(sessionId, task = {}) {
      const key = String(sessionId || "");
      if (!key) throw new Error("sessionId is required");
      const queue = this.list(key);
      if (!this.queues.has(key)) this.queues.set(key, queue);
      const fingerprint = taskFingerprint(task);
      const duplicate = queue.find((item) => (task.id && item.id === task.id) || item.fingerprint === fingerprint);
      if (duplicate) return duplicate;
      if (queue.length >= MAX_SESSION_QUEUE_SIZE) return null;
      const item = {
        id: task.id || `preset-${Date.now()}-${++this.sequence}`,
        text: String(task.text || "").trim(),
        attachments: Array.isArray(task.attachments) ? [...task.attachments] : [],
        context: task.context && typeof task.context === "object" ? { ...task.context } : null,
        ui: task.ui && typeof task.ui === "object" ? { ...task.ui } : null,
        quote: task.quote && typeof task.quote === "object" ? { ...task.quote } : null,
        autoStart: task.autoStart === true,
        supplement: task.supplement !== false,
        deliveryMode: task.deliveryMode === "steer" ? "steer" : "queue",
        fingerprint,
        createdAt: task.createdAt || Date.now()
      };
      queue.push(item);
      return item;
    }

    update(sessionId, taskId, patch = {}) {
      const task = this.list(sessionId).find((item) => item.id === taskId);
      if (!task) return null;
      if (Object.prototype.hasOwnProperty.call(patch, "text")) task.text = String(patch.text || "").trim();
      if (Array.isArray(patch.attachments)) task.attachments = [...patch.attachments];
      if (patch.context && typeof patch.context === "object") task.context = { ...patch.context };
      if (patch.ui && typeof patch.ui === "object") task.ui = { ...patch.ui };
      if (Object.prototype.hasOwnProperty.call(patch, "quote")) task.quote = patch.quote && typeof patch.quote === "object" ? { ...patch.quote } : null;
      if (Object.prototype.hasOwnProperty.call(patch, "autoStart")) task.autoStart = patch.autoStart === true;
      if (Object.prototype.hasOwnProperty.call(patch, "deliveryMode")) task.deliveryMode = patch.deliveryMode === "steer" ? "steer" : "queue";
      task.fingerprint = taskFingerprint(task);
      return task;
    }

    remove(sessionId, taskId) {
      const queue = this.list(sessionId);
      const index = queue.findIndex((item) => item.id === taskId);
      if (index < 0) return null;
      return queue.splice(index, 1)[0];
    }

    move(sessionId, taskId, offset) {
      const queue = this.list(sessionId);
      const from = queue.findIndex((item) => item.id === taskId);
      const to = Math.max(0, Math.min(queue.length - 1, from + Number(offset || 0)));
      if (from < 0 || from === to) return false;
      const [task] = queue.splice(from, 1);
      queue.splice(to, 0, task);
      return true;
    }

    reorder(sessionId, taskIds = []) {
      const queue = this.list(sessionId);
      const byId = new Map(queue.map((task) => [task.id, task]));
      const ordered = [];
      for (const id of taskIds) {
        const task = byId.get(id);
        if (!task) continue;
        ordered.push(task);
        byId.delete(id);
      }
      ordered.push(...byId.values());
      const changed = ordered.some((task, index) => task !== queue[index]);
      if (changed) queue.splice(0, queue.length, ...ordered);
      return changed;
    }

    clear(sessionId) {
      this.queues.delete(String(sessionId || ""));
    }

    shift(sessionId) {
      return this.list(sessionId).shift() || null;
    }

    setActive(sessionId, active) {
      const key = String(sessionId || "");
      if (!key) return;
      if (active) this.activeSessions.add(key);
      else this.activeSessions.delete(key);
    }

    isActive(sessionId) {
      return this.activeSessions.has(String(sessionId || ""));
    }

    beginRun(sessionId, runId) {
      const key = String(sessionId || "");
      this.pendingRuns.set(key, { runId, cancelled: false });
      this.pausedSessions.delete(key);
    }

    finishRun(sessionId, runId, completed) {
      const key = String(sessionId || "");
      const pending = this.pendingRuns.get(key);
      if (!pending || pending.runId !== runId) return false;
      this.pendingRuns.delete(key);
      if (!completed || pending.cancelled) this.pausedSessions.add(key);
      return true;
    }

    pause(sessionId) {
      const key = String(sessionId || "");
      this.pausedSessions.add(key);
      const pending = this.pendingRuns.get(key);
      if (pending) pending.cancelled = true;
    }

    resume(sessionId) {
      this.pausedSessions.delete(String(sessionId || ""));
    }

    isPaused(sessionId) {
      return this.pausedSessions.has(String(sessionId || ""));
    }

    isPending(sessionId) {
      return this.pendingRuns.has(String(sessionId || ""));
    }

    restore(sessionId, task) {
      const key = String(sessionId || "");
      const queue = this.list(key);
      if (!this.queues.has(key)) this.queues.set(key, queue);
      if (!queue.some(item => item.id === task.id)) queue.unshift(task);
    }
  }

  return SessionTaskQueue;
});
