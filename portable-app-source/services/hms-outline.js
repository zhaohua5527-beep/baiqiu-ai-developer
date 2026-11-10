"use strict";

const OUTLINE_OPEN_TAG = "<baiqiu-outline>";
const OUTLINE_CLOSE_TAG = "</baiqiu-outline>";

function cleanOutlineValue(value = "", maxLength = 80) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function outlineAnchorKey(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLocaleLowerCase();
}

function normalizeHmsOutline(value = {}) {
  const payload = value && typeof value === "object" ? value : {};
  const input = Array.isArray(payload.items) ? payload.items : [];
  const seenAnchors = new Set();
  const items = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const label = cleanOutlineValue(entry.label || entry.title || entry.summary, 24);
    const anchor = cleanOutlineValue(entry.anchor || entry.heading || entry.text, 100);
    const anchorKey = outlineAnchorKey(anchor);
    if (!label || !anchor || seenAnchors.has(anchorKey)) continue;
    seenAnchors.add(anchorKey);
    items.push({
      label,
      anchor,
      level: Math.max(1, Math.min(3, Number(entry.level) || 2))
    });
    if (items.length >= 8) break;
  }
  return items.length >= 2 ? { version: "baiqiu-outline/1.0", items } : null;
}

const NOVEL_CHAPTER_LINE = /^(?:序章|楔子|尾声|终章|后记|番外(?:篇)?|第\s*(?:\d+|[一二三四五六七八九十百千万零两]+)\s*[章节回卷篇])(?:\s*(?:[：:、.．\-—]\s*|\s+).{0,90})?$/u;

function outlineSourceText(text = "") {
  const source = String(text || "");
  const final = source.match(/<baiqiu-final>([\s\S]*?)<\/baiqiu-final>/i)?.[1] || source;
  return final
    .replace(/<baiqiu-(?:progress|outcome|presentation|clarification|outline)>[\s\S]*?<\/baiqiu-(?:progress|outcome|presentation|clarification|outline)>/gi, "")
    .trim();
}

function buildOutlineFromText(text = "") {
  const source = outlineSourceText(text);
  if (!source) return null;
  const items = [];
  const seen = new Set();
  let inFence = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = String(rawLine || "").trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^\|/.test(line)) continue;
    const markdown = line.match(/^#{1,3}\s+(.+?)\s*#*$/u);
    const chapter = line.match(NOVEL_CHAPTER_LINE);
    const heading = markdown?.[1]?.trim() || chapter?.[0]?.trim() || "";
    if (!heading || /^(?:摘要|总结|内容目录|summary|table of contents|contents|result|task completed)$/i.test(heading)) continue;
    const anchor = cleanOutlineValue(heading, 100);
    const key = outlineAnchorKey(anchor);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: cleanOutlineValue(heading, 24),
      anchor,
      level: markdown ? Math.min(3, markdown[0].match(/^#+/)?.[0].length || 2) : 2
    });
    if (items.length >= 8) break;
  }
  return items.length >= 2 ? { version: "baiqiu-outline/1.0", source: "local-heading-fallback", items } : null;
}

function extractHmsOutlineEnvelope(text = "") {
  const source = String(text || "");
  const match = source.match(/<baiqiu-outline>([\s\S]*?)<\/baiqiu-outline>/i);
  if (!match) return null;
  try {
    const outline = normalizeHmsOutline(JSON.parse(match[1]));
    if (!outline) return null;
    return { outline, envelope: match[0] };
  } catch {
    return null;
  }
}

function stripHmsOutlineEnvelopes(text = "") {
  return String(text || "")
    .replace(/<baiqiu-outline>[\s\S]*?<\/baiqiu-outline>/gi, "")
    .replace(/<baiqiu-outline>[\s\S]*$/gi, "")
    .trim();
}

module.exports = {
  OUTLINE_CLOSE_TAG,
  OUTLINE_OPEN_TAG,
  cleanOutlineValue,
  buildOutlineFromText,
  extractHmsOutlineEnvelope,
  normalizeHmsOutline,
  stripHmsOutlineEnvelopes
};
