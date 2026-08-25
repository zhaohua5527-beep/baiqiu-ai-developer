"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const XLSX = require("xlsx");
const { extractSpreadsheetColumns, computeBarcodeIntersection } = require("../services/spreadsheet-analysis");

function writeWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return wb;
}

test("multi-sheet workbook extracts wanted columns from every sheet", () => {
  // "订单" 页有 条形码/商品名称；"明细" 页也有 条形码（列名不同位置）。
  // 修复前只看第一页，会漏掉明细页的数据。
  const wb = writeWorkbook([
    {
      name: "订单",
      rows: [
        ["日期", "商品名称", "条形码"],
        ["20260703", "连衣裙A", "1000000000001"],
        ["20260704", "连衣裙B", "1000000000002"]
      ]
    },
    {
      name: "明细",
      rows: [
        ["条形码", "数量"],
        ["1000000000003", 3],
        ["1000000000004", 4]
      ]
    }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["条形码", "商品名称"]);
  assert.equal(result.ok, true);
  assert.equal(result.sheetCount, 2, "must report both sheets");
  assert.equal(result.totalRows, 4, "must count rows from all sheets");
  const barcode = result.results["条形码"];
  assert.ok(barcode, "must find barcode column");
  assert.equal(barcode.count, 4, "must merge barcodes from both sheets");
  // 明细页的条形码也必须在样例里
  assert.ok(barcode.sample.includes("1000000000003"), "must include detail-sheet barcode");
  assert.ok(barcode.sample.includes("1000000000004"), "must include detail-sheet barcode");
  assert.ok(result.results["商品名称"], "must find name column");
  assert.equal(result.results["商品名称"].count, 2);
});

test("single-sheet workbook keeps prior behavior", () => {
  const wb = writeWorkbook([
    {
      name: "Sheet1",
      rows: [
        ["商品名称", "条形码", "货号"],
        ["塑身裤", "3003632983281", "1726160013745160220"]
      ]
    }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["条形码", "商品名称", "货号"]);
  assert.equal(result.ok, true);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.totalRows, 1);
  assert.equal(result.results["条形码"].count, 1);
  assert.equal(result.results["条形码"].sample[0], "3003632983281");
});

test("empty workbook and empty sheet are handled gracefully", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "空页");
  const result = extractSpreadsheetColumns(XLSX, wb, ["条形码"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /空|工作表/);
});

