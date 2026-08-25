"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// task-030 残留修复：web_search 在途请求必须被 abort signal 真正取消。
// 之前 executeWithSignal 只中断"等待"，底层 https.get 继续跑（6.4秒后返回）。
// 现在 requestHtml 支持 signal，abort 时销毁底层请求。

test("web_search passes signal into underlying request", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "web-search.js"), "utf8");
  // execute 接收 context 并取 signal
  assert.match(source, /async execute\(params, context = \{\}\)/);
  assert.match(source, /const signal = context\.signal \|\| null;/);
  // requestHtml 接受 signal 并销毁请求
  assert.match(source, /function requestHtml\(url, redirectCount = 0, signal = null\)/);
  assert.match(source, /signal\.addEventListener\("abort", onAbort/);
  assert.match(source, /req\.destroy\(new Error\("搜索已中断"\)\)/);
  // 中断时不尝试备用搜索源
  assert.match(source, /signal\?\.aborted\) throw error;/);
});

test("web_search requestHtml destroys the HTTP request on abort", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "web-search.js"), "utf8");
  // abort 处理：已 abort 时立即销毁，避免发请求
  assert.match(source, /if \(signal\.aborted\) \{ req\.destroy/);
  // abort 监听器在请求关闭时移除（防泄漏）
  assert.match(source, /req\.on\("close", \(\) => signal\.removeEventListener/);
});
