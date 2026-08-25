# 黑球浏览器 — 历史记录 / 收藏 / 对话关联 Codex 方案

> 项目根目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/`
> 涉及文件:
> - `main.js` — 主进程，IPC 处理器，状态管理
> - `browser-preload.js` — 浏览器预加载脚本，IPC 桥接
> - `renderer-v2/black-ball-browser.html` — 浏览器工具栏 HTML
> - `renderer-v2/black-ball-browser.css` — 浏览器样式
> - `renderer-v2/black-ball-browser.js` — 浏览器前端逻辑

---

## 现有基础设施

### 已有的数据流

```
main.js                          browser-preload.js          black-ball-browser.js
─────────                        ──────────────────          ─────────────────────
browserPublicState() ──state──→  onState(handler) ────────→  applyState(state)
  ├─ history: [{url,title,visitedAt}...]                        ├─ 更新地址栏
  ├─ url, title, loading                                         ├─ 更新按钮状态
  ├─ canGoBack, canGoForward                                     └─ (history 未使用!)
  └─ sourceSessionId
```

- `blackBallBrowserState.history` 已存储最多 40 条浏览记录，通过 `browserPublicState()` 下发
- `blackBallBrowserSourceSessionId` 已跟踪来源对话，通过 `browserPublicState().sourceSessionId` 下发
- `persistBlackBallBrowserState()` 已将 history 持久化到 `browser-state.json`
- **但前端 `applyState()` 完全忽略了 `history` 和 `sourceSessionId` 字段**

### 持久化文件

`browser-state.json` 当前结构：
```json
{
  "updatedAt": "2026-08-09T...",
  "lastUrl": "https://www.baidu.com",
  "history": [{ "url": "...", "title": "...", "visitedAt": "..." }]
}
```

---

## Prompt 1: 历史记录面板

### 目标

在浏览器工具栏添加"历史"按钮，点击弹出下拉面板显示浏览记录，点击记录项可快速导航。数据已存在，只需加 UI。

### 修改 1A: HTML — 添加历史按钮和面板

**文件**: `renderer-v2/black-ball-browser.html`

**搜索锚点**:
```html
    <div class="browser-actions">
      <span id="loadingState" aria-live="polite"></span>
```

**在其前面插入**:
```html
    <div class="browser-dropdown" id="historyDropdown">
      <button id="historyBtn" type="button" title="历史记录" aria-label="历史记录" aria-haspopup="true" aria-expanded="false">&#x1f551;</button>
      <div class="browser-dropdown-panel" id="historyPanel" hidden>
        <div class="dropdown-panel-header">
          <span>历史记录</span>
          <button id="clearHistoryBtn" type="button" title="清空历史">清空</button>
        </div>
        <div class="dropdown-panel-list" id="historyList"></div>
      </div>
    </div>
