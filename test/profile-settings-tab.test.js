"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");

function sourceBlock(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source block must exist`);
  return source.slice(start, end);
}

test("settings hub exposes a profile tab and page in the dialog", () => {
  assert.match(indexSource, /data-settings-tab="profile"[^>]*>\s*<span>我的资料<\/span>/);
  assert.match(indexSource, /class="settings-page profile-settings-page"[^>]*data-settings-page="profile"/);
});

test("profile page has the five onboarding inputs with stable ids", () => {
  for (const id of [
    "profileUserNameInput",
    "profilePrimaryUseInput",
    "profileRoleInput",
    "profileAssistantNameInput",
    "profileStyleInput"
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.match(indexSource, /id="saveProfileSettingsBtn"/);
});

test("renderer pre-fills profile inputs from the existing onboarding snapshot", () => {
  const render = sourceBlock(rendererSource, "function renderProfileSettingsInputs", "function readProfileSettingsInputs");
  assert.match(render, /currentUserProfileOnboarding\(\)/);
  assert.match(render, /profileUserNameInput\.value\s*=\s*profile\.userName/);
  assert.match(render, /profilePrimaryUseInput\.value\s*=\s*profile\.primaryUse/);
  assert.match(render, /profileRoleInput\.value\s*=\s*profile\.role/);
  assert.match(render, /profileAssistantNameInput\.value\s*=\s*profile\.assistantName/);
  assert.match(render, /profileStyleInput\.value\s*=\s*profile\.personality/);
});

test("save rewrites changed stages through the narrow user-profile IPC and never wipes untouched fields", () => {
  const save = sourceBlock(rendererSource, "async function saveProfileSettings", "function renderProviderDetails");
  assert.match(save, /api\.updateUserProfile\(\{ stage, value, skipped: false \}\)/);
  assert.match(save, /filter\(\(\[, next, prev\]\) => next !== prev\)/);
  assert.match(save, /renderUserProfileOnboardingEntry\(\)/);
  assert.match(save, /state\.onboardingProfile = result\.profile/);
  assert.doesNotMatch(save, /api\.saveSettings/);
});

test("renderSettings re-fills profile inputs and tab switch refreshes them", () => {
  assert.match(rendererSource, /renderProfileSettingsInputs\(\);/);
  const tabSwitch = sourceBlock(rendererSource, "function switchSettingsTab", "function setSettingsTabSummary");
  assert.match(tabSwitch, /if \(tab === "profile"\) renderProfileSettingsInputs\(\);/);
});

test("profile inputs do not mark the shared settings form dirty", () => {
  const listener = sourceBlock(rendererSource, 'settingsDialog?.querySelector("form")?.addEventListener("input"', 'settingsDialog?.querySelector("form")?.addEventListener("change"');
  assert.match(listener, /closest\('\[data-settings-page="profile"\]'\)/);
});

test("save button and Enter commit without triggering the shared save/close", () => {
  assert.match(rendererSource, /saveProfileSettingsBtn\?\.addEventListener\("click"/);
  assert.match(rendererSource, /if \(event\.key !== "Enter" \|\| event\.shiftKey\) return;/);
  assert.match(rendererSource, /void saveProfileSettings\(\);/);
});

test("profile tab summary reflects completion state", () => {
  assert.match(rendererSource, /setSettingsTabSummary\("profile", isUserProfileOnboardingComplete\(profile\)/);
});
