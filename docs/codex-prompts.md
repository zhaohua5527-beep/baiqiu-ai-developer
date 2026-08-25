# 白球AI — Codex 精确 Prompt 文档

> 项目根目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/`
> 渲染层目录: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/renderer-v2/`
> 主进程文件: `C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/main.js`
> 技术栈: Electron 43 + 原生 JS（无框架），无 TypeScript，无构建工具

---

## Prompt 1: 取消"回到开头"箭头按钮 (C2)

### 目标
移除消息列表中的"回到当前轮开头"按钮（`currentRoundStartBtn`），该功能与目录导航重叠。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 302 行** — DOM 引用声明：
```js
const currentRoundStartBtn = $("currentRoundStartBtn");
```

2. **第 1872-1882 行** — 相关函数：
```js
function canReturnToCurrentRoundStart(row = currentRoundStartRow()) {
  if (!messageList || !row) return false;
  const listRect = messageList.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.bottom < listRect.top - 48;
}

function scrollToCurrentRoundStart() {
  const row = currentRoundStartRow();
  if (!row) return;
  pauseOutputFollowing();
  scrollMessageToStart(row, "smooth");
}
```

3. **第 1887-1893 行** — `updateReadingControls()` 中使用：
```js
function updateReadingControls() {
  if (!readingControls || !currentRoundStartBtn || !newOutputBtn || !messageList) return;
  const row = chooseViewportLongReply() || activeLongReplyRow();
  renderComposerLongReplyNav(row);
  currentRoundStartBtn.hidden = !canReturnToCurrentRoundStart();
  newOutputBtn.hidden = !state.newOutputAvailable;
  readingControls.hidden = currentRoundStartBtn.hidden && newOutputBtn.hidden;
}
```

**文件**: `renderer-v2/index.html` — 搜索 `currentRoundStartBtn` 找到对应 HTML 元素并删除。

### 修改要求
- 删除 HTML 中 `currentRoundStartBtn` 元素
- 删除 `app.js` 中 `currentRoundStartBtn` 的 DOM 引用、`canReturnToCurrentRoundStart()`、`scrollToCurrentRoundStart()` 函数
- 在 `updateReadingControls()` 中移除对 `currentRoundStartBtn` 的引用，只保留 `newOutputBtn` 逻辑
- `readingControls.hidden` 改为只依赖 `newOutputBtn.hidden`

---

## Prompt 2: 授权确认弹窗按钮改用主题色 (D3)

### 目标
工具执行授权确认弹窗（`confirm-card`）的按钮当前使用浏览器默认样式，没有 CSS 定义。需要添加主题色样式（蓝白配色），与整体 UI 一致。

### 文件与位置

**文件**: `renderer-v2/app.js`，第 6607-6641 行 — `showConfirmCard()` 函数生成 HTML：
```js
card.innerHTML = `
  <div class="bubble">
    <div class="confirm-title">
      <span aria-hidden="true">!</span>
      <strong>${escapeHtml(title)}</strong>
    </div>
    <div class="confirm-subtitle">${escapeHtml(request.toolName || request.toolId || "工具")} · ${escapeHtml(scopeName)}权限</div>
    <div class="confirm-params">${escapeHtml(paramsDisplay)}</div>
    <label class="confirm-mode">
      <span>权限记忆</span>
      <select class="confirm-mode-select">
        <option value="allow_once">一次允许</option>
        <option value="allow_always">始终允许（完全访问）</option>
        <option value="ask">每次询问</option>
        <option value="deny">拒绝</option>
      </select>
    </label>
    <div class="confirm-actions">
      <button class="confirm-yes" data-id="${escapeHtml(request.id)}" type="button">确认执行</button>
      <button class="confirm-no" data-id="${escapeHtml(request.id)}" type="button">取消</button>
    </div>
  </div>
`;
```

**文件**: `renderer-v2/styles.css` — 当前**完全没有** `.confirm-card`、`.confirm-yes`、`.confirm-no` 等 CSS 规则。

### 修改要求
在 `styles.css` 末尾添加以下 CSS（使用 CSS 变量与现有主题一致）：

