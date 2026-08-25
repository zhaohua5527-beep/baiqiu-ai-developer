"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectKeySentences, keyIndexes, summarize, splitSentences, toMarkedHtml } = require("../services/knowledge/knowledge-keyline");

const SAMPLE = [
  "本次项目完成了商品库存模块的开发。",
  "核心结论：库存低于阈值的商品共 12 个，需要补货。",
  "另外前端页面做了一些样式调整。",
  "因此建议优先处理缺货商品的补货计划，预计 3 天内完成。",
  "具体实现细节记录在代码仓库。"
].join("");

test("splitSentences keeps sentence boundaries", () => {
  const parts = splitSentences("第一句。第二句！第三句？");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "第一句。");
});

test("detectKeySentences marks signal and number sentences", () => {
  const result = detectKeySentences(SAMPLE);
  const keyed = result.filter((item) => item.key).map((item) => item.text);
  // 信号词句（核心结论/因此）和数字句（12个/3天）应被画线
  assert.ok(keyed.some((text) => text.includes("核心结论")), "核心结论句应画线");
  assert.ok(keyed.some((text) => text.includes("因此建议")), "因此句应画线");
  // 纯过程句（具体实现细节/样式调整）不应画线
  assert.ok(!keyed.some((text) => text.includes("具体实现细节")), "过程句不应画线");
});

test("keyIndexes returns marked positions", () => {
  const indexes = keyIndexes(SAMPLE);
  assert.ok(Array.isArray(indexes));
  assert.ok(indexes.length >= 1, "至少一句画线");
  assert.ok(indexes.every((index) => index >= 0));
});

test("summarize prefers key sentences over truncation", () => {
  const summary = summarize(SAMPLE);
  // 摘要应包含核心结论/因此句，而不是开头第一句
  assert.ok(summary.includes("库存") || summary.includes("因此"), "摘要应含重点内容");
});

test("summarize truncates to maxLength", () => {
  const summary = summarize(SAMPLE, { maxLength: 80 });
  assert.ok(summary.length <= 80, `长度 ${summary.length} 应 <= 80`);
});

test("toMarkedHtml wraps key sentences in mark", () => {
  const html = toMarkedHtml(SAMPLE);
  assert.ok(html.includes('<mark class="knowledge-keyline">'), "含画线标记");
  assert.ok(html.includes("核心结论"), "重点句在标记内");
  assert.ok(!html.includes("<script"), "无脚本注入");
});

test("detectKeySentences marks dates, files, and project entities", () => {
  const value = "普通描述没有需要强调的内容。白球项目将在 2026-08-04 读取 coordination.db。";
  const keyed = detectKeySentences(value).filter((item) => item.key).map((item) => item.text);
  assert.deepEqual(keyed, ["白球项目将在 2026-08-04 读取 coordination.db。"]);
});

test("ordinary prose is not highlighted just to satisfy a quota", () => {
  const keyed = detectKeySentences("今天整理了一些内容。页面样式已经调整。").filter((item) => item.key);
  assert.equal(keyed.length, 0);
});

test("summary mode marks the model conclusion and escapes input", () => {
  const html = toMarkedHtml('库存策略已经确认。<img src=x onerror="alert(1)">', { summaryMode: true });
  assert.match(html, /^<mark class="knowledge-keyline">库存策略已经确认。<\/mark>/);
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
});
