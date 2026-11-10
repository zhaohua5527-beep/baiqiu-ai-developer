"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { FailureRecovery } = require("./failure-recovery");

function errorText(result = {}) {
  return String(result?.normalized?.error || result?.error || result?.response?.error || "");
}

function repairPath(value) {
  if (typeof value !== "string" || !value.trim()) return value;
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "").replace(/^~(?=[\\/])/, process.env.USERPROFILE || "");
  const resolved = path.resolve(cleaned);
  if (fs.existsSync(resolved)) return resolved;
  try {
    const parent = path.dirname(resolved);
    const target = path.basename(resolved).toLowerCase();
    const match = fs.readdirSync(parent).find((name) => name.toLowerCase() === target);
    return match ? path.join(parent, match) : resolved;
  } catch {
    return resolved;
  }
}

function repairTaskArgs(task = {}) {
  const pathKeys = new Set(["path", "filePath", "targetPath", "sourcePath", "outputPath"]);
  const repair = (value, key = "") => {
    if (Array.isArray(value)) return value.map((item) => repair(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, repair(child, childKey)]));
    return pathKeys.has(key) ? repairPath(value) : value;
  };
  return { ...task, args: repair(task.args || {}), parameters: repair(task.parameters || {}) };
}

class RecoveryManager extends FailureRecovery {
  plan({ result = {}, planObject = {} } = {}) {
    const error = errorText(result);
    const base = super.plan({ result, planObject });
    let action = base.action;
    let strategy = "controlled_retry";
    let reason = base.reason;
    let alternatives = [];
    if (/ENOENT|not found|path|file does not exist|路径|文件不存在/i.test(error)) {
      action = "correct_parameters";
      strategy = "path_normalization";
      reason = "文件路径无效，自动清理引号、展开用户目录并检查大小写后重试。";
    } else if (/pdf|解析.*失败|parse.*failed|unsupported.*document/i.test(error)) {
      action = "alternative";
      strategy = "document_fallback";
      reason = "文档解析失败，改用文本提取或格式转换路线。";
      alternatives = ["extract_text", "convert_document", "request_readable_copy"];
    } else if (/permission|access denied|EACCES|EPERM|权限|用户取消/i.test(error)) {
      action = "user_intervention";
      strategy = "request_permission";
      reason = "当前权限不足，停止自动重试并向用户说明需要的授权。";
    } else if (/network|fetch|ECONN|ETIMEDOUT|timeout|网络|超时/i.test(error)) {
      action = "retry";
      strategy = "network_backoff";
      reason = "网络暂时不可用，使用受控退避重新请求。";
    }
    const recovery = { ...base, action, strategy, reason, alternatives, error: error.slice(0, 1000) };
    this.logger?.log?.("recovery", "strategy", recovery);
    return recovery;
  }

  applyPlan(planObject = {}, recovery = {}) {
    if (!planObject || recovery.action === "failed" || recovery.action === "user_intervention") return planObject;
    if (recovery.action === "correct_parameters") {
      return {
        ...planObject,
        id: `${planObject.id || "plan"}-path-recovery-${Date.now()}`,
        recovery,
        tasks: (planObject.tasks || []).map((task) => ({ ...repairTaskArgs(task), retryLimit: Math.max(Number(task.retryLimit || 0), 1) }))
      };
    }
    if (recovery.action === "alternative") {
      return {
        ...planObject,
        id: `${planObject.id || "plan"}-fallback-${Date.now()}`,
        recovery,
        tasks: (planObject.tasks || []).map((task) => ({ ...task, fallbackStrategies: recovery.alternatives || [], retryLimit: Math.max(Number(task.retryLimit || 0), 1) }))
      };
    }
    return super.applyPlan(planObject, recovery);
  }
}

module.exports = { RecoveryManager, repairPath, repairTaskArgs };
