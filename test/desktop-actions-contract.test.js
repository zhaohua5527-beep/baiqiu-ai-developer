"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const tools = require(path.join(root, "tools", "desktop-actions")).createTools();

test("desktop actions use Windows SendInput and return observable verification evidence", () => {
  for (const id of ["desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]) {
    assert.ok(tools.some((tool) => tool.id === id), `${id} is registered`);
  }
  assert.match(mainSource, /\[DllImport\("user32\.dll"\)\] public static extern uint SendInput/);
  assert.match(mainSource, /async function executeDesktopAction/);
  assert.match(mainSource, /async function executeDesktopType/);
  assert.match(mainSource, /async function executeDesktopKey/);
  assert.match(mainSource, /async function executeDesktopScroll/);
  assert.match(mainSource, /foregroundHwnd: observed\?\.foreground \|\| 0/);
  assert.match(mainSource, /cursor: observed \? \{ x: observed\.x, y: observed\.y \} : null/);
  assert.match(mainSource, /executeDesktopAction,\s*\n\s*executeDesktopType,\s*\n\s*executeDesktopKey,\s*\n\s*executeDesktopScroll,/);
});
