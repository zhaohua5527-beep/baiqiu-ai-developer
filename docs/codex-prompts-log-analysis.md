# 白球AI — 日志诊断与后端优化 Codex 方案

> 项目根目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/`
> 主进程文件: `main.js`（约 17226 行）
> 知识队列: `services/knowledge/conversation-knowledge-queue.js`（312 行）
> 技术栈: Electron 43 + 原生 JS + better-sqlite3

---

## 问题总览

从 4 份日志（crash.log / recovery.log / update.log / audit.log）+ conversation-trace.jsonl + main.js 启动代码中累积了 **10 个问题**，归为 5 类：

| 类别 | 问题编号 | 描述 | 直接导致UI卡死? | 已有方案? |
|------|----------|------|----------------|-----------|
| **A. 渲染进程阻塞** | 1 | `executeJavaScript()` 无超时 | ✅ 是 | ✅ 见 codex-prompts-process-stability.md |
| | 2 | `loadURL()` 无超时 | ✅ 是 | ✅ 同上 |
| | 3 | `WebContentsView` 不销毁 | ✅ 是 | ✅ 同上 |
| **B. 异常处理缺陷** | 5 | 知识队列 `this.db` 为 null 时崩溃 | ❌ 否（浪费资源） | ❌ 本文 Prompt 1 |
| **C. 启动时序问题** | 6 | `scheduleStartupMaintenance` 30秒内10个setTimeout | ❌ 否（争抢资源） | ❌ 本文 Prompt 2 |
| | 7 | 更新检查每次启动都跑，频繁失败 | ❌ 否（浪费网络） | ❌ 本文 Prompt 3 |
| **D. 性能感知** | 9 | 对话响应92%时间在思考（白屏） | ⚠️ 感知卡顿 | ✅ 见 codex-prompts-performance.md |
| **E. 观察项（无代码修复）** | 4 | health-probe recovery.log 噪声 | ❌ 否 | 见下文说明 |
| | 8 | 系统内存 70.72% | ❌ 否 | 见下文说明 |
| | 10 | 任务失败率 30%（6/20） | ❌ 否 | 见下文说明 |

### 已有方案文档（不在本文重复）

- **codex-prompts-process-stability.md** — 问题 1/2/3，三个渲染进程阻塞修复
- **codex-prompts-performance.md** — 问题 9，requireFinalEnvelope=false + 打字机提速

### 观察项说明（无需 Codex 修复）

**问题 4 — health-probe recovery.log 噪声**：
- recovery.log 中的 8 行重复日志并非真实失败，而是 `AgentHealthManager.checkRecovery()` 用 4 组合成错误（network timeout / ENOENT / PDF parse failed / EACCES）测试恢复策略时产生的日志
- 每次运行健康检查会生成 8 行（4 个 plan + 4 个 strategy），属于正常行为
- 唯一的问题是 2026-08-05 20:25 内 4 秒连续触发了 4 次健康检查，属于用户多次点击或前端重复触发，不是定时器空转
- **建议**：不做代码修改，仅在此记录以避免误诊

**问题 8 — 系统内存 70.72%**：
- audit.log 显示 16GB 内存用了 11.2GB，但这是整机内存，非白球AI独占
- 白球AI多进程模型正常消耗约 800MB-1.2GB
- **建议**：不做代码修改，如果用户机器内存 ≤8GB 可考虑减少后台任务并发度

**问题 10 — 任务失败率 30%**：
- conversation-trace.jsonl 显示 20 个任务中 6 个 failed，主要是表格处理任务
- 失败原因是模型执行错误（表格格式、UPC匹配等），不是进程卡顿导致
- **建议**：属于模型能力层面，不在进程稳定性方案范围内

---

## Prompt 1: 知识队列 catch 块防 null 崩溃

### 目标

`ConversationKnowledgeQueue.drainOnce()` 的 catch 块在 `this.db` 已被 `close()` 置为 null 时访问 `this.db.prepare()`，导致二次崩溃（unhandledRejection）。添加 null 守卫，使 catch 块在 db 已关闭时安全退出。

### 问题分析

**crash.log 记录**：
```
TypeError: Cannot read properties of null (reading 'prepare')
  at ConversationKnowledgeQueue.drainOnce (conversation-knowledge-queue.js:258:39)
  at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
  at async Timeout._onTimeout (conversation-knowledge-queue.js:278:22)