```

### 修改 1B: CSS — 历史面板样式

**文件**: `renderer-v2/black-ball-browser.css`

**在文件末尾（`@media` 之前）添加**:
```css
.browser-dropdown { position: relative; }
.browser-dropdown-panel { position: absolute; top: 100%; right: 0; z-index: 100; width: 340px; max-height: 400px; display: flex; flex-direction: column; border: 1px solid var(--browser-line-strong); border-radius: 7px; background: var(--browser-panel); box-shadow: 0 4px 16px rgba(0,0,0,.12); overflow: hidden; }
.dropdown-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--browser-line); font-size: 12px; font-weight: 500; color: var(--browser-muted); }
.dropdown-panel-header button { min-width: auto; height: auto; padding: 2px 8px; font-size: 11px; color: var(--browser-muted); }
.dropdown-panel-header button:hover { color: var(--browser-accent); }
.dropdown-panel-list { flex: 1; overflow-y: auto; }
.dropdown-panel-list:empty::after { content: "暂无记录"; display: block; padding: 24px; text-align: center; color: var(--browser-muted); font-size: 12px; }
.history-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-bottom: 1px solid var(--browser-line); cursor: pointer; }
.history-item:hover { background: var(--browser-accent-soft); }
.history-item-title { font-size: 13px; color: var(--browser-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.history-item-url { font-size: 11px; color: var(--browser-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.history-item-time { font-size: 10px; color: var(--browser-muted); }
```

### 修改 1C: JS — 历史面板逻辑

**文件**: `renderer-v2/black-ball-browser.js`

**搜索锚点**（文件末尾附近）:
```js
api.onState(applyState);
api.getState().then(applyState);
```

**在 `api.onState(applyState)` 之前添加**:
```js
const historyBtn = document.getElementById("historyBtn");
const historyPanel = document.getElementById("historyPanel");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
let historyItems = [];

function renderHistoryList() {
  historyList.innerHTML = "";
  historyItems.slice(0, 30).forEach((item) => {
    const el = document.createElement("div");
    el.className = "history-item";
    const titleEl = document.createElement("span");
    titleEl.className = "history-item-title";
    titleEl.textContent = item.title || item.url;
    const urlEl = document.createElement("span");
    urlEl.className = "history-item-url";
    urlEl.textContent = item.url;
    const timeEl = document.createElement("span");
    timeEl.className = "history-item-time";
    timeEl.textContent = formatHistoryTime(item.visitedAt);
    el.appendChild(titleEl);
    el.appendChild(urlEl);
    el.appendChild(timeEl);
    el.addEventListener("click", () => {
      api.navigate(item.url);
      toggleHistoryPanel(false);
    });
    historyList.appendChild(el);
  });
}

function formatHistoryTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return new Date(iso).toLocaleDateString("zh-CN");
}

function toggleHistoryPanel(force) {
  const show = force !== undefined ? force : historyPanel.hidden;
  historyPanel.hidden = !show;
  historyBtn.setAttribute("aria-expanded", String(show));
  if (show) renderHistoryList();
}

historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleHistoryPanel();
});
clearHistoryBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  historyItems = [];
  historyList.innerHTML = "";
  toggleHistoryPanel(false);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#historyDropdown")) toggleHistoryPanel(false);
});
```

**修改 `applyState` 函数，在函数末尾添加**:
```js
  if (state.history) {
    historyItems = state.history;
  }
```

### 修改 1D: preload.js — 暴露清空历史 IPC

**文件**: `browser-preload.js`

**搜索锚点**:
```js
  openExternal: () => ipcRenderer.invoke("black-ball-browser:open-external"),
```

**在其后添加**:
```js
  clearHistory: () => ipcRenderer.invoke("black-ball-browser:clear-history"),
```

### 修改 1E: main.js — 清空历史 IPC 处理器

**文件**: `main.js`

**搜索锚点**（约第 16924 行）:
```js
  ipcMain.handle("black-ball-browser:home", async () => openBlackBallBrowser("https://www.google.com/", { sessionId: blackBallBrowserSourceSessionId, forceNavigate: true }));
```

**在其后添加**:
```js
  ipcMain.handle("black-ball-browser:clear-history", () => {
    blackBallBrowserState.history = [];
    persistBlackBallBrowserState();
    return browserPublicState();
  });
