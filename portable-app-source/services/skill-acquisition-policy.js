"use strict";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function evaluateSkillAcquisition(input = {}, plan = {}) {
  const text = clean(`${input.name || ""} ${input.source || ""} ${input.body || ""}`);
  const capabilityQuestion = /^(?:你)?(?:可以|能|能够|是否可以|能不能|可不可以).{0,16}(?:学习|安装|新增|创建).{0,16}(?:其他|新的|更多)?(?:的)?(?:技能|skill)(?:吗|么|呢|？|\?)?$/i.test(text);
  if (capabilityQuestion) {
    return Object.freeze({ allowed: false, code: "SKILL_QUERY_NOT_ACQUISITION", reason: "能力询问不是技能学习命令。", requiresTrustedImplementation: false });
  }

  const operational = /视频|短视频|影片|动画|图片|海报|插画|音频|配音|播客|PPT|演示文稿|幻灯片|浏览器自动化|支付|登录|上传|发布|部署|修改代码|开发软件/i.test(text);
  const generatedKnowledgeOnly = String(plan.kind || "knowledge") === "knowledge";
  if (operational && generatedKnowledgeOnly) {
    return Object.freeze({
      allowed: false,
      code: "SKILL_TRUSTED_IMPLEMENTATION_REQUIRED",
      reason: "这是操作型技能，但当前只有知识模板，没有可执行实现、依赖声明和真实产物验证。",
      requiresTrustedImplementation: true
    });
  }

  const vague = /(?:其他|新的|更多).{0,8}(?:技能|skill)|^(?:学习|安装|新增|创建).{0,4}(?:技能|skill)$/i.test(text);
  if (vague && generatedKnowledgeOnly) {
    return Object.freeze({ allowed: false, code: "SKILL_TARGET_REQUIRED", reason: "需要先说明要学习的具体技能和期望产物。", requiresTrustedImplementation: false });
  }

  return Object.freeze({ allowed: true, code: "", reason: "", requiresTrustedImplementation: false });
}

function assertSkillAcquisitionAllowed(input = {}, plan = {}) {
  const evaluation = evaluateSkillAcquisition(input, plan);
  if (evaluation.allowed) return evaluation;
  const error = new Error(evaluation.reason);
  error.code = evaluation.code;
  error.acquisition = evaluation;
  throw error;
}

module.exports = { evaluateSkillAcquisition, assertSkillAcquisitionAllowed };
