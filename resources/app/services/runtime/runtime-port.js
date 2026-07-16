/**
 * Agent Runtime Port
 *
 * 白球产品层只依赖这套约定，不直接依赖 OpenClaw / Hermes 实现细节。
 * 后续新增内核时：实现同名能力，并在 runtime-factory 注册即可。
 */

const RUNTIME_IDS = Object.freeze({
  LOCAL: "local",
  OPENCLAW: "openclaw",
  HERMES: "hermes"
});

/**
 * @typedef {Object} RuntimeStatus
 * @property {string} state  connecting|connected|disconnected|error|auth_failed|idle|unavailable
 * @property {string} [message]
 * @property {any} [auth]
 */

/**
 * @typedef {Object} RuntimeChatInput
 * @property {string} [sessionKey]
 * @property {string} message
 * @property {string} [systemPrompt]
 * @property {Array} [attachments]
 * @property {Array} [tools]
 * @property {string} [idempotencyKey]
 * @property {string} [agentId]
 * @property {string} [sessionId]
 */

/**
 * Runtime 需要对外提供的最小能力清单（文档契约，非强制 class）。
 *
 * 必需：
 * - id / name
 * - ensureStarted()
 * - connect()
 * - waitUntilReady(timeoutMs?)
 * - sendChat(input)
 * - history(sessionKey, limit?)
 * - abortChat({ sessionKey, runId })
 * - getClient?.()  // 过渡期兼容：返回底层 client
 *
 * 可选：
 * - startAndConnect()
 * - onStatus(handler) / onEvent(handler)
 * - listSkills()
 * - stop()
 */
function assertRuntimeShape(runtime, label = "runtime") {
  if (!runtime || typeof runtime !== "object") {
    throw new Error(`${label} is required`);
  }
  const required = ["id", "ensureStarted", "connect", "waitUntilReady", "sendChat", "history", "abortChat"];
  for (const key of required) {
    if (runtime[key] == null) {
      throw new Error(`${label} missing required capability: ${key}`);
    }
  }
  return true;
}

function createRuntimeSessionKey(prefix = "agent:main:desktop") {
  const { randomUUID } = require("node:crypto");
  return `${prefix}:${randomUUID()}`;
}

function normalizeRuntimeId(value, fallback = RUNTIME_IDS.OPENCLAW) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return fallback;
  if (id === "oc" || id === "open-claw") return RUNTIME_IDS.OPENCLAW;
  return id;
}

module.exports = {
  RUNTIME_IDS,
  assertRuntimeShape,
  createRuntimeSessionKey,
  normalizeRuntimeId
};
