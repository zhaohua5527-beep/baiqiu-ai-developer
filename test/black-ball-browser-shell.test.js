"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const browserPreloadSource = fs.readFileSync(path.join(root, "browser-preload.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
const browserShellSource = fs.readFileSync(path.join(root, "renderer-v2", "black-ball-browser.js"), "utf8");
const browserControllerSource = fs.readFileSync(path.join(root, "services", "black-ball-browser-controller.js"), "utf8");
const browserActionTools = require(path.join(root, "tools", "browser-actions")).createTools();
const { BlackBallBrowserController } = require(path.join(root, "services", "black-ball-browser-controller"));

test("task board uses a stable header button instead of a draggable edge handle", () => {
  assert.match(html, /id="taskBoardToggleBtn" class="task-board-header-button"/);
  assert.match(html, /M8 8v8M12 8v5M16 8v8/);
  assert.match(styles, /\.task-board-header-button\s*\{[\s\S]*?color:\s*var\(--accent\)/);
  assert.doesNotMatch(html, /class="task-board-edge-toggle"/);
  assert.match(styles, /\.task-board-header-button\s*\{[\s\S]*?cursor: pointer;/);
  assert.doesNotMatch(rendererSource, /bindTaskBoardToggleDrag|taskBoardToggleDragState|taskBoardTogglePositionState/);
  assert.match(rendererSource, /taskBoardToggleBtn\.setAttribute\("aria-expanded"/);
});

test("browser home detaches through an atomic standalone ownership transition", () => {
  const embeddedHtml = rendererSource.slice(rendererSource.indexOf("function taskBoardEmbeddedBrowserHtml"), rendererSource.indexOf("function embeddedBrowserBounds"));
  const detachHandler = rendererSource.slice(rendererSource.indexOf('body.querySelector("[data-browser-external]")'), rendererSource.indexOf('body.querySelector("[data-browser-close-page]")'));
  assert.match(embeddedHtml, /data-browser-external[\s\S]*?\$\{tabs\.length \? "" : "disabled"\}/);
  assert.match(preloadSource, /browserDetach: \(\) => ipcRenderer\.invoke\("browser:detach"\)/);
  assert.match(detachHandler, /api\.browserDetach\?\.\(\)/);
  assert.doesNotMatch(detachHandler, /api\.browserOpen/);
  assert.match(mainSource, /function setBlackBallBrowserOwner\(owner = "hidden"\)/);
  assert.match(mainSource, /function detachBlackBallBrowserToStandalone\(\)/);
  assert.match(mainSource, /ipcMain\.handle\("browser:detach", \(\) => detachBlackBallBrowserToStandalone\(\)\)/);
  assert.match(mainSource, /blackBallBrowserOwner === "standalone" && payload\.forceOwnership !== true/);
});

test("model browser tools are scoped to real tab and document identities", async () => {
  const ids = browserActionTools.map((tool) => tool.id);
  for (const id of ["browser_list_tabs", "browser_open_tab", "browser_select_tab", "browser_close_tab"]) {
    assert.ok(ids.includes(id), `${id} is registered`);
  }
  for (const id of ["browser_click", "browser_confirm_action", "browser_type", "browser_scroll", "browser_wait", "browser_screenshot"]) {
    const required = browserActionTools.find((tool) => tool.id === id)?.parameters?.required || [];
    assert.ok(required.includes("tabId"), `${id} requires tabId`);
    assert.ok(required.includes("documentId"), `${id} requires documentId`);
  }
  const calls = [];
  const listTabs = browserActionTools.find((tool) => tool.id === "browser_list_tabs");
  const response = await listTabs.execute({}, { runtime: { executeBrowserAction: async (action, params) => { calls.push({ action, params }); return { ok: true, tabs: [] }; } } });
  assert.equal(response.success, true);
  assert.deepEqual(calls, [{ action: "list_tabs", params: {} }]);
  assert.match(browserControllerSource, /contents\(tabId = ""\)[\s\S]*?this\.getWebContents\?\.\(tabId\)/);
  assert.match(mainSource, /params\.documentId !== tab\.documentId/);
  assert.match(mainSource, /runBlackBallBrowserTabAction\(tab\.id/);
  assert.match(mainSource, /advanceBlackBallBrowserDocument\(tab/);
  assert.match(mainSource, /documentId: tab\.documentId/);
});

test("tab routing is exact and a wait stops when its document becomes stale", async () => {
  const requestedTabs = [];
  let scriptExecutions = 0;
  const controller = new BlackBallBrowserController({
    getWebContents: (tabId) => {
      requestedTabs.push(tabId);
      return {
        isDestroyed: () => false,
        executeJavaScript: async () => {
          scriptExecutions += 1;
          return { url: "https://example.com", elements: [], text: "" };
        }
      };
    },
    getDocumentId: () => "tab-b:document:2",
    screenshotRoot: () => root
  });
  await controller.inspect({ tabId: "tab-b" });
  assert.deepEqual(requestedTabs, ["tab-b"]);
  const stale = await controller.wait({ tabId: "tab-b", documentId: "tab-b:document:1", timeoutMs: 100 });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(scriptExecutions, 1, "stale wait does not execute against the replacement document");
});

test("embedded browser tracks the real viewport instead of a one-time task-board layout", () => {
  const source = rendererSource.slice(rendererSource.indexOf("function embeddedBrowserBounds"), rendererSource.indexOf("function markTaskBoardSheetDirty"));
  assert.match(source, /new ResizeObserver\(\(\) => requestEmbeddedBrowserLayout\(\)\)/);
  assert.match(source, /embeddedBrowserResizeObserver\.observe\(viewport\)/);
  assert.match(source, /const taskBoardControlGutter = 48/);
  assert.match(source, /width: Math\.max\(1, rect\.width - taskBoardControlGutter - drawerWidth\)/);
  assert.doesNotMatch(source, /task-board-browser-history/);
});

test("browser shell exposes one-click bookmarks and keeps history compact", () => {
  assert.match(mainSource, /function toggleBlackBallBrowserBookmark\(\)/);
  assert.match(mainSource, /history\.slice\(0, 16\)/);
  assert.match(browserPreloadSource, /toggleBookmark: \(\) => ipcRenderer\.invoke\("black-ball-browser:bookmark-toggle"\)/);
  assert.match(browserShellSource, /bookmarkBtn\.addEventListener\("click", \(\) => api\.toggleBookmark\(\)\)/);
  assert.match(preloadSource, /browserToggleBookmark: \(\) => ipcRenderer\.invoke\("browser:bookmark-toggle"\)/);
  assert.doesNotMatch(mainSource, /\.grid\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(190px,1fr\)\)/);
  assert.match(mainSource, /class="history-row"/);
  assert.match(mainSource, /data-browser-home-kind="bookmark"/);
  assert.match(mainSource, /data-browser-home-kind="history"/);
  assert.match(mainSource, /contents\.on\("context-menu"/);
  assert.match(mainSource, /label: item\.kind === "bookmark" \? "删除收藏" : "删除这条记录"/);
  assert.match(preloadSource, /browserRemoveBookmark: \(url\) => ipcRenderer\.invoke\("browser:bookmark-remove", url\)/);
  assert.match(preloadSource, /browserBookmarkContextMenu: \(url\) => ipcRenderer\.invoke\("browser:bookmark-context-menu", url\)/);
  assert.match(mainSource, /function showBlackBallBrowserBookmarkContextMenu\(url = ""\)/);
  assert.match(mainSource, /label: "删除收藏",\s*click: \(\) => removeBlackBallBrowserBookmark\(target\)/);
  assert.match(mainSource, /ipcMain\.handle\("browser:bookmark-context-menu", \(_event, url = ""\) => showBlackBallBrowserBookmarkContextMenu\(url\)\)/);
  const bookmarkContextHandler = rendererSource.slice(rendererSource.indexOf('addEventListener("contextmenu"'), rendererSource.indexOf('body.querySelector("[data-browser-analyze]"'));
  assert.match(bookmarkContextHandler, /api\.browserBookmarkContextMenu\?\.\(button\.dataset\.browserBookmarkUrl\)/);
  assert.doesNotMatch(bookmarkContextHandler, /api\.browserRemoveBookmark/);
  assert.match(mainSource, /blackBallBrowserHomeDayLabel/);
  assert.match(mainSource, /blackBallBrowserHomeTime\(item\.visitedAt\)/);
  assert.doesNotMatch(mainSource, /escapeBlackBallBrowserHomeTime/);
});

test("the close control sits with browser actions and returns to the browser home page", () => {
  assert.match(preloadSource, /browserClosePage: \(\) => ipcRenderer\.invoke\("browser:close-page"\)/);
  assert.match(preloadSource, /browserCloseTab: \(tabId\) => ipcRenderer\.invoke\("browser:close-tab", tabId\)/);
  assert.match(mainSource, /ipcMain\.handle\("browser:close-page", \(\) => closeBlackBallBrowserTab\(\)\)/);
  assert.match(mainSource, /if \(blackBallBrowserTabs\.length === 1\)[\s\S]*openBlackBallBrowser\(BLACK_BALL_BROWSER_HOME/);
  assert.match(rendererSource, /data-browser-close-page class="browser-close-icon"/);
  assert.match(rendererSource, /data-browser-close-page\]"\)\?\.addEventListener\("click", async \(\) => \{\s*await api\.browserClosePage/);
  assert.doesNotMatch(rendererSource, /data-browser-close-operation/);
  assert.doesNotMatch(rendererSource, /data-browser-nav="home"/);
});

test("browser tabs are real views with new, select, and close actions", () => {
  assert.match(mainSource, /let blackBallBrowserTabs = \[\]/);
  assert.match(mainSource, /function createAndMountBlackBallBrowserTab\(\)/);
  assert.match(mainSource, /function selectBlackBallBrowserTab\(tabId = ""\)/);
  assert.match(mainSource, /function closeBlackBallBrowserTab\(tabId = ""\)/);
  assert.match(mainSource, /contents\.setWindowOpenHandler\(\(details\) => \{/);
  assert.match(mainSource, /newTab: true/);
  assert.match(rendererSource, /data-browser-new-tab/);
  assert.match(rendererSource, /data-browser-tab-close/);
  assert.match(browserShellSource, /browserTabs/);
  assert.match(browserShellSource, /api\.newTab/);
  assert.match(browserShellSource, /api\.closeTab/);
});

test("browser initialization returns live tab state and standalone tabs receive stable bounds", () => {
  assert.match(rendererSource, /api\.browserEmbed\?\.\([\s\S]*?\.then\(\(result\) => \{/);
  assert.match(rendererSource, /state\.blackBallBrowser = \{ \.\.\.state\.blackBallBrowser, \.\.\.result\.state \}/);
  assert.match(rendererSource, /const shouldRender = Boolean\(/);
  assert.match(rendererSource, /error: error\?\.message \|\| "黑球浏览器启动失败"/);
  assert.match(mainSource, /const BLACK_BALL_BROWSER_TABS_HEIGHT = 34/);
  assert.match(mainSource, /const contentTop = BLACK_BALL_BROWSER_TOOLBAR_HEIGHT \+ BLACK_BALL_BROWSER_TABS_HEIGHT/);
  assert.match(mainSource, /else if \(blackBallBrowserView\) layoutBlackBallBrowserView\(\)/);
  assert.match(mainSource, /let blackBallBrowserInitialization = null/);
  assert.match(mainSource, /async function ensureBlackBallBrowserHome\(options = \{\}\)/);
  assert.match(mainSource, /if \(!blackBallBrowserInitialization\) \{[\s\S]*?openBlackBallBrowser\(BLACK_BALL_BROWSER_HOME/);
  assert.match(mainSource, /await ensureBlackBallBrowserHome\(payload\)/);
  assert.match(rendererSource, /const visible = Boolean\(drawer && !drawer\.hidden && state\.taskBoardTab === "links" && !state\.blackBallBrowser\?\.standalone\)/);
  assert.match(rendererSource, /if \(visible && !bounds\) return/);
  assert.match(rendererSource, /newTab: true[\s\S]*?\.catch\(\(error\) => \(\{ success: false, error: error\?\.message \|\| "新标签页打开失败" \}\)\)/);
});

test("background tab navigation cannot overwrite the active tab public URL", () => {
  const recordStart = mainSource.indexOf("function recordBlackBallBrowserVisit");
  const recordEnd = mainSource.indexOf("function escapeBlackBallBrowserHtml", recordStart);
  const recordSource = mainSource.slice(recordStart, recordEnd);
  assert.match(recordSource, /sendBlackBallBrowserState\(\{ lastVisitedAt: entry\.visitedAt \}/);
  assert.doesNotMatch(recordSource, /sendBlackBallBrowserState\(\{ url,/);
  assert.match(mainSource, /contents\.on\("page-title-updated"[\s\S]*?sendBlackBallBrowserState\(\{\}, \{ persist: true \}\)/);
  assert.match(mainSource, /const activeUrl = activeTab\?\.isHome/);
  assert.match(mainSource, /isBookmarked: blackBallBrowserState\.bookmarks\.some\(\(item\) => item\.url === activeUrl\)/);
  assert.doesNotMatch(mainSource, /let blackBallBrowserNavigation/);
  assert.match(mainSource, /navigation: null/);
  assert.match(mainSource, /const contents = tab\?\.view\?\.webContents/);
  assert.match(mainSource, /if \(tab\.navigation\?\.url === navigationUrl\)/);
  assert.match(mainSource, /if \(tab\.navigation === entry\) tab\.navigation = null/);
  assert.match(mainSource, /contents\.loadFile\(tab\.homeFile \|\| blackBallBrowserHomeFile\(tab\.id\)\)/);
  assert.match(mainSource, /code === -3 \|\| code === -2/);
  assert.match(mainSource, /ERR_ABORTED\|\\\(-3\\\)\|\\\(-2\\\)/);
});

test("the browser home removes its duplicate page label while retaining page labels for websites", () => {
  assert.match(rendererSource, /const pageBar = browser\.url && browser\.url !== "baiqiu:\/\/browser-home"/);
  assert.match(rendererSource, /\$\{pageBar\}/);
});

test("embedded browser exposes a lightweight history and bookmark drawer", () => {
  assert.match(rendererSource, /data-browser-history-drawer-toggle/);
  assert.match(rendererSource, /data-browser-history-tab="history"/);
  assert.match(rendererSource, /data-browser-history-tab="bookmarks"/);
  assert.match(rendererSource, /embeddedBrowserHistoryDrawerTab = "history"/);
  assert.match(rendererSource, /data-browser-history-url/);
  assert.match(rendererSource, /data-browser-drawer-bookmark-url/);
  assert.match(rendererSource, /embeddedBrowserRelativeTime/);
  assert.match(rendererSource, /embeddedBrowserHistoryDrawerOpen = !embeddedBrowserHistoryDrawerOpen/);
  assert.match(rendererSource, /drawerWidth/);
});

test("password storage is explicit and encrypted while login sessions remain in the browser profile", () => {
  assert.match(mainSource, /safeStorage\.encryptString\(password\)/);
  assert.match(mainSource, /safeStorage\.decryptString/);
  assert.match(mainSource, /electronSession\.fromPath\(profilePath\)/);
  assert.match(browserPreloadSource, /saveCredential: \(payload\) => ipcRenderer\.invoke\("black-ball-browser:credential-save", payload\)/);
});

test("browser visits notify the task-board edge control until the board is opened", () => {
  assert.match(rendererSource, /TASK_BOARD_BROWSER_READ_KEY/);
  assert.match(rendererSource, /setTaskBoardBrowserUnread\(true\)/);
  assert.match(rendererSource, /setTaskBoardBrowserUnread\(false\)/);
  assert.match(html, /task-board-browser-dot/);
  assert.match(styles, /task-board-browser-dot/);
});

test("Black Ball continues high-risk browser actions without a White Ball permission mode", () => {
  const start = mainSource.indexOf("async function executeBlackBallBrowserAction");
  const end = mainSource.indexOf("async function applyBlackBallBrowserColorScheme", start);
  const executeBrowserAction = mainSource.slice(start, end);
  const promptStart = mainSource.indexOf("function browserAutomationPrompt()");
  const promptEnd = mainSource.indexOf("function cleanAssistantText", promptStart);
  const browserPrompt = mainSource.slice(promptStart, promptEnd);
  assert.match(executeBrowserAction, /controller\.click\(params\)/);
  assert.match(executeBrowserAction, /controller\.click\(params, \{ confirmed: true \}\)/);
  assert.doesNotMatch(browserPrompt, /permissionTrustEnabled|currentToolAccessMode/);
  assert.match(browserPrompt, /browser_click、browser_confirm_action、browser_type/);
  assert.match(browserPrompt, /立即调用 browser_confirm_action 执行同一元素，不要在聊天中追加白球权限确认/);
  assert.match(mainSource, /密码框禁止自动填写/);
});

test("browser capabilities are selected per request and never require a new conversation", () => {
  const detectorStart = mainSource.indexOf("function requestsBrowserAutomation");
  const detectorEnd = mainSource.indexOf("function referencedTableOrdinals", detectorStart);
  const requestsBrowserAutomation = new Function(
    `${mainSource.slice(detectorStart, detectorEnd)}; return requestsBrowserAutomation;`
  )();
  assert.equal(requestsBrowserAutomation("去牵牛花后台查看导出字段"), true);
  assert.equal(requestsBrowserAutomation("打开页面弹窗并勾选字段"), true);
  assert.equal(requestsBrowserAutomation("我们聊聊平台设计"), false);

  const catalogStart = mainSource.indexOf("function hmsToolCatalogForRequest");
  const catalogEnd = mainSource.indexOf("function requestsBrowserAutomation", catalogStart);
  const catalogSource = mainSource.slice(catalogStart, catalogEnd);
  assert.match(catalogSource, /const browserRequested = requestsBrowserAutomation\(options\.message\);/);
  assert.match(catalogSource, /const blackBallOwnsDecision = options\.blackBallOwnsDecision === true/);
  assert.match(catalogSource, /const conversationOnly = !blackBallOwnsDecision[\s\S]{0,80}&& !browserRequested/);

  const promptStart = mainSource.indexOf("function browserAutomationPrompt()");
  const promptEnd = mainSource.indexOf("function cleanAssistantText", promptStart);
  const browserPrompt = mainSource.slice(promptStart, promptEnd);
  assert.match(browserPrompt, /能力清单按每次请求实时生成/);
  assert.match(browserPrompt, /不得建议用户为获得工具而新建对话/);
  assert.match(browserPrompt, /只看到知识工具不代表浏览器不可用/);
});
