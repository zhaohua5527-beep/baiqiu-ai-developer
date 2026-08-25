# 白球AI — 进程稳定性修复 Codex 方案

> 项目根目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/`
> 主进程文件: `main.js`（已安装版本约 17191 行）
> 技术栈: Electron 43 + 原生 JS（无框架）

---

## 问题背景

白球AI 运行时产生 6 个 Electron 子进程（正常架构），但存在三个代码缺陷导致进程卡死后无法恢复：

1. **"分析当前页"功能无超时**：`executeJavaScript()` 在网页渲染进程里执行 JS，如果网页很重（如百度首页），调用会无限期阻塞，渲染进程冻结（状态变为 Unknown）
2. **浏览器关闭时不销毁进程**：`WebContentsView` 只被设为 `null`，底层渲染进程变成孤儿，不被回收
3. **网页加载无超时**：`loadURL()` 没有 Promise 超时保护，慢页面会阻塞主流程

实际表现：PID 20576 占用 871MB、CPU 时间 29 分钟、状态 Unknown，整个应用无响应。

---

## Prompt 1: "分析当前页"添加超时保护（核心修复）

### 目标

`currentBlackBallBrowserSnapshot()` 的 `executeJavaScript()` 调用添加 15 秒超时。超时后返回错误，不再无限阻塞渲染进程。

### 修改

**文件**: `main.js`

**搜索锚点**（约第 945-955 行）:
```js
async function currentBlackBallBrowserSnapshot() {
  if (!blackBallBrowserView || blackBallBrowserView.webContents.isDestroyed()) throw new Error("黑球浏览器尚未打开网页");
  return blackBallBrowserView.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("main, article, [role='main']") || document.body;
    return {
      url: location.href,
      title: document.title || location.hostname,
      content: String(root?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 60000)
    };
  })()`, true);
}
```

