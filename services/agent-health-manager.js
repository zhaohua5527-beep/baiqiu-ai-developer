"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { dataRoot } = require("./data-root");

const HEALTH_REPORT_SCHEMA_VERSION = 5;
const HEALTH_REPORT_RUNTIME = "hermes";
const HEALTH_REPORT_SOURCE = "agent-health";
const LOCAL_CONNECTABLE_CAPABILITIES = new Set([
  "pdf", "word", "excel", "archive", "file_management",
  "cpu", "memory", "disk", "port", "screenshot", "clipboard_window"
]);
const OPTIONAL_CONNECTABLE_CAPABILITIES = new Set(["image", "process"]);
const NETWORK_VERIFIABLE_CAPABILITIES = new Set(["network"]);

const TOOL_REQUIREMENTS = [
  { id: "pdf", label: "PDF 处理", category: "file", toolIds: ["pdf_read", "pdf_write"], matchMode: "all", frequency: 8, value: 9, difficulty: 5, suggestion: "需要 PDF 读取与生成都通过真实校验" },
  { id: "word", label: "Word 处理", category: "file", toolIds: ["word_read", "word_write"], matchMode: "all", frequency: 7, value: 8, difficulty: 4, suggestion: "需要 Word 读取与生成都通过真实校验" },
  { id: "excel", label: "Excel 处理", category: "file", toolIds: ["write_xlsx", "spreadsheet_read", "spreadsheet_write"], frequency: 9, value: 9, difficulty: 4, suggestion: "需要接入可验证的 Excel 底层工具" },
  { id: "image", label: "图片处理", category: "file", toolIds: ["image_read", "image_edit"], matchMode: "all", frequency: 8, value: 8, difficulty: 4, suggestion: "添加本地图片读取、缩放和格式转换工具" },
  { id: "archive", label: "压缩与解压", category: "file", toolIds: ["archive_create", "archive_extract"], matchMode: "all", frequency: 6, value: 7, difficulty: 3, suggestion: "需要压缩与解压都通过真实校验" },
  { id: "file_management", label: "文件管理", category: "file", toolIds: ["find_desktop_files", "open_path", "write_text_file"], frequency: 10, value: 9, difficulty: 3, suggestion: "需要接入可验证的文件管理工具" },
  { id: "cpu", label: "CPU 查询", category: "system", toolIds: ["system_cpu"], frequency: 4, value: 6, difficulty: 2, suggestion: "需要接入可验证的 CPU 查询工具" },
  { id: "memory", label: "内存查询", category: "system", toolIds: ["system_memory"], frequency: 4, value: 6, difficulty: 2, suggestion: "需要接入可验证的内存查询工具" },
  { id: "disk", label: "磁盘查询", category: "system", toolIds: ["system_disk"], frequency: 5, value: 7, difficulty: 2, suggestion: "需要接入可验证的磁盘查询工具" },
  { id: "process", label: "进程管理", category: "system", toolIds: ["system_process", "system_process_terminate"], matchMode: "all", frequency: 6, value: 8, difficulty: 4, suggestion: "添加进程查询和受确认保护的进程终止工具" },
  { id: "network", label: "网络连接", category: "network", toolIds: ["web_search", "webpage_read"], frequency: 8, value: 8, difficulty: 3, suggestion: "需要接入可验证的网络工具" },
  { id: "port", label: "端口检测", category: "network", toolIds: ["network_port_check"], frequency: 4, value: 6, difficulty: 3, suggestion: "需要接入可验证的端口检测工具" },
  { id: "screenshot", label: "桌面截图", category: "desktop", toolIds: ["desktop_screenshot"], frequency: 7, value: 8, difficulty: 4, suggestion: "需要桌面截图真实生成 PNG 并校验" },
  { id: "clipboard_window", label: "剪贴板与窗口", category: "desktop", toolIds: ["clipboard_read", "clipboard_write", "window_inspect", "window_focus", "window_resize"], matchMode: "all", frequency: 7, value: 8, difficulty: 4, suggestion: "需要剪贴板往返校验和窗口读取、聚焦、调整都通过" }
].map((item) => Object.freeze({
  ...item,
  gapType: "tool",
  installable: false,
  connectable: LOCAL_CONNECTABLE_CAPABILITIES.has(item.id) || OPTIONAL_CONNECTABLE_CAPABILITIES.has(item.id) || NETWORK_VERIFIABLE_CAPABILITIES.has(item.id),
  connectorAction: OPTIONAL_CONNECTABLE_CAPABILITIES.has(item.id) ? "add" : (LOCAL_CONNECTABLE_CAPABILITIES.has(item.id) || NETWORK_VERIFIABLE_CAPABILITIES.has(item.id)) ? "verify" : "unavailable",
  integrationType: OPTIONAL_CONNECTABLE_CAPABILITIES.has(item.id)
    ? "bundled-optional"
    : NETWORK_VERIFIABLE_CAPABILITIES.has(item.id)
      ? "network-runtime"
      : LOCAL_CONNECTABLE_CAPABILITIES.has(item.id)
        ? "local-runtime"
        : "unavailable"
}));

