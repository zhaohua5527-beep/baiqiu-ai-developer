"use strict";

function tool(id, name, description, parameters, run, permission = { level: "system.read", scope: "system" }) {
  return {
    id,
    name,
    description,
    category: id === "network_port_check" ? "network" : "system",
    parameters,
    permission,
    async execute(params = {}, context = {}) {
      const result = await run(params, context.runtime);
      return {
        success: result?.success === true,
        result,
        error: result?.success === true ? null : (result?.error || "本地系统检测失败"),
        evidence: [{ type: "local-system-diagnostic", tool: id, ...(result?.evidence || {}) }]
      };
    }
  };
}

function createTools() {
  return [
    tool("system_cpu", "CPU 状态", "读取本机 CPU 型号、核心数和当前使用率采样。", { type: "object", properties: {} }, (_params, runtime) => runtime.executeSystemCpu()),
    tool("system_memory", "内存状态", "读取本机物理内存总量、可用量和使用率。", { type: "object", properties: {} }, (_params, runtime) => runtime.executeSystemMemory()),
    tool("system_disk", "磁盘状态", "读取指定磁盘的总容量、可用容量和使用率。", {
      type: "object",
      properties: { root: { type: "string", description: "例如 D:\\" } }
    }, (params, runtime) => runtime.executeSystemDisk(params)),
    tool("network_port_check", "端口检测", "使用本地 TCP 连接检测指定主机端口是否可达，不发送业务数据。", {
      type: "object",
      required: ["port"],
      properties: {
        host: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        timeoutMs: { type: "integer", minimum: 100, maximum: 10000 }
      }
    }, (params, runtime) => runtime.executeNetworkPortCheck(params))
  ];
}

module.exports = { createTools };
