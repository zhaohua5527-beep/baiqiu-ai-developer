"use strict";

const { createHash } = require("node:crypto");

function clean(value, limit = 16000) {
  return String(value || "").replace(/\r/g, "").trim().slice(0, limit);
}

function sourceType(source = "") {
  if (/^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\//i.test(source)) return "github";
  if (/^https:\/\//i.test(source)) return "web";
  return "topic";
}

class SkillResearchLayer {
  async research({ name = "", source = "", body = "" } = {}) {
    const normalizedSource = clean(source, 2000);
    const material = clean(body || source);
    if (!clean(name || normalizedSource || material, 2000)) throw new Error("Skill research requires a name, source, or topic.");
    const type = sourceType(normalizedSource);
    const topic = clean(name || normalizedSource || material, 120);
    const kind = /磁盘|硬盘|disk|drive/i.test(`${topic} ${material}`) ? "disk"
      : /CPU|处理器/i.test(`${topic} ${material}`) ? "cpu"
        : /内存|RAM|memory/i.test(`${topic} ${material}`) ? "memory"
          : /端口|port/i.test(`${topic} ${material}`) ? "port"
            : /网络连接|网卡|network/i.test(`${topic} ${material}`) ? "network"
              : "knowledge";
    return {
      topic,
      requirement: clean(`Create a reusable global skill for: ${topic}`, 500),
      source: {
        type,
        value: normalizedSource || topic,
        managed: true,
        contentHash: createHash("sha256").update(material).digest("hex")
      },
      technicalApproach: {
        kind,
        runtime: "commonjs",
        entrypoint: "execute",
        returnContract: "{ success, result, error, evidence }"
      },
      generationAdvice: [
        "Generate one isolated CommonJS skill module.",
        "Declare a JSON Schema MANIFEST and an async execute function.",
        "Return verifiable evidence and never report success without a real result."
      ],
      testPlan: [
        "Confirm the skill file and MANIFEST exist.",
        "Confirm the global registry and runtime tool registration exist.",
        "Invoke the runtime tool with sample arguments.",
        "Invoke the skill through the product execution router and verify success."
      ],
      risks: type === "topic" && !material ? ["No source material was supplied."] : []
    };
  }
}

module.exports = { SkillResearchLayer, sourceType };
