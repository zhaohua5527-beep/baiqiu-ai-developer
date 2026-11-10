"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  const events = [], messages = [], saves = [];
  let qr = 0;
  const worker = {
    status: async () => ({ ok: true, connected: true }),
    qrStatus: async () => ({ ok: true, connected: true }),
    unbind: async () => ({ ok: true, unbound: true }),
    qr: async () => ({ ok: true, qrText: `qr-${++qr}` }),
    history: async () => ({ ok: true, messages: [], cursor: 0 }),
    ...overrides
  };
  const database = { messages: { wechat: messages } };
  const context = vm.createContext({
    path, Date, setInterval: () => ({ unref() {} }), clearInterval() {},
    require: () => ({ toDataURL: async text => `data:${text}` }),
    ensureWechatGatewayWorker: async () => ({ worker, config: {}, runtime: { agentRoot: "fixture" } }),
    currentWechatSession: () => ({ id: "wechat" }),
    ensureWechatChatSession: () => ({ sessionId: "wechat" }),
    safeMainWindowSend: (channel, value) => events.push({ channel, value }),
    loadDb: () => database, rendererDbSnapshot: value => value,
    saveDb: (data, options) => saves.push(options), persistAttachmentForMessage: value => value,
    flushDbAsync: async () => ({ ok: true }),
    appendMessage: (id, message) => { messages.push(message); return message; }
  });
  vm.runInContext(`let wechatHistoryCursor = 0, wechatConnectionRevision = 0;
    let wechatUnbindPromise = null, wechatHistorySyncRunning = false, wechatHistorySyncTimer = null;
    const WECHAT_HISTORY_SYNC_INTERVAL_MS = 1000;
    ${source.slice(source.indexOf("async function realWechatGatewayStatus()"), source.indexOf("function registeredModelCapabilities"))}`, context);
  return { context, events, messages, saves, worker };
}

test("old status and QR poll cannot reconnect after unbind; every cycle returns a fresh QR", async () => {
  const status = deferred(), poll = deferred();
  const { context, events } = harness({ status: () => status.promise, qrStatus: () => poll.promise });
  const oldStatus = context.realWechatGatewayStatus();
  const oldPoll = context.realWechatGatewayQrStatus();
  await new Promise(setImmediate);
  const first = await context.realWechatGatewayUnbind();
  assert.equal(first.qrDataUrl, "data:qr-1");
  status.resolve({ connected: true });
  poll.resolve({ connected: true });
  assert.equal((await oldStatus).stale, true);
  assert.equal((await oldPoll).stale, true);
  assert.ok(events.every(event => !event.value.connected));
  const second = await context.realWechatGatewayUnbind();
  assert.equal(second.qrDataUrl, "data:qr-2");
});

test("concurrent unbind calls perform one unbind and one QR request", async () => {
  const pending = deferred();
  let count = 0;
  const { context } = harness({ unbind: () => { count++; return pending.promise; } });
  const first = context.realWechatGatewayUnbind();
  const second = context.realWechatGatewayUnbind();
  pending.resolve({ ok: true });
  assert.equal((await first).qrDataUrl, "data:qr-1");
  assert.equal((await second).qrDataUrl, "data:qr-1");
  assert.equal(count, 1);
});

test("failed unbind preserves connected state; failed QR remains refreshable", async () => {
  const { context, events, worker } = harness({ unbind: async () => ({ ok: false, reason: "fixture failure" }) });
  assert.equal((await context.realWechatGatewayUnbind()).ok, false);
  assert.equal(events.length, 0);
  worker.unbind = async () => ({ ok: true });
  worker.qr = async () => ({ ok: false, reason: "fixture offline" });
  const result = await context.realWechatGatewayUnbind();
  assert.equal(result.ok, true);
  assert.equal(result.connected, false);
  assert.equal(result.qrDataUrl, "");
  assert.equal(result.reason, "fixture offline");
  worker.qr = async () => ({ ok: true, qrText: "recovered" });
  assert.equal((await context.realWechatGatewayQr()).qrDataUrl, "data:recovered");
});

test("journal catch-up keeps file-only messages and distinct identical text, without duplicate replay", async () => {
  const attachments = [{ path: "fixture.docx", name: "合同.docx" }];
  const page = [
    { journal: true, chatId: "fixture", role: "user", messageId: "file", text: "", attachments },
    { journal: true, chatId: "fixture", role: "assistant", messageId: "one", text: "完成" },
    { journal: true, chatId: "fixture", role: "assistant", messageId: "two", text: "完成" }
  ];
  const { context, messages, saves } = harness({ history: async () => ({ ok: true, messages: page, cursor: 3 }) });
  assert.equal((await context.syncWechatGatewayHistory()).imported, 3);
  assert.equal((await context.syncWechatGatewayHistory()).imported, 0);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].attachments[0].name, "合同.docx");
  assert.equal(saves.length, 1);
  assert.ok(saves.every(save => !save?.immediate));
});

test("empty history polls do not create a session, save or publish a database snapshot", async () => {
  const { context, saves, events } = harness();
  context.ensureWechatChatSession = () => { throw new Error("empty poll must not mutate sessions"); };
  context.rendererDbSnapshot = () => { throw new Error("empty poll must not build a snapshot"); };
  for (let index = 0; index < 5; index += 1) assert.equal((await context.syncWechatGatewayHistory()).imported, 0);
  assert.equal(saves.length, 0);
  assert.equal(events.length, 0);
});

test("failed history persistence does not advance the cursor or report imported success", async () => {
  const cursors = [];
  const { context } = harness({ history: async (config, cursor) => {
    cursors.push(cursor);
    return { ok: true, cursor: 1, messages: [{ journal: true, role: "user", messageId: "one", text: "保留消息" }] };
  } });
  context.flushDbAsync = async () => ({ ok: false, error: new Error("disk failure") });
  const failed = await context.syncWechatGatewayHistory();
  assert.equal(failed.ok, false);
  context.flushDbAsync = async () => ({ ok: true });
  await context.syncWechatGatewayHistory();
  assert.deepEqual(cursors, [0, 0]);
});

test("legacy document record is upgraded in place and caption preserved", async () => {
  const { context, messages } = harness({ history: async () => ({ ok: true, cursor: 0, messages: [
    { sessionId: "old", messageId: "1", role: "user", text: "请比较", attachments: [{ name: "附件.pdf", path: "fixture.pdf" }] }
  ] }) });
  messages.push({ id: "hms-weixin:old:1", role: "user", text: "[The user sent a document: ...]", raw: { wechat: true } });
  await context.syncWechatGatewayHistory();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "请比较");
  assert.equal(messages[0].attachments[0].name, "附件.pdf");
});
