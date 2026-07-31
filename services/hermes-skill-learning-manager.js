"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { safeSkillName } = require("./hermes-skill-service");
const { assertSkillAcquisitionAllowed } = require("./skill-acquisition-policy");
const { assertReadyEvidence } = require("./skill-result-contract");

function clean(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function emitProgress(onProgress, stage, message, progress, extra = {}) {
  onProgress({ stage, message, progress: Math.max(0, Math.min(100, Math.round(progress))), ...extra });
}

function runtimeTraceEvidence(result = {}, skillId = "") {
  const expected = safeSkillName(skillId);
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const serialized = calls.map((call) => JSON.stringify(call)).join("\n");
  const matched = Boolean(expected && new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "i").test(serialized));
  return {
    toolCallCount: calls.length,
    skillTraceMatched: matched,
    toolCalls: calls.map((call) => ({
      toolCallId: call.toolCallId || call.id || "",
      title: clean(call.title || call.name || call.kind || "", 200),
      status: call.status || ""
    })).slice(0, 12)
  };
}

function isSkillCapabilityQuestion(value = "") {
  return /^(?:你)?(?:现在)?(?:可以|能|能够|是否可以|能不能|可不可以).{0,16}(?:真实(?:地|的)?|自己|自我)?(?:学习|学|安装|新增|创建).{0,16}(?:其他|新的|更多)?(?:的)?(?:技能|skill)(?:吗|么|呢|？|\?)?$/i.test(clean(value, 300));
}

