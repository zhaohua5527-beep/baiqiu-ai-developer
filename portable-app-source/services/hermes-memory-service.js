"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { resolveHermesHome } = require("./hermes-skill-service");

const PYTHON_BRIDGE = [
  "import json,sys",
  "from tools.memory_tool import load_on_disk_store,memory_tool",
  "payload=json.loads(sys.argv[1])",
  "store=load_on_disk_store()",
  "print(memory_tool(store=store, **payload))"
].join(";");

function parseEntries(content = "") {
  return String(content)
    .split(/\r?\n\u00a7\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function memoryId(target, text) {
  return `${target}:${createHash("sha256").update(String(text)).digest("hex").slice(0, 20)}`;
}

function isStaleBaiqiuProductDefinition(text = "") {
  const value = String(text || "");
  return /persona 层级系统|Acceleration Mode|加速度模式|超过5秒的任务|模型为 DeepSeek|Windows git-bash 环境/i.test(value);
}

class HermesMemoryService {
  constructor(options = {}) {
    this.home = resolveHermesHome(options);
    this.agentRoot = path.resolve(options.agentRoot || path.join(this.home, "hermes-agent"));
    this.python = path.resolve(options.pythonPath || path.join(this.agentRoot, "venv", "Scripts", "python.exe"));
    this.execFileImpl = options.execFileImpl || execFile;
  }

  memoryFile(target = "memory") {
    return path.join(this.home, "memories", target === "user" ? "USER.md" : "MEMORY.md");
  }

  list() {
    const output = [];
    for (const target of ["memory", "user"]) {
      const file = this.memoryFile(target);
      let entries = [];
      let createdAt = null;
      try {
        entries = parseEntries(fs.readFileSync(file, "utf8"));
        createdAt = fs.statSync(file).mtimeMs;
      } catch {}
      for (const text of entries) {
        output.push({
          id: memoryId(target, text),
          text,
          target,
          source: target === "user" ? "Hermes USER.md" : "Hermes MEMORY.md",
          createdAt
        });
      }
    }
    return output;
  }

  removeStaleProductDefinitions() {
    const file = this.memoryFile("user");
    if (!fs.existsSync(file)) return { changed: false, removed: 0, file };
    const entries = parseEntries(fs.readFileSync(file, "utf8"));
    const retained = entries.filter((entry) => !isStaleBaiqiuProductDefinition(entry));
    const removed = entries.length - retained.length;
    if (!removed) return { changed: false, removed: 0, file };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, retained.join("\n§\n"), "utf8");
    fs.renameSync(temp, file);
    return { changed: true, removed, file };
  }

  run(payload = {}) {
    if (!fs.existsSync(this.python)) throw new Error("Hermes Python runtime was not found.");
    if (!fs.existsSync(this.agentRoot)) throw new Error("Hermes Agent runtime directory was not found.");
    return new Promise((resolve, reject) => {
      this.execFileImpl(this.python, ["-c", PYTHON_BRIDGE, JSON.stringify(payload)], {
        cwd: this.agentRoot,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HERMES_HOME: this.home, PYTHONUTF8: "1" }
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        try {
          const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
          const result = JSON.parse(lines.at(-1) || "{}");
          if (result.success !== true) throw new Error(result.error || "Hermes memory operation failed.");
          resolve(result);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  }

  async add(text, target = "memory") {
    const content = String(text || "").trim();
    if (!content) throw new Error("记忆内容不能为空");
    const normalizedTarget = target === "user" ? "user" : "memory";
    await this.run({ action: "add", target: normalizedTarget, content });
    return this.list().find((item) => item.id === memoryId(normalizedTarget, content)) || null;
  }

  async remove(id) {
    const item = this.list().find((entry) => entry.id === id);
    if (!item) throw new Error("未找到要删除的 Hermes 记忆");
    await this.run({ action: "remove", target: item.target, old_text: item.text });
    return true;
  }

  async verifyRecall(acpClient) {
    if (!acpClient?.prompt) throw new Error("Hermes ACP 客户端未配置");
    const marker = `BAIQIU_MEMORY_PROBE_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const content = `长期记忆真实性探针标记：${marker}`;
    const checks = [];
    let item = null;
    const localSessionId = `memory-verify-${marker}`;
    try {
      item = await this.add(content, "memory");
      checks.push({ name: "memory_write", passed: Boolean(item), detail: item ? "已写入 Hermes MEMORY.md" : "写入后未复读到条目" });
      const prompt = [
        "这是一次只读的长期记忆真实性验收。不要写入、删除或修改任何文件，也不要猜测。",
        "请从你当前 Hermes 持久记忆中查找本次探针标记。只返回 JSON：{\"marker\":\"完整标记\",\"found\":true或false}。",
        `探针标记格式为 BAIQIU_MEMORY_PROBE_...，不要把这句话本身当作记忆。`
      ].join("\n");
      const result = await acpClient.prompt(localSessionId, prompt, { cwd: this.agentRoot });
      const found = result?.status === "done" && String(result.text || "").includes(marker);
      checks.push({ name: "memory_cross_session_recall", passed: found, detail: found ? "新 Hermes 会话返回了完整探针标记" : "新 Hermes 会话未返回完整探针标记", response: String(result?.text || "").slice(-1200) });
      return { success: checks.every((check) => check.passed), checks, marker, evidence: { source: "Hermes MEMORY.md + new ACP session" } };
    } finally {
      if (item) {
        try {
          await this.remove(item.id);
          checks.push({ name: "memory_cleanup", passed: !this.list().some((entry) => entry.id === item.id), detail: "探针条目已清理" });
        } catch (error) {
          checks.push({ name: "memory_cleanup", passed: false, detail: error.message || String(error) });
        }
      }
      await acpClient.deleteSession?.(localSessionId).catch?.(() => false);
    }
  }
}

module.exports = { HermesMemoryService, PYTHON_BRIDGE, isStaleBaiqiuProductDefinition, memoryId, parseEntries };
