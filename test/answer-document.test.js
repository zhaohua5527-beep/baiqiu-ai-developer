"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const answerDocument = require("../services/answer-document");

test("normalizes explicit answer block roles without inventing headings", () => {
  const normalized = answerDocument.normalizeAnswerDocument({
    schemaVersion: 1,
    blocks: [
      { index: 0, role: "heading", level: 2 },
      { index: 1, role: "paragraph" },
      { index: 2, role: "note" },
      { index: 3, role: "unknown" },
      { index: 2, role: "lead" }
    ]
  });
  assert.deepEqual(normalized, {
    protocol: "baiqiu-answer-document/1.0",
    schemaVersion: 1,
    blocks: [
      { index: 0, role: "heading", level: 2 },
      { index: 1, role: "paragraph" },
      { index: 2, role: "note" }
    ]
  });
});

test("extracts metadata while preserving the authored Markdown source", () => {
  const source = [
    "## 修复方案",
    "",
    "**123** 仍然是普通加粗文字。",
    "",
    "<baiqiu-answer-document>{\"schemaVersion\":1,\"blocks\":[{\"index\":0,\"role\":\"heading\",\"level\":2},{\"index\":1,\"role\":\"paragraph\"}]}</baiqiu-answer-document>"
  ].join("\n");
  const extracted = answerDocument.extractAnswerDocumentEnvelope(source);
  assert.equal(extracted.found, true);
  assert.equal(extracted.text, "## 修复方案\n\n**123** 仍然是普通加粗文字。");
  assert.equal(extracted.answerDocument.blocks[0].role, "heading");
  assert.equal(extracted.answerDocument.blocks[1].role, "paragraph");
});

test("invalid metadata is removed from display and does not create semantic roles", () => {
  const extracted = answerDocument.extractAnswerDocumentEnvelope(
    "普通正文\n<baiqiu-answer-document>{\"schemaVersion\":99,\"blocks\":[{\"index\":0,\"role\":\"heading\"}]}</baiqiu-answer-document>"
  );
  assert.equal(extracted.answerDocument, null);
  assert.equal(extracted.text, "普通正文");
});

test("message metadata is read from the durable product result", () => {
  const document = answerDocument.documentFromMessage({
    raw: {
      productResult: {
        answerDocument: {
          schemaVersion: 1,
          blocks: [{ index: 0, role: "note" }]
        }
      }
    }
  });
  assert.equal(document.blocks[0].role, "note");
});