```

---

## Prompt 2: 收藏当前网页

### 目标

在地址栏右侧添加收藏按钮（星标），点击收藏/取消收藏当前网页。收藏列表通过下拉面板查看和访问。收藏数据持久化到 `browser-state.json`。

### 修改 2A: main.js — 收藏数据结构和持久化

**文件**: `main.js`

**搜索锚点**（约第 542-551 行）:
```js
const blackBallBrowserState = {
  open: false,
  loading: false,
  url: "",
  title: "黑球浏览器",
  error: "",
  canGoBack: false,
  canGoForward: false,
  history: loadBlackBallBrowserHistory()
};
```

**改为**:
```js
const blackBallBrowserState = {
  open: false,
  loading: false,
  url: "",
  title: "黑球浏览器",
  error: "",
  canGoBack: false,
  canGoForward: false,
  history: loadBlackBallBrowserHistory(),
  bookmarks: loadBlackBallBrowserBookmarks()
};
```

**搜索锚点**（`loadBlackBallBrowserHistory` 函数之后，约第 540 行）:
```js
function loadBlackBallBrowserHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(blackBallBrowserStateFile(), "utf8"));
    return Array.isArray(parsed.history) ? parsed.history.filter((item) => /^https?:\/\//i.test(String(item?.url || ""))).slice(0, 40) : [];
  } catch {
    return [];
  }
}
```

**在其后添加**:
```js
function loadBlackBallBrowserBookmarks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(blackBallBrowserStateFile(), "utf8"));
    return Array.isArray(parsed.bookmarks) ? parsed.bookmarks.filter((item) => /^https?:\/\//i.test(String(item?.url || ""))).slice(0, 200) : [];
  } catch {
    return [];
  }
}
```

**搜索锚点**（`persistBlackBallBrowserState` 函数，约第 553-563 行）:
```js
function persistBlackBallBrowserState() {
  try {
    fs.writeFileSync(blackBallBrowserStateFile(), JSON.stringify({
      updatedAt: new Date().toISOString(),
      lastUrl: blackBallBrowserState.url,
      history: blackBallBrowserState.history.slice(0, 40)
    }, null, 2), "utf8");
  } catch (error) {
    devLogError("persistBlackBallBrowserState", error, false);
  }
}
```

**改为**:
```js
function persistBlackBallBrowserState() {
  try {
    fs.writeFileSync(blackBallBrowserStateFile(), JSON.stringify({
      updatedAt: new Date().toISOString(),
      lastUrl: blackBallBrowserState.url,
      lastSessionId: blackBallBrowserSourceSessionId,
      history: blackBallBrowserState.history.slice(0, 40),
      bookmarks: blackBallBrowserState.bookmarks.slice(0, 200)
    }, null, 2), "utf8");
  } catch (error) {
    devLogError("persistBlackBallBrowserState", error, false);
  }
}
```

### 修改 2B: main.js — 收藏 IPC 处理器

**文件**: `main.js`

**搜索锚点**（约第 16924 行，与 Prompt 1E 同位置）:
```js
  ipcMain.handle("black-ball-browser:home", async () => openBlackBallBrowser("https://www.google.com/", { sessionId: blackBallBrowserSourceSessionId, forceNavigate: true }));
