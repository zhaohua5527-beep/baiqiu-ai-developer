"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildHmsToolCatalog,
  buildHmsToolProtocolPrompt,
  selectHmsProtocolActions,
  hmsToolResultEnvelope,
  successfulToolDelivery,
  successfulToolCompletionText
} = require("../services/hms-tool-protocol");

const tools = [
  {
    id: "write_xlsx",
    name: "生成表格",
    description: "创建真实 XLSX 文件",
    permission: { level: "filesystem.write" },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "rows"],
            properties: {
              name: { type: "string" },
              rows: { type: "array", items: { type: "array", items: {} } }
            }
          }
        }
      },
      required: ["path", "sheets"]
    }
  },
  { id: "disabled_tool", enabled: false, parameters: {} }
];

const desktopTools = require("../tools/desktop-actions").createTools();

test("HMS catalog contains only exposed tools with compact schemas", () => {
  const catalog = buildHmsToolCatalog(tools);
  assert.deepEqual(catalog.map((tool) => tool.id), ["write_xlsx"]);
  assert.deepEqual(catalog[0].parameters.required, ["path", "sheets"]);
  assert.equal(catalog[0].parameters.properties.sheets.items.type, "object");
  assert.deepEqual(catalog[0].parameters.properties.sheets.items.required, ["name", "rows"]);
  assert.equal(catalog[0].parameters.properties.sheets.items.properties.rows.items.type, "array");
  const prompt = buildHmsToolProtocolPrompt(catalog);
  assert.match(prompt, /黑球 -> 白球可选能力桥/);
  assert.match(prompt, /write_xlsx/);
  assert.match(prompt, /native terminal, file, browser, web/);
  assert.match(prompt, /Capability availability is evaluated for every request/);
  assert.match(prompt, /Never tell the user to create a new conversation to obtain tools/);
  assert.match(prompt, /不得原生执行后再通过白球重复执行/);
  assert.doesNotMatch(prompt, /MANDATORY CONTROLLED|never use Hermes native Python|intentionally denied/);
});

test("HMS exposes Black Ball owned real desktop controls with verification-oriented guidance", () => {
  const catalog = buildHmsToolCatalog(desktopTools);
  assert.deepEqual(catalog.map((tool) => tool.id), ["desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]);
  const prompt = buildHmsToolProtocolPrompt(catalog);
  assert.match(prompt, /desktop_click, desktop_type, desktop_key, and desktop_scroll/);
  assert.match(prompt, /Hermes owns external actions; Baiqiu only maps their result/);
  assert.equal(catalog.find((tool) => tool.id === "desktop_click")?.parameters.required.includes("x"), true);
});

test("main HMS prompt keeps the isolated Hermes home without a duplicate native tool gate", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(source, /hermesHome: baiqiuDataRoot\("runtime", "hermes-home"\)/);
  assert.match(source, /new HermesConfigService\(\{ hermesHome \}\)/);
  assert.match(source, /new HermesMemoryService\(\{ hermesHome, agentRoot, pythonPath \}\)/);
  assert.doesNotMatch(source, /assertNoHmsNativeOverlap|shouldBlockHmsNativeToolCall|HMS_NATIVE_TOOL_BYPASS/);
});

test("HMS protocol accepts one allowlisted action and rejects other calls", () => {
  const catalog = buildHmsToolCatalog(tools);
  const selected = selectHmsProtocolActions([
    { type: "write_xlsx", path: "desktop/report.xlsx", sheets: [] },
    { type: "system_shutdown" }
  ], catalog);
  assert.equal(selected.accepted.length, 1);
  assert.equal(selected.accepted[0].type, "write_xlsx");
  assert.deepEqual(selected.rejected, [{ toolId: "system_shutdown", reason: "tool_not_exposed" }]);
});

test("successful tool evidence can close a task when the final model turn fails", () => {
  const envelope = hmsToolResultEnvelope([{
    type: "write_xlsx",
    response: {
      success: true,
      result: { path: "C:\\Users\\Lenovo\\Desktop\\report.xlsx", apiKey: "secret" },
      evidence: [{ type: "file", exists: true }],
      duration: 42
    }
  }], [], { taskId: "task-1", sessionId: "session-1" });
  assert.equal(envelope.taskId, "task-1");
  assert.equal(envelope.sessionId, "session-1");
  assert.equal(envelope.results[0].success, true);
  assert.equal(envelope.results[0].result.apiKey, "***");
  assert.doesNotMatch(successfulToolCompletionText(envelope), /write_xlsx|\{"path"|apiKey/);
  assert.match(successfulToolCompletionText(envelope), /report\.xlsx/);
  assert.deepEqual(successfulToolDelivery(envelope).files.map((file) => file.path), ["C:\\Users\\Lenovo\\Desktop\\report.xlsx"]);
});

test("nested file creator evidence produces concise delivery without raw JSON", () => {
  const envelope = {
    results: [{
      toolId: "file_creator",
      success: true,
      result: {
        success: true,
        output: { files: [{ file: "C:\\Users\\Lenovo\\Desktop\\margin.xlsx", size: 1869 }] },
        verification: { allExist: true }
      }
    }]
  };
  const delivery = successfulToolDelivery(envelope);
  assert.match(delivery.text, /margin\.xlsx/);
  assert.doesNotMatch(delivery.text, /file_creator|success|verification|\{|\}/i);
  assert.equal(delivery.files[0].path, "C:\\Users\\Lenovo\\Desktop\\margin.xlsx");
});

test("main keeps recent task context and never exposes tool JSON as the final fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(source, /\(!conversationOnly \|\| freshForegroundSession\)[\s\S]{0,80}boundedVisibleConversationContext/);
  assert.match(source, /requested granularity, and rejected approaches/);
  assert.match(source, /files: delivery\.files/);
  assert.match(source, /function mergePermanentHmsAnswer/);
  assert.match(source, /answerEnvelopeOnly: true/);
  assert.match(source, /finalText\.slice\(streamedText\.length\)/);
  assert.doesNotMatch(source, /text:\s*JSON\.stringify\(envelope\)/);
});
