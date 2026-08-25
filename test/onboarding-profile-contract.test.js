"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");

function sourceBlock(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source block must exist`);
  return source.slice(start, end);
}

test("profile onboarding has a durable stage schema and narrow IPC", () => {
  assert.match(mainSource, /userProfile:\s*\{[\s\S]*?primaryUse:\s*""[\s\S]*?role:\s*""[\s\S]*?onboarding:/);
  assert.match(preloadSource, /userProfile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("user-profile:get"\)/);
  assert.match(preloadSource, /updateUserProfile:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\("user-profile:update"/);

  const ipc = sourceBlock(mainSource, 'ipcMain.handle("user-profile:get"', 'ipcMain.handle("settings:save"');
  assert.match(ipc, /applyUserProfileOnboardingAnswer/);
  assert.match(ipc, /saveDb\(db\)/);
  assert.doesNotMatch(ipc, /syncHermesRuntimeConfig|refreshCapabilities|ensureHermes/);
});

test("each answer advances once and writes persona fields into the existing mechanism", () => {
  const apply = sourceBlock(mainSource, "function applyUserProfileOnboardingAnswer", "const LEGACY_PERSONA_ROLE");
  for (const stage of ["userName", "primaryUse", "role", "assistantName", "style"]) {
    assert.match(apply, new RegExp(`stage === "${stage}"`));
  }
  assert.match(apply, /settings\.personaMemory\.userName\s*=/);
  assert.match(apply, /settings\.personaMemory\.assistantName\s*=/);
  assert.match(apply, /settings\.persona\.personality\s*=/);
  assert.match(apply, /settings\.persona\.replyStyle\s*=/);
  assert.match(apply, /profile\.onboarding\.completed\s*=/);
  assert.match(apply, /profile\.onboarding\.stage\s*=\s*USER_PROFILE_ONBOARDING_STAGES\.find/);
  assert.match(apply, /syncPersonaMemory\(settings\)/);
});

test("onboarding cards reuse the intent prediction rows one for one", () => {
  const render = sourceBlock(rendererSource, "function renderUserProfileOnboardingCard", "async function openUserProfileOnboarding");
  assert.match(render, /className = `intent-predict-row/);
  assert.match(render, /className = "intent-predict-row custom"/);
  assert.match(render, /className = "intent-predict-row refuse"/);
  assert.match(render, /intent-predict-key/);
  assert.match(render, /intent-predict-text/);
  assert.match(render, /intent-predict-badge/);
  assert.match(render, /intent-predict-custom-input/);
  assert.doesNotMatch(render, /intentPredictEnabled/);
});

test("onboarding can be closed without erasing progress and resumes on startup", () => {
  const abortHandler = sourceBlock(rendererSource, 'composerClarificationAbort?.addEventListener("click"', 'queueClearBtn?.addEventListener');
  assert.match(abortHandler, /if \(state\.onboardingOpen\)/);
  assert.match(abortHandler, /clearComposerClarification\(\)/);
  assert.doesNotMatch(abortHandler, /updateUserProfile/);

  assert.match(rendererSource, /await renderAll\(\);[\s\S]*?void openUserProfileOnboarding\(\{ automatic: true \}\);/);
  assert.match(rendererSource, /profile\.onboarding\?\.stage/);
  assert.match(rendererSource, /profileOnboardingBtn\?\.addEventListener\("click"/);
});

test("completed onboarding removes the profile entry", () => {
  assert.match(indexSource, /id="profileOnboardingBtn"[\s\S]*?hidden/);
  const entry = sourceBlock(rendererSource, "function renderUserProfileOnboardingEntry", "async function saveUserProfileOnboardingAnswer");
  assert.match(entry, /profileOnboardingBtn\.hidden = isUserProfileOnboardingComplete\(profile\)/);
  assert.match(rendererSource, /profile\.onboarding\?\.stage === "done"/);
});