```

**在其后添加**:
```js
  ipcMain.handle("black-ball-browser:bookmark-toggle", () => {
    const url = blackBallBrowserView?.webContents?.getURL?.() || blackBallBrowserState.url;
    if (!/^https?:\/\//i.test(url)) return { success: false, error: "当前页面无法收藏" };
    const title = blackBallBrowserView?.webContents?.getTitle?.() || blackBallBrowserState.title || new URL(url).hostname;
    const existing = blackBallBrowserState.bookmarks.findIndex((item) => item.url === url);
    if (existing >= 0) {
      blackBallBrowserState.bookmarks.splice(existing, 1);
    } else {
      blackBallBrowserState.bookmarks.unshift({ url, title: sanitizeText(title), createdAt: new Date().toISOString() });
    }
    persistBlackBallBrowserState();
    return { success: true, bookmarked: existing < 0, bookmarks: blackBallBrowserState.bookmarks };
  });
  ipcMain.handle("black-ball-browser:bookmark-remove", (_event, url) => {
    blackBallBrowserState.bookmarks = blackBallBrowserState.bookmarks.filter((item) => item.url !== url);
    persistBlackBallBrowserState();
    return { success: true, bookmarks: blackBallBrowserState.bookmarks };
  });
```

**同时修改 `browserPublicState()` 函数**（约第 579-591 行）:

**搜索锚点**:
```js
function browserPublicState() {
  const navigation = blackBallBrowserView?.webContents?.navigationHistory;
  return {
    ...blackBallBrowserState,
    embedded: blackBallBrowserEmbedded,
    standalone: blackBallBrowserStandalone,
    theme: { ...blackBallBrowserThemeState },
    canGoBack: Boolean(navigation?.canGoBack?.()),
    canGoForward: Boolean(navigation?.canGoForward?.()),
    profilePath: blackBallBrowserProfileRoot(),
    sourceSessionId: blackBallBrowserSourceSessionId
  };
}
```

**改为**:
```js
function browserPublicState() {
  const navigation = blackBallBrowserView?.webContents?.navigationHistory;
  const currentUrl = blackBallBrowserView?.webContents?.getURL?.() || blackBallBrowserState.url;
  return {
    ...blackBallBrowserState,
    embedded: blackBallBrowserEmbedded,
    standalone: blackBallBrowserStandalone,
    theme: { ...blackBallBrowserThemeState },
    canGoBack: Boolean(navigation?.canGoBack?.()),
    canGoForward: Boolean(navigation?.canGoForward?.()),
    profilePath: blackBallBrowserProfileRoot(),
    sourceSessionId: blackBallBrowserSourceSessionId,
    currentBookmarked: blackBallBrowserState.bookmarks.some((item) => item.url === currentUrl)
  };
}
```

### 修改 2C: browser-preload.js — 暴露收藏 IPC

**文件**: `browser-preload.js`

**搜索锚点**:
```js
  openExternal: () => ipcRenderer.invoke("black-ball-browser:open-external"),
```

**在其后添加**:
```js
  bookmarkToggle: () => ipcRenderer.invoke("black-ball-browser:bookmark-toggle"),
  bookmarkRemove: (url) => ipcRenderer.invoke("black-ball-browser:bookmark-remove", url),
```

### 修改 2D: HTML — 添加收藏按钮和面板

**文件**: `renderer-v2/black-ball-browser.html`

**搜索锚点**:
```html
    <div class="browser-actions">
      <span id="loadingState" aria-live="polite"></span>
      <button id="analyzeBtn" class="primary" type="button" title="提取当前页面内容并发送到原会话">分析当前页</button>
```

**在 `<span id="loadingState"` 之前插入**:
```html
    <div class="browser-dropdown" id="bookmarkDropdown">
      <button id="bookmarkBtn" type="button" title="收藏当前网页" aria-label="收藏" aria-haspopup="true" aria-expanded="false">&#x2606;</button>
      <div class="browser-dropdown-panel" id="bookmarkPanel" hidden>
        <div class="dropdown-panel-header">
          <span>收藏夹</span>
        </div>
        <div class="dropdown-panel-list" id="bookmarkList"></div>
      </div>
    </div>
```

### 修改 2E: CSS — 收藏按钮样式

**文件**: `renderer-v2/black-ball-browser.css`

**在历史面板样式之后添加**:
```css
#bookmarkBtn[data-bookmarked="true"] { color: var(--browser-accent); }
#bookmarkBtn[data-bookmarked="true"]::after { content: "\2605"; }
#bookmarkBtn[data-bookmarked="true"] > * { display: none; }
.bookmark-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--browser-line); cursor: pointer; }
.bookmark-item:hover { background: var(--browser-accent-soft); }
.bookmark-item-text { flex: 1; min-width: 0; }
.bookmark-item-title { font-size: 13px; color: var(--browser-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bookmark-item-url { font-size: 11px; color: var(--browser-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bookmark-item-remove { flex-shrink: 0; min-width: 24px; height: 24px; padding: 0; font-size: 14px; color: var(--browser-muted); border: 0; background: transparent; cursor: pointer; }
.bookmark-item-remove:hover { color: #e24b4a; }
```

### 修改 2F: JS — 收藏逻辑

**文件**: `renderer-v2/black-ball-browser.js`

**在历史面板逻辑之后添加**:
```js
const bookmarkBtn = document.getElementById("bookmarkBtn");
const bookmarkPanel = document.getElementById("bookmarkPanel");
const bookmarkList = document.getElementById("bookmarkList");
let bookmarkItems = [];

function renderBookmarkList() {
  bookmarkList.innerHTML = "";
  if (bookmarkItems.length === 0) {
    bookmarkList.innerHTML = "";
    return;
  }
  bookmarkItems.forEach((item) => {
    const el = document.createElement("div");
    el.className = "bookmark-item";
    const textEl = document.createElement("div");
    textEl.className = "bookmark-item-text";
    const titleEl = document.createElement("div");
    titleEl.className = "bookmark-item-title";
    titleEl.textContent = item.title || item.url;
    const urlEl = document.createElement("div");
    urlEl.className = "bookmark-item-url";
    urlEl.textContent = item.url;
    textEl.appendChild(titleEl);
    textEl.appendChild(urlEl);
    const removeBtn = document.createElement("button");
    removeBtn.className = "bookmark-item-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.title = "移除收藏";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      api.bookmarkRemove(item.url).then((result) => {
        if (result?.success) {
          bookmarkItems = result.bookmarks || [];
          renderBookmarkList();
          updateBookmarkBtnState();
        }
      });
    });
    el.appendChild(textEl);
    el.appendChild(removeBtn);
    el.addEventListener("click", () => {
      api.navigate(item.url);
      toggleBookmarkPanel(false);
    });
    bookmarkList.appendChild(el);
  });
}

function updateBookmarkBtnState() {
  const currentUrl = addressInput.value;
  const bookmarked = bookmarkItems.some((item) => item.url === currentUrl);
  bookmarkBtn.dataset.bookmarked = String(bookmarked);
}

function toggleBookmarkPanel(force) {
  const show = force !== undefined ? force : bookmarkPanel.hidden;
  bookmarkPanel.hidden = !show;
  bookmarkBtn.setAttribute("aria-expanded", String(show));
  if (show) renderBookmarkList();
}

bookmarkBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (e.shiftKey || e.detail === 2) {
    toggleBookmarkPanel();
    return;
  }
  const result = await api.bookmarkToggle();
  if (result?.success) {
    bookmarkItems = result.bookmarks || [];
    updateBookmarkBtnState();
  }
});
bookmarkBtn.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  toggleBookmarkPanel();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#bookmarkDropdown")) toggleBookmarkPanel(false);
});
```

**修改 `applyState` 函数，追加**:
```js
  if (state.bookmarks) {
    bookmarkItems = state.bookmarks;
  }
  if (state.currentBookmarked !== undefined) {
    bookmarkBtn.dataset.bookmarked = String(state.currentBookmarked);
  } else {
    updateBookmarkBtnState();
  }
