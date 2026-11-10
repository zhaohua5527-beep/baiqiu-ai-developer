"use strict";

const DEVELOPMENT_TASK_CAPABILITIES = Object.freeze([
  "code_search",
  "code_read",
  "code_modify",
  "test_execute"
]);

const CONTENT_TASK_CAPABILITIES = Object.freeze([
  "text_generation",
  "writing",
  "research"
]);

function normalizeCapabilities(value = []) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))]
    : [];
}

function assignmentCapabilityProfile({
  taskType = "",
  action = "",
  role = "",
  capability = "",
  requiredCapabilities = []
} = {}) {
  const source = [taskType, action, role, capability].map(String).join(" ");
  if (/(论文|文章|短文|写作|撰写|内容生成|document|writing|content_task)/i.test(source)) {
    return Object.freeze({
      taskType: "content_task",
      requiredCapabilities: CONTENT_TASK_CAPABILITIES,
      missingCapability: "writing_agent"
    });
  }
  if (/(开发|代码|程序|软件|模块|更新|developer|development_task)/i.test(source)) {
    return Object.freeze({
      taskType: "development_task",
      requiredCapabilities: DEVELOPMENT_TASK_CAPABILITIES,
      missingCapability: "development_agent"
    });
  }
  return Object.freeze({
    taskType: String(taskType || "general_task").trim(),
    requiredCapabilities: Object.freeze(normalizeCapabilities(requiredCapabilities)),
    missingCapability: "worker_agent"
  });
}

module.exports = {
  DEVELOPMENT_TASK_CAPABILITIES,
  CONTENT_TASK_CAPABILITIES,
  normalizeCapabilities,
  assignmentCapabilityProfile
};
