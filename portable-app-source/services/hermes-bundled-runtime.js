const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const HOME_SYNC_MARKER = ".baiqiu-bundled-home.json";
const MODELS_DEV_CACHE = "models_dev_cache.json";
const MODELS_DEV_OFFLINE_SENTINEL = "__baiqiu_offline_fallback__";

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

function mergeBundledManifest(source, destination, allowedNames = null) {
  if (!fs.existsSync(source)) return false;
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const current = lines(destination);
  const names = new Set(current.map((line) => line.split(":", 1)[0].trim()));
  const additions = lines(source).filter((line) => {
    const name = line.split(":", 1)[0].trim();
    if (!name || names.has(name) || (allowedNames && !allowedNames.has(name))) return false;
    names.add(name);
    return true;
  });
  if (!additions.length) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${[...current, ...additions].join("\n")}\n`, "utf8");
  return true;
}

function bundledSkillDirectories(root) {
  if (!fs.existsSync(root)) return [];
  const directories = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(directory, entry.name);
      if (fs.existsSync(path.join(target, "SKILL.md"))) directories.push(target);
      else visit(target);
    }
  };
  visit(root);
  return directories;
}

function syncApplicationBundledSkills(home, options = {}) {
  const source = path.resolve(
    options.applicationSkillsPath || path.join(__dirname, "..", "skills", "hermes")
  );
  if (!fs.existsSync(source)) return { copied: 0, manifestMerged: false };
  const destination = path.join(home, "skills");
  let copied = 0;
  const copiedNames = new Set();
  for (const skillDirectory of bundledSkillDirectories(source)) {
    const target = path.join(destination, path.relative(source, skillDirectory));
    if (fs.existsSync(target)) continue;
    copied += copyMissingTree(skillDirectory, target);
    copiedNames.add(path.basename(skillDirectory));
  }
  const manifestMerged = mergeBundledManifest(
    path.join(source, ".bundled_manifest"),
    path.join(destination, ".bundled_manifest"),
    copiedNames
  );
  return { copied, manifestMerged };
}

function bundledHomeIdentity(runtime) {
  if (!runtime?.manifestPath || !fs.existsSync(runtime.manifestPath)) return null;
  return {
    runtimeRoot: path.resolve(runtime.root),
    manifestSha256: createHash("sha256").update(fs.readFileSync(runtime.manifestPath)).digest("hex")
  };
}

function bundledHomeDestinationsReady(runtime, home) {
  const pairs = [
    [path.join(runtime.hermesRoot, "skills"), path.join(home, "skills")],
    [path.join(runtime.hermesRoot, "plugins"), path.join(home, "plugins")],
    [path.join(runtime.hermesRoot, "SOUL.md"), path.join(home, "SOUL.md")]
  ];
  return pairs.every(([source, destination]) => !fs.existsSync(source) || fs.existsSync(destination));
}

function bundledHomeAlreadySynced(runtime, home, identity) {
  if (!identity || !bundledHomeDestinationsReady(runtime, home)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(home, HOME_SYNC_MARKER), "utf8"));
    return marker?.runtimeRoot === identity.runtimeRoot
      && marker?.manifestSha256 === identity.manifestSha256;
  } catch {
    return false;
  }
}

function writeBundledHomeMarker(home, identity) {
  if (!identity) return;
  fs.writeFileSync(path.join(home, HOME_SYNC_MARKER), `${JSON.stringify({ ...identity, syncedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function ensureModelsDevOfflineCache(home) {
  const target = path.join(home, MODELS_DEV_CACHE);
  if (fs.existsSync(target)) {
    try {
      const current = JSON.parse(fs.readFileSync(target, "utf8"));
      if (current?.[MODELS_DEV_OFFLINE_SENTINEL]) {
        const now = new Date();
        fs.utimesSync(target, now, now);
      }
    } catch {}
    return false;
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const sentinel = {
    [MODELS_DEV_OFFLINE_SENTINEL]: {
      models: {},
      purpose: "Skip unavailable community metadata; use runtime fallbacks."
    }
  };
  fs.writeFileSync(temporary, `${JSON.stringify(sentinel)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return true;
}

function ensureBundledHermesHome(options = {}) {
  const runtime = resolveBundledHermesRuntime(options);
  const home = resolveHermesHome(options);
  fs.mkdirSync(home, { recursive: true });
  if (!runtime) {
    const applicationSkills = syncApplicationBundledSkills(home, options);
    return { available: false, home, copied: applicationSkills.copied, applicationSkills };
  }
  const identity = bundledHomeIdentity(runtime);
  if (bundledHomeAlreadySynced(runtime, home, identity)) {
    const applicationSkills = syncApplicationBundledSkills(home, options);
    ensureModelsDevOfflineCache(home);
    return { available: true, home, copied: applicationSkills.copied, cached: true, runtime, applicationSkills };
  }
  let copied = 0;
  copied += copyMissingTree(path.join(runtime.hermesRoot, "skills"), path.join(home, "skills"));
  copied += copyMissingTree(path.join(runtime.hermesRoot, "plugins"), path.join(home, "plugins"));
  const bundledSoul = path.join(runtime.hermesRoot, "SOUL.md");
  const localSoul = path.join(home, "SOUL.md");
  if (fs.existsSync(bundledSoul) && !fs.existsSync(localSoul)) {
    fs.copyFileSync(bundledSoul, localSoul);
    copied += 1;
  }
  const applicationSkills = syncApplicationBundledSkills(home, options);
  copied += applicationSkills.copied;
  ensureModelsDevOfflineCache(home);
  writeBundledHomeMarker(home, identity);
  return { available: true, home, copied, cached: false, runtime, applicationSkills };
}

module.exports = {
  copyMissingTree,
  ensureModelsDevOfflineCache,
  ensureBundledHermesHome,
  bundledSkillDirectories,
  mergeBundledManifest,
  resolveBundledHermesRuntime,
  resolveHermesHome,
  runtimePythonPath,
  syncApplicationBundledSkills
};
