"use strict";

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  if (typeof error.error === "string") return error.error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function errorCode(error) {
  if (error && typeof error === "object") {
    const direct = String(error.code || error.errorCode || "").trim();
    if (direct) return direct;
    // failureResponse 包装后，原始码放在 meta.errorCode（如 "TASK_HARD_TIMEOUT (NC3001)"）
    const meta = String(error.meta?.errorCode || error.meta?.originalErrorCode || "").trim();
    if (meta) return meta;
  }
  return "";
}

function errorStatus(error) {
  if (!error || typeof error !== "object") return 0;
  return Number(error.status || error.statusCode || error.response?.status || error.debug?.status || 0) || 0;
}

function isExplicitPermissionError(raw = "", code = "") {
  if (["PERMISSION_DENIED", "ACCESS_DENIED", "EACCES", "EPERM"].includes(String(code || "").toUpperCase())) return true;
  return /\b(?:EACCES|EPERM)\b|\baccess\s+denied\b|权限(?:被)?拒绝|拒绝访问/i.test(String(raw || ""));
}

function publicBrandText(value = "") {
  return String(value)
    .replace(/Hermes\s+Agent/gi, "黑球")
    .replace(/\bHMS\b|Hermes|OpenClaw/gi, "黑球");
}

function isInternalExecutionError(value = "", code = "") {
  return /(?:system_)?capability_missing|NC\d{3,5}|UnderstandingDecision|Product task failed|UUG_|code_(?:search|read|modify)|test_execute|patch_apply/i.test(`${code} ${value}`);
}

function userFacingError(error, context = {}) {
  const raw = errorText(error).replace(/\r/g, "\n");
  const firstLine = publicBrandText(raw.split("\n").filter(Boolean)[0] || "未知原因");
  const code = errorCode(error);
  const status = errorStatus(error);
  const developerMode = context.developerMode === true;

  if (/MODEL_FIRST_EVENT_TIMEOUT|MODEL_REQUEST_TIMEOUT/i.test(code)) {
    return "模型在规定时间内没有返回结果，请检查网络、API Key 或模型供应商状态后重试。";
  }

  if (status === 402 || /(?:billing|credit|credits|account\s+balance|insufficient\s+(?:account\s+)?balance|payment\s+required|quota\s+exhausted)/i.test(`${code} ${raw}`)) {
    return "当前模型供应商的账户余额或额度不足，本次请求未执行。请充值或更新 API Key，也可以切换到其他可用模型后重试。";
  }

  if (/MODEL_POLICY_REMOTE_PROVIDER_REQUIRED/i.test(code) || /禁止本地模型.*远程模型|没有配置可用的远程模型/i.test(raw)) {
    return "当前没有可用的模型服务。请到 [模型管理](baiqiu://open-model-manager) 配置 API Key 或启用本地模型后重试。";
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
  if (code === "MEMBERSHIP_REQUIRED") return "此功能需要有效会员。";
  if (code === "CLIENT_INTEGRITY_REPAIR_REQUIRED") return "客户端完整性校验失败，请使用完整客户端的修复功能后重试。";
  if (/hms_file_evidence_missing/i.test(`${code} ${raw}`)) {
    return "黑球声称文件任务已经完成，但没有返回可核验的文件证据，本次未标记为完成。";
  }
  if (/hms_effect_evidence_missing/i.test(`${code} ${raw}`)) {
    return "黑球声称操作已经完成，但没有返回真实工具证据，本次未标记为完成。";
  }
  if (/hms_outcome_missing/i.test(`${code} ${raw}`)) {
    return "黑球没有返回可核验的任务状态，本次未标记为完成。";
  }
  if (/missing_public_final_envelope/i.test(`${code} ${raw}`)) {
    return "黑球没有返回完整的最终答复，过程内容未写入对话。";
  }
  if (/NC3001|UnderstandingDecision is required/i.test(raw)) {
    // TOOL_FAILURE（NC3001）是工具执行失败的兜底前缀。它可能是由超时、
    // 权限、网络等具体原因引起的——先让更具体的判定透传，不要笼统翻译成
    // "没有安全地进入执行链"，否则用户看到超时却被说成安全阻断。
    // 注意：真实超时错误可能不含"超时"二字（如"任务超过最长允许时长"），
    // 但要按超时语义呈现，不能伪装成安全阻断。
    if (/TASK_HARD_TIMEOUT|HARD_TIMEOUT|timeout|timed?\s*out|超时|超过最长允许时长|最长允许时长/i.test(`${code} ${raw}`)) return "任务执行超过允许时长，已停止。您可以缩小任务范围或再次尝试。";
    if (isExplicitPermissionError(raw, code)) return "系统拒绝了该目录的写入操作，请检查该目录的 Windows 权限。";
    if (/network|fetch|econn|dns|socket|联网/i.test(raw)) return "网络连接失败，请检查网络连接或模型供应商地址。";
    if (/not\s*found|enoent|不存在|找不到/i.test(raw)) return "所需文件、程序或资源不存在。";
    if (/weekly[_\s-]*limit|usage[_\s-]*limit|quota|rate[_\s-]*limit|429|配额|额度|限额/i.test(raw)) return "模型供应商额度已用完或触发限流，请更换有额度的 API Key，或等待额度恢复。";
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
  if (/\b(?:EACCES|EPERM)\b.*\bmkdir\b.*['"]?[A-Za-z]:[\\/]?['"]?/i.test(raw)) {
    return "不能直接创建或覆盖磁盘根目录；请在盘符下指定文件夹名称。盘符本身可以作为保存位置。";
  }
  if (isExplicitPermissionError(raw, code)) return "系统拒绝了该目录的写入操作，请检查该目录的 Windows 权限。";
  if (/weekly[_\s-]*limit|usage[_\s-]*limit|quota|rate[_\s-]*limit|429|配额|额度|限额/i.test(raw)) return "模型供应商额度已用完或触发限流，请更换有额度的 API Key，或等待额度恢复。";
  if (/unsupported model|does not support (?:the )?model|当前账号(?:不支持|没有返回)文本模型/i.test(raw)) {
    return `当前模型型号不受供应商接口支持：${firstLine.slice(0, 180)}`;
  }
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