test("wanted field missing from all sheets stays absent (not fabricated)", () => {
  const wb = writeWorkbook([
    { name: "订单", rows: [["商品名称", "数量"], ["连衣裙", 1]] }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["条形码", "商品名称"]);
  assert.equal(result.ok, true);
  assert.ok(result.results["商品名称"], "found column present");
  assert.equal(result.results["条形码"], undefined, "missing column stays absent");
});

test("deduplicates repeated values across sheets in sample", () => {
  const wb = writeWorkbook([
    { name: "A", rows: [["条形码"], ["111"]] },
    { name: "B", rows: [["条形码"], ["111"], ["222"]] }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["条形码"]);
  assert.equal(result.results["条形码"].count, 2, "111 deduplicated across sheets");
  assert.deepEqual(result.results["条形码"].sample, ["111", "222"]);
});

test("reports every sheet name with its data row count (task-037)", () => {
  // 多 sheet 工作簿：逐页报告名称与实际数据行数，验收要求每页都出现
  const wb = writeWorkbook([
    { name: "门店商品", rows: [["商品条码", "商品名称"], ["1", "甲"], ["2", "乙"]] },
    { name: "组合关系", rows: [["SPUID", "SKUID"], ["A", "B"]] }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["商品条码"]);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.sheets), "must expose per-sheet report");
  assert.equal(result.sheets.length, 2);
  assert.deepEqual(
    result.sheets.map((sheet) => [sheet.name, sheet.dataRows]),
    [["门店商品", 2], ["组合关系", 1]]
  );
});

test("barcode intersection across two attachments (task-037)", () => {
  // 附件1：门店商品 3 条码 + 组合关系 1 条码；附件2：活动 4 条码
  // 共同：2（条码 1、3）；仅附件1：2（商品2 + 组合4）；仅附件2：2
  const wb1 = writeWorkbook([
    { name: "门店商品", rows: [["商品条码"], ["1"], ["2"], ["3"]] },
    { name: "组合关系", rows: [["商品条码"], ["4"]] }
  ]);
  const wb2 = writeWorkbook([
    { name: "门店商品活动信息", rows: [["商品条码"], ["1"], ["3"], ["5"], ["6"]] }
  ]);
  const attachments = [
    { name: "products.xlsx", workbook: wb1 },
    { name: "activities.xlsx", workbook: wb2 }
  ];
  const result = computeBarcodeIntersection(XLSX, attachments, {
    readAttachment: (att) => ({ buffer: null }),
    readWorkbook: (XLSX_, buffer, att) => ({ workbook: att.workbook })
  });
  assert.ok(result, "two-table attachments must produce intersection");
  assert.equal(result.first.unique, 4);
  assert.equal(result.second.unique, 4);
  assert.equal(result.intersectionCount, 2);
  assert.equal(result.onlyFirst, 2);
  assert.equal(result.onlySecond, 2);
});

test("barcode intersection returns null with single attachment", () => {
  const wb = writeWorkbook([{ name: "S", rows: [["商品条码"], ["1"]] }]);
  const result = computeBarcodeIntersection(XLSX, [{ name: "one.xlsx", workbook: wb }], {
    readWorkbook: (XLSX_, buffer, att) => ({ workbook: att.workbook })
  });
  assert.equal(result, null, "single attachment has no intersection semantics");
});

test("barcode column located across sheets with different header layouts", () => {
  // 附件1 用"商品条码"，附件2 用"条码"——都能识别
  const wb1 = writeWorkbook([{ name: "A", rows: [["商品名称", "商品条码"], ["甲", "10"]] }]);
  const wb2 = writeWorkbook([{ name: "B", rows: [["条码", "数量"], ["10", 1], ["11", 2]] }]);
  const result = computeBarcodeIntersection(XLSX, [
    { name: "a.xlsx", workbook: wb1 },
    { name: "b.xlsx", workbook: wb2 }
  ], {
    readAttachment: (att) => ({ buffer: null }),
    readWorkbook: (XLSX_, buffer, att) => ({ workbook: att.workbook })
  });
  assert.equal(result.first.unique, 1);
  assert.equal(result.second.unique, 2);
  assert.equal(result.intersectionCount, 1);
});

test("count is unique value count, not occurrence count (task-037 rc.7)", () => {
  // 复刻 Codex rc.7 验收场景：2 sheet、130+80 行、品牌每行重复出现。
  // count 必须是去重后的唯一值数（品牌 15），不能是出现次数（135）。
  const firstRows = [["商品条码", "SKUID", "商品品牌", "商品名称"]];
  const secondRows = [["商品条码", "SKUID", "商品品牌", "商品名称"]];
  for (let index = 0; index < 130; index += 1) {
    firstRows.push([`UPC-${String(index % 90).padStart(3, "0")}`, `SKU-${String(index % 60).padStart(3, "0")}`, `品牌-${String(index % 10).padStart(2, "0")}`, `第一表商品-${index}`]);
  }
  for (let index = 0; index < 80; index += 1) {
    secondRows.push([`UPC-${String(60 + (index % 60)).padStart(3, "0")}`, `SKU-${String(40 + (index % 50)).padStart(3, "0")}`, `品牌-${String(5 + (index % 10)).padStart(2, "0")}`, `第二表商品-${index}`]);
  }
  const wb = writeWorkbook([
    { name: "主数据", rows: firstRows },
    { name: "补充数据", rows: secondRows }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["商品条码", "SKUID", "商品品牌"]);
  assert.equal(result.results["商品条码"].count, 120, "barcode unique count");
  assert.equal(result.results["SKUID"].count, 90, "SKU unique count");
  assert.equal(result.results["商品品牌"].count, 15, "brand unique count, not 135");
  // 样本去重且不重复
  assert.equal(new Set(result.results["商品品牌"].sample).size, result.results["商品品牌"].sample.length);
  // 内部去重集合不泄漏到结果
  assert.equal(result.results["商品条码"].seen, undefined);
  assert.equal(result.results["SKUID"].seen, undefined);
});

test("SKUID and 商品条码 headers are matched exactly (task-037 rc.7)", () => {
  // 修复前：SKUID 无字段映射；商品条码被映射成"条形码"，找不到表头。
  // 现在 wanted=SKUID/商品条码 必须直接命中表头。
  const wb = writeWorkbook([
    { name: "S", rows: [["商品条码", "SKUID", "商品品牌"], ["UPC-A", "SKU-1", "甲"], ["UPC-B", "SKU-1", "甲"]] }
  ]);
  const result = extractSpreadsheetColumns(XLSX, wb, ["SKUID", "商品条码", "商品品牌"]);
  assert.equal(result.results["商品条码"].count, 2);
  assert.equal(result.results["SKUID"].count, 1, "SKU deduped to 1");
  assert.equal(result.results["商品品牌"].count, 1);
});
