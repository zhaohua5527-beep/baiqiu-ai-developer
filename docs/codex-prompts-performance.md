# 白球AI — 对话性能优化 Codex 方案

> 项目根目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/`  
> 主进程文件: `main.js`（已安装版本约 17191 行）  
> 渲染层文件: `renderer-v2/app.js`  
> 技术栈: Electron 43 + 原生 JS（无框架），无 TypeScript，无构建工具



---

## 问题背景

根据实际对话日志（`D:/白球AI/data/user-data/heiqiu-db.json`）提取的 37 条计时数据：

| 指标         | 数值            |
| ---------- | ------------- |
| 平均回复字数     | 1030 字        |
| 打字机占总时间比例  | **8%**        |
| 推算思考时间 平均  | **128 秒**     |
| 推算思考时间 中位数 | **67 秒**      |
| 思考时间范围     | 2.2 秒 ~ 620 秒 |

**核心发现：打字机不是瓶颈（仅占 8%），真正的问题是模型思考期间用户看到空白屏幕。**

用户在 92% 的时间里盯着空白，因为 `requireFinalEnvelope = true` 将模型输出的所有文字（包括 `<baiqiu-progress>` 状态更新）全部缓冲到 `publicProgressDelta`，直到检测到 `<baiqiu-final>` 闭合标签才开始向用户显示。

**解决方向（已确认）：**

1. 显示思考过程 — 让 `<baiqiu-progress>` 状态文字立即显示给用户，用户知道"在思考"而不是"卡顿"
2. 打字机速度 90 → 120-500 — 缩短那 8% 的显示时间

---

## Prompt 1: 对话模式显示思考过程（核心修复）

### 目标

对话模式（`conversationOnly = true`）保留 `<baiqiu-progress>` / `<baiqiu-final>` 协议不变，但将 `requireFinalEnvelope` 设为 `false`。这样模型输出的进度状态文字（如"分析中..."、"读取数据..."）立即显示给用户，不再缓冲等待最终答案完成。

**修改前**：模型输出 `<baiqiu-progress>` → 缓冲到 `publicProgressDelta`（用户看不到）→ 等待 `<baiqiu-final>` → 开始显示 → 打字机逐字

**修改后**：模型输出 `<baiqiu-progress>` → 立即显示为状态提示 → 模型输出 `<baiqiu-final>` → 答案文字流式显示

### 修改

**文件**: `main.js`

**搜索锚点**（在 `runHermesSessionPrompt` 函数内部，`promptHermes` 闭包内，约第 14517 行）:

```js
const visibleStream = new HmsMessageStreamDemux({ requireFinalEnvelope: !options.internalStructuredResponse });
```

**改为**:

```js
const visibleStream = new HmsMessageStreamDemux({ requireFinalEnvelope: !options.internalStructuredResponse && !conversationOnly });
```

**原理**：

- `conversationOnly` 在 `runHermesSessionPrompt` 函数开头（约第 14368 行）定义，`promptHermes` 是其内部闭包，可访问该变量
- 当 `requireFinalEnvelope = false` 时，`HmsMessageStreamDemux.consume()`（`services/hms-progress.js` 第 66-152 行）的行为变化：
  - **修改前（true）**：`<baiqiu-final>` 标签之前的所有文字都进入 `publicProgressDelta`，`visibleDelta` 为空，用户看到空白
  - **修改后（false）**：`<baiqiu-progress>` 内容仍被解析为进度事件（`publicProgressDelta`），显示为状态提示；`<baiqiu-final>` 内容直接进入 `visibleDelta`，流式显示给用户；标签之外的纯文本也直接进入 `visibleDelta`
- 关键代码路径（`services/hms-progress.js`）：
  ```js
  // consume() 方法内
  if (!this.requireFinalEnvelope) visibleDelta += plain;
  // ↑ false 时，纯文本直接进 visibleDelta（立即显示）

  else if (!this.finalClosed) this.publicProgressDelta += plain;
  // ↑ true 时，纯文本进 publicProgressDelta（缓冲，用户看不到）
  ```

### 不需要改的部分

- **系统提示词中的信封协议指令**：保持不变。对话模式仍注入 `[Public response channel protocol]`，模型仍输出 `<baiqiu-progress>` 和 `<baiqiu-final>` 标签
- **`buildConversationSystemPrompt()`**：保持不变。不需要添加"禁止标签"指令
- **`extractHmsFinalEnvelope()`**（约第 14120 行）：保持不变。`requireFinalEnvelope = false` 时，`<baiqiu-final>` 标签仍被正常解析，提取最终答案文本
- **`normalizeHmsResponse()`**：保持不变。当 `extractHmsFinalEnvelope()` 返回 null 时 fallback 到 `normalized.text`，不会报错

### 验证要点

1. **对话模式发送"你好"**：确认用户立即看到状态提示（如"分析中..."），然后看到回复正文，不再有长时间空白
2. **对话模式发送复杂问题**：确认用户看到多个状态更新（如"读取数据" → "分析中" → "生成回答"），然后看到正文
3. **执行模式发送"帮我创建一个表格"**：确认行为不变——仍出现 baiqiu-progress 状态提示和 baiqiu-final 正文
4. **检查标签泄漏**：确认 `<baiqiu-progress>` 和 `<baiqiu-final>` 原始标签文本不会出现在用户可见的回复正文中（`HmsMessageStreamDemux` 会解析并移除标签本身）
5. **检查 `normalizeHmsResponse()`**（约第 14120 行）：确认 `extractHmsFinalEnvelope()` 在 `requireFinalEnvelope = false` 时仍能正确提取 `<baiqiu-final>` 内的文本

---

## Prompt 2: 打字机速度 90 → 120-500

### 目标

将打字机基准速度从 90 字/秒提升至 120 字/秒，快速模式从 220 字/秒提升至 500 字/秒。短回复（≤500 字）用 120 字/秒保持自然感，长回复（>500 字）用 500 字/秒快速显示。

### 修改 2A: 基准速度 90 → 120

**文件**: `renderer-v2/app.js`

**搜索锚点**（约第 146 行）:

```js
const ASSISTANT_TYPING_CHARS_PER_SECOND = 90;
```

**改为**:

```js
const ASSISTANT_TYPING_CHARS_PER_SECOND = 120;
```

### 修改 2B: 快速模式速度 220 → 500

**文件**: `renderer-v2/app.js`

**搜索锚点**（如果存在，约第 147-148 行）:

```js
const ASSISTANT_TYPING_FAST_CHARS_PER_SECOND = 220;
const ASSISTANT_TYPING_FAST_THRESHOLD = 500;
```

**改为**:

```js
const ASSISTANT_TYPING_FAST_CHARS_PER_SECOND = 500;
const ASSISTANT_TYPING_FAST_THRESHOLD = 500;
```

**原理**：

- `ASSISTANT_TYPING_FAST_THRESHOLD = 500`：当回复超过 500 字时切换到快速模式
- `ASSISTANT_TYPING_FAST_CHARS_PER_SECOND = 500`：快速模式 500 字/秒，2000 字回复只需 4 秒显示完（修改前需 22 秒）
- 短回复（如"你好"→ 46 字）仍用 120 字/秒，0.4 秒显示完，保持自然流式感

### 修改 2C: 标点暂停缩短

**文件**: `renderer-v2/app.js`

**搜索方法**：在 `renderer-v2/app.js` 中搜索以下关键词找到标点暂停逻辑:

- `punctuation`
- `pauseAtPunctuation`
- `[。，！？；：、]` 或类似标点正则
- 在 `startAssistantTyping` 函数（约第 5143 行）和 `revealLiveChatStreamText` 函数（约第 5995 行）内的标点判断逻辑

**修改要求**：

- 找到标点暂停的时间值（通常为 100-150ms 的 `setTimeout` 或延迟计算）
- 将其缩短至 20-30ms
- 如果标点暂停逻辑与 `ASSISTANT_TYPING_FAST_THRESHOLD` 关联（即快速模式跳过标点暂停），现在基准速度已提升，可以将标点暂停统一设为 20-30ms，不再区分快速/慢速模式

### 验证要点

1. 发送短问题（如"你好"），确认回复仍有自然流式感，不会突然全部弹出
2. 发送需要长回复的问题（如"方案难点是什么"），确认文字快速流出，无明显卡顿
3. 确认标点处仍有微弱停顿感（20-30ms），但不会拖沓
4. 确认流式渲染不会因速度提升出现乱码或丢字

---

## Prompt 3: 对话模式知识库上下文精简（可选）

### 目标

对话模式的知识库上下文从 4200 字缩减至 1500 字，减少模型处理系统提示词的时间（TTFT）。执行模式保持 4200 字不变。

### 修改

**文件**: `main.js`

**搜索锚点**（在 `runHermesSessionPrompt` 函数内，系统提示词数组最后一项，约第 14466 行）:

```js
String(options.knowledgeContext || "").slice(0, 4200)
```

**改为**:

```js
String(options.knowledgeContext || "").slice(0, conversationOnly ? 1500 : 4200)
```

**原理**：对话模式通常不需要大量知识库上下文，1500 字足够提供参考。减少 2700 字可缩短模型 TTFT。

---

## 预期效果

### 用户体感变化

| 场景           | 修改前            | 修改后                          |
| ------------ | -------------- | ---------------------------- |
| 发送消息后 0-5 秒  | 空白屏幕，不知道是否卡顿   | 显示"分析中..."状态提示，用户知道在思考       |
| 发送消息后 5-60 秒 | 仍然空白（复杂任务）     | 持续显示状态更新（"读取数据"→"分析"→"生成回答"） |
| 模型生成完毕后      | 打字机 90 字/秒慢慢显示 | 打字机 120-500 字/秒快速显示          |
| 500 字回复总时间   | 思考 + 5.6 秒打字机  | 思考（有进度提示）+ 1 秒打字机            |
| 2000 字回复总时间  | 思考 + 22 秒打字机   | 思考（有进度提示）+ 4 秒打字机            |

### 延迟拆解（修改后，对话模式）

| 阶段                 | 修改前      | 修改后       | 说明                             |
| ------------------ | -------- | --------- | ------------------------------ |
| loadDb + 路由        | 0.1-0.5s | 0.1-0.5s  | 同步读取（未改）                       |
| HMS session resume | 0-1s     | 0-1s      | 已有 prewarm 机制                  |
| 模型 TTFT            | 2-15s    | 2-15s     | 取决于模型提供商（未改）                   |
| 信封缓冲               | 1-2s     | **0s**    | **requireFinalEnvelope=false** |
| 首 token 可见         | 5-17s    | **2-15s** | **进度文字立即显示**                   |
| 打字机显示（500字）        | 5.6s     | **1s**    | **120→500 字/秒**                |
| 打字机显示（2000字）       | 22s      | **4s**    | **500 字/秒**                    |

**关键改善：**

- 首字延迟：从"等 5-17 秒看到空白"变成"等 2-15 秒看到状态提示"
- 完整显示：500 字回复从 +5.6 秒缩短到 +1 秒
- 用户心理：从"是不是卡了？"变成"在思考，等一下"

---

## 注意事项

1. **只改对话模式**：Prompt 1 的修改条件是 `&& !conversationOnly`，执行模式（`conversationOnly = false`）完全不受影响
2. **打字机改动全局生效**：Prompt 2 的速度修改对对话模式和执行模式都生效（这是期望行为，两种模式都应快速显示）
3. **`conversationOnly` 的判定**：在 `runHermesSessionPrompt` 函数开头（约第 14368 行）通过 `options.conversationUnderstanding?.shouldCreateTask === false` 和 `responseMode` 判断。纯聊天 → `true`，任务执行 → `false`
4. **源代码版本差异**：源代码仓库（`source-current/main.js` 约 13040 行）与已安装版本（约 17191 行）行号不同，请通过函数名和代码片段搜索定位
5. **备份**：修改前请备份 `main.js` 和 `renderer-v2/app.js`
6. **语法验证**：修改后执行 `node --check main.js` 和 `node --check renderer-v2/app.js` 确认无语法错误
