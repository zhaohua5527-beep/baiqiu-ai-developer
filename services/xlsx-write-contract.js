"use strict";

function invalidInput(message) {
  const error = new Error(message);
  error.code = "INVALID_XLSX_INPUT";
  return error;
}

function normalizeSheetName(value, index) {
  const fallback = `Sheet${index + 1}`;
  const normalized = String(value || fallback).trim().replace(/[\\/?*:[\]]/g, "_").slice(0, 31);
  return normalized || fallback;
}

function normalizeRows(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw invalidInput(`${label} 必须是非空二维数组`);
  const rows = value.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw invalidInput(`${label} 第 ${rowIndex + 1} 行不是数组`);
    return row.map((cell, columnIndex) => {
      if (cell === null || cell === undefined || ["string", "number", "boolean"].includes(typeof cell)) {
        if (typeof cell === "number" && !Number.isFinite(cell)) {
          throw invalidInput(`${label} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列不是有限数字`);
        }
        return cell ?? null;
      }
      throw invalidInput(`${label} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列必须是文本、数字、布尔值或空值`);
    });
  });
  if (!rows.some((row) => row.some((cell) => cell !== null && String(cell).length > 0))) {
    throw invalidInput(`${label} 不能是空白表格`);
  }
  return rows;
}

function normalizeXlsxSheets(action = {}) {
  const rawSheets = Array.isArray(action.sheets) ? action.sheets : [];
  const topLevelRows = action.rows;
  let sheets;
  if (!rawSheets.length) {
    sheets = [{ name: "Sheet1", rows: normalizeRows(topLevelRows, "rows") }];
  } else if (rawSheets.every((sheet) => typeof sheet === "string")) {
    if (rawSheets.length !== 1 || !Array.isArray(topLevelRows)) {
      throw invalidInput("字符串 sheets 只兼容单工作表，并且必须同时提供顶层 rows");
    }
    sheets = [{ name: rawSheets[0], rows: normalizeRows(topLevelRows, "rows") }];
  } else {
    if (rawSheets.length > 12) throw invalidInput("一次最多生成 12 个工作表");
    sheets = rawSheets.map((sheet, index) => {
      if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) {
        throw invalidInput(`sheets 第 ${index + 1} 项必须是对象`);
      }
      const rows = sheet.rows ?? (rawSheets.length === 1 ? topLevelRows : undefined);
      return { name: sheet.name, rows: normalizeRows(rows, `sheets[${index}].rows`) };
    });
  }

  const names = new Set();
  return sheets.map((sheet, index) => {
    const name = normalizeSheetName(sheet.name, index);
    const key = name.toLowerCase();
    if (names.has(key)) throw invalidInput(`工作表名称重复：${name}`);
    names.add(key);
    return { name, rows: sheet.rows };
  });
}

function meaningfulRange(rows) {
  let lastRow = -1;
  let lastColumn = -1;
  rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (cell === null || cell === undefined || String(cell).length === 0) return;
    lastRow = Math.max(lastRow, rowIndex);
    lastColumn = Math.max(lastColumn, columnIndex);
  }));
  return { lastRow, lastColumn };
}

function verifyWrittenXlsx(XLSX, file, expectedSheets) {
  let workbook;
  try {
    workbook = XLSX.readFile(file, { cellDates: false, raw: true });
  } catch (cause) {
    const error = new Error(`表格写后无法重新读取：${cause?.message || cause}`);
    error.code = "XLSX_VERIFICATION_FAILED";
    throw error;
  }
  const expectedNames = expectedSheets.map((sheet) => sheet.name);
  if (JSON.stringify(workbook.SheetNames) !== JSON.stringify(expectedNames)) {
    const error = new Error(`表格写后工作表名称不一致：${workbook.SheetNames.join(", ")}`);
    error.code = "XLSX_VERIFICATION_FAILED";
    throw error;
  }
  let verifiedCells = 0;
  for (const expected of expectedSheets) {
    const worksheet = workbook.Sheets[expected.name];
    const expectedRange = meaningfulRange(expected.rows);
    const actualRange = worksheet?.["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    if (!actualRange || actualRange.e.r !== expectedRange.lastRow || actualRange.e.c !== expectedRange.lastColumn) {
      const error = new Error(`表格写后范围不一致：${expected.name}`);
      error.code = "XLSX_VERIFICATION_FAILED";
      throw error;
    }
    expected.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      const actual = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]?.v ?? null;
      if (cell === null || cell === "") {
        if (actual !== null && actual !== "") throw invalidInput(`表格写后单元格不一致：${expected.name}!${rowIndex + 1},${columnIndex + 1}`);
      } else if (actual !== cell) {
        const error = new Error(`表格写后单元格不一致：${expected.name}!${rowIndex + 1},${columnIndex + 1}`);
        error.code = "XLSX_VERIFICATION_FAILED";
        throw error;
      } else {
        verifiedCells += 1;
      }
    }));
  }
  return { sheetNames: expectedNames, verifiedCells };
}

module.exports = { normalizeXlsxSheets, verifyWrittenXlsx };
