"use strict";

function createTools() {
  return [
    {
      id: "desktop_screenshot",
      name: "桌面截图",
      description: "截取当前 Windows 桌面并保存为真实 PNG 文件，不上传图片。",
      category: "desktop",
      parameters: { type: "object", properties: { outputPath: { type: "string" }, monitor: { type: "integer", minimum: 0, maximum: 16 } } },
      permission: { level: "desktop.capture", scope: "desktop" },
      requirePermission: true,
      riskLevel: "medium",
      async execute(params, context) {
        const result = await context.runtime.executeDesktopScreenshot(params);
        return { success: result?.success === true, result, error: result?.success === true ? null : result?.error, evidence: [{ type: "desktop-screenshot", tool: "desktop_screenshot", ...(result?.evidence || {}) }] };
      }
    }
  ];
}

module.exports = { createTools };
