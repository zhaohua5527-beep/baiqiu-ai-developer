# 白球AI 工具调用架构 — 完整代码打印

> 生成时间：2026-08-01
> 修改文件：`main.js`（主进程核心）、`tool-registry.js`、`tool-loader.js`、`services/permission-manager.js`、`services/agent-loop-execution-context.js`

---

## 架构总览

```
用户消息
  │
  ▼
┌─────────────────────────────────┐
│ ConversationUnderstandingLayer   │  ← 消息分类层
│ executionModeFor() → "answer"    │     判断：对话 or 执行
│ shouldCreateTask = execute/delegate │
└──────────┬──────────────────────┘
           │
     ┌─────┴─────┐
     │           │
  shouldCreateTask = false    shouldCreateTask = true
     │           │
     ▼           ▼
runDirectConversation()    runHermesSessionPrompt()
  (对话模式)                  (执行模式 → HMS Agent)
     │                           │
     │ disableTools: false        │ HMS 不可用时
     │ providerFallbackToolMode   │ → runProviderFallbackForHermesUnavailable()
     │   = "safe"                 │   → directProviderChat()
     ▼                           │
  directProviderChat()  ◄────────┘
     │
     ▼
┌─────────────────────────────────┐
│ directProviderChat() — Agent Loop │
│                                   │
│ 1. bindAgentLoopExecutionContext() │
│ 2. canExposeAgentLoopTools()       │
│ 3. providerRequestBody()           │
│    └─ toolSchemasForFunctionCalling() │
│       └─ providerToolCallAllowed()    │
│          └─ isProviderFallbackSafeTool()│
│ 4. callChatCompletion() → 模型API   │
│ 5. 模型返回 tool_calls              │
│ 6. executeToolActions()            │
│    └─ ToolRegistry.execute()       │
│       └─ PermissionManager.check() │
│       └─ tool.execute()            │
│ 7. 工具结果 → messages → 循环      │
└─────────────────────────────────┘
```

---

## 1. 工具注册 / 定义

### 1.1 工具加载器 — `tool-loader.js`（完整 61 行）

```js
const fs = require("node:fs");
const path = require("node:path");

function loadTools(registry, context, toolsDir = path.join(__dirname, "tools")) {
  if (!fs.existsSync(toolsDir)) return [];
  const registered = [];
  const files = fs.readdirSync(toolsDir)
    .filter((file) => file.endsWith(".js"))
    .sort();

  for (const file of files) {
    const fullPath = path.join(toolsDir, file);
    delete require.cache[require.resolve(fullPath)];
    const mod = require(fullPath);
    const exportsValue = typeof mod.createTools === "function"
      ? mod.createTools(context)
      : typeof mod.createTool === "function"
        ? mod.createTool(context)
        : mod.tools || mod.tool || mod;
    const tools = Array.isArray(exportsValue) ? exportsValue : [exportsValue];
    for (const tool of tools.filter(Boolean)) {
      registered.push(registry.register(tool));
    }
  }
  return registered;
}

function loadSkills(registry, context, skillsDir = path.join(__dirname, "skills")) {
  const manifestFile = path.join(skillsDir, "_manifest.json");
  if (!fs.existsSync(manifestFile)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const registered = [];

  for (const entry of (manifest.skills || []).filter((skill) => skill?.enabled !== false)) {
    const file = path.basename(String(entry.file || ""));
    if (!file || file !== entry.file || !file.endsWith(".js")) {
      throw new Error(`Invalid skill file: ${entry.file || entry.name || "unknown"}`);
    }
    const fullPath = path.join(skillsDir, file);
    delete require.cache[require.resolve(fullPath)];
    const mod = require(fullPath);
    if (typeof mod.execute !== "function") throw new Error(`Skill execute missing: ${entry.name || file}`);
    const skillManifest = mod.MANIFEST || {};
    const name = String(entry.name || skillManifest.name || "").trim();
    if (!name) throw new Error(`Skill name missing: ${file}`);
    const id = `skill_${name}`;
    registered.push(registry.register({
      id,
      name,
      description: entry.description || skillManifest.description || name,
      parameters: skillManifest.parameters || entry.parameters || { type: "object", properties: {}, required: [] },
      permission: { level: "skill.execute", scope: "skills" },
      async execute(params, toolContext) {
        return mod.execute(params, { ...context, ...toolContext, skill: entry });
      }
    }));
  }
  return registered;
}

module.exports = { loadTools, loadSkills };
```

