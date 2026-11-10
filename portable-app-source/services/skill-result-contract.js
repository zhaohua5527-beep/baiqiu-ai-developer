"use strict";

const REQUIRED_READY_CHECKS = Object.freeze([
  "skill_file",
  "skill_registry",
  "skill_loaded",
  "runtime_test",
  "agent_invocation",
  "result_verification"
]);

function readyEvidence(result = {}) {
  const verification = result.verification || {};
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const passed = new Set(checks.filter((item) => item?.passed === true).map((item) => item.name));
  const skillId = String(result.item?.id || result.skill?.skillId || "").trim();
  const pipelineRunId = String(result.pipelineRunId || result.skill?.metadata?.pipelineRunId || "").trim();
  const installedPath = String(result.evidence?.installedPath || result.loaded?.filePath || "").trim();
  const missingChecks = REQUIRED_READY_CHECKS.filter((name) => !passed.has(name));
  const verifiedAt = String(result.evidence?.verifiedAt || result.verifiedAt || result.stages?.at?.(-1)?.at || "").trim();
  const valid = result.success === true
    && result.status === "READY"
    && verification.contractVersion === 2
    && verification.verified === true
    && Boolean(skillId && pipelineRunId && installedPath && verifiedAt)
    && missingChecks.length === 0;
  return Object.freeze({
    valid,
    skillId,
    pipelineRunId,
    installedPath,
    verifiedAt,
    checks: Object.freeze(REQUIRED_READY_CHECKS.map((name) => Object.freeze({ name, passed: passed.has(name) }))),
    missingChecks: Object.freeze(missingChecks),
    runtimeTestPassed: verification.runtimeTest?.success === true,
    agentInvocationPassed: verification.agentInvocation?.success === true,
    verifierPassed: verification.resultVerification?.verified === true && verification.resultVerification?.status !== "skipped"
  });
}

function assertReadyEvidence(result = {}) {
  const evidence = readyEvidence(result);
  if (evidence.valid) return evidence;
  const error = new Error(`Skill READY evidence is incomplete: ${evidence.missingChecks.join(", ") || "identity/path/timestamp"}`);
  error.code = "SKILL_READY_EVIDENCE_INCOMPLETE";
  error.evidence = evidence;
  throw error;
}

module.exports = { REQUIRED_READY_CHECKS, readyEvidence, assertReadyEvidence };