```

---

## Prompt 3: 保留上一个对话关联

### 目标

浏览器关闭后重新打开时，自动恢复上次的对话关联（`sourceSessionId`），并在工具栏显示来源对话标识。

### 修改 3A: main.js — 持久化和恢复 sourceSessionId

**文件**: `main.js`

**搜索锚点**（`loadBlackBallBrowserHistory` 函数之后，约第 540 行）:

在 Prompt 2A 中添加的 `loadBlackBallBrowserBookmarks` 之后，再添加:
```js
function loadBlackBallBrowserLastSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(blackBallBrowserStateFile(), "utf8"));
    return sanitizeText(parsed.lastSessionId || "");
  } catch {
    return "";
  }
}
```

**搜索锚点**（约第 364 行）:
```js
let blackBallBrowserSourceSessionId = "";
```

**改为**:
```js
let blackBallBrowserSourceSessionId = loadBlackBallBrowserLastSession();
```

> **注意**：`persistBlackBallBrowserState()` 已在 Prompt 2A 中修改为保存 `lastSessionId: blackBallBrowserSourceSessionId`，此处无需重复修改。

### 修改 3B: main.js — 获取对话标题 IPC

**文件**: `main.js`

**搜索锚点**（与其他 `black-ball-browser:` IPC 处理器一起，约第 16904 行之后）:

添加:
```js
  ipcMain.handle("black-ball-browser:get-session-info", () => {
    const sessionId = blackBallBrowserSourceSessionId;
    if (!sessionId) return { sessionId: "", title: "" };
    try {
      const db = loadDb();
      const session = (db.sessions || []).find((s) => s.id === sessionId);
      return { sessionId, title: session?.title || "未命名对话" };
    } catch {
      return { sessionId, title: "" };
    }
  });
```

### 修改 3C: browser-preload.js — 暴露对话信息 IPC

**文件**: `browser-preload.js`

**搜索锚点**:
```js
  openExternal: () => ipcRenderer.invoke("black-ball-browser:open-external"),
