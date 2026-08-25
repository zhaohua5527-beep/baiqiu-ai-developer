"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  resolveAppRoot,
  resolveTarget,
  isWritableTarget,
  detectUnsafeCode,
  validateSyntax,
  createBackup,
  sha256
} = require("./healing-safeguard");
const { repairPolicy } = require("./repair-policy");

// 白球完全自主自愈引擎。
// 链路：感知(错误台账) → 诊断(黑球返回修复方案) → 安全修改(护栏+备份+语法校验)
//      → 验证(静态校验，不执行) → 学习(记入 healed.jsonl)。
// 安全要点：
//   - 写入后绝不在主进程 require/执行新代码（防止任意代码执行）
//   - 可写范围限 renderer-v2 与 tools 新增文件（services/ 主目录禁止）
//   - 所有副作用被护栏硬约束：路径白名单、会员禁区、危险代码拦截、覆盖前备份

const MAX_HEALED = 200;
const DEFAULT_HEALING_DIRS = ["renderer-v2", "tools"];

class SelfHealingEngine {
  constructor(options = {}) {
    this.appRoot = resolveAppRoot(options.appRoot);
    this.dataRoot = options.dataRoot || "";
    this.healLogPath = "";
    if (this.dataRoot) {
      this.healLogPath = path.join(this.dataRoot, "self-healing", "healed.jsonl");
    }
    this.events = [];
  }

  _emit(event) {
    this.events.push(event);
    if (this.events.length > 20) this.events = this.events.slice(-20);
  }

  status() {
    return {
      appRoot: this.appRoot,
      writableDirs: DEFAULT_HEALING_DIRS,
      protectedFiles: ["main.js", "preload.js", "browser-preload.js", "tool-registry.js", "tool-loader.js", "services/**", "config/**"],
      repairPolicy: repairPolicy(),
      lastEvents: [...this.events]
    };
  }

  // 诊断入口：黑球看到错误后给出 target 文件 + 新内容（或说明不需要改）。
  // 返回是否通过护栏；未通过则给出原因，黑球据此调整方案。
  evaluateProposal({ file = "", code = "", reason = "" } = {}) {
    if (!file) return { ok: false, reason: "缺少目标文件" };
    if (typeof code !== "string" || !code.trim()) return { ok: false, reason: "缺少新的文件内容" };
    const target = resolveTarget(this.appRoot, file);
    if (!target.ok) return { ok: false, reason: target.reason };
    const rel = target.relative;
    const writable = isWritableTarget(rel);
    if (!writable.ok) return { ok: false, reason: writable.reason };
    // tools/ 下只允许新增文件，不允许覆盖已加载工具（覆盖会在下次启动时被主进程执行）。
    if (rel.startsWith("tools/") && fs.existsSync(target.target)) {
      return { ok: false, reason: "tools/ 下只能新增文件，禁止覆盖已有工具" };
    }
    const unsafe = detectUnsafeCode(code);
    if (unsafe) return { ok: false, reason: unsafe };
    // tools 新增文件需要 module.exports 才能被注册，放行 exports；其他目录禁止。
    if (!rel.startsWith("tools/") && /module\s*\.\s*exports/i.test(String(code || ""))) {
      return { ok: false, reason: "renderer 代码禁止改写模块导出" };
    }
    const syntax = validateSyntax(code, rel);
    if (!syntax.ok) return { ok: false, reason: `语法错误：${syntax.error}` };
    return { ok: true, target: target.target, relative: rel, reason: String(reason || "").slice(0, 1000) };
  }

  // 执行修改：护栏全过才落地，覆盖前备份，成功记学习日志。
  // 写入后不执行新代码（避免主进程任意代码执行），仅静态验证。
  apply({ file = "", code = "", reason = "", diagnosis = "" } = {}) {
    const proposal = this.evaluateProposal({ file, code, reason });
    if (!proposal.ok) {
      this._emit({ type: "rejected", file, reason: proposal.reason, at: Date.now() });
      return { ok: false, reason: proposal.reason, applied: false };
    }
    const { target, relative } = proposal;
    let backupPath = "";
    let existed = false;
    try {
      const backup = createBackup(this.appRoot, target);
      backupPath = backup.backupPath;
      existed = backup.exists;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, code, "utf8");
      this._logHealed({ file: relative, reason, diagnosis, backupPath, existed, timestamp: Date.now() });
      this._emit({ type: "applied", file: relative, backupPath, at: Date.now() });
      return {
        ok: true,
        applied: true,
        file: relative,
        backupPath,
        existed,
        note: existed
          ? `已修改 ${relative}（旧文件已备份 ${backupPath}；renderer 改动下次启动生效）`
          : `已新建 ${relative}（tools 新增工具下次启动自动注册）`
      };
    } catch (error) {
      if (backupPath && fs.existsSync(backupPath) && fs.existsSync(target)) fs.copyFileSync(backupPath, target);
      this._emit({ type: "error", file: relative, reason: error?.message || String(error), at: Date.now() });
      return { ok: false, reason: error?.message || String(error), applied: false, rolledBack: Boolean(backupPath) };
    }
  }

  _logHealed(entry) {
    if (!this.healLogPath) return;
    try {
      fs.mkdirSync(path.dirname(this.healLogPath), { recursive: true });
      const lines = fs.existsSync(this.healLogPath) ? fs.readFileSync(this.healLogPath, "utf8").split("\n").filter(Boolean) : [];
      lines.push(JSON.stringify({ ...entry, hash: sha256(entry.backupPath || entry.file) }));
      const trimmed = lines.slice(-MAX_HEALED);
      fs.writeFileSync(this.healLogPath, `${trimmed.join("\n")}\n`, "utf8");
    } catch {}
  }

  history({ limit = 20 } = {}) {
    if (!this.healLogPath || !fs.existsSync(this.healLogPath)) return [];
    try {
      const lines = fs.readFileSync(this.healLogPath, "utf8").split("\n").filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(100, Number(limit) || 20))).reverse().map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
}

module.exports = { SelfHealingEngine, DEFAULT_HEALING_DIRS, MAX_HEALED };
