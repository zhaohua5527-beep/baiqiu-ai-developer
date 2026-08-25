"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const XLSX = require("xlsx");
const { normalizeXlsxSheets, verifyWrittenXlsx } = require("../services/xlsx-write-contract");

test("normalizes the rc.37 single sheet compatibility shape", () => {
  const sheets = normalizeXlsxSheets({
    sheets: ["验收"],
    rows: [["项目", "状态"], ["任务状态同步", "通过"]]
  });
  assert.deepEqual(sheets, [{
    name: "验收",
    rows: [["项目", "状态"], ["任务状态同步", "通过"]]
  }]);
});

test("rejects malformed or blank workbook input", () => {
  assert.throws(() => normalizeXlsxSheets({ sheets: ["A", "B"], rows: [[1]] }), { code: "INVALID_XLSX_INPUT" });
  assert.throws(() => normalizeXlsxSheets({ sheets: [{ name: "A", rows: [] }] }), { code: "INVALID_XLSX_INPUT" });
  assert.throws(() => normalizeXlsxSheets({ rows: [[null, ""]] }), { code: "INVALID_XLSX_INPUT" });
});

test("reopens a written workbook and verifies names, range, and cell values", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-xlsx-contract-"));
  const file = path.join(directory, "report.xlsx");
  const sheets = normalizeXlsxSheets({
    sheets: [{ name: "验收", rows: [["项目", "状态"], ["HMS工具调用", "通过"]] }]
  });
  try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheets[0].rows), sheets[0].name);
    XLSX.writeFile(workbook, file);
    assert.deepEqual(verifyWrittenXlsx(XLSX, file, sheets), { sheetNames: ["验收"], verifiedCells: 4 });

    const damaged = XLSX.readFile(file);
    damaged.Sheets["验收"].B2.v = "失败";
    XLSX.writeFile(damaged, file);
    assert.throws(() => verifyWrittenXlsx(XLSX, file, sheets), { code: "XLSX_VERIFICATION_FAILED" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
