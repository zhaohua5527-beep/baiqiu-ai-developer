"use strict";

const fs = require("node:fs");

const OUTPUT_FILE_PATH_PATTERN = /[A-Za-z]:[\\/][^\r\n|<>"?*]+?\.(?:xlsx|xls|csv|docx|doc|pdf|pptx|ppt|txt|md|json|zip|png|jpe?g|webp)/gi;

const TERMINAL_SUCCESS = new Set(["completed", "complete", "success", "succeeded", "done"]);
const WAITING = new Set(["awaiting_input", "awaiting_confirmation", "pending_confirmation"]);
const TERMINAL_FAILURE = new Set(["failed", "error", "blocked", "cancelled", "aborted"]);

function cleanText(value, limit = 24000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function normalizeStatus(value = "") {
  const status = cleanText(value, 80).toLowerCase();
  if (TERMINAL_SUCCESS.has(status)) return "completed";
  if (WAITING.has(status)) return "awaiting_input";
  if (TERMINAL_FAILURE.has(status)) return status === "cancelled" || status === "aborted" ? "cancelled" : "failed";
  return status;
}

function parseHmsOutcomeEnvelope(text = "") {
  const source = String(text || "");
  const match = source.match(/<baiqiu-outcome>([\s\S]*?)<\/baiqiu-outcome>/i);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const status = normalizeStatus(payload?.status);
    const kind = cleanText(payload?.kind || payload?.resultType || "task", 80).toLowerCase();
    if (!status || !kind) return null;
    return {
      text: source.replace(match[0], "").trim(),
      hmsOutcome: {
        protocol: "hms-outcome/1.0",
        kind,
        status,
        summary: cleanText(payload?.summary, 2000),
        evidenceType: cleanText(payload?.evidenceType, 80).toLowerCase(),
        evidence: payload?.evidence && typeof payload.evidence === "object" ? payload.evidence : null
      }
    };
  } catch {
    return null;
  }
}

function responseObjects(response = {}) {
  const objects = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    objects.push(value);
  };
  push(response);
  push(response.raw);
  push(response.result);
  push(response.raw?.raw);
  push(response.result?.raw);
  push(response.result?.result);
  return objects;
}

function successfulToolCalls(response = {}) {
  const calls = responseObjects(response).flatMap((item) => Array.isArray(item.toolCalls) ? item.toolCalls : []);
  return calls.filter((call) => {
    const status = normalizeStatus(call?.status || call?.state);
    const output = call?.rawOutput || call?.output || call?.response || call?.result || null;
    if (call?.error || output?.error || output?.success === false) return false;
    return status === "completed" || output?.success === true;
  });
}

function generatedFiles(response = {}) {
  const files = responseObjects(response).flatMap((item) => [
    ...(Array.isArray(item.files) ? item.files : []),
    ...(Array.isArray(item.generatedFiles) ? item.generatedFiles : [])
  ]);
  return files.filter((file) => cleanText(typeof file === "string" ? file : file?.path || file?.sourcePath || file?.filePath, 2000));
}

function evidenceFilePaths(response = {}) {
  const values = [];
  const add = (value) => {
    const file = String(typeof value === "string"
      ? value
      : value?.path || value?.sourcePath || value?.filePath || value?.outputPath || value?.savedPath || "").trim().slice(0, 2000);
    if (file) values.push(file);
  };
  generatedFiles(response).forEach(add);
  for (const call of successfulToolCalls(response)) {
    const output = call?.rawOutput || call?.output || call?.response || call?.result || {};
    add(output);
    add(output?.result);
    for (const file of Array.isArray(output?.files) ? output.files : []) add(file);
    for (const item of Array.isArray(call?.content) ? call.content : []) {
      const text = String(item?.content?.text || item?.text || "");
      for (const match of text.matchAll(OUTPUT_FILE_PATH_PATTERN)) add(match[0]);
    }
  }
  return [...new Set(values)];
}

