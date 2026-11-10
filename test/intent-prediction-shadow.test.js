"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ClarificationHandler } = require("../services/response-router");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("structured local prediction objects are normalized without JSON string coercion", () => {
  const handler = new ClarificationHandler();
  const stage = handler.normalizeGeneratedStage({
    action: "clarify",
    workingGoal: "处理图片请求",
    confidence: 0.66,
    candidates: [
      { id: "generate_image", label: "生成图片", confidence: 0.66, evidence: "用户提到生成" },
      { id: "understand_image", label: "分析图片", confidence: 0.34, evidence: "也可能是识图" }
    ],
    blocker: {
      dimension: "image_request_kind",
      label: "图片需求",
      question: "需要生成新图片还是分析已有图片？",
      reason: "两类任务调用不同能力",
      impact: "high",
      options: [
        { label: "生成新图片", recommended: true, candidateIds: ["generate_image"] },
        { label: "分析已有图片", recommended: false, candidateIds: ["understand_image"] }
      ]
    }
  }, {
    originalRequest: "你可以生成图片吗",
    confirmedDimensions: {},
    askedDimensions: [],
    askedQuestions: []
  });
  assert.equal(stage.dimension, "image_request_kind");
  assert.equal(stage.options.length, 2);
});

test("Black Ball decision code remains available while guidance is rolled back", () => {
  const start = mainSource.indexOf("function applyIntentPredictionDecision");
  const end = mainSource.indexOf("function ensureTaskQueue", start);
  const block = mainSource.slice(start, end);
  assert.match(mainSource, /const INTENT_PREDICTION_EXTERNAL_MODE = "shadow";/);
  assert.match(block, /event: "shadow_prediction"/);
  assert.match(block, /source: "whiteball_shadow"/);
  assert.match(block, /semanticOwner === "black_ball"/);
  assert.match(block, /interactionMode: understanding\.responseMode === "clarify" \? "select_and_fill" : "execute"/);
  assert.match(mainSource, /intentPredict: false/);
  assert.match(mainSource, /taskGuidanceEnabled: false/);
  assert.match(mainSource, /db\.settings\.taskGuidanceEnabled = false;/);
  assert.match(mainSource, /db\.settings\.intentPredict = false;/);
});
