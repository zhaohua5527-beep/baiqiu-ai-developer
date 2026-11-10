"use strict";

const FILE_FORMAT = "(?:txt|md|html?|docx?|word|xlsx?|excel|csv|pdf|pptx?|powerpoint|png|jpe?g|webp)";

function wantsFileOutput(message = "") {
  const text = String(message || "").trim();
  if (!text) return false;
  if (/(保存|导出|下载|另存为|保存为|放到桌面|放桌面|写入文件|创建文件|生成文件|文件名)/i.test(text)) return true;
  if (/(?:写|放|存)(?:到|进|为).{0,8}(?:文件|文档|桌面|文件夹)/i.test(text)) return true;
  if (new RegExp(`(?:生成|创建|制作|转换|输出|交付).{0,24}(?:文件|文档|表格|图片|\\.${FILE_FORMAT}\\b|${FILE_FORMAT}\\s*(?:格式|版本))`, "i").test(text)) return true;
  if (new RegExp(`(?:要|给我|需要).{0,12}(?:${FILE_FORMAT})\\s*(?:文件|格式|版本)`, "i").test(text)) return true;
  return false;
}

module.exports = { wantsFileOutput };
