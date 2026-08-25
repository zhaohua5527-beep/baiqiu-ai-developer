"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildExecutionContinuationInput,
  hasReusableFileWorkset,
  isCompactExecutionConfirmation,
  recentExecutionTurn,
  selectReusableWorksetTask
} = require("../services/contextual-execution");

test("compact execution confirmations are recognized without matching questions", () => {
  for (const value of ["对的 执行", "好的 开始执行。", "那就继续执行", "可以生成吧"]) {
    assert.equal(isCompactExecutionConfirmation(value), true, value);
  }
  for (const value of ["执行超时原因是什么", "你执行了吗？", "这个表格怎么做"]) {
    assert.equal(isCompactExecutionConfirmation(value), false, value);
  }
});

test("recent execution turn keeps the concrete user directive and assistant proposal", () => {
  const turn = recentExecutionTurn([
    { role: "user", text: "旧任务" },
    { role: "assistant", text: "旧回复" },
    { role: "user", text: "按曝光>0、下单=0生成V4" },
    { role: "assistant", text: "我将按五个条件生成V4。" }
  ]);
  const input = buildExecutionContinuationInput({ confirmation: "对的 执行", ...turn });
  assert.match(input, /按曝光>0、下单=0生成V4/);
  assert.match(input, /按五个条件生成V4/);
  assert.match(input, /对的 执行/);
});

test("a spreadsheet workset wins over a newer text-only task", () => {
  const textOnly = { task_id: "newer", attachments: [] };
  const spreadsheet = {
    task_id: "bound-four-tables",
    attachments: [
      { name: "表1.xlsx" },
      { name: "表2.csv" },
      { name: "表3.xlsx" },
      { name: "表4.xlsx" }
    ]
  };
  assert.equal(hasReusableFileWorkset(textOnly), false);
  assert.equal(hasReusableFileWorkset(spreadsheet), true);
  assert.equal(selectReusableWorksetTask([textOnly, spreadsheet], "newer").task_id, "bound-four-tables");
});
