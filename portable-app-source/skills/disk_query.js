"use strict";

const MANIFEST = {
  "name": "disk_query",
  "description": "白球已验证专业技能：磁盘查询",
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

const fs = require("node:fs");
async function execute() {
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ":\\";
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statfsSync(root);
      const totalBytes = Number(stat.bsize) * Number(stat.blocks);
      const freeBytes = Number(stat.bsize) * Number(stat.bavail);
      drives.push({ drive: root, totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, freePercent: totalBytes ? Math.round((freeBytes / totalBytes) * 100) : 0 });
    } catch {}
  }
  return { success: drives.length > 0, result: { drives }, error: drives.length ? null : "未读取到磁盘信息", evidence: drives.map((item) => ({ type: "system", capability: "disk", drive: item.drive })) };
}

module.exports = { MANIFEST, execute };
