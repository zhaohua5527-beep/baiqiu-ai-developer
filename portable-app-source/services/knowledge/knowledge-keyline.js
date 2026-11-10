"use strict";

// 知识重点识别：从知识正文/摘要里识别"重点句"与"可独立阅读的摘要"。
// 用途：
// 1. 摘要识别式提炼——替代纯 slice 截断，给"结论/数字/实体"加权
// 2. 摘要划重点画线——返回带重点标注的句子索引，前端据此画下划线
//
// 纯函数、无副作用、不依赖 Electron。重点识别规则：
// - 信号词句：因此/结论/注意/必须/核心/关键/重点/最后/综上 开头
// - 数字实体句：含数字/百分比/日期/金额
// - 结论句：以句号结尾的陈述句且长度适中（8-80 字）
// 摘要提炼：按重点度排序取前 N 句拼接，而不是 slice 截断。

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// 把正文切成句子（保留标点）
function splitSentences(value = "") {
  const text = clean(value);
  if (!text) return [];
  return text.split(/(?<=[。！？!?；;])/).map((item) => clean(item)).filter(Boolean);
}

// 信号词（开头命中即重点）
const SIGNAL_PATTERNS = [
  /^(?:因此|综上|总之|最后|最终|核心|关键|重点|注意|必须|应该|需要|建议|结论|结论是|也就是说|换句话说|最重要的是|特别提醒)/,
  /(?:因此|综上|结论|核心|关键|重点|注意|必须|建议|要点|要点是)/
];

// 数字/实体（数字、日期、金额、文件名和项目标识）
const NUMBER_PATTERN = /\d+(?:\.\d+)?%?|\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?|人民币?|￥|\$|元|万元|亿/;
const FILE_PATTERN = /(?:[a-z]:[\\/][^\s<>:"|?*]+|[\w\u3400-\u9fff.-]+\.(?:md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|xlsx?|csv|docx?|pdf|pptx?|zip))(?:\b|$)/i;
const PROJECT_PATTERN = /(?:task-[a-z0-9-]+|rc\.\d+|[「“\[][^」”\]]{2,40}[」”\]](?:项目|工程)?|[\w\u3400-\u9fff-]{2,32}(?:项目|工程))/i;

function normalizedSentence(value = "") {
  return clean(value).replace(/[。！？!?；;]+$/g, "");
}

function isSummarySentence(sentence, summaryText) {
  const sentenceText = normalizedSentence(sentence);
  const summary = normalizedSentence(summaryText);
  if (!sentenceText || !summary) return false;
  return summary.includes(sentenceText) || sentenceText.includes(summary);
}

// 单句重点度打分：0-1
function scoreSentence(sentence = "", index = 0, total = 0, { summaryText = "", summaryMode = false } = {}) {
  let score = 0;
  if (isSummarySentence(sentence, summaryText)) score += 0.8;
  if (SIGNAL_PATTERNS.some((pattern) => pattern.test(sentence))) score += 0.55;
  if (NUMBER_PATTERN.test(sentence) || FILE_PATTERN.test(sentence) || PROJECT_PATTERN.test(sentence)) score += 0.45;
  // 长度只参与同类信号句排序，不单独把普通句判成重点。
  const length = sentence.length;
  if (length >= 8 && length <= 80) score += 0.08;
  else if (length > 120) score -= 0.15;
  if (/[。！]$/.test(sentence)) score += 0.04;
  if (summaryMode && index === 0) score += 0.42;
  else if (index === 0 && total > 1) score += 0.03;
  return Math.max(0, Math.min(1, score));
}

// 识别重点句：返回 [{ text, score, key }]
// key=true 表示该句应画线（score >= 阈值）
function detectKeySentences(value = "", { minScore = 0.45, summaryText = "", summaryMode = false } = {}) {
  const sentences = splitSentences(value);
  const total = sentences.length;
  if (!total) return [];
  const scored = sentences.map((text, index) => ({
    text,
    score: scoreSentence(text, index, total, { summaryText, summaryMode }),
    key: false
  }));
  // 最多标记 30%，但普通句不会因为排名靠前而被误标。
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const keyCount = Math.max(1, Math.min(scored.length, Math.round(scored.length * 0.3)));
  const selected = new Set(sorted.filter((item) => item.score >= minScore).slice(0, keyCount));
  for (const item of scored) item.key = selected.has(item);
  return scored;
}

// 提炼摘要：取重点句拼接成可独立阅读的摘要（替代 slice 截断）
function summarize(value = "", { maxSentences = 3, maxLength = 160 } = {}) {
  const sentences = splitSentences(value);
  if (!sentences.length) return "";
  const scored = sentences.map((text, index) => ({ text, score: scoreSentence(text, index, sentences.length) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences);
  // 按原顺序拼回，保持可读
  const ordered = scored.map((item) => item.text).sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b));
  const joined = ordered.join("").slice(0, maxLength);
  return joined || clean(value).slice(0, maxLength);
}

// 渲染安全：把正文转成带 <mark> 画线标记的 HTML 片段
// 供前端列表/正文展示；纯文本 fallback 用 keyIndexes
function toMarkedHtml(value = "", options = {}) {
  const sentences = detectKeySentences(value, options);
  return sentences.map((item) => item.key ? `<mark class="knowledge-keyline">${escapeHtml(item.text)}</mark>` : escapeHtml(item.text)).join("");
}

// 供前端非 HTML 渲染：返回重点句的下标列表
function keyIndexes(value = "", options = {}) {
  return detectKeySentences(value, options).map((item, index) => item.key ? index : -1).filter((index) => index >= 0);
}

function escapeHtml(value = "") {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const knowledgeKeylineApi = {
  detectKeySentences,
  keyIndexes,
  scoreSentence,
  splitSentences,
  summarize,
  toMarkedHtml
};

if (typeof module !== "undefined" && module.exports) module.exports = knowledgeKeylineApi;
if (typeof window !== "undefined") window.BaiqiuKnowledgeKeyline = knowledgeKeylineApi;
