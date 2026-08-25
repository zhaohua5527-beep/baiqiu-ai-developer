const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "index.html"), "utf8");

test("model management reuses an open dialog and reports missing configuration UI", () => {
  assert.match(appSource, /function openSettingsTab\(tab, mode = "external"\)/);
  assert.match(appSource, /if \(!settingsDialog\.open\) settingsDialog\.showModal\(\);/);
  assert.match(appSource, /function openModelConfigDrawer\(key = "deepseek", mode = "edit"\)/);
  assert.match(appSource, /模型配置无法打开，请重新进入模型管理/);
  assert.match(appSource, /requestAnimationFrame\(\(\) => \$\("modelConfigNameInput"\)\?\.focus\(\)\)/);
});

test("configured models expose a direct third-party entry with unique provider IDs", () => {
  assert.match(indexSource, /id="configureOtherModelBtn"[^>]*>＋ 配置其他模型<\/button>/);
  assert.match(appSource, /function createCustomProviderKey\(\)/);
  assert.match(appSource, /crypto\?\.randomUUID/);
  assert.match(appSource, /return `custom-\$\{suffix\}`\.toLowerCase\(\)/);
  assert.match(appSource, /configureOtherModelBtn\?\.addEventListener\("click", openOtherModelConfigDrawer\)/);
});

function functionSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}`);
  const end = appSource.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source block must exist`);
  return appSource.slice(start, end);
}

test("saving visible settings preserves the official update endpoint", () => {
  const source = functionSource("readSettingsFromDialog", "savePersona");
  assert.match(source, /settings\.update\s*=\s*\{\s*\.\.\.\(settings\.update\s*\|\|\s*\{\}\)/s);
  assert.doesNotMatch(source, /updateManifestInput|updateTarget/);
});

test("always-on web access has no missing toggle reference", () => {
  assert.doesNotMatch(appSource, /webSearchBtn|renderWebSearchMode/);
  assert.match(appSource, /settings\.webSearch\s*=\s*\{[\s\S]*?enabled:\s*true\s*\};/);
});

test("removed controls leave no dormant event handlers", () => {
  for (const id of ["chatMoreBtn", "skinBtn", "licenseBuyBtn", "updateManifestInput"]) {
    assert.equal(appSource.includes(id), false, `${id} must not remain as a dead renderer reference`);
  }
});

test("update settings never show a hard-coded release version", () => {
  assert.match(indexSource, /id="appVersion">读取中<\/b>/);
  assert.doesNotMatch(indexSource, /id="appVersion">\d+\.\d+\.\d+/);

  const source = functionSource("renderUpdateInfo", "renderUpdateStatus");
  assert.match(source, /appVersion\.textContent = "读取中"/);
  assert.match(source, /appVersion\.textContent = info\.currentVersion/);
  assert.match(source, /appVersion\.textContent = "读取失败"/);
});

test("title bar reports membership mode instead of a stale release label", () => {
  assert.doesNotMatch(appSource, /2\.1 测试版/);
  assert.match(appSource, /trialStatus\.textContent = "开发者模式"/);
});
