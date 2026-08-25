"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mainWindowBoundsForDisplay } = require("../services/window-size");

function display(width, height, x = 0, y = 0) {
  return { workArea: { width, height, x, y } };
}

test("normal window leaves visible desktop space on a 1366x768 laptop", () => {
  const bounds = mainWindowBoundsForDisplay(display(1366, 728));
  assert.deepEqual(bounds, { width: 1100, height: 612, minWidth: 960, minHeight: 580, x: 133, y: 58 });
});

test("window uses the selected display work area and centers on that display", () => {
  const bounds = mainWindowBoundsForDisplay(display(1920, 1040, 1920, 0));
  assert.deepEqual(bounds, { width: 1100, height: 680, minWidth: 960, minHeight: 580, x: 2330, y: 180 });
});

test("small displays lower the minimum size without exceeding the work area", () => {
  const compact = mainWindowBoundsForDisplay(display(800, 600));
  const narrow = mainWindowBoundsForDisplay(display(640, 480));
  assert.deepEqual(compact, { width: 768, height: 568, minWidth: 768, minHeight: 568, x: 16, y: 16 });
  assert.deepEqual(narrow, { width: 608, height: 448, minWidth: 608, minHeight: 448, x: 16, y: 16 });
});
