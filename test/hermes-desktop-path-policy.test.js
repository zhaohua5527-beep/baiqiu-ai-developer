"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateHermesDesktopWrite,
  userRequestedDesktopCodeDelivery,
  userRequestedDesktopDelivery
} = require("../services/hermes-desktop-path-policy");

const desktopRoot = "C:\\Users\\Lenovo\\Desktop";

function permission(toolCall) {
  return { sessionId: "session-1", toolCall, options: [] };
}

test("desktop reads remain allowed", () => {
  const decision = evaluateHermesDesktopWrite(permission({
    kind: "read",
    title: "read_file",
    rawInput: { path: `${desktopRoot}\\source.xlsx` }
  }), { desktopRoot, allowDesktopDelivery: false });
  assert.equal(decision.blocked, false);
});

test("unrequested desktop writes are blocked", () => {
  const decision = evaluateHermesDesktopWrite(permission({
    kind: "edit",
    title: "write_file",
    rawInput: { path: `${desktopRoot}\\result.xlsx` }
  }), { desktopRoot, allowDesktopDelivery: false });
  assert.deepEqual(decision, { blocked: true, reason: "desktop_not_requested" });
});

test("helper scripts stay blocked when a final workbook was requested on desktop", () => {
  const decision = evaluateHermesDesktopWrite(permission({
    kind: "execute",
    title: "run_command",
    rawInput: { command: `Set-Content -Path '${desktopRoot}\\read_xlsx.py' -Value 'print(1)'` }
  }), { desktopRoot, allowDesktopDelivery: true, allowDesktopCodeDelivery: false });
  assert.deepEqual(decision, { blocked: true, reason: "desktop_intermediate_file" });
});

test("explicit final desktop workbook delivery remains allowed", () => {
  const decision = evaluateHermesDesktopWrite(permission({
    kind: "edit",
    title: "write_file",
    rawInput: { path: `${desktopRoot}\\筛选结果.xlsx` }
  }), { desktopRoot, allowDesktopDelivery: true, allowDesktopCodeDelivery: false });
  assert.equal(decision.blocked, false);
});

test("desktop request detection distinguishes delivery from reading", () => {
  assert.equal(userRequestedDesktopDelivery("读取桌面的七月表格并分析"), false);
  assert.equal(userRequestedDesktopDelivery("把最终表格保存到桌面"), true);
  assert.equal(userRequestedDesktopCodeDelivery("把 Python 脚本保存到桌面"), true);
  assert.equal(userRequestedDesktopCodeDelivery("把最终表格保存到桌面"), false);
});