function hasExistingFileEvidence(response = {}) {
  return evidenceFilePaths(response).some((file) => {
    try {
      return fs.existsSync(file) && fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function completedDelegations(response = {}) {
  const values = responseObjects(response).flatMap((item) => [
    ...(Array.isArray(item.delegationResults) ? item.delegationResults : []),
    ...(Array.isArray(item.delegationEvidence) ? item.delegationEvidence : []),
    ...(Array.isArray(item.employeeResults) ? item.employeeResults : [])
  ]);
  return values.filter((item) => normalizeStatus(item?.status || item?.state) === "completed");
}

function fileEffectClaim(text = "", outcome = {}) {
  const source = `${cleanText(text)} ${cleanText(outcome?.summary)}`;
  const kind = cleanText(outcome?.kind || outcome?.evidenceType, 80).toLowerCase();
  if (["file", "artifact", "spreadsheet", "document"].includes(kind)) return true;
  const fileClaim = /(?:\u5df2(?:\u751f\u6210|\u521b\u5efa|\u4fdd\u5b58|\u5bfc\u51fa|\u5199\u5165)|(?:\u6587\u4ef6|\u8868\u683c|\u6587\u6863)\u5df2).{0,80}(?:\.xlsx|\.csv|\.docx|\.pdf|\u684c\u9762|\u8def\u5f84|\u6587\u4ef6)/i.test(source);
  return fileClaim;
}

function effectClaim(text = "", outcome = {}) {
  const source = `${cleanText(text)} ${cleanText(outcome?.summary)}`;
  const kind = cleanText(outcome?.kind || outcome?.evidenceType, 80).toLowerCase();
  if (fileEffectClaim(text, outcome)) return true;
  if (["system", "desktop", "delegation", "project"].includes(kind)) return true;
  const systemClaim = /(?:\u5df2(?:\u6253\u5f00|\u542f\u52a8|\u5b89\u88c5|\u5378\u8f7d|\u5220\u9664|\u4fee\u6539)|\u64cd\u4f5c\u5df2\u5b8c\u6210)/i.test(source);
  const delegationClaim = /(?:\u5df2(?:\u59d4\u6d3e|\u5206\u914d)|(?:agent|worker).{0,30}\u5df2\u5b8c\u6210)/i.test(source);
  return systemClaim || delegationClaim;
}

function inlineTextOutcome(outcome = {}) {
  const kind = cleanText(outcome?.kind, 80).toLowerCase();
  if (["inline_text", "content", "answer", "analysis"].includes(kind)) return true;
  if (kind !== "task" || cleanText(outcome?.evidenceType, 80).toLowerCase() !== "none") return false;
  return /(?:\u5bf9\u8bdd\u6846|\u804a\u5929\u7a97\u53e3|\u6b63\u6587|\u6587\u5b57).{0,16}(?:\u8f93\u51fa|\u5c55\u793a|\u56de\u7b54|\u4ea4\u4ed8)/i.test(cleanText(outcome?.summary, 2000));
}

function findOutcome(response = {}) {
  return responseObjects(response).map((item) => item.hmsOutcome).find((item) => item && typeof item === "object") || null;
}

function evaluateHmsResponse(response = {}, { canonicalTask = false } = {}) {
  const text = cleanText(response?.text || response?.message);
  const tools = successfulToolCalls(response);
  const files = generatedFiles(response);
  const delegations = completedDelegations(response);
  const existingFileEvidence = hasExistingFileEvidence(response);
  const hasEffectEvidence = tools.length > 0 || existingFileEvidence || delegations.length > 0;
  const status = normalizeStatus(response?.status);
  if (status === "cancelled") {
    return { success: false, status: "cancelled", verified: true, text, error: response?.error || "hms_response_cancelled" };
  }
  const failed = response?.ok === false || response?.success === false
    || status === "failed";
  if (failed) {
    return { success: false, status: "failed", verified: true, text, error: response?.error || "hms_response_failed" };
  }

  const clarification = responseObjects(response).map((item) => item.clarification).find(Boolean);
  const outcome = findOutcome(response);
  const outcomeStatus = normalizeStatus(outcome?.status);
  if (clarification?.preserveTask === true || outcomeStatus === "awaiting_input") {
    return { success: true, status: "awaiting_input", verified: true, text, outcome, error: null };
  }

  if (!canonicalTask) {
    return text
      ? { success: true, status: "completed", verified: true, text, outcome, error: null }
      : { success: false, status: "failed", verified: false, text, outcome, error: "conversation_response_text_invalid" };
  }

  if (outcomeStatus === "failed" || outcomeStatus === "cancelled") {
    return { success: false, status: outcomeStatus, verified: true, text, outcome, error: response?.error || outcome?.summary || "hms_task_failed" };
  }

  const claimedFilePaths = evidenceFilePaths(response);
  const hasDeclaredEffectEvidence = tools.length > 0 || files.length > 0 || delegations.length > 0;
  if (outcomeStatus === "completed") {
    if (inlineTextOutcome(outcome)) {
      return { success: Boolean(text), status: text ? "completed" : "failed", verified: Boolean(text), text, outcome, error: text ? null : "conversation_response_text_invalid" };
    }
    if (effectClaim(text, outcome) && !hasDeclaredEffectEvidence) {
      return { success: false, status: "failed", verified: false, text, outcome, error: "hms_effect_evidence_missing" };
    }
    if ((fileEffectClaim(text, outcome) || claimedFilePaths.length > 0) && !hasExistingFileEvidence(response)) {
      return { success: false, status: "failed", verified: false, text, outcome, error: "hms_file_evidence_missing" };
    }
    return { success: Boolean(text), status: text ? "completed" : "failed", verified: Boolean(text), text, outcome, error: text ? null : "conversation_response_text_invalid" };
  }

  if (hasEffectEvidence) {
    return { success: true, status: "completed", verified: true, text: text || "任务已根据真实执行证据完成。", outcome: null, error: null };
  }

  return { success: false, status: "failed", verified: false, text, outcome, error: "hms_outcome_missing" };
}

module.exports = {
  evaluateHmsResponse,
  parseHmsOutcomeEnvelope
};