```css
/* === 授权确认弹窗 === */
.confirm-card .bubble {
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 12px;
  padding: 16px 20px;
  max-width: 480px;
}
.confirm-title {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.confirm-title span {
  display: inline-flex; width: 22px; height: 22px;
  border-radius: 50%; background: var(--accent); color: #fff;
  align-items: center; justify-content: center; font-size: 13px;
}
.confirm-title strong { color: var(--text); font-size: 15px; }
.confirm-subtitle { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.confirm-params {
  background: var(--bg); border-radius: 8px; padding: 10px 12px;
  font-size: 12px; color: var(--muted); max-height: 160px;
  overflow: auto; white-space: pre-wrap; margin-bottom: 12px;
}
.confirm-mode {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-size: 13px; color: var(--muted);
}
.confirm-mode-select {
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 4px 8px; font-size: 13px;
}
.confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
.confirm-yes {
  background: var(--accent); color: #fff; border: none;
  border-radius: 8px; padding: 8px 20px; font-size: 14px;
  cursor: pointer; transition: opacity .15s;
}
.confirm-yes:hover { opacity: .85; }
.confirm-no {
  background: transparent; color: var(--muted);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 20px; font-size: 14px; cursor: pointer;
  transition: background .15s;
}
.confirm-no:hover { background: var(--bg); }
```

如果 `--accent` 变量未定义，使用 `--accent-color` 或回退到 `#2563eb`。

---

## Prompt 3: 取消"极简纯白"主题 (E1)

### 目标
"极简纯白"主题（`minimal-white`）与"白球蓝调"（`baiqiu`）配色几乎一样，移除前者。

### 文件与位置

**文件**: `renderer-v2/index.html`

1. **第 473 行** — 主题色板按钮：
```html
<button type="button" data-theme-palette="minimal-white"><i><b></b><b></b><b></b></i><span>极简纯白</span></button>
```

**文件**: `renderer-v2/app.js`

2. **第 675 行** — 预设定义：
```js
"minimal-white": { textColor: "#111827", accentColor: "#315fca", backgroundColor: "#f7f8fa", panelColor: "#ffffff" },
```

3. **第 208-215 行** — 迁移逻辑（将旧的 `white` 皮肤映射到 `custom`）：
```js
if (next.settings.appearance.skin === "white") {
  Object.assign(next.settings.appearance, {
    skin: "custom",
    palette: "baiqiu",
    textColor: "#172033",
    accentColor: "#2563eb",
    backgroundColor: "#f5f8ff",
    panelColor: "#ffffff"
  });
}
```

### 修改要求
- 删除 `index.html` 第 473 行的 `minimal-white` 按钮
- 删除 `app.js` 第 675 行的 `minimal-white` 预设
- 在删除前添加迁移逻辑：如果用户当前 `palette === "minimal-white"`，自动切换为 `"baiqiu"`
- 保留 `white` → `custom` 的迁移逻辑不变

---

## Prompt 4: 切换会话时保留输入草稿 (B4)

### 目标
用户在输入框输入了文字但还没发送，此时切换到其他会话，切回来后输入内容丢失。需要在切换会话时保存草稿。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 994-1014 行** — `selectSessionById()` 函数（会话切换入口）：
```js
async function selectSessionById(sessionId) {
  const session = state.db?.sessions?.find((item) => item.id === sessionId || item.sessionId === sessionId || item.conversationId === sessionId);
  const resolvedSessionId = session?.id || sessionId;
  if (!resolvedSessionId) return;
  if (resolvedSessionId === state.selectedSessionId) {
    markSessionRead(resolvedSessionId);
    updateProjectTreePresentation();
    return;
  }
  clearSessionTransientState();  // ← 这里清除了所有状态包括输入框
  document.body.classList.add("session-transitioning");
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    state.db = await api.selectSession(resolvedSessionId);
    state.selectedSessionId = resolvedSessionId;
    markSessionRead(resolvedSessionId);
    await renderAll({ refreshSettings: false, refreshSecondary: false });
  } finally {
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("session-transitioning")));
  }
}
```

