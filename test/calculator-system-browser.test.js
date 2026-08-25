"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { VerifiedTaskService } = require("../services/verified-task-service");

function makeService({ openPathResult = null, openInternalBrowser = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-vts-test-"));
  return {
    tmp,
    service: new VerifiedTaskService({
      desktopPath: () => tmp,
      saveRoot: () => tmp,
      dataRoot: (...parts) => path.join(tmp, ...parts),
      actionRelativeLabel: (file) => String(file || "").replace(/\\/g, "/"),
      safeActionPath: (value) => path.resolve(value),
      openPath: async () => openPathResult || { opened: true, browser: "system", url: "file:///tmp/x.html", verifiedProcess: "system" },
      openInternalBrowser: openInternalBrowser || (async () => { throw new Error("不应调用黑球浏览器"); }),
      openExternal: async () => undefined,
      enqueueTask: () => ({ id: `t-${Math.random().toString(36).slice(2, 8)}` }),
      updateTask: () => {},
      findQueueTask: () => null,
      ensureRunActive: () => {},
      withTimeout: (promise, ms, label) => promise,
      logger: () => {}
    })
  };
}

test("system-browser calculator creation succeeds and never calls black-ball browser", async () => {
  const { tmp, service } = makeService({});
  const result = await service.createCalculator({ sessionId: "s1", message: "做一个计算器" });
  assert.equal(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.result.browser, "system", "system browser should be used");
  assert.equal(result.result.browserVerified, true, "system open should count as verified");
  assert.ok(fs.existsSync(result.result.file), "calculator html should exist");
});

test("system-browser html-app creation succeeds", async () => {
  const { tmp, service } = makeService({});
  const result = await service.createHtmlApp({ sessionId: "s1", message: "做一个库存管理应用" });
  assert.equal(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
});

test("calculator creation fails cleanly when browser open fails", async () => {
  const { service } = makeService({});
  // 模拟打开失败：openPath 返回无 url 的对象，createCalculator 应判失败而非抛未捕获异常
  service.deps.openPath = async () => ({});
  const result = await service.createCalculator({ sessionId: "s1", message: "做一个计算器" });
  assert.equal(result.success, false, "browser open failure should fail cleanly");
});
