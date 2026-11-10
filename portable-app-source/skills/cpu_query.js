"use strict";

const MANIFEST = {
  "name": "cpu_query",
  "description": "白球已验证专业技能：CPU 查询",
  "parameters": {
    "type": "object",
    "properties": {
      "request": {
        "type": "string",
        "description": "用户当前任务"
      },
      "host": {
        "type": "string",
        "description": "主机地址"
      },
      "port": {
        "type": "number",
        "description": "端口"
      },
      "timeoutMs": {
        "type": "number",
        "description": "超时时间"
      }
    },
    "required": []
  },
  "permission": {
    "level": "skill.execute",
    "scope": "skills"
  }
};

const os = require("node:os");
async function execute() {
  const cpus = os.cpus();
  return { success: cpus.length > 0, result: { model: cpus[0]?.model || "", cores: cpus.length, speedMHz: cpus[0]?.speed || 0, loadAverage: os.loadavg() }, evidence: [{ type: "system", capability: "cpu" }] };
}

module.exports = { MANIFEST, execute };
