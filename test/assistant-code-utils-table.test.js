"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { marked } = require("marked");
const codeUtils = require("../services/assistant-code-utils");

const TSV_TABLE = [
  "```",
  "Product\tSales\tImpressions",
  "Fig snack\t3\t53",
  "Care pad\t2\t6",
  "```"
].join("\n");

test("CJK quoted emphasis retains exact content without touching code or unmatched markers", () => {
  const source = '把论点写到**"法律保留"**这一层，保留**普通重点**。\n\n`**"代码"**不变`\n\n~~~text\n**"围栏"**不变\n~~~\n\n未完成**重点';
  const html = marked.parse(codeUtils.prepareAssistantMarkdownSource(source), {
    gfm: true, tokenizer: codeUtils.createAssistantMarkdownTokenizer(marked.Tokenizer)
  });
  assert.match(html, /<strong>&quot;法律保留&quot;<\/strong>这一层/);
  assert.match(html, /<strong>普通重点<\/strong>/);
  assert.match(html, /<code>\*\*&quot;代码&quot;\*\*不变<\/code>/);
  assert.match(html, /\*\*&quot;围栏&quot;\*\*不变/);
  assert.match(html, /未完成\*\*重点/);
});

test("fenced TSV tables become GFM tables instead of hidden code", () => {
  const normalized = codeUtils.normalizeFencedTables(TSV_TABLE);
  assert.match(normalized, /\| Product \| Sales \| Impressions \|/);
  assert.match(normalized, /\| --- \| --- \| --- \|/);
  assert.equal(codeUtils.extractCodeBlocks(TSV_TABLE).length, 0);
  assert.equal(codeUtils.hideCodeBlocks(TSV_TABLE).includes(codeUtils.HIDDEN_CODE_LABEL), false);
});

test("fenced Markdown tables remain table content", () => {
  const source = [
    "```markdown",
    "| Product | Sales |",
    "| --- | ---: |",
    "| Fig snack | 3 |",
    "```"
  ].join("\n");
  assert.match(codeUtils.hideCodeBlocks(source), /\| Product \| Sales \|/);
  assert.equal(codeUtils.extractCodeBlocks(source).length, 0);
});

test("real code remains hidden and copyable", () => {
  const source = "```js\nconst rows = [{ product: 'Fig snack' }];\n```";
  const blocks = codeUtils.extractCodeBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].language, "js");
  assert.equal(codeUtils.hideCodeBlocks(source).includes(codeUtils.HIDDEN_CODE_LABEL), true);
});

test("older persisted table code blocks are restored as tables", () => {
  const restored = codeUtils.restoreHiddenTableBlocks(
    `Result\n${codeUtils.HIDDEN_CODE_LABEL}`,
    [{ language: "code", code: "Product\tSales\nFig snack\t3" }]
  );
  assert.match(restored, /\| Product \| Sales \|/);
  assert.equal(restored.includes(codeUtils.HIDDEN_CODE_LABEL), false);
});

test("provider emphasis, blockquotes and GFM tables render while raw HTML stays escaped", () => {
  const source = [
    "This is <strong>important</strong>.",
    "",
    "> Quoted evidence",
    "",
    "| Item | Value |",
    "| --- | ---: |",
    "| Result | 40% |",
    "",
    "<script>alert('blocked')</script>"
  ].join("\n");
  const prepared = codeUtils.prepareAssistantMarkdownSource(source);
  const html = marked.parse(prepared, { gfm: true, breaks: true });

  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /<blockquote>[\s\S]*Quoted evidence[\s\S]*<\/blockquote>/);
  assert.match(html, /<table>[\s\S]*<td[^>]*>40%<\/td>[\s\S]*<\/table>/);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/i);
});

test("numeric ranges keep single tildes while double tildes remain deletion markup", () => {
  const renderer = codeUtils.createAssistantMarkdownRenderer(marked.Renderer);
  const html = marked.parse(
    "降雨概率 4~6 成，降水量 0.1~0.4mm；~~旧数据~~。",
    { gfm: true, breaks: true, renderer }
  );

  assert.match(html, /4~6 成/);
  assert.match(html, /0\.1~0\.4mm/);
  assert.match(html, /<del>旧数据<\/del>/);
  assert.doesNotMatch(html, /<del>6 成/);
});

test("tilde characters inside inline and fenced code remain untouched", () => {
  const renderer = codeUtils.createAssistantMarkdownRenderer(marked.Renderer);
  const html = marked.parse(
    "`npm install package@~1.0`\n\n```text\n~~~\n```",
    { gfm: true, breaks: true, renderer }
  );

  assert.match(html, /<code>npm install package@~1\.0<\/code>/);
  assert.match(html, /<code class="language-text">~~~\n<\/code>/);
});
