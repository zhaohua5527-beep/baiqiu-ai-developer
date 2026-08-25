"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HermesSkillLearningManager, skillTargetFromRequest } = require("../services/hermes-skill-learning-manager");

// task-042 HMS 架构修复验证：
// 1. skill-service list() 的 availability 区分 verified/declared（假 READY 识别）
// 2. 技能清单不再按白球权限档过滤
// 3. 技能语义由黑球判断，不走白球直接学习分支
// 4. 技能验证器禁止安装依赖

test("skill availability reflects verification results", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "hermes-skill-service.js"), "utf8");
  const fnStart = src.indexOf("  list() {", src.indexOf("class HermesSkillService"));
  assert.ok(fnStart >= 0, "list() must exist");
  const segment = src.slice(fnStart, fnStart + 1100);
  // availability 必须区分 verified / declared
  assert.ok(segment.includes('availability = "verified"'), "verified availability on real check");
  assert.match(segment, /availability = compatible \? "declared" : "platform_incompatible"/s, "declared fallback preserved");
  assert.ok(segment.includes("lastCheck?.success === true"), "uses verification result");
});

test("runtimeSkillList is not filtered by White Ball access modes", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const listStart = mainSource.indexOf("function listSkills()");
  const runtimeStart = mainSource.indexOf("function runtimeSkillList");
  const runtimeEnd = mainSource.indexOf("function listSkills", runtimeStart);
  assert.doesNotMatch(mainSource.slice(runtimeStart, runtimeEnd), /accessMode|HIGH_RISK_SKILL_IDS|skillVisibleInMode/);
  assert.doesNotMatch(mainSource.slice(listStart, listStart + 400), /accessMode|currentToolAccessMode/);
});

test("ordinary skill language cannot route to White Ball direct learning", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function submitProductWithTaskBrain");
  const end = mainSource.indexOf("function ensureProductExecutionRouter", start);
  const product = mainSource.slice(start, end);
  assert.match(product, /blackBallOwnedUnderstanding/);
  assert.doesNotMatch(product, /learnSkillDirectReply|isSkillLearningRequest|skill_management/);
});

test("skill verifier forbids installing dependencies", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "hermes-skill-learning-manager.js"), "utf8");
  const marker = "Do not install or download any package";
  assert.ok(src.includes(marker), "verifier must not install deps");
  const fnStart = src.indexOf("async verify(installed, candidate, onProgress)");
  assert.ok(fnStart >= 0, "verify must exist");
  const seg = src.slice(fnStart, fnStart + 1500);
  assert.match(seg, /Do not install or download any package/, "verifier must not install deps");
  assert.match(seg, /report the missing dependency as the result/, "missing dep reported as result");
});

test("refreshCapabilities publishes the complete runtime skill list", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("function refreshCapabilities()");
  const seg = mainSource.slice(fnStart, fnStart + 400);
  assert.match(seg, /skills: runtimeSkillList\(\)/);
  assert.doesNotMatch(seg, /accessMode|currentToolAccessMode/);
});

test("skill_management is not intercepted before Black Ball", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function submitProductWithTaskBrain");
  const end = mainSource.indexOf("function ensureProductExecutionRouter", start);
  const product = mainSource.slice(start, end);
  assert.doesNotMatch(product, /taskStructuredType|structuredTaskTypeEarly|learnSkillDirectReply/);
});

test("long skill requests keep a stable confirmation hash", async () => {
  const request = `请真实学习并创建一个名为 qa-long-skill 的技能。${"读取商品与库存两列并返回库存为零的商品名称。".repeat(12)}`;
  assert.ok(skillTargetFromRequest(request).length <= 120, "derived skill name is bounded before hashing");
  const manager = new HermesSkillLearningManager({
    skillService: { search: async () => [] },
    acpClient: {},
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname
  });
  const first = await manager.preview({ source: request });
  const second = await manager.preview({ source: first.selectedSource, name: first.name });
  assert.equal(second.confirmationHash, first.confirmationHash);
  assert.equal(second.name, first.name);
});

test("free-form skill search falls back to local generation when the registry match cannot be inspected", async () => {
  const manager = new HermesSkillLearningManager({
    skillService: {
      search: async () => [{ identifier: "generated-query-slug", name: "generated-query-slug" }],
      inspect: async () => { throw new Error("No skill named generated-query-slug found in any source."); }
    },
    acpClient: {},
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname
  });

  const preview = await manager.preview({ source: "Create a new reusable inventory CSV checker skill" });
  assert.equal(preview.mode, "local");
  assert.match(preview.selectedSource, /^local:/);
});

test("explicitly named skill creation bypasses registry search and preserves the requested name", async () => {
  let searchCalls = 0;
  const manager = new HermesSkillLearningManager({
    skillService: {
      search: async () => { searchCalls += 1; return []; }
    },
    acpClient: {},
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname
  });
  const request = "\u8bf7\u771f\u5b9e\u5b66\u4e60\u5e76\u521b\u5efa\u4e00\u4e2a\u540d\u4e3a qa-trust-explicit-inventory-check \u7684\u6280\u80fd";
  const preview = await manager.preview({ source: request });
  assert.equal(preview.mode, "local");
  assert.equal(preview.name, "qa-trust-explicit-inventory-check");
  assert.match(preview.selectedSource, /^local:/);
  assert.equal(searchCalls, 0);
});

