"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ToolExecutionService } = require("../services/tool-execution-service");
const { TaskBrain } = require("../services/task-brain");
const { buildProductExecutionStrategies } = require("../services/product-execution-strategies");
const { ProductExecutionServices } = require("../services/product-execution-services");
const { ToolSelector } = require("../services/tool-selector");

function createExecutionService(authorizer, execute) {
  return new ToolExecutionService({
    registry: {
      list: () => [{ id: "write_xlsx" }],
      execute
    },
    selector: {
      approveToolCall: () => ({ approved: true, reason: "selected", selectedTools: [{ id: "write_xlsx" }] })
    },
    authorizer,
    ensureRunActive: () => {}
  });
}

test("member entitlement is the only product authorization before tool execution", async () => {
  let executionCount = 0;
  const denied = createExecutionService(
    () => ({ allowed: false, code: "MEMBERSHIP_REQUIRED", message: "会员 required" }),
    async () => {
      executionCount += 1;
      return { success: true, result: "unexpected" };
    }
  );
  const deniedResult = await denied.execute({ toolId: "write_xlsx" });
  assert.equal(deniedResult.success, false);
  assert.equal(deniedResult.error.code, "MEMBERSHIP_REQUIRED");
  assert.equal(executionCount, 0);

  const allowed = createExecutionService(
    () => ({ allowed: true }),
    async () => {
      executionCount += 1;
      return { success: true, result: "written" };
    }
  );
  const allowedResult = await allowed.execute({ toolId: "write_xlsx" });
  assert.equal(allowedResult.success, true);
  assert.equal(allowedResult.result, "written");
  assert.equal(executionCount, 1);
});

test("supplemental verifier diagnostics do not rewrite a completed tool result", async () => {
  const service = new ToolExecutionService({
    registry: {
      list: () => [{ id: "write_xlsx" }],
      execute: async () => ({ success: true, result: { file: "C:\\test.xlsx" } })
    },
    selector: {
      approveToolCall: () => ({ approved: true, reason: "selected", selectedTools: [{ id: "write_xlsx" }] })
    },
    verifier: {
      verify: () => ({ verified: false, status: "failed", reason: "missing optional evidence", checks: [] })
    },
    ensureRunActive: () => {}
  });
  const result = await service.execute({ toolId: "write_xlsx" });
  assert.equal(result.success, true);
  assert.equal(result.status, "success");
  assert.equal(result.verification.verified, false);
  assert.equal(result.response.meta.verificationDiagnostic, "missing optional evidence");
});

test("baiqiu-action protocol fields are not forwarded as tool arguments", async () => {
  let received = null;
  const service = new ToolExecutionService({
    registry: {
      list: () => [{ id: "write_xlsx" }],
      execute: async (_id, args) => {
        received = args;
        return { success: true, result: { path: args.path } };
      }
    },
    selector: {
      approveToolCall: () => ({ approved: true, reason: "selected", selectedTools: [{ id: "write_xlsx" }] })
    },
    ensureRunActive: () => {}
  });
  await service.executeActions([{ type: "write_xlsx", toolId: "ignored", path: "desktop/report.xlsx" }]);
  assert.deepEqual(received, { path: "desktop/report.xlsx" });
});

test("client integrity status is diagnostic rather than a tool entitlement gate", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function memberToolEntitlement");
  const end = mainSource.indexOf("function broadcastLicenseStatus", start);
  const entitlement = mainSource.slice(start, end);
  assert.match(entitlement, /const membershipActive = status\.unlocked \|\| trialActive/);
  assert.match(entitlement, /if \(membershipActive\)[\s\S]*return \{ allowed: true, status \}/);
  assert.doesNotMatch(entitlement, /code: "CLIENT_INTEGRITY_REPAIR_REQUIRED"/);
});

