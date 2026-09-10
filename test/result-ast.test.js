"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { marked } = require("marked");
const resultAst = require("../services/result-ast");
const codeUtils = require("../services/assistant-code-utils");

const SOURCE = [
  "# Report",
  "",
  "A **verified** result with `inline` data.",
  "",
  "- first",
  "- second",
  "",
  "| Item | Value |",
  "| --- | ---: |",
  "| result | 40% |",
  "",
  "> quoted evidence",
  "",
  "```js",
  "const value = 40;",
  "```"
].join("\n");

function create(source = SOURCE, envelope = {}) {
  return resultAst.createResultAst(source, {
    target: "answer",
    envelope: { turnId: "turn-1", eventId: "answer-1", sequence: 7, segmentId: "segment-1", ...envelope },
    marked
  });
}

test("Result AST is opt-in for answer events and retains the event envelope", () => {
  assert.equal(resultAst.createResultAst("hidden", { target: "execution", marked }), null);
  assert.equal(resultAst.createResultAst("hidden", { target: "structured", marked }), null);
  assert.equal(resultAst.createResultAst("hidden", { marked }), null);
  const document = create();
  assert.equal(document.target, "answer");
  assert.equal(document.turnId, "turn-1");
  assert.equal(document.eventId, "answer-1");
  assert.equal(document.sequence, 7);
  assert.equal(document.segmentId, "segment-1");
  assert.equal(document.source, SOURCE);
});

test("Result AST preserves Markdown structure without inventing business semantics", () => {
  const document = create();
  assert.deepEqual(document.children.map((node) => node.type), [
    "Heading", "Paragraph", "List", "Table", "Blockquote", "CodeBlock"
  ]);
  assert.equal(document.children[0].level, 1);
  assert.equal(document.children[1].children[1].type, "Strong");
  assert.equal(document.children[1].children[3].type, "InlineCode");
  assert.equal(document.children.some((node) => ["Summary", "Status", "Alert", "KeyValue", "Steps"].includes(node.type)), false);
});

test("Result serializers preserve Markdown, code, tables, and clean plain text", () => {
  const document = create();
  const table = document.children.find((node) => node.type === "Table");
  const code = document.children.find((node) => node.type === "CodeBlock");
  assert.equal(resultAst.serializeResult(document, "markdown"), SOURCE);
  assert.equal(resultAst.serializeResultNode(table, "tsv"), "Item\tValue\nresult\t40%");
  assert.equal(resultAst.serializeResultNode(code, "code"), "const value = 40;");
  assert.match(resultAst.serializeResult(document), /- first\n- second/);
  assert.doesNotMatch(resultAst.serializeResult(document), /复制此内容|小剧场|执行状态/);
});

test("empty answers stay empty and provider HTML remains escaped by the existing renderer pipeline", () => {
  const empty = create("");
  assert.deepEqual(empty.children, []);
  assert.equal(resultAst.serializeResult(empty, "markdown"), "");
  const prepared = codeUtils.prepareAssistantMarkdownSource("<script>alert(1)</script>");
  const html = marked.parse(prepared, { gfm: true, breaks: true });
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/i);
});

test("renderer integration is scoped to answer result roots", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
  assert.ok(html.indexOf("../services/result-ast.js") < html.indexOf("./app.js"));
  assert.match(app, /createResultAst\?\.\(source, \{\s*target: "answer"/);
  assert.doesNotMatch(app, /result-node-copy|复制此内容/);
  assert.doesNotMatch(css, /result-node-copy|result-node-shell/);
  assert.match(app, /ensureAssistantCopyAction\(bubble/);
  assert.match(css, /\.result-region\.result-document/);
  assert.doesNotMatch(css, /(?:^|\n)\.rendered\s*\{[^}]*--result-title-size/s);
});
