const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HMS_VERSION = "0.19.0";

function runtimeReady(root) {
  if (!root) return false;
  return [
    path.join(root, "runtime-manifest.json"),
    path.join(root, "python", "python.exe"),
    path.join(root, "hermes", "hermes-agent", "acp_adapter", "entry.py"),
    path.join(root, "hermes", "hermes-agent", "venv", "Lib", "site-packages")
  ].every((item) => fs.existsSync(item));
}

function safeRemove(target, parent) {
  const resolved = path.resolve(target);
  const prefix = `${path.resolve(parent)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`黑球运行环境清理路径不安全：${resolved}`);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function extractionProgress(chunk, onProgress) {
  const matches = [...String(chunk || "").matchAll(/(\d{1,3})%/g)];
  if (!matches.length) return;
  const raw = Math.max(0, Math.min(100, Number(matches.at(-1)?.[1]) || 0));
  onProgress({
    percent: 5 + Math.floor(raw * 0.9),
    phase: "正在安装黑球",
    detail: "正在部署运行环境与内置技能"
  });
}

function extractArchive(extractor, archive, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(extractor, ["x", archive, `-o${destination}`, "-y", "-bsp1", "-bb0"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let diagnostic = "";
    child.stdout.on("data", (chunk) => extractionProgress(chunk, onProgress));
    child.stderr.on("data", (chunk) => {
      extractionProgress(chunk, onProgress);
      diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-6000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`黑球运行环境解压失败（${code}）：${diagnostic.trim()}`));
    });
  });
}

async function ensureHmsRuntime(options = {}) {
  const resourcesPath = path.resolve(options.resourcesPath || process.resourcesPath || "");
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const expanded = path.join(resourcesPath, "hms-runtime");
  if (runtimeReady(expanded)) return { path: expanded, installed: false, source: "expanded" };

  const dataRoot = path.resolve(options.dataRoot || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Baiqiu AI",
    "runtime"
  ));
  const target = path.join(dataRoot, `hms-${HMS_VERSION}`);
  if (runtimeReady(target)) return { path: target, installed: false, source: "installed" };

  const bundleRoot = path.join(resourcesPath, "hms-bundle");
  const archive = path.join(bundleRoot, "hms-runtime.7z");
  const extractor = path.join(bundleRoot, "7za.exe");
  if (!fs.existsSync(archive) || fs.statSync(archive).size <= 0 || !fs.existsSync(extractor)) {
    return { path: "", installed: false, source: "missing" };
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  const temporary = path.join(dataRoot, `.hms-${HMS_VERSION}.installing`);
  safeRemove(temporary, dataRoot);
  fs.mkdirSync(temporary, { recursive: true });
  onProgress({ percent: 3, phase: "正在准备黑球", detail: "正在检查安装空间" });
  try {
    await extractArchive(extractor, archive, temporary, onProgress);
    onProgress({ percent: 96, phase: "正在校验", detail: "正在确认黑球运行环境完整性" });
    if (!runtimeReady(temporary)) throw new Error("解压后的黑球运行环境不完整。");
    safeRemove(target, dataRoot);
    fs.renameSync(temporary, target);
    onProgress({ percent: 99, phase: "正在启动黑球", detail: "首次初始化即将完成" });
    return { path: target, installed: true, source: "archive" };
  } catch (error) {
    safeRemove(temporary, dataRoot);
    throw error;
  }
}

module.exports = { HMS_VERSION, ensureHmsRuntime, extractArchive, extractionProgress, runtimeReady };
