const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function assertOrdered(source, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle, cursor + 1);
    assert(index > cursor, `${label}: expected ${needle} after previous step`);
    cursor = index;
  }
}

function main() {
  const cases = [];
  const mainSource = read("main.js");
  const rendererSource = read(path.join("renderer", "app.js"));
  const stylesSource = read(path.join("renderer", "styles.css"));

  assert(mainSource.includes("function deterministicBasicReply"), "basic QA needs deterministic product answers");
  assert(mainSource.includes("type: \"identity\""), "identity questions should not depend on the model");
  assert(mainSource.includes("type: \"spreadsheet_ability\""), "spreadsheet ability questions need deterministic routing");
  assert(mainSource.includes("type: \"image_ability\""), "image ability questions need deterministic routing");
  cases.push("basic_qa_deterministic");

  assertOrdered(mainSource, [
    "async function productLayerConversationReply",
    "deterministicBasicReply(text",
    "answerMemoryQuestion(text)",
    "productLayerChatRuntime"
  ], "product layer route order");
  assertOrdered(mainSource, [
    'ipcMain.handle("chat:send"',
    "deterministicBasicReply(originalText",
    "answerMemoryQuestion(originalText)",
    "isSkillLearningRequest(originalText)"
  ], "legacy chat route order");
  cases.push("route_order_consistent");

  assert(mainSource.includes("spreadsheetAttachmentAnalysisReply(attachments)"), "spreadsheet attachment analysis should run before generic chat");
  assert(mainSource.includes("const visibleSheets = sheets.slice(0, 5)"), "spreadsheet output must be compact by default");
  assert(mainSource.includes("compactList(sheet.headers || [], 5)"), "spreadsheet output must not dump all fields");
  assert(!mainSource.includes("attachmentText(item).slice(0, 16000)"), "spreadsheet raw dump must stay disabled");
  cases.push("spreadsheet_compact_analysis");

  assert(mainSource.includes("function runCalculatorShortcut"), "calculator should have deterministic shortcut");
  assert(mainSource.includes('toolId: "calculator_creator"'), "calculator shortcut should use calculator_creator");
  assert(mainSource.includes('agentIntent: "dev.code.calculator"'), "calculator shortcut should keep correct tool intent");
  assert(!mainSource.includes("计算器生成失败：${execution.error"), "calculator failures must not stringify objects");
  cases.push("calculator_reliable_shortcut");

  assert(mainSource.includes("await learnProfessionalSkill"), "skill learning should create reusable professional skills");
  assert(mainSource.includes("saveCustomSkill(skill)"), "learned skills should persist as custom skills");
  assert(mainSource.includes("本次没有实际联网检索来源"), "online skill learning must not fake web sources");
  cases.push("skill_learning_truthful");

  assert(mainSource.includes("function sanitizeUserFacingReply"), "backend reply sanitizer should exist");
  assert(rendererSource.includes("function sanitizeVisibleReply"), "renderer reply sanitizer should exist");
  for (const forbidden of ["Tool Registry", "ToolSelector", "office.doc", "general.chat", "dev.code.calculator"]) {
    assert(new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(mainSource), `sanitizer should recognize ${forbidden}`);
  }
  cases.push("internal_error_sanitized");

  assert(rendererSource.includes("function buildTaskThinkingCard"), "task thinking card should exist");
  assert(rendererSource.includes("function submitMonitoredProductTask"), "shortcut tasks should create monitored product tasks");
  assert(rendererSource.includes("function startProductTaskMonitor"), "running product tasks should be polled");
  assert(!rendererSource.includes("[EXEC] waiting for tool result"), "fake monitor heartbeat should stay removed");
  cases.push("real_progress_experience");

  assert(rendererSource.includes("renderTable(lines)"), "markdown tables should render as tables");
  assert(rendererSource.includes('target="_blank"'), "markdown links should be clickable");
  assert(stylesSource.includes(".rendered .markdown-table-wrap"), "markdown table styling should exist");
  cases.push("markdown_rendering_ready");

  console.log(JSON.stringify({ ok: true, acceptanceScore: 100, cases }, null, 2));
}

main();
