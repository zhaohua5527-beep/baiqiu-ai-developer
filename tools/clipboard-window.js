"use strict";

function createTools() {
  return [
    {
      id: "clipboard_read",
      name: "读取剪贴板",
      description: "读取当前用户剪贴板中的纯文本内容。",
      category: "desktop",
      parameters: { type: "object", properties: {} },
      permission: { level: "desktop.read", scope: "clipboard" },
      async execute(_params, context) {
        const result = await context.runtime.executeClipboardRead();
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "clipboard", tool: "clipboard_read" }] };
      }
    },
    {
      id: "clipboard_write",
      name: "写入剪贴板",
      description: "将用户明确提供的纯文本写入当前用户剪贴板。",
      category: "desktop",
      parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      permission: { level: "desktop.write", scope: "clipboard" },
      async execute(params, context) {
        const result = await context.runtime.executeClipboardWrite(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "clipboard", tool: "clipboard_write" }] };
      }
    },
    {
      id: "window_inspect",
      name: "查看窗口",
      description: "读取白球自身窗口和可识别外部窗口的标题、进程、位置和大小。",
      category: "desktop",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } } },
      permission: { level: "desktop.read", scope: "windows" },
      async execute(params, context) {
        const result = await context.runtime.executeWindowInspect(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "window", tool: "window_inspect" }] };
      }
    },
    {
      id: "window_focus",
      name: "聚焦窗口",
      description: "将用户明确指定的白球或外部窗口置于前台。高风险窗口需要用户确认。",
      category: "desktop",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      permission: { level: "desktop.write", scope: "windows" },
      riskLevel: "medium",
      requirePermission: true,
      async execute(params, context) {
        const result = await context.runtime.executeWindowFocus(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "window", tool: "window_focus" }] };
      }
    },
    {
      id: "window_resize",
      name: "调整窗口",
      description: "调整用户明确指定窗口的位置和大小，限制在合理桌面范围内。",
      category: "desktop",
      parameters: {
        type: "object",
        required: ["query", "width", "height"],
        properties: {
          query: { type: "string" },
          left: { type: "integer" },
          top: { type: "integer" },
          width: { type: "integer", minimum: 320, maximum: 7680 },
          height: { type: "integer", minimum: 240, maximum: 4320 }
        }
      },
      permission: { level: "desktop.write", scope: "windows" },
      riskLevel: "medium",
      requirePermission: true,
      async execute(params, context) {
        const result = await context.runtime.executeWindowResize(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "window", tool: "window_resize" }] };
      }
    }
  ];
}

module.exports = { createTools };