const HEALTH_TESTS = Object.freeze([
  { id: "runtime", label: "黑球运行时" },
  { id: "delegation", label: "黑球任务委派" },
  { id: "skills", label: "黑球技能清单" },
  { id: "understanding", label: "意图理解" },
  { id: "context", label: "上下文保持" },
  { id: "planning", label: "任务规划" },
  { id: "tools", label: "工具调用" },
  { id: "local_tools", label: "本地底层能力" },
  { id: "file", label: "文件处理" }
]);

const HEALTH_PHASES = Object.freeze([
  { id: "preparing", label: "准备检测" },
  { id: "generating", label: "生成测试任务" },
  { id: "executing", label: "AI 执行任务" },
  { id: "collecting", label: "收集执行结果" },
  { id: "analyzing", label: "分析能力" },
  { id: "scoring", label: "生成评分" }
]);

function clamp(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }
function scoreFromChecks(checks = []) {
  const verified = checks.filter((item) => item && typeof item.passed === "boolean");
  return verified.length ? clamp((verified.filter((item) => item.passed).length / verified.length) * 100) : 0;
}
function evidenceSummary(checks = []) {
  const verified = checks.filter((item) => item && typeof item.passed === "boolean");
  const passed = verified.filter((item) => item.passed).length;
  const skipped = checks.filter((item) => item?.skipped === true || String(item?.status || "").toLowerCase() === "skipped").length;
  return { passed, failed: verified.length - passed, skipped, total: verified.length + skipped, score: scoreFromChecks(verified), checks: verified };
}
function statusFor(score) { return score >= 85 ? "优秀" : score >= 65 ? "正常" : "风险"; }
function qualityFor(score) { return score >= 90 ? "优秀" : score >= 75 ? "良好" : score >= 60 ? "一般" : "风险"; }
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}

class AgentHealthManager {
  constructor({
    root = path.join(dataRoot(), "agent-health"),
    intentAgent = null,
    capabilityCenter = null,
    toolProvider = null,
    taskBrain = null,
    recoveryManager = null,
    checkpointManager = null,
    taskProbe = null,
    toolProbe = null,
    localCapabilityProbe = null,
    fileProbe = null,
    runtimeProbe = null,
    delegationProbe = null,
    skillProbe = null,
    phaseDelayMs = 90
  } = {}) {
    this.root = root;
    this.latestFile = path.join(root, "latest.json");
    this.historyFile = path.join(root, "history.json");
    this.intentAgent = intentAgent;
    this.capabilityCenter = capabilityCenter;
    this.toolProvider = typeof toolProvider === "function" ? toolProvider : () => [];
    this.taskBrain = taskBrain;
    this.recoveryManager = recoveryManager;
    this.checkpointManager = checkpointManager;
    this.taskProbe = typeof taskProbe === "function" ? taskProbe : null;
    this.toolProbe = typeof toolProbe === "function" ? toolProbe : null;
    this.localCapabilityProbe = typeof localCapabilityProbe === "function" ? localCapabilityProbe : null;
    this.fileProbe = typeof fileProbe === "function" ? fileProbe : null;
    this.runtimeProbe = typeof runtimeProbe === "function" ? runtimeProbe : null;
    this.delegationProbe = typeof delegationProbe === "function" ? delegationProbe : null;
    this.skillProbe = typeof skillProbe === "function" ? skillProbe : null;
    this.phaseDelayMs = Math.max(0, Number(phaseDelayMs) || 0);
  }

