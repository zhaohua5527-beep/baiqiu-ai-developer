"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const rendererHtml = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const { AgentHealthManager } = require("../services/agent-health-manager");
const { repairPolicy } = require("../services/self-healing/repair-policy");

test("Agent health understanding uses the production request probe only", async () => {
  let productionCalls = 0;
  const manager = new AgentHealthManager({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-health-contract-")),
    productionUnderstandingProbe: async () => {
      productionCalls += 1;
      return { tests: [{ name: "direction-question", passed: true }, { name: "explicit-task", passed: true }] };
    },
    phaseDelayMs: 0
  });
  const result = await manager.probeUnderstanding();
  assert.equal(productionCalls, 1);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);

  const noProduction = new AgentHealthManager({ phaseDelayMs: 0 });
  const fallback = await noProduction.probeUnderstanding();
  assert.equal(fallback.passed, false);
  assert.match(fallback.detail, /IntentAgent/);
});

test("self-healing policy exposes L0-L3, forbidden roots, and signed patch trust", () => {
  const policy = repairPolicy();
  assert.equal(policy.authority, "independent_repair_supervisor");
  assert.deepEqual(policy.levels.map((item) => item.id), ["L0", "L1", "L2", "L3", "FORBIDDEN"]);
  assert.equal(policy.levels.find((item) => item.id === "L3").mode, "signed_patch_only");
  assert.equal(policy.levels.find((item) => item.id === "FORBIDDEN").mode, "never");
  for (const control of ["embedded_public_key", "signed_manifest", "sha256", "anti_downgrade", "atomic_install", "rollback"]) {
    assert.ok(policy.corePatchTrust.includes(control));
  }
});

test("Black Ball repair is explicitly scan then apply, never scan-time mutation", () => {
  assert.match(rendererSource, /renderBlackBallScan\(report, \{ autoRepair: false \}\)/);
  assert.match(rendererSource, /runAgentHealthBtn\.textContent = report\?\.hasRepairableChanges \? "申请修复" : "重新检测"/);
  assert.match(rendererSource, /const repairing = Boolean\(blackBallScanState\?\.hasRepairableChanges && blackBallScanState\.scanId\)/);
  assert.match(rendererSource, /if \(repairing\) \{[\s\S]*?autoRepairBlackBallReport\(blackBallScanState\)/);
  const scanBranch = rendererSource.slice(rendererSource.indexOf("const report = await api.blackBallScan()"), rendererSource.indexOf("return report;", rendererSource.indexOf("const report = await api.blackBallScan()")));
  assert.doesNotMatch(scanBranch, /blackBallRepair\(/);
});

test("self-check UI and QA implementation expose ten probes including production RequestRun", () => {
  const cards = rendererHtml.match(/data-debug-check="[^"]+"/g) || [];
  assert.equal(cards.length, 10);
  assert.match(rendererHtml, /data-debug-check="requestRunContract"/);
  assert.match(rendererHtml, /10 项真实系统探针/);
  const qaBody = mainSource.slice(mainSource.indexOf("function ensureQaAgent"), mainSource.indexOf("function initializeProjectMemory"));
  assert.equal((qaBody.match(/label:/g) || []).length, 10);
  assert.match(qaBody, /runHealthProductionUnderstandingProbe\(\)/);
});

test("run-scoped lifecycle protects cancellation, idempotency, and non-blocking visible output drain", () => {
  assert.match(mainSource, /cancelRequestTargetsRun\(requestedRunId, run\)/);
  assert.match(mainSource, /eventId: executionRunId \? `\$\{executionRunId\}:execution:\$\{sequence\}`/);
  assert.match(rendererSource, /entry\.seenActivityEventIds\?\.has\(eventId\)/);
  assert.match(rendererSource, /void waitForVisibleOutputDrain\(session\.id, streamId\)/);
  assert.doesNotMatch(rendererSource, /await waitForVisibleOutputDrain\(session\.id, streamId\)/);
  assert.match(rendererSource, /if \(!stillRunning\) \{[\s\S]*?removeSessionExecutionIndicator\(session\.id\)/);
});

test("online updates use the signed update.json authority without latest.json fallback", () => {
  const urls = mainSource.slice(mainSource.indexOf("function updateManifestUrls"), mainSource.indexOf("function updateJsonUrl"));
  assert.match(urls, /`\$\{baseUrl\}\/update\.json`/);
  assert.doesNotMatch(urls, /latest\.json/);
  assert.match(mainSource, /DEFAULT_PUBLIC_SERVER = "http:\/\/47\.108\.191\.67"/);
});
