"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BaiqiuTokenUsage = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  function recordUsage(previous, event) {
    if (!event?.requestId || ![event.inputTokens, event.outputTokens, event.totalTokens].every(count)) return previous || null;
    const requests = { ...(previous?.requests || {}) };
    const known = requests[event.requestId];
    if (known && event.totalTokens <= known.totalTokens) return previous;
    requests[event.requestId] = {
      inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens
    };
    return Object.values(requests).reduce((usage, request) => ({
      ...usage,
      inputTokens: usage.inputTokens + request.inputTokens,
      outputTokens: usage.outputTokens + request.outputTokens,
      totalTokens: usage.totalTokens + request.totalTokens
    }), { source: "provider", requests, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  }
  function fromMessage(message = {}) {
    const raw = message.raw || {};
    return [message.tokenUsage, raw.tokenUsage, raw.productResult?.tokenUsage, raw.productResult?.raw?.tokenUsage]
      .find(usage => usage?.source === "provider" && count(usage.totalTokens)) || null;
  }
  function format(value) {
    if (!count(value)) return "—";
    if (value < 1000) return String(value);
    return `${(Math.floor(value / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  }
  function updateCounter(value, target, animate, formatValue = format) {
    const state = value.__tokenCounter ||= { displayed: null, target: null, timer: null };
    if (!count(target)) {
      value.textContent = "—";
      return;
    }
    const settle = () => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.displayed = target;
      state.target = target;
      value.textContent = formatValue(target);
    };
    if (!animate || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }
    if (state.target === target) return;
    if (state.timer !== null) clearTimeout(state.timer);
    const from = state.displayed ?? 0;
    state.target = target;
    const startedAt = performance.now();
    const duration = Math.min(600, Math.max(32, (target - from) * 32));
    value.textContent = formatValue(from);
    const tick = () => {
      state.timer = null;
      if (!value.isConnected) { settle(); return; }
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      state.displayed = Math.min(target, Math.floor(from + (target - from) * progress));
      value.textContent = formatValue(state.displayed);
      if (progress < 1) state.timer = setTimeout(tick, 32);
    };
    state.timer = setTimeout(tick, 32);
  }
  function paint(root, usage, animate = true) {
    if (!root?.querySelectorAll) return;
    if (usage?.source === "provider" && count(usage.totalTokens)
      && (!root.__tokenUsage || usage.totalTokens >= root.__tokenUsage.totalTokens)) root.__tokenUsage = usage;
    const current = root.__tokenUsage || null;
    const label = format(current?.totalTokens);
    for (const elapsed of root.querySelectorAll(".streaming-elapsed")) {
      let badge = elapsed.nextElementSibling;
      if (!badge?.classList.contains("execution-token-usage")) {
        badge = document.createElement("span");
        badge.className = "execution-token-usage";
        badge.innerHTML = '<span class="execution-token-icon" aria-hidden="true">◈</span><span class="execution-token-counter"><span class="execution-token-value"></span></span>';
        elapsed.after(badge);
      }
      badge.title = current
        ? `已返回的实际用量：输入 ${current.inputTokens.toLocaleString()}，输出 ${current.outputTokens.toLocaleString()}，合计 ${current.totalTokens.toLocaleString()} Token`
        : "供应商尚未返回实际 Token 用量";
      badge.setAttribute("aria-label", badge.title);
      const counter = badge.querySelector(".execution-token-counter");
      const value = badge.querySelector(".execution-token-value");
      counter.style.minWidth = `${Math.max(7, label.length)}ch`;
      updateCounter(value, current?.totalTokens, animate);
    }
  }
  return { recordUsage, fromMessage, format, paint, updateCounter };
});