  async runHealthCheck({ onProgress } = {}) {
    const startedAt = Date.now();
    const progressTests = HEALTH_TESTS.map((item) => ({ ...item, status: "pending", score: null, error: "" }));
    const emit = (phaseIndex, extra = {}) => {
      const phase = HEALTH_PHASES[phaseIndex];
      try {
        onProgress?.({
          phase: phase.id,
          phaseLabel: phase.label,
          phaseIndex: phaseIndex + 1,
          phaseTotal: HEALTH_PHASES.length,
          completedTests: progressTests.filter((item) => item.status === "passed" || item.status === "failed" || item.status === "skipped").length,
          totalTests: progressTests.length,
          tests: progressTests.map((item) => ({ ...item })),
          ...extra
        });
      } catch {
        // Rendering progress must never interrupt the health check.
      }
    };
    const pause = () => this.phaseDelayMs ? new Promise((resolve) => setTimeout(resolve, this.phaseDelayMs)) : Promise.resolve();
    const runProbe = async (id, probe) => {
      const test = progressTests.find((item) => item.id === id);
      test.status = "running";
      emit(2, { currentTest: id });
      await pause();
      try {
        const result = await probe();
        const skipped = result?.skipped === true || String(result?.status || "").toUpperCase() === "SKIPPED";
        if (skipped) {
          test.score = null;
          test.status = "skipped";
          test.error = "";
          test.detail = result.detail || "未启用，已跳过";
        } else {
          test.score = clamp(result.score);
          test.status = result.passed === false || test.score < 60 ? "failed" : "passed";
          test.error = result.error || "";
          test.detail = result.detail || "";
        }
        return result;
      } catch (error) {
        test.score = 0;
        test.status = "failed";
        test.error = error?.message || String(error);
        return { score: 0, passed: false, error: test.error, tests: [], detail: test.error };
      } finally {
        emit(2, { currentTest: id });
      }
    };

    emit(0);
    await pause();
    emit(1);
    await pause();
    emit(2);

    const runtimeProbe = await runProbe("runtime", () => this.probeExternal("runtime", this.runtimeProbe));
    const delegationProbe = await runProbe("delegation", () => this.probeExternal("delegation", this.delegationProbe));
    const skillProbe = await runProbe("skills", () => this.probeExternal("skills", this.skillProbe));
    const understandingProbe = await runProbe("understanding", () => this.probeUnderstanding());
    const contextProbe = await runProbe("context", () => this.probeContext());
    const planningProbe = await runProbe("planning", () => this.probePlanning());
    const toolProbe = await runProbe("tools", () => this.probeToolExecution());
    const localProbe = await runProbe("local_tools", () => this.probeLocalCapabilities());
    const fileProbe = await runProbe("file", () => this.probeFileProcessing());

    emit(3);
    await pause();
    const tools = this.checkTools(toolProbe, localProbe);
    const capabilities = this.checkCapabilities(tools.requirements, fileProbe, toolProbe);
    const recovery = this.checkRecovery();
    const understanding = this.checkUnderstanding(understandingProbe);
    const closure = this.checkClosure(planningProbe);
    const context = this.checkContext(contextProbe);
    const longTask = this.checkLongTask({ contextProbe, planningProbe, recovery });
    const runtimeModule = this.externalModule("hermes-runtime", "黑球运行时", runtimeProbe);
    const delegationModule = this.externalModule("hermes-delegation", "黑球临时任务委派", delegationProbe);
    const skillModule = this.externalModule("hermes-skills", "黑球技能清单", skillProbe);

    emit(4);
    await pause();
    const evidenceChecks = [
      ...((runtimeProbe.tests || []).map((item) => ({ ...item, source: "runtime" }))),
      ...((delegationProbe.tests || []).map((item) => ({ ...item, source: "delegation" }))),
      ...((skillProbe.tests || []).map((item) => ({ ...item, source: "skills" }))),
      ...((understandingProbe.tests || []).map((item) => ({ ...item, source: "understanding" }))),
      ...((contextProbe.tests || []).map((item) => ({ ...item, source: "context" }))),
      ...((planningProbe.tests || []).map((item) => ({ ...item, source: "planning" }))),
      ...((toolProbe.tests || []).map((item) => ({ ...item, source: "tools" }))),
      ...((localProbe.tests || []).map((item) => ({ ...item, source: "local-runtime" }))),
      ...((fileProbe.tests || []).map((item) => ({ ...item, source: "file" }))),
      ...tools.requirements.map((item) => ({
        name: `capability:${item.id}`,
        passed: item.available === true,
        source: "registered-tools",
        detail: item.available ? `matched: ${item.matchedToolIds.join(", ")}` : item.suggestion
      })),
      ...recovery.checks.map((item) => ({ ...item, name: item.name || `recovery:${item.expected}`, source: "recovery" }))
    ];
    const evidence = evidenceSummary(evidenceChecks);
    const dimensions = {
      intelligence: scoreFromChecks([
        ...(runtimeProbe.tests || []), ...(understandingProbe.tests || []), ...(contextProbe.tests || [])
      ]),
      execution: scoreFromChecks([
        ...(delegationProbe.tests || []), ...(planningProbe.tests || []), ...recovery.checks
      ]),
      tools: scoreFromChecks([
        ...(skillProbe.tests || []), ...(toolProbe.tests || []), ...(localProbe.tests || []), ...(fileProbe.tests || []), ...tools.requirements.map((item) => ({ passed: item.available }))
      ]),
      stability: scoreFromChecks([
        ...(runtimeProbe.tests || []), ...(contextProbe.tests || []), ...recovery.checks
      ])
    };
    const overallScore = evidence.score;
    const gaps = this.analyzeGaps(tools.requirements);
    const history = this.history();
    const report = {
      schemaVersion: HEALTH_REPORT_SCHEMA_VERSION,
      reportId: randomUUID(),
      reportVersion: `V${history.length + 1}`,
      runtime: HEALTH_REPORT_RUNTIME,
      reportSource: HEALTH_REPORT_SOURCE,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      overallScore,
      status: overallScore >= 85 ? "良好" : overallScore >= 65 ? "正常" : "需升级",
      dimensions,
      modules: [runtimeModule, delegationModule, skillModule, understanding, closure, context, tools, recovery, capabilities.fileModule, capabilities.systemModule, longTask],
      skillCoverage: tools.coverageScore,
      capabilityGaps: gaps,
      priorityRecommendations: gaps.slice(0, 8),
      comparison: history.length ? { previousVersion: history.at(-1).reportVersion, scoreChange: overallScore - history.at(-1).overallScore } : null,
      evidence: {
        score: evidence.score,
        checks: evidence.checks,
        toolCount: tools.toolCount,
        capabilityCount: capabilities.items.length,
        recentTaskCount: this.taskBrain?.list?.("", 20)?.length || 0,
        checkpointEnabled: Boolean(this.checkpointManager?.create && this.checkpointManager?.restore),
        hermes: {
          runtime: runtimeProbe.evidence || null,
          delegation: delegationProbe.evidence || null,
          skills: skillProbe.evidence || null,
          localCapabilities: localProbe.evidence || null
        },
        testSummary: {
          total: evidence.total,
          passed: evidence.passed,
          failed: evidence.failed,
          skipped: evidence.skipped,
          tests: progressTests.map((item) => ({ ...item }))
        }
      }
    };
    emit(5, { overallScore, dimensions, revealScores: true });
    await pause();
    report.durationMs = Date.now() - startedAt;
    this.persist(report, history);
    emit(5, { overallScore, dimensions, revealScores: true, completed: true });
    return report;
  }

