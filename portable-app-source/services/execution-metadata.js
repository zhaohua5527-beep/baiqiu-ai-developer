"use strict";

const { randomUUID } = require("node:crypto");

// This module carries execution identifiers between components. It does not
// authorize, deny, isolate, or reroute a request.
const AVAILABLE_EXECUTION_FEATURES = Object.freeze({
  allowTaskCreation: true,
  allowAgent: true,
  allowTools: true,
  allowVerifier: true,
  allowFileWrite: true
});

function metadataCandidate(source = {}) {
  if (!source || typeof source !== "object") return {};
  const candidates = [
    source.executionMetadata,
    source.execution_metadata,
    source.understandingDecision,
    source.decision,
    source.conversationUnderstanding?.executionMetadata,
    source.understanding?.executionMetadata,
    source.taskBrain?.execution_metadata,
    source.context?.executionMetadata,
    source.context?.conversationUnderstanding?.executionMetadata,
    source.context?.taskBrain?.execution_metadata,
    // Legacy task records may still carry this field. It is read only for
    // migration so existing tasks can finish after the gate removal.
    source.uug,
    source.conversationUnderstanding?.uug,
    source.understanding?.uug,
    source.taskBrain?.uug,
    source.context?.conversationUnderstanding?.uug,
    source.context?.taskBrain?.uug,
    source
  ];
  return candidates.find((item) => item && typeof item === "object") || {};
}

function textFrom(candidate, source, keys, fallback = "") {
  for (const key of keys) {
    const value = candidate?.[key] ?? source?.[key];
    const text = String(value || "").trim();
    if (text) return text;
  }
  return fallback;
}

function buildExecutionMetadata(source = {}) {
  const candidate = metadataCandidate(source);
  const decisionId = textFrom(candidate, source, ["decisionId", "decision_id", "taskId", "task_id"], randomUUID());
  return Object.freeze({
    decisionId,
    classification: textFrom(candidate, source, ["classification"], "development_task"),
    responseMode: textFrom(candidate, source, ["responseMode", "response_mode"], "execute"),
    routing: textFrom(candidate, source, ["routing", "route"], "task_brain"),
    permissions: AVAILABLE_EXECUTION_FEATURES
  });
}

function buildExecutionBinding(source = {}) {
  const taskBrain = source.taskBrain || source.context?.taskBrain || {};
  const assignment = source.assignment || source.context?.assignment || {};
  const teamAssignment = source.agentTeam?.assignments?.[0] || source.context?.agentTeam?.assignments?.[0] || {};
  const metadata = buildExecutionMetadata(source);
  return Object.freeze({
    taskId: String(source.taskId || source.task_id || taskBrain.task_id || assignment.taskId || assignment.task_id || metadata.decisionId).trim(),
    assignmentId: String(source.assignmentId || source.assignment_id || taskBrain.assignment_id || assignment.id || assignment.assignmentId || assignment.assignment_id || teamAssignment.assignmentId || teamAssignment.id || `assignment-${metadata.decisionId}`).trim(),
    agentId: String(source.agentId || source.agent_id || assignment.agent || assignment.agentId || teamAssignment.agentId || source.conversationId || source.sessionId || source.context?.sessionId || `agent-${metadata.decisionId}`).trim()
  });
}

function buildExecutionContext(source = {}) {
  return Object.freeze({
    metadata: buildExecutionMetadata(source),
    binding: buildExecutionBinding(source)
  });
}

module.exports = {
  AVAILABLE_EXECUTION_FEATURES,
  buildExecutionMetadata,
  buildExecutionBinding,
  buildExecutionContext
};
