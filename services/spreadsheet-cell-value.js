"use strict";

// 表格单元格值归一化：决定编辑器行值以数字还是字符串写入工作簿。
// 大整数（UPC/条码等 18 位数字）超过 Number.MAX_SAFE_INTEGER 后 Number()
// 会溢出丢精度，必须保持字符串，避免保存时永久改写数据。
function spreadsheetCellValue(value) {
  const text = String(value ?? "");
  if (!text) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && !/^-?0\d+/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER) return number;
  }
  return text;
}

module.exports = { spreadsheetCellValue };