  async probeExternal(id, probe) {
    if (!probe) return { score: 0, skipped: true, status: "SKIPPED", error: "", detail: "未配置真实探针，已跳过" };
    const result = await probe();
    if (result?.skipped === true || String(result?.status || "").toUpperCase() === "SKIPPED") {
      return {
        score: 0,
        skipped: true,
        status: "SKIPPED",
        error: "",
        detail: String(result?.detail || "探针未启用，已跳过"),
        evidence: result?.evidence || result || null,
        tests: Array.isArray(result?.tests) ? result.tests : [],
        errors: 0,
        quality: "未启用"
      };
    }
    const passed = result?.success === true;
    return {
      score: passed ? 100 : 0,
      passed,
      error: passed ? "" : String(result?.error || `${id} probe failed`),
      detail: String(result?.detail || (passed ? "真实探针通过" : "真实探针失败")),
      evidence: result?.evidence || result || null,
      tests: [{ name: id, passed }],
      errors: passed ? 0 : 1,
      quality: passed ? "已验证" : "失败"
    };
  }

  externalModule(id, name, probe = {}) {
    if (probe?.skipped === true || String(probe?.status || "").toUpperCase() === "SKIPPED") {
      return {
        id,
        name,
        score: 0,
        status: "未启用",
        detail: probe.detail || "已跳过",
        tests: probe.tests || [],
        errors: 0,
        quality: "未启用",
        evidence: probe.evidence || null
      };
    }
    return {
      id,
      name,
      score: clamp(probe.score),
      status: statusFor(probe.score),
      detail: probe.detail || probe.error || "未执行",
      tests: probe.tests || [],
      errors: probe.errors || 0,
      quality: probe.quality || "未验证",
      evidence: probe.evidence || null
    };
  }

