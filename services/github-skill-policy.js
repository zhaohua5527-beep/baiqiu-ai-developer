"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);
const ALLOWED_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".app", ".bat", ".bin", ".cmd", ".com", ".dll", ".dmg", ".exe", ".jar", ".js", ".jse",
  ".msi", ".msp", ".ps1", ".py", ".rb", ".reg", ".scr", ".sh", ".so", ".vbs", ".wsf"
]);
const INSTALL_SCRIPT_NAMES = new Set([
  "install", "install.bat", "install.cmd", "install.ps1", "install.sh", "install.py",
  "setup", "setup.bat", "setup.cmd", "setup.ps1", "setup.sh", "setup.py",
  "bootstrap", "bootstrap.bat", "bootstrap.cmd", "bootstrap.ps1", "bootstrap.sh",
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pyproject.toml",
  "requirements.txt", "gemfile", "cargo.toml"
]);

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_REPOSITORY_KB = 100 * 1024;

class GitHubSkillPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GitHubSkillPolicyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new GitHubSkillPolicyError(code, message, details);
}

function parseSafeGitHubUrl(value) {
  const rawValue = String(value || "");
  const rawPathMatch = rawValue.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/);
  if (rawPathMatch) {
    let rawPath = rawPathMatch[1] || "/";
    for (let pass = 0; pass < 3; pass += 1) {
      assertSafeRelativePath(rawPath);
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        fail("INVALID_PATH_ENCODING", "GitHub source path contains invalid encoding.");
      }
      if (decoded === rawPath) break;
      rawPath = decoded;
    }
    assertSafeRelativePath(rawPath);
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    fail("INVALID_URL", "GitHub source URL is invalid.");
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") fail("INSECURE_PROTOCOL", "GitHub sources must use HTTPS.");
  if (!ALLOWED_HOSTS.has(hostname)) fail("UNTRUSTED_HOST", "GitHub source host is not allowed.", { hostname });
  if (url.username || url.password) fail("URL_CREDENTIALS", "Source URLs must not contain credentials.");
  if (url.port && url.port !== "443") fail("UNTRUSTED_PORT", "GitHub source URL uses an untrusted port.");

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    fail("INVALID_PATH_ENCODING", "GitHub source path contains invalid encoding.");
  }
  assertSafeRelativePath(decodedPath);

  const segments = decodedPath.split("/").filter(Boolean);
  if (segments.length < 2) fail("INCOMPLETE_GITHUB_PATH", "GitHub source must identify an owner and repository.");

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    fail("INVALID_OWNER", "GitHub owner name is invalid.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repository)) fail("INVALID_REPOSITORY", "GitHub repository name is invalid.");

  if (hostname === "raw.githubusercontent.com" && segments.length < 4) {
    fail("INCOMPLETE_RAW_PATH", "Raw GitHub source must include a revision and file path.");
  }

  return {
    url: url.toString(),
    host: hostname,
    owner,
    repository,
    revision: hostname === "raw.githubusercontent.com" ? segments[2] : null,
    filePath: hostname === "raw.githubusercontent.com" ? segments.slice(3).join("/") : null
  };
}

function assertSafeRelativePath(value) {
  const input = String(value || "").replace(/\\/g, "/");
  if (input.includes("\0")) fail("NULL_BYTE", "Source path contains a null byte.");
  const segments = input.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    fail("PATH_TRAVERSAL", "Source path contains traversal segments.");
  }
  if (/(?:^|\/)~(?:\/|$)/.test(input)) fail("UNSAFE_PATH", "Source path contains an unsafe home segment.");
  return input.replace(/^\/+/, "");
}

function validateRepositoryMetadata(metadata, options = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("INVALID_REPOSITORY_METADATA", "Repository metadata must be an object.");
  }

  const source = parseSafeGitHubUrl(metadata.html_url || metadata.url);
  const fullName = String(metadata.full_name || "");
  if (fullName.toLowerCase() !== `${source.owner}/${source.repository}`.toLowerCase()) {
    fail("REPOSITORY_IDENTITY_MISMATCH", "Repository metadata does not match its source URL.");
  }
  if (metadata.private === true || String(metadata.visibility || "public") !== "public") {
    fail("PRIVATE_REPOSITORY", "Only public GitHub repositories are allowed.");
  }
  if (metadata.archived === true) fail("ARCHIVED_REPOSITORY", "Archived repositories are not accepted.");
  if (metadata.disabled === true) fail("DISABLED_REPOSITORY", "Disabled repositories are not accepted.");

  const defaultBranch = String(metadata.default_branch || "").trim();
  if (!defaultBranch || /[\x00-\x20~^:?*\[\\]/.test(defaultBranch) || defaultBranch.includes("..")) {
    fail("INVALID_DEFAULT_BRANCH", "Repository default branch is invalid.");
  }

  const maxRepositoryKb = Number(options.maxRepositoryKb || DEFAULT_MAX_REPOSITORY_KB);
  const sizeKb = Number(metadata.size || 0);
  if (!Number.isFinite(sizeKb) || sizeKb < 0) fail("INVALID_REPOSITORY_SIZE", "Repository size is invalid.");
  if (sizeKb > maxRepositoryKb) {
    fail("REPOSITORY_TOO_LARGE", "Repository exceeds the allowed size.", { sizeKb, maxRepositoryKb });
  }

  return Object.freeze({
    owner: source.owner,
    repository: source.repository,
    fullName: `${source.owner}/${source.repository}`,
    sourceUrl: source.url,
    defaultBranch,
    visibility: "public",
    sizeKb,
    pushedAt: metadata.pushed_at || null
  });
}

function toContentBuffer(content) {
  if (Buffer.isBuffer(content)) return Buffer.from(content);
  if (typeof content === "string") return Buffer.from(content, "utf8");
  fail("INVALID_CONTENT", "Skill content must be a string or Buffer.");
}

