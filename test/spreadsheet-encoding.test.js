"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const XLSX = require("xlsx");
const {
  detectCsvEncoding,
  readSpreadsheetWorkbook
} = require("../services/spreadsheet-attachment-reader");
const { encodeCsvBuffer } = require("../services/csv-encoding");

const GBK_CSV = Buffer.from([
  0xc9, 0xcc, 0xc6, 0xb7, 0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0x75, 0x70, 0x63, 0x0a,
  0xb2, 0xe2, 0xca, 0xd4, 0xc9, 0xcc, 0xc6, 0xb7, 0x2c, 0x31, 0x32, 0x33, 0x0a
]);

function rowsFrom(buffer) {
  const { workbook, encoding } = readSpreadsheetWorkbook(XLSX, buffer, { name: "sales.csv", mimeType: "text/csv" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return { encoding, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) };
}

test("GBK CSV files are decoded before task-board and analysis parsing", () => {
  assert.equal(detectCsvEncoding(GBK_CSV), "gbk");
  assert.deepEqual(rowsFrom(GBK_CSV), {
    encoding: "gbk",
    rows: [["商品名称", "upc"], ["测试商品", 123]]
  });
});

test("UTF-8 CSV files retain their original encoding", () => {
  const csv = Buffer.from("商品名称,upc\n测试商品,123\n", "utf8");
  assert.equal(detectCsvEncoding(csv), "utf-8");
  assert.deepEqual(rowsFrom(csv), {
    encoding: "utf-8",
    rows: [["商品名称", "upc"], ["测试商品", 123]]
  });
});

test("GBK CSV writes back as GBK bytes after a round trip", () => {
  // 模拟完整链路：GBK 读入 → xlsx 输出 UTF-8（带 BOM）→ 转回 GBK
  const { workbook } = readSpreadsheetWorkbook(XLSX, GBK_CSV, { name: "sales.csv", mimeType: "text/csv" });
  const utf8Out = XLSX.write(workbook, { type: "buffer", bookType: "csv" });
  const gbkOut = encodeCsvBuffer(utf8Out, "gbk");
  assert.equal(detectCsvEncoding(gbkOut), "gbk", "write-back should be GBK again");
  // 内容 round-trip：GBK 输出再被 reader 读回，中文不乱码
  const { rows } = rowsFrom(gbkOut);
  assert.deepEqual(rows, [["商品名称", "upc"], ["测试商品", 123]]);
});

test("UTF-8 CSV write-back stays UTF-8 and readable", () => {
  const workbook = XLSX.read(Buffer.from("商品名称,upc\n测试商品,123\n", "utf8"), { type: "buffer", cellDates: true, codepage: 65001 });
  const utf8Out = XLSX.write(workbook, { type: "buffer", bookType: "csv" });
  assert.equal(detectCsvEncoding(utf8Out), "utf-8");
  const { rows } = rowsFrom(utf8Out);
  assert.deepEqual(rows, [["商品名称", "upc"], ["测试商品", 123]]);
});
