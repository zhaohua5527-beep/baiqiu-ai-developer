const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainJs = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("HMS initialization window can be minimized and closed by the user", () => {
  assert.match(mainJs, /minimizable:\s*true/);
  assert.match(mainJs, /frame:\s*true/);
  assert.match(mainJs, /可以关闭或最小化这个窗口，黑球会继续在后台安装/);
});

test("closing HMS initialization window hides progress UI without cancelling install", () => {
  assert.match(mainJs, /hmsInitializationWindow\.on\("close",\s*\(event\)\s*=>\s*{/);
  assert.match(mainJs, /event\.preventDefault\(\);/);
  assert.match(mainJs, /hmsInitializationWindow\.hide\(\);/);
});

test("normal app startup does not wait for HMS installation before opening main window", () => {
  assert.doesNotMatch(mainJs, /app\.whenReady\(\)\.then\(async \(\) => \{\s*await prepareBundledHmsRuntime\(\);/);

  const startupBlock = mainJs.slice(mainJs.indexOf("app.whenReady().then(async () => {"));
  assert(startupBlock.includes("const hmsRuntimePreparation = prepareBundledHmsRuntime();"));
  assert(startupBlock.indexOf("createWindow();") < startupBlock.indexOf("hmsRuntimePreparation.catch"));
});
