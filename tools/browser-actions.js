"use strict";

function resultFor(action, value) {
  const success = value?.ok === true;
  const error = success ? null : {
    code: value?.confirmationRequired ? "BROWSER_CONFIRM_REQUIRED" : value?.blocked ? "BROWSER_ACTION_BLOCKED" : "BROWSER_ACTION_FAILED",
    message: value?.error || `浏览器${action}失败`
  };
  return {
    success,
    result: value,
    error,
    evidence: [{ type: "black-ball-browser-action", action, url: value?.url || "", target: value?.target || null }]
  };
}

function targetProperties() {
  return {
    ref: { type: "string", description: "browser_inspect 返回的元素 ref" },
    selector: { type: "string", description: "CSS 选择器，仅在没有 ref 时使用" },
    text: { type: "string", description: "元素可见文字，仅在没有 ref/selector 时使用" }
  };
}

function tool(id, name, description, parameters, permission, action, options = {}) {
  return {
    id,
    name,
    description,
    category: "network",
    supportedIntent: ["general.chat", "realtime.web", "web.browse", "web.read"],
    riskLevel: options.riskLevel || "low",
    requirePermission: options.requirePermission === true,
    parameters,
    permission,
    async execute(params, context) {
      const value = await context.runtime.executeBrowserAction(action, params || {}, context);
      return resultFor(action, value);
    }
  };
}

function createTools() {
  return [
    tool("browser_inspect", "检查当前网页", "读取黑球浏览器当前页面的可见文字和可交互元素，返回稳定 ref。执行点击或输入前应先调用。", {
      type: "object",
      properties: {
        maxElements: { type: "integer", minimum: 1, maximum: 120 },
        includeText: { type: "boolean" }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "inspect"),
    tool("browser_click", "点击网页元素", "按 browser_inspect 返回的 ref 点击普通网页元素。删除、付款、下单、注销等高风险元素不会执行，而会要求调用 browser_confirm_action。", {
      type: "object",
      properties: targetProperties()
    }, { level: "network.write", scope: "browser.interaction" }, "click", { riskLevel: "medium" }),
    tool("browser_confirm_action", "确认高风险网页点击", "仅在 browser_click 返回 BROWSER_CONFIRM_REQUIRED 后调用；始终弹出用户确认，确认后点击同一元素。", {
      type: "object",
      properties: targetProperties()
    }, { level: "network.write", scope: "browser.highRisk" }, "confirm_click", { riskLevel: "high", requirePermission: true }),
    tool("browser_type", "输入网页文字", "向普通输入框、文本域或可编辑区域输入文字。密码框始终禁止自动填写。", {
      type: "object",
      required: ["value"],
      properties: {
        ...targetProperties(),
        value: { type: "string" },
        replace: { type: "boolean", description: "默认覆盖原文字；false 表示追加" }
      }
    }, { level: "network.write", scope: "browser.interaction" }, "type", { riskLevel: "medium" }),
    tool("browser_scroll", "滚动网页", "滚动当前网页，或把指定元素滚动到视口中间。", {
      type: "object",
      properties: {
        ...targetProperties(),
        x: { type: "number" },
        y: { type: "number", description: "纵向滚动距离，默认 600" }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "scroll"),
    tool("browser_wait", "等待网页状态", "等待选择器或文字出现/消失，超时上限 15 秒。", {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        hidden: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 15000 }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "wait"),
    tool("browser_screenshot", "截取当前网页", "截取黑球浏览器当前可见页面并保存为真实 PNG 文件。", {
      type: "object",
      properties: {}
    }, { level: "network.read", scope: "browser.currentPage" }, "screenshot")
  ];
}

module.exports = { createTools, resultFor };
