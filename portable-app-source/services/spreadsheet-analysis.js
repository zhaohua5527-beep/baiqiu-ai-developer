"use strict";

// 表格数据分析：按请求字段从工作簿中提取列数据。
// 关键：必须覆盖工作簿内的所有工作表（sheet），不能只看第一页——
// 多 sheet 文件（如"订单"+"明细"分页）如果只读 Sheet1，第二个页签的
// 数据会被漏掉，回复"未找到对应列"。
//
// 每个 sheet 用自己的表头定位请求列，再按字段合并值：不同页的列布局
// 可能不同，逐页独立提取避免列索引错位。返回结构：
// { ok, totalRows, columns, sheetCount, sheets, results, encoding }
//   sheets = [{ name, dataRows, headers }]  逐工作表报告
//   results[字段] = { column, count, sample: [最多5条] }
//   count 是全表去重后的唯一值数量（task-037：不能把行数当唯一数）

function extractSpreadsheetColumns(XLSX, workbook, wantedFields = [], attachment = {}) {
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) return { ok: false, error: "表格没有可读取的工作表" };
  const results = {};
  const sheets = [];
  let totalRows = 0;
  let headerColumns = 0;
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (!rows.length) continue;
    const headers = rows[0].map((cell) => String(cell ?? "").trim());
    if (!headers.some(Boolean)) continue;
    const dataRows = rows.slice(1);
    if (!headerColumns) headerColumns = headers.filter(Boolean).length;
    totalRows += dataRows.length;
    sheets.push({ name: sheetName, dataRows: dataRows.length, headers });
    for (const wanted of wantedFields) {
      const idx = headers.findIndex((h) => h.includes(wanted) || wanted.includes(h));
      if (idx < 0) continue;
      // 全表去重：count 必须是唯一值数量，样本取去重后的前 5 条
      const seen = new Set();
      for (const row of dataRows) {
        const value = String(row[idx] ?? "").trim();
        if (value) seen.add(value);
      }
      const uniqueValues = [...seen];
      const existing = results[wanted];
      if (existing) {
        for (const value of uniqueValues) existing.seen.add(value);
        existing.count = existing.seen.size;
        existing.sample = [...existing.seen].slice(0, 5);
        existing.column = existing.column || headers[idx];
      } else {
        results[wanted] = { column: headers[idx], count: uniqueValues.length, sample: uniqueValues.slice(0, 5), seen: seen };
      }
    }
  }
  if (!totalRows) return { ok: false, error: "表格为空" };
  // 剥掉内部去重集合，只暴露 count/sample/column
  for (const info of Object.values(results)) {
    delete info.seen;
    info.sample = info.sample.slice(0, 5);
  }
  return {
    ok: true,
    totalRows,
    columns: headerColumns,
    sheetCount: sheetNames.length,
    sheets,
    results,
    encoding: attachment.source || ""
  };
}

// 从表头里定位"条码"列：优先精确匹配商品条码/条形码，其次含"码"的列。
function findBarcodeColumnIndex(headers) {
  for (const key of ["商品条码", "条形码", "条码", "UPC", "商品编码", "编码"]) {
    const idx = headers.findIndex((h) => h === key || h.includes(key));
    if (idx >= 0) return idx;
  }
  return headers.findIndex((h) => h.includes("码"));
}

// 跨附件条码交集统计：每个附件可含多个 sheet（如门店商品+组合关系）。
// 只统计表头带条码列的工作表，返回每个附件的唯一条码数，以及两附件
// 之间的共同/独有条码。readAttachment/readWorkbook 由调用方注入：
// readAttachment(att) -> { buffer } | null；readWorkbook(XLSX, buffer, att) -> { workbook }。
// 少于两个表格附件时返回 null（单表只做列提取，不构成交集语义）。
function computeBarcodeIntersection(XLSX, attachments = [], { readAttachment, readWorkbook } = {}) {
  const tableAttachments = (attachments || []).filter((att) => /\.(xlsx|xls|csv)$/i.test(String(att.name || "")));
  if (tableAttachments.length < 2) return null;
  const sets = [];
  for (const attachment of tableAttachments.slice(0, 2)) {
    const loaded = readAttachment ? readAttachment(attachment) : null;
    if (!loaded) return null;
    const { workbook } = readWorkbook ? readWorkbook(XLSX, loaded.buffer, attachment) : {};
    if (!workbook) return null;
    let barcodeSet = new Set();
    for (const sheetName of workbook.SheetNames || []) {
      const sheet = workbook.Sheets?.[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (!rows.length) continue;
      const headers = rows[0].map((cell) => String(cell ?? "").trim());
      const idx = findBarcodeColumnIndex(headers);
      if (idx < 0) continue;
      for (const row of rows.slice(1)) {
        const value = String(row[idx] ?? "").trim();
        if (value) barcodeSet.add(value);
      }
    }
    sets.push({ file: attachment.name || "", unique: barcodeSet.size, barcodes: barcodeSet });
  }
  if (sets.length !== 2) return null;
  const [first, second] = sets;
  const intersection = [...first.barcodes].filter((code) => second.barcodes.has(code));
  return {
    ok: true,
    first: { file: first.file, unique: first.unique },
    second: { file: second.file, unique: second.unique },
    intersectionCount: intersection.length,
    onlyFirst: first.unique - intersection.length,
    onlySecond: second.unique - intersection.length
  };
}

module.exports = { extractSpreadsheetColumns, computeBarcodeIntersection, findBarcodeColumnIndex };
