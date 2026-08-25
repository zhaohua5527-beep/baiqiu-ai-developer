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
    tabId: { type: "string", description: "browser_list_tabs 或 browser_open_tab 返回的标签页 id" },
    documentId: { type: "string", description: "browser_inspect 返回的页面版本 id；页面跳转后必须重新检查" },
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
    tool("browser_list_tabs", "列出网页标签", "列出黑球浏览器全部真实标签页以及各自的 tabId、documentId、网址和活动状态。操作多个网页前必须先调用。", {
      type: "object",
      properties: {}
    }, { level: "network.read", scope: "browser.tabs" }, "list_tabs"),
    tool("browser_open_tab", "新建网页标签", "在黑球浏览器中新建一个真实网页标签，返回 tabId 和 documentId。默认切换到新标签；activate=false 可在后台打开。", {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "网址、域名或搜索词" },
        activate: { type: "boolean", description: "是否切换到新标签，默认 true" }
      }
    }, { level: "network.read", scope: "browser.tabs" }, "open_tab"),
    tool("browser_select_tab", "切换网页标签", "把指定 tabId 设为当前可见网页，不改变其他标签内容。", {
      type: "object",
      required: ["tabId"],
      properties: { tabId: { type: "string" } }
    }, { level: "network.read", scope: "browser.tabs" }, "select_tab"),
    tool("browser_close_tab", "关闭网页标签", "关闭指定 tabId。关闭前应确认该网页不再需要。", {
      type: "object",
      required: ["tabId"],
      properties: { tabId: { type: "string" } }
    }, { level: "network.write", scope: "browser.tabs" }, "close_tab", { riskLevel: "medium" }),
    tool("browser_inspect", "检查指定网页", "读取指定 tabId 页面的可见文字和可交互元素，返回 documentId 作用域内的稳定 ref。执行点击或输入前应先调用。", {
      type: "object",
      required: ["tabId"],
      properties: {
        tabId: { type: "string", description: "要检查的标签页 id" },
        maxElements: { type: "integer", minimum: 1, maximum: 120 },
        includeText: { type: "boolean" }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "inspect"),
    tool("browser_click", "点击网页元素", "按 browser_inspect 返回的 ref 点击普通网页元素。删除、付款、下单、注销等高风险元素不会执行，而会要求调用 browser_confirm_action。", {
      type: "object",
      required: ["tabId", "documentId"],
      properties: targetProperties()
    }, { level: "network.write", scope: "browser.interaction" }, "click", { riskLevel: "medium" }),
    tool("browser_confirm_action", "确认高风险网页点击", "仅在 browser_click 返回 BROWSER_CONFIRM_REQUIRED 后调用；确认后点击同一元素。权限信任模式下会使用用户的持续授权，不再重复询问。", {
      type: "object",
      required: ["tabId", "documentId"],
      properties: targetProperties()
    }, { level: "network.write", scope: "browser.highRisk" }, "confirm_click", { riskLevel: "high", requirePermission: true }),
    tool("browser_type", "输入网页文字", "向普通输入框、文本域或可编辑区域输入文字。密码框始终禁止自动填写。", {
      type: "object",
      required: ["tabId", "documentId", "value"],
      properties: {
        ...targetProperties(),
        value: { type: "string" },
        replace: { type: "boolean", description: "默认覆盖原文字；false 表示追加" }
      }
    }, { level: "network.write", scope: "browser.interaction" }, "type", { riskLevel: "medium" }),
    tool("browser_scroll", "滚动网页", "滚动当前网页，或把指定元素滚动到视口中间。", {
      type: "object",
      required: ["tabId", "documentId"],
      properties: {
        ...targetProperties(),
        x: { type: "number" },
        y: { type: "number", description: "纵向滚动距离，默认 600" }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "scroll"),
    tool("browser_wait", "等待网页状态", "等待选择器或文字出现/消失，超时上限 15 秒。", {
      type: "object",
      required: ["tabId", "documentId"],
      properties: {
        tabId: { type: "string" },
        documentId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        hidden: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 15000 }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "wait"),
    tool("browser_screenshot", "截取当前网页", "截取黑球浏览器当前可见页面并保存为真实 PNG 文件。", {
      type: "object",
      required: ["tabId", "documentId"],
      properties: {
        tabId: { type: "string" },
        documentId: { type: "string" }
      }
    }, { level: "network.read", scope: "browser.currentPage" }, "screenshot")
  ];
}

module.exports = { createTools, resultFor };
