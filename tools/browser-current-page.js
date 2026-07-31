"use strict";

function createTool(context = {}) {
  return {
    id: "browser_current_page",
    name: "读取黑球浏览器当前页面",
    description: "读取黑球浏览器当前已加载页面的标题、网址和可见文本。使用浏览器持久化登录态，不操作外部浏览器。",
    parameters: { type: "object", properties: {} },
    permission: { level: "network.read", scope: "browser.currentPage" },
    async execute() {
      const result = await context.runtime.executeBrowserCurrentPage();
      const content = String(result?.content || "");
      return {
        success: Boolean(result?.url && content),
        result: { ...result, content: content.slice(0, 60000) },
        error: content ? null : "当前页面没有可读取内容",
        evidence: [{ type: "browser-current-page", url: result?.url || "", title: result?.title || "", contentLength: content.length }]
      };
    }
  };
}

module.exports = { createTool };