function appearsBinary(buffer) {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.02;
}

function inferPermissions(text) {
  const checks = [
    ["network", /\b(?:https?:\/\/|fetch\s*\(|curl\b|wget\b|network|联网|网络请求)\b/i],
    ["filesystem", /\b(?:files?|filesystem|readFile|writeFile|mkdir|目录|文件读写|读取文件|写入文件)\b/i],
    ["shell", /\b(?:shell|terminal|command line|powershell|cmd\.exe|bash|执行命令|终端)\b/i],
    ["git", /\b(?:git|github|repository|仓库)\b/i],
    ["secrets", /\b(?:api[_ -]?key|token|credential|password|密钥|令牌|密码)\b/i]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([permission]) => permission);
}

function validateSkillFile(file, options = {}) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    fail("INVALID_SKILL_FILE", "Skill file descriptor must be an object.");
  }

  const filePath = assertSafeRelativePath(file.path || file.name);
  if (!filePath) fail("MISSING_FILE_PATH", "Skill file path is required.");
  const baseName = path.posix.basename(filePath).toLowerCase();
  const extension = path.posix.extname(baseName).toLowerCase();
  if (INSTALL_SCRIPT_NAMES.has(baseName) || /^(?:install|setup|bootstrap)(?:[._-]|$)/i.test(baseName)) {
    fail("INSTALL_SCRIPT", "Installation and bootstrap files are not allowed.", { filePath });
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    fail("EXECUTABLE_FILE", "Executable or script files are not allowed.", { filePath });
  }
  if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) {
    fail("UNSUPPORTED_TEXT_TYPE", "Only approved text skill formats are allowed.", { filePath, extension });
  }
  if (file.executable === true || (Number(file.mode || 0) & 0o111) !== 0) {
    fail("EXECUTABLE_MODE", "Executable file mode is not allowed.", { filePath });
  }

  const content = toContentBuffer(file.content);
  const maxFileBytes = Number(options.maxFileBytes || DEFAULT_MAX_FILE_BYTES);
  if (content.length > maxFileBytes) {
    fail("FILE_TOO_LARGE", "Skill file exceeds the allowed size.", { size: content.length, maxFileBytes });
  }
  if (file.size != null && Number(file.size) !== content.length) {
    fail("SIZE_MISMATCH", "Declared skill file size does not match its content.");
  }
  if (appearsBinary(content)) fail("BINARY_CONTENT", "Binary content is not allowed.", { filePath });

  const text = content.toString("utf8");
  if (text.startsWith("#!")) fail("SCRIPT_SHEBANG", "Script shebangs are not allowed in skill text.");
  if (/"(?:preinstall|install|postinstall)"\s*:/i.test(text)) {
    fail("INSTALL_HOOK", "Package installation hooks are not allowed in skill text.");
  }

  const source = parseSafeGitHubUrl(file.sourceUrl || file.downloadUrl);
  return Object.freeze({
    path: filePath,
    size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    mediaType: extension === ".json" ? "application/json" : "text/plain",
    source,
    permissions: inferPermissions(text),
    executable: false
  });
}

function buildConfirmationSummary({ repository, files, requestedPermissions = [] }) {
  if (!repository || !Array.isArray(files) || files.length === 0) {
    fail("INCOMPLETE_CONFIRMATION", "Repository and at least one validated skill file are required.");
  }
  const permissions = [...new Set([
    ...requestedPermissions.map(String),
    ...files.flatMap((file) => Array.isArray(file.permissions) ? file.permissions : [])
  ])].sort();

  return Object.freeze({
    confirmationRequired: true,
    action: "install-github-text-skill",
    source: {
      provider: "GitHub",
      repository: repository.fullName,
      url: repository.sourceUrl,
      revision: repository.defaultBranch,
      pushedAt: repository.pushedAt || null
    },
    files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256, sourceUrl: file.source.url })),
    permissions,
    restrictions: ["text-only", "no-clone", "no-execution", "no-install-scripts"],
    totalBytes: files.reduce((total, file) => total + file.size, 0)
  });
}

function buildVersionMetadata({ skillId, version, repository, files, installedAt = new Date().toISOString() }) {
  if (!skillId || !version || !repository || !Array.isArray(files) || files.length === 0) {
    fail("INCOMPLETE_VERSION_METADATA", "Skill ID, version, repository and files are required.");
  }
  return Object.freeze({
    skillId: String(skillId),
    version: String(version),
    source: "github",
    repository: repository.fullName,
    repositoryUrl: repository.sourceUrl,
    revision: repository.defaultBranch,
    installedAt: new Date(installedAt).toISOString(),
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }))
  });
}

function buildRollbackMetadata({ currentVersion, previousVersion = null, backupPath, createdAt = new Date().toISOString() }) {
  if (!currentVersion || !backupPath) {
    fail("INCOMPLETE_ROLLBACK_METADATA", "Current version and backup path are required.");
  }
  const safeBackupPath = assertSafeRelativePath(backupPath);
  return Object.freeze({
    currentVersion: String(currentVersion),
    previousVersion: previousVersion == null ? null : String(previousVersion),
    backupPath: safeBackupPath,
    createdAt: new Date(createdAt).toISOString(),
    state: "ready",
    automaticExecution: false
  });
}

module.exports = {
  ALLOWED_HOSTS,
  ALLOWED_TEXT_EXTENSIONS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_REPOSITORY_KB,
  GitHubSkillPolicyError,
  parseSafeGitHubUrl,
  validateRepositoryMetadata,
  validateSkillFile,
  buildConfirmationSummary,
  buildVersionMetadata,
  buildRollbackMetadata
};