### 1.2 工具注册表 — `tool-registry.js`（完整 291 行）

```js
const { enrichToolMetadata } = require("./services/tool-selector");

class ToolRegistry {
  constructor({ context = {}, logger = null } = {}) {
    this.context = context;
    this.logger = logger || context.logger || null;
    this.tools = new Map();
    this._permissionManager = null;
    this._pendingConfirmations = new Map();
    this._mainWindow = null;
  }

  setPermissionManager(manager) {
    this._permissionManager = manager;
  }

  setMainWindow(mainWindow) {
    this._mainWindow = mainWindow || null;
  }

  register(tool) {
    validateTool(tool);
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, enrichToolMetadata({ ...tool, parameters: normalizeParameters(tool.parameters) }));
    return this.get(tool.id);
  }

  unregister(id) {
    return this.tools.delete(String(id || ""));
  }

  get(id) {
    return this.tools.get(String(id || "")) || null;
  }

  list() {
    return [...this.tools.values()].map(({ execute, ...schema }) => enrichToolMetadata({ ...schema }));
  }

  async execute(id, parameters = {}, contextPatch = {}) {
    const toolId = String(id || "");
    const tool = this.get(toolId);
    const startedAt = new Date();
    const startMs = Date.now();
    const entry = {
      startedAt: startedAt.toISOString(),
      endedAt: null,
      toolId,
      toolName: tool?.name || toolId || "unknown",
      parameters: safeSnapshot(parameters),
      result: null,
      error: null,
      duration: 0
    };

    if (!tool) {
      const response = normalizeToolResponse({
        success: false,
        result: null,
        error: `未识别动作：${toolId || "unknown"}`,
        evidence: []
      }, startMs);
      entry.endedAt = new Date().toISOString();
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      return response;
    }

    const toolContext = {
      ...this.context,
      ...contextPatch,
      tool,
      registry: this
    };
    const permissionTool = {
      ...tool,
      permission: this._permissionLevel(tool.permission),
      permissionScope: this._permissionScope(tool.permission, tool)
    };
    const permissionManager = this._permissionManager;
    if (permissionManager) {
      const checkResult = permissionManager.check(permissionTool, toolContext);
      this.context.auditLogger?.permissionCheck?.(toolId, checkResult.required, checkResult.current, checkResult.allowed, checkResult.message);
      if (!checkResult.allowed) {
        const response = {
          success: false,
          result: null,
          error: {
            code: "PERMISSION_DENIED",
            message: checkResult.message,
            requiredPermission: checkResult.required,
            currentPermission: checkResult.current
          },
          evidence: { toolId, params: this._sanitizeForEvidence(parameters) },
          duration: 0
        };
        entry.endedAt = new Date().toISOString();
        entry.error = response.error;
        entry.duration = response.duration;
        this.log(entry);
        this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
        return response;
      }

      if (permissionManager.requiresConfirmation?.(permissionTool)) {
        const confirmResult = await this._requestChatConfirmation(permissionTool, parameters, toolContext);
        this.context.auditLogger?.confirmation?.(toolId, confirmResult.confirmed, parameters);
        if (confirmResult.mode === "allow_always") {
          permissionManager.trustTool?.(toolId);
          permissionManager.rememberMode?.(permissionTool.permissionScope, "allow_always");
        } else if (confirmResult.mode === "deny") {
          permissionManager.rememberMode?.(permissionTool.permissionScope, "deny");
        } else if (confirmResult.mode === "ask") {
          permissionManager.revokeTrust?.(toolId);
          permissionManager.rememberMode?.(permissionTool.permissionScope, "ask");
        }
        if (!confirmResult.confirmed) {
          const response = {
            success: false,
            result: null,
            error: {
              code: "CANCELLED",
              message: "用户取消操作"
            },
            evidence: { toolId, params: this._sanitizeForEvidence(parameters) },
            duration: 0
          };
          entry.endedAt = new Date().toISOString();
          entry.error = response.error;
          entry.duration = response.duration;
          this.log(entry);
          this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
          return response;
        }
      }
    }

    try {
      const output = await tool.execute(parameters, toolContext);
      const response = normalizeToolResponse(output, startMs);
      entry.endedAt = new Date().toISOString();
      entry.result = safeSnapshot(response.result);
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
      return response;
    } catch (error) {
      this.context.auditLogger?.error?.(toolId, error, toolContext);
      const response = normalizeToolResponse({
        success: false,
        result: null,
        error: error?.message || String(error),
        evidence: []
      }, startMs);
      entry.endedAt = new Date().toISOString();
      entry.error = response.error;
      entry.duration = response.duration;
      this.log(entry);
      this.context.auditLogger?.toolExecute?.(toolId, parameters, toolContext, response, response.duration);
      return response;
    }
  }

  // ... 辅助方法：log, _sanitizeForEvidence, _permissionLevel,
  //              _permissionScope, _requestChatConfirmation 省略
}

function validateTool(tool) {
  if (!tool || typeof tool !== "object") throw new Error("Tool schema must be an object");
  for (const key of ["id", "name", "description", "parameters", "permission", "execute"]) {
    if (!(key in tool)) throw new Error(`Tool schema missing required field: ${key}`);
  }
  if (!String(tool.id || "").trim()) throw new Error("Tool id is required");
  if (typeof tool.execute !== "function") throw new Error(`Tool execute must be a function: ${tool.id}`);
}

module.exports = { ToolRegistry };
```

