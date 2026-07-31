"use strict";

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  if (typeof error.error === "string") return error.error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function errorCode(error) {
  if (error && typeof error === "object") return String(error.code || error.errorCode || "").trim();
  return "";
}

function publicBrandText(value = "") {
  return String(value)
    .replace(/Hermes\s+Agent/gi, "黑球")
    .replace(/Hermes|OpenClaw/gi, "黑球");
}

function isInternalExecutionError(value = "", code = "") {
  return /(?:system_)?capability_missing|NC\d{3,5}|UnderstandingDecision|Product task failed|UUG_|code_(?:search|read|modify)|test_execute|patch_apply/i.test(`${code} ${value}`);
}

function userFacingError(error, context = {}) {
  const raw = errorText(error).replace(/\r/g, "\n");
  const firstLine = publicBrandText(raw.split("\n").filter(Boolean)[0] || "未知原因");
  const code = errorCode(error);
  const developerMode = context.developerMode === true;

  if (/MODEL_POLICY_REMOTE_PROVIDER_REQUIRED/i.test(code) || /禁止本地模型.*远程模型|没有配置可用的远程模型/i.test(raw)) {
    return "您已要求不使用本地模型，但当前没有配置可用的远程模型。请先在设置中配置远程模型后重试；我不会静默改用本地模型。";
  }
  if (code === "SKILL_QUERY_NOT_ACQUISITION") {
    return "这是在询问我的技能学习能力，不是学习命令；我不会因此创建或安装技能。";
  }
  if (code === "SKILL_TARGET_REQUIRED") {
    return "请先说明要学习的具体技能、要完成的目标和期望产物，我不会把模糊问句当成技能安装命令。";
  }
  if (code === "SKILL_TRUSTED_IMPLEMENTATION_REQUIRED") {
    return "当前只找到了知识说明，没有可执行实现和真实产物验证，因此这项技能没有被标记为 READY。需要接入可信实现或对应工具后，才能继续原始目标。";
  }
  if (/NC3001|UnderstandingDecision is required/i.test(raw)) {
    return developerMode
      ? `执行链安全上下文缺失，操作已停止（${firstLine.slice(0, 180)}）。`
      : "这次请求没有安全地进入执行链，我已停止操作，且没有产生副作用。请重试；若仍失败，请提交诊断日志。";
  }
  if (/(?:system_)?capability_missing/i.test(`${code} ${raw}`)) {
    const domain = String(context.domain || context.classification || "");
    if (domain === "content" || /writing_agent|text_generation|document_generation/i.test(raw)) {
      return "当前缺少完成这项内容所需的能力，我没有生成假结果。可以先补充目标和交付格式，或在能力可用后继续。";
    }
    if (domain === "development" || /development_task|code_(?:search|read|modify)|test_execute/i.test(raw)) {
      return "当前缺少完成这项修改所需的开发能力，我没有创建失败任务，也不会假装已经修改。请在开发能力可用后重试。";
    }
    return "当前缺少完成这项请求所需的能力，我没有执行或生成假结果。请调整目标，或在相应能力可用后继续。";
  }
  if (/permission|access\s*denied|eacces|eperm|权限/i.test(firstLine)) return "权限不足，请调整访问权限后重试。";
  if (/weekly[_\s-]*limit|usage[_\s-]*limit|quota|rate[_\s-]*limit|429|配额|额度|限额/i.test(raw)) return "模型供应商额度已用完或触发限流，请更换有额度的 API Key，或等待额度恢复。";
  if (/timeout|timed?\s*out|超时/i.test(firstLine)) return "网络或工具响应超时，请稍后重试。";
  if (/not\s*found|enoent|不存在|找不到/i.test(firstLine)) return "所需文件、程序或资源不存在。";
  if (/模型接口|chat\/completions|Base URL|choices|output_text|codekey|api key|apiKey/i.test(raw)) return "模型接口连接失败，请检查模型 Base URL、API Key 和模型名称。";
  if (/network|fetch|econn|dns|socket|联网/i.test(firstLine)) return "网络连接失败，请检查网络连接或模型供应商地址。";
  if (/syntax|unexpected token|parse/i.test(firstLine)) return "生成内容格式异常，已停止执行。";
  if (!developerMode && isInternalExecutionError(raw, code)) {
    return "这次请求未能安全完成，我已停止执行且不会声称成功。请重试，或提交诊断日志进一步定位。";
  }
  return firstLine
    .replace(/^Error:\s*/i, "")
    .replace(/^Exception:\s*/i, "")
    .replace(/^Failed:\s*/i, "失败：")
    .slice(0, 240) || "未知原因";
}

module.exports = { errorText, errorCode, isInternalExecutionError, publicBrandText, userFacingError };
