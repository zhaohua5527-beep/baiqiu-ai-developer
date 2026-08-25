"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// task-040 rc.7 修复：Task Brain 固定任务上下文含"当前阶段"等系统词，
// 被 isRealtimeWebQuestion 的 realtime 词表（含"当前"）误命中，导致分析任务
// 触发 web_search，query 是整段模板块。stripTaskBrainContext 剥离模板块后
// 只用用户真实请求判断联网意图。

function loadStripper() {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function stripTaskBrainContext");
  const end = mainSource.indexOf("function toolResultText", start);
  assert.ok(start >= 0 && end > start, "stripTaskBrainContext must exist");
  return new Function(`${mainSource.slice(start, end)}; return stripTaskBrainContext;`)();
}

test("stripTaskBrainContext removes the template block", () => {
  const strip = loadStripper();
  const polluted = [
    "【Task Brain 固定任务上下文】",
    "原始目标：重新深度分析两个附件",
    "当前阶段：executing",
    "已完成：暂无",
    "下一步：确认目标文件",
    "验收标准：真实执行已发生",
    "用户期望：完成真实执行",
    "允许动作：ex",
    "执行过程中必须保持以上结构化目标，不得重新解析或直接执行用户原话。",
    "测试编号 T040-INT。重新深度分析两个附件，逐条核验条码覆盖。"
  ].join("\n");
  const stripped = strip(polluted);
  assert.ok(!stripped.includes("当前阶段"), "template stage word removed");
  assert.ok(!stripped.includes("【Task Brain 固定任务上下文】"), "marker removed");
  assert.ok(!stripped.includes("允许动作"), "template action removed");
  assert.ok(stripped.includes("T040-INT"), "real user request preserved");
});

test("stripTaskBrainContext leaves plain user text untouched", () => {
  const strip = loadStripper();
  const plain = "帮我查一下今天的天气";
  assert.equal(strip(plain), plain);
});

test("stripTaskBrainContext strips mid-text template", () => {
  const strip = loadStripper();
  const text = `【Task Brain 固定任务上下文】\n当前阶段：executing\n执行过程中必须保持以上结构化目标，不得重新解析或直接执行用户原话。\n用户真实请求：分析这个表格`;
  const stripped = strip(text);
  assert.ok(!stripped.includes("当前阶段"));
  assert.ok(stripped.includes("分析这个表格"));
});

test("isRealtimeWebQuestion must not fire on stripped analysis request", () => {
  // 剥离后是纯分析请求，不含实时词，不应触发联网搜索
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("function isRealtimeWebQuestion");
  const fnEnd = mainSource.indexOf("function realtimeSearchQuery", fnStart);
  const isRealtime = new Function(
    "sanitizeText", "recentUserContext",
    `${mainSource.slice(fnStart, fnEnd)}; return isRealtimeWebQuestion;`
  )(
    (value) => String(value || "").replace(/\s+/g, " ").trim(),
    () => ""
  );
  const analysis = "测试编号 T040-INT。重新深度分析两个附件，逐条核验活动商品与库存商品的条码覆盖，生成完整异常明细。这是中断恢复测试，请真实读取文件，不要复用上一条回答。";
  assert.equal(isRealtime(analysis, ""), false, "analysis request must not trigger realtime search");
});