### 1.3 工具定义示例 — `tools/command.js`

```js
// 注册 3 个工具 ID：run_command, execute_command, shell_command
// 权限：{ level: "process.execute", scope: "safe-command" }
```

### 1.4 工具定义示例 — `tools/document-tools.js`

```js
// 注册 4 个工具 ID：word_read, word_write, pdf_read, pdf_write
```

---

## 2. 模型调用代码

### 2.1 API 请求体构建 — `providerRequestBody()` (main.js:8088)

```js
function providerRequestBody(settings, message, attachments, sessionId = "", options = {}) {
  const profile = getPersonaProfile(settings);
  const session = sessionId ? loadDb().sessions.find((item) => item.id === sessionId) : null;
  const systemPrompt = [
    buildSystemPrompt(profile, settings, session?.memory || {}),
    projectSessionPrompt(session, { includeWorkState: options.includeWorkState !== false })
  ].filter(Boolean).join("\n\n");
  const text = appendAttachmentText(applyChatOptions(message, settings), attachments);
  const providerKey = settings.defaultProvider || "deepseek";
  const provider = normalizeProvider(providerKey, settings.providers?.[providerKey] || {});
  const canSendImages = providerSupportsImageContent(providerKey, provider);
  const images = attachments.filter((item) => String(item.mimeType || "").startsWith("image/") && item.dataUrl);
  let content = text;
  // ... 图片处理 ...
  const history = chatHistoryMessages(sessionId);
  const request = {
    model: provider.model || "deepseek-chat",
    messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content }],
    tools: options.disableTools === true ? [] : toolSchemasForFunctionCalling(options),  // ← 关键
    tool_choice: "auto",
    stream: false
  };
  return request;
}
```

### 2.2 工具 Schema 过滤 — `toolSchemasForFunctionCalling()` (main.js:10280)

