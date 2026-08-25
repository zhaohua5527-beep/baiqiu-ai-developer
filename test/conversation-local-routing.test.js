"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// HMS 是工具选择的唯一入口；对话误分类不能重新启用本地快捷判断。

test("conversation fallback does not bypass HMS with local tool shortcuts", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  // 找到对话降级路径（!task && !shouldCreateTask）
  const anchor = mainSource.indexOf("!task && !conversationUnderstanding.shouldCreateTask");
  assert.ok(anchor >= 0, "conversation fallback branch must exist");
  const segment = mainSource.slice(anchor, anchor + 4500);
  assert.doesNotMatch(segment, /tryHandleDirectToolCommand\(message, localContext\)/);
  assert.doesNotMatch(segment, /tryHandleSkillShortcut\(message, localContext\)/);
  assert.doesNotMatch(segment, /executeSpreadsheetDataAnalysis\(message, attachments/);
  assert.match(segment, /routeNonExecutionResponse/);
});

test("conversation HMS route uses signal from active run", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const anchor = mainSource.indexOf("!task && !conversationUnderstanding.shouldCreateTask");
  const segment = mainSource.slice(anchor, anchor + 2600);
  assert.match(segment, /signal: activeRuns\.get\(sessionId\)\?\.controller\?\.signal/);
  assert.match(segment, /routeNonExecutionResponse/);
});

test("tool-requiring requests override analyze-only before the fallback branch", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function routeHmsToolRequest");
  const end = mainSource.indexOf("function browserAutomationPrompt", start);
  const route = new Function(
    "requestNeedsHmsToolDecision",
    `${mainSource.slice(start, end)}; return routeHmsToolRequest;`
  )(() => true);
  const routed = route({ shouldCreateTask: false, responseMode: "analyze_only", context: {} }, "生成表格", "session-1");
  assert.equal(routed.shouldCreateTask, true);
  assert.equal(routed.responseMode, "execute");
  assert.equal(routed.route, "task_brain");
  assert.equal(routed.context.hmsToolDecisionRequired, true);

  const apply = mainSource.indexOf("conversationUnderstanding = routeHmsToolRequest", mainSource.indexOf("async function submitProductWithTaskBrain"));
  const fallback = mainSource.indexOf("!task && !conversationUnderstanding.shouldCreateTask", apply);
  assert.ok(apply >= 0 && fallback > apply, "HMS tool routing must run before non-execution fallback");
});

test("bound table helpers remain available without preempting Black Ball", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function referencedTableOrdinals");
  const end = mainSource.indexOf("function requestNeedsHmsToolDecision", start);
  const helpers = new Function(
    "sanitizeText",
    `${mainSource.slice(start, end)}; return { referencedTableOrdinals, referencesBoundAttachmentOperation };`
  )((value) => String(value || ""));

  assert.deepEqual(helpers.referencedTableOrdinals("请把表3剔除后填入表4"), [3, 4]);
  assert.equal(helpers.referencesBoundAttachmentOperation("请把0曝光0下单的商品剔除表3，填入表4"), true);
  assert.equal(helpers.referencesBoundAttachmentOperation("表3和表4分别是什么？"), false);

  const handlerStart = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const handler = mainSource.slice(handlerStart, handlerStart + 8500);
  assert.doesNotMatch(handler, /requestsAttachmentRecovery\(message\) \|\| boundAttachmentOperation/);
  assert.doesNotMatch(handler, /boundAttachmentOperation \? Math\.max\(1, \.\.\.referencedOrdinals\) : 1/);
  assert.match(mainSource, /blackBallOwnedUnderstanding/);
});
