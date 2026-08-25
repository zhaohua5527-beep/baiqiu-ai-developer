function createTool() {
  return {
    id: "launch_windows_application",
    name: "打开 Windows 应用",
    description: "直接启动本机已安装的 Windows 应用，不经过模型或终端兼容层。",
    parameters: {
      type: "object",
      required: ["application"],
      properties: {
        application: { type: "string", enum: ["wps", "calculator"] }
      }
    },
    permission: { level: "process.execute", scope: "system.applicationLaunch" },
    async execute(params, context) {
      const result = await context.runtime.executeLaunchWindowsApplication(params);
      return {
        success: true,
        result,
        error: null,
        evidence: [{ type: "process-launch", tool: "launch_windows_application", executable: result.executable, pid: result.pid }]
      };
    }
  };
}

module.exports = { createTool };