2. **第 924-933 行** — `clearSessionTransientState()` 清除状态：
```js
state.presetTaskContextTarget = null;
// ... 其他状态清除
```

3. **第 927 行** — 输入框被清空：
```js
chatInput.value = "";
```

4. **第 6829-6830 行** — 发送消息时读取输入：
```js
const draftText = chatInput.value.trim();
```

5. **第 59 行** — state 中的 attachments：
```js
attachments: [],
```

6. **第 313 行** — DOM 引用：
```js
const attachmentPreview = $("attachmentPreview");
```

### 修改要求
1. 在 `state` 对象中添加 `sessionDrafts: {}`（第 59 行附近）
2. 在 `selectSessionById()` 中，**在 `clearSessionTransientState()` 之前**保存当前会话草稿：
```js
// 保存当前会话草稿
if (state.selectedSessionId && chatInput) {
  state.sessionDrafts[state.selectedSessionId] = {
    text: chatInput.value,
    attachments: [...state.attachments]
  };
}
```
3. 在 `renderAll()` 完成后，**恢复目标会话草稿**：
```js
// 恢复目标会话草稿
const draft = state.sessionDrafts[resolvedSessionId];
if (draft) {
  chatInput.value = draft.text || "";
  state.attachments = draft.attachments || [];
  if (attachmentPreview) attachmentPreview.refresh?.();
} else {
  chatInput.value = "";
  state.attachments = [];
}
```
4. 在消息发送成功后（第 6829 行附近），清除该会话草稿：
```js
delete state.sessionDrafts[state.selectedSessionId];
```

---

## Prompt 5: 切换会话卡顿优化 (B1)

### 目标
切换会话时明显卡顿。根因是 `clearSessionTransientState()` 和 `renderAll()` 中有同步 DOM 操作堆积。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 994-1014 行** — `selectSessionById()`（同 Prompt 4）

2. **第 924-933 行** — `clearSessionTransientState()`：
```js
// 当前实现：同步清除所有状态，包括 DOM 操作
```

3. **第 6685-6701 行** — `renderAll()` 中消息列表渲染：
```js
function renderMessages(messages = []) {
  // ...
  const visibleMessages = messages.slice(-50);  // 已从120优化到50
  // 全量 innerHTML 重建
}
```

4. **第 2725-2737 行** — 滚动位置计算：
```js
const currentScrollTop = messageList.scrollTop;
const nearBottom = isNearBottom(messageList);
```

### 修改要求
1. 在 `selectSessionById()` 中，`clearSessionTransientState()` 之前先保存当前滚动位置
2. 将 `renderAll()` 拆分为两阶段：
   - 阶段 1（同步）：清除消息列表 DOM、更新会话标题、切换 sessionList 高亮
   - 阶段 2（异步，requestAnimationFrame）：渲染消息列表、恢复滚动位置
3. 在 `renderMessages()` 中，如果消息超过 50 条，先渲染前 50 条，然后用 `requestIdleCallback` 延迟渲染剩余消息
4. 会话切换时给消息列表加 `opacity: 0` 过渡，渲染完成后 `opacity: 1`，避免白屏闪烁

---

## Prompt 6: 智能滚动跟随 (C1)

### 目标
当前执行任务完成后会强制滚动到顶部再回到底部。改为：新内容出现时自动跟随到底部，用户手动上滑时打断跟随。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 82 行** — 默认状态：
```js
followOutput: true,
```

2. **第 1710-1712 行** — `isNearBottom()`：
```js
function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
```

3. **第 1715-1725 行** — `pauseOutputFollowing()`：
```js
function pauseOutputFollowing() {
  state.followOutput = false;
  state.composerReplyNavRequested = true;
  updateReadingControls();
}
```

4. **第 1728-1742 行** — `resumeOutputFollowing()`：
```js
function resumeOutputFollowing({ resume = false } = {}) {
  if (!messageList || (!resume && !state.followOutput)) return;
  if (resume || isNearBottom(messageList)) {
    state.followOutput = true;
  }
  state.composerReplyNavRequested = false;
  state.newOutputAvailable = false;
  if (state.followOutput) {
    messageList.scrollTop = messageList.scrollHeight;
  }
  updateReadingControls();
}
```

