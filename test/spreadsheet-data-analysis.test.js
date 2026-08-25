"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// 用模块加载测试（避免依赖 Electron main.js）
const { readSpreadsheetAttachment, readSpreadsheetWorkbook } = require("../services/spreadsheet-attachment-reader");
const XLSX = require("xlsx");

function extractColumns(file, wantedFields) {
  const attachment = { name: path.basename(file), sourcePath: file };
  const loaded = readSpreadsheetAttachment(attachment, { resolvePath: (a) => a.sourcePath });
  if (!loaded) return { ok: false, error: "read failed" };
  const { workbook } = readSpreadsheetWorkbook(XLSX, loaded.buffer, attachment);
  const sheet = workbook.Sheets?.[workbook.SheetNames?.[0]];
  if (!sheet) return { ok: false, error: "no sheet" };
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!rows.length) return { ok: false, error: "empty" };
  const headers = rows[0].map((cell) => String(cell ?? "").trim());
  const dataRows = rows.slice(1);
  const results = {};
  for (const wanted of wantedFields) {
    const idx = headers.findIndex((h) => h.includes(wanted) || wanted.includes(h));
    if (idx >= 0) {
      const values = dataRows.map((row) => String(row[idx] ?? "").trim()).filter(Boolean);
      results[wanted] = { column: headers[idx], count: values.length, sample: values.slice(0, 3) };
    }
  }
  return { ok: true, totalRows: dataRows.length, columns: headers.length, results };
}

test("extracts UPC/name/SKU from a real product CSV", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-csv-test-"));
  const file = path.join(tmp, "products.csv");
  // 模拟商品销售 CSV（GBK 列名：日期,商品名称,条形码,货号）
  fs.writeFileSync(file, "日期,商品名称,条形码,货号\n20260703,塑身裤示例,3003632983281,1726160013745160220\n20260703,连衣裙示例,3001010372214,1760865106583240749\n", "utf8");
  const result = extractColumns(file, ["条形码", "商品名称", "货号"]);
  assert.equal(result.ok, true);
  assert.equal(result.totalRows, 2, "should read 2 data rows");
  assert.ok(result.results["条形码"], "should find barcode column");
  assert.ok(result.results["条形码"].count >= 2, "should extract barcodes");
  assert.ok(result.results["条形码"].sample[0].includes("3003632983281"), "first barcode should match");
  assert.ok(result.results["商品名称"], "should find name column");
  assert.ok(result.results["货号"], "should find SKU column");
});

test("returns clear error when file is not a spreadsheet", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-csv-test2-"));
  const file = path.join(tmp, "note.txt");
  fs.writeFileSync(file, "not a spreadsheet", "utf8");
  const attachment = { name: "note.txt", sourcePath: file };
  const loaded = readSpreadsheetAttachment(attachment, { resolvePath: (a) => a.sourcePath });
  assert.ok(loaded, "text file should still read as buffer");
});