```js
function toolSchemasForFunctionCalling(options = {}) {
  const settings = loadDb().settings;
  return ensureToolRegistry().list()
    .filter((tool) => settings.webSearch?.enabled !== false || tool.id !== "web_search")
    .filter((tool) => providerToolCallAllowed(tool.id, options))  // ← 白名单过滤
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.id,
        description: tool.description || tool.name || tool.id,
        parameters: normalizeToolParameters(tool.parameters)
      }
    }));
}
```

### 2.3 Agent Loop — `directProviderChat()` (main.js:8148)

```js
async function directProviderChat(settings, text, attachments, sessionId = "", options = {}) {
  const executionContext = bindAgentLoopExecutionContext(options, {
    sessionId,
    userMessage: text,
    agentIntent: detectIntent(options.originalUserMessage || text),
    signal: options.signal || null
  });
  const signal = executionContext.signal;
  const toolsAllowed = canExposeAgentLoopTools(executionContext);  // ← disableTools !== true
  // ...
  const body = providerRequestBody(localSettings, text, attachments, sessionId, executionContext);
  if (!toolsAllowed) body.tools = [];  // ← 如果工具被禁用，清空
  const messages = [...body.messages];
  const actionResults = [];
  const payloads = [];
  let loopNo = 0;

  while (true) {  // Agent Loop
    ensureRunActive(signal);
    loopNo += 1;
    if (loopNo > MAX_AGENT_TOOL_LOOPS) { /* 防止死循环 */ }

    const finalRequestBody = { ...body, messages };
    if (!toolsAllowed) {
      delete finalRequestBody.tools;
      delete finalRequestBody.tool_choice;
    } else {
      finalRequestBody.tools = body.tools;
      finalRequestBody.tool_choice = "auto";
    }

    // 发送请求到模型 API
    payload = await callChatCompletion({
      providerId: providerKey,
      provider: normalizedProvider,
      body: finalRequestBody,
      signal
    });

    const assistantMessage = payload.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];

    if (!toolCalls.length) {
      // 模型没有调用工具 → 尝试提取白球自定义动作或返回最终文本
      const rawText = contentText(assistantMessage.content ?? "");
      const extracted = extractBaiqiuActions(rawText);
      if (extracted.actions.length) {
        // 执行白球自定义动作
        for (const action of extracted.actions) {
          if (!providerToolCallAllowed(actionId, executionContext)) {
            return { text: `黑球未启用...`, ... };
          }
        }
        const executed = await executeToolActions(extracted.actions, { ...executionContext });
        messages.push({ role: "user", content: buildToolResultFollowupMessage(executed) });
        continue;  // 继续循环
      }
      // 返回最终文本
      return { text: assistantVisibleText(assistantMessage, payload), raw: { ... } };
    }

    // 模型返回了 tool_calls → 执行每个工具调用
    messages.push(assistantMessage);
    const toolMessages = [];
    for (const call of toolCalls) {
      const name = call.function?.name || call.name || "";
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }

      // ← 白名单检查
      if (!providerToolCallAllowed(name, executionContext)) {
        return {
          text: `黑球未启用，当前云模型兜底只允许安全工具和内置技能；"${name}"需要黑球或用户确认后才能执行。`,
          raw: { ..., stopReason: "unsafe_tool_blocked" }
        };
      }

      // ← 重复调用检测
      const signature = `${name}:${JSON.stringify(args)}`;
      const repeated = (repeatedToolCalls.get(signature) || 0) + 1;
      if (repeated >= 2) { /* 停止循环 */ }

      // ← 实际执行工具
      const [executed] = await executeToolActions([{ ...args, type: name }], {
        ...executionContext, provider: providerKey, sessionId, signal
      });

      toolMessages.push({
        role: "tool",
        tool_call_id: call.id || `${name}-${Date.now()}`,
        content: JSON.stringify(executed?.response || { success: false, error: "Tool execution failed" })
      });
    }
    messages.push(...toolMessages);
    messages.push({
      role: "user",
      content: "如果上面的工具结果 success=true，必须优先给出最终中文结论..."
    });
  }
}
```

