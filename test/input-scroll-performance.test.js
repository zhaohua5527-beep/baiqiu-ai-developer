"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error("Missing renderer boundary: " + start);
  return source.slice(first, last);
}

function setup() {
  Object.defineProperty(window, "localStorage", { value: { getItem: () => null } });
  document.body.innerHTML = '<main class="chat" style="height:760px;display:flex;flex-direction:column;width:1000px">'
    + '<section id="messageList" class="message-list" style="flex:1;min-height:0"></section>'
    + '<form id="chatForm" class="composer"><nav id="composerReplyNav" class="composer-reply-nav" style="width:340px;right:auto">'
    + '<div id="composerReplyNavItems" class="composer-reply-nav-items"></div><div id="composerReplyNavOverflow" class="composer-reply-nav-overflow">'
    + '<button id="composerReplyNavMore" class="composer-reply-nav-more">...</button><div id="composerReplyNavMenu" class="composer-reply-nav-menu" hidden></div></div></nav>'
    + '<textarea id="chatInput" rows="1" placeholder="输入消息"></textarea></form></main>';
  for (const id of ["chatInput", "chatForm", "messageList", "composerReplyNav", "composerReplyNavItems", "composerReplyNavOverflow", "composerReplyNavMenu", "composerReplyNavMore"]) {
    window[id] = document.getElementById(id);
  }
  const paragraph = '<p><span>完整保留的历史正文。</span><span>这是隔离测试，不是用户数据。</span></p>';
  messageList.innerHTML = Array.from({ length: 60 }, (_, index) => '<article class="message assistant" data-message-id="fixture-' + index
    + '"><div class="bubble"><div class="rendered">' + paragraph.repeat(60) + '</div></div></article>').join("");
  window.positionTaskBoard = () => {};
  window.state = { selectedSessionId: "fixture", pendingSuggestionActions: [] };
  window.savedDrafts = [];
  window.saveSessionDraft = (...args) => savedDrafts.push(args);
  window.renderSlashCommandMenu = () => {};
  window.syncComposerSendAction = () => {};
  window.hideRecommendBadge = () => {};
  window.checkAndShowRecommendBadge = () => {};
  window.createComposerReplyNavButton = (_row, heading) => {
    const button = document.createElement("button");
    button.className = "composer-reply-nav-menu-item";
    button.textContent = heading.textContent;
    return button;
  };
  const headings = Array.from({ length: 24 }, (_, index) => ({ textContent: "第" + index + "个历史回复章节标题" }));
  composerReplyNav._activeRow = { _longReplyHeadings: headings };
  composerReplyNav.dataset.signature = "fixture-headings";
  for (const heading of headings) {
    const button = document.createElement("button");
    button.className = "composer-reply-nav-item";
    button.textContent = heading.textContent;
    composerReplyNavItems.appendChild(button);
  }
}

