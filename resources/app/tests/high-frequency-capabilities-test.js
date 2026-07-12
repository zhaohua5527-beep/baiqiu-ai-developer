const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskExperience } = require("../services/product-sdk/task-experience");
const SpreadsheetAgent = require("../services/spreadsheet-agent");
const FileAnalysis = require("../services/file-analysis");

function main() {
  const cases = [];

  {
    const task = {
      taskId: "hf-task-1",
      productName: "desktop-assistant",
      message: "分析这个表格"
    };
    const created = TaskExperience.create(task, "received");
    const running = TaskExperience.advance({ ...task, experience: created }, "executing");
    assert.equal(created.message, "已接收");
    assert.equal(running.message, "正在执行");
    assert(!/[锛�姝宸]/.test(JSON.stringify(running)), "task experience should not contain mojibake");
    cases.push("task_experience_chinese_stage_labels");
  }

  {
    const fakeXlsx = {
      read: () => ({
        SheetNames: ["销售"],
        Sheets: { "销售": {} }
      }),
      utils: {
        sheet_to_json: () => [
          ["商品", "销售额", "数量"],
          ["A", 120, 2],
          ["B", 80, 1],
          ["A", 60, 1]
        ]
      }
    };
    const analysis = SpreadsheetAgent.analyzeWorkbook(fakeXlsx, Buffer.from("fake"), { name: "销售表.xlsx" });
    const text = SpreadsheetAgent.formatWorkbookAnalysis(analysis);
    assert(text.includes("工作表数量：1"));
    assert(text.includes("字段摘要："));
    assert(text.includes("销售额"));
    assert(!/[锛�姝宸]/.test(text), "spreadsheet summary should not contain mojibake");
    cases.push("spreadsheet_structured_summary_chinese");
  }

  {
    const refs = FileAnalysis.extractFileReferences("帮我分析 销售表.xlsx，再看看 图片.png");
    assert(refs.includes("销售表.xlsx"));
    assert(refs.includes("图片.png"));
    assert.equal(FileAnalysis.isAnalysisIntent("分析这个表格"), true);
    assert.equal(FileAnalysis.isContinuationIntent("继续分析"), true);
    cases.push("file_analysis_reference_and_intent");
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-file-analysis-"));
    const file = path.join(dir, "复盘数据.csv");
    fs.writeFileSync(file, "商品,金额\nA,10\nB,20\n", "utf8");
    const prepared = FileAnalysis.prepareAnalysisContext({
      message: "继续分析",
      lastTarget: { path: file, name: "复盘数据.csv", mimeType: "text/csv", ext: ".csv" },
      searchRoots: [dir]
    });
    assert.equal(prepared.usedLastTarget, true);
    assert.equal(prepared.attachments.length, 1);
    assert(prepared.message.includes("继续基于上一份文件/图片"));
    assert(prepared.attachments[0].textContent.includes("商品,金额"));
    cases.push("file_analysis_continuation_uses_last_target");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes('if (id === "openclaw") return true;'), "openclaw image gateway should not be blocked by local image guard");
    assert(mainSource.includes("image_url"), "vision-capable providers should receive OpenAI image_url content");
    assert(/qwen\.\*vl|qwen-vl|glm-4v|llava|pixtral/.test(mainSource), "vision model detection should include common multimodal models");
    assert(/\\u4e0d\\u8981\\u5047\\u88c5|不要假装/.test(mainSource), "unsupported image reply must not pretend to inspect images");
    cases.push("image_vision_routing_and_degradation_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function spreadsheetAttachmentAnalysisReply"), "spreadsheet attachments need a deterministic local analysis reply");
    assert(mainSource.includes("spreadsheetAttachmentAnalysisReply(attachments)"), "spreadsheet analysis must run before generic model routing");
    assert(mainSource.includes("spreadsheetParseError"), "spreadsheet parse errors should be reported instead of crashing or blaming permissions");
    assert(!mainSource.includes("无法直接读取上传的 xlsx 附件内容"), "runtime must not claim uploaded xlsx cannot be read when local parser exists");
    cases.push("spreadsheet_attachment_local_analysis_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function isSpreadsheetAbilityQuestion"), "spreadsheet ability questions should be detected before model routing");
    assert(mainSource.includes("function spreadsheetAbilityReply"), "spreadsheet ability questions need deterministic replies");
    assert(mainSource.includes("可以，我能分析 Excel / CSV 表格"), "spreadsheet ability reply should clearly say Excel/CSV can be analyzed");
    assert(mainSource.includes("不会在没读到图片内容时假装已经看过"), "image ability reply should avoid fake vision claims");
    assert(mainSource.includes("function isImageAbilityQuestion"), "image ability questions should be detected before model routing");
    assert(mainSource.includes("function imageAbilityReply"), "image ability questions need deterministic replies");
    cases.push("deterministic_file_ability_replies_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const replyStart = mainSource.indexOf("async function productLayerConversationReply");
    const identityIndex = mainSource.indexOf("你叫什么", replyStart);
    const capabilityIndex = mainSource.indexOf("isCapabilityListQuestion(text)", replyStart);
    const memoryIndex = mainSource.indexOf("answerMemoryQuestion(text)", replyStart);
    const runtimeIndex = mainSource.indexOf("productLayerChatRuntime", replyStart);
    assert(replyStart >= 0 && identityIndex > replyStart, "conversation reply should have deterministic identity handling");
    assert(capabilityIndex > replyStart, "conversation reply should have deterministic capability handling");
    assert(memoryIndex > identityIndex, "identity questions must not be intercepted by memory/context");
    assert(memoryIndex > capabilityIndex, "capability questions must not be intercepted by memory/context");
    assert(runtimeIndex > memoryIndex, "model runtime should remain the final fallback");
    cases.push("deterministic_basic_qa_route_order_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const chatStart = mainSource.indexOf('ipcMain.handle("chat:send"');
    const deterministicIndex = mainSource.indexOf("deterministicBasicReply(originalText", chatStart);
    const memoryIndex = mainSource.indexOf("answerMemoryQuestion(originalText)", chatStart);
    const skillIndex = mainSource.indexOf("isSkillLearningRequest(originalText)", chatStart);
    assert(chatStart >= 0 && deterministicIndex > chatStart, "legacy chat chain should use deterministic basic QA");
    assert(memoryIndex > deterministicIndex, "legacy chat memory should not intercept basic QA");
    assert(skillIndex > deterministicIndex, "legacy chat skill handling should remain after deterministic list/capability handling");
    assert(mainSource.includes("sanitizeUserFacingReply(deterministicReply.text)"), "legacy deterministic replies should be sanitized");
    cases.push("legacy_chat_deterministic_qa_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function summarizeSpreadsheetForUser"), "spreadsheet replies should have a compact user-facing summary");
    assert(mainSource.includes("summarizeSpreadsheetForUser(item.spreadsheetAnalysis)"), "spreadsheet runtime should show compact analysis instead of raw parser text");
    assert(!mainSource.includes("attachmentText(item).slice(0, 16000)"), "spreadsheet runtime must not dump long raw analysis into chat");
    assert(mainSource.includes("const visibleSheets = sheets.slice(0, 5)"), "spreadsheet chat summary should only show a few sheets by default");
    assert(mainSource.includes("compactList(sheet.headers || [], 5)"), "spreadsheet chat summary should limit displayed fields");
    assert(mainSource.includes("这是较大的工作簿，默认只展示摘要"), "large workbook replies should explain compact mode");
    cases.push("spreadsheet_reply_compact_summary_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert(mainSource.includes("function runCalculatorShortcut"), "calculator requests need a deterministic product runtime shortcut");
    assert(mainSource.includes('toolId: "calculator_creator"'), "calculator shortcut must use calculator_creator");
    assert(mainSource.includes('agentIntent: "dev.code.calculator"'), "calculator shortcut must keep the correct ToolSelector intent");
    assert(rendererSource.includes("function isCalculatorCreationPrompt"), "UI should route calculator creation before the long generic task path");
    assert(rendererSource.includes("正在生成计算器"), "UI should show immediate calculator progress");
    cases.push("calculator_shortcut_product_runtime_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function readableToolError"), "tool error objects should be formatted for users");
    assert(mainSource.includes("计算器生成失败：${errorText}"), "calculator shortcut should not stringify raw error objects");
    assert(!mainSource.includes("计算器生成失败：${execution.error"), "calculator shortcut must not produce [object Object]");
    cases.push("calculator_error_object_format_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function effectiveLicenseUnlocked"), "permission layer should use effective license state");
    assert(mainSource.includes("if (isDevMode) return true;"), "developer activated UI state must unlock write permissions");
    assert(mainSource.includes("isUnlocked: effectiveLicenseUnlocked(db)"), "ToolRegistry PermissionManager must sync with effective activation state");
    assert(!mainSource.includes("isUnlocked: Boolean(db.settings?.license?.unlocked)"), "permission sync must not rely only on stale db.settings.license.unlocked");
    cases.push("license_permission_sync_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("function isOnlineSkillLearningRequest"), "online skill request detection should be explicit");
    assert(mainSource.includes("function extractSkillSourceFromMessage"), "skill learning should extract URL or topic source");
    assert(mainSource.includes("function extractRequestedSkillTopic"), "skill learning should extract a usable skill topic");
    assert(mainSource.includes("await learnProfessionalSkill"), "generic skill learning should create a reusable self-learning skill");
    assert(mainSource.includes("buildLearnedSkill({"), "skill learning should generate a structured skill document");
    assert(mainSource.includes("saveCustomSkill(skill)"), "learned skill should be persisted as a custom skill file");
    cases.push("professional_skill_learning_guard");
  }

  {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    const productSubmitBlocks = rendererSource.match(/return api\.productSubmitTask\(\{[\s\S]*?\n  \}\);/g) || [];
    const runtimeBlocks = productSubmitBlocks.filter((block) => /desktop\.chat_runtime|desktop\.chat/.test(block));
    assert(runtimeBlocks.length >= 2, "chat runtime submit helpers should be present");
    for (const block of runtimeBlocks) {
      assert(block.includes("skipPersist: true"), "UI-owned chat runtime persistence must avoid duplicate messages");
    }
    cases.push("chat_runtime_skip_persist_duplicate_guard");
  }

  {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    const stylesSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");
    assert(rendererSource.includes("function renderMarkdown"), "renderer should keep markdown renderer");
    assert(rendererSource.includes("renderTable(lines)"), "markdown tables should render as HTML tables");
    assert(rendererSource.includes("<ol>"), "numbered markdown lists should render as ordered lists");
    assert(rendererSource.includes("<blockquote>"), "markdown blockquotes should render");
    assert(rendererSource.includes('target="_blank"'), "markdown links should be clickable");
    assert(stylesSource.includes(".rendered .markdown-table-wrap"), "markdown tables need stable chat styling");
    cases.push("markdown_rendering_table_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert(mainSource.includes("function sanitizeUserFacingReply"), "backend replies need a user-visible sanitizer");
    assert(rendererSource.includes("function sanitizeVisibleReply"), "renderer needs a final user-visible sanitizer");
    assert(mainSource.includes("ToolSelector|Intent\\s*Lock|intent\\s*mismatch"), "sanitizer should catch internal routing terms");
    assert(mainSource.includes("任务返回了异常对象"), "sanitizer should suppress [object Object]");
    assert(rendererSource.includes("任务返回了异常对象"), "renderer should suppress [object Object]");
    cases.push("user_visible_reply_sanitizer_guard");
  }

  {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(mainSource.includes("onlineRequested"), "online skill requests should be handled explicitly");
    assert(mainSource.includes("本次没有实际联网检索来源"), "online skill learning must not claim web learning without sources");
    assert(mainSource.includes("技能已登记为本地技能档案"), "generic skill learning should describe recorded local capability");
    cases.push("skill_learning_truthfulness_guard");
  }

  {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert(rendererSource.includes("function buildTaskThinkingCard"), "task requests should show a concise thinking card");
    assert(rendererSource.includes("我理解为"), "thinking card should explain interpreted goal");
    assert(rendererSource.includes("执行方式"), "thinking card should explain execution approach");
    assert(rendererSource.includes("function persistTaskExchange"), "user, thinking card, and result should persist together");
    assert(rendererSource.includes("pushMonitorEvent(\"STEP\""), "progress log should be driven by real stage changes");
    assert(!rendererSource.includes("[EXEC] waiting for tool result"), "monitor should not use fake execution heartbeat logs");
    assert(!rendererSource.includes("[PLAN] build execution steps"), "monitor should not simulate planning logs");
    cases.push("real_progress_and_thinking_card_guard");
  }

  {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert(rendererSource.includes("function startProductTaskMonitor"), "long product tasks should be monitored while running");
    assert(rendererSource.includes("api.productQueryTask(taskId)"), "task monitor should poll Product SDK task state");
    assert(rendererSource.includes("updateProductTaskProgress(task"), "task monitor should update UI progress from task experience");
    assert(rendererSource.includes("const stopTaskMonitor = startProductTaskMonitor"), "submit flow should start runtime task monitoring");
    assert(rendererSource.includes("stopTaskMonitor();"), "submit flow should stop task monitoring after completion");
    cases.push("product_task_runtime_monitor_guard");
  }

  {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert(rendererSource.includes("async function submitMonitoredProductTask"), "shortcut paths need a shared monitored submit helper");
    assert(rendererSource.includes("createdTask = await api.productCreateTask(base)"), "monitored submit should create a Product SDK task before execution");
    assert(rendererSource.includes("templateId: \"desktop.chat_runtime\""), "skill and attachment runtime paths should remain Product SDK runtime tasks");
    assert(rendererSource.includes("skillLearning: true"), "skill learning path should use monitored Product SDK runtime");
    assert(rendererSource.includes("hasAttachments: true"), "attachment analysis path should use monitored Product SDK runtime");
    assert(rendererSource.includes("conversationOnly: true"), "calculator and chat shortcut paths should use monitored Product SDK conversation tasks");
    cases.push("shortcut_paths_monitored_task_guard");
  }

  console.log(JSON.stringify({ ok: true, cases }, null, 2));
}

main();
