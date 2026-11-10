"use strict";

const path = require("node:path");
const fs = require("node:fs");
const XLSX = require("xlsx");

function clean(value, limit = 12000) {
  return String(value || "").trim().slice(0, limit);
}

function assignmentMarker(assignmentId = "") {
  return `[BAIQIU_ASSIGNMENT_ID=${clean(assignmentId, 240)}]`;
}

function absoluteWindowsPaths(summary = "") {
  // 排除中文逗号/句号/分号/顿号/半角逗号等分隔符：路径后常跟"，表头为指标"等，
  // 贪婪匹配会把后缀文字并进路径，导致 goal 与 result 提取的路径不一致、
  // 信任豁免失效（task-041 指挥项目路径门禁误杀根因）。
  const matches = String(summary || "").match(/[a-z]:\\[^\s，。；;、,|`"'<>()（）]+/gi) || [];
  return [...new Set(matches.map((item) => item.replace(/[，。；;、)）}\]]+$/g, "")))];
}

function outputPathsOutsideWorkspace(summary = "", workspace = "") {
  const root = clean(workspace, 4000);
  if (!root) return [];
  const normalizedRoot = path.win32.resolve(root).toLowerCase();
  // 只校验带产物扩展名的文件路径：Worker 正文提到工作目录/输入目录（裸目录、
  // 无扩展名）是正常上下文，不是额外产物。误把裸目录当越界产物会让"真实执行
  // 成功"被验收器判失败（task-041 rc.9：价格 Agent 提到 qa-artifacts 目录被
  // 当成额外产物，CEO 只回收 1/2）。
  const PRODUCT_EXT = /\.(?:txt|md|json|csv|html?|xlsx?|pdf|docx?|pptx?|png|jpe?g|webp)$/i;
  return absoluteWindowsPaths(summary)
    .filter((item) => PRODUCT_EXT.test(item))
    .filter((item) => {
      const candidate = path.win32.resolve(item).toLowerCase();
      return candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}\\`);
    });
}

function requestedCharacterCount(goal = "") {
  const value = clean(goal, 4000);
  const numeric = value.match(/(\d{2,5})\s*字/);
  if (numeric) return Number(numeric[1]);
  const hundreds = value.match(/([一二两三四五六七八九])百\s*字/);
  if (hundreds) return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[hundreds[1]] * 100;
  if (/一百\s*字/.test(value)) return 100;
  return 0;
}

