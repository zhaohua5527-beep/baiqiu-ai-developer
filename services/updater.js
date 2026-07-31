const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { app } = require("electron");

class Updater {
  constructor(options = {}) {
    this.updateServer = options.updateServer || "http://localhost:3000";
    this.currentVersion = options.currentVersion || app.getVersion();
    this.checkInterval = options.checkInterval || 24 * 60 * 60 * 1000;
    this.downloadDir = options.downloadDir || path.join(app.getPath("userData"), "updates");
    this.statePath = options.statePath || path.join(this.downloadDir, "update-state.json");
    this.updateLogPath = options.updateLogPath || path.join(app.getPath("userData"), "logs", "update.log");
    this.executablePath = options.executablePath || app.getPath("exe");
    this.userDataPath = options.userDataPath || app.getPath("userData");
    this.processId = Number.isInteger(options.processId) ? options.processId : process.pid;
  }

  async checkForUpdate(inviteCode) {
    try {
      const version = encodeURIComponent(this.currentVersion);
      const code = encodeURIComponent(String(inviteCode || ""));
      const response = await this._request("GET", `/api/update/check?version=${version}&inviteCode=${code}`);
      if (response?.hasUpdate) {
        return {
          hasUpdate: true,
          latestVersion: response.latestVersion,
          releaseNotes: response.releaseNotes,
          downloadUrl: response.downloadUrl,
          fileSize: response.fileSize,
          checksum: response.checksum
        };
      }
      return {
        hasUpdate: false,
        latestVersion: response?.latestVersion || this.currentVersion,
        releaseNotes: response?.releaseNotes || "",
        message: response?.message || "当前已经是最新版本。"
      };
    } catch (error) {
      console.error("[Updater] 检查更新失败", error.message || error);
      return { hasUpdate: false, error: error.message || String(error) };
    }
  }

