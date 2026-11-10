"use strict";

function clean(value, limit = 200000) {
  return String(value || "").trim().slice(0, limit);
}

function headingFor(assignment = {}, index = 0) {
  const source = clean(assignment.goal || assignment.action || assignment.role || `任务 ${index + 1}`, 120)
    .replace(/\s+/g, " ");
  return source.length > 48 ? `${source.slice(0, 47)}...` : source;
}

function integrateProjectResults({ assignments = [], workerResults = [], employeeResults = [], errorText = "" } = {}) {
  const safeAssignments = Array.isArray(assignments) ? assignments.filter(Boolean) : [];
  const safeWorkers = Array.isArray(workerResults) ? workerResults.filter(Boolean) : [];
  const safeEmployees = Array.isArray(employeeResults) ? employeeResults.filter(Boolean) : [];
  const byAssignment = new Map(safeWorkers.map((item) => [String(item.assignmentId || ""), item]));
  const employeeByAssignment = new Map(safeEmployees.map((item) => [String(item.assignmentId || ""), item]));
  const items = safeAssignments.map((assignment, index) => {
    const assignmentId = String(assignment.assignmentId || "");
    const worker = byAssignment.get(assignmentId);
    const employee = employeeByAssignment.get(assignmentId);
    const summary = clean(worker?.summary);
    const completed = String(worker?.status || "").toLowerCase() === "completed"
      && String(employee?.status || "").toLowerCase() === "completed"
      && Boolean(summary);
    return {
      title: headingFor(assignment, index),
      summary,
      completed,
      warnings: Array.isArray(worker?.warnings) ? worker.warnings.map((item) => clean(item, 500)).filter(Boolean) : [],
      error: clean(worker?.error || (employee?.summaryPreview || "").replace(/^失败[:：]?\s*/i, "") || errorText, 4000)
    };
  });
  const completed = items.filter((item) => item.completed);
  const failed = items.filter((item) => !item.completed);
  const sections = completed.map((item, index) => [
    completed.length > 1 ? `### ${index + 1}. ${item.title}` : "",
    item.summary,
    item.warnings.length ? `> 质量提示：${item.warnings.join("；")}` : ""
  ].filter(Boolean).join("\n\n"));

  if (items.length > 0 && failed.length === 0) {
    return ["## 任务完成内容", ...sections].join("\n\n");
  }

  const lines = [
    `任务未全部完成（${completed.length}/${items.length}）。`,
    ...(sections.length ? ["## 已完成内容", ...sections] : []),
    "## 未完成事项",
    ...failed.map((item) => `- ${item.title}：${item.error || "员工未返回有效结果"}`)
  ];
  return lines.join("\n\n");
}

module.exports = { integrateProjectResults };
