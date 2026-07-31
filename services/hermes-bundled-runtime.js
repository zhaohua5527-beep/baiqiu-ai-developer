const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveHermesHome(options = {}) {
  return path.resolve(
    options.hermesHome
      || process.env.HERMES_HOME
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes")
  );
}

function resolveBundledHermesRuntime(options = {}) {
  const resourcesPath = String(options.resourcesPath || "").trim();
  const root = [
    options.bundledRuntimePath,
    resourcesPath && path.join(resourcesPath, "hms-runtime"),
    resourcesPath && path.join(resourcesPath, ".hms-runtime")
  ]
    .filter(Boolean)
    .find((candidate) => fs.existsSync(candidate));
  if (!root) return null;
  const hermesRoot = path.join(root, "hermes");
  const agentRoot = path.join(hermesRoot, "hermes-agent");
  const pythonPath = path.join(root, "python", "python.exe");
  const sitePackages = path.join(agentRoot, "venv", "Lib", "site-packages");
  const acpEntry = path.join(agentRoot, "acp_adapter", "entry.py");
  if (![pythonPath, sitePackages, acpEntry].every((item) => fs.existsSync(item))) return null;
  return {
    root,
    hermesRoot,
    agentRoot,
    pythonPath,
    sitePackages,
    manifestPath: path.join(root, "runtime-manifest.json")
  };
}

function runtimePythonPath(runtime, extras = []) {
  if (!runtime) return extras.filter(Boolean).join(path.delimiter);
  return [runtime.agentRoot, runtime.sitePackages, ...extras].filter(Boolean).join(path.delimiter);
}

function copyMissingTree(source, destination) {
  if (!fs.existsSync(source)) return 0;
  let copied = 0;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copied += copyMissingTree(from, to);
    } else if (entry.isFile() && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function ensureBundledHermesHome(options = {}) {
  const runtime = resolveBundledHermesRuntime(options);
  const home = resolveHermesHome(options);
  if (!runtime) return { available: false, home, copied: 0 };
  fs.mkdirSync(home, { recursive: true });
  let copied = 0;
  copied += copyMissingTree(path.join(runtime.hermesRoot, "skills"), path.join(home, "skills"));
  copied += copyMissingTree(path.join(runtime.hermesRoot, "plugins"), path.join(home, "plugins"));
  const bundledSoul = path.join(runtime.hermesRoot, "SOUL.md");
  const localSoul = path.join(home, "SOUL.md");
  if (fs.existsSync(bundledSoul) && !fs.existsSync(localSoul)) {
    fs.copyFileSync(bundledSoul, localSoul);
    copied += 1;
  }
  return { available: true, home, copied, runtime };
}

module.exports = {
  copyMissingTree,
  ensureBundledHermesHome,
  resolveBundledHermesRuntime,
  resolveHermesHome,
  runtimePythonPath
};
