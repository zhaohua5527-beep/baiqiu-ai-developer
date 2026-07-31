"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const stylesheet = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");

test("sidebar project and chat labels use the stronger Chinese typography layer", () => {
  const typographyBlock = stylesheet.slice(
    stylesheet.lastIndexOf("/* Sidebar hierarchy stays compact while making Chinese labels easier to scan. */"),
    stylesheet.indexOf(".project-ceo-row > .project-session-item:has", stylesheet.lastIndexOf("/* Sidebar hierarchy stays compact while making Chinese labels easier to scan. */"))
  );

  assert.match(typographyBlock, /"Microsoft YaHei UI", "Microsoft YaHei"/);
  assert.match(typographyBlock, /\.tree-section-label \{\s*font-size: 11px;\s*font-weight: 700;/);
  assert.match(typographyBlock, /\.project-row > strong,\s*\.project-session-name \{\s*font-family: "Microsoft YaHei", "Microsoft YaHei UI"[\s\S]*?font-size: 12px;\s*font-weight: 700;[\s\S]*?-webkit-text-stroke: 0\.12px currentColor;/);
  assert.match(typographyBlock, /\.project-session-name\[data-name-density="compact"\] \{ font-size: 11px; \}/);
  assert.match(typographyBlock, /\.project-session-name\[data-name-density="tight"\] \{ font-size: 10px; \}/);
});
