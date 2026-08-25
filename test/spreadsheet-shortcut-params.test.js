"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadParser() {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function splitTableValues");
  const end = mainSource.indexOf("async function tryHandleSkillShortcutLegacy", start);
  assert.ok(start >= 0 && end > start, "spreadsheet parser must be present in main.js");
  return new Function("sanitizeText", `${mainSource.slice(start, end)}; return parseSpreadsheetSkillUse;`)(
    (value) => String(value || "").replace(/\s+/g, " ").trim()
  );
}

test("absolute Windows path is preserved for the xlsx target", () => {
  const parser = loadParser();
  const request = parser("生成 D:\\Codex验收\\会员数据.xlsx，包含姓名、手机号、状态三列和两行测试数据");
  assert.equal(request.action.path, "D:\\Codex验收\\会员数据.xlsx");
  assert.deepEqual(request.action.sheets[0].rows[0], ["姓名", "手机号", "状态"]);
});

test("bare filename is extracted instead of fixed sample", () => {
  const parser = loadParser();
  const request = parser("生成 会员数据.xlsx");
  assert.equal(request.action.path, "desktop/会员数据.xlsx");
  assert.ok(request.action.path.includes("会员数据.xlsx"));
});

test("headers and data from natural language are captured", () => {
  const parser = loadParser();
  const request = parser("做表格 文件名：报表2026.xlsx 表头是项目、数量、备注 数据是A、1、x；B、2、y");
  assert.equal(request.action.path, "desktop/报表2026.xlsx");
  assert.deepEqual(request.action.sheets[0].rows, [
    ["项目", "数量", "备注"],
    ["A", "1", "x"],
    ["B", "2", "y"]
  ]);
});

test("plain request without filename gets a dated default, not the fixed sample", () => {
  const parser = loadParser();
  const request = parser("随便做一个表格给我放桌面");
  assert.match(request.action.path, /^desktop\/白球表格-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test("docs destination keyword routes to documents folder", () => {
  const parser = loadParser();
  const request = parser("创建 Excel 表格放到文档 文件名：会员权限测试.xlsx");
  assert.equal(request.action.path, "documents/会员权限测试.xlsx");
});

test("forward-slash absolute path is preserved", () => {
  const parser = loadParser();
  const request = parser("生成 D:/Codex验收/报表.xlsx");
  assert.equal(request.action.path, "D:/Codex验收/报表.xlsx");
});

test("sentence punctuation is not written into the final spreadsheet cell", () => {
  const parser = loadParser();
  const request = parser("生成 D:\\Codex验收\\状态.xlsx，表头为项目、状态，数据为单独项目、通过。");
  assert.deepEqual(request.action.sheets[0].rows.slice(-1)[0], ["单独项目", "通过"]);
});
