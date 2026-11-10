"use strict";

const PROTOCOL = "baiqiu-answer-document/1.0";
const OPEN_TAG = "<baiqiu-answer-document>";
const CLOSE_TAG = "</baiqiu-answer-document>";
const ROLES = new Set(["heading", "paragraph", "note", "lead"]);

function cleanText(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeAnswerDocument(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const schemaVersion = Number(raw.schemaVersion || raw.version || 1);
  if (schemaVersion !== 1) return null;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .map((block) => {
      if (!block || typeof block !== "object") return null;
      const index = Number(block.index);
      const role = cleanText(block.role, 24).toLowerCase();
      if (!Number.isInteger(index) || index < 0 || index > 200 || !ROLES.has(role)) return null;
      const normalized = { index, role };
      if (role === "heading") {
        const level = Number(block.level || 2);
        normalized.level = Number.isInteger(level) ? Math.max(1, Math.min(6, level)) : 2;
      }
      return normalized;
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .filter((block, index, values) => index === 0 || block.index !== values[index - 1].index);
  if (!blocks.length) return null;
  return { protocol: PROTOCOL, schemaVersion: 1, blocks };
}

function extractAnswerDocumentEnvelope(source = "") {
  const text = String(source || "");
  let answerDocument = null;
  let found = false;
  const visibleText = text.replace(/<baiqiu-answer-document>([\s\S]*?)<\/baiqiu-answer-document>/gi, (_match, body) => {
    found = true;
    if (!answerDocument) {
      try { answerDocument = normalizeAnswerDocument(JSON.parse(body)); } catch {}
    }
    return "";
  }).trim();
  return {
    text: visibleText,
    answerDocument,
    found
  };
}

function stripAnswerDocumentEnvelope(source = "") {
  return extractAnswerDocumentEnvelope(source).text;
}

function documentFromMessage(message = {}) {
  const raw = message?.raw && typeof message.raw === "object" ? message.raw : {};
  const product = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : {};
  const candidates = [
    message.answerDocument,
    raw.answerDocument,
    product.answerDocument,
    product.raw?.answerDocument,
    raw.raw?.answerDocument
  ];
  return candidates.map(normalizeAnswerDocument).find(Boolean) || null;
}

function normalizeRenderedRole(role = "", element = null) {
  const value = cleanText(role, 24).toLowerCase();
  if (!ROLES.has(value) || !element) return "";
  const tag = String(element.tagName || "").toLowerCase();
  if (value === "heading") return /^h[1-6]$/.test(tag) ? value : "";
  return tag === "p" ? value : "";
}

function applyAnswerDocumentRoles(root, answerDocument) {
  if (!root || !answerDocument) return 0;
  const blocks = Array.isArray(answerDocument.blocks) ? answerDocument.blocks : [];
  const segmentRoots = root.querySelectorAll?.(".stream-segment-answer, .progressive-markdown-stable, .progressive-markdown-tail") || [];
  const elements = segmentRoots.length
    ? [...segmentRoots].flatMap((segmentRoot) => [...(segmentRoot.children || [])])
    : [...(root.children || [])];
  let applied = 0;
  for (const block of blocks) {
    const element = elements[Number(block.index)];
    const role = normalizeRenderedRole(block.role, element);
    if (!role) continue;
    element.dataset.semanticRole = role;
    element.classList.add(`answer-semantic-${role}`);
    if (role === "heading" && Number(block.level) === Number(String(element.tagName || "").slice(1))) {
      element.dataset.semanticLevel = String(block.level);
    }
    applied += 1;
  }
  if (applied) root.dataset.answerDocumentProtocol = PROTOCOL;
  return applied;
}

const answerDocumentApi = {
  PROTOCOL,
  OPEN_TAG,
  CLOSE_TAG,
  applyAnswerDocumentRoles,
  documentFromMessage,
  extractAnswerDocumentEnvelope,
  normalizeAnswerDocument,
  stripAnswerDocumentEnvelope
};

if (typeof module !== "undefined" && module.exports) module.exports = answerDocumentApi;
if (typeof window !== "undefined") window.BaiqiuAnswerDocument = answerDocumentApi;
