"use strict";

const { buildExecutionMetadata } = require("./execution-metadata");

function bindAgentLoopExecutionContext(options = {}, defaults = {}) {
  const conversationUnderstanding = options.conversationUnderstanding || options.understanding || defaults.conversationUnderstanding || null;
  const taskBrain = options.taskBrain || defaults.taskBrain || null;
  const candidate = {
    ...options,
    conversationUnderstanding,
    understanding: conversationUnderstanding,
    taskBrain
  };
  let executionMetadata = null;
  try {
    executionMetadata = buildExecutionMetadata(candidate);
  } catch {}
  return {
    ...options,
    conversationUnderstanding,
    understanding: conversationUnderstanding,
    taskBrain,
    executionMetadata: executionMetadata || null,
    decisionId: executionMetadata?.decisionId || options.decisionId || conversationUnderstanding?.decisionId || taskBrain?.decision_id || "",
    taskId: options.taskId || taskBrain?.task_id || defaults.taskId || "",
    assignmentId: options.assignmentId || taskBrain?.assignment_id || defaults.assignmentId || "",
    agentId: options.agentId || defaults.agentId || defaults.sessionId || "",
    traceId: options.traceId || defaults.traceId || "",
    sessionId: options.sessionId || defaults.sessionId || "",
    userMessage: options.originalUserMessage || options.userMessage || defaults.userMessage || "",
    agentIntent: options.agentIntent || conversationUnderstanding?.context?.domainIntent || defaults.agentIntent || "",
    signal: options.signal || defaults.signal || null
  };
}

function canExposeAgentLoopTools(context = {}) {
  return context.disableTools !== true;
}

module.exports = { bindAgentLoopExecutionContext, canExposeAgentLoopTools };
