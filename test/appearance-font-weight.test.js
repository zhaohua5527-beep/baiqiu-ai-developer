"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

test("font weight control exposes three readable persisted levels", () => {
  const fontSizePosition = indexSource.indexOf('id="fontSizeInput"');
  const fontWeightPosition = indexSource.indexOf('id="fontWeightInput"');

  assert.ok(fontSizePosition >= 0 && fontWeightPosition > fontSizePosition);
  assert.match(indexSource, /id="fontWeightInput"[^>]*min="400"[^>]*max="600"[^>]*step="100"[^>]*value="400"/);
  assert.match(indexSource, /常规[\s\S]*清晰[\s\S]*加粗/);
  assert.match(rendererSource, /appearance: \{ skin: "custom", fontSize: 16, fontWeight: 400 \}/);
  assert.match(mainSource, /fontSize: 16,\s*fontWeight: 400,/);
  assert.match(rendererSource, /fontWeight: normalizeChatFontWeight\(fontWeightInput\?\.value/);
});

test("font weight is normalized and scoped to conversation reading content", () => {
  const normalizer = rendererSource.slice(
    rendererSource.indexOf("function normalizeChatFontWeight"),
    rendererSource.indexOf("function applyAppearance")
  );

  assert.match(normalizer, /Number\.isFinite/);
  assert.match(normalizer, /Math\.max\(400, Math\.min\(600,/);
  assert.match(rendererSource, /setProperty\("--chat-font-weight", String\(chatFontWeight\)\)/);
  assert.match(stylesSource, /\.message\.user \.bubble\s*\{[\s\S]*?font-weight: var\(--chat-font-weight, 400\);/);
  assert.match(stylesSource, /\.execution-activity-details\s*\{[\s\S]*?font-weight: var\(--chat-font-weight, 400\);/);
  assert.match(stylesSource, /\.rendered :is\(pre, code\) \{ font-weight: 400; \}/);
  assert.match(stylesSource, /\.execution-activity-whimsy\s*\{[\s\S]*?font-weight: 600;/);
  assert.doesNotMatch(stylesSource, /body\s*\{[^}]*font-weight: var\(--chat-font-weight/);
});
