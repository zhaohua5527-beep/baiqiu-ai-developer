"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { IntentPredictionService } = require("../services/intent-prediction-service");

test("image generation capability question produces a structured local prediction", () => {
  const prediction = new IntentPredictionService().predict({ input: "你给我生产图片吗？" });
  assert.equal(prediction.action, "clarify");
  assert.equal(prediction.source, "whiteball_intent_prediction");
  assert.deepEqual(prediction.candidates.map((item) => item.id), ["generate_image", "image_capability", "understand_image"]);
  assert.equal(prediction.blocker.options[0].recommended, true);
});

test("GPT follow-up in image context separates generation, understanding and model switching", () => {
  const prediction = new IntentPredictionService().predict({
    input: "如果我切换大模型 用gpt呢？",
    recentTurns: [
      { role: "user", text: "随便生产一张美女图片，我主要是测试" },
      { role: "assistant", text: "当前还没有调用图片生成工具。" }
    ]
  });
  assert.equal(prediction.blocker.dimension, "image_model_intent");
  assert.deepEqual(prediction.candidates.map((item) => item.id), ["generate_image", "understand_image", "switch_chat_model"]);
  assert.equal(prediction.blocker.options[0].recommended, true);
});

test("simple chat and complete image briefs do not trigger intent prediction", () => {
  const service = new IntentPredictionService();
  assert.equal(service.predict({ input: "你好" }), null);
  assert.equal(service.predict({ input: "随便生产一张美女图片，我主要是测试" }), null);
  assert.equal(service.predict({ input: "生成一张写实风格的红色跑车海报，16:9" }), null);
});

test("intent predictor has no Black Ball, tool, file or memory dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "services", "intent-prediction-service.js"), "utf8");
  assert.doesNotMatch(source, /runHermes|HermesAcp|HMS|toolRegistry|readFile|writeFile|memory/i);
});