```

**在其后添加**:
```js
  getSessionInfo: () => ipcRenderer.invoke("black-ball-browser:get-session-info"),
```

### 修改 3D: HTML — 添加对话来源标识

**文件**: `renderer-v2/black-ball-browser.html`

**搜索锚点**:
```html
    <div class="browser-actions">
```

**在其前面插入**:
```html
    <div id="sessionBadge" class="session-badge" hidden title="当前页面分析将发送到此对话">
      <span class="session-badge-dot"></span>
      <span id="sessionBadgeText"></span>
    </div>
```

### 修改 3E: CSS — 对话标识样式

**文件**: `renderer-v2/black-ball-browser.css`

**添加**:
```css
.session-badge { display: flex; align-items: center; gap: 5px; max-width: 160px; padding: 0 10px; height: 28px; border-radius: 14px; background: var(--browser-accent-soft); color: var(--browser-accent); font-size: 12px; cursor: default; }
.session-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--browser-accent); flex-shrink: 0; }
.session-badge span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

### 修改 3F: JS — 显示对话来源

**文件**: `renderer-v2/black-ball-browser.js`

**在文件顶部变量声明区添加**:
```js
const sessionBadge = document.getElementById("sessionBadge");
const sessionBadgeText = document.getElementById("sessionBadgeText");
```

**在 `api.getState().then(applyState)` 之后添加**:
```js
async function updateSessionBadge() {
  const info = await api.getSessionInfo();
  if (info?.title) {
    sessionBadgeText.textContent = info.title;
    sessionBadge.hidden = false;
  } else {
    sessionBadge.hidden = true;
  }
}
updateSessionBadge();
```

**在 `applyState` 函数中追加**:
```js
  if (state.sourceSessionId !== undefined) {
    updateSessionBadge();
  }
```

---

## 完整文件变更清单

| 文件 | Prompt 1 (历史) | Prompt 2 (收藏) | Prompt 3 (对话) |
|------|-----------------|-----------------|-----------------|
| `main.js` | 1E: clear-history IPC | 2A: bookmarks 数据 + 持久化, 2B: bookmark IPC + browserPublicState | 3A: 持久化 sourceSessionId, 3B: get-session-info IPC |
| `browser-preload.js` | 1D: clearHistory | 2C: bookmarkToggle, bookmarkRemove | 3C: getSessionInfo |
| `black-ball-browser.html` | 1A: 历史按钮 + 面板 | 2D: 收藏按钮 + 面板 | 3D: 对话标识 |
| `black-ball-browser.css` | 1B: 历史面板样式 | 2E: 收藏样式 | 3E: 标识样式 |
| `black-ball-browser.js` | 1C: 渲染 + 交互 | 2F: 收藏逻辑 | 3F: 显示来源 |

## 交互设计总结

| 功能 | 触发方式 | 展示方式 |
|------|----------|----------|
| 历史记录 | 点击时钟按钮 | 下拉面板，显示标题+URL+时间，点击导航 |
| 收藏网页 | 单击星标按钮收藏/取消 | 右键或 Shift+点击打开收藏列表面板 |
| 对话关联 | 自动恢复 | 工具栏蓝色胶囊标识，显示来源对话名 |

## 注意事项

1. **执行顺序**：建议按 Prompt 1 → 2 → 3 顺序执行，因为 Prompt 2 修改了 `persistBlackBallBrowserState()`，Prompt 3 依赖此修改
2. **`browser-state.json` 兼容性**：新增 `bookmarks` 和 `lastSessionId` 字段，旧文件缺少这些字段时 `loadBlackBallBrowserBookmarks()` 和 `loadBlackBallBrowserLastSession()` 会返回空值，不会报错
3. **源代码与已安装版本**：两个版本的浏览器文件目前一致，修改后需同步到 `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/` 对应文件
4. **备份**：修改前请备份所有涉及文件
5. **语法验证**：`node --check main.js`、`node --check browser-preload.js`、`node --check renderer-v2/black-ball-browser.js`
