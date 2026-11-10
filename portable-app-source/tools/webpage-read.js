function createTool(context = {}) {
  return {
    id: "webpage_read",
    name: "读取网页正文",
    description: "读取公开 HTTP/HTTPS 网页的标题和正文，用于后续总结、分析和信息提取。不执行网页脚本，也不使用登录 Cookie。",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "需要读取的公开 HTTP/HTTPS 网页地址" }
      }
    },
    permission: { level: "network.read", scope: "web" },
    async execute(params) {
      const url = String(params.url || "").trim();
      if (!url) throw new Error("webpage_read 需要 url");
      const result = await context.runtime.executeWebpageRead({ url });
      return {
        success: Boolean(result?.ok),
        result,
        error: result?.ok ? null : (result?.error || "网页正文读取失败"),
        evidence: [{ type: "webpage-read", url: result?.url || url, title: result?.title || "", contentLength: String(result?.content || "").length }]
      };
    }
  };
}

module.exports = { createTool };
