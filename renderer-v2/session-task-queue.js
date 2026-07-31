(function exposeSessionTaskQueue(root, factory) {
  const SessionTaskQueue = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = SessionTaskQueue;
  if (root) root.BaiqiuSessionTaskQueue = SessionTaskQueue;
})(typeof window !== "undefined" ? window : globalThis, () => {
  class SessionTaskQueue {
    constructor() {
      this.queues = new Map();
      this.activeSessions = new Set();
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
      const item = {
        id: task.id || `preset-${Date.now()}-${++this.sequence}`,
        text: String(task.text || "").trim(),
        attachments: Array.isArray(task.attachments) ? [...task.attachments] : [],
        context: task.context && typeof task.context === "object" ? { ...task.context } : null,
        ui: task.ui && typeof task.ui === "object" ? { ...task.ui } : null,
        quote: task.quote && typeof task.quote === "object" ? { ...task.quote } : null,
        autoStart: task.autoStart === true,
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
  }

  return SessionTaskQueue;
});
