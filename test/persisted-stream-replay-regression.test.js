"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MiniElement {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.classList = {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(" ");
      },
      contains: (name) => this.className.split(/\s+/).includes(name)
    };
    this.hidden = false;
    this.textContent = "";
    this.innerHTML = "";
    this.style = { removeProperty() {} };
    this.listeners = new Map();
  }

  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }

  appendChild(node) {
    if (!node) return node;
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    nodes.forEach((node) => this.appendChild(node));
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  dispatchEvent(event) {
    const payload = event || { type: "click", target: this };
    payload.target ||= this;
    (this.listeners.get(payload.type) || []).forEach((listener) => listener(payload));
  }

  click() { this.dispatchEvent({ type: "click", target: this }); }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (!value) return false;
      if (value.startsWith(".")) return this.classList.contains(value.slice(1));
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const output = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.matches(selector)) output.push(child);
        visit(child);
      });
    };
    visit(this);
    return output;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`Missing source range: ${start}`);
  return source.slice(from, to);
}

function loadReplayApi() {
  const rendererSource = fs.readFileSync(
    path.join(__dirname, "..", "renderer-v2", "app.js"),
    "utf8"
  );
  const source = [
    sourceBetween(rendererSource, "function mergeStructuredEventLists", "function snapshotMessageIdentity"),
    sourceBetween(rendererSource, "function snapshotMessageIdentity", "function mergeSessionChangedDb"),
    sourceBetween(rendererSource, "function publicExecutionDetailsFromMessage", "function renderPersistedExecutionTimeline"),
    sourceBetween(rendererSource, "function bindExecutionActivityToggle", "function updateExecutionActivityToggle")
  ].join("\n");
  const context = {
    console,
    Map,
    Set,
    Array,
    Number,
    String,
    Date,
    document: { createElement: (tag) => new MiniElement(tag) },
    progressTarget: (event = {}) => String(event.target || event.progressTarget || ""),
    liveTurnEventFingerprint: (event) => JSON.stringify(event),
    executionActivityEntry: (item) => ({ ...item, kind: item.kind || item.type || "tool" }),
    uniqueExecutionActivityEntries: (items) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    replaceExecutionActivityLines: () => {},
    isPublicStructuredThought: () => false,
    renderMarkdown: (text) => String(text || ""),
    bindRenderedLinks: () => {},
    classifyRenderedDataLayout: () => {},
    bindExecutionActivityViewport: () => {},
    mutatePreservingMessageViewport: (mutation) => mutation(),
    executionActivityNodes: (root) => ({ rendered: root.querySelector(".execution-activity-details") }),
    executionActivityRenderedDetails: (_root, details) => details,
    scrollExecutionActivityToLatest: () => {},
    updateExecutionActivityToggle: () => {}
  };
  vm.runInNewContext(`${source}\nthis.api = {\n  structuredEventsFromMessage,\n  answerSegmentsFromMessage,\n  publicExecutionDetailsFromMessage,\n  renderPersistedSegmentPairs,\n  mergeSessionSnapshotMessage,\n  bindExecutionActivityToggle\n};`, context);
  return context.api;
}

const api = loadReplayApi();

function persistedMessage(overrides = {}) {
  return {
    id: "message-1",
    role: "assistant",
    text: "final answer",
    answerSegments: [{ turnId: "turn-1", eventId: "answer-1", sequence: 1, segmentId: "segment-1", text: "final answer" }],
    executionLog: [{ turnId: "turn-1", eventId: "execution-1", sequence: 1, target: "execution", kind: "tool", message: "tool returned" }],
    structuredEvents: [{ turnId: "turn-1", eventId: "structured-1", sequence: 2, target: "structured_result", kind: "public_progress", message: "stage confirmed", segmentId: "segment-1" }],
    ...overrides
  };
}

test("structured-only persisted messages establish a real replay", () => {
  const rendered = new MiniElement("div");
  const message = {
    id: "structured-only",
    text: "final answer",
    structuredEvents: [{ turnId: "turn-1", eventId: "structured-1", sequence: 1, target: "structured_result", message: "stage confirmed" }]
  };
  assert.equal(api.renderPersistedSegmentPairs(message, rendered), true);
  assert.equal(rendered.querySelector(".structured-result-entry").textContent, "stage confirmed");
});
test("nested raw.raw execution, structured, and answer fields are restored", () => {
  const message = {
    raw: {
      raw: {
        executionLog: [{ eventId: "execution-raw-raw", target: "execution", kind: "tool", message: "nested tool" }],
        structuredEvents: [{ eventId: "structured-raw-raw", target: "structured_result", message: "nested stage" }],
        answerSegments: [{ eventId: "answer-raw-raw", segmentId: "segment-1", text: "nested answer" }]
      }
    }
  };
  assert.equal(api.publicExecutionDetailsFromMessage(message).some((item) => item.eventId === "execution-raw-raw"), true);
  assert.equal(api.structuredEventsFromMessage(message).some((item) => item.eventId === "structured-raw-raw"), true);
  assert.equal(api.answerSegmentsFromMessage(message).some((item) => item.eventId === "answer-raw-raw"), true);
});

test("completed segmented details are hidden initially and restored by the expand action", () => {
  const rendered = new MiniElement("div");
  assert.equal(api.renderPersistedSegmentPairs(persistedMessage(), rendered), true);
  const block = rendered.querySelector(".stream-segment-block");
  assert.equal(block.querySelector(".stream-segment-process").hidden, true);
  assert.equal(block.querySelector(".stream-segment-structured").hidden, true);

  const bubble = new MiniElement("div");
  bubble.className = "bubble";
  const activity = new MiniElement("div");
  activity.className = "streaming-activity";
  activity.dataset.segmentedDetailsOwner = "1";
  activity.dataset.activityExpanded = "0";
  activity.__executionActivityDetails = [{ message: "tool returned" }];
  const toggle = new MiniElement("button");
  toggle.className = "execution-activity-toggle";
  bubble.append(activity, rendered);
  activity.appendChild(toggle);
  api.bindExecutionActivityToggle(activity);
  toggle.click();
  assert.equal(block.querySelector(".stream-segment-process").hidden, false);
  assert.equal(block.querySelector(".stream-segment-structured").hidden, false);
});

test("refresh reconstruction preserves independent process and final answer records", () => {
  const current = persistedMessage({ raw: { executionLog: [{ eventId: "execution-1", target: "execution", kind: "tool", message: "tool returned" }] } });
  const incoming = { id: current.id, role: "assistant", text: "", raw: {} };
  const merged = api.mergeSessionSnapshotMessage(current, incoming);
  assert.equal(merged.text, "final answer");
  assert.equal(merged.raw.executionLog[0].eventId, "execution-1");

  const rebuilt = new MiniElement("div");
  assert.equal(api.renderPersistedSegmentPairs(merged, rebuilt), true);
  assert.equal(rebuilt.querySelector(".stream-segment-answer").textContent, "final answer");
  assert.equal(rebuilt.querySelector(".stream-segment-process").hidden, true);
});
