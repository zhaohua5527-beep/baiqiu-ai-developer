"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 多表格分析修复：executeSpreadsheetDataAnalysis 必须遍历所有表格附件，
// 而不是只取第一个。否则用户发两个表一起分析时，第二个表被忽略，
// 回复"未找到对应列"的模板话（"莫名其妙的话"）。
test("spreadsheet data analysis iterates all table attachments", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("async function executeSpreadsheetDataAnalysis");
  assert.ok(fnStart >= 0, "function must exist");
  // 函数含逐 sheet 报告 + 条码交集 + 汇总表生成，体长 ~3200；切片需覆盖到 return
  const segment = mainSource.slice(fnStart, fnStart + 3400);
  // 必须遍历所有表格附件（filter），而不是只取第一个（find）
  assert.match(segment, /\.filter\(\(att\) =>/);
  assert.match(segment, /tableAttachments/);
  assert.ok(!segment.includes(".find((att) =>"), "must not use .find (first only)");
  // 遍历循环
  assert.match(segment, /for \(const tableAttachment of tableAttachments\)/);
  // 记录处理了多个表
  assert.match(segment, /tableCount/);
  assert.match(segment, /tableAttachments\.length/);
  // task-037 增强：逐工作表报告名+行数
  assert.match(segment, /extracted\.sheets \|\| \[\]/);
  // 跨附件条码交集统计
  assert.match(segment, /computeBarcodeIntersection/);
  // 用户指定汇总路径时生成真实汇总表
  assert.match(segment, /executeWriteXlsx/);
});

test("spreadsheet data analysis extracts a table without the wanted column gracefully", () => {
  // 验证 extractSpreadsheetColumns 对缺列的处理（不崩溃、返回未找到）
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("function extractSpreadsheetColumns");
  assert.ok(fnStart >= 0);
  const segment = mainSource.slice(fnStart, fnStart + 300);
  assert.match(segment, /function extractSpreadsheetColumns/);
});

test("conversation fallback leaves spreadsheet selection to HMS", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const anchor = mainSource.indexOf("!task && !conversationUnderstanding.shouldCreateTask");
  assert.ok(anchor >= 0, "conversation fallback branch must exist");
  const segment = mainSource.slice(anchor, anchor + 2400);
  assert.doesNotMatch(segment, /executeSpreadsheetDataAnalysis\(message, attachments/);
  assert.doesNotMatch(segment, /tryHandleSkillShortcut\(message, localContext\)/);
  assert.match(mainSource, /buildHmsToolProtocolPrompt\(hmsToolCatalog\)/);
});