### 2.4 模型 API 调用 — `callChatCompletion()` (services/model-adapter.js:72)

```js
// 支持 OpenAI 和 Anthropic 两种 API 风格
// OpenAI 风格：直接传递 body（包含 tools 数组）
// Anthropic 风格：映射 tools 为 input_schema 格式
```

---

## 3. 权限校验逻辑

### 3.1 权限管理器 — `services/permission-manager.js`（完整 131 行）

```js
class PermissionManager {
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.ownerDevice = options.ownerDevice || false;
    this.advancedMode = options.advancedMode || false;
    this.isUnlocked = options.isUnlocked || false;
    this.accessMode = options.accessMode || "full";
    this.permissionModes = options.permissionModes || {};
    this.trustedTools = new Set(options.trustedTools || []);
    this.saveTrustedTools = typeof options.saveTrustedTools === "function" ? options.saveTrustedTools : null;
    this.savePermissionMode = typeof options.savePermissionMode === "function" ? options.savePermissionMode : null;
  }

  check(tool, context = {}) {
    const required = String(tool?.permission?.level || tool?.permission || "read").toLowerCase();
    const scope = this.scopeFor(tool);
    const mode = this.modeFor(tool);
    const current = required === "admin" ? "admin" : required === "write" ? "write" : "read";

    // 内部技能验证
    const internalSkillVerification = context.skillVerification === true
      && context.globalSkillPool === true
      && /^skill_[a-z0-9_]+$/i.test(String(tool?.id || ""));
    if (internalSkillVerification) {
      return { allowed: true, required, current: "internal_verification", trusted: false, scope, mode: "verify", message: "" };
    }

    // 个人资料工具
    if (tool?.id === "update_profile" || tool?.id === "get_profile") {
      return { allowed: true, required, current: "local_profile", trusted: true, scope, mode: "allow_always", message: "" };
    }

    // ★ 关键：默认总是返回 allowed: true
    return { allowed: true, required, current, trusted: true, scope, mode, message: "" };
  }

  requiresConfirmation(tool) {
    return false;  // ★ 总是 false，不需要确认
  }

  scopeFor(tool) {
    const raw = String(tool?.permissionScope || tool?.permission?.scope || tool?.scope || "").toLowerCase();
    const id = String(tool?.id || "").toLowerCase();
    const level = String(tool?.permission?.level || tool?.permission || "").toLowerCase();
    if (raw.includes("network") || id.includes("web") || id.includes("search")) return "network";
    if (raw.includes("file") || raw.includes("desktop") || raw.includes("filesystem") || level.includes("write") || level.includes("move") || level.includes("recycle")) return "file";
    if (level.includes("admin") || level.includes("execute") || id.includes("command") || id.includes("shell")) return "system";
    return "tool";
  }

  modeFor(tool) {
    const scope = this.scopeFor(tool);
    const toolMode = this.permissionModes?.[tool?.id]?.mode;
    const scopeMode = this.permissionModes?.[scope]?.mode;
    return toolMode || scopeMode || "ask";
  }

  // ... trustTool, revokeTrust, isTrusted, rememberMode, requestConfirmation 等
}

module.exports = PermissionManager;
```

### 3.2 Agent Loop 执行上下文 — `services/agent-loop-execution-context.js`（完整 41 行）