test("local generation leaves file writes to the host and requires the exact requested name", async () => {
  let generationPrompt = "";
  let installedName = "";
  const manager = new HermesSkillLearningManager({
    skillService: {
      async installLocal(name) {
        installedName = name;
        return { success: true, item: { id: name, name, path: "SKILL.md" } };
      }
    },
    acpClient: {
      async prompt(_sessionId, prompt) {
        generationPrompt = prompt;
        return {
          status: "done",
          text: JSON.stringify({
            name: "qa-trust-explicit-inventory-check",
            description: "Checks inventory CSV text",
            triggers: ["inventory CSV"],
            instructions: ["Read CSV text", "Find zero stock rows", "Return count and names"],
            testPrompt: "Check this inventory CSV",
            expectedSignals: ["count", "names"]
          })
        };
      },
      async deleteSession() {}
    },
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname
  });
  await manager.generateLocal({
    mode: "local",
    name: "qa-trust-explicit-inventory-check",
    request: "Create an inventory CSV checker skill"
  }, () => {});
  assert.equal(installedName, "qa-trust-explicit-inventory-check");
  assert.match(generationPrompt, /must be exactly "qa-trust-explicit-inventory-check"/);
  assert.match(generationPrompt, /Do not inspect existing skills, call tools, run commands, or write files/);
});

test("skill prompts retry one transient ACP connection closure with a new session", async () => {
  let promptCalls = 0;
  const deletedSessions = [];
  const manager = new HermesSkillLearningManager({
    skillService: {},
    acpClient: {
      async prompt() {
        promptCalls += 1;
        if (promptCalls === 1) throw new Error("ACP connection closed");
        return { status: "done", text: '{"ok":true}' };
      },
      async deleteSession(sessionId) { deletedSessions.push(sessionId); }
    },
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname,
    idFactory: () => `retry-${promptCalls}`
  });

  const result = await manager.hermesPrompt("return JSON", "retry");
  assert.equal(result.json.ok, true);
  assert.equal(promptCalls, 2);
  assert.equal(new Set(deletedSessions).size, 2);
});

test("skill prompts ask Hermes once to repair malformed JSON without losing tool evidence", async () => {
  let promptCalls = 0;
  const manager = new HermesSkillLearningManager({
    skillService: {},
    acpClient: {
      async prompt() {
        promptCalls += 1;
        if (promptCalls === 1) {
          return {
            status: "done",
            text: '{"items":["a" "b"]}',
            toolCalls: [{ toolCallId: "skill-call", title: "load_skill", status: "completed" }]
          };
        }
        return { status: "done", text: '{"items":["a","b"]}', toolCalls: [] };
      },
      async deleteSession() {}
    },
    reportRoot: path.join(__dirname, ".unused-skill-reports"),
    workspaceRoot: __dirname,
    idFactory: () => `json-${promptCalls}`
  });

  const result = await manager.hermesPrompt("Return JSON only", "generate");
  assert.deepEqual(result.json, { items: ["a", "b"] });
  assert.equal(promptCalls, 2);
  assert.equal(result.result.toolCalls[0].toolCallId, "skill-call");
});

test("skill learning waits for the bundled runtime before creating its ACP client", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("async function learnProfessionalSkill");
  const end = mainSource.indexOf("function orderStore", start);
  const body = mainSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(body.indexOf("await hmsRuntimePreparationPromise") < body.indexOf("ensureHermesSkillLearningManager().acquire"));
  assert.match(body, /runtime_initialization_failed/);
});

test("runtime-bound Hermes singletons refresh after the bundled runtime path changes", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const clientStart = mainSource.indexOf("function ensureHermesClient()");
  const serviceStart = mainSource.indexOf("function ensureHermesSkillService()");
  const managerStart = mainSource.indexOf("function ensureHermesSkillLearningManager()", serviceStart);
  const clientBody = mainSource.slice(clientStart, serviceStart);
  const serviceBody = mainSource.slice(serviceStart, managerStart);
  assert.match(clientBody, /hermesClient\.options\?\.bundledRuntimePath/);
  assert.match(clientBody, /hermesClient = null/);
  assert.match(serviceBody, /hermesSkillService\.options\?\.bundledRuntimePath/);
  assert.match(serviceBody, /hermesSkillLearningManager = null/);
});

test("startup verifies bundled hermes skills (availability verified)", () => {
  // rc.10：干净环境 verified=0，启动需对内置核心技能做真实 inspect 验证
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("async function verifyBundledHermesSkills");
  assert.ok(fnStart >= 0, "verifyBundledHermesSkills must exist");
  const seg = mainSource.slice(fnStart, fnStart + 900);
  assert.ok(seg.includes("item.builtin && item.enabled"), "verifies bundled skills");
  assert.ok(seg.includes("service.check(skill.id)"), "uses real inspect");
  assert.ok(seg.includes(".slice(0, 3)"), "caps at few core skills");
  // 启动维护里调用它
  const maintenance = mainSource.indexOf("function scheduleStartupMaintenance");
  assert.ok(maintenance >= 0);
  const mSeg = mainSource.slice(maintenance, mainSource.indexOf("async function runPackagedHermesProbe", maintenance));
  assert.ok(mSeg.includes("verifyBundledHermesSkills()"), "called at startup");
  assert.ok(mSeg.includes('queueStartupMaintenance("verify-hermes-skills"'), "verification waits for idle maintenance");
});
