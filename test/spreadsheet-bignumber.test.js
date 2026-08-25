"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { spreadsheetCellValue } = require("../services/spreadsheet-cell-value");

test("small integers stay numbers", () => {
  assert.equal(spreadsheetCellValue("42"), 42);
  assert.equal(spreadsheetCellValue("0"), 0);
  assert.equal(spreadsheetCellValue("-7"), -7);
  assert.equal(spreadsheetCellValue("3.14"), 3.14);
});

test("max safe integer stays a number", () => {
  assert.equal(spreadsheetCellValue("9007199254740991"), Number.MAX_SAFE_INTEGER);
});

test("integers beyond max safe stay strings (no precision loss)", () => {
  assert.equal(spreadsheetCellValue("9007199254740992"), "9007199254740992");
  assert.equal(spreadsheetCellValue("12345678901234567890"), "12345678901234567890");
  assert.equal(spreadsheetCellValue("-9007199254740992"), "-9007199254740992");
});

test("large decimals beyond max safe stay strings", () => {
  assert.equal(spreadsheetCellValue("12345678901234567890.50"), "12345678901234567890.50");
});

test("leading zeros stay strings", () => {
  assert.equal(spreadsheetCellValue("0123"), "0123");
  assert.equal(spreadsheetCellValue("00123456"), "00123456");
});

test("non-numeric and empty values pass through", () => {
  assert.equal(spreadsheetCellValue("ABC123"), "ABC123");
  assert.equal(spreadsheetCellValue("2026-08-02"), "2026-08-02");
  assert.equal(spreadsheetCellValue(""), null);
  assert.equal(spreadsheetCellValue(null), null);
  assert.equal(spreadsheetCellValue(undefined), null);
});
