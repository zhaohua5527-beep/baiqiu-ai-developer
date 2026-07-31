"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dataRoot } = require("./data-root");

const SECRET_PATTERN = /(sk-[a-z0-9_-]{8,}|bearer\s+\S+|api[-_ ]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+)/gi;

function sanitize(value, depth = 0) {
  if (depth > 6) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string") return value.slice(0, 12000).replace(SECRET_PATTERN, "***REDACTED***");
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /api[-_]?key|authorization|token|secret|password|credential/i.test(key) ? "***REDACTED***" : sanitize(item, depth + 1)
    ]));
  }
  return String(value);
}

class ConversationTraceLogger {
  constructor({ root = path.join(dataRoot(), "logs", "conversation"), clock = () => new Date() } = {}) {
    this.root = root;
    this.file = path.join(root, "conversation-trace.jsonl");
    this.clock = clock;
  }

  record({ traceId = "", sessionId = "", stage = "event", data = {} } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    const entry = {
      traceId: String(traceId || ""),
      sessionId: String(sessionId || ""),
      stage: String(stage || "event"),
      time: this.clock().toISOString(),
      data: sanitize(data)
    };
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  start(input = {}) {
    return this.record({ ...input, stage: "user_input", data: { userInput: input.userInput || "" } });
  }

  understood(input = {}) {
    return this.record({ ...input, stage: "understanding", data: { understanding: input.understanding || null } });
  }

  route(input = {}) {
    return this.record({ ...input, stage: "route_selected", data: { route: input.route || "", role: input.role || "" } });
  }

  finish(input = {}) {
    return this.record({ ...input, stage: "result", data: { status: input.status || "", result: input.result || null } });
  }
}

module.exports = { ConversationTraceLogger, sanitize };
