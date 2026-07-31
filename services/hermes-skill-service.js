const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const YAML = require("yaml");
const {
  ensureBundledHermesHome,
  resolveBundledHermesRuntime,
  resolveHermesHome,
  runtimePythonPath
} = require("./hermes-bundled-runtime");

function resolveHermesCliLaunch(options = {}) {
  const explicit = [options.executablePath, process.env.HERMES_CLI_PATH]
    .filter(Boolean)
    .map((item) => path.resolve(item))
    .find((item) => fs.existsSync(item));
  if (explicit) return { executablePath: explicit, argsPrefix: [], runtime: null };
  const runtime = resolveBundledHermesRuntime(options);
  if (runtime) {
    return {
      executablePath: runtime.pythonPath,
      argsPrefix: ["-m", "hermes_cli.main"],
      runtime
    };
  }
  const home = resolveHermesHome(options);
  const local = path.join(home, "hermes-agent", "venv", "Scripts", "hermes.exe");
  return { executablePath: fs.existsSync(local) ? local : "", argsPrefix: [], runtime: null };
}

function resolveHermesExecutable(options = {}) {
  return resolveHermesCliLaunch(options).executablePath;
}

function frontmatter(markdown = "") {
  const match = String(markdown).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const value = YAML.parse(match[1]);
  return value && typeof value === "object" ? value : {};
}

function currentPlatformName(platform = process.platform) {
  return { win32: "windows", darwin: "macos", linux: "linux" }[platform] || platform;
}

function platformCompatible(platforms, platform = process.platform) {
  if (!Array.isArray(platforms) || !platforms.length) return true;
  const current = currentPlatformName(platform);
  return platforms.map((item) => String(item).toLowerCase()).includes(current);
}

function walkSkillFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(target);
    }
  };
  visit(root);
  return files;
}

function bundledSkillNames(home) {
  const manifest = path.join(home, "skills", ".bundled_manifest");
  if (!fs.existsSync(manifest)) return new Set();
  return new Set(fs.readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split(":", 1)[0].trim())
    .filter(Boolean));
}

