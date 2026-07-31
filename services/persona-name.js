"use strict";

const DEFAULT_MAX_NAME_LENGTH = 12;
const PREFIXES = [
  "\u4ece\u73b0\u5728\u8d77\u4f60\u53eb",             // cong xian zai qi ni jiao
  "\u4f60\u73b0\u5728\u7684\u540d\u5b57\u53eb",     // ni xian zai de ming zi jiao
  "\u4f60\u73b0\u5728\u53eb",                       // ni xian zai jiao
  "\u4ee5\u540e\u4f60\u53eb",                       // yi hou ni jiao
  "\u4ee5\u540e\u7ed9\u4f60\u53d6\u540d\u53eb", // yi hou gei ni qu ming jiao
  "\u4ee5\u540e\u4f60\u5c31\u53eb",             // yi hou ni jiu jiao
  "\u4ee5\u540e\u53eb\u4f60",                   // yi hou jiao ni
  "\u7ed9\u4f60\u53d6\u540d\u53eb",             // gei ni qu ming jiao
  "\u4f60\u7684\u540d\u5b57\u662f",             // ni de ming zi shi
  "\u4f60\u7684\u540d\u5b57\u53eb"              // ni de ming zi jiao
];
const VALID_NAME = /^[\p{L}\p{N}]+$/u;
const DISCUSSION_MARKER = /(?:\u4ec0\u4e48|\u662f\u5426|\u600e\u4e48\u6837|\u597d\u4e0d\u597d|\u53ef\u4ee5\u5417|\u884c\u4e0d\u884c|\u8fd9\u4e2a\u540d\u5b57|\u7684\u529f\u80fd|\u7684\u8bf4\u6cd5|\u8fd9\u53e5\u8bdd|\u8fd9\u4ef6\u4e8b)/u;
const TRAILING_SENTENCE_PUNCTUATION = /[\u3002\uff01!]+$/u;
const QUOTE_PAIRS = new Map([
  ['"', '"'], ["'", "'"], ["\u201c", "\u201d"], ["\u2018", "\u2019"], ["\u300a", "\u300b"]
]);

function unicodeLength(value) {
  return Array.from(value).length;
}

function unwrapQuotes(value) {
  if (value.length < 2) return value;
  const closingQuote = QUOTE_PAIRS.get(value[0]);
  return closingQuote && value.at(-1) === closingQuote ? value.slice(1, -1).trim() : value;
}

function normalizePersonaName(value, options = {}) {
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : DEFAULT_MAX_NAME_LENGTH;
  if (maxLength < 1 || typeof value !== "string") return null;
  const name = unwrapQuotes(value.normalize("NFKC").trim());
  if (!name || unicodeLength(name) > maxLength || !VALID_NAME.test(name) || DISCUSSION_MARKER.test(name)) return null;
  return name;
}

function extractPersonaName(input, options = {}) {
  if (typeof input !== "string") return null;
  const command = input.normalize("NFKC").trim().replace(TRAILING_SENTENCE_PUNCTUATION, "").trim();
  const prefix = PREFIXES.find((item) => command.startsWith(item));
  if (!prefix) return null;
  return normalizePersonaName(command.slice(prefix.length), options);
}

module.exports = { DEFAULT_MAX_NAME_LENGTH, extractPersonaName, normalizePersonaName };
