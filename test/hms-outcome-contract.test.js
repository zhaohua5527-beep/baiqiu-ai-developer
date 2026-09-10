"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  evaluateHmsResponse,
  parseHmsOutcomeEnvelope,
  parseTrailingHmsProtocolObjects
} = require("../services/hms-outcome-contract");

test("parses HMS outcome without exposing the machine block", () => {
  const parsed = parseHmsOutcomeEnvelope('Done.\n<baiqiu-outcome>{"kind":"analysis","status":"completed","summary":"Done"}</baiqiu-outcome>');
  assert.equal(parsed.text, "Done.");
  assert.equal(parsed.hmsOutcome.status, "completed");
  assert.equal(parsed.hmsOutcome.kind, "analysis");
});

test("recovers complete trailing clarification and outcome lines without exposing JSON", () => {
  const parsed = parseTrailingHmsProtocolObjects([
    "需要先确认查询城市。",
    JSON.stringify({ question: "请确认要查询成都吗？", required: ["城市"], options: ["成都", "绵阳"] }),
    JSON.stringify({ kind: "analysis", status: "awaiting_input", summary: "等待城市确认", evidenceType: "none" })
  ].join("\n"));
  assert.equal(parsed.text, "需要先确认查询城市。");
  assert.equal(parsed.clarification.question, "请确认要查询成都吗？");
  assert.equal(parsed.hmsOutcome.status, "awaiting_input");
  const evaluated = evaluateHmsResponse({
    status: "partial",
    text: parsed.text,
    clarification: parsed.clarification,
    hmsOutcome: parsed.hmsOutcome
  }, { canonicalTask: true });
  assert.equal(evaluated.status, "awaiting_input");
  assert.equal(evaluated.success, true);
});

test("does not reinterpret ordinary or malformed JSON as HMS protocol", () => {
  assert.equal(parseTrailingHmsProtocolObjects('答案\n{"city":"成都","temperature":28}'), null);
  assert.equal(parseTrailingHmsProtocolObjects('答案\n{"kind":"analysis","status":"awaiting_input"'), null);
});

test("plain text cannot complete a canonical task", () => {
  const result = evaluateHmsResponse({ ok: true, text: "The workbook was generated on the desktop." }, { canonicalTask: true });
  assert.equal(result.success, false);
  assert.equal(result.error, "hms_outcome_missing");
});

test("presentation status is display-only and cannot complete a task", () => {
  const result = evaluateHmsResponse({
    ok: true,
    text: "Done",
    presentation: { status: "completed", summary: "Workbook created", files: [{ path: "C:/fake.xlsx" }] }
  }, { canonicalTask: true });
  assert.equal(result.success, false);
  assert.equal(result.error, "hms_outcome_missing");
});

test("inline text is complete evidence for a chat-delivered writing result", () => {
  const result = evaluateHmsResponse({
    ok: true,
    text: "# \u4f7f\u7528\u624b\u518c\n\n- \u5df2\u5b89\u88c5\u6280\u80fd\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u3002",
    hmsOutcome: {
      kind: "task",
      status: "completed",
      summary: "\u5df2\u5728\u5bf9\u8bdd\u6846\u4e2d\u8f93\u51fa\u5b8c\u6574\u4f7f\u7528\u624b\u518c",
      evidenceType: "none"
    }
  }, { canonicalTask: true });

  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
});

test("file completion requires real runtime evidence", () => {
  const withoutEvidence = evaluateHmsResponse({
    ok: true,
    text: "Workbook generated: result.xlsx",
    hmsOutcome: { kind: "file", status: "completed", summary: "Workbook generated" }
  }, { canonicalTask: true });
  assert.equal(withoutEvidence.success, false);
  assert.equal(withoutEvidence.error, "hms_effect_evidence_missing");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-outcome-file-"));
  try {
    const outputPath = path.join(root, "result.xlsx");
    const missingEvidence = evaluateHmsResponse({
      ok: true,
      text: "Workbook generated: result.xlsx",
      hmsOutcome: { kind: "file", status: "completed", summary: "Workbook generated" },
      raw: { toolCalls: [{ status: "completed", rawOutput: { success: true, outputPath } }] }
    }, { canonicalTask: true });
    assert.equal(missingEvidence.success, false);
    assert.equal(missingEvidence.error, "hms_file_evidence_missing");

    const disguisedMissingEvidence = evaluateHmsResponse({
      ok: true,
      text: "已生成桌面文件 result.xlsx",
      hmsOutcome: { kind: "task", status: "completed", summary: "文件已生成" },
      raw: { toolCalls: [{ status: "completed", rawOutput: { success: true } }] }
    }, { canonicalTask: true });
    assert.equal(disguisedMissingEvidence.success, false);
    assert.equal(disguisedMissingEvidence.error, "hms_file_evidence_missing");

    const multilingualMissingEvidence = evaluateHmsResponse({
      ok: true,
      text: "Workbook generated",
      hmsOutcome: { kind: "task", status: "completed", summary: "Workbook generated" },
      raw: { toolCalls: [{ status: "completed", rawOutput: { success: true, outputPath } }] }
    }, { canonicalTask: true });
    assert.equal(multilingualMissingEvidence.success, false);
    assert.equal(multilingualMissingEvidence.error, "hms_file_evidence_missing");

    fs.writeFileSync(outputPath, "real workbook evidence");
    const withEvidence = evaluateHmsResponse({
      ok: true,
      text: "Workbook generated: result.xlsx",
      hmsOutcome: { kind: "file", status: "completed", summary: "Workbook generated" },
      raw: { toolCalls: [{ status: "completed", rawOutput: { success: true, outputPath } }] }
    }, { canonicalTask: true });
    assert.equal(withEvidence.success, true);
    assert.equal(withEvidence.status, "completed");

    const withAcpTextEvidence = evaluateHmsResponse({
      ok: true,
      text: "Workbook generated",
      hmsOutcome: { kind: "file", status: "completed", summary: "Workbook generated" },
      raw: {
        toolCalls: [{
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: `Saved: ${outputPath} | rows: 12` } }]
        }]
      }
    }, { canonicalTask: true });
    assert.equal(withAcpTextEvidence.success, true);
    assert.equal(withAcpTextEvidence.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clarification keeps a canonical task awaiting input", () => {
  const result = evaluateHmsResponse({
    ok: true,
    text: "Which matching key should I use?",
    clarification: { preserveTask: true, question: "Which matching key should I use?" }
  }, { canonicalTask: true });
  assert.equal(result.success, true);
  assert.equal(result.status, "awaiting_input");
});
