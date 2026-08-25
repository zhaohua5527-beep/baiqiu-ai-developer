"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { publicBrandText } = require("../services/user-facing-error-adapter");
const { HmsProgressMapper } = require("../services/hms-progress");
const { ModelSwitchOptimizer } = require("../services/model-switch-optimizer");

test("all internal runtime codenames map to Black Ball on public surfaces", () => {
  assert.equal(publicBrandText("Hermes Agent / HMS / OpenClaw / Hermes"), "黑球 / 黑球 / 黑球 / 黑球");
  const mapper = new HmsProgressMapper();
  const events = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: '<baiqiu-progress>{"message":"HMS 正在检查 Hermes 配置"}</baiqiu-progress>' }
  });
  assert.equal(events[0].message, "判断：黑球 正在检查 黑球 配置");
});

test("GPT-5.6 family supports image understanding but does not claim image generation", () => {
  const optimizer = new ModelSwitchOptimizer();
  for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const capability = optimizer.getModelCapabilities(model);
    assert.equal(capability.vision, true, model);
    assert.equal(capability.tools, true, model);
    assert.equal(capability.reasoning, true, model);
    assert.equal(capability.imageGeneration, false, model);
  }
  assert.equal(optimizer.getModelCapabilities("deepseek-chat").vision, false);
});

test("completed response duration uses compact seconds and minutes", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  assert.match(renderer, /return `\$\{totalSeconds\}s`/);
  assert.match(renderer, /return seconds \? `\$\{minutes\}m \$\{seconds\}s` : `\$\{minutes\}m`/);
  assert.doesNotMatch(renderer, /meta\.textContent = `执行完成/);
  assert.match(renderer, /const duration = durationMs > 0 \? formatTaskDuration\(durationMs\) : "—"/);
});

test("completed response duration prefers real result timing and ignores interruption carryover", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const duration = renderer.slice(
    renderer.indexOf("function messageDurationMs"),
    renderer.indexOf("function buildPersistedAttachments")
  );
  assert.match(duration, /raw\.interruptedDelivery === true/);
  assert.match(duration, /productResult\.durationMs/);
  assert.match(duration, /raw\.durationMs\n\s*\]\.map/);
  assert.doesNotMatch(duration, /Math\.max\(\s*0,[\s\S]*raw\.durationMs/);
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.doesNotMatch(mainSource, /inferredDurationMs|Date\.now\(\) - Number\(previousUser\.createdAt\)/);
});