test("legacy chat execution treats integrity as a diagnostic warning", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("chat:send"');
  const end = mainSource.indexOf('ipcMain.handle("chat:abort"', start);
  const legacyChat = mainSource.slice(start, end);
  assert.match(legacyChat, /Integrity warning recorded without blocking execution/);
  assert.doesNotMatch(legacyChat, /throw new Error\(licenseStatus\.securityMessage/);
});

test("HMS permission requests are silent and mode-free", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function requestHermesPermission");
  const end = mainSource.indexOf("function ensureHermesClient", start);
  const handler = mainSource.slice(start, end);
  assert.match(handler, /isSensitiveHermesToolCall/);
  assert.match(handler, /memberToolEntitlement/);
  assert.match(handler, /hermesPermissionSelection\(params\.options \|\| \[\], "allow_once"\)/);
  assert.doesNotMatch(handler, /currentToolAccessMode|_requestChatConfirmation|accessMode/);
});

test("a drive-root desktop path falls back to the user's desktop folder", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(mainSource, /function preferredDesktopPath\(\)/);
  assert.match(mainSource, /function desktopOutputRoot\(\)/);
  assert.match(mainSource, /nativeDesktop === path\.parse\(nativeDesktop\)\.root/);
  assert.match(mainSource, /app\.setPath\("desktop", preferredDesktopPath\(\)\)/);
  assert.match(mainSource, /const desktopRoot = desktopOutputRoot\(\)/);
});

test("an existing drive-root save setting is accepted without creating the drive root", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function configuredSaveRoot");
  const end = mainSource.indexOf("function safeActionPath", start);
  const saveRoot = mainSource.slice(start, end);
  assert.match(saveRoot, /resolved === path\.parse\(resolved\)\.root/);
  assert.match(saveRoot, /fs\.existsSync\(resolved\).*fs\.statSync\(resolved\)\.isDirectory\(\)/s);
  assert.match(saveRoot, /return resolved/);
  assert.match(saveRoot, /return path\.resolve\(fallback\)/);
});

test("trust mode supports known folders and explicit absolute paths", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function safeActionPath");
  const end = mainSource.indexOf("function actionRelativeLabel", start);
  const safePath = mainSource.slice(start, end);
  assert.match(safePath, /desktop\|documents\|downloads\|pictures\|music\|videos\|home/);
  assert.match(mainSource, /function trustedLocalFileAccessEnabled\(\)/);
  assert.match(safePath, /const hasFullLocalAccess = fullLocalFileAccessEnabled\(\) \|\| trustedLocalFileAccessEnabled\(\);/);
  assert.match(safePath, /hasFullLocalAccess && path\.isAbsolute\(value\)/);
});

test("direct provider conversations have no White Ball response deadline", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function runDirectConversation");
  const end = mainSource.indexOf("async function runHermesSessionPrompt", start);
  const directConversation = mainSource.slice(start, end);
  assert.match(directConversation, /const signal = options\.signal \|\| null/);
  assert.doesNotMatch(directConversation, /setTimeout|MODEL_RESPONSE_TIMEOUT|firstResponseTimeoutMs/);
});

test("provider conversation and HMS fallback are text-only", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const directConversation = mainSource.slice(
    mainSource.indexOf("async function runDirectConversation"),
    mainSource.indexOf("async function runHermesSessionPrompt")
  );
  const runtimeFallback = mainSource.slice(
    mainSource.indexOf("async function runProviderFallbackForHermesUnavailable"),
    mainSource.indexOf("async function runDirectConversation")
  );
  assert.match(directConversation, /disableTools: true/);
  assert.match(directConversation, /disableWebBridge: true/);
  assert.match(runtimeFallback, /disableTools: true/);
  assert.match(runtimeFallback, /disableWebBridge: true/);
  assert.match(mainSource, /if \(!toolsAllowed\) \{[\s\S]*?stopReason: "text_only_provider"/);
});

test("task brain never adds a confirmation state to new or stored work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-task-brain-"));
  try {
    const brain = new TaskBrain({ root });
    const task = brain.prepare({
      sessionId: "session-1",
      understanding: {
        goal: "delete temporary files",
        intentType: "system_operation",
        context: {
          normalizedInput: "delete temporary files",
          taskSpec: { taskType: "system_operation", requiresConfirmation: true }
        }
      }
    });
    assert.equal(task.status, "ready");
    assert.equal(task.requires_confirmation, false);

    brain.store.tasks[0].status = "awaiting_confirmation";
    brain.store.tasks[0].requires_confirmation = true;
    brain.save();
    const migrated = new TaskBrain({ root }).get(task.task_id);
    assert.equal(migrated.status, "ready");
    assert.equal(migrated.requires_confirmation, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HMS owns execution decisions before compatibility strategies", () => {
  const services = {
    canUseLocalRouting: () => true,
    canUseHermes: () => true,
    executeDirectCommand: async () => ({ handled: false }),
    executeSkillShortcut: async () => ({ handled: false }),
    executeRealtimeWeb: async () => ({ handled: true, success: true }),
    executeHermes: async () => ({ handled: true, success: true })
  };
  const strategies = buildProductExecutionStrategies({}, services);
  assert.deepEqual(strategies.map((item) => item.name), ["hermes_strategy"]);
});

