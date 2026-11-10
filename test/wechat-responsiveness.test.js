"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function rendererHarness(connected = false) {
  let requests = 0;
  let release;
  const status = new Promise(resolve => { release = resolve; });
  const selected = [];
  const context = vm.createContext({
    state: { wechat: { connected }, db: { sessions: [{ id: "wechat", source: "wechat" }] } },
    wechatDialog: { open: false, showModal() { this.open = true; }, close() { this.open = false; } },
    wechatQrText: { textContent: "" }, refreshWechatQrBtn: {},
    api: { wechatStatus: () => { requests += 1; return status; },
      wechatEnsureSession: () => { throw new Error("existing conversation must not be recreated"); } },
    selectSessionById: async id => selected.push(id),
    ensureClientDb: db => db, isWechatChatSession: item => item.source === "wechat",
    stopWechatQrPolling() {}, scheduleWechatQrPolling() {},
    applyWechatStatus(value) { context.state.wechat = value; },
    showCopyToast() {}
  });
  vm.runInContext(`let wechatUnbinding = false, wechatQrRevision = 0;
    let wechatConversationEnterPromise = null, wechatLinkRequest = null;
    ${section(renderer, "async function enterWechatConversation()", 'const updateCheckBtn')}
    ${section(renderer, "async function renderWechatLink", "async function unbindWechatAndRefresh")}
    ${section(renderer, "async function openSettingsTab", "function firstUseGuidePending")}`, context);
  return { context, selected, release, requests: () => requests };
}

test("binding dialog opens immediately while status is pending; repeated clicks share one request", async () => {
  const fixture = rendererHarness();
  await fixture.context.openSettingsTab("wechat", "external", { userInitiated: true });
  assert.equal(fixture.context.wechatDialog.open, true);
  assert.match(fixture.context.wechatQrText.textContent, /正在检查微信连接/);
  await fixture.context.openSettingsTab("wechat", "external", { userInitiated: true });
  assert.equal(fixture.requests(), 1);
  fixture.release({ connected: false, available: false });
});

test("connected conversation opens before gateway status responds", async () => {
  const fixture = rendererHarness(true);
  await fixture.context.openSettingsTab("wechat", "external", { userInitiated: true });
  assert.deepEqual(fixture.selected, ["wechat"]);
  assert.equal(fixture.requests(), 1);
  fixture.release({ connected: true });
});

test("repeated session ensure without changes does not save or refresh updatedAt", () => {
  const session = { id: "wechat", title: "微信聊天", name: "微信聊天", source: "wechat", wechatSession: true,
    systemLocked: true, pinned: true, archived: false, order: -1, updatedAt: 123 };
  const db = { sessions: [session], messages: { wechat: [{ id: "message", text: "历史" }] }, selectedSessionId: "other" };
  let saved = 0;
  const context = vm.createContext({ loadDb: () => db, Date, saveDb: () => { saved += 1; }, rendererDbSnapshot: value => value });
  vm.runInContext(section(main, "function ensureWechatChatSession", "function currentWechatSession"), context);
  for (let index = 0; index < 5; index += 1) context.ensureWechatChatSession({ select: false, includeSnapshot: false });
  assert.equal(saved, 0);
  assert.equal(session.updatedAt, 123);
  assert.equal(db.selectedSessionId, "other");
  const result = context.ensureWechatChatSession();
  assert.equal(saved, 1);
  assert.equal(result.session.messages, undefined);
  assert.equal(db.messages.wechat.length, 1);
});
