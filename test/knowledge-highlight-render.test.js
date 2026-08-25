"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("knowledge list renders summary through the shared safe highlighter", () => {
  assert.match(htmlSource, /services\/knowledge\/knowledge-keyline\.js/);
  assert.match(appSource, /class="knowledge-note-summary">\$\{knowledgeMarkedHtml\(knowledgeSummaryText\(note\), \{ summaryMode: true \}\)\}/);
  assert.match(cssSource, /\.knowledge-note-summary/);
  assert.match(cssSource, /\.knowledge-keyline/);
});

test("knowledge body has distinct preview and editing states", () => {
  assert.match(htmlSource, /id="knowledgeBodyPreview"/);
  assert.match(htmlSource, /id="editKnowledgeNoteBtn"/);
  assert.match(appSource, /function renderKnowledgeBodyPreview/);
  assert.match(appSource, /setKnowledgeEditorMode\(!knowledgeEditorEditing/);
  assert.match(cssSource, /\.knowledge-body-preview/);
});
