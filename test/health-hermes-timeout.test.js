"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 黑球链接检测（agentRuntime 探针）修复验证：
// 1. 运行时未就绪时返回 NOT_READY（诊断）而非等待超时失败
// 2. 超时时间提高到 120 秒，避免模型冷启动/连接慢被误判失败
test("blackball runtime probe reports NOT_READY when HMS is not initialized", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function runHealthHermesRuntimeProbe");
  assert.ok(start >= 0, "runtime probe must exist");
  const segment = mainSource.slice(start, start + 1800);
  // 未就绪必须显式返回 NOT_READY，而不是等待超时
  assert.match(segment, /hmsRuntimePath/);
  assert.match(segment, /NOT_READY/);
  assert.match(segment, /runtime_not_ready/);
  assert.match(segment, /首次初始化中或未安装/);
  // 已就绪才走真实连接
  assert.match(segment, /withHermesHealthSession/);
});

test("blackball link detection has no white-ball deadline by default", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const fnStart = mainSource.indexOf("async function withHermesHealthSession");
  const fnSegment = mainSource.slice(fnStart, fnStart + 900);
  assert.match(fnSegment, /timeoutMs = 0/);
  assert.match(fnSegment, /const controller = new AbortController\(\)/);
  assert.match(fnSegment, /healthProbeControllers\.add\(controller\)/);
  assert.match(fnSegment, /Number\(timeoutMs\) > 0/);
  assert.doesNotMatch(fnSegment, /timeoutMs = 120000/);
});

test("health probes are isolated from user sessions and yield to interactive requests", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(mainSource, /function ensureHermesHealthClient\(\)/);
  assert.match(mainSource, /clientName: "baiqiu-health-auditor"/);
  assert.match(mainSource, /function prioritizeInteractiveHermes\(\)/);
  assert.match(mainSource, /for \(const controller of healthProbeControllers\) controller\.abort\(\)/);
  assert.doesNotMatch(mainSource, /const session = db\.sessions\.find\(\(item\) => item\.id === db\.selectedSessionId\)[\s\S]{0,500}BAIQIU_QA_OK/);
  assert.match(mainSource, /"qa-model",[\s\S]{0,240}BAIQIU_QA_OK/);
});

test("runtime probe explicitly disables white-ball timeout", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function runHealthHermesRuntimeProbe");
  const segment = mainSource.slice(start, start + 1800);
  assert.match(segment, /timeoutMs: 0/);
  assert.doesNotMatch(segment, /timeoutMs: 120000/);
});