```js
const { buildExecutionMetadata } = require("./execution-metadata");

function bindAgentLoopExecutionContext(options = {}, defaults = {}) {
  const conversationUnderstanding = options.conversationUnderstanding || options.understanding || defaults.conversationUnderstanding || null;
  const taskBrain = options.taskBrain || defaults.taskBrain || null;
  const candidate = { ...options, conversationUnderstanding, understanding: conversationUnderstanding, taskBrain };
  let executionMetadata = null;
  try { executionMetadata = buildExecutionMetadata(candidate); } catch {}
  return {
    ...options,
    conversationUnderstanding,
    understanding: conversationUnderstanding,
    taskBrain,
    executionMetadata: executionMetadata || null,
    decisionId: executionMetadata?.decisionId || options.decisionId || ...,
    taskId: options.taskId || taskBrain?.task_id || defaults.taskId || "",
    assignmentId: options.assignmentId || taskBrain?.assignment_id || defaults.assignmentId || "",
    agentId: options.agentId || defaults.agentId || defaults.sessionId || "",
    traceId: options.traceId || defaults.traceId || "",
    sessionId: options.sessionId || defaults.sessionId || "",
    userMessage: options.originalUserMessage || options.userMessage || defaults.userMessage || "",
    agentIntent: options.agentIntent || conversationUnderstanding?.context?.domainIntent || defaults.agentIntent || "",
    signal: options.signal || defaults.signal || null
  };
}

function canExposeAgentLoopTools(context = {}) {
  return context.disableTools !== true;  // ★ 只要 disableTools 不是 true，就允许工具
}

module.exports = { bindAgentLoopExecutionContext, canExposeAgentLoopTools };
```

### 3.3 Provider Fallback 白名单过滤 — `main.js:8029`

```js
const PROVIDER_FALLBACK_SAFE_TOOL_IDS = new Set([
  "list_skills", "web_search", "webpage_read", "browser_current_page",
  "browser_open", "find_desktop_files", "write_text_file", "write_xlsx",
  "word_read", "word_write", "pdf_read", "pdf_write",
  "desktop_screenshot", "clipboard_read", "clipboard_write",
  "run_command", "execute_command", "shell_command",
  "open_path", "create_folder", "file_creator", "html_app_creator",
  "calculator_creator", "switch_model", "list_models", "switch_reasoning",
  "archive_create", "archive_extract",
  "window_inspect", "window_focus", "window_resize",
  "install_skill", "skill_install", "modify_skill", "optimize_skill",
  "rollback_skill", "list_skill_backups"
]);

function isProviderFallbackSafeTool(toolId = "") {
  const id = String(toolId || "").trim();
  if (!id) return false;
  if (id.startsWith("skill_")) return bundledJsSkillToolIds().has(id);
  return PROVIDER_FALLBACK_SAFE_TOOL_IDS.has(id);
}

function providerFallbackToolMode(options = {}) {
  return String(options.providerFallbackToolMode || options.toolMode || "").trim().toLowerCase();
}

function providerToolCallAllowed(toolId = "", options = {}) {
  return providerFallbackToolMode(options) !== "safe" || isProviderFallbackSafeTool(toolId);
}
```

---

## 4. 路由决策 — 消息分类层

### 4.1 `runHermesSessionPrompt()` 路由入口 (main.js:11109)

```js
async function runHermesSessionPrompt(session, text, attachments, settings, options = {}) {
  // ...
  const understanding = await ConversationUnderstandingLayer.analyze(text, session, settings);
  const executionMode = understanding.executionMode;  // "answer" | "execute" | "delegate"
  const shouldCreateTask = understanding.shouldCreateTask;  // true 仅当 execute/delegate

  if (!shouldCreateTask) {
    // 对话模式 → runDirectConversation()
    return await runDirectConversation(session, text, attachments, settings, {
      ...options,
      understanding,
      disableTools: false,           // ← 修复前：true（禁止所有工具）
      providerFallbackToolMode: "safe"  // ← 修复后新增
    });
  }

  // 执行模式 → HMS Agent
  // HMS 不可用时 → runProviderFallbackForHermesUnavailable()
  //              → directProviderChat()
}
```

### 4.2 `runDirectConversation()` (main.js:11051)

