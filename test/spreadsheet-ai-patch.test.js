"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildSpreadsheetAiPrompt,
  buildSpreadsheetProfile,
  validateSpreadsheetAiPlan
} = require("../services/spreadsheet-ai-patch");

const ROWS = [
  ["Name", "Price", "Note"],
  [" A ", "12", " old "],
  ["A", "", "old-old"],
  ["A", "", "old-old"]
];

test("data profile reports columns, missing values, and duplicate rows", () => {
  const profile = buildSpreadsheetProfile(ROWS, { sourceEncoding: "gbk" });
  assert.equal(profile.sourceEncoding, "gbk");
  assert.equal(profile.rowCount, 4);
  assert.equal(profile.dataRowCount, 3);
  assert.equal(profile.columnCount, 3);
  assert.equal(profile.duplicateRowCount, 1);
  assert.equal(profile.columns[1].type, "number");
  assert.equal(profile.columns[1].missing, 2);
});

test("validated AI plans become bounded, reversible cell patches", () => {
  const plan = validateSpreadsheetAiPlan(ROWS, {
    summary: "Clean text and complete prices.",
    operations: [
      { type: "trim_cells", column: 0 },
      { type: "replace_text", column: 2, find: "old", replace: "new" },
      { type: "fill_empty", column: 1, value: "0" },
      { type: "rename_column", column: 2, value: "Remark" }
    ]
  });
  assert.equal(plan.affectedCells, 7);
  assert.deepEqual(plan.patches.find((item) => item.row === 1 && item.column === 0), { row: 1, column: 0, before: " A ", after: "A" });
  assert.deepEqual(plan.patches.find((item) => item.row === 2 && item.column === 2), { row: 2, column: 2, before: "old-old", after: "new-new" });
  assert.deepEqual(plan.patches.find((item) => item.row === 0 && item.column === 2), { row: 0, column: 2, before: "Note", after: "Remark" });
});

test("unsafe and malformed plan operations are rejected", () => {
  assert.throws(() => validateSpreadsheetAiPlan(ROWS, {
    operations: [{ type: "delete_file", column: 0 }]
  }), /Unsupported spreadsheet operation/);
  assert.throws(() => validateSpreadsheetAiPlan(ROWS, {
    operations: [{ type: "set_cell", row: 99, column: 0, value: "x" }]
  }), /outside the worksheet/);
});

test("AI prompt only exposes a bounded spreadsheet snapshot", () => {
  const prompt = buildSpreadsheetAiPrompt({ request: "Clean the sheet", rows: ROWS });
  assert.match(prompt, /Return one JSON object only/);
  assert.match(prompt, /Visible worksheet snapshot/);
  assert.match(prompt, /replace_text/);
});