5. **第 1755-1763 行** — `scheduleStreamingScroll()`：
```js
function scheduleStreamingScroll() {
  if (!messageList || !state.followOutput || state.manualOutputPause || streamingScrollFrame) return;
  streamingScrollFrame = requestAnimationFrame(() => {
    streamingScrollFrame = 0;
    if (!state.followOutput || state.manualOutputPause) return;
    messageList.scrollTop = messageList.scrollHeight;
    updateReadingControls();
  });
}
```

6. **第 5628 行** — 滚动事件监听：
```js
if (target === messageList && state.followOutput) scheduleStreamingScroll();
```

7. **第 2725-2737 行** — 滚动检测逻辑

### 修改要求
1. 添加 `messageList` 的 `scroll` 事件监听器（如果还没有），在用户手动滚动时检测：
```js
messageList.addEventListener("scroll", () => {
  if (isNearBottom(messageList)) {
    // 用户滑到底部，恢复跟随
    state.followOutput = true;
    state.newOutputAvailable = false;
  } else {
    // 用户手动上滑，打断跟随
    state.followOutput = false;
    state.newOutputAvailable = true;
  }
  updateReadingControls();
}, { passive: true });
```

2. 移除任何在任务完成后强制 `scrollTop = 0` 或 `scrollToTop` 的代码
3. `scheduleStreamingScroll()` 只在 `state.followOutput === true` 时滚动到底部（当前已满足）
4. 任务完成时（`setLiveStreamStage(entry, "completed")`），如果 `state.followOutput === false`，显示"有新输出"提示按钮（`newOutputBtn`），不强制滚动
5. 确保所有 `messageList.scrollTop = messageList.scrollHeight` 调用前都检查 `state.followOutput`

---

## Prompt 7: 消息附件/图片渲染修复 (A3)

### 目标
发送包含文字+文件的消息后，对话框只显示文字，不显示文件和图片。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 5548-5575 行** — 图片渲染逻辑（在消息渲染函数中）：
```js
for (const image of message.images || []) {
  const imageItem = image && typeof image === "object"
    ? image
    : { id: `${message.id || Date.now()}-img`, name: "会话图片", mimeType: "image/png", dataUrl: image };
  const img = document.createElement("img");
  img.className = "message-image";
  img.alt = imageItem.name || "会话图片";
  img.title = "点击在任务看板中查看图片";
  const inlineSource = imageItem.dataUrl || imageItem.url || "";
  if (inlineSource) img.src = inlineSource;
  img.addEventListener("click", () => openAttachmentInBoard(imageItem));
  bubble.appendChild(img);
  // ...
}
```

2. **第 5360-5380 行** — 文件链接渲染（仅在 `structuredPresentation` 中）：
```js
const files = structuredPresentationFiles(presentation.files, canonicalFiles);
if (files.length) {
  // 创建文件链接列表
}
```

3. **第 2979-2980 行** — 消息上下文提取：
```js
const files = (message.attachments || []).map((item) => `${item.name || ""} ${item.mimeType || ""}`).join("\n");
return [message.role || "", message.text || "", files].filter(Boolean).join("\n");
```

4. **第 1057-1074 行** — `submitProductInput()` 发送时附件处理：
```js
async function submitProductInput(session, text, { attachments = [], streamId = "", clientMessageId = "" } = {}) {
  const requestText = text || (attachments.length ? "请分析附件内容。" : "");
  // ...
  attachments,
  // ...
}
```

