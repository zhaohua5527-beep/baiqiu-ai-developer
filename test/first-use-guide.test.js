"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("a fresh customer gets one persisted first-use guide state", () => {
  const initBlock = main.slice(main.indexOf('ipcMain.handle("app:init"'), main.indexOf('ipcMain.handle("voice:transcribe"'));
  assert.match(initBlock, /if \(!db\.sessions\.length\)/);
  assert.match(initBlock, /seedFirstLaunchWelcome\(session\.id\)/);
  assert.match(main, /db\.settings\.firstUseGuide = \{[\s\S]*?pending: true[\s\S]*?completedAt: ""/);
  assert.match(main, /ipcMain\.handle\("onboarding:first-use-guide-complete"/);
  assert.match(main, /pending: false/);
  assert.match(preload, /completeFirstUseGuide: \(\) => ipcRenderer\.invoke\("onboarding:first-use-guide-complete"\)/);
});

test("the guide is a dedicated searchable surface instead of a long chat message", () => {
  assert.match(html, /id="firstUseGuideDialog"/);
  assert.match(html, /id="firstUseGuideSearch"/);
  assert.match(html, /data-guide-page="knowledge"/);
  assert.match(html, /data-guide-page="conscious"/);
  assert.match(html, /知识星球：长期可复用的知识/);
  assert.match(html, /意识提取：保存可恢复的执行现场/);
  assert.match(html, /意识提取保存的是执行状态，不是黑球的内部推理/);
  assert.doesNotMatch(main, /\*\*先连接模型\*\*/);
  assert.doesNotMatch(main, /\*\*能力与使用说明\*\*/);
});

test("first-use automatic opening is gated by persisted pending state and customer profile", () => {
  assert.match(renderer, /function firstUseGuidePending\(\)/);
  assert.match(renderer, /guide\?\.pending === true && !guide\?\.completedAt/);
  assert.match(renderer, /if \(automatic && !firstUseGuidePending\(\)\) return false/);
  assert.match(renderer, /if \(automatic && customerProfileOverlay && !customerProfileOverlay\.hidden\) return false/);
  assert.match(renderer, /if \(!openFirstUseGuide\(\{ automatic: true \}\)\) void openUserProfileOnboarding/);
  assert.match(renderer, /completeFirstUseGuideOnce\(\)/);
});

test("guide search routes explanations and real destinations without sending chat text", () => {
  assert.match(renderer, /const FIRST_USE_GUIDE_ITEMS = Object\.freeze\(\[/);
  assert.match(renderer, /label: "知识星球是什么"[\s\S]*?section: "knowledge"/);
  assert.match(renderer, /label: "打开知识星球"[\s\S]*?target: "knowledge"/);
  assert.match(renderer, /label: "意识提取是什么"[\s\S]*?section: "conscious"/);
  assert.match(renderer, /case "knowledge": void openGrowthCenter\(\)/);
  assert.match(renderer, /case "conscious": openConsciousCenter\(\)/);
  assert.match(renderer, /case "model": openSetting\("model"\)/);
  assert.match(renderer, /firstUseGuideSearch\?\.addEventListener\("input", renderFirstUseGuideSearchResults\)/);
  assert.doesNotMatch(renderer.slice(renderer.indexOf("function activateFirstUseGuideItem"), renderer.indexOf("function openConsciousCenter")), /sendCurrentTask|submitProduct/);
});

test("guide layout is stable on desktop and collapses for narrow windows", () => {
  assert.match(css, /\.first-use-guide-dialog \{[\s\S]*?width: min\(1080px,[\s\S]*?height: min\(760px,/);
  assert.match(css, /\.first-use-guide-shell \{[\s\S]*?grid-template-columns: 224px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.first-use-guide-shell \{[\s\S]*?grid-template-columns: 1fr/);
  assert.match(css, /\.first-use-guide-results \{[\s\S]*?max-height: 300px/);
  assert.match(html, /id="firstUseGuideBtn"[\s\S]*?title="新手手册"/);
});
