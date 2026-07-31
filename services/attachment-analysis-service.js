const fs = require("node:fs");
const path = require("node:path");

const MAX_TEXT_CHARS = 120000;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 100 * 1024 * 1024;

function extensionOf(attachment = {}) {
  return path.extname(String(attachment.name || attachment.path || attachment.sourcePath || "")).toLowerCase();
}

function attachmentKind(attachment = {}) {
  const extension = extensionOf(attachment);
  const mimeType = String(attachment.mimeType || "").toLowerCase();
  if (mimeType.startsWith("image/") || /^\.(png|jpe?g|webp|bmp|gif)$/.test(extension)) return "image";
  if (/\.(xlsx|xls|csv)$/.test(extension) || /spreadsheet|excel|csv/.test(mimeType)) return "spreadsheet";
  if (extension === ".docx" || /wordprocessingml|msword/.test(mimeType)) return "word";
  if (extension === ".pdf" || /pdf/.test(mimeType)) return "pdf";
  if (extension === ".pptx" || /presentationml|powerpoint/.test(mimeType)) return "presentation";
  if (/\.html?$/.test(extension) || /html/.test(mimeType)) return "html";
  if (extension === ".zip" || /zip/.test(mimeType)) return "archive";
  if (/\.(txt|md|json|log|js|css|xml)$/.test(extension) || /^text\/|json|markdown|javascript|xml/.test(mimeType)) return "text";
  return "binary";
}

function dataUrlBuffer(dataUrl = "") {
  const match = String(dataUrl).match(/^data:[^,]*;base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? Buffer.from(match[1].replace(/\s+/g, ""), "base64") : null;
}

function attachmentBuffer(attachment = {}, resolvePath = () => "", maxBytes = MAX_ANALYSIS_BYTES) {
  const embedded = dataUrlBuffer(attachment.dataUrl);
  if (embedded) {
    if (embedded.length > maxBytes) throw new Error("附件超过本地分析大小上限");
    return { buffer: embedded, sourcePath: "" };
  }
  const sourcePath = String(resolvePath(attachment) || "").trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  if (fs.statSync(sourcePath).size > maxBytes) throw new Error("附件超过本地分析大小上限");
  return { buffer: fs.readFileSync(sourcePath), sourcePath };
}

function presentationText(value) {
  if (typeof value === "string") return value;
  const slides = Array.isArray(value) ? value : [];
  return slides.map((slide) => [
    `## 幻灯片 ${slide.number || ""}：${slide.title || ""}`.trim(),
    ...(slide.lines || []).map((line) => `- ${line}`)
  ].join("\n")).join("\n\n");
}

function collectPresentationText(node, output = []) {
  if (node == null) return output;
  if (Array.isArray(node)) {
    node.forEach((item) => collectPresentationText(item, output));
    return output;
  }
  if (typeof node !== "object") return output;
  for (const [key, value] of Object.entries(node)) {
    if (key === "a:t") {
      const values = Array.isArray(value) ? value : [value];
      values.forEach((item) => {
        const text = typeof item === "object" ? item?.["#text"] : item;
        if (String(text || "").trim()) output.push(String(text).trim());
      });
    } else {
      collectPresentationText(value, output);
    }
  }
  return output;
}

async function extractPresentationSlides(buffer, { JSZip, XMLParser } = {}) {
  if (!JSZip || !XMLParser) throw new Error("PPT 解析依赖不可用");
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const slideFiles = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/i)?.[1] || 0) - Number(right.match(/slide(\d+)/i)?.[1] || 0))
    .slice(0, 100);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false, trimValues: true });
  const slides = [];
  for (const [index, fileName] of slideFiles.entries()) {
    const xml = await archive.file(fileName).async("string");
    const text = [...new Set(collectPresentationText(parser.parse(xml)).filter(Boolean))];
    slides.push({ number: index + 1, title: text[0] || `幻灯片 ${index + 1}`, lines: text.slice(1, 40) });
  }
  return slides;
}

async function inspectProjectArchive(buffer, attachment = {}, JSZip) {
  if (!JSZip) throw new Error("ZIP 解析依赖不可用");
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  const names = entries.map((entry) => entry.name).slice(0, 500);
  const preferred = entries.filter((entry) => /(^|\/)(readme(?:\.[^/]*)?|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod)$/i.test(entry.name)).slice(0, 12);
  const details = [];
  for (const entry of preferred) {
    const text = (await entry.async("string")).slice(0, 16000).trim();
    if (text) details.push(`## ${entry.name}\n${text}`);
  }
  return [
    `[ProjectArchive: ${attachment.name || "项目压缩包"}]`,
    `文件数量：${entries.length}`,
    `目录清单：\n${names.map((name) => `- ${name}`).join("\n")}`,
    ...details
  ].join("\n\n");
}

async function enrichAttachmentContent(attachment = {}, handlers = {}) {
  const item = { ...attachment };
  const kind = attachmentKind(item);
  const resolvePath = handlers.resolvePath || (() => "");

  if (kind === "image") {
    if (item.dataUrl) return item;
    try {
      const loaded = attachmentBuffer(item, resolvePath, handlers.maxInlineImageBytes || MAX_INLINE_IMAGE_BYTES);
      if (!loaded) return { ...item, analysisError: "图片文件路径不可用" };
      const mimeType = item.mimeType || ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" }[extensionOf(item)] || "image/png");
      return { ...item, mimeType, dataUrl: `data:${mimeType};base64,${loaded.buffer.toString("base64")}` };
    } catch (error) {
      return { ...item, analysisError: String(error?.message || error || "图片解析失败").slice(0, 500) };
    }
  }

  if (item.textContent) return item;
  try {
    if (kind === "spreadsheet") {
      const text = await handlers.spreadsheet?.(item);
      return text ? { ...item, textContent: String(text).slice(0, MAX_TEXT_CHARS) } : item;
    }

    const loaded = attachmentBuffer(item, resolvePath);
    if (!loaded) return { ...item, analysisError: "附件文件路径不可用" };
    let text = "";
    if (kind === "word") text = await handlers.word?.(loaded.buffer, item);
    else if (kind === "pdf") text = await handlers.pdf?.(loaded.buffer, item);
    else if (kind === "presentation") text = presentationText(await handlers.presentation?.(loaded.buffer, item));
    else if (kind === "html") text = await handlers.html?.(loaded.buffer.toString("utf8"), item);
    else if (kind === "archive") text = await handlers.archive?.(loaded.buffer, item);
    else if (kind === "text") text = loaded.buffer.toString("utf8");
    return text ? { ...item, textContent: String(text).slice(0, MAX_TEXT_CHARS) } : item;
  } catch (error) {
    return { ...item, analysisError: String(error?.message || error || "附件解析失败").slice(0, 500) };
  }
}

module.exports = {
  MAX_ANALYSIS_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  attachmentKind,
  enrichAttachmentContent,
  extractPresentationSlides,
  inspectProjectArchive
};