### 修改要求
1. 在消息渲染函数中（图片渲染之前），添加**通用附件渲染**逻辑：
```js
// 渲染通用附件（非图片）
const attachments = message.attachments || [];
if (attachments.length > 0) {
  const attachmentList = document.createElement("div");
  attachmentList.className = "message-attachments";
  for (const item of attachments) {
    if (String(item.mimeType || "").startsWith("image/")) continue; // 图片单独渲染
    const attachmentItem = document.createElement("div");
    attachmentItem.className = "message-attachment-item";
    attachmentItem.innerHTML = `<span class="attachment-icon">▣</span>
      <span class="attachment-name">${escapeHtml(item.name || "文件")}</span>
      ${item.sizeBytes ? `<small class="attachment-size">${compactBytes(item.sizeBytes)}</small>` : ""}`;
    attachmentItem.addEventListener("click", () => openAttachmentExternally(item));
    attachmentList.appendChild(attachmentItem);
  }
  if (attachmentList.children.length > 0) bubble.appendChild(attachmentList);
}
```

2. 检查 `message.images` 是否被正确赋值——在 `renderMessages()` 中确认 `message.images` 和 `message.attachments` 字段存在。如果后端只返回 `attachments`，需要从中分离出图片：
```js
const imageAttachments = (message.attachments || []).filter(a => String(a.mimeType || "").startsWith("image/"));
const images = message.images || imageAttachments.map(a => ({ ...a, dataUrl: a.dataUrl || a.url }));
```

3. 在 `styles.css` 中添加 `.message-attachments` 和 `.message-attachment-item` 样式

---

## Prompt 8: 渲染层文字消失重写修复 (A2)

### 目标
任务执行过程中已渲染的文字会突然消失再重新出现。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 5049-5075 行** — `renderProgressiveMarkdown()`（已做过节流优化）：
```js
function renderProgressiveMarkdown(rendered, text = "") {
  if (!rendered) return;
  // 节流逻辑：>200字时每80ms才重解析，>600字用textContent
  // ...
}
```

2. **第 5103-5130 行** — `startAssistantTyping()` 中的 `finish()` 方法：
```js
finish() {
  if (finished) return;
  finished = true;
  // 完成时做完整 markdown 渲染
  rendered.innerHTML = renderMarkdown(chars.join(""));
  bindRenderedLinks(rendered);
  // ...
}
```

3. **第 6125-6140 行** — `flushLiveChatStream()`（流式直播渲染）：
```js
function flushLiveChatStream(entry) {
  // ...
  if (entry.revealedLength < entry.targetChars.length) scheduleLiveChatStreamPaint(entry);
  else if (entry.backendCompleted) setLiveStreamStage(entry, "completed");
}
```

4. **第 6300-6360 行** — `setLiveStreamStage()` 函数

### 修改要求
1. 在 `renderProgressiveMarkdown()` 的节流逻辑中，**不要用 `textContent` 替换 `innerHTML`**（这会清除已有格式）。改为：对 >600 字的文本，仍然用 `renderMarkdown()` 但降低频率到每 200ms 一次
2. 在 `finish()` 方法中，先检查当前内容是否与最终内容一致，避免不必要的 DOM 替换：
```js
finish() {
  if (finished) return;
  finished = true;
  const finalHtml = renderMarkdown(chars.join(""));
  if (rendered.innerHTML !== finalHtml) {
    rendered.innerHTML = finalHtml;
    bindRenderedLinks(rendered);
  }
  // ...
}
```
3. 在 `setLiveStreamStage(entry, "completed")` 之前，确保做一次完整的 `renderMarkdown` 渲染（已在之前的优化中添加）
4. 检查是否有其他地方调用了 `rendered.innerHTML = ""` 或 `rendered.textContent = ""` 清空已有内容——如果有，移除或改为仅在首次渲染时清空

---

## Prompt 9: 违禁词过滤精简 (G1)

### 目标
白球AI 内置了过多内容过滤，连"开发"这样的正常词也被拦截。需要找到并精简过滤词表。

### 文件与��置

**文件**: `main.js`

1. **第 8095-8097 行** — `sanitizeText()` 函数（只清除控制字符，不是违禁词过滤）：
```js
function sanitizeText(text) {
  return String(text || "").replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}
```

2. **第 2894 行** — 有注释提到拦截逻辑：
```js
// "开发/编写/实现/做一个 X 计算器"是软件开发任务，不是"打开系统计算器"，不拦截
```

3. **第 3712 行** — "前拦截"注释