test("file-analysis context does not suppress a local spreadsheet command", async () => {
  let receivedMessage = "";
  const services = new ProductExecutionServices({
    appendMessage: () => {},
    updateSession: () => {},
    recordAgentState: () => {},
    tryHandleSkillShortcut: async (message) => {
      receivedMessage = message;
      return "generated";
    }
  });
  const input = {
    session: { id: "session-1" },
    originalText: "测试 随便做一个表格给我放桌面",
    effectiveText: "file analysis context",
    skipLocalToolRouting: true,
    understanding: { context: { domainIntent: "content.spreadsheet" }, goal: "create spreadsheet" },
    taskBrain: {}
  };
  assert.equal(services.canUseLocalRouting(input), true);
  const result = await services.executeSkillShortcut(input);
  assert.equal(result.handled, undefined);
  assert.equal(result.success, true);
  assert.equal(receivedMessage, input.originalText);
});

test("spreadsheet intent authorizes the xlsx tool", () => {
  const selector = new ToolSelector();
  const approved = selector.approveToolCall({
    toolCall: { name: "write_xlsx" },
    context: { agentIntent: "content.spreadsheet" }
  });
  assert.equal(approved.approved, true);
});

test("a plain desktop spreadsheet request uses the deterministic xlsx route", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function parseSpreadsheetSkillUse");
  const end = mainSource.indexOf("async function tryHandleSkillShortcutLegacy", start);
  assert.ok(start >= 0 && end > start, "spreadsheet parser must be present in main.js");
  const parser = new Function("sanitizeText", "splitTableValues", `${mainSource.slice(start, end)}; return parseSpreadsheetSkillUse;`)(
    (value) => String(value || "").replace(/\s+/g, " ").trim(),
    (value) => String(value || "").split(/[，,、|]/).map((item) => String(item).trim()).filter(Boolean)
  );
  const request = parser("测试 随便做一个表格给我放桌面");
  // 无指定文件名时回落到带日期的默认名（不再是固定的"白球测试表格"），
  // 避免覆盖用户真实文件。
  assert.match(request.action.path, /^desktop\/白球表格-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(request.action.sheets[0].rows, [
    ["项目", "数量", "备注"],
    ["示例项目", "1", "请编辑此表格"]
  ]);
  const documentsRequest = parser("创建 Excel 表格放到文档 文件名：会员权限测试.xlsx");
  assert.equal(documentsRequest.action.path, "documents/会员权限测试.xlsx");
});