  probeUnderstanding() {
    const cases = [
      { input: "帮我做一个计算器", expected: ["dev.code.calculator", "dev.code"] },
      { input: "开发一个小工具", expected: ["dev.code"] },
      { input: "分析这个 Excel 文件", expected: ["office.doc", "file.create"] },
      { input: "你好，解释什么是缓存", expected: ["general.chat"] }
    ];
    const tests = cases.map((item) => {
      const actual = this.intentAgent?.analyze?.(item.input, { hasAttachments: /Excel/.test(item.input) })?.primaryIntent || "unavailable";
      return { ...item, actual, passed: item.expected.includes(actual) };
    });
    const score = clamp((tests.filter((item) => item.passed).length / tests.length) * 100);
    return { score, passed: score >= 60, tests, errors: tests.filter((item) => !item.passed).length, quality: qualityFor(score), detail: `完成 ${tests.filter((item) => item.passed).length}/${tests.length} 项意图测试` };
  }

  probeContext() {
    const base = {
      task_id: "health-context-probe",
      task_type: "software_development",
      level: 3,
      route: "agent",
      intent: "dev.code",
      response_mode: "execution",
      goal: "创建一个离线计算器",
      original_input: "创建计算器，保持离线且不要使用外部库",
      output: "calculator.html",
      current_stage: "planning",
      current_step: "",
      completed: [],
      pending: ["实现界面", "验证计算"],
      constraints: ["离线运行", "不使用外部库"],
      acceptance: ["可以计算", "结果正确"],
      required_tools: ["代码生成", "文件创建"],
      plan: ["实现界面", "验证计算"]
    };
    const turns = [
      base,
      { ...base, current_stage: "executing", completed: ["实现界面"], pending: ["验证计算"] },
      { ...base, current_stage: "verifying", completed: ["实现界面", "验证计算"], pending: [] }
    ];
    const contexts = turns.map((task) => this.taskBrain?.executionContext?.(task)).filter(Boolean);
    const tests = contexts.map((context, index) => ({
      turn: index + 1,
      passed: context.original_goal === base.goal
        && context.constraints?.includes("离线运行")
        && context.acceptance?.includes("结果正确")
        && context.current_stage === turns[index].current_stage
    }));
    const score = clamp((tests.filter((item) => item.passed).length / Math.max(1, turns.length)) * 100);
    return { score, passed: score >= 60, tests, errors: turns.length - tests.filter((item) => item.passed).length, quality: qualityFor(score), detail: `连续 ${turns.length} 个阶段保持目标与约束` };
  }