**改为**:
```js
async function currentBlackBallBrowserSnapshot() {
  if (!blackBallBrowserView || blackBallBrowserView.webContents.isDestroyed()) throw new Error("黑球浏览器尚未打开网页");
  const snapshotPromise = blackBallBrowserView.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("main, article, [role='main']") || document.body;
    return {
      url: location.href,
      title: document.title || location.hostname,
      content: String(root?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 60000)
    };
  })()`, true);
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("页面内容提取超时")), 15000);
  });
  try {
    return await Promise.race([snapshotPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**原理**：
- `Promise.race` 让 `executeJavaScript` 和 15 秒超时竞争
- 如果 15 秒内 `executeJavaScript` 完成，正常返回结果，`clearTimeout` 取消超时
- 如果 15 秒超时先触发，抛出 `Error("页面内容提取超时")`，调用方（`black-ball-browser:analyze-current` IPC 处理器，约第 16931 行）收到错误，返回 `{ success: false, error: "页面内容提取超时" }` 给浏览器前端
- 浏览器前端 `black-ball-browser.js` 第 67 行已有错误处理：`analyzeBtn.textContent = result?.success ? "已发送" : "提取失败"`
- 超时后 `executeJavaScript` 的 Promise 仍然 pending（无法取消），但不再阻塞调用方流程，用户看到"提取失败"而不是永远转圈

### 验证要点

1. 打开黑球浏览器，导航到百度首页，点击"分析当前页"
2. 如果页面正常，15 秒内应显示"已发送"
3. 如果页面很重导致卡顿，15 秒后应显示"提取失败"，不再无限等待
4. 超时后浏览器其他功能（导航、前进后退）应仍可正常使用

---

## Prompt 2: 浏览器关闭时显式销毁渲染进程

### 目标

浏览器窗口关闭时，显式销毁 `WebContentsView` 的 `webContents`，并从主窗口移除视图引用，防止孤儿进程残留。

### 修改

**文件**: `main.js`

**搜索锚点**（约第 850-857 行，在 `createBlackBallBrowserWindow` 函数内）:
```js
  blackBallBrowserWindow.on("closed", () => {
    stopBlackBallBrowserReveal();
    blackBallBrowserState.open = false;
    blackBallBrowserStandalone = false;
    blackBallBrowserWindow = null;
    blackBallBrowserView = null;
    sendBlackBallBrowserState({ open: false, loading: false });
  });
```

**改为**:
```js
  blackBallBrowserWindow.on("closed", () => {
    stopBlackBallBrowserReveal();
    blackBallBrowserState.open = false;
    blackBallBrowserStandalone = false;
    try {
      if (mainWindow && !mainWindow.isDestroyed() && blackBallBrowserView) {
        mainWindow.contentView.removeChildView(blackBallBrowserView);
      }
    } catch (error) {
      devLogError("browserView removeChildView", error, false);
    }
    try {
      if (blackBallBrowserView?.webContents && !blackBallBrowserView.webContents.isDestroyed()) {
        blackBallBrowserView.webContents.destroy();
      }
    } catch (error) {
      devLogError("browserView webContents destroy", error, false);
    }
    blackBallBrowserWindow = null;
    blackBallBrowserView = null;
    sendBlackBallBrowserState({ open: false, loading: false });
  });
```

**原理**：
- **问题根因**：当浏览器以嵌入模式（`blackBallBrowserEmbedded = true`）运行时，`attachBlackBallBrowserViewToMain()`（约第 685 行）会将 `blackBallBrowserView` 添加到 `mainWindow.contentView` 作为子视图。关闭浏览器窗口时，`closed` 事件处理器只将 JS 变量设为 `null`，但视图仍然挂在 `mainWindow.contentView` 上，底层渲染进程不会被销毁
- **修复**：关闭时先从 `mainWindow.contentView` 移除子视图（`removeChildView`），再显式销毁 `webContents`（`destroy()`），最后才设为 `null`
- `webContents.destroy()` 会强制终止渲染进程，释放内存
- 两处 `try/catch` 防止在窗口已销毁或视图已失效时抛出未捕获异常
- `devLogError` 是项目中已有的错误日志函数

### 验证要点

1. 打开黑球浏览器，浏览几个网页，然后关闭浏览器窗口
2. 打开任务管理器，确认白球AI的进程数从 6 个减少（浏览器渲染进程应被回收）
3. 重新打开黑球浏览器，确认功能正常
4. 嵌入模式下关闭浏览器，确认主窗口不受影响，且进程被清理

---

## Prompt 3: 网页加载添加超时保护

### 目标

`openBlackBallBrowser()` 中的 `loadURL()` 添加 30 秒超时。超时后停止加载并返回错误，不再无限阻塞。

### 修改

**文件**: `main.js`

**搜索锚点**（约第 916-925 行，在 `openBlackBallBrowser` 函数内）:
```js
    } else {
      const navigation = Promise.resolve(blackBallBrowserView.webContents.loadURL(url));
      const entry = { url, promise: navigation };
      blackBallBrowserNavigation = entry;
      try {
        await navigation;
      } catch (error) {
        if (!isExpectedBrowserNavigationAbort(error)) throw error;
      } finally {
        if (blackBallBrowserNavigation === entry) blackBallBrowserNavigation = null;
      }
    }
```

**改为**:
```js
    } else {
      const navigation = blackBallBrowserView.webContents.loadURL(url);
      const entry = { url, promise: navigation };
      blackBallBrowserNavigation = entry;
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("页面加载超时")), 30000);
      });
      try {
        await Promise.race([navigation, timeoutPromise]);
      } catch (error) {
        if (!isExpectedBrowserNavigationAbort(error)) {
          if (/超时/.test(String(error?.message || ""))) {
            try { blackBallBrowserView.webContents.stop(); } catch {}
          } else {
            throw error;
          }
        }
      } finally {
        clearTimeout(timeoutId);
        if (blackBallBrowserNavigation === entry) blackBallBrowserNavigation = null;
      }
    }
```

**原理**：
- `Promise.race` 让 `loadURL` 和 30 秒超时竞争
- 超时后调用 `webContents.stop()` 停止加载，释放阻塞
- 去掉了原代码的 `Promise.resolve()` 包装（不需要，`loadURL` 本身返回 Promise）
- `clearTimeout` 在 `finally` 中执行，确保无论成功还是失败都清理定时器
- 非超时错误（如 `ERR_ABORTED`）仍走原有的 `isExpectedBrowserNavigationAbort` 逻辑
- 超时错误被静默吞掉（不 `throw`），因为页面可能部分加载了，用户可以看到部分内容

### 验证要点

1. 导航到一个正常网页（如 google.com），确认正常加载
2. 导航到一个已知很慢的网页，确认 30 秒后不再卡在加载状态
3. 超时后确认浏览器仍可操作（可以输入新网址、前进后退）
4. 确认 `blackBallBrowserNavigation` 在超时后被正确清理（`finally` 块执行）

---

## 预期效果

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| 分析重网页（百度首页） | 渲染进程冻结，871MB，状态 Unknown | 15 秒超时，显示"提取失败"，进程不冻结 |
| 关闭浏览器窗口 | 渲染进程变孤儿，内存不释放 | 进程立即销毁，内存回收 |
| 加载慢网页 | 主流程无限阻塞 | 30 秒超时，停止加载，恢复操作 |

---

## 注意事项

1. **`devLogError` 函数**：项目中已有的错误日志函数，签名 `devLogError(label, error, isFatal)`。如果不确定是否存在，搜索 `function devLogError` 确认
2. **`WebContentsView` API**：Electron 43 使用 `WebContentsView`（不是旧版 `BrowserView`）。`webContents.destroy()` 是强制销毁渲染进程的方法
3. **`executeJavaScript` 无法取消**：超时后 Promise 仍 pending，但不再阻塞调用方。渲染进程会在下一次垃圾回收或页面导航时恢复
4. **源代码版本差异**：源代码仓库（`source-current/main.js`）与已安装版本行���不同，请通过函数名和代码片段搜索定位
5. **备份**：修改前请备份 `main.js`
6. **语法验证**：修改后执行 `node --check main.js` 确认无语法错误