function stripAnsi(value = "") {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function hermesOutputError(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`.trim();
  return /(?:^|\n)\s*(?:error|fatal)\s*:/i.test(text)
    || /no skill named|skill .* not found|failed to|command failed|traceback/i.test(text);
}

function safeSkillName(value = "") {
  return String(value).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function skillDirectoryFingerprint(directory) {
  const hash = createHash("sha256");
  const visit = (current, relative = "") => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const child = path.join(relative, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) visit(target, child);
      else if (entry.isFile()) {
        hash.update(child);
        hash.update("\0");
        hash.update(fs.readFileSync(target));
        hash.update("\0");
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

class HermesSkillService {
  constructor(options = {}) {
    this.options = options;
    this.home = ensureBundledHermesHome(options).home;
    this.skillsRoot = path.join(this.home, "skills");
    this.launch = resolveHermesCliLaunch(options);
    this.executablePath = this.launch.executablePath;
    this.execFileImpl = options.execFileImpl || execFile;
    this.platform = options.platform || process.platform;
    this.verificationResults = new Map();
    this.verificationFile = path.join(this.skillsRoot, ".baiqiu-verification.json");
    this.dedupHistoryFile = path.join(this.skillsRoot, ".baiqiu-dedup-history.json");
    this.loadVerificationResults();
  }

  deduplicationHistory(limit = 20) {
    let records = [];
    try {
      const value = JSON.parse(fs.readFileSync(this.dedupHistoryFile, "utf8"));
      records = Array.isArray(value.records) ? value.records : [];
    } catch {}
    return {
      success: true,
      historyFile: this.dedupHistoryFile,
      records: records.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    };
  }

  recordDeduplication(result) {
    const record = {
      id: `skill-dedup-${Date.now()}`,
      executedAt: new Date().toISOString(),
      scanned: Number(result.scanned || 0),
      duplicateGroups: Number(result.duplicateGroups || 0),
      removedCount: Number(result.removedCount || 0),
      conflictCount: Array.isArray(result.conflicts) ? result.conflicts.length : 0,
      remaining: Number(result.remaining || 0),
      removed: (result.removed || []).map((item) => ({
        id: item.id,
        kept: item.kept,
        removed: item.removed,
        fingerprint: item.fingerprint
      })),
      rule: result.evidence?.rule || ""
    };
    const previous = this.deduplicationHistory(19).records;
    fs.mkdirSync(this.skillsRoot, { recursive: true });
    const temporary = `${this.dedupHistoryFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: [record, ...previous] }, null, 2), "utf8");
    fs.renameSync(temporary, this.dedupHistoryFile);
    return { ...record, historyFile: this.dedupHistoryFile };
  }

  loadVerificationResults() {
    try {
      const value = JSON.parse(fs.readFileSync(this.verificationFile, "utf8"));
      for (const [name, result] of Object.entries(value.results || {})) this.verificationResults.set(name, result);
    } catch {}
  }

  saveVerificationResults() {
    fs.mkdirSync(this.skillsRoot, { recursive: true });
    const temporary = `${this.verificationFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, results: Object.fromEntries(this.verificationResults) }, null, 2), "utf8");
    fs.renameSync(temporary, this.verificationFile);
  }

  recordVerification(name, result = {}) {
    const skill = this.get(String(name || ""));
    if (!skill) return null;
    this.verificationResults.set(skill.name, {
      success: result.success === true,
      checkedAt: result.checkedAt || new Date().toISOString(),
      evidence: result.evidence || {},
      error: String(result.error || "")
    });
    this.saveVerificationResults();
    return this.get(skill.name);
  }

  list() {
    const bundled = bundledSkillNames(this.home);
    return walkSkillFiles(this.skillsRoot).map((file) => {
      const markdown = fs.readFileSync(file, "utf8");
      const meta = frontmatter(markdown);
      const name = String(meta.name || path.basename(path.dirname(file))).trim();
      const compatible = platformCompatible(meta.platforms, this.platform);
      const stat = fs.statSync(file);
      const lastCheck = this.verificationResults.get(name);
      return {
        id: name,
        name,
        description: String(meta.description || "").trim(),
        category: String(meta.metadata?.hermes?.category || path.basename(path.dirname(path.dirname(file))) || "general"),
        version: String(meta.version || ""),
        source: bundled.has(name) ? "黑球内置" : "黑球本地",
        builtin: bundled.has(name),
        status: !compatible
          ? "DISABLED"
          : lastCheck?.success === true
            ? "READY"
            : lastCheck?.success === false
              ? "FAILED"
              : "UNVERIFIED",
        enabled: compatible,
        runnable: compatible && lastCheck?.success === true,
        runtime: "hermes",
        runtimeId: "HMS",
        platforms: Array.isArray(meta.platforms) ? meta.platforms.map(String) : [],
        path: file,
        updatedAt: stat.mtime.toISOString(),
        verification: {
          verified: compatible && lastCheck?.success === true,
          source: "hermes-skill-loader",
          checkedAt: lastCheck?.checkedAt || "",
          evidence: { manifest: file, platform: currentPlatformName(this.platform), ...(lastCheck?.evidence || {}) }
        }
      };
    }).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  get(name) {
    return this.list().find((item) => item.id === name || item.name === name) || null;
  }

  async run(args, options = {}) {
    if (!this.executablePath) {
      const error = new Error("Hermes CLI executable was not found.");
      error.code = "HERMES_CLI_NOT_FOUND";
      throw error;
    }
    return new Promise((resolve, reject) => {
      const pythonPath = runtimePythonPath(this.launch.runtime, [process.env.PYTHONPATH]);
      this.execFileImpl(this.executablePath, [...this.launch.argsPrefix, ...args], {
        cwd: options.cwd || this.home,
        windowsHide: true,
        timeout: options.timeout || 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          HERMES_HOME: this.home,
          ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          NO_COLOR: "1"
        }
      }, (error, stdout, stderr) => {
        const result = { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode: error?.code ?? 0 };
        if (error) {
          const wrapped = new Error(result.stderr || result.stdout || error.message);
          wrapped.code = "HERMES_SKILL_COMMAND_FAILED";
          wrapped.result = result;
          reject(wrapped);
          return;
        }
        resolve(result);
      });
    });
  }

  async inspect(identifier) {
    const value = String(identifier || "").trim();
    if (!value) throw new Error("A Hermes skill identifier is required.");
    const result = await this.run(["skills", "inspect", value]);
    return { identifier: value, preview: result.stdout, verifiedBy: "hermes skills inspect" };
  }

  async search(query, limit = 8) {
    const value = String(query || "").trim();
    if (!value) throw new Error("A Hermes skill search query is required.");
    const result = await this.run(["skills", "search", value, "--limit", String(Math.max(1, Math.min(20, limit))), "--json"]);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      const wrapped = new Error(`Hermes skill search returned invalid JSON: ${error.message}`);
      wrapped.code = "HERMES_SKILL_SEARCH_INVALID";
      throw wrapped;
    }
    return Array.isArray(parsed) ? parsed : (parsed.results || parsed.skills || []);
  }

  async install(identifier, options = {}) {
    const value = String(identifier || "").trim();
    if (!value) throw new Error("A Hermes skill identifier is required.");
    const before = new Set(this.list().map((item) => item.id));
    const args = ["skills", "install", value, "--yes"];
    if (options.name) args.push("--name", String(options.name));
    if (options.category) args.push("--category", String(options.category));
    const result = await this.run(args, { timeout: 180000 });
    if (hermesOutputError(result.stdout, result.stderr)) {
      const error = new Error(result.stderr || result.stdout || "Hermes skill installation failed.");
      error.code = "HERMES_SKILL_COMMAND_REPORTED_ERROR";
      error.result = result;
      throw error;
    }
    const skills = this.list();
    const expectedNames = [
      options.name,
      value.split("/").filter(Boolean).pop(),
      value.match(/\/([^/?#]+?)(?:\.md)?(?:[?#]|$)/i)?.[1]
    ].filter(Boolean).map((item) => safeSkillName(item));
    const installed = skills.find((item) => !before.has(item.id))
      || skills.find((item) => expectedNames.includes(safeSkillName(item.id)))
      || null;
    if (!installed) {
      const error = new Error("Hermes reported installation success, but no installed SKILL.md manifest was found.");
      error.code = "HERMES_SKILL_MANIFEST_MISSING";
      throw error;
    }
    return { success: true, status: installed.status, output: result.stdout, item: installed, skills };
  }

  async installLocal(name, body, options = {}) {
    const id = safeSkillName(name);
    const content = String(body || "").trim();
    if (!id) throw new Error("A valid Hermes skill name is required.");
    if (!content) throw new Error("Hermes skill instructions are required.");
    const directory = path.join(this.skillsRoot, safeSkillName(options.category || "custom") || "custom", id);
    const file = path.join(directory, "SKILL.md");
    fs.mkdirSync(directory, { recursive: true });
    const description = String(options.description || `User-created Baiqiu skill: ${name}`).replace(/[\r\n]+/g, " ").trim();
    const markdown = content.startsWith("---\n") || content.startsWith("---\r\n")
      ? content
      : YAML.stringify({ name: id, description, platforms: [currentPlatformName(this.platform)] }).trimEnd()
        .replace(/^/, "---\n").concat("\n---\n\n", content, "\n");
    fs.writeFileSync(file, markdown, "utf8");
    const check = await this.check(id);
    if (!check.success) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(check.error || "The local Hermes skill failed validation.");
    }
    return { success: true, status: "READY", item: check.skill, verification: check, skills: this.list() };
  }

  deduplicate() {
    const bundled = bundledSkillNames(this.home);
    const manifests = walkSkillFiles(this.skillsRoot).map((file) => {
      const markdown = fs.readFileSync(file, "utf8");
      const meta = frontmatter(markdown);
      const name = String(meta.name || path.basename(path.dirname(file))).trim();
      const relative = path.relative(this.skillsRoot, file);
      const firstDirectory = relative.split(path.sep)[0].toLowerCase();
      return {
        id: safeSkillName(name),
        name,
        file,
        directory: path.dirname(file),
        fingerprint: skillDirectoryFingerprint(path.dirname(file)),
        builtin: bundled.has(name) && !["custom", "learned"].includes(firstDirectory),
        verified: this.verificationResults.get(name)?.success === true,
        updatedAt: fs.statSync(file).mtimeMs
      };
    });
    const byIdentity = new Map();
    for (const item of manifests) {
      if (!item.id) continue;
      const group = byIdentity.get(item.id) || [];
      group.push(item);
      byIdentity.set(item.id, group);
    }

    const removed = [];
    const conflicts = [];
    let duplicateGroups = 0;
    for (const [id, identityGroup] of byIdentity) {
      if (identityGroup.length < 2) continue;
      const byFingerprint = new Map();
      for (const item of identityGroup) {
        const group = byFingerprint.get(item.fingerprint) || [];
        group.push(item);
        byFingerprint.set(item.fingerprint, group);
      }
      if (byFingerprint.size > 1) {
        conflicts.push({ id, manifests: identityGroup.map((item) => item.file) });
      }
      for (const exactGroup of byFingerprint.values()) {
        if (exactGroup.length < 2) continue;
        duplicateGroups += 1;
        exactGroup.sort((left, right) => Number(right.builtin) - Number(left.builtin)
          || Number(right.verified) - Number(left.verified)
          || right.updatedAt - left.updatedAt
          || left.file.localeCompare(right.file));
        const keeper = exactGroup[0];
        for (const duplicate of exactGroup.slice(1)) {
          const duplicateRoot = path.resolve(duplicate.directory);
          const skillsRoot = path.resolve(this.skillsRoot);
          if (!duplicateRoot.startsWith(`${skillsRoot}${path.sep}`)) continue;
          if (path.resolve(keeper.file).startsWith(`${duplicateRoot}${path.sep}`)) continue;
          fs.rmSync(duplicateRoot, { recursive: true, force: true });
          removed.push({ id, kept: keeper.file, removed: duplicate.file, fingerprint: duplicate.fingerprint });
        }
      }
    }
    const remaining = this.list();
    const result = {
      success: true,
      scanned: manifests.length,
      duplicateGroups,
      removedCount: removed.length,
      removed,
      conflicts,
      remaining: remaining.length,
      evidence: {
        skillsRoot: this.skillsRoot,
        scannedManifests: manifests.map((item) => item.file),
        rule: "same normalized skill id and identical skill-directory SHA-256"
      }
    };
    return { ...result, record: this.recordDeduplication(result) };
  }

  async uninstall(name) {
    const skill = this.get(String(name || ""));
    if (!skill) throw new Error("Hermes skill was not found.");
    if (skill.builtin) throw new Error("Bundled Hermes skills cannot be uninstalled from Baiqiu.");
    const result = await this.run(["skills", "uninstall", skill.name]);
    return { success: true, output: result.stdout, skills: this.list() };
  }

  async check(name) {
    const skill = this.get(String(name || ""));
    if (!skill) return { success: false, status: "FAILED", error: "Hermes skill was not found." };
    const checkedAt = new Date().toISOString();
    try {
      const result = await this.run(["skills", "inspect", skill.name]);
      const reportedError = hermesOutputError(result.stdout, result.stderr);
      const success = Boolean(skill.enabled && result.stdout && !reportedError);
      const evidence = { command: "hermes skills inspect", output: result.stdout.slice(0, 1200), manifest: skill.path };
      this.verificationResults.set(skill.name, { success, checkedAt, evidence });
      this.saveVerificationResults();
      return { success, status: success ? "READY" : "FAILED", skill: this.get(skill.name), error: reportedError ? result.stdout || result.stderr : "", evidence };
    } catch (error) {
      const evidence = { command: "hermes skills inspect", output: "", manifest: skill.path };
      this.verificationResults.set(skill.name, { success: false, checkedAt, evidence, error: error.message });
      this.saveVerificationResults();
      return { success: false, status: "FAILED", skill: this.get(skill.name), error: error.message, evidence };
    }
  }
}

module.exports = {
  HermesSkillService,
  frontmatter,
  platformCompatible,
  resolveHermesExecutable,
  resolveHermesHome,
  safeSkillName,
  skillDirectoryFingerprint,
  walkSkillFiles,
  hermesOutputError
};
