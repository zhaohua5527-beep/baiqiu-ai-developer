"use strict";

function createTools() {
  return [
    {
      id: "system_process",
      name: "查询进程",
      description: "读取 Windows 当前进程清单，可按名称筛选，不修改系统状态。",
      category: "system",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        }
      },
      permission: { level: "system.read", scope: "system" },
      async execute(params, context) {
        const result = await context.runtime.executeSystemProcess(params);
        return {
          success: result?.success === true,
          result,
          error: result?.success === true ? null : result?.error,
          evidence: [{ type: "windows-process-list", tool: "system_process", ...(result?.evidence || {}) }]
        };
      }
    },
    {
      id: "system_process_terminate",
      name: "终止进程",
      description: "按 PID 终止指定 Windows 进程；每次执行都需要用户确认。",
      category: "system",
      parameters: {
        type: "object",
        required: ["pid"],
        properties: { pid: { type: "integer", minimum: 1 } }
      },
      permission: { level: "system.execute", scope: "system" },
      riskLevel: "high",
      async execute(params, context) {
        const result = await context.runtime.executeSystemProcessTerminate(params);
        return {
          success: result?.success === true,
          result,
          error: result?.success === true ? null : result?.error,
          evidence: [{ type: "windows-process-terminate", tool: "system_process_terminate", ...(result?.evidence || {}) }]
        };
      }
    }
  ];
}

module.exports = { createTools };