4. 搜索 `services/` 目录下的 `self-healing/healing-safeguard.js` 第 54 行：
```js
[/isDevMode|--dev|developerLicense/i, "禁止伪造开发者授权"],
```

5. `services/memory-distiller.js` 第 66 行：
```js
const WORK_SIGNAL = /(项目|任务|目标|阶段|进度|开发|实现|修改|优化|升级|创建|制作|部署|测试|验证|修复|设计|架构|方案|需求|交付|文件|代码|Agent|CEO|Task Brain|决定|确认|采用|选择|调整为|改为|取消|结论|必须|不要|禁止|只能|要求|优先|保持|待办|待完成|未完成|下一步|已完成|完成事项)/i;
```

### 修改要求
1. 全局搜索 `main.js` 和 `services/` 目录中所有涉及内容拦截/过滤的正则表达式和词表
2. 搜索关键词：`禁止`、`拦截`、`屏蔽`、`敏感`、`违禁`、`forbidden`、`blocked`、`censored`、`filter`
3. 特别检查 `services/conversation-understanding-layer.js`、`services/self-healing/`、`config/` 目录
4. 检查是否有发送给 AI 模型的 system prompt 中包含"不能讨论开发相关话题"之类的限制
5. 检查 HMS Python 端（`services/hermes-*.py`）是否有内容过滤
6. **只移除过度限制的词汇过滤**（如"开发"、"编写"、"实现"等正常技术词汇），保留法律法规要求的敏感词（如涉政、涉暴、涉黄等）
7. 修改后列出所有被移除的过滤规则

---

## Prompt 10: 长上下文虚拟滚动 (B2)

### 目标
单个会话消息过多时操作卡顿。实现虚拟滚动，只渲染可见区域的消息。

### 文件与位置

**文件**: `renderer-v2/app.js`

1. **第 6685-6701 行** — `renderMessages()` 函数：
```js
function renderMessages(messages = []) {
  // 当前：messages.slice(-50) 全量渲染
  const visibleMessages = messages.slice(-50);
  // 全量 innerHTML 重建
}
```

2. **第 1710-1712 行** — `isNearBottom()` 判断
3. **第 2725-2737 行** — 滚动位置跟踪
4. **第 5628 行** — 滚动事件监听

### 修改要求
1. 将 `renderMessages()` 改为虚拟滚动模式：
   - 计算可见区域的消息范围（基于 `messageList.scrollTop` 和 `clientHeight`）
   - 只渲染可见区域 ±5 条消息（上下各多渲染 5 条作为缓冲）
   - 用占位符 div 撑起滚动条高度（`height = totalMessages * estimatedRowHeight`）
2. 添加 `messageList` 的 `scroll` 事件监听器（passive），滚动时重新计算可见范围并更新 DOM
3. 使用 `IntersectionObserver` 检测消息进入/离开视口
4. 保留流式渲染时的特殊处理：当前正在流式输出的消息始终保持在 DOM 中
5. 消息高度不固定，需要动态测量：首次渲染后记录每条消息的实际高度，用于计算滚动条

**注意**：这是改动最大的一项，建议先在 `renderMessages()` 中实现分页加载（滚动到顶部时加载更多），作为虚拟滚动的简化版。

---

## Prompt 11: 预置任务打断延迟+不可编辑 (D2)

### 目标
1. 预置任务执行中打断有延迟
2. 预置任务不可编辑

### 文件与位置

**文件**: `main.js`

1. **第 3144-3165 行** — 任务中断逻辑：
```js
return Boolean(run?.userAborted || run?.controller?.signal?.aborted);
// ...
if (taskId) ensureTaskBrain().interrupt(taskId, "用户终止执行，等待继续恢复");
// ...
updateSession(sessionId, { interruptedCheckpoint: null, status: "done" });
```

2. **第 15028 行** — 预置任务中断保护：
```js
// 迟到写回保护：signal 已 abort（用户取消/超时/预置中断）时，旧任务即使 HMS 返回了
```

3. **第 15308 行** — controller 复用检查：
```js
// 复用 controller 前必须确认未 abort：预置任务中断旧任务时旧 controller 已取消，
```

**文件**: `renderer-v2/app.js`