  async downloadUpdate(downloadUrl, checksum, onProgress, redirectCount = 0, expectedSize = 0) {
    if (!downloadUrl) throw new Error("缺少更新包下载地址");
    if (!/^(?:https?:|http:\/\/(?:localhost|127\.0\.0\.1|47\.108\.191\.67)(?::\d+)?\/)/i.test(downloadUrl)) {
      throw new Error("更新包必须使用 HTTP(S) 下载地址");
    }
    const expectedChecksum = String(checksum || "").replace(/^sha256:/i, "").trim();
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) throw new Error("更新清单缺少有效的 SHA-256 校验值");
    if (redirectCount > 5) throw new Error("更新包下载重定向次数过多");
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const filePath = path.join(this.downloadDir, "update.zip");
    fs.rmSync(filePath, { force: true });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        try { file.destroy(); } catch {}
        fs.rm(filePath, { force: true }, () => reject(error));
      };
      const file = fs.createWriteStream(filePath);
      const request = this._protocol(downloadUrl).get(downloadUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close(() => {
            fs.unlink(filePath, () => {});
            this.downloadUpdate(new URL(response.headers.location, downloadUrl).toString(), expectedChecksum, onProgress, redirectCount + 1, expectedSize).then(resolve, reject);
          });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          finishReject(new Error(`下载失败：HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = Number(response.headers["content-length"] || 0);
        let downloadedSize = 0;
        response.on("data", (chunk) => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize > 0) onProgress(Math.round((downloadedSize / totalSize) * 100));
        });
        response.on("aborted", () => finishReject(new Error("更新包下载连接已中断")));
        response.on("error", finishReject);
        response.pipe(file);

        file.on("finish", () => {
          file.close(async () => {
            try {
              if (downloadedSize <= 0) throw new Error("下载的更新包为空");
              if (totalSize > 0 && downloadedSize !== totalSize) {
                throw new Error(`更新包下载不完整：${downloadedSize}/${totalSize}`);
              }
              const manifestSize = Number(expectedSize || 0);
              if (manifestSize > 0 && downloadedSize !== manifestSize) {
                throw new Error(`更新包大小与清单不一致：${downloadedSize}/${manifestSize}`);
              }
              await this.verifyChecksum(filePath, expectedChecksum);
              if (onProgress) onProgress(100);
              settled = true;
              resolve(filePath);
            } catch (error) {
              finishReject(error);
            }
          });
        });
        file.on("error", finishReject);
      });

      request.setTimeout(60000, () => request.destroy(new Error("更新包下载超时")));
      request.on("error", finishReject);
    });
  }

  verifyChecksum(filePath, checksum) {
    const expected = String(checksum || "").replace(/^sha256:/i, "").toLowerCase();
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => {
        const actual = hash.digest("hex").toLowerCase();
        if (expected && actual !== expected) {
          reject(new Error("文件校验失败，下载文件可能已损坏。"));
          return;
        }
        resolve(actual);
      });
    });
  }

  async applyUpdate(zipFilePath, options = {}) {
    if (!zipFilePath || !fs.existsSync(zipFilePath)) throw new Error("更新包不存在");
    const tempUpdatePath = path.join(this.downloadDir, "temp-update");
    const currentExe = this.executablePath;
    const appPath = path.dirname(currentExe);
    const userDataPath = path.resolve(this.userDataPath);
    const stableDataPath = String(process.env.BAIQIU_DATA_ROOT || "").trim()
      ? path.resolve(process.env.BAIQIU_DATA_ROOT)
      : "";
    if (path.resolve(appPath).toLowerCase() === userDataPath.toLowerCase()) {
      throw new Error("更新已停止：程序目录不能与用户数据目录相同");
    }
    const backupPath = path.join(this.downloadDir, "backup");
    const scriptPath = path.join(this.downloadDir, "update.ps1");
    const versionLockPath = path.join(this.downloadDir, "version-lock.json");
    const logPath = path.join(this.downloadDir, "logs", `installer-${Date.now()}.log`);
    const pid = this.processId;
    const targetVersion = String(options.version || "");
    const oldVersion = String(options.oldVersion || this.currentVersion || "");
    const restartAfterUpdate = options.restart !== false;
    if (!targetVersion) throw new Error("缺少目标版本号");
    const psUtf8 = (value) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(value || ""), "utf8").toString("base64")}'))`;

    fs.rmSync(tempUpdatePath, { recursive: true, force: true });
    fs.mkdirSync(tempUpdatePath, { recursive: true });

    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      `$package = ${psUtf8(zipFilePath)}`,
      `$tempUpdate = ${psUtf8(tempUpdatePath)}`,
      `$target = ${psUtf8(appPath)}`,
      `$userDataRoot = ${psUtf8(userDataPath)}`,
      `$stableDataRoot = ${psUtf8(stableDataPath)}`,
      `$backup = ${psUtf8(backupPath)}`,
      `$exe = ${psUtf8(currentExe)}`,
      `$stateFile = ${psUtf8(this.statePath)}`,
      `$versionLockFile = ${psUtf8(versionLockPath)}`,
      `$logFile = ${psUtf8(logPath)}`,
      `$updateLogFile = ${psUtf8(this.updateLogPath)}`,
      `$oldVersion = ${psUtf8(oldVersion)}`,
      `$targetVersion = ${psUtf8(targetVersion)}`,
      `$pidToWait = ${JSON.stringify(pid)}`,
      `$restartAfterUpdate = ${restartAfterUpdate ? "$true" : "$false"}`,
      "$oldExeHash = ''",
      "$expectedExeHash = ''",
      "$installedExeHash = ''",
      "$releaseManifestHash = ''",
      "function Get-AppVersion([string]$root) {",
      "  $files = @((Join-Path $root 'resources\\app\\version.json'), (Join-Path $root 'resources\\app\\package.json'), (Join-Path $root 'version.json'), (Join-Path $root 'package.json'))",
      "  foreach ($file in $files) {",
      "    if (!(Test-Path -LiteralPath $file)) { continue }",
      "    try {",
      "      $json = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json",
      "      $value = [string]$(if ($json.appVersion) { $json.appVersion } else { $json.version })",
      "      if ($value) { return $value.Trim() }",
      "    } catch {}",
      "  }",
      "  return ''",
      "}",
      "function Get-FileSha256([string]$file) {",
      "  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return '' }",
      "  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()",
      "}",
      "function Get-ExecutableVersion([string]$file) {",
      "  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return '' }",
      "  try { return [string](Get-Item -LiteralPath $file).VersionInfo.ProductVersion } catch { return '' }",
      "}",
      "function Same-AppVersion([string]$actual, [string]$expected) {",
      "  $left = ([string]$actual).Trim()",
      "  $right = ([string]$expected).Trim()",
      "  if (!$left -or !$right) { return $false }",
      "  while ($left.EndsWith('.0')) { $left = $left.Substring(0, $left.Length - 2) }",
      "  while ($right.EndsWith('.0')) { $right = $right.Substring(0, $right.Length - 2) }",
      "  return $left -eq $right",
      "}",
      "function Assert-ReleaseFiles([string]$root, $manifest) {",
      "  $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd([char[]]'\\/') + [IO.Path]::DirectorySeparatorChar",
      "  foreach ($entry in @($manifest.files)) {",
      "    $relative = [string]$entry.path",
      "    if (!$relative) { throw 'Release manifest contains an empty file path.' }",
      "    $file = [IO.Path]::GetFullPath((Join-Path $root $relative))",
      "    if (!$file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('Release manifest path escapes package root: ' + $relative) }",
      "    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Release file is missing: ' + $relative) }",
      "    if ([int64](Get-Item -LiteralPath $file).Length -ne [int64]$entry.size) { throw ('Release file size mismatch: ' + $relative) }",
      "    $actualHash = Get-FileSha256 $file",
      "    if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw ('Release file hash mismatch: ' + $relative) }",
      "  }",
      "}",
      "function Write-UpdateAudit([string]$status, [string]$errorMessage = '') {",
      "  $dir = Split-Path -Parent $updateLogFile",
      "  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  $entry = [ordered]@{ requestTime = (Get-Date).ToUniversalTime().ToString('o'); source = 'installer'; oldVersion = $oldVersion; newVersion = $targetVersion; installedVersion = (Get-AppVersion $target); oldExeSha256 = $oldExeHash; expectedExeSha256 = $expectedExeHash; installedExeSha256 = (Get-FileSha256 $exe); releaseManifestSha256 = $releaseManifestHash; result = $status; error = $errorMessage }",
      "  ($entry | ConvertTo-Json -Compress) | Add-Content -LiteralPath $updateLogFile -Encoding UTF8",
      "}",
      "function Write-UpdateState([string]$status, [string]$errorMessage = '') {",
      "  $dir = Split-Path -Parent $stateFile",
      "  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  $state = @{ state = $status; status = $status; version = $targetVersion; oldVersion = $oldVersion; newVersion = $targetVersion; installedVersion = (Get-AppVersion $target); oldExeSha256 = $oldExeHash; expectedExeSha256 = $expectedExeHash; installedExeSha256 = (Get-FileSha256 $exe); releaseManifestSha256 = $releaseManifestHash; lastUpdate = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); scriptPath = $PSCommandPath; packagePath = $package; backupPath = $backup; appPath = $target; error = $errorMessage }",
      "  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $stateFile -Encoding UTF8",
      "  Write-UpdateAudit $status $errorMessage",
      "}",
      "function Write-InstallerLog([string]$message) {",
      "  $dir = Split-Path -Parent $logFile",
      "  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  ('[' + (Get-Date).ToString('o') + '] ' + $message) | Add-Content -LiteralPath $logFile -Encoding UTF8",
      "}",
      "function Write-VersionLock {",
      "  $dir = Split-Path -Parent $versionLockFile",
      "  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  @{ version = $targetVersion; oldVersion = $oldVersion; installedVersion = (Get-AppVersion $target); oldExeSha256 = $oldExeHash; expectedExeSha256 = $expectedExeHash; installedExeSha256 = (Get-FileSha256 $exe); releaseManifestSha256 = $releaseManifestHash; status = 'completed'; lastUpdate = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versionLockFile -Encoding UTF8",
      "}",
      "function Invoke-MirrorCopy([string]$source, [string]$dest) {",
      "  $excludedDirs = @($userDataRoot, $stableDataRoot) | Where-Object { $_ }",
      "  if ($excludedDirs.Count -gt 0) {",
      "    robocopy $source $dest /MIR /R:2 /W:1 /XD $excludedDirs | Out-Null",
      "  } else {",
      "    robocopy $source $dest /MIR /R:2 /W:1 | Out-Null",
      "  }",
      "  $code = $LASTEXITCODE",
      "  if ($code -ge 8) { throw \"Robocopy failed with exit code $code\" }",
      "}",
      "try {",
      "  Write-UpdateState 'switching'",
      "  Write-InstallerLog 'switching started'",
      "  Start-Sleep -Seconds 3",
      "  if ($pidToWait -gt 0) { try { Wait-Process -Id $pidToWait -Timeout 60 -ErrorAction SilentlyContinue } catch {} }",
      "  if (!(Test-Path -LiteralPath $package)) { throw 'Update package not found.' }",
      "  if ((Get-Item -LiteralPath $package).Length -le 0) { throw 'Update package is empty.' }",
      "  if (Test-Path $tempUpdate) { Remove-Item $tempUpdate -Recurse -Force }",
      "  New-Item -ItemType Directory -Force -Path $tempUpdate | Out-Null",
      "  Write-UpdateState 'verifying'",
      "  Expand-Archive -LiteralPath $package -DestinationPath $tempUpdate -Force",
      "  $clientPath = Join-Path $tempUpdate 'client'",
      "  if (Test-Path -LiteralPath $clientPath) { $sourcePath = $clientPath } else {",
      "    $source = Get-ChildItem $tempUpdate -Directory | Select-Object -First 1",
      "    if ($source) { $sourcePath = $source.FullName } else { $sourcePath = $tempUpdate }",
      "  }",
      "  $fileCount = (Get-ChildItem -LiteralPath $sourcePath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count",
      "  if ($fileCount -lt 10) { throw 'Update package file count is too small.' }",
      "  $releaseManifestFile = Join-Path $sourcePath 'release-manifest.json'",
      "  if (!(Test-Path -LiteralPath $releaseManifestFile -PathType Leaf)) { throw 'Update package is missing release-manifest.json.' }",
      "  $releaseManifestHash = Get-FileSha256 $releaseManifestFile",
      "  $releaseManifest = Get-Content -LiteralPath $releaseManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json",
      "  if ([string]$releaseManifest.packageType -ne 'full-client') { throw 'Update package is not a full-client release.' }",
      "  if (!(Same-AppVersion ([string]$releaseManifest.version) $targetVersion)) { throw \"Package version mismatch: expected $targetVersion, found $($releaseManifest.version)\" }",
      "  $packageExe = Join-Path $sourcePath (Split-Path -Leaf $exe)",
      "  if (!(Test-Path -LiteralPath $packageExe -PathType Leaf)) { $packageExe = Join-Path $sourcePath 'BaiqiuAI.exe' }",
      "  if (!(Test-Path -LiteralPath $packageExe -PathType Leaf)) { throw 'Update package missing BaiqiuAI.exe.' }",
      "  $mainEntry = Join-Path $sourcePath 'resources\\app\\main.js'",
      "  $asarEntry = Join-Path $sourcePath 'resources\\app.asar'",
      "  if (!(Test-Path -LiteralPath $mainEntry -PathType Leaf) -and !(Test-Path -LiteralPath $asarEntry -PathType Leaf)) { throw 'Update package is missing the application entry.' }",
      "  Assert-ReleaseFiles $sourcePath $releaseManifest",
      "  $expectedExeHash = ([string]$releaseManifest.executable.sha256).ToLowerInvariant()",
      "  if (!$expectedExeHash -or (Get-FileSha256 $packageExe) -ne $expectedExeHash) { throw 'Update executable hash does not match release manifest.' }",
      "  $packageExeVersion = Get-ExecutableVersion $packageExe",
      "  if ($packageExeVersion -and !(Same-AppVersion $packageExeVersion $targetVersion)) { throw \"Executable version mismatch: expected $targetVersion, found $packageExeVersion\" }",
      "  $packageVersion = Get-AppVersion $sourcePath",
      "  if (!$packageVersion) { throw 'Update package is missing version metadata.' }",
      "  if (!(Same-AppVersion $packageVersion $targetVersion)) { throw \"Package version mismatch: expected $targetVersion, found $packageVersion\" }",
      "  $oldExeHash = Get-FileSha256 $exe",
      "  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }",
      "  New-Item -ItemType Directory -Force -Path $backup | Out-Null",
      "  Invoke-MirrorCopy $target $backup",
      "  Write-InstallerLog 'backup complete'",
      "  Invoke-MirrorCopy $sourcePath $target",
      "  Write-UpdateState 'testing'",
      "  if (!(Test-Path -LiteralPath (Join-Path $target 'resources\\app\\main.js') -PathType Leaf)) { throw 'Updated app missing main entry after replace.' }",
      "  if (!(Test-Path -LiteralPath $exe)) { throw 'Updated app executable is missing after replace.' }",
      "  Assert-ReleaseFiles $target $releaseManifest",
      "  $installedExeHash = Get-FileSha256 $exe",
      "  if ($installedExeHash -ne $expectedExeHash) { throw 'Installed executable hash does not match release manifest.' }",
      "  $installedVersion = Get-AppVersion $target",
      "  if (!(Same-AppVersion $installedVersion $targetVersion)) { throw \"Installed version mismatch: expected $targetVersion, found $installedVersion\" }",
      "  $installedExeVersion = Get-ExecutableVersion $exe",
      "  if ($installedExeVersion -and !(Same-AppVersion $installedExeVersion $targetVersion)) { throw \"Installed executable version mismatch: expected $targetVersion, found $installedExeVersion\" }",
      "  Write-VersionLock",
      "  Write-UpdateState 'completed'",
      "  Write-InstallerLog 'completed'",
      "  if ($restartAfterUpdate) { Start-Process -FilePath $exe -WorkingDirectory $target }",
      "} catch {",
      "  $message = $_.Exception.Message",
      "  Write-InstallerLog ('rollback: ' + $message)",
      "  try { if ((Test-Path $backup) -and (Test-Path $target)) { Invoke-MirrorCopy $backup $target } } catch { $message = $message + '; rollback copy failed: ' + $_.Exception.Message }",
      "  $restoredVersion = Get-AppVersion $target",
      "  if ($oldVersion -and !(Same-AppVersion $restoredVersion $oldVersion)) { $message = $message + \"; rollback version mismatch: expected $oldVersion, found $restoredVersion\" }",
      "  try { if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Force } } catch {}",
      "  Write-UpdateState 'rollback' $message",
      "  try { if ($restartAfterUpdate) { Start-Process -FilePath $exe -WorkingDirectory $target } } catch {}",
      "}"
    ].join("\r\n");
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, "utf8");

    return {
      success: true,
      zipFilePath,
      tempUpdatePath,
      appPath,
      backupPath,
      scriptPath,
      statePath: this.statePath,
      updateLogPath: this.updateLogPath,
      oldVersion,
      newVersion: targetVersion,
      restartAfterUpdate,
      message: "更新包已准备，白球即将安全退出并应用更新。"
    };
  }

  _request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.updateServer);
      const data = body ? JSON.stringify(body) : "";
      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      };

      const req = this._protocol(url.toString()).request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody || "{}"));
          } catch {
            resolve(responseBody);
          }
        });
      });

      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  _protocol(url) {
    return String(url || "").startsWith("https:") ? https : http;
  }
}

module.exports = Updater;

