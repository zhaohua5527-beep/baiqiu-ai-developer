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
    const partialPath = path.join(this.downloadDir, "update.zip.part");
    let partialSize = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    if (expectedSize > 0 && partialSize > expectedSize) {
      fs.rmSync(partialPath, { force: true });
      partialSize = 0;
    }
    if (expectedSize > 0 && partialSize === expectedSize) {
      await this.verifyChecksum(partialPath, expectedChecksum);
      fs.rmSync(filePath, { force: true });
      fs.renameSync(partialPath, filePath);
      if (onProgress) onProgress(100);
      return filePath;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let file = null;
      const finishReject = (error, { discardPartial = false } = {}) => {
        if (settled) return;
        settled = true;
        try { file.destroy(); } catch {}
        if (discardPartial) fs.rm(partialPath, { force: true }, () => reject(error));
        else reject(error);
      };
      const requestHeaders = partialSize > 0 ? { Range: `bytes=${partialSize}-` } : {};
      const request = this._protocol(downloadUrl).get(downloadUrl, { headers: requestHeaders }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          this.downloadUpdate(new URL(response.headers.location, downloadUrl).toString(), expectedChecksum, onProgress, redirectCount + 1, expectedSize).then(resolve, reject);
          return;
        }
        const resumed = partialSize > 0 && response.statusCode === 206;
        const restartFromZero = partialSize > 0 && response.statusCode === 200;
        if (![200, 206].includes(response.statusCode) || (partialSize > 0 && !resumed && !restartFromZero)) {
          response.resume();
          finishReject(new Error(`下载失败：HTTP ${response.statusCode}`));
          return;
        }
        if (resumed) {
          const contentRange = String(response.headers["content-range"] || "");
          const range = contentRange.match(/^bytes\s+(\d+)-\d+\/(\d+|\*)$/i);
          if (!range || Number(range[1]) !== partialSize) {
            response.resume();
            finishReject(new Error("更新包断点续传响应无效"), { discardPartial: true });
            return;
          }
        }

        const startSize = resumed ? partialSize : 0;
        if (restartFromZero) fs.rmSync(partialPath, { force: true });
        const responseSize = Number(response.headers["content-length"] || 0);
        const totalSize = responseSize > 0 ? startSize + responseSize : 0;
        let downloadedSize = 0;
        file = fs.createWriteStream(partialPath, { flags: startSize > 0 ? "a" : "w" });
        if (onProgress && expectedSize > 0 && startSize > 0) onProgress(Math.round((startSize / expectedSize) * 100));
        response.on("data", (chunk) => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize > 0) onProgress(Math.round(((startSize + downloadedSize) / totalSize) * 100));
        });
        response.on("aborted", () => finishReject(new Error("更新包下载连接已中断")));
        response.on("error", finishReject);
        response.pipe(file);

        file.on("finish", () => {
          file.close(async () => {
            try {
              const completedSize = startSize + downloadedSize;
              if (completedSize <= 0) throw new Error("下载的更新包为空");
              if (totalSize > 0 && completedSize !== totalSize) {
                throw new Error(`更新包下载不完整：${completedSize}/${totalSize}`);
              }
              const manifestSize = Number(expectedSize || 0);
              if (manifestSize > 0 && completedSize !== manifestSize) {
                throw new Error(`更新包大小与清单不一致：${completedSize}/${manifestSize}`);
              }
              await this.verifyChecksum(partialPath, expectedChecksum);
              fs.rmSync(filePath, { force: true });
              fs.renameSync(partialPath, filePath);
              if (onProgress) onProgress(100);
              settled = true;
              resolve(filePath);
            } catch (error) {
              finishReject(error, { discardPartial: /校验|不完整|不一致/.test(String(error?.message || "")) });
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
    const handoffPath = path.join(this.downloadDir, "installer-started.json");
    const logPath = path.join(this.downloadDir, "logs", `installer-${Date.now()}.log`);
    const pid = this.processId;
    const targetVersion = String(options.version || "");
    const oldVersion = String(options.oldVersion || this.currentVersion || "");
    const restartAfterUpdate = options.restart !== false;
    if (!targetVersion) throw new Error("缺少目标版本号");
    const psUtf8 = (value) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(value || ""), "utf8").toString("base64")}'))`;
    const scriptIdentityBase64 = Buffer.from(path.resolve(scriptPath), "utf8").toString("base64");

    fs.rmSync(tempUpdatePath, { recursive: true, force: true });
    fs.rmSync(handoffPath, { force: true });
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
      `$handoffFile = ${psUtf8(handoffPath)}`,
      `$logFile = ${psUtf8(logPath)}`,
      `$updateLogFile = ${psUtf8(this.updateLogPath)}`,
      `$oldVersion = ${psUtf8(oldVersion)}`,
      `$targetVersion = ${psUtf8(targetVersion)}`,
      `$scriptIdentity = ${psUtf8(scriptPath)}`,
      `$scriptIdentityBase64 = '${scriptIdentityBase64}'`,
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
      "function Get-SafeReleaseFile([string]$root, [string]$relative) {",
      "  $normalized = ([string]$relative).Replace('/', '\\').TrimStart('\\')",
      "  if (!$normalized -or $normalized.Contains(':') -or $normalized.Contains('..\\') -or $normalized.Contains([char]0)) { throw ('Release manifest contains an unsafe executable path: ' + $relative) }",
      "  $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd([char[]]'\\/') + [IO.Path]::DirectorySeparatorChar",
      "  $file = [IO.Path]::GetFullPath((Join-Path $root $normalized))",
      "  if (!$file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('Release manifest executable escapes package root: ' + $relative) }",
      "  return $file",
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
      "  $state = @{ state = $status; status = $status; version = $targetVersion; oldVersion = $oldVersion; newVersion = $targetVersion; installedVersion = (Get-AppVersion $target); oldExeSha256 = $oldExeHash; expectedExeSha256 = $expectedExeHash; installedExeSha256 = (Get-FileSha256 $exe); releaseManifestSha256 = $releaseManifestHash; lastUpdate = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); scriptPath = $scriptIdentity; packagePath = $package; backupPath = $backup; appPath = $target; error = $errorMessage }",
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
      "  $excludedFiles = @('Uninstall*.exe')",
      "  if ($excludedDirs.Count -gt 0) {",
      "    robocopy $source $dest /MIR /R:2 /W:1 /XD $excludedDirs /XF $excludedFiles | Out-Null",
      "  } else {",
      "    robocopy $source $dest /MIR /R:2 /W:1 /XF $excludedFiles | Out-Null",
      "  }",
      "  $code = $LASTEXITCODE",
      "  if ($code -ge 8) { throw \"Robocopy failed with exit code $code\" }",
      "}",
      "function Write-InstallerHandoff {",
      "  $handoffTemp = $handoffFile + '.' + $PID + '.tmp'",
      "  $handoffJson = @{ processId = $PID; scriptPath = $scriptIdentity; scriptPathBase64 = $scriptIdentityBase64; version = $targetVersion; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress",
      "  [IO.File]::WriteAllText($handoffTemp, $handoffJson, [Text.UTF8Encoding]::new($false))",
      "  Move-Item -LiteralPath $handoffTemp -Destination $handoffFile -Force",
      "}",
      "try {",
      "  Write-InstallerHandoff",
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
      "    $rootManifest = Join-Path $tempUpdate 'release-manifest.json'",
      "    if (Test-Path -LiteralPath $rootManifest -PathType Leaf) { $sourcePath = $tempUpdate } else {",
      "      $source = Get-ChildItem $tempUpdate -Directory | Select-Object -First 1",
      "      if ($source) { $sourcePath = $source.FullName } else { $sourcePath = $tempUpdate }",
      "    }",
      "  }",
      "  $fileCount = (Get-ChildItem -LiteralPath $sourcePath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count",
      "  if ($fileCount -lt 10) { throw 'Update package file count is too small.' }",
      "  $releaseManifestFile = Join-Path $sourcePath 'release-manifest.json'",
      "  if (!(Test-Path -LiteralPath $releaseManifestFile -PathType Leaf)) { throw 'Update package is missing release-manifest.json.' }",
      "  $releaseManifestHash = Get-FileSha256 $releaseManifestFile",
      "  $releaseManifest = Get-Content -LiteralPath $releaseManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json",
      "  if ([string]$releaseManifest.packageType -ne 'full-client') { throw 'Update package is not a full-client release.' }",
      "  if (!(Same-AppVersion ([string]$releaseManifest.version) $targetVersion)) { throw \"Package version mismatch: expected $targetVersion, found $($releaseManifest.version)\" }",
      "  $manifestExecutablePath = [string]$releaseManifest.executable.path",
      "  $manifestExecutableName = Split-Path -Leaf $manifestExecutablePath",
      "  $currentExecutableName = Split-Path -Leaf $exe",
      "  if (!$manifestExecutableName) { throw 'Update package release manifest is missing the executable path.' }",
      "  if ($manifestExecutableName -ne $currentExecutableName) { throw \"当前启动的程序不是此更新包对应的正式版（当前：$currentExecutableName，更新包：$manifestExecutableName）。请使用正式安装版启动后再更新。\" }",
      "  $packageExe = Get-SafeReleaseFile $sourcePath $manifestExecutablePath",
      "  if (!(Test-Path -LiteralPath $packageExe -PathType Leaf)) { throw \"Update package executable is missing: $manifestExecutablePath\" }",
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
      handoffPath,
      updateLogPath: this.updateLogPath,
      oldVersion,
      newVersion: targetVersion,
      restartAfterUpdate,
      message: "更新包已准备，白球即将安全退出并应用更新。"
    };
  }

  async applyPatchUpdate(zipFilePath, options = {}) {
    if (!zipFilePath || !fs.existsSync(zipFilePath)) throw new Error("更新包不存在");
    const patchManifest = options.manifest;
    if (!patchManifest || patchManifest.packageType !== "file-patch" || !Array.isArray(patchManifest.files)) {
      throw new Error("补丁清单无效");
    }
    const packageChecksum = String(options.packageChecksum || "").replace(/^sha256:/i, "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(packageChecksum)) throw new Error("补丁包缺少有效的 SHA-256 校验值");
    const tempUpdatePath = path.join(this.downloadDir, "temp-patch");
    const currentExe = this.executablePath;
    const appPath = path.dirname(currentExe);
    const userDataPath = path.resolve(this.userDataPath);
    const backupPath = path.join(this.downloadDir, "patch-backup");
    const scriptPath = path.join(this.downloadDir, "apply-patch.ps1");
    const versionLockPath = path.join(this.downloadDir, "version-lock.json");
    const handoffPath = path.join(this.downloadDir, "installer-started.json");
    const logPath = path.join(this.downloadDir, "logs", `patcher-${Date.now()}.log`);
    const targetVersion = String(options.version || patchManifest.toVersion || "");
    const oldVersion = String(options.oldVersion || this.currentVersion || "");
    const restartAfterUpdate = options.restart !== false;
    if (!targetVersion || String(patchManifest.toVersion) !== targetVersion) throw new Error("补丁目标版本不一致");
    if (String(patchManifest.fromVersion) !== oldVersion) throw new Error("补丁基础版本不一致");
    if (path.resolve(appPath).toLowerCase() === userDataPath.toLowerCase()) {
      throw new Error("更新已停止：程序目录不能与用户数据目录相同");
    }
    const psUtf8 = (value) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(value || ""), "utf8").toString("base64")}'))`;
    const scriptIdentityBase64 = Buffer.from(path.resolve(scriptPath), "utf8").toString("base64");
    const manifestJson = JSON.stringify(patchManifest);

    fs.rmSync(tempUpdatePath, { recursive: true, force: true });
    fs.rmSync(handoffPath, { force: true });
    fs.mkdirSync(tempUpdatePath, { recursive: true });

    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      `$package = ${psUtf8(zipFilePath)}`,
      `$expectedPackageSha256 = ${psUtf8(packageChecksum)}`,
      `$expectedManifestJson = ${psUtf8(manifestJson)}`,
      `$tempUpdate = ${psUtf8(tempUpdatePath)}`,
      `$target = ${psUtf8(appPath)}`,
      `$userDataRoot = ${psUtf8(userDataPath)}`,
      `$backup = ${psUtf8(backupPath)}`,
      `$exe = ${psUtf8(currentExe)}`,
      `$stateFile = ${psUtf8(this.statePath)}`,
      `$versionLockFile = ${psUtf8(versionLockPath)}`,
      `$handoffFile = ${psUtf8(handoffPath)}`,
      `$logFile = ${psUtf8(logPath)}`,
      `$updateLogFile = ${psUtf8(this.updateLogPath)}`,
      `$oldVersion = ${psUtf8(oldVersion)}`,
      `$targetVersion = ${psUtf8(targetVersion)}`,
      `$scriptIdentity = ${psUtf8(scriptPath)}`,
      `$scriptIdentityBase64 = '${scriptIdentityBase64}'`,
      `$pidToWait = ${JSON.stringify(this.processId)}`,
      `$restartAfterUpdate = ${restartAfterUpdate ? "$true" : "$false"}`,
      "$packageType = 'file-patch'",
      "$backupIndex = $null",
      "$patchManifestHash = ''",
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
      "function Same-AppVersion([string]$actual, [string]$expected) {",
      "  $left = ([string]$actual).Trim()",
      "  $right = ([string]$expected).Trim()",
      "  if (!$left -or !$right) { return $false }",
      "  while ($left.EndsWith('.0')) { $left = $left.Substring(0, $left.Length - 2) }",
      "  while ($right.EndsWith('.0')) { $right = $right.Substring(0, $right.Length - 2) }",
      "  return $left -eq $right",
      "}",
      "function Get-SafeRelativePath([string]$relative) {",
      "  $normalized = ([string]$relative).Replace('\\', '/').TrimStart('/')",
      "  if (!$normalized -or $normalized -eq '.' -or $normalized -eq '..' -or $normalized.Contains(':') -or $normalized.Contains('../') -or $normalized.Contains([char]0)) { throw ('Unsafe patch path: ' + $relative) }",
      "  return $normalized",
      "}",
      "function Get-SafePath([string]$root, [string]$relative) {",
      "  $normalized = Get-SafeRelativePath $relative",
      "  $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd([char[]]'\\/') + [IO.Path]::DirectorySeparatorChar",
      "  $candidate = [IO.Path]::GetFullPath((Join-Path $root $normalized.Replace('/', '\\')))",
      "  if (!$candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('Patch path escapes root: ' + $relative) }",
      "  return $candidate",
      "}",
      "function Assert-EntryHash($file, $expected, [string]$label) {",
      "  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw ($label + ' is missing') }",
      "  if ([int64](Get-Item -LiteralPath $file).Length -ne [int64]$expected.size) { throw ($label + ' size mismatch') }",
      "  if ((Get-FileSha256 $file) -ne ([string]$expected.sha256).ToLowerInvariant()) { throw ($label + ' hash mismatch') }",
      "}",
      "function Write-InstallerLog([string]$message) {",
      "  $dir = Split-Path -Parent $logFile",
      "  if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  ('[' + (Get-Date).ToString('o') + '] ' + $message) | Add-Content -LiteralPath $logFile -Encoding UTF8",
      "}",
      "function Write-UpdateState([string]$status, [string]$errorMessage = '') {",
      "  $dir = Split-Path -Parent $stateFile",
      "  if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
      "  $state = @{ state = $status; status = $status; packageType = $packageType; version = $targetVersion; oldVersion = $oldVersion; newVersion = $targetVersion; installedVersion = (Get-AppVersion $target); lastUpdate = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); scriptPath = $scriptIdentity; packagePath = $package; backupPath = $backup; appPath = $target; patchManifestSha256 = $patchManifestHash; error = $errorMessage }",
      "  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $stateFile -Encoding UTF8",
      "  $auditDir = Split-Path -Parent $updateLogFile",
      "  if (!(Test-Path -LiteralPath $auditDir)) { New-Item -ItemType Directory -Force -Path $auditDir | Out-Null }",
      "  ($state | ConvertTo-Json -Compress) | Add-Content -LiteralPath $updateLogFile -Encoding UTF8",
      "}",
      "function Restore-PatchBackup {",
      "  if ($null -eq $backupIndex) { return }",
      "  foreach ($item in @($backupIndex.items)) {",
      "    $destination = Get-SafePath $target ([string]$item.path)",
      "    if ([bool]$item.existed) {",
      "      $source = Get-SafePath $backup ([string]$item.path)",
      "      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null",
      "      Copy-Item -LiteralPath $source -Destination $destination -Force",
      "    } elseif (Test-Path -LiteralPath $destination) {",
      "      Remove-Item -LiteralPath $destination -Force",
      "    }",
      "  }",
      "}",
      "function Write-InstallerHandoff {",
      "  $handoffTemp = $handoffFile + '.' + $PID + '.tmp'",
      "  $handoffJson = @{ processId = $PID; scriptPath = $scriptIdentity; scriptPathBase64 = $scriptIdentityBase64; version = $targetVersion; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress",
      "  [IO.File]::WriteAllText($handoffTemp, $handoffJson, [Text.UTF8Encoding]::new($false))",
      "  Move-Item -LiteralPath $handoffTemp -Destination $handoffFile -Force",
      "}",
      "try {",
      "  Write-InstallerHandoff",
      "  Write-UpdateState 'switching'",
      "  Write-InstallerLog 'patch switching started'",
      "  Start-Sleep -Seconds 3",
      "  if ($pidToWait -gt 0) { try { Wait-Process -Id $pidToWait -Timeout 60 -ErrorAction SilentlyContinue } catch {} }",
      "  if (!(Test-Path -LiteralPath $package -PathType Leaf)) { throw 'Patch package not found.' }",
      "  if ((Get-FileSha256 $package) -ne $expectedPackageSha256) { throw 'Patch package SHA-256 mismatch.' }",
      "  $patch = $expectedManifestJson | ConvertFrom-Json",
      "  if ([string]$patch.packageType -ne 'file-patch' -or !(Same-AppVersion ([string]$patch.fromVersion) $oldVersion) -or !(Same-AppVersion ([string]$patch.toVersion) $targetVersion)) { throw 'Trusted patch manifest version mismatch.' }",
      "  if (!(Test-Path -LiteralPath $tempUpdate)) { New-Item -ItemType Directory -Force -Path $tempUpdate | Out-Null }",
      "  Get-ChildItem -LiteralPath $tempUpdate -Force | Remove-Item -Recurse -Force",
      "  Expand-Archive -LiteralPath $package -DestinationPath $tempUpdate -Force",
      "  $packageManifest = Join-Path $tempUpdate 'patch-manifest.json'",
      "  if (!(Test-Path -LiteralPath $packageManifest -PathType Leaf)) { throw 'Patch package is missing patch-manifest.json.' }",
      "  $patchManifestHash = Get-FileSha256 $packageManifest",
      "  $stagedFilesRoot = Join-Path $tempUpdate 'files'",
      "  if (!(Test-Path -LiteralPath $stagedFilesRoot -PathType Container)) { throw 'Patch package is missing file payloads.' }",
      "  $backupItems = New-Object System.Collections.Generic.List[object]",
      "  foreach ($entry in @($patch.files)) {",
      "    $relative = Get-SafeRelativePath ([string]$entry.path)",
      "    $destination = Get-SafePath $target $relative",
      "    if ($null -ne $entry.before) { Assert-EntryHash $destination $entry.before ('Base file ' + $relative) } elseif (Test-Path -LiteralPath $destination) { throw ('Unexpected existing target file: ' + $relative) }",
      "    if ([string]$entry.operation -eq 'replace') {",
      "      $source = Get-SafePath $stagedFilesRoot $relative",
      "      Assert-EntryHash $source $entry.after ('Patch file ' + $relative)",
      "    } elseif ([string]$entry.operation -ne 'delete') { throw ('Unsupported patch operation: ' + $entry.operation) }",
      "    $backupItems.Add([pscustomobject]@{ path = $relative; existed = [bool](Test-Path -LiteralPath $destination -PathType Leaf) }) | Out-Null",
      "  }",
      "  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }",
      "  New-Item -ItemType Directory -Force -Path $backup | Out-Null",
      "  $backupIndex = @{ items = @($backupItems.ToArray()) }",
      "  $backupIndex | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'index.json') -Encoding UTF8",
      "  foreach ($item in @($backupIndex.items)) {",
      "    if (![bool]$item.existed) { continue }",
      "    $source = Get-SafePath $target ([string]$item.path)",
      "    $destination = Get-SafePath $backup ([string]$item.path)",
      "    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null",
      "    Copy-Item -LiteralPath $source -Destination $destination -Force",
      "  }",
      "  Write-UpdateState 'testing'",
      "  foreach ($entry in @($patch.files)) {",
      "    $relative = Get-SafeRelativePath ([string]$entry.path)",
      "    $destination = Get-SafePath $target $relative",
      "    if ([string]$entry.operation -eq 'replace') {",
      "      $source = Get-SafePath $stagedFilesRoot $relative",
      "      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null",
      "      Copy-Item -LiteralPath $source -Destination $destination -Force",
      "    } else { Remove-Item -LiteralPath $destination -Force }",
      "  }",
      "  foreach ($entry in @($patch.files)) {",
      "    $relative = Get-SafeRelativePath ([string]$entry.path)",
      "    $destination = Get-SafePath $target $relative",
      "    if ([string]$entry.operation -eq 'replace') { Assert-EntryHash $destination $entry.after ('Installed file ' + $relative) }",
      "    if ([string]$entry.operation -eq 'delete' -and (Test-Path -LiteralPath $destination)) { throw ('Deleted file remains present: ' + $relative) }",
      "  }",
      "  $releaseManifest = Join-Path $target 'release-manifest.json'",
      "  if (![string]::IsNullOrWhiteSpace([string]$patch.targetReleaseManifestSha256) -and (Get-FileSha256 $releaseManifest) -ne ([string]$patch.targetReleaseManifestSha256).ToLowerInvariant()) { throw 'Installed release manifest hash mismatch.' }",
      "  if (!(Same-AppVersion (Get-AppVersion $target) $targetVersion)) { throw ('Installed version mismatch: expected ' + $targetVersion + ', found ' + (Get-AppVersion $target)) }",
      "  @{ version = $targetVersion; oldVersion = $oldVersion; installedVersion = (Get-AppVersion $target); packageType = $packageType; patchManifestSha256 = $patchManifestHash; status = 'completed'; lastUpdate = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $versionLockFile -Encoding UTF8",
      "  Write-UpdateState 'completed'",
      "  Write-InstallerLog 'patch completed'",
      "  if ($restartAfterUpdate) { Start-Process -FilePath $exe -WorkingDirectory $target }",
      "} catch {",
      "  $message = $_.Exception.Message",
      "  Write-InstallerLog ('patch rollback: ' + $message)",
      "  try { Restore-PatchBackup } catch { $message = $message + '; patch rollback failed: ' + $_.Exception.Message }",
      "  try { if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Force } } catch {}",
      "  Write-UpdateState 'rollback' $message",
      "  try { if ($restartAfterUpdate -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe -WorkingDirectory $target } } catch {}",
      "}"
    ].join("\r\n");
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, "utf8");

    return {
      success: true,
      packageType: "file-patch",
      zipFilePath,
      tempUpdatePath,
      appPath,
      backupPath,
      scriptPath,
      statePath: this.statePath,
      handoffPath,
      updateLogPath: this.updateLogPath,
      oldVersion,
      newVersion: targetVersion,
      restartAfterUpdate,
      message: "补丁已验证并准备完成，重启白球后才会替换程序文件。"
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