4. **第 369-370 行** — 预置任务 UI 元素：
```js
const presetTaskContextMenu = $("presetTaskContextMenu");
const presetTaskEditBtn = $("presetTaskEditBtn");
```

5. **第 924 行** — `state.presetTaskContextTarget`

### 修改要求
1. **打断延迟修复**：
   - 在 `main.js` 中找到任务中断的 IPC handler，确保 `controller.abort()` 立即执行
   - 中断后立即向渲染进程发送 `task-interrupted` 事件，不等 HMS 响应
   - 检查是否有 `await` 在 `controller.abort()` 之后阻塞了中断响应

2. **预置任务可编辑**：
   - 搜索 `presetTaskEditBtn` 的事件监听器，确认是否被 `disabled` 或 `hidden`
   - 如果 `presetTaskEditBtn` 没有点击事件，添加编辑功能：点击后打开编辑面板，修改后保存到 `state.presetTaskContextTarget`

---

## Prompt 12: 界面响应式自适应 (A4)

### 目标
界面没有随屏幕大小自适应，任务看板在小屏幕上无法使用。

### 文件与位置

**文件**: `renderer-v2/styles.css`（386KB）
**文件**: `renderer-v2/index.html`

1. **任务看板相关 CSS** — `styles.css` 第 1948-1998 行：
```css
.task-board-edge-toggle { /* ... */ }
.task-board-drawer { /* ... */ }
.task-board-drawer.preview-expanded { width: min(1080px, 100%); }
```

2. **主布局** — 搜索 `styles.css` 中的固定宽度/高度：
```css
/* 搜索所有 width: Npx 的硬编码值 */
```

3. **`index.html`** — 检查是否有 `<meta name="viewport">` 标签

### 修改要求
1. 在 `index.html` 的 `<head>` 中确保有：
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

2. 在 `styles.css` 中添加媒体查询断点：
```css
/* 大屏 (>1400px): 默认布局 */
/* 中屏 (1024-1400px): 侧边栏收窄 */
@media (max-width: 1400px) {
  .session-sidebar { width: 240px; }
  .task-board-drawer { width: min(720px, 80%); }
}
/* 小屏 (<1024px): 侧边栏可折叠 */
@media (max-width: 1024px) {
  .session-sidebar { width: 56px; }
  .session-sidebar .session-label { display: none; }
  .task-board-drawer { width: 100%; }
  .task-board-drawer.preview-expanded { width: 100%; }
}
```

3. 将所有固定 `width: Npx` 改为 `width: min(Npx, N%)` 或 `clamp()` 函数
4. 任务看板在 <1024px 屏幕上改为全屏覆盖模式
5. 消息气泡 `max-width` 使用 `clamp(320px, 80%, 720px)`

**注意**：styles.css 有 386KB，不要全量替换。只搜索和修改布局相关的选择器（`.session-sidebar`、`.task-board-*`、`.message-list`、`.chat-input`、`.main-layout` 等）。

---

## 使用说明

### 给 Codex 的全局上下文

在每个 prompt 前添加以下上下文：

```
项目: 白球AI，Electron 43 桌面应用
代码位置: C:/Users/Lenovo/AppData/Local/Programs/baiqiu-ai/resources/app/
技术栈: 纯 JavaScript（无 TypeScript、无 React/Vue、无构建工具）
修改前必须备份原文件
不要引入新的 npm 依赖
保持现有代码风格（无分号、2空格缩进、模板字符串）
```

### 执行顺序建议

1. **先做简单的**：Prompt 1 (删按钮) → Prompt 3 (删主题) → Prompt 2 (加CSS)
2. **再做中等的**：Prompt 4 (草稿) → Prompt 6 (滚动) → Prompt 7 (附件渲染)
3. **最后做复杂的**：Prompt 5 (切换优化) → Prompt 8 (文字消失) → Prompt 10 (虚拟滚动) → Prompt 11 (任务打断) → Prompt 12 (响应式) → Prompt 9 (违禁词)
4. **Prompt 9 放最后**：因为需要全局搜索，可能涉及多个文件
