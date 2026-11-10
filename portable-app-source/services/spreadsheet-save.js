"use strict";

// 表格保存的增量写回：编辑数据写回原 worksheet 时保留公式（f）、合并单元格
// （!merges）、单元格样式（.s/.z）等结构，而不是用 aoa_to_sheet 整表重建
// 丢弃它们。仅适用于覆盖已有文件（save）；新建/导出仍走 aoa_to_sheet。
//
// 值类型由 spreadsheetCellValue 归一化决定（大数字保持字符串 → t:"s"），
// 这里只负责把编辑器行值映射回 xlsx cell。

function makeSpreadsheetCell(value, existing = null) {
  const number = typeof value === "number" && Number.isFinite(value);
  const cell = { v: value, t: number ? "n" : "s" };
  if (existing && typeof existing === "object") {
    if (existing.z !== undefined) cell.z = existing.z;
    if (existing.s !== undefined) cell.s = existing.s;
  }
  return cell;
}

// 增量写回原 worksheet。保留 !merges/!cols/!rows 与既有 cell 样式；
// 编辑器行数变短时只抹超界旧 cell，不删行；公式 cell 在编辑器值为空时跳过，
// 避免把公式抹空。返回 { worksheet, targetRows, targetCols }。
function applyEditorRowsToWorksheet(XLSX, worksheet, rows = [], { columnWidths = {}, rowHeights = {} } = {}) {
  const sourceRange = worksheet && worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
  const sourceRows = sourceRange ? sourceRange.e.r + 1 : 0;
  const sourceCols = sourceRange ? sourceRange.e.c + 1 : 0;
  const editorCols = Math.max(0, ...rows.map((row) => row.length));
  const targetRows = Math.max(rows.length, sourceRows);
  const targetCols = Math.max(editorCols, sourceCols);

  for (let r = 0; r < targetRows; r += 1) {
    for (let c = 0; c < targetCols; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      const existing = worksheet ? worksheet[address] : null;
      const value = rows[r]?.[c];
      if (value === undefined || value === null || value === "") {
        // 编辑器该格为空。公式 cell 保留原公式（值由公式决定，编辑器给空不代表
        // 用户要删公式）；非公式 cell 清空值。
        if (existing && existing.f) continue;
        if (existing) {
          existing.v = null;
          existing.t = "s";
        }
        continue;
      }
      // 编辑器有值：覆盖既有 cell（保留样式/格式，公式被用户主动改写则丢弃公式），
      // 或新建 cell。
      if (existing) {
        const next = makeSpreadsheetCell(value, existing);
        if (existing.f) {
          delete existing.f;
          existing.v = value;
          existing.t = next.t;
        } else {
          existing.v = value;
          existing.t = next.t;
        }
      } else {
        worksheet[address] = makeSpreadsheetCell(value);
      }
    }
  }

  // 编辑器行数变短时，抹掉超出编辑行数的旧 cell 值（不删行、不动结构）
  if (sourceRows > rows.length) {
    for (let r = rows.length; r < sourceRows; r += 1) {
      for (let c = 0; c < sourceCols; c += 1) {
        const address = XLSX.utils.encode_cell({ r, c });
        if (worksheet[address] && !worksheet[address].f) {
          worksheet[address].v = null;
          worksheet[address].t = "s";
        }
      }
    }
  }

  worksheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: targetRows - 1, c: targetCols - 1 } });

  // 列宽/行高：只覆盖编辑器实际改过的行/列，其它保留原值（避免整表覆盖压扁）
  const widthMap = Object.fromEntries(Object.keys(columnWidths || {}).map((key) => [Number(key), columnWidths[key]]));
  if (Object.keys(widthMap).length) {
    const mergedCols = Array.isArray(worksheet["!cols"]) ? worksheet["!cols"].slice() : [];
    for (let c = 0; c < Math.max(editorCols, mergedCols.length); c += 1) {
      if (widthMap[c] !== undefined) mergedCols[c] = { wpx: Math.max(40, Math.min(500, Number(widthMap[c] || 112))) };
      else if (!mergedCols[c]) mergedCols[c] = { wpx: 112 };
    }
    worksheet["!cols"] = mergedCols;
  }
  const heightMap = Object.fromEntries(Object.keys(rowHeights || {}).map((key) => [Number(key), rowHeights[key]]));
  if (Object.keys(heightMap).length) {
    const mergedRows = Array.isArray(worksheet["!rows"]) ? worksheet["!rows"].slice() : [];
    for (let r = 0; r < Math.max(rows.length, mergedRows.length); r += 1) {
      if (heightMap[r] !== undefined) mergedRows[r] = { hpx: Math.max(18, Math.min(160, Number(heightMap[r] || 30))) };
      else if (!mergedRows[r]) mergedRows[r] = { hpx: 30 };
    }
    worksheet["!rows"] = mergedRows;
  }

  return { worksheet, targetRows, targetCols };
}

module.exports = { makeSpreadsheetCell, applyEditorRowsToWorksheet };