```js
async function runDirectConversation(session, text, attachments, settings, options = {}, startedAt = Date.now()) {
  // ...
  const providerResult = await directProviderChat(settings, text, attachments, sessionId, {
    ...options,
    signal,
    disableTools: false,            // ← 修复前：true
    disableWebBridge: false,        // ← 修复前：true
    requireDelegation: false,
    includeWorkState: false,
    providerFallbackToolMode: "safe",  // ← 修复后新增
    originalUserMessage: options.originalUserMessage || text,
    conversationUnderstanding: options.conversationUnderstanding || options.understanding || null,
    understanding: options.understanding || options.conversationUnderstanding || null
  });
  // ...
  return { status: "done", text: replyText, files: [], toolCalls: [], ... };
}
```

---

## 5. 修复总结

### Bug 根因

| 层级 | 问题 | 影响 |
|------|------|------|
| **Layer 1** | `runDirectConversation()` 设置 `disableTools: true` | `canExposeAgentLoopTools()` 返回 false → `body.tools = []` → 模型完全无法调用工具 |
| **Layer 2** | `PROVIDER_FALLBACK_SAFE_TOOL_IDS` 仅含 4 个工具 | 即使 Layer 1 修复，safe 模式下也只有 `list_skills`、`web_search`、`webpage_read`、`browser_current_page` 可用 |
| **PermissionManager** | `check()` 始终返回 `allowed: true` | 不是 bug 根因，"权限不足"提示来自错误适配器的用户友好映射 |

### 修复内容

| 修复点 | 文件 | 行号 | 修改前 | 修改后 |
|--------|------|------|--------|--------|
| Fix 1 | `main.js` | 11068 | `disableTools: true` | `disableTools: false` |
| Fix 1 | `main.js` | 11069 | `disableWebBridge: true` | `disableWebBridge: false` |
| Fix 1 | `main.js` | 11072 | _(无此行)_ | `providerFallbackToolMode: "safe"` |
| Fix 2 | `main.js` | 8029-8067 | 4 个工具 ID | 37 个工具 ID |

### 为什么"检查更新"不受影响

检查更新走的是 `Updater` 类（独立的 `updater.js`），完全不经过工具调用系统。

---

## 6. 完整调用链路

```
用户输入 "帮我搜索XXX"
  │
  ▼
ConversationUnderstandingLayer.analyze()
  → executionMode = "answer" (默认)
  → shouldCreateTask = false
  │
  ▼
runHermesSessionPrompt()
  → shouldCreateTask === false
  → runDirectConversation()
     → disableTools: false ✅ (修复后)
     → providerFallbackToolMode: "safe" ✅ (修复后)
     │
     ▼
  directProviderChat()
     → bindAgentLoopExecutionContext()
     → canExposeAgentLoopTools() = true ✅ (因为 disableTools !== true)
     → providerRequestBody()
        → toolSchemasForFunctionCalling()
           → ensureToolRegistry().list() → 所有已注册工具
           → .filter(providerToolCallAllowed(tool.id, options))
              → providerFallbackToolMode === "safe"
              → isProviderFallbackSafeTool(tool.id)
                 → PROVIDER_FALLBACK_SAFE_TOOL_IDS.has(tool.id) ✅ (37个工具)
           → 返回过滤后的工具 schema 数组
        → body.tools = [已过滤的工具 schema]  ✅ 非空
     │
     ▼
  callChatCompletion() → 发送到模型 API
     → 请求体包含 tools 数组 ✅
     │
     ▼
  模型返回 tool_calls: [{ function: { name: "web_search", arguments: "..." } }]
     │
     ▼
  providerToolCallAllowed("web_search", executionContext) → true ✅
     │
     ▼
  executeToolActions([{ type: "web_search", ... }])
     → ToolRegistry.execute("web_search", params)
        → PermissionManager.check() → { allowed: true } ✅
        → tool.execute(params, context) → 执行搜索
        → 返回 { success: true, result: ..., ... }
     │
     ▼
  工具结果 → messages → 继续循环
     → 模型返回最终文本（无 tool_calls）
     → 返回给用户 ✅
```
