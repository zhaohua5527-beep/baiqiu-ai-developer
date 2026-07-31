"use strict";

const REPORT_STATUSES = Object.freeze({
  SUCCESS: "SUCCESS",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
  FAILED: "FAILED",
  RUNNING: "RUNNING"
});

function resultVerification(result = {}) {
  return result.evidence?.verification
    || result.verification?.meta?.verification
    || result.verification?.verification
    || result.verification
    || null;
}

function isStrictVerifiedResult(result, options = {}) {
  if (!result || typeof result !== "object") return false;
  const bindingValidator = typeof options === "function" ? options : options.bindingValidator;
  if (typeof bindingValidator !== "function" || bindingValidator(result) !== true) return false;
  const verification = resultVerification(result);
  const verifierStatus = String(verification?.status || "").trim().toLowerCase();
  return Boolean(result.resultId)
    && Boolean(result.childTaskId)
    && result.execution?.success === true
    && result.success === true
    && String(result.status || "").trim().toUpperCase() === "SUCCESS"
    && verification?.verified === true
    && verifierStatus === "passed";
}

function compactText(value, maximum = 32) {
  const text = String(value || "")
    .replace(/(?:task|agent|trace|result)[\s:_-]*[a-z0-9][a-z0-9:._-]*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "未命名任务";
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function compactDisplayText(value, maximum = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function assignmentLabel(assignment = {}, index = 0) {
  return compactText(assignment.step?.action || assignment.step || assignment.action || `子任务 ${index + 1}`);
}

function resultForAssignment(assignment, results, usedResults) {
  const match = results.find((result, index) => {
    if (usedResults.has(index)) return false;
    return Boolean(assignment.childTaskId)
      && result.childTaskId === assignment.childTaskId;
  });
  if (!match) return null;
  usedResults.add(results.indexOf(match));
  return match;
}

function failureReason(item) {
  if (!item.result) return "未生成Result";
  if (!item.bindingValid) return "Result未绑定持久化ChildTask";
  const verification = resultVerification(item.result);
  if (!item.result.resultId) return "Result未落库";
  if (String(item.result.status || "").toUpperCase() !== "SUCCESS") {
    return compactText(verification?.reason || "执行失败", 52);
  }
  if (verification?.verified !== true) return "Verifier未确认结果有效";
  if (String(verification?.status || "").toLowerCase() !== "passed") {
    return compactText(verification?.reason || "Verifier验证未通过", 52);
  }
  return "结果未满足严格成功条件";
}

function agentLabel(assignment = {}, index = 0) {
  const value = String(
    assignment.registrySelection?.selectedAgentName
    || assignment.agentName
    || assignment.name
    || ""
  ).replace(/\s+/g, " ").trim();
  if (!value) return `Agent ${index + 1}`;
  return value.length > 28 ? `${value.slice(0, 27)}…` : value;
}

function taskGoal(task = {}) {
  return compactText(
    task.goal
    || task.original_goal
    || task.original_input
    || task.input
    || "完成当前项目任务",
    120
  );
}

function displayStatus(status) {
  if (status === REPORT_STATUSES.SUCCESS) return "成功";
  if (status === REPORT_STATUSES.PARTIAL_SUCCESS) return "部分完成";
  if (status === REPORT_STATUSES.RUNNING) return "部分完成";
  return "失败";
}

function removeFalseSuccessClaims(value) {
  return String(value || "")
    .replace(/全部完成|全部通过|4\s*\/\s*4\s*成功/gi, "结果声明与验证状态不一致");
}

function buildCeoReport({ task = {}, assignments = [], results = [], terminal = true, resultBindingValidator = null } = {}) {
  const safeAssignments = Array.isArray(assignments) ? assignments.filter(Boolean) : [];
  const safeResults = Array.isArray(results) ? results.filter(Boolean) : [];
  const usedResults = new Set();
  const sourceAssignments = safeAssignments.length
    ? safeAssignments
    : safeResults.map((result) => result.assignment || {});
  const evaluations = sourceAssignments.map((assignment, index) => {
    const result = resultForAssignment(assignment, safeResults, usedResults);
    const bindingValid = Boolean(result && typeof resultBindingValidator === "function" && resultBindingValidator(result) === true);
    return {
      label: assignmentLabel(assignment, index),
      agent: agentLabel(assignment, index),
      result,
      bindingValid,
      verified: isStrictVerifiedResult(result, { bindingValidator: resultBindingValidator })
    };
  });
  const completed = evaluations.filter((item) => item.verified);
  const incomplete = evaluations.filter((item) => !item.verified);
  const hasTerminalFailure = incomplete.some((item) => item.result
    && ["FAILED", "SKIPPED"].includes(String(item.result.status || "").toUpperCase()));
  const parentTaskStatus = String(task.status || task.current_stage || "").trim().toUpperCase();
  const parentTaskFailed = ["FAILED", "SKIPPED", "CANCELLED", "ABORTED"].includes(parentTaskStatus);

  let status = REPORT_STATUSES.FAILED;
  if (!terminal && !parentTaskFailed && (!evaluations.length || (incomplete.length && !hasTerminalFailure))) status = REPORT_STATUSES.RUNNING;
  else if (!parentTaskFailed && evaluations.length && completed.length === evaluations.length) status = REPORT_STATUSES.SUCCESS;
  else if (!parentTaskFailed && completed.length) status = REPORT_STATUSES.PARTIAL_SUCCESS;

  const planText = evaluations.length
    ? evaluations.map((item, index) => `${index + 1}.${item.label}`).join("；")
    : (Array.isArray(task.plan) && task.plan.length
      ? task.plan.map((item, index) => `${index + 1}.${compactText(item, 32)}`).join("；")
      : "未生成可执行计划");
  const scheduledAgents = [...new Set(evaluations.map((item) => item.agent).filter(Boolean))];
  const failedAgents = [...new Set(incomplete.map((item) => item.agent).filter(Boolean))];
  const failureDetails = incomplete.map((item) => `${item.agent}：${failureReason(item)}`);
  if (parentTaskFailed) {
    failureDetails.unshift(`父任务：${compactText(task.failure_reason || task.error || `状态${parentTaskStatus}`, 52)}`);
  }
  const nextStep = status === REPORT_STATUSES.SUCCESS
    ? "按已验证结果进入交付。"
    : status === REPORT_STATUSES.RUNNING
      ? "等待任务执行并取得Verifier结论后再形成最终决策。"
      : "修复失败项并重新执行Verifier，未通过前不进入最终交付。";
  const riskSummary = status === REPORT_STATUSES.SUCCESS
    ? "未发现阻断性交付风险。"
    : status === REPORT_STATUSES.RUNNING
      ? "任务尚未形成完整验证结论。"
      : (failureDetails.length ? failureDetails.join("；") : "任务缺少可验证Result。");
  const personnel = scheduledAgents.length
    ? `调用${scheduledAgents.length}个Agent：${compactDisplayText(scheduledAgents.join("、"), 72)}`
    : "未调用Agent";
  const verificationSummary = status === REPORT_STATUSES.SUCCESS
    ? `通过${completed.length}项，未通过0项。`
    : `通过${completed.length}项，未通过${incomplete.length}项；${compactDisplayText(failureDetails.join("；") || "尚无可验证Result", 92)}`;
  const deliverySummary = status === REPORT_STATUSES.SUCCESS
    ? `已交付${completed.length}项经验证结果。${nextStep}`
    : `${parentTaskFailed ? `保留${completed.length}项已验证子结果，父任务失败，未形成最终交付` : `已交付${completed.length}项经验证结果`}；失败Agent：${failedAgents.length ? compactDisplayText(failedAgents.join("、"), 52) : "无（父任务失败）"}。风险：${compactDisplayText(riskSummary, 70)}。建议：${nextStep}`;
  const executionSummary = parentTaskFailed
    ? `子任务成功${completed.length}项，失败${incomplete.length}项；父任务失败。`
    : `成功${completed.length}项，失败${incomplete.length}项。`;
  const lines = [
    "【任务接收】",
    `状态：${displayStatus(status)}；目标：${taskGoal(task)}`,
    "",
    "【任务拆解】",
    compactText(planText, 92),
    "",
    "【人员分配】",
    personnel,
    "",
    "【执行状态】",
    executionSummary,
    "",
    "【验证结果】",
    verificationSummary,
    "",
    "【最终交付】",
    deliverySummary
  ];
  const summary = lines.join("\n");
  const safeSummary = status === REPORT_STATUSES.SUCCESS ? summary : removeFalseSuccessClaims(summary);

  return {
    status,
    success: status === REPORT_STATUSES.SUCCESS,
    summary: safeSummary,
    counts: {
      total: evaluations.length,
      completed: completed.length,
      incomplete: incomplete.length
    },
    completed: completed.map((item) => item.label),
    incomplete: incomplete.map((item) => ({ label: item.label, reason: failureReason(item) })),
    risks: failureDetails,
    taskStatus: parentTaskStatus,
    protocol: "ceo-report/2.0",
    basis: {
      taskStatus: parentTaskStatus,
      resultCount: safeResults.length,
      verifiedResultCount: completed.length
    }
  };
}

function buildCeoPendingReport({ task = {} } = {}) {
  const plan = Array.isArray(task.plan) ? task.plan.filter(Boolean) : [];
  const planText = plan.length
    ? plan.map((item, index) => `${index + 1}.${compactText(item, 32)}`).join("；")
    : "未生成可执行计划";
  const summary = [
    "【任务接收】",
    `状态：等待执行；目标：${taskGoal(task)}`,
    "",
    "【任务拆解】",
    compactText(planText, 92),
    "",
    "【人员分配】",
    "尚未调用Agent。",
    "",
    "【执行状态】",
    "任务尚未执行。",
    "",
    "【验证结果】",
    "当前没有可验证Result。",
    "",
    "【最终交付】",
    "暂无交付；确认高风险操作后开始真实调度。"
  ].join("\n");
  return {
    status: REPORT_STATUSES.RUNNING,
    success: false,
    summary,
    counts: { total: plan.length, completed: 0, incomplete: plan.length },
    completed: [],
    incomplete: plan.map((item) => ({ label: compactText(item, 32), reason: "等待用户确认" })),
    risks: [],
    taskStatus: String(task.status || "AWAITING_CONFIRMATION").toUpperCase(),
    protocol: "ceo-report/2.0",
    basis: { taskStatus: String(task.status || "AWAITING_CONFIRMATION").toUpperCase(), resultCount: 0, verifiedResultCount: 0 }
  };
}

module.exports = {
  REPORT_STATUSES,
  buildCeoReport,
  buildCeoPendingReport,
  isStrictVerifiedResult
};