async function sampleInput() {
  chatInput.value = "测试内容";
  adjustComposerHeight();
  await new Promise(resolve => setTimeout(resolve, 0));
  const observer = new MutationObserver(() => {});
  observer.observe(chatInput, { attributes: true, attributeFilter: ["style"] });
  let styleMutations = 0;
  for (let index = 0; index < 40; index++) {
    chatInput.value = "测试内容" + index;
    adjustComposerHeight();
    messageList.getBoundingClientRect();
    styleMutations += observer.takeRecords().length;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  observer.disconnect();
  return { styleMutations, value: chatInput.value, nodes: document.querySelectorAll("*").length };
}

async function sampleScroll() {
  layoutComposerReplyNav();
  await new Promise(resolve => setTimeout(resolve, 0));
  const observer = new MutationObserver(() => {});
  observer.observe(composerReplyNav, { subtree: true, childList: true, attributes: true });
  const menuFirst = composerReplyNavMenu.firstChild;
  composerReplyNavMenu.hidden = false;
  observer.takeRecords();
  let mutations = 0;
  for (let index = 0; index < 40; index++) {
    messageList.scrollTop = index * 18;
    layoutComposerReplyNav();
    mutations += observer.takeRecords().length;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  observer.disconnect();
  return { mutations, menuPreserved: menuFirst === composerReplyNavMenu.firstChild, menuOpen: !composerReplyNavMenu.hidden };
}

async function verifyBehavior() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  chatInput.focus();
  chatInput.value = "中文输入法草稿";
  chatInput.setSelectionRange(2, 5);
  adjustComposerHeight();
  const minimum = chatInput.offsetHeight;
  check(chatInput.selectionStart === 2 && chatInput.selectionEnd === 5 && document.activeElement === chatInput, "Resizing changed input selection or focus");
  chatInput.dispatchEvent(new CompositionEvent("compositionstart"));
  chatInput.value = "wo'zai'shu'ru";
  chatInput.dispatchEvent(new InputEvent("input", { isComposing: true, data: "ru" }));
  check(composerIsComposing && composerHeightFrame === 0, "IME composition scheduled a layout");
  chatInput.value = "我在输入中文";
  chatInput.dispatchEvent(new CompositionEvent("compositionend", { data: chatInput.value }));
  const scheduledFrame = composerHeightFrame;
  chatInput.value += "草稿";
  chatInput.dispatchEvent(new InputEvent("input", { data: "草稿" }));
  check(scheduledFrame && composerHeightFrame === scheduledFrame, "Input events were not coalesced");
  adjustComposerHeight();
  await new Promise(resolve => setTimeout(resolve, COMPOSER_DRAFT_SAVE_DELAY_MS + 40));
  clearTimeout(state._recommendTimer);
  check(savedDrafts.at(-1)?.[1] === "我在输入中文草稿", "IME draft was not persisted intact");
  chatInput.value = Array.from({ length: 16 }, () => "中文多行草稿").join("\n");
  adjustComposerHeight();
  check(chatInput.offsetHeight > minimum && chatInput.style.overflowY === "auto", "Multiline input did not grow or scroll");
  chatInput.value = "缩回一行";
  adjustComposerHeight();
  check(Math.abs(chatInput.offsetHeight - minimum) <= 1, "Deleting text did not shrink composer");
  for (const fontSize of [14, 20, 28]) {
    for (const width of [280, 680]) {
      chatInput.style.fontSize = fontSize + "px";
      chatInput.style.width = width + "px";
      chatInput.value = "测试字体缩放和中英文换行 sample text ".repeat(6);
      adjustComposerHeight();
      const style = getComputedStyle(chatInput);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const contentHeight = chatInput.scrollHeight + border;
      check(chatInput.style.overflowY === "auto" || contentHeight <= chatInput.offsetHeight + 1, "Text clipped after width or font change");
    }
  }
  applyManualComposerHeight(190);
  const manualHeight = chatInput.style.height;
  chatInput.value = "手动高度保持不变";
  adjustComposerHeight();
  check(chatInput.style.height === manualHeight, "Typing changed manual height");
  const narrowVisible = [...composerReplyNavItems.children].filter(button => !button.hidden).length;
  composerReplyNav.style.width = "900px";
  layoutComposerReplyNav();
  const wideVisible = [...composerReplyNavItems.children].filter(button => !button.hidden).length;
  check(wideVisible > narrowVisible, "Wider navigation failed to reveal headings");
  for (const button of composerReplyNavItems.children) button.style.fontSize = "24px";
  layoutComposerReplyNav();
  check([...composerReplyNavItems.children].filter(button => !button.hidden).length < wideVisible, "Font zoom did not invalidate navigation layout");
  check(composerReplyNavItems.children.length === 24, "Navigation lost headings");
  check(messageList.querySelectorAll(".message").length === 60, "History rows were removed");
  return { selection: true, composition: true, draft: true, multiline: true, shrink: true, fontZoom: true, manualHeight: true, resize: true, history: true };
}

if (process.argv.includes("--ui-fluidity")) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.BAIQIU_UI_TEST_PROFILE);
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const results = {};
    const sources = [["current", path.join(root, "renderer-v2/app.js")]];
    if (process.env.BAIQIU_UI_BASELINE) sources.unshift(["baseline", process.env.BAIQIU_UI_BASELINE]);
    for (const [label, file] of sources) {
      console.log("UI_PHASE=" + label + ":setup");
      const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { backgroundThrottling: false, contextIsolation: false } });
      try {
        const source = fs.readFileSync(file, "utf8");
        await window.loadURL("about:blank");
        await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
        const constants = [...source.matchAll(/^const (COMPOSER_MIN_INPUT_HEIGHT|COMPOSER_AUTO_MAX_INPUT_HEIGHT|COMPOSER_HEIGHT_KEY|COMPOSER_DRAFT_SAVE_DELAY_MS) = .+;$/gm)].map(match => match[0]).join("\n");
        const functions = between(source, source.includes("function measureComposerInputHeight(") ? "function measureComposerInputHeight(" : "function adjustComposerHeight(", "\nfunction resetComposerLayout(")
          + between(source, "function layoutComposerReplyNav(", "\nfunction hideComposerReplyNav(")
          + between(source, "function handleComposerInput(", 'chatInput.addEventListener("focus"');
        await window.webContents.executeJavaScript("(" + setup.toString() + ")();\nlet composerHeightFrame = 0, composerHeightMeasure = null, composerIsComposing = false, composerLastInputAt = 0, draftSaveTimer = null;\n" + constants + "\n" + functions);
        await window.webContents.executeJavaScript("(async () => { await document.fonts.ready; chatInput.value = '测试内容'; adjustComposerHeight(); layoutComposerReplyNav(); messageList.getBoundingClientRect(); await new Promise(resolve => setTimeout(resolve, 80)); })()");
        window.webContents.debugger.attach("1.3");
        await window.webContents.debugger.sendCommand("Performance.enable");
        const metrics = async () => Object.fromEntries((await window.webContents.debugger.sendCommand("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
        const before = await metrics();
        const input = await window.webContents.executeJavaScript("(" + sampleInput.toString() + ")()");
        console.log("UI_PHASE=" + label + ":input");
        const middle = await metrics();
        const scroll = await window.webContents.executeJavaScript("(" + sampleScroll.toString() + ")()");
        console.log("UI_PHASE=" + label + ":scroll");
        const after = await metrics();
        const delta = (left, right) => Object.fromEntries(["LayoutCount", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"].map(key => [key, right[key] - left[key]]));
        results[label] = { input: { ...input, metrics: delta(before, middle) }, scroll: { ...scroll, metrics: delta(middle, after) } };
        if (label === "current") {
          const assert = require("node:assert/strict");
          assert.equal(input.styleMutations, 0, "Single-line typing repeatedly changes visible composer geometry");
          assert.equal(scroll.mutations, 0, "Unchanged navigation rebuilds on scroll");
          assert.equal(scroll.menuPreserved, true);
          assert.equal(scroll.menuOpen, true);
          results.current.behavior = await window.webContents.executeJavaScript("(" + verifyBehavior.toString() + ")()");
        }
      } finally { window.destroy(); }
    }
    console.log("UI_FLUIDITY=" + JSON.stringify(results));
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  require("node:test")("input and scroll layouts avoid full-page churn while retaining text and navigation", context => {
    const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-fluidity-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, BAIQIU_UI_TEST_PROFILE: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require("node:child_process").spawnSync(require("electron"), [__filename, "--ui-fluidity"], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 40000
    });
    require("node:assert/strict").equal(result.status, 0, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"));
    require("node:assert/strict").match(result.stdout, /UI_FLUIDITY=.*"history":true/);
    console.log(result.stdout.trim());
  });
}
