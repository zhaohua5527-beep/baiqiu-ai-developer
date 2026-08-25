"use strict";

// CSV 写回编码对称：读侧能识别 GBK/UTF-16，写侧也要按原编码输出，
// 否则 GBK 中文文件被保存成 UTF-8，再被 GBK 工具打开就乱码。
// xlsx 的 bookType:"csv" 固定输出 UTF-8（带 BOM），所以这里生成 UTF-8 文本
// 后用 iconv-lite 转回目标编码；iconv-lite 已在 dependencies（xlsx 生态标准库）。
let iconv = null;
function iconvLite() {
  if (iconv) return iconv;
  try { iconv = require("iconv-lite"); } catch { iconv = null; }
  return iconv;
}

function encodeCsvBuffer(utf8Buffer, encoding = "") {
  const source = Buffer.isBuffer(utf8Buffer) ? utf8Buffer : Buffer.from(utf8Buffer || "");
  if (encoding !== "gbk" && encoding !== "utf-16le" && encoding !== "utf-16be") return source;
  let text = source.toString("utf8");
  // xlsx 的 CSV 输出总是带 UTF-8 BOM，转码前剥掉，避免变成 GBK 开头的乱码字符
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const converter = iconvLite();
  if (!converter) return source;
  try { return converter.encode(text, encoding); } catch { return source; }
}

module.exports = { encodeCsvBuffer, iconvLite };
