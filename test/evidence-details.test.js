"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { marked } = require("marked");
const codeUtils = require("../services/assistant-code-utils");
const resultAst = require("../services/result-ast");

function render(source) {
  return marked.parse(codeUtils.prepareAssistantMarkdownSource(source), {
    renderer: codeUtils.createAssistantMarkdownRenderer(marked.Renderer)
  });
}

test("only explicitly marked evidence collapses; conclusions and ordinary code stay visible", () => {
  const source = "关键文件齐全。\n\n```baiqiu-evidence\nOK tools/git.exe\nMISS optional/bash.exe\n```\n\n实际失败需要重试。\n\n```js\nconst result = 1;\n```\n\n```text\nOK unchanged\n```";
  const html = render(source);
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.match(html, /<details class="answer-evidence"><summary>展开<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /<p>关键文件齐全。<\/p>/);
  assert.match(html, /<\/details>\s*<p>实际失败需要重试。<\/p>/);
  assert.match(html, /class="language-js">const result = 1;/);
  assert.match(html, /class="language-text">OK unchanged/);
});

test("evidence is preserved through table and legacy code normalization", () => {
  const source = "```baiqiu-evidence\nname\tstatus\ngit\tOK\nconst diagnostic = 1;\n```";
  assert.equal(codeUtils.normalizeFencedTables(source), source);
  assert.equal(codeUtils.hideCodeBlocks(source), source);
  assert.deepEqual(codeUtils.extractCodeBlocks(source), []);
  const document = resultAst.createResultAst(source, { target: "answer", marked });
  assert.equal(resultAst.serializeResult(document, "markdown"), source);
  assert.match(resultAst.serializeResult(document), /const diagnostic = 1;/);
});

test("raw evidence HTML is escaped once and cannot create executable elements", () => {
  const source = '```baiqiu-evidence\n<script>alert(1)</script>\n<strong>raw</strong>\n<img src=x onerror="alert(1)">\n```';
  assert.equal(codeUtils.prepareAssistantMarkdownSource(source), source);
  const html = render(source);
  assert.doesNotMatch(html, /<(?:script|img|strong)\b/);
  assert.match(html, /&lt;strong&gt;raw&lt;\/strong&gt;/);
  assert.doesNotMatch(html, /&amp;lt;/);
});

test("an unfinished evidence fence remains collapsed while streaming and survives persistence", () => {
  const source = "结论保留。\n\n```baiqiu-evidence\nOK first\nOK second";
  for (let length = source.indexOf("OK first"); length <= source.length; length++) {
    const html = render(source.slice(0, length));
    assert.match(html, /<details class="answer-evidence">/);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  }
  const persisted = JSON.parse(JSON.stringify({ text: source + "\n```" }));
  assert.equal(render(persisted.text), render(source));
});

test("longer closing fences do not expose following HTML", () => {
  for (const delimiter of ["```", "~~~"]) {
    const source = `${delimiter}baiqiu-evidence\nOK\n${delimiter + delimiter}\n\n<script>alert(1)</script>`;
    const html = render(source);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<\/details>[\s\S]*&lt;script&gt;/);
  }
});

test("tilde evidence cannot be extracted as implicit code or swallow subsequent delivered code", () => {
  const evidence = "~~~baiqiu-evidence\nconst diagnostic = 1;\n~~~";
  assert.deepEqual(codeUtils.extractCodeBlocks(evidence), []);
  assert.equal(codeUtils.hideCodeBlocks(evidence), evidence);
  const source = evidence + "\n\n```js\nconst delivered = 2;\n```";
  assert.deepEqual(codeUtils.extractCodeBlocks(source), [{ language: "js", code: "const delivered = 2;" }]);
});

test("legacy verification fences collapse and ordinary implementation fences remain visible", () => {
  const source = [
    "1) C 盘版本实测",
    "```text",
    "DisplayVersion = 2.55.0.3",
    "```",
    "2) 执行命令确认路径",
    "```bash",
    "exec-path: F:/tools/git.exe",
    "```",
    "实现代码如下：",
    "```js",
    "1) keep this source code unchanged",
    "const result = true;",
    "```"
  ].join("\n");
  const prepared = codeUtils.prepareAssistantMarkdownSource(source);
  assert.match(prepared, /```baiqiu-evidence[\s\S]*DisplayVersion/);
  assert.match(prepared, /2\. 执行命令确认路径/);
  assert.match(prepared, /```js[\s\S]*const result/);
  const html = render(source);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.match(html, /<ol>/);
  assert.match(html, /class="language-js">1\) keep this source code unchanged\nconst result = true;/);
  assert.match(prepared, /1\) keep this source code unchanged/);
  assert.ok(!html.includes('<details class="answer-evidence"><summary>查看核验详情</summary><pre><code class="language-js">'));
  assert.match(html, /<pre><code class="language-js">1\) keep this source code unchanged\nconst result = true;/);
});

test("evidence body markers catch a second verification block without a matching heading", () => {
  const source = [
    "结论：F 盘可用。",
    "```plaintext",
    "OK tools/git/git-bash.exe",
    "OK tools/git/cmd/git.exe",
    "MISS tools/git/mingw64/bin/bash.exe",
    "```",
    "普通代码：",
    "```js",
    "const ok = true;",
    "```"
  ].join("\n");
  const html = render(source);
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.match(html, /<summary>展开<\/summary>/);
  assert.match(html, /class="language-js">const ok = true;/);
});
