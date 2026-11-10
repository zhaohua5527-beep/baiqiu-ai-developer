"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

// 白球自主自愈的静态护栏 —— 白名单 + 黑名单双层，杜绝绕过。
// 设计原则：自愈能改的文件必须满足"改了也碰不到 Node 授权判定"。
//   - renderer-v2/ 是浏览器脚本，主进程不加载、无 Node 权限，改它不碰授权逻辑
//   - tools/ 只允许新增文件（不覆盖已加载工具，防主进程执行新代码）
//   - services/ 主目录整体禁止（全是启动即加载、参与授权判定的模块）
//   - self-healing/ 自身禁止修改（防"一键拆除护栏"提权）
// 会员系统文件无论落在哪个目录都是绝对禁区。

const APP_WRITABLE_RELATIVE = /^(?:renderer-v2|tools)[\\/]/;
// services/ 主目录与自身护栏目录不可改（防启动即加载模块注入 + 防自废护栏）。
const APP_FORBIDDEN_PREFIX = /^(?:services|config|test|build|dist|node_modules)[\\/]/;

// 受保护文件：改了会破坏启动链或授权判定。
const PROTECTED_FILES = new Set([
  "main.js",
  "preload.js",
  "browser-preload.js",
  "tool-registry.js",
  "tool-loader.js"
]);

// 会员系统绝对禁区（路径关键词），任何自主修改不得触碰。
const MEMBERSHIP_PATH_PATTERN = /(?:license|membership|entitle|授权|会员|计费|order|payment|activate|unlock|trial|plan|premium)/i;

// 危险代码：自愈写入的代码绝不允许触碰 Node 进程、文件系统、网络或会员判定。
// 这些是"能碰到"就危险的能力，与具体写法无关（堵住拼接/编码绕过）。
const UNSAFE_PATTERNS = [
  [/child[\s\S]*process|exec[\s\S]*sync|spawn\s*\(|fork\s*\(|shell:/i, "禁止执行外部命令"],
  [/require\s*\(/i, "禁止 require 任何模块"],
  [/import\s*\(/i, "禁止动态 import"],
  [/from\s*['"][^'"]+['"]/i, "禁止 import 模块"],
  [/fs[\s\S]*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|writeFile|writeFileSync|appendFile|rename|copyFile)\s*\(/i, "禁止文件系统写操作"],
  [/process[\s\S]*\.\s*(?:env|exit|kill|chdir|cwd|mainModule)\b/i, "禁止访问进程环境"],
  [/global[\s\S]*\.\s*require\b/i, "禁止全局 require"],
  [/eval\s*\(/i, "禁止使用 eval"],
  [/new\s+Function\s*\(/i, "禁止动态构造函数"],
  [/^\s*throw\b/im, "禁止顶层抛错（防启动崩溃）"],
  [/https?:\/\/|wss?:\/\//i, "禁止硬编码网络地址"],
  [/\.\.\s*[\\/]/i, "禁止路径穿越"]
];

// 会员相关代码内容：新代码一旦出现这些模式即拒绝（双保险，防改其他文件间接绕过）。
const MEMBERSHIP_CODE_PATTERNS = [
  [/currentLicenseStatus|memberToolEntitlement|membershipExpiresAt/i, "禁止触碰会员授权状态"],
  [/licenseStatus|unlocked\s*[=:]|locked\s*[=:]|activationState/i, "禁止强制解锁会员"],
  [/membershipActive|trialActive|expiresAt\s*[=:]|plan\s*[=:]/i, "禁止改动会员有效期或套餐"],
  [/isDevMode|--dev|developerLicense/i, "禁止伪造开发者授权"],
  [/prototype[\s\S]*\s*=/i, "禁止原型链篡改"]
];

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function resolveAppRoot(root = "") {
  const candidate = root || path.resolve(__dirname, "..", "..");
  return path.resolve(candidate);
}

// 归一化路径后做白名单检查。
function isWritableTarget(relativePath = "") {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  if (PROTECTED_FILES.has(normalized)) return { ok: false, reason: "受保护文件不允许自主修改" };
  if (APP_FORBIDDEN_PREFIX.test(normalized)) return { ok: false, reason: "该目录参与系统运行或授权判定，禁止自主修改" };
  if (MEMBERSHIP_PATH_PATTERN.test(normalized)) return { ok: false, reason: "路径涉及会员/授权系统，禁止自主修改" };
  if (!APP_WRITABLE_RELATIVE.test(normalized)) return { ok: false, reason: "路径不在可自主修改范围内" };
  return { ok: true };
}

function resolveTarget(appRoot = "", file = "") {
  const root = resolveAppRoot(appRoot);
  const requested = String(file || "").replace(/^[\\/]+/, "");
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  const outside = relative.startsWith("..") || path.isAbsolute(relative);
  if (outside) return { ok: false, reason: "目标不在白球源码目录内" };
  return { ok: true, root, target: resolved, relative: relative.replace(/\\/g, "/") };
}

function detectUnsafeCode(code = "") {
  const source = String(code || "");
  for (const [pattern, label] of UNSAFE_PATTERNS) {
    if (pattern.test(source)) return label;
  }
  for (const [pattern, label] of MEMBERSHIP_CODE_PATTERNS) {
    if (pattern.test(source)) return label;
  }
  return null;
}

function validateSyntax(code = "", filename = "self-healing.js") {
  try {
    new vm.Script(code, { filename });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function createBackup(appRoot = "", target = "") {
  const root = resolveAppRoot(appRoot);
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return { ok: true, backupPath: "", exists: false };
  const rel = path.relative(root, resolved).replace(/\\/g, "/");
  const backupPath = `${resolved}.heal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(resolved, backupPath);
  return { ok: true, backupPath, exists: true, rel };
}

module.exports = {
  APP_WRITABLE_RELATIVE,
  APP_FORBIDDEN_PREFIX,
  PROTECTED_FILES,
  MEMBERSHIP_PATH_PATTERN,
  MEMBERSHIP_CODE_PATTERNS,
  resolveAppRoot,
  isWritableTarget,
  resolveTarget,
  detectUnsafeCode,
  validateSyntax,
  createBackup,
  sha256
};
