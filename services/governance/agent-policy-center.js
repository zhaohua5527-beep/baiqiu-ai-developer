const fs = require("node:fs");
const path = require("node:path");
const { dataRoot } = require("../data-root");

const DEFAULT_GOVERNANCE_ROOT = path.join(dataRoot(), "governance");
const DEFAULT_POLICY = Object.freeze({
  maxSteps: 50,
  maxToolCalls: 100,
  maxRetry: 3,
  maxExecutionTime: 600000,
  highRiskRequireConfirm: true
});

class AgentPolicyCenter {
  constructor({ rootDir = DEFAULT_GOVERNANCE_ROOT, policyFile = null } = {}) {
    this.rootDir = rootDir;
    this.policyFile = policyFile || path.join(rootDir, "policy.json");
    this.ensurePolicy();
  }

  ensurePolicy() {
    fs.mkdirSync(this.rootDir, { recursive: true });
    if (!fs.existsSync(this.policyFile)) this.writePolicy(DEFAULT_POLICY);
  }

  getPolicy() {
    this.ensurePolicy();
    try {
      return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(this.policyFile, "utf8")) };
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  updatePolicy(patch = {}) {
    const policy = { ...this.getPolicy(), ...patch };
    this.writePolicy(policy);
    return policy;
  }

  checkTask(task = {}, context = {}) {
    const policy = this.getPolicy();
    const taskText = String(task?.goal || task?.name || task?.description || "").toLowerCase();
    const isHighRisk = Boolean(policy.highRiskRequireConfirm) && /删除|移除|清空|格式化|覆盖|批量|卸载|关机|重启|付款|支付|转账|下单|购买|注销/i.test(taskText);
    // 合理性修正：policy 声明 highRiskRequireConfirm 时，高风险任务应标记需确认，
    // 而不是把它硬改成 false（原代码直接忽略了 policy 的约束）。
    return {
      allowed: true,
      status: isHighRisk ? "requires_confirmation" : "allowed",
      reason: isHighRisk ? "high_risk_task_requires_confirmation" : "",
      highRisk: isHighRisk,
      policy: {
        ...policy,
        highRiskRequireConfirm: Boolean(policy.highRiskRequireConfirm)
      }
    };
  }

  writePolicy(policy) {
    fs.mkdirSync(path.dirname(this.policyFile), { recursive: true });
    fs.writeFileSync(this.policyFile, JSON.stringify(policy, null, 2), "utf8");
  }
}

module.exports = { AgentPolicyCenter, DEFAULT_POLICY, DEFAULT_GOVERNANCE_ROOT };
