"use strict";

function cleanText(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function denied(value, target) {
  const prefix = "(?:不要|禁止|不允许|不准|无需|不可|不能|(?<!分)别)";
  return new RegExp(`${prefix}.{0,16}${target}`, "i").test(value);
}

class NegativeConstraintResolver {
  static resolve(input = "") {
    const text = cleanText(input);
    const denyExecution = denied(text, "(?:执行|运行|启动|处理|动手|操作)");
    const denyMutation = denied(text, "(?:修改|改动|编辑|写入|保存|创建|新建|删除|上传|下载|安装|部署)")
      || /(?:不改|别改|不修改|别修改)(?:代码|文件|项目|模块|系统)?/i.test(text);
    const denyAgent = denied(text, "(?:(?:调用|使用|启动|安排|调度|创建|让).{0,8})?(?:Agent|员工|子Agent)");
    const denyTaskCreation = denied(text, "(?:创建|新建|生成|进入).{0,8}(?:任务|Task)")
      || /(?:不要|禁止|不允许|不准|别).{0,8}(?:Task|任务)/i.test(text);
    const analysisOnly = /(?:只|仅仅|仅).{0,10}(?:分析|检查|审计|查看|评估|阅读|解释|给出方案)|(?:分析|检查|审计|查看|评估|阅读).{0,16}(?:即可|就行|就好|不要执行|不要修改|不修改|不改代码)|(?:先|只).{0,8}(?:告诉我|给出).{0,6}(?:方案|建议)/i.test(text);
    const hasExplicitDenial = denyExecution || denyMutation || denyAgent || denyTaskCreation;
    const hasNonExecutionGoal = /(?:分析|检查|审计|查看|评估|阅读|解释|原因|为什么|方案|建议|Agent|员工|任务|修改|执行|处理|代码|模块|系统|架构)/i.test(text);
    const forceAnalyzeOnly = analysisOnly || (hasExplicitDenial && hasNonExecutionGoal);
    const matched = [];
    if (denyExecution) matched.push("deny_execution");
    if (denyMutation) matched.push("deny_mutation");
    if (denyAgent) matched.push("deny_agent");
    if (denyTaskCreation) matched.push("deny_task_creation");
    if (analysisOnly) matched.push("analysis_only");
    return Object.freeze({
      denyExecution,
      denyMutation,
      denyAgent,
      denyTaskCreation,
      analysisOnly,
      forceAnalyzeOnly,
      matched: Object.freeze(matched)
    });
  }
}

module.exports = { NegativeConstraintResolver };