function readableDeclaredOutput(summary = "", workspace = "") {
  const root = clean(workspace, 4000);
  const normalizedRoot = root ? path.win32.resolve(root).toLowerCase() : "";
  for (const file of absoluteWindowsPaths(summary)) {
    const candidate = path.win32.resolve(file);
    const normalized = candidate.toLowerCase();
    if (normalizedRoot && normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}\\`)) continue;
    if (!/\.(?:txt|md)$/i.test(candidate)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size <= 2 * 1024 * 1024) return fs.readFileSync(candidate, "utf8");
    } catch {}
  }
  return "";
}

function extractWorkerContent(summary = "", workspace = "") {
  const fileContent = readableDeclaredOutput(summary, workspace);
  if (fileContent.trim()) return fileContent.trim();
  const quoted = String(summary || "").split(/\r?\n/)
    .filter((line) => /^\s*>/.test(line))
    .map((line) => line.replace(/^\s*>\s?/, "").trim())
    .filter(Boolean)
    .join("\n");
  if (quoted) return quoted;
  const text = clean(summary, 200000);
  return /(?:交付物|验收|验证结果|完成摘要|字数统计)/i.test(text) ? "" : text;
}

function outputReadabilityError(file = "", goal = "") {
  const extension = path.extname(file).toLowerCase();
  if (![".xlsx", ".xls"].includes(extension)) return "";
  try {
    const workbook = XLSX.readFile(file, { raw: false, dense: true });
    if (!workbook.SheetNames.length) return "工作簿没有可读取的工作表";
    const hasCells = workbook.SheetNames.some((name) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" });
      return rows.some((row) => row.some((value) => String(value ?? "").trim() !== ""));
    });
    if (/(?:表头|数据|内容|行|列)/i.test(goal) && !hasCells) return "工作簿无法读取到任务要求的单元格内容";
    return "";
  } catch (error) {
    return `工作簿无法被标准 XLSX 解析器读取：${clean(error?.message || error, 500)}`;
  }
}

function verifyAssignmentResult(assignment = {}, result = {}, delegationId = "") {
  const hardErrors = [];
  const warnings = [];
  const deliveryMode = clean(assignment.deliveryMode, 40) === "file" ? "file" : "chat";
  // 用户/编排在任务目标里明确指定的输出路径属于信任路径：Worker 按指令写入
  // 这些路径不算越界（任务要求"生成 D:\...\summary.xlsx"却因路径在工作目录
  // 之外被误判失败，违反信任模式明确绝对路径的产品约定）。只拦截 Worker
  // 自行决定、目标里没有的越界路径。
  // 豁免按"目录 + 文件名（去扩展名）"匹配：Agent 常把要求扩展名写成相近格式
  // （如要求 .xlsx 实际存成 .csv），同一目录同名不同扩展名应视为按指令交付。
  const trustedOutputKeys = new Set(
    absoluteWindowsPaths(`${assignment.goal || ""}\n${assignment.scope || ""}\n${assignment.deliverable || ""}`)
      .map((item) => path.win32.resolve(item).toLowerCase())
      .map((resolved) => `${path.win32.dirname(resolved)}\u0000${path.win32.basename(resolved, path.win32.extname(resolved))}`)
  );
  const isTrustedOutput = (item) => {
    const resolved = path.win32.resolve(item).toLowerCase();
    const key = `${path.win32.dirname(resolved)}\u0000${path.win32.basename(resolved, path.win32.extname(resolved))}`;
    return trustedOutputKeys.has(key);
  };
  const outsidePaths = outputPathsOutsideWorkspace(result.summary, assignment.workingDirectory)
    .filter((item) => !isTrustedOutput(item));
  if (outsidePaths.length) hardErrors.push(`Hermes Worker 将结果写到了项目工作目录之外：${outsidePaths.join("、")}`);

  const declaredOutputs = absoluteWindowsPaths(result.summary)
    .filter((item) => /\.(?:txt|md|json|csv|html?|xlsx?|pdf|docx?|pptx?|png|jpe?g|webp)$/i.test(item));
  const expectedFileCount = deliveryMode === "file" ? Math.max(1, Number(assignment.expectedFileCount || 1)) : 0;
  const missingOutputs = declaredOutputs.filter((item) => {
    try { return !fs.statSync(item).isFile(); } catch { return true; }
  });
  if (missingOutputs.length) {
    const message = `Hermes Worker 声明的交付文件不存在：${missingOutputs.join("、")}`;
    if (deliveryMode === "file") hardErrors.push(message);
    else warnings.push(message);
  }
  if (deliveryMode === "file" && declaredOutputs.length < expectedFileCount) {
    hardErrors.push(`文件任务要求${expectedFileCount}个真实文件，但Worker只返回了${declaredOutputs.length}个可核验文件路径。`);
  }
  if (deliveryMode === "file") {
    for (const file of declaredOutputs.filter((item) => !missingOutputs.includes(item))) {
      const readabilityError = outputReadabilityError(file, assignment.goal);
      if (readabilityError) hardErrors.push(`Hermes Worker 交付文件不可用：${file}（${readabilityError}）。`);
    }
  }

  const hasExecutionEvidence = String(result?.delegationId || delegationId || "") === delegationId
    && clean(result?.liveTranscript, 2000)
    && Number(result?.apiCalls || 0) > 0
    && Number.isFinite(Number(result?.durationSeconds));
  if (!hasExecutionEvidence) hardErrors.push("Hermes Worker 缺少可复核的真实执行证据。");

  const expectedCharacters = requestedCharacterCount(assignment.goal);
  if (expectedCharacters) {
    const content = extractWorkerContent(result.summary, assignment.workingDirectory);
    const actualCharacters = (content.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const tolerance = /(?:约|左右|大约)/.test(assignment.goal) ? 0.25 : 0.15;
    const minimum = Math.floor(expectedCharacters * (1 - tolerance));
    const maximum = Math.ceil(expectedCharacters * (1 + tolerance));
    if (!content) hardErrors.push(`无法从 Worker 结果中提取正文，不能确认存在真实正文。`);
    else if (actualCharacters < minimum || actualCharacters > maximum) {
      warnings.push(`正文实际为${actualCharacters}个汉字，目标约${expectedCharacters}字（建议范围${minimum}-${maximum}字），结果已保留。`);
    }
  }
  return { ok: hardErrors.length === 0, errors: hardErrors, hardErrors, warnings };
}

function normalizedAssignments(assignments = []) {
  const list = (Array.isArray(assignments) ? assignments : []).map((assignment, index) => ({
    assignmentId: clean(assignment.assignmentId || assignment.assignment_id || `assignment-${index + 1}`, 240),
    roleSessionId: clean(assignment.roleSessionId || assignment.agent_id, 240),
    roleName: clean(assignment.roleName || assignment.name || `员工 ${index + 1}`, 240),
    role: clean(assignment.role || "执行人员", 240),
    goal: clean(assignment.goal || assignment.action, 12000),
    scope: clean(assignment.scope || assignment.goal || assignment.action, 4000),
    deliverable: clean(assignment.deliverable || "返回本员工负责范围的完整结果", 2000),
    deliveryMode: clean(assignment.deliveryMode, 40) === "file" ? "file" : "chat",
    expectedFileCount: Math.max(0, Math.min(20, Number(assignment.expectedFileCount || 0))),
    inputFiles: (Array.isArray(assignment.inputFiles) ? assignment.inputFiles : []).map((file) => ({
      name: clean(file?.name, 240),
      path: clean(file?.path || file?.sourcePath, 4000),
      mimeType: clean(file?.mimeType, 160),
      sizeBytes: Number(file?.sizeBytes || 0),
      analysisPath: clean(file?.analysisPath, 4000)
    })).filter((file) => file.name && file.path),
    workingDirectory: clean(assignment.workingDirectory, 4000),
    acceptance: (Array.isArray(assignment.acceptance) ? assignment.acceptance : []).map((item) => clean(item, 500)).filter(Boolean).slice(0, 12),
    maxToolCalls: Math.max(1, Math.min(30, Number(assignment.maxToolCalls || 8)))
  }));
  if (!list.length) throw new Error("Hermes Worker dispatch requires assignments.");
  if (list.some((item) => !item.assignmentId || !item.roleSessionId || !item.goal)) {
    throw new Error("Every Hermes Worker assignment requires assignmentId, roleSessionId and goal.");
  }
  if (new Set(list.map((item) => item.assignmentId)).size !== list.length) throw new Error("Hermes Worker assignment ids must be unique.");
  if (new Set(list.map((item) => item.roleSessionId)).size !== list.length) throw new Error("Hermes Worker role bindings must be one-to-one.");
  return list;
}

function buildHermesDelegationTasks(assignments = [], context = {}) {
  const list = normalizedAssignments(assignments);
  return list.map((assignment) => {
    const structuredInputs = assignment.inputFiles.filter((file) => file.analysisPath);
    const inputRule = structuredInputs.length
      ? `白球已经在本地读取并校验了输入文件，并将结构化摘要保存到：${structuredInputs.map((file) => `${file.name} => ${file.analysisPath}`).join("；")}。先用现有文件读取工具读取摘要；只有摘要确实缺少任务所需数据时才读取原文件。不得安装 pandas、openpyxl 或其他依赖，不得用包管理器等待安装。`
      : "如果任务需要读取文件，只使用当前环境已有工具；禁止为了读取文件临时安装 pandas、openpyxl 或其他依赖。";
    const deliveryRule = assignment.deliveryMode === "file"
      ? `用户明确要求文件交付。必须生成${Math.max(1, assignment.expectedFileCount || 1)}个真实文件，并在最终回复中逐一返回可核验的绝对路径。任务里指定的绝对输出路径（用户指定位置）可直接写入；未指定的文件应写入工作目录。`
      : "本任务的交付位置是员工对话框。直接返回完整正文或结论；除非读取指定输入所必需，否则不要调用文件工具、不要创建TXT/Markdown等文件。";
    const expectedCharacters = requestedCharacterCount(assignment.goal);
    const characterRule = expectedCharacters
      ? `篇幅是质量目标，不是完成门禁。尽量控制在约${expectedCharacters}个汉字，返回前自行检查；即使有偏差也必须交付真实正文。`
      : "";
    const xlsxSpecPath = path.win32.join(
      assignment.workingDirectory || clean(context.workspace, 4000) || ".",
      `.baiqiu-xlsx-${assignment.assignmentId}.json`
    );
    const xlsxRule = assignment.deliveryMode === "file" && /\.xlsx?\b/i.test(assignment.goal)
      ? context.xlsxBackend?.pythonPath && context.xlsxBackend?.helperPath
        ? `本任务要求标准 Excel 文件。必须使用 execute_code 调用白球受控 XLSX 后端，不得手工拼接 OOXML/ZIP。规格文件只能写到项目工作目录内的 r'${xlsxSpecPath}'，不得放到用户输出目录；用 json.dump(..., ensure_ascii=False) 写 UTF-8 JSON，格式为 {"sheet":"工作表名","rows":[["表头1","表头2"],["值1",2]]}。再用 subprocess.run([sys.executable, r'${context.xlsxBackend.helperPath}', '--output', r'任务指定的xlsx绝对路径', '--spec', r'${xlsxSpecPath}'], check=True) 生成文件。完成后必须调用 subprocess.run([sys.executable, r'${context.xlsxBackend.helperPath}', '--inspect', r'xlsx绝对路径'], check=True) 并核对每个单元格，然后删除 r'${xlsxSpecPath}'。最终回复只能返回任务要求的 XLSX 路径，不得把临时规格文件当成交付物。`
        : "XLSX 必须能被标准 Excel 解析器回读到任务要求的单元格；不得仅检查 ZIP 完整性或原始 XML 后声称完成。"
      : "";
    return {
      goal: `${assignmentMarker(assignment.assignmentId)}\n岗位：${assignment.roleName}（${assignment.role}）\n任务：${assignment.goal}\n负责范围：${assignment.scope}\n交付方式：${assignment.deliveryMode === "file" ? "文件" : "内部执行对话"}\n交付物：${assignment.deliverable}\n验收标准：${assignment.acceptance.join("；") || "必须返回可复核的真实结果"}\n${deliveryRule}\n${xlsxRule}\n${characterRule}\n工具调用上限：${assignment.maxToolCalls}\n只完成本任务并返回完整结果，不得再委派其他内部执行单元，不得代替黑球汇总其他结果或整个项目，不得扫描未列出的目录。`,
      context: `白球项目ID：${clean(context.projectId, 240)}\n项目运行ID：${clean(context.runId, 240)}\n内部执行会话ID：${assignment.roleSessionId}\n工作目录：${assignment.workingDirectory || clean(context.workspace, 4000)}\n指定输入文件：${JSON.stringify(assignment.inputFiles)}\n${inputRule}`,
      role: "leaf"
    };
  });
}

function buildHermesDelegationPrompt(assignments = [], context = {}) {
  const tasks = buildHermesDelegationTasks(assignments, context);
  return [
    "你是白球项目的 Hermes 调度器。本轮禁止亲自完成任何子任务。",
    `必须且只能调用一次 delegate_task，并使用 batch tasks 参数创建恰好 ${tasks.length} 个 leaf Worker。`,
    "tasks 必须严格保持下面 JSON 的数量、顺序、goal 和 context，不得合并、删减、改写或新增任务。每个 Worker 只能读取指定输入文件和工作目录，不得自行搜索整个电脑。",
    JSON.stringify(tasks, null, 2),
    "delegate_task 返回句柄后不要编写任务正文，只回复 BAIQIU_DELEGATION_DISPATCHED。"
  ].join("\n\n");
}

function bindHermesResults(assignments = [], runtimeResult = {}) {
  const list = normalizedAssignments(assignments);
  const delegationIds = [...new Set((runtimeResult.delegationIds || []).map(String).filter(Boolean))];
  if (delegationIds.length !== 1) throw new Error(`Expected exactly one Hermes delegation batch, received ${delegationIds.length}.`);
  const completion = Array.isArray(runtimeResult.delegationCompletions) ? runtimeResult.delegationCompletions[0] : null;
  const goals = Array.isArray(completion?.event?.goals) ? completion.event.goals : [];
  if (goals.length !== list.length) throw new Error(`Hermes delegation count mismatch: expected ${list.length}, received ${goals.length}.`);
  list.forEach((assignment, index) => {
    if (!String(goals[index] || "").includes(assignmentMarker(assignment.assignmentId))) {
      throw new Error(`Hermes delegation lost assignment binding at task ${index}.`);
    }
  });
  const runtimeResults = Array.isArray(runtimeResult.delegationResults) ? runtimeResult.delegationResults : [];
  if (runtimeResults.length !== list.length) throw new Error(`Hermes result count mismatch: expected ${list.length}, received ${runtimeResults.length}.`);
  return list.map((assignment, index) => {
    const result = runtimeResults.find((item) => item.taskIndex === index);
    const verification = verifyAssignmentResult(assignment, result, delegationIds[0]);
    const extracted = assignment.deliveryMode === "chat"
      ? extractWorkerContent(result?.summary, assignment.workingDirectory)
      : "";
    const deliveredSummary = clean(extracted || result?.summary, 200000);
    const status = String(result?.status || "failed").toLowerCase() === "completed"
      && deliveredSummary
      && verification.ok
      ? "completed"
      : "failed";
    return {
      ...assignment,
      taskIndex: index,
      delegationId: delegationIds[0],
      status,
      summary: deliveredSummary,
      warnings: verification.warnings,
      error: status === "completed"
        ? ""
        : clean(result?.error
          || verification.errors.join("；")
          || result?.exitReason
          || "Hermes Worker did not return a complete result.", 4000),
      evidence: {
        delegationId: delegationIds[0],
        taskIndex: index,
        hermesParentSessionId: clean(runtimeResult.hermesSessionId, 240),
        model: clean(result?.model, 240),
        apiCalls: Number(result?.apiCalls || 0),
        durationSeconds: result?.durationSeconds ?? null,
        tokens: result?.tokens || null,
        liveTranscript: clean(result?.liveTranscript, 2000)
      }
    };
  });
}

class HermesWorkerRuntime {
  constructor({ ledger, execute } = {}) {
    if (!ledger || typeof ledger.begin !== "function") throw new Error("HermesWorkerRuntime requires a ProjectRunLedger.");
    if (typeof execute !== "function") throw new Error("HermesWorkerRuntime requires an execute function.");
    this.ledger = ledger;
    this.execute = execute;
  }

  async dispatchBatch({ projectId, ceoSessionId, taskId = "", goal = "", assignments = [], signal = null, onUpdate = null } = {}) {
    const normalized = normalizedAssignments(assignments);
    const run = this.ledger.begin({ projectId, ceoSessionId, taskId, goal, assignments: normalized });
    this.ledger.markStarted(run.runId);
    const prompt = buildHermesDelegationPrompt(normalized, { projectId, runId: run.runId, workspace: normalized[0]?.workingDirectory || "" });
    let runtimeResult = null;
    let dispatchedRun = null;
    const markDispatched = ({ hermesParentSessionId = "", delegationId = "", bindings = [] } = {}) => {
      if (!delegationId || dispatchedRun) return dispatchedRun;
      dispatchedRun = this.ledger.markDispatched(run.runId, {
        hermesParentSessionId,
        delegationId,
        bindings: bindings.length
          ? bindings
          : normalized.map((assignment, index) => ({ assignmentId: assignment.assignmentId, taskIndex: index }))
      });
      return dispatchedRun;
    };
    try {
      runtimeResult = await this.execute({
        prompt,
        run,
        assignments: normalized,
        signal,
        onUpdate,
        onDelegationDiscovered: (info) => markDispatched(info)
      });
      const results = bindHermesResults(normalized, runtimeResult);
      markDispatched({
        hermesParentSessionId: runtimeResult.hermesSessionId,
        delegationId: results[0].delegationId,
        bindings: results.map((item) => ({ assignmentId: item.assignmentId, taskIndex: item.taskIndex }))
      });
      const finished = this.ledger.finish(run.runId, results);
      if (finished.status !== "completed") {
        const error = new Error(finished.error || "One or more Hermes Workers failed.");
        error.code = "HERMES_WORKER_INCOMPLETE";
        error.workerRun = finished;
        error.workerResults = results;
        throw error;
      }
      return { run: finished, results, runtime: runtimeResult };
    } catch (error) {
      if (!error.workerRun) {
        const partialResults = Array.isArray(error.workerResults) ? error.workerResults : [];
        error.workerRun = this.ledger.fail(run.runId, error.message || "Hermes Worker dispatch failed.", partialResults);
        error.workerResults = partialResults;
      }
      error.runtimeResult = runtimeResult;
      throw error;
    }
  }
}

module.exports = {
  HermesWorkerRuntime,
  assignmentMarker,
  bindHermesResults,
  buildHermesDelegationPrompt,
  buildHermesDelegationTasks,
  normalizedAssignments,
  outputPathsOutsideWorkspace,
  outputReadabilityError,
  requestedCharacterCount,
  verifyAssignmentResult
};
