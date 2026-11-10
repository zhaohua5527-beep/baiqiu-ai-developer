"use strict";

const BLOCKED_SKILL_CODE = Object.freeze([
  { label: "exec(", pattern: /\bexec\s*\(/i },
  { label: "spawn(", pattern: /\bspawn\s*\(/i },
  { label: "spawnSync", pattern: /\bspawnSync\s*\(/i },
  { label: "rmSync", pattern: /\brmSync\s*\(/i },
  { label: "unlinkSync", pattern: /\bunlinkSync\s*\(/i },
  { label: "rmdirSync", pattern: /\brmdirSync\s*\(/i },
  { label: "Remove-Item", pattern: /(?:^|[\r\n;&|]\s*)Remove-Item\b/im },
  { label: "del", pattern: /(?:^|[\r\n;&|]\s*)del(?:\.exe)?(?:\s|$)/im },
  { label: "format", pattern: /(?:^|[\r\n;&|]\s*)format(?:\.com)?(?:\s|$)/im },
  { label: "shutdown", pattern: /(?:^|[\r\n;&|]\s*)shutdown(?:\.exe)?(?:\s|$)/im },
  { label: "reg delete", pattern: /(?:^|[\r\n;&|]\s*)reg(?:\.exe)?\s+delete\b/im },
  { label: "Clear-RecycleBin", pattern: /(?:^|[\r\n;&|]\s*)Clear-RecycleBin\b/im }
]);

function detectUnsafeSkillCode(code = "") {
  const text = String(code || "");
  return BLOCKED_SKILL_CODE.find((entry) => entry.pattern.test(text))?.label || "";
}

module.exports = { detectUnsafeSkillCode, BLOCKED_SKILL_CODE };
