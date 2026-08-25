"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createStandaloneTaskCountBadge,
  drawTaskCountBadge,
  isTaskCompletionTransition,
  trayBadgeText
} = require("../services/tray-icon-badge");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const trayPopupHtml = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "tray-popup.html"), "utf8");

function rgbaAt(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return {
    blue: bitmap[offset],
    green: bitmap[offset + 1],
    red: bitmap[offset + 2],
    alpha: bitmap[offset + 3]
  };
}

test("unread state is binary and never renders a numeric glyph", () => {
  assert.equal(trayBadgeText(0), "");
  assert.equal(trayBadgeText(1), "unread");
  assert.equal(trayBadgeText(137), "unread");
});

test("tray badge paints a restrained brand-blue dot with a light border", () => {
  const width = 32;
  const height = 32;
  const source = Buffer.alloc(width * height * 4, 0);
  const clear = drawTaskCountBadge(source, width, height, 0);
  const unread = drawTaskCountBadge(source, width, height, 42);
  assert.deepEqual(clear, source);
  assert.deepEqual(rgbaAt(unread, width, 27, 4), { blue: 235, green: 99, red: 37, alpha: 255 });
  assert.deepEqual(rgbaAt(unread, width, 27, 2), { blue: 255, green: 255, red: 255, alpha: 255 });
  assert.deepEqual(rgbaAt(unread, width, 0, 0), { blue: 0, green: 0, red: 0, alpha: 0 });
});

test("taskbar overlay uses the same dot state and completion transition remains exact", () => {
  assert.equal(createStandaloneTaskCountBadge(0), null);
  const badge = createStandaloneTaskCountBadge(3);
  assert.equal(badge.width, 7);
  assert.equal(badge.height, 7);
  assert.ok([...badge.bitmap].some(Boolean));
  assert.equal(isTaskCompletionTransition("running", "completed"), true);
  assert.equal(isTaskCompletionTransition("completed", "completed"), false);
});

test("foreground completion is read immediately while background sessions remain unread", () => {
  assert.match(mainSource, /onComplete: \(task\) => recordCompletedTaskForTray\(task\)/);
  assert.match(mainSource, /const unreadCompletedTasksBySession = new Map\(\)/);
  assert.match(mainSource, /if \(selectedSessionIsVisible\(sessionId\)\) \{[\s\S]*?clearCompletedTaskTrayCount\(sessionId\);[\s\S]*?return;/);
  assert.match(mainSource, /ipcMain\.handle\("session:select",[\s\S]*?clearCompletedTaskTrayCount\(id\);/);
  assert.doesNotMatch(mainSource, /mainWindow\.on\("minimize", clearCompletedTaskTrayCount\)/);
});

test("tray popup uses Baiqiu Chinese actions without uninstall or hide", () => {
  assert.match(mainSource, /tray\.on\("click", showWindow\)/);
  assert.match(mainSource, /tray\.on\("right-click", showTrayPopup\)/);
  assert.doesNotMatch(mainSource, /Show \/ Hide|Uninstall Baiqiu AI|launchInstalledUninstaller|label: "Exit"/);
  assert.match(trayPopupHtml, />显示白球</);
  assert.match(trayPopupHtml, />退出白球</);
  assert.doesNotMatch(trayPopupHtml, />\s*(?:卸载|隐藏|Show|Exit|Codex)/i);
  assert.match(trayPopupHtml, /background: #ffffff/);
  assert.match(trayPopupHtml, /color: #165dcc/);
});
