"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  buildOutlineFromText,
  extractHmsOutlineEnvelope,
  normalizeHmsOutline,
  stripHmsOutlineEnvelopes
} = require("../services/hms-outline");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const uiAdapterSource = fs.readFileSync(path.join(root, "services", "product-sdk", "ui-adapter.js"), "utf8");

function rendererOutlineFunctions() {
  const helperStart = rendererSource.indexOf("function normalizeLongReplyAnchor");
  const helperEnd = rendererSource.indexOf("function cleanLongReplyTitle", helperStart);
  const headingStart = rendererSource.indexOf("function longReplyHeadings");
  const headingEnd = rendererSource.indexOf("function clearLongReplyState", headingStart);
  const context = { LONG_REPLY_MIN_HEADINGS: 2 };
  vm.createContext(context);
  vm.runInContext(`${rendererSource.slice(helperStart, helperEnd)}\n${rendererSource.slice(headingStart, headingEnd)}`, context);
  return context;
}

function fakeElement(tagName, textContent, { excluded = false } = {}) {
  return {
    tagName,
    textContent,
    closest: () => excluded ? {} : null,
    getBoundingClientRect: () => ({ top: 0, bottom: 20 })
  };
}

function fakeRendered({ headings = [], anchors = headings } = {}) {
  return {
    querySelectorAll(selector) {
      return selector === "h1, h2, h3" ? headings : anchors;
    }
  };
}

test("HMS outline envelopes retain only bounded unique entries", () => {
  const parsed = extractHmsOutlineEnvelope([
    "<baiqiu-final># First section\nBody\n# Second section\nBody</baiqiu-final>",
    '<baiqiu-outline>{"items":[',
    '{"label":"First section details","anchor":"First section","level":1},',
    '{"label":"Duplicate ignored","anchor":"First section","level":2},',
    '{"label":"Second section details","anchor":"Second section","level":9}',
    "]}</baiqiu-outline>"
  ].join(""));

  assert.equal(parsed.outline.version, "baiqiu-outline/1.0");
  assert.deepEqual(parsed.outline.items, [
    { label: "First section details", anchor: "First section", level: 1 },
    { label: "Second section details", anchor: "Second section", level: 3 }
  ]);
});

test("an outline with fewer than two valid anchors is rejected", () => {
  assert.equal(normalizeHmsOutline({ items: [{ label: "Only item", anchor: "Only anchor" }] }), null);
  assert.equal(extractHmsOutlineEnvelope("<baiqiu-outline>{broken}</baiqiu-outline>"), null);
});

test("local fallback builds a grounded directory from novel chapter lines", () => {
  const outline = buildOutlineFromText([
    "<baiqiu-final>",
    "《雾港来信》",
    "第一章 雨夜的门铃",
    "雨落在港口的石阶上。",
    "第二章 未寄出的信",
    "信封背面留着褪色的印记。",
    "```md",
    "第三章 这行代码不应进入目录",
    "```",
    "尾声 灯塔仍亮着",
    "</baiqiu-final>"
  ].join("\n"));

  assert.deepEqual(outline, {
    version: "baiqiu-outline/1.0",
    source: "local-heading-fallback",
    items: [
      { label: "第一章 雨夜的门铃", anchor: "第一章 雨夜的门铃", level: 2 },
      { label: "第二章 未寄出的信", anchor: "第二章 未寄出的信", level: 2 },
      { label: "尾声 灯塔仍亮着", anchor: "尾声 灯塔仍亮着", level: 2 }
    ]
  });
});