  async probePlanning() {
    if (!this.taskProbe) return { score: 0, passed: false, tests: [], errors: 1, quality: "未验证", error: "未配置任务规划探针", detail: "无法执行真实 Task Brain 规划" };
    const task = await this.taskProbe("开发一个离线 HTML 计算器，需要创建文件、实现计算并验证结果；要求离线运行，不使用外部库");
    const checks = [
      { name: "识别开发目标", passed: /计算器/.test(task?.goal || "") && task?.task_type === "software_development" },
      { name: "生成执行步骤", passed: Array.isArray(task?.plan) && task.plan.length >= 3 },
      { name: "生成验收标准", passed: Array.isArray(task?.acceptance) && task.acceptance.length >= 2 },
      { name: "选择执行路线", passed: task?.route === "task_brain" },
      { name: "保留约束", passed: Array.isArray(task?.constraints) && task.constraints.some((item) => /离线/.test(item)) }
    ];
    const score = clamp((checks.filter((item) => item.passed).length / checks.length) * 100);
    return { score, passed: score >= 60, tests: checks, errors: checks.filter((item) => !item.passed).length, quality: qualityFor(score), detail: `规划与验收 ${checks.filter((item) => item.passed).length}/${checks.length} 通过`, task: { task_type: task?.task_type, route: task?.route, plan: task?.plan } };
  }

  async probeToolExecution() {
    if (!this.toolProbe) return { score: 0, passed: false, tests: [], errors: 1, quality: "未验证", error: "未配置工具执行探针", detail: "工具注册不代表可调用" };
    const response = await this.toolProbe();
    const checks = [
      { name: "Registry 可发现", passed: Boolean(response?.toolId) },
      { name: "工具实际执行", passed: response?.success === true },
      { name: "返回可验证结果", passed: response?.result !== undefined && response?.result !== null },
      { name: "无执行错误", passed: !response?.error }
    ];
    const score = clamp((checks.filter((item) => item.passed).length / checks.length) * 100);
    return { score, passed: score >= 60, tests: checks, errors: checks.filter((item) => !item.passed).length, quality: qualityFor(score), detail: `真实工具调用 ${response?.toolId || "不可用"}`, evidence: response };
  }

  async probeLocalCapabilities() {
    if (!this.localCapabilityProbe) return { score: 0, passed: false, tests: [], capabilities: {}, errors: 1, quality: "未验证", error: "未配置本地底层能力探针", detail: "工具声明不能替代真实调用" };
    const response = await this.localCapabilityProbe();
    const checks = Array.isArray(response?.tests)
      ? response.tests.filter((item) => item && typeof item.passed === "boolean")
      : [];
    const score = scoreFromChecks(checks);
    return {
      score,
      passed: checks.length > 0 && checks.every((item) => item.passed),
      tests: checks,
      capabilities: response?.capabilities || {},
      errors: checks.filter((item) => !item.passed).length,
      quality: qualityFor(score),
      error: checks.some((item) => !item.passed) ? "部分本地能力未通过真实调用" : "",
      detail: `本地底层调用 ${checks.filter((item) => item.passed).length}/${checks.length} 通过`,
      evidence: response?.evidence || response || null
    };
  }

  async probeFileProcessing() {
    if (!this.fileProbe) return { score: 0, passed: false, tests: [], errors: 1, quality: "未验证", error: "未配置文件处理探针", detail: "文件能力未实际验证" };
    const response = await this.fileProbe();
    const checks = [
      { name: "识别测试文件", passed: response?.recognized === true },
      { name: "读取文件内容", passed: response?.contentMatched === true },
      { name: "建立文件关联", passed: response?.linked === true },
      { name: "清理临时文件", passed: response?.cleaned === true }
    ];
    const score = clamp((checks.filter((item) => item.passed).length / checks.length) * 100);
    return { score, passed: score >= 60, tests: checks, errors: checks.filter((item) => !item.passed).length, quality: qualityFor(score), detail: `文件解析 ${checks.filter((item) => item.passed).length}/${checks.length} 通过`, evidence: response };
  }

  checkUnderstanding(probe = this.probeUnderstanding()) {
    return { id: "understanding", name: "智能理解能力", score: probe.score, status: statusFor(probe.score), detail: `完成测试 ${probe.tests?.filter((item) => item.passed).length || 0}/${probe.tests?.length || 0} · 错误 ${probe.errors || 0} 次 · 响应质量 ${probe.quality || qualityFor(probe.score)}`, tests: probe.tests, errors: probe.errors || 0, quality: probe.quality };
  }

