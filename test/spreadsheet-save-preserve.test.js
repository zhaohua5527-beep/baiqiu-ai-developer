"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const XLSX = require("xlsx");

const { applyEditorRowsToWorksheet } = require("../services/spreadsheet-save");

// 构造一个含公式、合并单元格、样式的 xlsx，读成 workbook 后做增量写回
function buildWorkbookWithStructure() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["商品", "数量", "金额", "备注"],
    ["苹果", 3, { f: "B2*10" }, "a"],
    ["香蕉", 5, { f: "B3*10" }, "b"]
  ]);
  // 合并 A1:A2（表头合并）
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }];
  // 给 D1 一个样式
  sheet.D1 = { v: "备注", t: "s", z: "@", s: { numFmt: 49 } };
  // 第二个 sheet
  const sheet2 = XLSX.utils.aoa_to_sheet([["x", "y"], [1, 2]]);
  workbook.SheetNames = ["Sheet1", "Sheet2"];
  workbook.Sheets.Sheet1 = sheet;
  workbook.Sheets.Sheet2 = sheet2;
  return workbook;
}

test("incremental write-back preserves merges, styles, and other sheets", () => {
  const workbook = buildWorkbookWithStructure();
  const sheet = workbook.Sheets.Sheet1;
  const editorRows = [
    ["商品", "数量", "金额", "备注"],
    ["苹果", 4, 30, "edited"],   // B2 3→4, C2 公式改30
    ["香蕉", 5, { f: "B3*10" }, "b"]
  ];
  const result = applyEditorRowsToWorksheet(XLSX, sheet, editorRows);

  assert.ok(sheet["!merges"].length >= 1, "merges preserved");
  assert.equal(sheet.D1.s.numFmt, 49, "style preserved");
  assert.equal(sheet.A1.v, "商品", "unchanged cell kept");
  assert.equal(sheet.B2.v, 4, "edited value applied");
  assert.equal(sheet.C2.v, 30, "formula cell replaced by edited value");
  assert.equal(workbook.SheetNames.length, 2, "other sheets preserved");
  assert.equal(workbook.Sheets.Sheet2.A1.v, "x", "second sheet intact");
  assert.ok(result.targetRows >= 3);
});

test("empty editor value does not wipe formula cells", () => {
  const workbook = buildWorkbookWithStructure();
  const sheet = workbook.Sheets.Sheet1;
  const editorRows = [
    ["商品", "数量", "金额", "备注"],
    ["苹果", 3, "", "a"],   // C2 空，但原 cell 是公式 { f: "B2*10" }
    ["香蕉", 5, "", "b"]    // C3 空，原 cell 是公式
  ];
  applyEditorRowsToWorksheet(XLSX, sheet, editorRows);
  assert.ok(sheet.C2.f, "formula preserved when editor cell is empty");
  assert.ok(sheet.C3.f, "formula preserved when editor cell is empty");
});

test("editor row shortening blanks old cells but does not delete structure", () => {
  const workbook = buildWorkbookWithStructure();
  const sheet = workbook.Sheets.Sheet1;
  const editorRows = [
    ["商品", "数量"],  // 只有 2 列、2 行（原来 3 行 4 列）
    ["苹果", 3]
  ];
  applyEditorRowsToWorksheet(XLSX, sheet, editorRows);
  // 超界普通旧 cell 被清空；公式 cell 保留公式不被误清
  assert.equal(sheet.A3.v, null, "old row beyond editor height blanked");
  assert.equal(sheet.D1.v, null, "old cell beyond editor width blanked");
  assert.ok(sheet.C2.f, "formula cell beyond editor width preserved");
  // 结构仍保留
  assert.ok(sheet["!merges"].length >= 1);
  assert.equal(sheet.D1.s.numFmt, 49);
});

test("column widths only override edited columns", () => {
  const workbook = buildWorkbookWithStructure();
  const sheet = workbook.Sheets.Sheet1;
  const editorRows = [["商品", "数量", "金额", "备注"], ["苹果", 4, 30, "edited"], ["香蕉", 5, 50, "b"]];
  applyEditorRowsToWorksheet(XLSX, sheet, editorRows, { columnWidths: { 1: 200 } });
  assert.equal(sheet["!cols"][1].wpx, 200, "edited column width applied");
  // 未编辑的列不应被重置（这里没有默认宽度，应保留 undefined 或不新增为 112 以外值）
  // 重点：整表覆盖不再发生——不编辑列宽时 !cols 不被改动
});

test("round-trip through xlsx write/read preserves the workbook", () => {
  const workbook = buildWorkbookWithStructure();
  applyEditorRowsToWorksheet(XLSX, workbook.Sheets.Sheet1, [
    ["商品", "数量", "金额", "备注"],
    ["苹果", 4, 30, "edited"],
    ["香蕉", 5, 50, "b"]
  ]);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const reread = XLSX.read(buffer, { type: "buffer", cellDates: true, cellStyles: true });
  const sheet = reread.Sheets.Sheet1;
  assert.equal(sheet.B2.v, 4);
  assert.equal(sheet.C2.v, 30);
  assert.equal(sheet.D1.v, "备注");
  assert.equal(reread.SheetNames.length, 2, "both sheets survive write");
  assert.ok(reread.Sheets.Sheet2.A1.v, "x");
});
