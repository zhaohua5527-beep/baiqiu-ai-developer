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

test("normal app startup opens the main window before starting HMS", () => {
  assert.doesNotMatch(mainJs, /app\.whenReady\(\)\.then\(async \(\) => \{\s*await prepareBundledHmsRuntime\(\);/);

  const startupBlock = mainJs.slice(mainJs.indexOf("app.whenReady().then(async () => {"));
  assert(startupBlock.includes("createWindow();"));
  assert(startupBlock.includes("void ensureHmsRuntimePreparation().catch"));
  assert(startupBlock.indexOf("createWindow();") < startupBlock.indexOf("void ensureHmsRuntimePreparation()"));
});

test("installed runtime starts the execution ACP lane during startup", () => {
  const preparationBlock = mainJs.slice(
    mainJs.indexOf("async function prepareBundledHmsRuntime"),
    mainJs.indexOf("function trayIconSourcePath")
  );
  assert.match(preparationBlock, /ensureHermesClient\(\)\.start\(\)/);
  assert.match(preparationBlock, /ensureHermesForegroundClient\(\)\.start\(\)/);
  assert.doesNotMatch(preparationBlock, /prewarmForegroundSession\(\)/);
  assert.doesNotMatch(preparationBlock, /prewarmVoiceStt\(\)/);
  assert.doesNotMatch(preparationBlock, /await ensureHermesClient\(\)\.start\(\)/);
  assert.doesNotMatch(preparationBlock, /await ensureHermesForegroundClient\(\)\.start\(\)/);
});

test("failed HMS preparation is not cached as a permanent startup failure", () => {
  const preparationBlock = mainJs.slice(
    mainJs.indexOf("function ensureHmsRuntimePreparation"),
    mainJs.indexOf("function trayIconSourcePath")
  );
  assert.match(preparationBlock, /if \(!result\?\.connected\) hmsRuntimePreparationPromise = null/);
  assert.match(preparationBlock, /hmsRuntimePreparationPromise = null;\s*throw error/);
});

test("HMS uses the active member entitlement instead of a second confirmation prompt", () => {
  const permissionBlock = mainJs.slice(
    mainJs.indexOf("async function requestHermesPermission"),
    mainJs.indexOf("function ensureHermesClient")
  );
  assert.match(permissionBlock, /memberToolEntitlement\(\)/);
  assert.match(permissionBlock, /hermesPermissionSelection\(params\.options \|\| \[\], "allow_once"\)/);
  assert.doesNotMatch(permissionBlock, /tool:confirmation-request/);
});