  checkClosure(probe) {
    return { id: "closure", name: "任务闭环能力", score: probe.score, status: statusFor(probe.score), detail: `规划测试 ${probe.tests?.filter((item) => item.passed).length || 0}/${probe.tests?.length || 0} · 错误 ${probe.errors || 0} 次 · 质量 ${probe.quality || qualityFor(probe.score)}`, checks: probe.tests, errors: probe.errors || 0, quality: probe.quality };
  }

  checkContext(probe) {
    return { id: "context", name: "上下文保持能力", score: probe.score, status: statusFor(probe.score), detail: `连续阶段保持率 ${probe.score}% · 错误 ${probe.errors || 0} 次`, tests: probe.tests, errors: probe.errors || 0, quality: probe.quality };
  }

  checkCapabilities(toolRequirements = [], fileProbe, toolProbe) {
    const items = this.capabilityCenter?.listCapabilities?.() || [];
    const module = (id, name, category, probe) => {
      const checks = toolRequirements.filter((item) => item.category === category);
      const allChecks = [...(probe?.tests || []), ...checks.map((item) => ({ name: `capability:${item.id}`, passed: item.available === true }))];
      const summary = evidenceSummary(allChecks);
      return { id, name, score: summary.score, status: statusFor(summary.score), detail: `真实检查 ${summary.passed}/${summary.total} · 错误 ${summary.failed} 次`, checks: allChecks, errors: summary.failed, quality: qualityFor(summary.score) };
    };
    return {
      items,
      fileModule: module("file", "文件处理能力", "file", fileProbe),
      systemModule: module("system", "系统操作能力", "system", toolProbe)
    };
  }

  checkTools(executionProbe = { score: 0, errors: 1, quality: "未验证" }, localProbe = null) {
    const tools = this.toolProvider() || [];
    const toolIds = new Set(tools.map((tool) => String(tool.id || "").trim()).filter(Boolean));
    const capabilityIds = new Set((this.capabilityCenter?.listCapabilities?.() || [])
      .filter((item) => item.status === "available")
      .flatMap((item) => [String(item.id || ""), String(item.source || "")])
      .filter(Boolean));
    const requirements = TOOL_REQUIREMENTS.map((item) => {
      const matchedToolIds = item.toolIds.filter((id) => toolIds.has(id));
      const matchedCapabilityIds = item.toolIds.filter((id) => capabilityIds.has(id) || capabilityIds.has(`tool.${id}`));
      const matches = new Set([...matchedToolIds, ...matchedCapabilityIds]);
      const registered = item.matchMode === "all" ? item.toolIds.every((id) => matches.has(id)) : matches.size > 0;
      const hasLocalEvidence = Boolean(localProbe && localProbe.capabilities && Object.prototype.hasOwnProperty.call(localProbe.capabilities, item.id));
      const locallyVerified = hasLocalEvidence ? localProbe.capabilities[item.id] === true : localProbe ? false : true;
      const available = registered && locallyVerified;
      return {
        ...item,
        available,
        matchedToolIds,
        matchedCapabilityIds,
        evidence: { toolIds: item.toolIds, matchMode: item.matchMode || "any", matchedToolIds, matchedCapabilityIds, registered, locallyVerified, localProbeConfigured: Boolean(localProbe) }
      };
    });
    const coverageScore = scoreFromChecks(requirements.map((item) => ({ passed: item.available })));
    const checks = [...(executionProbe.tests || []), ...requirements.map((item) => ({ name: `capability:${item.id}`, passed: item.available, detail: item.suggestion }))];
    const score = scoreFromChecks(checks);
    const categoryCoverage = Object.fromEntries(["file", "system", "network", "desktop"].map((category) => {
      const categoryItems = requirements.filter((item) => item.category === category);
      return [category, clamp((categoryItems.filter((item) => item.available).length / Math.max(1, categoryItems.length)) * 100)];
    }));
    return {
      id: "tools",
      name: "工具能力",
      score,
      status: statusFor(score),
      detail: `真实调用 ${executionProbe.score}% · 注册覆盖 ${coverageScore}% · 错误 ${executionProbe.errors || 0} 次`,
      toolCount: tools.length,
      requirements,
      coverageScore,
      categoryCoverage,
      checks,
      errors: checks.filter((item) => !item.passed).length,
      quality: qualityFor(score)
    };
  }

