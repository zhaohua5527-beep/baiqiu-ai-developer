"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const styleSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("sidebar keeps the Baiqiu brand and gives actions a clear hierarchy", () => {
  assert.match(indexSource, /<div class="sidebar-brand">\s*<img src="\.\/assets\/baiqiu-tray\.png" alt="白球 AI" decoding="async">\s*<strong>白球 AI<\/strong>/);
  const headStart = indexSource.indexOf('<div class="sessions-head">');
  const headEnd = indexSource.indexOf("</div>", headStart);
  const head = indexSource.slice(headStart, headEnd);
  assert.match(head, /id="newSessionBtn" class="sidebar-primary-action"/);
  assert.match(head, /id="batchManageBtn" class="sidebar-icon-action"/);
  assert.doesNotMatch(head, /newProjectBtn/);
});

test("new projects are created from the project section and status signals are semantic", () => {
  assert.match(appSource, /addProject\.classList\.add\("project-section-add"\)/);
  assert.match(appSource, /treeAction\("＋", "新建项目", \(\) => openProjectDialog\(\)\)/);
  assert.match(appSource, /empty\.textContent = query \? "没有匹配的项目" : "暂无项目"/);
  assert.match(appSource, /sidebar-status-spinner/);
  assert.match(appSource, /sidebar-status-unread/);
  assert.match(appSource, /sidebar-status-error/);
  assert.match(appSource, /return \{ label: "状态未知", tone: "created" \}/);
  assert.match(appSource, /const failureVisible = tone === "failed" && status\.noticeAcknowledged !== true/);
  assert.match(appSource, /indicator\.hidden = tone !== "running" && !failureVisible && signal !== "unread"/);
  assert.match(appSource, /acknowledgeSessionNotice\(resolvedSessionId\)/);
  assert.match(appSource, /SESSION_NOTICE_ACK_KEY/);
  assert.match(appSource, /function sessionNoticeRevision\(session\)/);
  assert.match(appSource, /execution\.runId[\s\S]*?execution\.taskId[\s\S]*?latestAssistant\.id/);
  assert.match(appSource, /session\?\.id !== state\.selectedSessionId/);
});

test("sidebar rows use one selected rail instead of outlined cards", () => {
  const blockStart = styleSource.lastIndexOf("/* Sidebar control hierarchy:");
  const block = styleSource.slice(blockStart);
  assert.match(block, /grid-template-columns: minmax\(0, 1fr\) 40px/);
  assert.match(block, /\.project-session-item\.active \{[\s\S]*?border-left-color: var\(--accent\)/);
  assert.match(block, /\.chat-section > \.session-item\.project-session-item \{[\s\S]*?border: 0 !important/);
  assert.match(block, /\.sidebar-status-spinner/);
});
