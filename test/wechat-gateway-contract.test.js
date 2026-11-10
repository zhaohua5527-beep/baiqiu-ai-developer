"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WechatGatewayWorker } = require("../services/wechat-gateway-worker");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
const bridgeSource = fs.readFileSync(path.join(root, "services", "wechat-gateway-worker.py"), "utf8");
const gatewayRuntimeSource = fs.readFileSync(path.join(root, "services", "wechat-gateway-runtime.py"), "utf8");

test("WeChat QR uses HMS iLink endpoints and stores confirmed credentials", () => {
  assert.match(bridgeSource, /EP_GET_BOT_QR/);
  assert.match(bridgeSource, /EP_GET_QR_STATUS/);
  assert.match(bridgeSource, /save_weixin_account/);
  assert.match(bridgeSource, /send_weixin_direct/);
  assert.match(mainSource, /node_modules", "qrcode"/);
  assert.match(mainSource, /qrcode\.toDataURL/);
  assert.doesNotMatch(mainSource, /api\.qrserver|chart\.googleapis|quickchart/);
  assert.doesNotMatch(mainSource, /黑球微信网关尚未接入白球桥接|wechat_qr_unavailable/);
});

test("HMS GatewayRunner mirrors real WeChat turns into the interactive session", () => {
  assert.match(bridgeSource, /wechat-gateway-runtime\.py/);
  assert.match(gatewayRuntimeSource, /from gateway\.run import GatewayRunner, main/);
  assert.match(gatewayRuntimeSource, /WeixinAdapter\.set_message_handler/);
  assert.match(gatewayRuntimeSource, /WeixinAdapter\.handle_message = _handle_message_with_mirror/);
  assert.match(mainSource, /ensureWechatChatSession\(\{ select: false, includeSnapshot: false \}\)/);
  assert.match(mainSource, /raw: \{ wechat: true/);
  assert.match(preloadSource, /wechatSend:/);
  assert.match(mainSource, /async function realWechatGatewaySend/);
  assert.match(bridgeSource, /s\.source = 'weixin'/);
  assert.match(bridgeSource, /m\.role IN \('user', 'assistant'\)/);
  assert.match(mainSource, /async function syncWechatGatewayHistory/);
  assert.match(mainSource, /const WECHAT_HISTORY_SYNC_INTERVAL_MS = 1000;/);
  assert.match(mainSource, /setInterval\(\(\) => \{ void syncWechatGatewayHistory\(\); \}, WECHAT_HISTORY_SYNC_INTERVAL_MS\)/);
  assert.match(mainSource, /hmsHistory: true/);
  assert.doesNotMatch(bridgeSource.slice(bridgeSource.indexOf("def _history_messages"), bridgeSource.indexOf("async def _api_get")), /role IN \('tool'|reasoning|reasoning_content/);
});

test("WeChat QR is requested on first open and polled until connected", () => {
  assert.match(preloadSource, /wechatQrStatus:\s*\(\) => ipcRenderer\.invoke\("wechat:qr-status"\)/);
  assert.match(mainSource, /ipcMain\.handle\("wechat:qr-status"/);
  assert.match(rendererSource, /api\.wechatQrStatus\?\.\(\)/);
  assert.match(rendererSource, /if \(!refreshQr && !status\?\.connected && status\?\.available !== false && !state\.wechat\?\.qrDataUrl\)/);
  assert.match(rendererSource, /status = await api\.wechatQr\?\.\(\)/);
  assert.match(rendererSource, /scheduleWechatQrPolling\(\)/);
  assert.match(rendererSource, /if \(state\.wechat\.connected\)[\s\S]*stopWechatQrPolling\(\)/);
  assert.match(rendererSource, /const qrExpired = status\.qrStatus === "expired"/);
  assert.match(mainSource, /const qr = await realWechatGatewayQr\(\{ afterUnbind: true \}\)/);
});

test("WeChat keeps files as attachment cards and queues ordinary follow-ups", () => {
  assert.match(gatewayRuntimeSource, /"attachments": attachments/);
  assert.match(gatewayRuntimeSource, /HERMES_GATEWAY_BUSY_INPUT_MODE.*queue/);
  assert.match(gatewayRuntimeSource, /HERMES_GATEWAY_BUSY_TEXT_MODE.*queue/);
  assert.match(bridgeSource, /_legacy_document_attachment/);
  assert.match(bridgeSource, /"attachments": attachments/);
  assert.match(mainSource, /if \(\(!text && !attachments\.length\)/);
  assert.match(mainSource, /persistAttachmentForMessage\(item\)/);
  assert.match(rendererSource, /const deliveredFiles = taskPresentation/);
  assert.match(rendererSource, /className = "message-file-link"/);
});

test("WeChat is one locked real conversation at the top of the normal chat list", () => {
  assert.match(mainSource, /return \{ ok: true, db: rendererDbSnapshot/);
  assert.match(mainSource, /ensureWechatChatSession\(\{ select: false, includeSnapshot: false \}\)/);
  assert.doesNotMatch(rendererSource, /createWechatSessionShortcut|data-wechat-shortcut|wechat-session-shortcut/);
  assert.doesNotMatch(stylesSource, /\.wechat-session-shortcut/);
  assert.match(rendererSource, /isWechatChatSession\(a\) === isWechatChatSession\(b\) \? 0 : isWechatChatSession\(a\) \? -1 : 1/);
  assert.match(rendererSource, /for \(const session of unassigned\) chatSection\.appendChild\(createProjectSessionNode\(session, \{ batchSelectable: true \}\)\)/);
  assert.match(rendererSource, /button\.innerHTML = isWechat/);
  assert.doesNotMatch(rendererSource, /wechat-session-component|同步微信聊天记录/);
  assert.match(rendererSource, /function renderComposerSessionMode\(session = selectedSession\(\)\)/);
  assert.match(rendererSource, /chatForm\.hidden = false/);
  assert.match(rendererSource, /if \(!isWechat\) button\.addEventListener\("contextmenu"/);
  assert.match(rendererSource, /!session\.systemLocked && !isWechatChatSession\(session\)/);
  const plainWechatRow = rendererSource.slice(rendererSource.indexOf("button.innerHTML = isWechat"), rendererSource.indexOf("if (!isWechat && !isTrashed) updateSessionStatusIndicator"));
  assert.doesNotMatch(plainWechatRow.split(": `", 1)[0], /ai-core|session-status-indicator|扫码|未连接/);
});

test("stopping during startup prevents a late worker from spawning", async () => {
  let starts = 0;
  const worker = new WechatGatewayWorker({ spawnProcess: () => { starts++; } });
  const pending = worker.status({ pythonPath: "fixture", agentRoot: "fixture" });
  await worker.stop();
  await assert.rejects(pending, /启动已取消/);
  assert.equal(starts, 0);
  assert.equal(worker.child, null);
});

test("WeChat worker keeps one HMS bridge process for QR and status", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-wechat-worker-test-"));
  const scriptPath = path.join(fixture, "worker.js");
  fs.writeFileSync(scriptPath, [
    'const readline = require("node:readline");',
    'let count = 0;',
    'const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'emit({ type: "ready" });',
    'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const request = JSON.parse(line); count += 1;',
    '  emit({ id: request.id, result: { ok: true, action: request.action, pid: process.pid, count } });',
    '});'
  ].join("\n"), "utf8");
  const worker = new WechatGatewayWorker({ scriptPath });
  const runtime = { pythonPath: process.execPath, agentRoot: fixture, hermesHome: fixture };
  try {
    const [qr, status] = await Promise.all([worker.qr(runtime), worker.qrStatus(runtime)]);
    assert.equal(qr.pid, status.pid);
    assert.equal(qr.action, "qr");
    assert.equal(status.action, "qr-status");
    assert.equal(status.count, 2);
  } finally {
    await worker.stop();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