```

**根因链**：
1. `app.on("before-quit")` 调用 `conversationKnowledgeQueue?.close?.()`
2. `close()` 执行 `this.db?.close?.(); this.db = null;`
3. 此时 `drainOnce()` 可能正在异步执行中（`setTimeout` 回调已入队）
4. `drainOnce()` 的 try 块抛出错误（任何原因）
5. 进入 catch 块，执行 `this.db.prepare("SELECT attempts ...")` → `this.db` 已是 null → TypeError
6. TypeError 成为 unhandledRejection

### 修改

**文件**: `services/knowledge/conversation-knowledge-queue.js`

**搜索锚点**（约第 256-263 行）:
```js
    } catch (error) {
      const attempts = Number(this.db.prepare("SELECT attempts FROM knowledge_summary_jobs WHERE id=?").pluck().get(job.id) || 1);
      const state = attempts >= MAX_ATTEMPTS ? "failed" : "retry";
      const notBefore = state === "retry" ? Number(this.now()) + this.retryDelayMs * attempts : 0;
      this.db.prepare("UPDATE knowledge_summary_jobs SET state=?, not_before=?, updated_at=?, error=? WHERE id=?")
        .run(state, notBefore, Number(this.now()), clean(error?.message || String(error), 2000), job.id);
      return { processed: true, jobId: job.id, error: error?.message || String(error), state };
    } finally {
```

**改为**:
```js
    } catch (error) {
      if (!this.db) {
        return { processed: false, jobId: job.id, reason: "closed", error: error?.message || String(error) };
      }
      const attempts = Number(this.db.prepare("SELECT attempts FROM knowledge_summary_jobs WHERE id=?").pluck().get(job.id) || 1);
      const state = attempts >= MAX_ATTEMPTS ? "failed" : "retry";
      const notBefore = state === "retry" ? Number(this.now()) + this.retryDelayMs * attempts : 0;
      this.db.prepare("UPDATE knowledge_summary_jobs SET state=?, not_before=?, updated_at=?, error=? WHERE id=?")
        .run(state, notBefore, Number(this.now()), clean(error?.message || String(error), 2000), job.id);
      return { processed: true, jobId: job.id, error: error?.message || String(error), state };
    } finally {
```

**原理**：
- 在 catch 块顶部添加 `if (!this.db)` 守卫
- 如果 db 已被 `close()` 置为 null，直接返回 `{ processed: false, reason: "closed" }`，不再访问 `this.db.prepare()`
- 这阻止了 catch 块中的二次崩溃（TypeError: Cannot read properties of null）
- 返回 `processed: false` 让 `wake()` 知道没有处理成功，但因为 `this.closed === true`，`wake()` 不会再调度下一次
- 不影响正常流程：只有 db 非 null 时才走原有的 attempts 查询和状态更新逻辑

### 验证要点

1. 启动白球AI，发起一次对话让知识队列有 pending 任务
2. 在知识队列处理过程中关闭白球AI（触发 `before-quit` → `close()`）
3. 检查 crash.log，确认不再出现 `Cannot read properties of null (reading 'prepare')`
4. 正常使用场景下（不退出），知识队列的 retry/failed 状态更新功能不受影响

---

## Prompt 2: 启动后台任务错峰分散

### 目标

`scheduleStartupMaintenance()` 在启动后 30 秒内排了 10 个 `setTimeout` 后台任务，全部挤在用户首次交互的高峰窗口。将任务分散到更宽的时间范围（60 秒），降低启动期的 CPU/IO 竞争。

### 问题分析

**main.js 第 17007-17083 行**，当前启动时序：

| 延迟 | 任务 | 耗时估计 |
|------|------|----------|
| 2.5s | `startAutomaticWorkStateSnapshots()` | 低（启动定时器） |
| 4s | `reconcileInterruptedExecutionState()` | 中（DB 查询） |
| 6s | `ensureUpdateV2Layout` + `recoverInterruptedUpdate` + license | 中（文件IO） |
| 8s | `removeStaleProductDefinitions()` | 低 |
| 9s | `ensureKnowledgeVault().initializeIndex()` | 高（索引构建） |
| 11s | `ensureConversationKnowledgeQueue().start()` | 低（启动定时器） |
| 12s | `autoCheckForUpdates()` | 高（网络请求） |
| 13.5s | `hermesSkillService.deduplicate()` | 中（DB 扫描） |
| 15s | `verifyBundledHermesSkills()` | 高（真实技能调用） |
| 30s | `verifyAppIntegrity()` + `ensureDesktopShortcut` | 中（文件校验） |

**问题**：
- 9s~15s 之间有 5 个高/中耗时任务密集启动
- 这些任务虽然各自异步，但 Promise 并发执行时仍会争抢 CPU 时间片和 IO 带宽
- 用户启动后 10-15 秒正是首次对话的高峰期，后台任务与前台渲染争抢资源

### 修改

**文件**: `main.js`

**搜索锚点**（约第 17007 行）:
```js
function scheduleStartupMaintenance() {
  setTimeout(() => {
    startAutomaticWorkStateSnapshots();
  }, 2500);

  // 启动时对少量内置核心技能做真实黑球验证。它只更新可用性诊断，
  // 不作为技能调用的第二道门禁。
  setTimeout(() => {
    verifyBundledHermesSkills().catch((error) => {
      devLogError("verifyBundledHermesSkills", error, false);
    });
  }, 15000);

  setTimeout(() => {
    try {
      const repairs = reconcileInterruptedExecutionState();
      if (Object.values(repairs).some(Boolean)) safeMainWindowSend("session:changed", loadDb());
    } catch (error) {
      devLogError("reconcileInterruptedExecutionState", error, false);
    }
  }, 4000);

  setTimeout(() => {
    try {
      const memoryCleanup = ensureHermesMemoryService().removeStaleProductDefinitions();
      if (memoryCleanup.changed) devLog("system", "INFO", "[Hermes] Removed stale product definitions from USER.md", memoryCleanup);
    } catch (error) {
      devLog("error", "WARN", "[Hermes] Failed to clean stale product definitions", { error: error.message || String(error) });
    }
  }, 8000);

  setTimeout(() => {
    ensureKnowledgeVault().initializeIndex().then((result) => {
      if (!result?.ok) devLog("knowledge", "WARN", "[Knowledge] 后台索引初始化降级", result || {});
      else devLog("knowledge", "INFO", "[Knowledge] 后台索引已就绪", result);
    }).catch((error) => {
      devLog("knowledge", "WARN", "[Knowledge] 后台索引初始化失败", { error: error?.message || String(error) });
    });
  }, 9000);

  setTimeout(() => {
    try { ensureConversationKnowledgeQueue().start(); }
    catch (error) { devLog("knowledge", "WARN", "[Knowledge] 自动归纳队列启动失败", { error: error?.message || String(error) }); }
  }, 11000);

  setTimeout(() => {
    ensureUpdateV2Layout();
    recoverInterruptedUpdate();
    if (!isDevMode && !currentLicenseStatus().unlocked) ensureLicenseManager().startTrial();
    startLicenseTicker();
  }, 6000);

  setTimeout(() => {
    autoCheckForUpdates().catch((error) => {
      console.error("[Updater] 自动检查失败:", error.message || error);
      devLogError("autoCheckForUpdates", error, true);
    });
  }, 12000);

  setTimeout(() => {
    try {
      const result = ensureHermesSkillService().deduplicate();
      devLog("knowledge", "INFO", "[Knowledge] 黑球技能后台完整性检测完成", {
        scanned: result.scanned,
        removedCount: result.removedCount,
        conflicts: result.conflicts?.length || 0,
        recordId: result.record?.id || ""
      });
    } catch (error) {
      devLog("knowledge", "WARN", "[Knowledge] 黑球技能后台完整性检测失败", { error: error?.message || String(error) });
    }
  }, 13500);

  runWhenMainWindowInactive(() => {
    verifyAppIntegrity();
    setTimeout(ensureDesktopShortcut, 1200);
  }, 30000);
```

**改为**（调整延迟值，错峰分散到 60 秒）:
```js
function scheduleStartupMaintenance() {
  // 第一梯队（0-5s）：轻量初始化，不涉及重IO
  setTimeout(() => {
    startAutomaticWorkStateSnapshots();
  }, 2500);

  setTimeout(() => {
    try {
      const repairs = reconcileInterruptedExecutionState();
      if (Object.values(repairs).some(Boolean)) safeMainWindowSend("session:changed", loadDb());
    } catch (error) {
      devLogError("reconcileInterruptedExecutionState", error, false);
    }
  }, 4000);

  // 第二梯队（5-10s）：许可证与布局，中量IO
  setTimeout(() => {
    ensureUpdateV2Layout();
    recoverInterruptedUpdate();
    if (!isDevMode && !currentLicenseStatus().unlocked) ensureLicenseManager().startTrial();
    startLicenseTicker();
  }, 6000);

  setTimeout(() => {
    try {
      const memoryCleanup = ensureHermesMemoryService().removeStaleProductDefinitions();
      if (memoryCleanup.changed) devLog("system", "INFO", "[Hermes] Removed stale product definitions from USER.md", memoryCleanup);
    } catch (error) {
      devLog("error", "WARN", "[Hermes] Failed to clean stale product definitions", { error: error.message || String(error) });
    }
  }, 8000);

  // 第三梯队（10-20s）：知识库与队列，重量IO，拉大间隔
  setTimeout(() => {
    ensureKnowledgeVault().initializeIndex().then((result) => {
      if (!result?.ok) devLog("knowledge", "WARN", "[Knowledge] 后台索引初始化降级", result || {});
      else devLog("knowledge", "INFO", "[Knowledge] 后台索引已就绪", result);
    }).catch((error) => {
      devLog("knowledge", "WARN", "[Knowledge] 后台索引初始化失败", { error: error?.message || String(error) });
    });
  }, 10000);

  setTimeout(() => {
    try { ensureConversationKnowledgeQueue().start(); }
    catch (error) { devLog("knowledge", "WARN", "[Knowledge] 自动归纳队列启动失败", { error: error?.message || String(error) }); }
  }, 12000);

  // 第四梯队（20-30s）：更新检查与技能验证，网络密集，错开到20s后
  setTimeout(() => {
    autoCheckForUpdates().catch((error) => {
      console.error("[Updater] 自动检查失败:", error.message || error);
      devLogError("autoCheckForUpdates", error, true);
    });
  }, 20000);

  setTimeout(() => {
    try {
      const result = ensureHermesSkillService().deduplicate();
      devLog("knowledge", "INFO", "[Knowledge] 黑球技能后台完整性检测完成", {
        scanned: result.scanned,
        removedCount: result.removedCount,
        conflicts: result.conflicts?.length || 0,
        recordId: result.record?.id || ""
      });
    } catch (error) {
      devLog("knowledge", "WARN", "[Knowledge] 黑球技能后台完整性检测失败", { error: error?.message || String(error) });
    }
  }, 22000);

  // 第五梯队（25s）：技能验证，最重，放到最后
  setTimeout(() => {
    verifyBundledHermesSkills().catch((error) => {
      devLogError("verifyBundledHermesSkills", error, false);
    });
  }, 25000);

  // 第六梯队（30s+）：完整性校验，不变
  runWhenMainWindowInactive(() => {
    verifyAppIntegrity();
    setTimeout(ensureDesktopShortcut, 1200);
  }, 30000);
```

**调整对照表**:

| 任务 | 原延迟 | 新延迟 | 变化 |
|------|--------|--------|------|
| 自动工作状态快照 | 2.5s | 2.5s | 不变 |
| 恢复中断执行状态 | 4s | 4s | 不变 |
| 更新布局 + 许可证 | 6s | 6s | 不变 |
| 清理过期产品定义 | 8s | 8s | 不变 |
| 知识库索引初始化 | 9s | 10s | +1s |
| 知识队列启动 | 11s | 12s | +1s |
| 自动检查更新 | 12s | **20s** | +8s |
| 技能去重 | 13.5s | **22s** | +8.5s |
| 验证内置技能 | 15s | **25s** | +10s |
| 应用完整性验证 | 30s | 30s | 不变 |

**原理**：
- 前四个轻量任务（2.5s/4s/6s/8s）保持不变，它们启动快、不涉及重IO
- 知识库索引（10s）和队列启动（12s）略微后移，避免与前台渲染争抢
- 三个最重任务（更新检查、技能去重、技能验证）从 12-15s 窗口拉开到 20-25s 窗口，给用户首次对话留出 15-20 秒无干扰窗口
- 完整性验证保持 30s 不变（已有 `runWhenMainWindowInactive` 守卫）
- 不改变任何任务的执行逻辑，只调整 `setTimeout` 延迟值

### 验证要点

1. 启动白球AI，观察启动后 0-30 秒内 CPU 使用率曲线（任务管理器）
2. 在启动后 5-10 秒内发起对话，确认响应速度比修改前更流畅
3. 确认所有 10 个后台任务最终都执行了（检查 dev log 输出）
4. 确认知识库搜索在启动后 10 秒内可用（索引初始化在 10s 启动）

---

## Prompt 3: 启动更新检查添加跳过缓存

### 目标

`autoCheckForUpdates()` 在每次启动时都发起网络请求检查更新。当用户刚更新完版本或短时间内多次启动时，这些请求浪费网络带宽和启动时间。添加一个 6 小时缓存，如果距上次检查不足 6 小时则跳过自动检查。

### 问题分析

**update.log 数据**：
- 2026-08-06 一天内启动了至少 8 次，每次都触发 `source: "startup"` 更新检查
- 其中多次返回 `UP_TO_DATE`（已是最新版），网络请求完全浪费
- rc.79~rc.84 期间每次启动都失败（"Unsupported online update manifest schema"），每次浪费 2-5 秒
- 3.0.9 期间每次启动都失败（"signature verification failed"），同样浪费

**当前代码**（main.js 约第 17059 行）:
```js
  setTimeout(() => {
    autoCheckForUpdates().catch((error) => {
      console.error("[Updater] 自动检查失败:", error.message || error);
      devLogError("autoCheckForUpdates", error, true);
    });
  }, 12000);
```

`autoCheckForUpdates` 每次都调用 `fetchUpdateManifest({ source: "startup" })`，无任何缓存。

### 修改

**文件**: `main.js`

**搜索锚点**（约第 17059 行，在 `scheduleStartupMaintenance` 函数内）:
```js
  setTimeout(() => {
    autoCheckForUpdates().catch((error) => {
      console.error("[Updater] 自动检查失败:", error.message || error);
      devLogError("autoCheckForUpdates", error, true);
    });
  }, 12000);
```

**改为**:
```js
  setTimeout(() => {
    const UPDATE_CHECK_CACHE_KEY = "lastAutoUpdateCheck";
    const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
    let shouldSkip = false;
    try {
      const lastCheck = loadDb()?.[UPDATE_CHECK_CACHE_KEY];
      if (lastCheck && (Date.now() - Number(lastCheck)) < UPDATE_CHECK_INTERVAL_MS) {
        shouldSkip = true;
        devLog("system", "INFO", "[Updater] 距上次检查不足6小时，跳过启动自动检查");
      }
    } catch {}
    if (shouldSkip) return;
    try { saveDb({ [UPDATE_CHECK_CACHE_KEY]: Date.now() }); } catch {}
    autoCheckForUpdates().catch((error) => {
      console.error("[Updater] 自动检查失败:", error.message || error);
      devLogError("autoCheckForUpdates", error, true);
    });
  }, 12000);
```

**原理**：
- 在调用 `autoCheckForUpdates()` 之前，先从 `loadDb()` 读取上次检查时间戳
- 如果距上次检查不足 6 小时，跳过本次自动检查，记录 dev log
- 如果超过 6 小时（或没有记录），先写入当前时间戳到 `loadDb()`，再执行检查
- `loadDb()` / `saveDb()` 是项目中已有的 DB 持久化函数（main.js 中多处使用）
- **手动检查不受影响**：用户通过设置界面手动点击"检查更新"时，不走这个缓存逻辑（`autoCheckForUpdates` 只被 `scheduleStartupMaintenance` 调用，手动检查走 `ipcMain.handle("update:check-now", ...)` 等其他入口）
- 6 小时间隔可配置：如果需要更短或更长，修改 `UPDATE_CHECK_INTERVAL_MS` 常量

**注意事项**：
- `saveDb` 会覆盖整个 DB 对象，需要确认 `loadDb()` / `saveDb()` 是合并语义还是替换语义。如果是替换语义，应改为：
  ```js
  const currentDb = loadDb();
  saveDb({ ...currentDb, [UPDATE_CHECK_CACHE_KEY]: Date.now() });
  ```
- 如果项目中没有 `saveDb` 函数，搜索 `function saveDb` 或 `function persistDb` 确认实际函数名

### 验证要点

1. 首次启动白球AI，确认 12 秒后正常发起更新检查（dev log 不出现"跳过"消息）
2. 关闭白球AI后立即重新启动，确认 12 秒后 dev log 出现"距上次检查不足6小时，跳过启动自动检查"
3. 在设置界面手动点击"检查更新"，确认不受缓存影响，正常发起请求
4. 等待 6 小时后重新启动，确认自动检查恢复正常

---

## 预期效果

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| 退出时知识队列正在处理 | unhandledRejection 崩溃日志 | 安全返回，无崩溃 |
| 启动后 10-15 秒内对话 | 5个后台任务争抢CPU | 仅2个轻量任务，对话更流畅 |
| 短时间多次启动 | 每次都发更新检查请求 | 6小时内跳过，节省2-5秒 |

---

## 注意事项

1. **三个 Prompt 相互独立**：可以单独执行任意一个，不影响其他两个
2. **与已有方案的关系**：
   - `codex-prompts-process-stability.md`（问题1/2/3）— 渲染进程阻塞修复，**已应用到 main.js**（但未经用户授权，需确认是否保留）
   - `codex-prompts-performance.md`（问题9）— requireFinalEnvelope=false + 打字机提速，**未应用**
   - 本文（问题5/6/7）— 后端优化，**未应用**
3. **源代码与已安装版本**：源代码仓库（`source-current/`）与已安装版本（`AppData/Local/Programs/baiqiu-ai/`）行号不同，请通过函数名和代码片段搜索定位
4. **备份**：修改前请备份对应文件
5. **语法验证**：修改后执行 `node --check main.js` 和 `node --check conversation-knowledge-queue.js` 确认无语法错误
6. **loadDb/saveDb**：在 main.js 中搜索 `function loadDb` 和 `function saveDb` 确认函数签名和语义后再修改 Prompt 3
