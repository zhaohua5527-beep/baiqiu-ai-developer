"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const systemPromptSource = fs.readFileSync(path.join(root, "config", "system_prompt_v2.md"), "utf8");
const xlsxWriterSource = fs.readFileSync(path.join(root, "services", "hms-xlsx-writer.py"), "utf8");

test("project CEO requests enter HMS before local understanding and shortcuts", () => {
  const submitStart = mainSource.indexOf("async function submitProductWithTaskBrain");
  const projectEntry = mainSource.indexOf("const projectForHms", submitStart);
  const understanding = mainSource.indexOf("let conversationUnderstanding", submitStart);
  const spreadsheetShortcut = mainSource.indexOf("executeSpreadsheetDataAnalysis", submitStart);
  assert.ok(projectEntry > submitStart, "HMS project entry must exist in product submission");
  assert.ok(projectEntry < understanding, "HMS project entry must run before local understanding");
  assert.ok(projectEntry < spreadsheetShortcut, "HMS project entry must run before spreadsheet shortcuts");
  assert.match(mainSource.slice(projectEntry, understanding), /runHmsProjectCeoOrchestration/);
});

test("legacy project orchestration is isolated and has no production caller", () => {
  const legacyDefinitions = mainSource.match(/function runLegacyProjectCeoOrchestration/g) || [];
  const legacyReferences = mainSource.match(/runLegacyProjectCeoOrchestration/g) || [];
  assert.equal(legacyDefinitions.length, 1);
  assert.equal(legacyReferences.length, 1, "legacy orchestration must only remain as an isolated definition");
  assert.doesNotMatch(mainSource, /runProjectCeoOrchestration/);
});

test("TaskBrain receives HMS state projection without local assignments", () => {
  const runtimeStart = mainSource.indexOf("async function runHmsProjectCeoOrchestration");
  const runtimeEnd = mainSource.indexOf("function updateProjectAgent", runtimeStart);
  const runtimeSource = mainSource.slice(runtimeStart, runtimeEnd);
  assert.match(runtimeSource, /task_type:\s*"hms_project"/);
  assert.match(runtimeSource, /agent_assignments:\s*\[\]/);
  assert.match(runtimeSource, /delegation_mode:\s*"hms_native"/);
  assert.doesNotMatch(runtimeSource, /bindProjectTaskAssignments/);
  assert.doesNotMatch(runtimeSource, /runDirectHermesDelegation/);
  assert.match(runtimeSource, /legacyFallback:\s*false/);
});

test("all product results survive renderer reload without duplicate messages", () => {
  const ipcStart = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const ipcEnd = mainSource.indexOf('ipcMain.handle("product:query-task"', ipcStart);
  const ipcSource = mainSource.slice(ipcStart, ipcEnd);
  const sendStart = rendererSource.indexOf("async function sendCurrentTask");
  const sendEnd = rendererSource.indexOf("async function processQueue", sendStart);
  const sendSource = rendererSource.slice(sendStart, sendEnd);

  assert.match(mainSource, /function persistProductResult/);
  assert.match(mainSource, /product-result:\$\{stableResultKey\}/);
  assert.match(ipcSource, /finalResult[\s\S]*?persistProductResult/);
  assert.match(ipcSource, /failureResult[\s\S]*?persistProductResult/);
  assert.match(mainSource, /const runId = String\(result\.runId \|\| result\.projectRunId \|\| result\.traceId/);
  assert.match(sendSource, /productResult\?\.persistedByMain === true/);
  assert.match(sendSource, /productResult\.persistedSessionId === session\.id/);
  assert.match(sendSource, /persistAssistantResult\(\{ role: "assistant"/);
});

test("intent prediction is White Ball-owned and never opens a Black Ball session", () => {
  const routeStart = mainSource.indexOf("async function routeNonExecutionResponse");
  const routeEnd = mainSource.indexOf("function executionCapabilityFailureText", routeStart);
  const routeSource = mainSource.slice(routeStart, routeEnd);
  assert.doesNotMatch(routeSource, /intent-prediction:/);
  assert.match(routeSource, /prediction: understanding\?\.intentPrediction \|\| null/);
  assert.match(mainSource, /new IntentPredictionService\(\)/);
  assert.match(mainSource, /applyIntentPredictionDecision/);
  assert.match(mainSource, /HERMES_INTENT_CONTROL_LEAK/);
});

test("project Agent creation is a role template and UI says so", () => {
  const createStart = mainSource.indexOf("function createProjectAgent");
  const createEnd = mainSource.indexOf("function ensureAgentCapabilityContext", createStart);
  const createSource = mainSource.slice(createStart, createEnd);
  assert.match(createSource, /roleTemplate = true/);
  assert.match(createSource, /runtimeBinding = "hms-template"/);
  assert.match(rendererSource, /添加黑球岗位模板/);
  assert.match(rendererSource, /岗位模板/);
});

test("project progress and UI use the blackball display name", () => {
  assert.match(mainSource, /黑球项目 CEO 正在规划/);
  assert.doesNotMatch(mainSource, /HMS 项目 CEO 正在规划/);
  assert.doesNotMatch(rendererSource, /添加 HMS 岗位模板|HMS 规划时可参考/);
});

test("user-visible metadata and diagnostics use the blackball display name", () => {
  assert.doesNotMatch(mainSource, /\[HMS\]/);
  assert.doesNotMatch(systemPromptSource, /HMS/);
  assert.doesNotMatch(xlsxWriterSource, /Baiqiu HMS/);
  assert.match(xlsxWriterSource, /dc:creator>[^<]*\u9ed1\u7403/);
});
