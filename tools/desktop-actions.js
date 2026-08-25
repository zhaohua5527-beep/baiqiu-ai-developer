"use strict";

function desktopTool(id, name, description, parameters, runtimeMethod, options = {}) {
  return {
    id,
    name,
    description,
    category: "desktop",
    riskLevel: options.riskLevel || "medium",
    parameters,
    permission: { level: "desktop.write", scope: "desktop.input" },
    async execute(params, context) {
      const result = await context.runtime[runtimeMethod](params || {});
      return {
        success: result?.success === true,
        result,
        error: result?.success === true ? null : result?.error,
        evidence: [{ type: "desktop-input", tool: id, action: result?.action || id, verified: result?.verified === true }]
      };
    }
  };
}

function optionalWindowProperty() {
  return { window: { type: "string", description: "可选：先聚焦的目标窗口标题或进程名" } };
}

function createTools() {
  return [
    desktopTool("desktop_click", "真实鼠标点击", "在 Windows 前台窗口中移动真实鼠标并执行左键、双击或右键。仅在网页元素桥接不可用、原生窗口或 Canvas 控件需要时使用；先用 window_inspect 确认目标窗口。", {
      type: "object", required: ["x", "y"], properties: { ...optionalWindowProperty(), x: { type: "integer", minimum: 0, maximum: 7680 }, y: { type: "integer", minimum: 0, maximum: 4320 }, action: { type: "string", enum: ["click", "double_click", "right_click"] } }
    }, "executeDesktopAction"),
    desktopTool("desktop_type", "真实键盘输入", "向当前前台窗口输入 Unicode 文本。不得输入密码、验证码、令牌或其他凭据。", {
      type: "object", required: ["text"], properties: { ...optionalWindowProperty(), text: { type: "string", minLength: 1, maxLength: 2000 } }
    }, "executeDesktopType"),
    desktopTool("desktop_key", "真实键盘按键", "向当前前台窗口发送单个普通导航或确认按键。", {
      type: "object", required: ["key"], properties: { ...optionalWindowProperty(), key: { type: "string", enum: ["ENTER", "TAB", "ESC", "BACKSPACE", "DELETE", "SPACE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGEUP", "PAGEDOWN"] } }
    }, "executeDesktopKey"),
    desktopTool("desktop_scroll", "真实鼠标滚动", "在当前前台窗口发送真实鼠标滚轮事件；正数向上，负数向下。", {
      type: "object", required: ["delta"], properties: { ...optionalWindowProperty(), delta: { type: "integer", minimum: -12000, maximum: 12000 } }
    }, "executeDesktopScroll", { riskLevel: "low" })
  ];
}

module.exports = { createTools };
