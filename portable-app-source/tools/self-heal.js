"use strict";

// 白球自主修改自己软件的核心工具。
// 白球在对话/执行中感知到自身缺陷或用户要求改进时，通过本工具安全落地修改。
// 安全设计：
//   - 可写范围仅限 renderer-v2/ 与 tools/ 新增文件（services/ 主目录、main.js 等核心文件禁止）
//   - 覆盖前自动备份，写入后不做主进程执行（防任意代码执行）
//   - 会员/授权系统是绝对禁区，任何路径或代码触碰即拒绝
// 用法：
//   - self_heal { file, code, reason }   应用修改（整体覆盖）
//   - self_heal { file, action: "revert" }  回滚该文件最近一次自愈修改（同样过护栏）
//   - self_heal { action: "history" }    查看自愈记录
function createTool() {
  return {
    id: "self_heal",
    name: "修改白球自身",
    description: "让白球安全修改自己的前端代码。可写范围仅限 renderer-v2/ 目录，以及 tools/ 下新增工具文件；会自动备份旧文件、校验语法与危险代码；main.js、services/、config/ 等系统运行文件、以及所有会员/授权相关文件均禁止自主修改。也可查看自愈记录或回滚最近一次修改。",
    parameters: {
      type: "object",
      required: ["file", "reason"],
      properties: {
        file: {
          type: "string",
          description: "要修改的白球相对路径。允许：renderer-v2/ 下任意文件，或 tools/ 下【新增】的 .js 文件。禁止：main.js、services/、config/、test/、所有含会员/授权关键词的路径。"
        },
        code: {
          type: "string",
          description: "新的完整文件内容（整体覆盖）。不能包含 require/import/process/fs 写操作/eval/原型篡改等危险代码。"
        },
        reason: {
          type: "string",
          description: "修改原因，必须说明要解决什么问题，用于审计与学习"
        },
        action: {
          type: "string",
          enum: ["apply", "revert", "history"],
          description: "apply=应用修改（默认）；revert=回滚该文件最近一次自愈修改；history=查看自愈记录。"
        },
        diagnosis: {
          type: "string",
          description: "可选：你对当前问题的诊断说明，用于白球学习改进"
        }
      }
    },
    permission: { level: "app.write", scope: "appRoot" },
    async execute(params, context) {
      const { engine } = context?.selfHealing || {};
      if (!engine) throw new Error("自愈引擎未初始化");
      const file = String(params?.file || "").trim();
      const reason = String(params?.reason || "").trim();
      const action = String(params?.action || "apply").trim();
      const code = String(params?.code ?? "");
      const diagnosis = String(params?.diagnosis || "").trim();

      if (action === "history") {
        return { success: true, result: { history: engine.history() } };
      }
      if (action === "revert") {
        if (!file) return { success: false, error: "缺少目标文件", result: null };
        // revert 也必须过完整护栏：目标必须是可写路径，不能回滚到会员文件。
        const proposal = engine.evaluateProposal({ file, code: "module.exports = {};", reason: "revert target check" });
        if (!proposal.ok) return { success: false, error: proposal.reason, result: null };
        const history = engine.history({ limit: 50 });
        const entry = history.find((item) => item.file === file);
        if (!entry?.backupPath) return { success: false, error: `没有找到 ${file} 的自愈备份，无法回滚`, result: null };
        // 校验备份文件真实存在于引擎备份目录内，且就是该文件的 .heal- 备份，防止伪造条目。
        const backupPath = String(entry.backupPath || "");
        const targetDir = require("node:path").dirname(proposal.target);
        const expectedPrefix = `${proposal.target}.heal-`;
        if (!backupPath.startsWith(expectedPrefix)) {
          return { success: false, error: "备份路径不匹配，已拒绝回滚", result: null };
        }
        try {
          const fs = require("node:fs");
          if (!fs.existsSync(backupPath)) return { success: false, error: `备份文件已不存在：${backupPath}`, result: null };
          fs.copyFileSync(backupPath, proposal.target);
          return { success: true, result: `已回滚 ${file} 到修改前版本（备份：${backupPath}）` };
        } catch (error) {
          return { success: false, error: `回滚失败：${error?.message || error}`, result: null };
        }
      }

      const result = engine.apply({ file, code, reason, diagnosis });
      return result.ok
        ? { success: true, result: result.note || `已修改 ${file}`, evidence: result }
        : { success: false, error: result.reason, result: null, evidence: result };
    }
  };
}

module.exports = { createTool };
