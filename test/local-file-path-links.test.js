"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("local file paths open an inline preview and retain explicit external-open actions", () => {
  const start = source.indexOf("function localFilePathFromText");
  const end = source.indexOf("function enhanceHiddenCodeBlocks", start);
  const block = source.slice(start, end);
  assert.match(block, /A-Za-z\]:\[\\\\\//);
  assert.match(block, /dataset\.localFilePath/);
  assert.match(block, /openConversationFilePreview\(rendered, pathValue\)/);
  assert.match(block, /api\.openPath\(pathValue\)/);
  assert.match(block, /closest\("a, button, pre/);
  assert.match(block, /inlineCode\.textContent\.trim\(\) !== pathValue/);
  assert.match(block, /showCopyToast/);
});

test("path links are bound before ordinary URL routing", () => {
  const start = source.indexOf("function bindRenderedLinks");
  const block = source.slice(start, source.indexOf("function enhanceHiddenCodeBlocks", start));
  assert.match(block, /bindLocalFilePathLinks\(rendered\);/);
  assert.match(block, /querySelectorAll\("a\[href\]"\)/);
  assert.match(block, /if \(link\.dataset\.localFilePath\) return/);
});