test("product layer leaves spreadsheet tool selection to HMS", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const productRuntimeStart = mainSource.indexOf("async function productLayerChatRuntime");
  const productRuntimeEnd = mainSource.indexOf("function bindUnderstandingToTaskDecision", productRuntimeStart);
  const productRuntime = mainSource.slice(productRuntimeStart, productRuntimeEnd);
  assert.ok(productRuntimeStart >= 0 && productRuntimeEnd > productRuntimeStart);
  assert.doesNotMatch(productRuntime, /executeSpreadsheetShortcut\(originalText/);
  assert.match(productRuntime, /runHermesSessionPromptWithRecovery\(/);
});

test("product submissions prebind only explicit lifecycle work", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const end = mainSource.indexOf('ipcMain.handle("product:query-task"', start);
  const handler = mainSource.slice(start, end);
  assert.doesNotMatch(handler, /incomingAttachments\.length > 0 \|\| requestNeedsHmsToolDecision\(message, sessionId\)/);
  assert.doesNotMatch(handler, /brain\.submit\(\{[\s\S]{0,500}attachments: incomingAttachments/);
  assert.doesNotMatch(handler, /if \(!canonicalTaskId[^)]*\)\s*\{\s*const submitted = brain\.submit/s);
  assert.match(handler, /const conversationOnlyRequest = taskContext\.conversationOnly === true \|\| payload\.templateId === "desktop\.chat";/);
  assert.match(handler, /const timingWatch = canonicalTaskId && !conversationOnlyRequest\s*\? startTaskTimingWatch\(\{ taskId: canonicalTaskId/s);
  assert.match(handler, /awaitingInputContinuation: true/);
  assert.match(handler, /const resolvedTaskId = String\(canonicalTaskId \|\| result\?\.taskId \|\| result\?\.taskBrain\?\.task_id/);
  assert.match(handler, /taskBrain: brain\.executionContext\(finalTask \|\| resolvedTaskId\)/);
  assert.match(handler, /taskBrain: finalTask \? brain\.executionContext\(finalTask\) : null/);
  assert.match(mainSource.slice(end, end + 500), /ensureTaskBrain\(\)\.get/);
});

test("IPC result persistence does not rewrite TaskBrain success from response text", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const end = mainSource.indexOf('ipcMain.handle("product:query-task"', start);
  const handler = mainSource.slice(start, end);
  assert.doesNotMatch(handler, /brain\.complete\(/);
  assert.doesNotMatch(handler, /result\?\.success === true \|\| \["completed", "success"\]/);
  assert.match(handler, /const resolvedTaskId = String\(canonicalTaskId \|\| result\?\.taskId/);
});

test("pure conversations skip task timing watch and wait indefinitely for Hermes", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const promptStart = mainSource.indexOf("async function runHermesSessionPrompt");
  const promptEnd = mainSource.indexOf("async function sendWithHermes", promptStart);
  const promptRuntime = mainSource.slice(promptStart, promptEnd);
  assert.match(promptRuntime, /timeoutMs: 0/);
  assert.doesNotMatch(promptRuntime, /conversationOnly \? 1200000 : 600000/);

  const handlerStart = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const handlerEnd = mainSource.indexOf('ipcMain.handle("product:query-task"', handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /canonicalTaskId && !conversationOnlyRequest/);
});

test("task timing watch reports delay without timing out or aborting Black Ball", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function startTaskTimingWatch");
  const end = mainSource.indexOf("function ensureTaskBrain", start);
  const timingWatch = mainSource.slice(start, end);
  assert.match(timingWatch, /markDelayed/);
  assert.doesNotMatch(timingWatch, /markTimedOut|TASK_HARD_TIMEOUT|controller\?\.abort|hardTimer/);
});

test("product execution does not bypass HMS with a local Windows launcher", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function productLayerChatRuntime");
  const end = mainSource.indexOf("function bindUnderstandingToTaskDecision", start);
  const runtime = mainSource.slice(start, end);
  assert.doesNotMatch(runtime, /executeWindowsApplicationShortcut\(originalText/);
  assert.match(runtime, /runHermesSessionPromptWithRecovery\(/);
  assert.match(mainSource, /executeLaunchWindowsApplication: \(params = \{\}\) => launchWindowsApplication\(params\.application\)/);
});

test("terminal product responses return the current TaskBrain snapshot", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function submitProductWithTaskBrain");
  const end = mainSource.indexOf("function ensureProductExecutionRouter", start);
  const submit = mainSource.slice(start, end);
  assert.match(submit, /ensureTaskBrain\(\)\.complete\(task\.task_id,[\s\S]*taskBrain: ensureTaskBrain\(\)\.executionContext\(task\.task_id\)/);
  assert.doesNotMatch(submit, /finishProductConversation\(\{ \.\.\.result, taskBrain: taskContext \}\)/);
  assert.match(submit, /const resultTaskId = String\(result\?\.taskBrain\?\.task_id \|\| canonicalTaskId/);
  assert.match(submit, /ensureTaskBrain\(\)\.executionContext\(resultTaskId\)/);
  assert.match(submit, /if \(latestTaskBrain\) result = \{ \.\.\.result, taskBrain: latestTaskBrain \}/);
});

test("legacy pre-HMS web bridge cannot choose or execute tools", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.doesNotMatch(mainSource, /collectHermesWebToolEvidence/);
  assert.doesNotMatch(mainSource, /provider: "hermes-local-web-bridge"/);
});