test("outline envelopes can never leak into visible fallback text", () => {
  const source = 'Visible<baiqiu-outline>{"items":[]}</baiqiu-outline>';
  assert.equal(stripHmsOutlineEnvelopes(source), "Visible");
  assert.match(rendererSource, /function stripHmsOutlineEnvelopeTags/);
  assert.match(rendererSource, /stripHmsOutlineEnvelopeTags\(stripHmsProgressEnvelopeTags/);
});

test("the model outline protocol is optional and requires exact final-answer anchors", () => {
  assert.match(mainSource, /For a final answer longer than roughly 500 Chinese characters/);
  assert.match(mainSource, /For creative writing, chapter lines such as 第一章、第二章、序章、尾声 count as real sections/);
  assert.match(mainSource, /Every anchor must occur exactly once in the final answer/);
  assert.match(mainSource, /if \(outlineEnvelope\?\.outline\) normalized\.outline = outlineEnvelope\.outline/);
  assert.match(mainSource, /const fallbackOutline = buildOutlineFromText\(source\);/);
  assert.match(uiAdapterSource, /"clarification", "presentation", "outline", "knowledgeReferences"/);
});

test("renderer validates outline labels and anchors before building a directory", () => {
  assert.match(rendererSource, /function validatedOutlineLabel\(label = "", anchor = ""\)/);
  assert.match(rendererSource, /overlap \/ labelChars\.length >= 0\.5/);
  assert.match(rendererSource, /if \(matches\.length !== 1\) return null/);
  assert.match(rendererSource, /element\.closest\("pre, code, blockquote, table,/);
  assert.match(rendererSource, /\}\)\.slice\(0, 8\)/);
  assert.match(rendererSource, /return \[\.\.\.final\]\.slice\(0, 12\)\.join\(""\)/);
  assert.doesNotMatch(rendererSource, /extractNovelTitle\(displayText, originalRequest\)/);
});

test("directories are created only after final content is stable", () => {
  assert.match(rendererSource, /row\.dataset\.contentReady !== "1"/);
  assert.match(rendererSource, /row\.classList\.contains\("streaming-response"\)/);
  assert.match(rendererSource, /if \(typingEntry\) completeAssistantTyping/);
  assert.match(rendererSource, /evaluateLongReply\(row, rendered, displayText, options\)/);
});

test("plain novel chapter lines are promoted into real navigable headings", () => {
  assert.match(rendererSource, /const NOVEL_CHAPTER_HEADING_LINE =/);
  assert.match(rendererSource, /function promoteNovelChapterHeadings\(text = ""\)/);
  assert.match(rendererSource, /return `## \$\{trimmed\}`;/);
  assert.match(rendererSource, /const normalizedSource = promoteNovelChapterHeadings\(source\);/);
  assert.match(rendererSource, /element,/);
  assert.match(rendererSource, /const anchorElement = heading\?\.element \|\| heading;/);
});

test("real headings remain authoritative when a model label is not grounded", () => {
  const { longReplyHeadings } = rendererOutlineFunctions();
  const first = fakeElement("H2", "Installation and prerequisites");
  const second = fakeElement("H2", "Runtime verification procedure");
  const row = {
    _longReplyOutline: [
      { label: "Unrelated forecast", anchor: "Installation and prerequisites", level: 2 },
      { label: "Runtime verify", anchor: "Runtime verification procedure", level: 2 }
    ],
    querySelector: () => null
  };
  const headings = longReplyHeadings(row, fakeRendered({ headings: [first, second] }));

  assert.equal(headings[0].textContent, "Installation and prerequisites");
  assert.equal(headings[1].textContent, "Runtime verify");
  assert.equal(headings[1]._outlineAnchor, "Runtime verification procedure");
});

test("paragraph summaries require a unique grounded anchor and ignore excluded content", () => {
  const { longReplyHeadings } = rendererOutlineFunctions();
  const first = fakeElement("P", "Prepare source documents before import.");
  const second = fakeElement("P", "Verify output files after export.");
  const excluded = fakeElement("P", "Verify output files after export.", { excluded: true });
  const outline = [
    { label: "Prepare docs", anchor: "Prepare source documents", level: 2 },
    { label: "Verify outputs", anchor: "Verify output files", level: 2 }
  ];
  const row = { _longReplyOutline: outline, querySelector: () => null };
  const headings = longReplyHeadings(row, fakeRendered({ headings: [], anchors: [first, second, excluded] }));

  assert.deepEqual(Array.from(headings, (item) => item.textContent), ["Prepare docs", "Verify outputs"]);

  const duplicateRow = { _longReplyOutline: outline, querySelector: () => null };
  const duplicate = fakeElement("P", "Prepare source documents for another import.");
  assert.equal(longReplyHeadings(duplicateRow, fakeRendered({ headings: [], anchors: [first, duplicate, second] })).length, 0);
});
