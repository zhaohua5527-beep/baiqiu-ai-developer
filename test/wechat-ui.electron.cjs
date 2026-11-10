"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.join(__dirname, "..");
app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-wechat-ui-")));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 660, height: 460, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  try {
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const between = (start, end, after = 0) => {
      const from = source.indexOf(start, after), to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Missing renderer section: " + start);
      return source.slice(from, to);
    };
    const cards = between("  if (deliveredFiles.length) {", "  const suggestionEligible", source.indexOf("function addMessage("));
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      document.body.style.cssText = 'display:block;padding:30px;background:#fff;color:#18212b;';
      const opened = [], folders = [];
      const openAttachmentExternally = async item => opened.push(item.path);
      const showAttachmentInFolder = item => folders.push(item.path);
      const showCopyToast = () => {};
      const formatTaskBoardBytes = () => '12 KB';
      const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      const message = { raw: { wechat: true } };
      const deliveredFiles = [{name:'房屋租赁合同.docx',path:'fixture-contract.docx',sizeBytes:12000},
        {name:'比较结果.pdf',path:'fixture-result.pdf',sizeBytes:12000}];
      const bubble = document.createElement('div');
      document.body.appendChild(bubble);
      ${cards}
      const links = [...bubble.querySelectorAll('.message-file-link')];
      assert.equal(links.length, 2);
      assert.ok(links[0].textContent.includes('DOCX'));
      assert.ok(links[1].textContent.includes('PDF'));
      assert.ok(!bubble.textContent.includes('fixture-contract.docx'));
      links[0].click(); bubble.querySelector('.wechat-file-folder').click();
      assert.deepEqual(opened, ['fixture-contract.docx']);
      assert.deepEqual(folders, ['fixture-contract.docx']);
      for (const card of bubble.querySelectorAll('.wechat-file-card')) {
        assert.ok(card.getBoundingClientRect().height >= 60);
        assert.ok(card.scrollWidth <= card.clientWidth + 1);
      }
      let wechatQrPollTimer = 0, wechatQrRevision = 0, wechatUnbinding = false, wechatConversationAutoEntered = false;
      const state = { wechat: { connected: false, available: true, qrDataUrl: 'old' } };
      const wechatStatusPill = document.createElement('span'), wechatQrBox = document.createElement('div');
      const wechatQrImage = document.createElement('img'), wechatQrPlaceholder = document.createElement('div');
      const wechatQrText = document.createElement('span'), wechatLastSync = document.createElement('span');
      const unbindWechatBtn = document.createElement('button'), disconnectWechatTopBtn = document.createElement('button');
      const refreshWechatQrBtn = document.createElement('button');
      const wechatDialog = { open: false, showModal() { this.open = true; } };
      let entered = 0;
      const enterWechatConversation = async () => { entered++; };
      const setSettingsTabSummary = () => {}, updateProjectTreePresentation = () => {};
      let qr = 0;
      const api = { wechatUnbind: async () => ({ok:true,connected:false,available:true,qrDataUrl:'fresh-' + (++qr)}) };
      ${between("function stopWechatQrPolling()", "async function updateSettingsTabSummaries()")}
      applyWechatStatus({connected:true,available:true});
      assert.equal(entered, 1);
      assert.equal(state.wechat.qrDataUrl, '');
      await unbindWechatAndRefresh();
      assert.equal(state.wechat.qrDataUrl, 'fresh-1');
      assert.equal(wechatQrImage.hidden, false);
      applyWechatStatus({stale:true,connected:true});
      assert.equal(state.wechat.connected, false);
      await unbindWechatAndRefresh();
      assert.equal(state.wechat.qrDataUrl, 'fresh-2');
      applyWechatStatus({connected:false,available:true,qrDataUrl:''});
      assert.equal(state.wechat.qrDataUrl, '');
      assert.equal(wechatQrImage.hasAttribute('src'), false);
      stopWechatQrPolling();
      return {cards: links.length, openAndFolder: true, repeatedUnbind: true, staleIgnored: true, explicitQrClear: true};
    })()`);
    fs.mkdirSync(path.join(root, "work/wechat-diagnostics"), { recursive: true });
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
});