  checkRecovery() {
    const samples = [
      { error: "network timeout", expected: "retry" },
      { error: "ENOENT file path not found", expected: "correct_parameters" },
      { error: "PDF parse failed", expected: "alternative" },
      { error: "EACCES permission denied", expected: "user_intervention" }
    ];
    const checks = samples.map((sample) => {
      const actual = this.recoveryManager?.plan?.({ result: { error: sample.error }, planObject: { id: "health-probe", tasks: [] } })?.action || "unavailable";
      return { ...sample, actual, passed: actual === sample.expected };
    });
    checks.push({ expected: "checkpoint", actual: this.checkpointManager?.create && this.checkpointManager?.restore ? "checkpoint" : "unavailable", passed: Boolean(this.checkpointManager?.create && this.checkpointManager?.restore) });
    const score = clamp((checks.filter((item) => item.passed).length / checks.length) * 100);
    return { id: "recovery", name: "错误恢复能力", score, status: statusFor(score), detail: `恢复策略 ${checks.filter((item) => item.passed).length}/${checks.length} 通过`, checks, errors: checks.filter((item) => !item.passed).length, quality: qualityFor(score) };
  }

  checkLongTask({ contextProbe, planningProbe, recovery }) {
    const checks = [
      { name: "目标保持", passed: contextProbe.score >= 60 },
      { name: "阶段规划", passed: planningProbe.score >= 60 },
      { name: "执行检查点", passed: Boolean(this.checkpointManager?.create && this.checkpointManager?.restore) },
      { name: "失败恢复", passed: recovery.score >= 60 }
    ];
    const score = clamp((checks.filter((item) => item.passed).length / checks.length) * 100);
    return { id: "long_task", name: "长期任务能力", score, status: statusFor(score), detail: `${checks.filter((item) => item.passed).length}/${checks.length} 项长任务保障通过`, checks, errors: checks.filter((item) => !item.passed).length, quality: qualityFor(score) };
  }

  analyzeGaps(requirements = []) {
    return requirements.filter((item) => !item.available).map((item) => ({
      id: item.id,
      name: item.label,
      category: item.category,
      gapType: item.gapType || "tool",
      installable: item.installable === true,
      connectable: item.connectable === true,
      connectorAction: item.connectorAction || "unavailable",
      integrationType: item.integrationType || "unavailable",
      requiredToolIds: item.toolIds || [],
      evidence: item.evidence || { toolIds: item.toolIds || [], matchedToolIds: [], matchedCapabilityIds: [] },
      suggestion: item.suggestion,
      priorityScore: Number(((item.frequency * item.value) / Math.max(1, item.difficulty)).toFixed(1)),
      phase: item.frequency >= 8 && item.value >= 8 ? "P0" : item.difficulty <= 4 ? "P1" : "P2"
    })).sort((a, b) => b.priorityScore - a.priorityScore);
  }

  generateReport(options) { return this.runHealthCheck(options); }
  isCurrentReport(report) {
    return Boolean(report
      && Number(report.schemaVersion) >= HEALTH_REPORT_SCHEMA_VERSION
      && report.runtime === HEALTH_REPORT_RUNTIME
      && report.reportSource === HEALTH_REPORT_SOURCE
      && report.reportId);
  }
  latest() {
    try {
      const report = JSON.parse(fs.readFileSync(this.latestFile, "utf8"));
      return this.isCurrentReport(report) ? report : null;
    } catch { return null; }
  }
  history() {
    try {
      const value = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      return Array.isArray(value) ? value.filter((report) => this.isCurrentReport(report)) : [];
    } catch { return []; }
  }
  persist(report, history = this.history()) {
    atomicWrite(this.latestFile, report);
    atomicWrite(this.historyFile, [...history, report].slice(-52));
  }
}

module.exports = { AgentHealthManager, TOOL_REQUIREMENTS, HEALTH_TESTS, HEALTH_PHASES, statusFor };
