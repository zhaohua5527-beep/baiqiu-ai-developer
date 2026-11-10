"use strict";

const AGENT_RUNTIME_STATES = Object.freeze({
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  WAITING: "WAITING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED"
});

const STATUS_ALIASES = Object.freeze({
  CREATED: AGENT_RUNTIME_STATES.CREATED,
  IDLE: AGENT_RUNTIME_STATES.CREATED,
  READY: AGENT_RUNTIME_STATES.CREATED,
  RUNNING: AGENT_RUNTIME_STATES.RUNNING,
  EXECUTING: AGENT_RUNTIME_STATES.RUNNING,
  PLANNING: AGENT_RUNTIME_STATES.RUNNING,
  WAITING: AGENT_RUNTIME_STATES.WAITING,
  AWAITING_CONFIRMATION: AGENT_RUNTIME_STATES.WAITING,
  SUCCESS: AGENT_RUNTIME_STATES.SUCCESS,
  DONE: AGENT_RUNTIME_STATES.SUCCESS,
  COMPLETED: AGENT_RUNTIME_STATES.SUCCESS,
  FAILED: AGENT_RUNTIME_STATES.FAILED,
  TIMEOUT: AGENT_RUNTIME_STATES.FAILED,
  ABORTED: AGENT_RUNTIME_STATES.FAILED,
  CANCELLED: AGENT_RUNTIME_STATES.FAILED
});

function normalizeAgentRuntimeState(value, fallback = AGENT_RUNTIME_STATES.CREATED) {
  const normalized = String(value || "").trim().toUpperCase();
  return STATUS_ALIASES[normalized] || fallback;
}

function runtimeStateFromResult(result = {}) {
  if (result.waitingForInput || result.confirmationRequired) return AGENT_RUNTIME_STATES.WAITING;
  return result.success === true ? AGENT_RUNTIME_STATES.SUCCESS : AGENT_RUNTIME_STATES.FAILED;
}

function verifiedSuccess(result = {}) {
  if (result.success !== true) return false;
  const verification = result.normalized?.meta?.verification
    || result.response?.verification
    || result.verification?.meta?.verification
    || result.verification?.verification
    || result.verification;
  if (!verification) return false;
  const status = String(verification.status || "").toLowerCase();
  return verification.verified === true && status === "passed";
}

module.exports = {
  AGENT_RUNTIME_STATES,
  normalizeAgentRuntimeState,
  runtimeStateFromResult,
  verifiedSuccess
};