function skillTargetFromRequest(value = "") {
  const text = clean(value, 1000)
    .replace(/^(?:请|帮我|现在|立即|开始|尝试|真实地?|自己|自我)*/i, "")
    .replace(/(?:学习|学会|学|安装|创建|新增|做成|掌握)/gi, " ")
    .replace(/(?:一个|一项|新的|专业的|可复用的)/g, " ")
    .replace(/(?:skill|技能)/gi, " ")
    .replace(/(?:请分析需求|安装所需依赖|注册到工具中心|完成真实调用测试)/g, " ")
    .replace(/[，。！？,.!?；;：:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || clean(value, 120);
}

function skillCapabilityReply(skills = []) {
  const ready = skills.filter((item) => item?.status === "READY").length;
  const failed = skills.filter((item) => item?.status === "FAILED").length;
  return [
    "可以，但真实学习必须经过验证，不能只保存一段说明就算学会。",
    "",
    `当前 Hermes 已加载 ${ready} 个 READY 技能${failed ? `，另有 ${failed} 个未通过验证` : ""}。`,
    "你给出具体技能后，我会依次执行：搜索可信技能、必要时生成本地 Hermes 技能、展示来源与权限、安装 SKILL.md、运行隔离测试、再次验证自动选中。",
    "只有清单、加载、真实调用、自动选中和结果检查全部通过，状态才会变为 READY。缺少底层程序、API 或账号时，我会明确报告能力缺口，不会假装已经学会。",
    "",
    "可以直接说：学习 Excel 对账技能，输入是销售表和回款表，输出差异清单。"
  ].join("\n");
}

function parseJsonObject(value = "") {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Hermes 未返回可验证的 JSON 结果");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hermes 返回的技能结果格式无效");
  return parsed;
}

function localSelection(request = "") {
  return `local:${Buffer.from(clean(request, 3000), "utf8").toString("base64url")}`;
}

function decodeLocalSelection(value = "") {
  if (!String(value).startsWith("local:")) return "";
  try { return Buffer.from(String(value).slice(6), "base64url").toString("utf8"); } catch { return ""; }
}

function directIdentifier(value = "") {
  return /^https?:\/\//i.test(value)
    || /^[a-z0-9_.-]+\/[a-z0-9_.-]+\/[a-z0-9_./-]+$/i.test(value)
    || /^[a-z0-9_.-]+$/i.test(value);
}

class HermesSkillLearningManager {
  constructor({ skillService, acpClient, reportRoot, workspaceRoot, syncRuntime = async () => {}, clock = () => new Date(), idFactory = randomUUID } = {}) {
    if (!skillService || !acpClient || !reportRoot || !workspaceRoot) throw new Error("HermesSkillLearningManager requires real runtime dependencies");
    this.skillService = skillService;
    this.acpClient = acpClient;
    this.reportRoot = reportRoot;
    this.workspaceRoot = workspaceRoot;
    this.syncRuntime = syncRuntime;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  now() {
    return this.clock().toISOString();
  }

  confirmationHash(candidate = {}) {
    return createHash("sha256").update(JSON.stringify({ mode: candidate.mode, selected: candidate.selectedSource, name: candidate.name || "" })).digest("hex");
  }

  async preview(payload = {}, onProgress = () => {}) {
    const source = clean(payload.source, 3000);
    const requestedName = clean(payload.name, 120);
    if (!source) throw new Error("请输入具体技能、技能库标识或 SKILL.md 网址");
    const decoded = decodeLocalSelection(source);
    const request = decoded || source;
    let candidate;
    if (decoded) {
      candidate = { mode: "local", selectedSource: source, request, name: requestedName || skillTargetFromRequest(request) };
    } else if (directIdentifier(source)) {
      candidate = { mode: "registry", selectedSource: source, request, name: requestedName || source.split("/").filter(Boolean).pop() || source };
    } else {
      emitProgress(onProgress, "RESEARCHING", "正在搜索黑球技能库", 10);
      let matches = [];
      try { matches = await this.skillService.search(skillTargetFromRequest(source), 8); } catch { matches = []; }
      const match = matches[0];
      candidate = match?.identifier
        ? { mode: "registry", selectedSource: String(match.identifier), request, name: requestedName || match.name || match.identifier, description: match.description || "", sourceLabel: match.source || "Hermes 技能库" }
        : { mode: "local", selectedSource: localSelection(request), request, name: requestedName || skillTargetFromRequest(request), description: "Hermes 将根据目标生成本地工作流技能", sourceLabel: "Hermes 本地生成" };
    }
    const confirmationHash = this.confirmationHash(candidate);
    return {
      ...candidate,
      confirmationRequired: true,
      confirmationHash,
      confirmation: {
        source: { repository: `${candidate.sourceLabel || (candidate.mode === "local" ? "Hermes 本地生成" : "Hermes 技能库")} · ${candidate.name}` },
        permissions: candidate.mode === "local"
          ? ["调用 Hermes 生成技能清单", "写入本地 SKILL.md", "执行两次隔离验收"]
          : ["下载技能清单", "写入 Hermes 技能目录", "执行两次隔离验收"],
        candidate
      },
      preview: clean(candidate.description || candidate.name, 1200)
    };
  }

  async hermesPrompt(prompt, label) {
    const sessionId = `skill-${label}-${this.idFactory()}`;
    try {
      const result = await this.acpClient.prompt(sessionId, prompt, {
        cwd: this.workspaceRoot,
        signal: AbortSignal.timeout(120000)
      });
      if (result?.status !== "done") throw new Error(result?.text || `Hermes ${label} 未完成`);
      return { result, json: parseJsonObject(result.text) };
    } finally {
      await this.acpClient.deleteSession(sessionId).catch(() => false);
    }
  }

  async generateLocal(candidate, onProgress) {
    assertSkillAcquisitionAllowed({ name: candidate.name, source: candidate.request }, { kind: "knowledge" });
    emitProgress(onProgress, "GENERATING", "正在生成本地技能合同", 25);
    await this.syncRuntime();
    const generated = await this.hermesPrompt([
      "Create a reusable Hermes SKILL.md contract for the following user goal.",
      `Goal: ${candidate.request}`,
      "This may only orchestrate capabilities that already exist. Do not claim unavailable APIs, applications, credentials, media engines, or network access.",
      "Return JSON only with: name, description, triggers (array), instructions (array of concrete steps), testPrompt, expectedSignals (array).",
      "The name must use lowercase letters, numbers, and hyphens. Include at least three instructions and two expectedSignals."
    ].join("\n"), "generate");
    const draft = generated.json;
    const id = safeSkillName(candidate.name) || safeSkillName(draft.name);
    const instructions = Array.isArray(draft.instructions) ? draft.instructions.map((item) => clean(item, 1000)).filter(Boolean) : [];
    const triggers = Array.isArray(draft.triggers) ? draft.triggers.map((item) => clean(item, 300)).filter(Boolean) : [];
    const expectedSignals = Array.isArray(draft.expectedSignals) ? draft.expectedSignals.map((item) => clean(item, 200)).filter(Boolean) : [];
    if (!id || instructions.length < 3 || expectedSignals.length < 2) throw new Error("Hermes 生成的技能合同不完整，未写入技能目录");
    const body = [
      `# ${clean(draft.description || candidate.name, 200)}`,
      "",
      "## Triggers",
      ...triggers.map((item) => `- ${item}`),
      "",
      "## Workflow",
      ...instructions.map((item, index) => `${index + 1}. ${item}`),
      "",
      "## Boundaries",
      "- Use only tools and integrations that are actually available in Hermes.",
      "- Never report completion without checking the resulting artifact or structured output.",
      "- If a required program, API, account, credential, or permission is missing, report the exact missing dependency.",
      "",
      "## Verification Contract",
      `- Test prompt: ${clean(draft.testPrompt || candidate.request, 1000)}`,
      ...expectedSignals.map((item) => `- Expected signal: ${item}`)
    ].join("\n");
    emitProgress(onProgress, "INSTALLING", "正在写入黑球 SKILL.md", 45);
    const installed = await this.skillService.installLocal(id, body, { description: clean(draft.description || candidate.name, 200), category: "learned" });
    emitProgress(onProgress, "REGISTERING", "技能文件已写入，正在注册清单", 60, { skillId: id });
    return { ...installed, generated: true, contract: { ...draft, expectedSignals } };
  }

  async verify(installed, candidate, onProgress) {
    const pipelineRunId = `skill-learning-${this.idFactory()}`;
    const skill = installed.item;
    const checks = [];
    const add = (name, passed, detail = "") => checks.push({ name, passed: passed === true, detail: clean(detail, 1200) });
    add("skill_file", Boolean(skill?.path && fs.existsSync(skill.path)), skill?.path || "");
    add("skill_registry", Boolean(skill?.id && this.skillService.get(skill.id)), skill?.id || "");
    emitProgress(onProgress, "VERIFYING", "正在执行黑球技能只读检查", 72, { skillId: skill.id });
    const loaded = await this.skillService.check(skill.id);
    add("skill_loaded", loaded.success === true, loaded.error || loaded.evidence?.output || "");

    emitProgress(onProgress, "TESTING", "正在运行技能隔离任务", 84, { skillId: skill.id });
    let runtimeTest = { success: false };
    let agentInvocation = { success: false };
    try {
      const runtime = await this.hermesPrompt([
        `Load and apply the installed Hermes skill named "${skill.id}".`,
        `Verification goal: ${candidate.request}`,
        "Do not modify user files. Produce a concrete sample result using the skill workflow.",
        "Return JSON only: {\"skill\":\"skill-id\",\"applied\":true,\"result\":\"non-empty concrete result\",\"evidence\":[\"rule or step actually applied\"]}."
      ].join("\n"), "runtime-test");
      const value = runtime.json;
      const trace = runtimeTraceEvidence(runtime.result, skill.id);
      runtimeTest = {
        success: safeSkillName(value.skill) === safeSkillName(skill.id)
          && value.applied === true
          && clean(value.result, 8000).length >= 20
          && Array.isArray(value.evidence)
          && value.evidence.length > 0
          && trace.toolCallCount > 0
          && trace.skillTraceMatched,
        response: value,
        trace
      };
    } catch (error) {
      runtimeTest = { success: false, error: error.message || String(error) };
    }
    add("runtime_test", runtimeTest.success, runtimeTest.error || JSON.stringify(runtimeTest.response || {}));

    emitProgress(onProgress, "TESTING", "正在验证新请求能否自动选中技能", 92, { skillId: skill.id });
    try {
      const automatic = await this.hermesPrompt([
        "Choose the best installed Hermes skill for this goal and apply it without being told the skill name.",
        `Goal: ${candidate.request}`,
        "Return JSON only: {\"selectedSkill\":\"installed-skill-id\",\"applied\":true,\"result\":\"concrete result\",\"evidence\":[\"selection reason\"]}."
      ].join("\n"), "auto-select");
      const value = automatic.json;
      const trace = runtimeTraceEvidence(automatic.result, skill.id);
      agentInvocation = {
        success: safeSkillName(value.selectedSkill) === safeSkillName(skill.id)
          && value.applied === true
          && clean(value.result, 8000).length >= 20
          && trace.toolCallCount > 0
          && trace.skillTraceMatched,
        response: value,
        trace
      };
    } catch (error) {
      agentInvocation = { success: false, error: error.message || String(error) };
    }
    add("agent_invocation", agentInvocation.success, agentInvocation.error || JSON.stringify(agentInvocation.response || {}));
    const verifiedResult = runtimeTest.success && agentInvocation.success;
    add("result_verification", verifiedResult, verifiedResult ? "两次隔离调用均返回可核对结果" : "隔离调用未全部通过");

    const verifiedAt = this.now();
    const report = {
      pipelineRunId,
      skill: { id: skill.id, name: skill.name, path: skill.path },
      request: candidate.request,
      source: candidate.mode,
      checks,
      runtimeTest,
      agentInvocation,
      verifiedAt
    };
    fs.mkdirSync(this.reportRoot, { recursive: true });
    const reportFile = path.join(this.reportRoot, `${pipelineRunId}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
    const success = checks.every((item) => item.passed);
    this.skillService.recordVerification?.(skill.id, { success, checkedAt: verifiedAt, evidence: { reportFile, pipelineRunId } });
    const result = {
      success,
      status: success ? "READY" : "FAILED",
      error: success ? "" : checks.filter((item) => !item.passed).map((item) => `${item.name}: ${item.detail || "failed"}`).join("；"),
      pipelineRunId,
      item: this.skillService.get(skill.id) || skill,
      evidence: { installedPath: skill.path, verifiedAt, reportFile },
      verification: {
        contractVersion: 2,
        verified: success,
        checks,
        runtimeTest,
        agentInvocation,
        resultVerification: { verified: verifiedResult, status: verifiedResult ? "passed" : "failed" }
      },
      installEvidence: installed.installEvidence || { manifest: skill.path },
      skills: this.skillService.list()
    };
    if (success) assertReadyEvidence(result);
    return result;
  }

  async acquire(payload = {}, onProgress = () => {}) {
    let lastProgress = 0;
    const report = (event = {}) => {
      lastProgress = Number.isFinite(Number(event.progress)) ? Number(event.progress) : lastProgress;
      onProgress(event);
    };
    try {
      const preview = await this.preview(payload, report);
      if (!payload.confirmed || payload.confirmationHash !== preview.confirmationHash) return preview;
      let installed;
      if (preview.mode === "local") {
        installed = await this.generateLocal(preview, report);
      } else {
        emitProgress(report, "INSTALLING", `正在通过黑球安装 ${preview.selectedSource}`, 45);
        installed = await this.skillService.install(preview.selectedSource, { name: clean(payload.name, 120) || undefined });
        emitProgress(report, "REGISTERING", "技能清单已写入，正在注册", 60, { skillId: installed.item?.id || preview.name });
      }
      const result = await this.verify(installed, preview, report);
      emitProgress(report, result.success ? "READY" : "FAILED", result.success ? `${result.item.name} 已通过真实调用验收` : `${result.item.name} 未通过真实调用验收`, result.success ? 100 : 92, { skillId: result.item?.id || preview.name, verification: result.verification });
      return result;
    } catch (error) {
      emitProgress(report, "FAILED", error.message || String(error), lastProgress);
      throw error;
    }
  }

  async verifyExisting(skillId, onProgress = () => {}) {
    const skill = this.skillService.get(String(skillId || ""));
    if (!skill) return { success: false, status: "FAILED", error: "未找到该 Hermes 技能" };
    const candidate = {
      mode: "existing",
      name: skill.name,
      request: `对已安装技能 ${skill.name} 执行只读真实验收：使用该技能完成一个可核对的示例结果`
    };
    return this.verify({ item: skill }, candidate, onProgress);
  }
}

module.exports = {
  HermesSkillLearningManager,
  isSkillCapabilityQuestion,
  skillCapabilityReply,
  skillTargetFromRequest,
  parseJsonObject,
  emitProgress
};
