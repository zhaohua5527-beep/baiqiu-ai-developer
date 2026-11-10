"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const marker = "PROTOCOL_DOM_RESULT:";

if (process.argv.includes("--protocol-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadURL("data:text/html,<main></main>");
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const helper = source.slice(source.indexOf("function ensureProtocolContinueAction("), source.indexOf("function showCopyToast("));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const activeSendOwners = new Map();
      const sends = [];
      const guidanceMessages = [];
      const composerClarification = {dataset: {}};
      const INTENT_PREDICTION_EXTERNAL_ENABLED = false;
      const showCopyToast = () => {};
      const sendCurrentTask = async (task, sessionId) => sends.push({task, sessionId});
      const renderComposerClarification = message => {
        guidanceMessages.push(message);
        composerClarification.dataset.guidanceSource = message?.raw?.clarification?.source || "";
        composerClarification.dataset.sessionId = message?.raw?.clarification?.sessionId || "";
      };
      ${helper}
      const bubble = document.createElement("div");
      bubble.innerHTML = '<div class="rendered">已交付的阶段结果</div><div class="message-actions"></div>';
      document.body.appendChild(bubble);
      const message = {raw:{productResult:{status:"failed",taskId:"task-42",raw:{protocolError:true}}}};
      ensureProtocolContinueAction(bubble, message, "original-session");
      ensureProtocolContinueAction(bubble, message, "original-session");
      const guidance = guidanceMessages[guidanceMessages.length - 1];
      const report = {guidanceCount: guidanceMessages.length,
        guidanceCardType: guidance?.raw?.clarification?.cardType || "",
        guidanceSource: guidance?.raw?.clarification?.source || "",
        guidanceTaskId: guidance?.raw?.clarification?.taskId || "",
        guidanceOptions: guidance?.raw?.clarification?.options || [],
        buttons:bubble.querySelectorAll("button").length,
        noticeCount:bubble.querySelectorAll(".protocol-failure-notice").length,
        retained:bubble.querySelector(".rendered").textContent};
      ensureProtocolContinueAction(bubble, {raw:{protocolError:true,status:"cancelled"}}, "original-session");
      report.cancelledButtons = bubble.querySelectorAll("button").length;
      const ordinary = document.createElement("div");
      ordinary.innerHTML = '<div class="rendered">已生成的半段答案</div><div class="message-actions"></div>';
      document.body.appendChild(ordinary);
      ensureProtocolContinueAction(ordinary, {raw:{productResult:{status:"failed",success:false,failureNotice:"本次任务未完整完成，已保留已经生成的内容。"}}}, "ordinary-session");
      report.ordinaryButtons = ordinary.querySelectorAll("button").length;
      report.ordinaryNotice = ordinary.querySelector(".execution-failure-notice")?.textContent || "";
      report.ordinaryRetained = ordinary.querySelector(".rendered").textContent;
      return report;
    })()`);
    process.stdout.write(marker + JSON.stringify(result) + "\n", () => app.exit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { spawn } = require("node:child_process");
  test("failed turn retains results without the rolled-back guidance card", async () => {
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require("electron"), [__filename, "--protocol-dom"], { cwd: root, env, windowsHide: true });
      let output = "";
      child.stdout.on("data", data => output += data);
      child.stderr.on("data", data => output += data);
      child.on("error", reject);
      const timer = setTimeout(() => { child.kill(); reject(new Error("Protocol DOM test timed out")); }, 15000);
      child.on("close", code => {
        clearTimeout(timer);
        const line = output.split(/\r?\n/).find(text => text.startsWith(marker));
        if (code || !line) return reject(new Error(output));
        resolve(JSON.parse(line.slice(marker.length)));
      });
    });
    assert.equal(result.guidanceCount, 0);
    assert.equal(result.guidanceCardType, "");
    assert.equal(result.guidanceSource, "");
    assert.equal(result.guidanceTaskId, "");
    assert.deepEqual(result.guidanceOptions, []);
    assert.equal(result.retained, "已交付的阶段结果");
    assert.equal(result.buttons, 0);
    assert.equal(result.noticeCount, 1);
    assert.equal(result.cancelledButtons, 0);
    assert.equal(result.ordinaryButtons, 0);
    assert.equal(result.ordinaryNotice, "本次任务未完整完成，已保留已经生成的内容。");
    assert.equal(result.ordinaryRetained, "已生成的半段答案");
  });
}
